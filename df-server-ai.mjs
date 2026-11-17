/**
 * IA no servidor para assentos desconectados (Rankeado / PvP).
 * Paridade com vs-IA Difícil: mesmo cérebro + ritmo 1,5s entre ações.
 */
import { applyAuthoritativeAction, buildPresentationEnvelope, buildProtecaoVisualEnvelope, roomActionRng } from "./df-authority.mjs";
import { withRoomLock, mirrorRoomNow } from "./df-room-store.mjs";
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import { openReactiveSuspension } from "./df-reactive-suspend.mjs";
import {
  pickBestSummon,
  pickBestAttack,
  pickDraw,
  pickNextAction,
  pickOnEnterResolution,
  scoreLegalAction,
  listTalentPlays,
  pickUltimate,
  pickWinAttack,
  championSummonCost,
} from "./df-ai-hard-brain.mjs";

const AI_GRACE_MS = 8000;
/** Ritmo pedido pelo autor: ~2,5s entre ações da IA no disconnect (paridade vs-IA + VFX no cliente). */
const AI_STEP_MS = 2500;
const AI_MAX_STEPS_PER_TURN = 18;
const AI_TICK_BUDGET_MS = Number(process.env.DF_AI_TICK_BUDGET_MS) || 40;

function ensureAiFlags(room) {
  if (!room.aiControlled) room.aiControlled = [false, false];
  if (!room.aiGraceTimer) room.aiGraceTimer = [null, null];
  if (!room.aiStepTimer) room.aiStepTimer = null;
  if (!room.aiPhase) room.aiPhase = "summon";
  if (room.aiMainFloor == null) room.aiMainFloor = 5;
  if (room.aiGeneration == null) room.aiGeneration = 0;
}

export function clearAiSeat(room, seat) {
  ensureAiFlags(room);
  if (seat !== 0 && seat !== 1) return;
  // Nova geração: ticks/follow-ups em voo abortam no check.
  room.aiGeneration = (room.aiGeneration | 0) + 1;
  room.aiControlled[seat] = false;
  // Reset de fase quando este assento deixa de ser controlado por IA.
  if (room.aiTurnSeat === seat) {
    room.aiTurnSeat = null;
    room.aiPhase = "summon";
    room.aiMainFloor = 5;
    room.aiStepsThisTurn = 0;
  }
  if (room.aiGraceTimer[seat]) {
    clearTimeout(room.aiGraceTimer[seat]);
    room.aiGraceTimer[seat] = null;
  }
  // Cancela o próximo passo imediatamente se era a vez deste assento
  // ou se ninguém mais está sob IA.
  const otherAi = room.aiControlled[seat === 0 ? 1 : 0];
  if (room.aiStepTimer && (room.gameState?.currentPlayer === seat || !otherAi)) {
    clearTimeout(room.aiStepTimer);
    room.aiStepTimer = null;
  }
}

export function clearAllAi(room) {
  ensureAiFlags(room);
  room.aiGeneration = (room.aiGeneration | 0) + 1;
  room.aiControlled[0] = false;
  room.aiControlled[1] = false;
  if (room.aiGraceTimer[0]) {
    clearTimeout(room.aiGraceTimer[0]);
    room.aiGraceTimer[0] = null;
  }
  if (room.aiGraceTimer[1]) {
    clearTimeout(room.aiGraceTimer[1]);
    room.aiGraceTimer[1] = null;
  }
  if (room.aiStepTimer) {
    clearTimeout(room.aiStepTimer);
    room.aiStepTimer = null;
  }
  room.aiPhase = "summon";
  room.aiMainFloor = 5;
}

function enemyFieldCount(state, seat) {
  let n = 0;
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    n += (state.players[p]?.field || []).filter(Boolean).length;
  }
  return n;
}

export function listLegal(state, seat) {
  const { DfEngine } = bootDragonfallEngine();
  // U-D01 (rodada 3): o offline invoca o campeão inútil como corpo quando
  // não há mais nada jogável (trilhos útil/inútil do _best_summon). O
  // humano já podia (summonCheckOpts, df-engine.js:27-28: as mesmas
  // flags). Aceitar a invocação inútil aqui e deixar o cérebro escolher
  // o trilho (onEnterUsable + pickBestHardAction).
  return DfEngine.listLegalActions(state, seat, {
    strictFumacaToxica: true,
    avoidEnemyOnEnterWaste: false,
    allowWastedOnEnter: true,
  }) || [];
}

/**
 * C-A08 (Lote F): a IA do servidor pergunta ao humano antes de agir,
 * exatamente como o offline pergunta ao defensor. Decide SE a ação da IA
 * suspende (o humano tem a carta de Reação) e devolve o spec da suspensão
 * (df-reactive-suspend.mjs orquestra). Não aplica nada.
 *
 * - ATTACK_RESOLVE → BLOQUEAR ATAQUE (o humano bloqueia o ataque).
 * - TALENT_START → CONTRAMÁGICA (o talento é descartado da mão).
 * - SUMMON com instantânea "auto" → EXAUSTÃO (trial apply num clone p/
 *   detectar o modo auto; RITUAL fora — é o item C-A09).
 * - ABILITY_TARGET (follow-up de onEnter instantânea) → EXAUSTÃO.
 * - TALENT_TARGET de talento que reduz Poder (BOLA/EXPLOSÃO) → PROTEÇÃO.
 * ULTIMATE_* não passa aqui: a autoridade suspende (opts.serverAi).
 */
export function maybeSuspendAiAction(room, seat, action, talentMeta) {
  const state = room.gameState;
  if (!state?.players || !action?.type) return { suspend: false };
  const { DfRules, DfEffects, DfEngine } = bootDragonfallEngine();
  const defSeat = 1 - seat;
  const base = {
    askerSeat: seat,
    defenderSeat: defSeat,
    deferredAction: action,
    talentMeta: talentMeta || null,
  };

  if (action.type === "ATTACK_RESOLVE") {
    if (DfRules?.canOfferReactiveBlock?.(state, defSeat, seat)?.ok) {
      return { suspend: true, spec: { ...base, kind: "bloquearAtaque" } };
    }
    return { suspend: false };
  }

  if (action.type === "TALENT_START") {
    if (DfRules?.canOfferContramagica?.(state, defSeat, seat)?.ok) {
      const card = state.players[seat]?.hand?.[action.handIdx];
      const te = talentMeta?._talentEffect || action.talentEffect || "";
      return {
        suspend: true,
        spec: {
          ...base, kind: "contramagica",
          contramagicaCtx: { talentEffect: te, talentName: card?.name || "" },
        },
      };
    }
    return { suspend: false };
  }

  if (action.type === "SUMMON") {
    const card = state.players[seat]?.hand?.[action.handIdx];
    if (!card || card.summonRitual) return { suspend: false };
    try {
      const trial = DfEngine.applyAction(DfEngine.cloneState(state),
        { ...action, playerId: seat }, { rng: roomActionRng(room, seat) });
      const pending = trial?.events?.find((e) => e?.type === "ON_ENTER_PENDING");
      if (!trial?.ok || !pending || pending.fieldIdx == null) return { suspend: false };
      const plan = DfEffects?.planOnEnter?.(trial.state, seat, pending.fieldIdx);
      if (!plan?.ok || plan.mode !== "auto") return { suspend: false };
      const champ = trial.state?.players?.[seat]?.field?.[pending.fieldIdx];
      if (!champ || champ.abilityType !== "instant") return { suspend: false };
      if (!DfRules?.canOfferExaustao?.(state, defSeat, seat)?.ok) return { suspend: false };
      return {
        suspend: true,
        spec: {
          ...base, kind: "exaustaoAuto",
          exaustaoCtx: {
            casterIdx: seat,
            fieldIdx: pending.fieldIdx,
            onEnter: champ.onEnter || plan.onEnter || "",
            abilityName: champ.abilityName || card?.abilityName || "",
            championName: champ.name || card?.name || "",
          },
        },
      };
    } catch (e) {
      return { suspend: false };
    }
  }

  if (action.type === "ABILITY_TARGET") {
    const champ = state.players?.[seat]?.field?.[action.fieldIdx];
    if (!champ || champ.abilityType !== "instant") return { suspend: false };
    if (DfRules?.canOfferExaustao?.(state, defSeat, seat)?.ok) {
      return {
        suspend: true,
        spec: {
          ...base, kind: "exaustao",
          exaustaoCtx: {
            casterIdx: action.casterIdx ?? seat,
            fieldIdx: action.fieldIdx,
            onEnter: action.abilityKey || champ.onEnter || "",
            abilityName: champ.abilityName || "",
            championName: champ.name || "",
          },
        },
      };
    }
    // U-B01 (rodada 3): sem EXAUSTÃO (ou sem carta), a PROTEÇÃO DIVINA
    // é a 2ª pergunta — ordem do offline (EXAUSTÃO primeiro, PROTEÇÃO
    // depois). Só as 4 habilidades que reduzem Poder (o motor resolve
    // direto, sem pendingReduction — a suspensão é o único portão).
    const abilityKey = action.abilityKey || champ.onEnter || "";
    if (["bolaDeFogo", "assassinar", "transformarBichinho", "incendiar"].includes(abilityKey)
        && DfRules?.canOfferReactiveProtection?.(state, defSeat, seat)?.ok) {
      // U-B07 / E-N1 Opção 1 (rodada 5): o visual viaja COM a pergunta.
      return { suspend: true, spec: { ...base, kind: "protecaoDivina",
        presentationEnvelope: buildProtecaoVisualEnvelope(action, state, seat) || undefined } };
    }
    return { suspend: false };
  }

  if (action.type === "TALENT_TARGET") {
    const te = action.talentEffect || "";
    // U-B02 (rodada 3): TRANSFORMAR EM BICHINHO também reduz Poder
    // (morfo) — entra na lista com BOLA e EXPLOSÃO.
    if (te === "bolaDeFogoTalento" || te === "explosao" || te === "transformarBichinhoTalento") {
      if (DfRules?.canOfferReactiveProtection?.(state, defSeat, seat)?.ok) {
        // U-B07 / E-N1 Opção 1 (rodada 5): o visual viaja COM a pergunta.
        return { suspend: true, spec: { ...base, kind: "protecaoDivina",
          presentationEnvelope: buildProtecaoVisualEnvelope(action, state, seat) || undefined } };
      }
    }
    return { suspend: false };
  }

  return { suspend: false };
}

/** Hooks do módulo de suspensão, montados a partir dos hooks da IA. */
function reactiveHooksFor(room, io, hooks) {
  return {
    emitEnvelope: (r, env) => hooks.emitEnvelope(r, env),
    maybeFinish: (r, st) => hooks.maybeFinish?.(r, st),
    persist: async (r) => {
      try { hooks.persist?.(); } catch (e) { /* */ }
      try { await mirrorRoomNow(r); } catch (e) { /* */ }
    },
    scheduleAi: (r) => scheduleServerAi(r, io, hooks),
    onAiResume: (r, seat, result, spec) => continueAiAfterResume(r, io, hooks, seat, result, spec),
  };
}

function actionKey(a) {  if (!a?.type) return "";
  if (a.type === "SUMMON") return `SUMMON:${a.handIdx}`;
  if (a.type === "ATTACK_RESOLVE") {
    return `ATK:${a.attackerIdx}:${a.defenderPlayerId}:${a.defenderIdx}`;
  }
  if (a.type === "TALENT_START") return `TALENT:${a.handIdx}`;
  if (a.type === "ULTIMATE_PLAY") return `ULT:${a.ultimateType}:${a.targetP}:${a.targetI}`;
  if (a.type === "TALENT_TARGET") return `TT:${a.targetP}:${a.targetI}`;
  return a.type;
}

function delayMs() {
  return Math.max(AI_STEP_MS, AI_TICK_BUDGET_MS);
}

/**
 * S2-M10 (offline _run_ai_turn): próximo passo só após o fim da
 * animação do envelope anterior + 1,0 s de respiro; +2,0 s após
 * invocação/talento. Teto de 8 s p/ não morrer no relógio de 70 s (C-A19).
 */
export function delayAfterEnvelope(room, lastActionType) {
  const now = Date.now();
  const lastAt = room.aiLastEnvelopeAt || 0;
  const lastDur = room.aiLastEnvelopeDurationMs || 0;
  const endsAt = lastAt + lastDur;
  let wait = Math.max(0, endsAt - now) + 1000; // respiro
  if (lastActionType === "SUMMON" || lastActionType === "TALENT_START") wait += 2000;
  return Math.min(Math.max(wait, AI_STEP_MS), 8000);
}

// S2-M13: registra os uids que a IA statusou NESTE turno (veneno, congelar,
// em chamas, prisão). Limpo quando o turno da IA começa (scheduleServerAi,
// quando aiTurnSeat muda). O estado carrega em room.aiStatusedUids (Set)
// e é copiado p/ state.aiStatusedUids antes de cada pick.
// D-M13-2: sem caminho de reidratação — sem REDIS_URL o mirror está inativo
// (loadRoomBlob nunca é chamado) e a sala vive só em memória; um restart do
// servidor já descarta a sala inteira, então não há persistência a fazer.
export function markAiStatusedFromResult(room, seat, before, after, action) {
  if (!room.aiStatusedUids) room.aiStatusedUids = new Set();
  if (!before?.players || !after?.players) return;
  // D-N19 (a): comparar por uid — remoções deslocam o campo e o índice
  // antigo casava com o campeão errado (o "refresh" também era perdido).
  const beforeByUid = new Map();
  for (let p = 0; p < 2; p++) {
    if (p === seat) continue;
    for (const c of before.players[p]?.field || []) {
      if (c?.uid) beforeByUid.set(c.uid, c);
    }
  }
  for (let p = 0; p < 2; p++) {
    if (p === seat) continue;
    for (const c of after.players[p]?.field || []) {
      const b = c?.uid ? beforeByUid.get(c.uid) : null;
      if (!c || !b) continue;
      const gained = (!b.poisoned && c.poisoned) || (!b.frozen && c.frozen)
        || (!b.burning && c.burning) || (!b.prisaoPrismatica && c.prisaoPrismatica);
      if (gained) room.aiStatusedUids.add(c.uid);
    }
  }
  // D-N19 (b): marcação direta do alvo de status — cobre o REFRESH (o
  // status já estava lá e a ação o renovou; o diff falso→verdadeiro não
  // vê). O uid é lido do estado PRÉ-ação (o alvo pode ter saído do campo).
  if (action) {
    const statusKey = action.abilityKey || action.talentEffect || action.ultimateType || null;
    const isStatusAction = ["mordidaVenenosa", "rajadaCongelante", "incendiar", "prisaoPrismatica",
      "baforadaVenenosa", "tornadoDeFogo", "prisaoPrismaticaTalento", "zeroAbsoluto",
      "targetEnemyFreeze", "incinerate"].includes(statusKey);
    if (isStatusAction && action.targetP != null && action.targetI != null) {
      const target = before.players[action.targetP]?.field?.[action.targetI];
      if (target?.uid) room.aiStatusedUids.add(target.uid);
    }
  }
}

// D-N07 (offline game_state.gd:4047-4048, 4295-4296): a marca BOLHAS/
// PESADELO é setada NO GATILHO (quando o efeito dispara), não ao invocar.
// O gatilho é o follow-up (ABILITY_TARGET do onEnter / TALENT_AUTO do
// talento bolhas) — marcado nos dois loops de follow-up.
// D-N07 (rodada 3): a marca BOLHAS/PESADELO é setada NO GATILHO — o EVENTO
// é o gatilho. O SUMMON de um campeão auto-resolve o onEnter "auto"
// (BOLHAS/PESADELO) dentro do próprio ack (applyActionWithOnEnter) e
// REMOVE o ON_ENTER_PENDING — então não há follow-up e a marcação por
// ação (markAiBolhasPesadeloFromFollowUp) nunca dispara para campeões.
// Escanear os eventos do resultado cobre o caminho campeão E o replay via
// IMITAR (o BOLHAS vem no ack do ABILITY_TARGET "imitar", que o follow-up
// não marca). Chamado em todo ponto que aplica um resultado da IA.
export function markAiBolhasPesadeloFromEvents(room, events) {
  if (!Array.isArray(events) || !events.length) return;
  if (!room.aiBolhasPesadeloUsed) room.aiBolhasPesadeloUsed = new Set();
  for (const e of events) {
    if (e?.type === "BOLHAS") room.aiBolhasPesadeloUsed.add("bolhas");
    if (e?.type === "PESADELO") room.aiBolhasPesadeloUsed.add("pesadelo");
  }
}

function markAiBolhasPesadeloFromFollowUp(room, fa) {
  if (!room.aiBolhasPesadeloUsed) room.aiBolhasPesadeloUsed = new Set();
  if (fa?.type === "ABILITY_TARGET" && (fa.abilityKey === "bolhas" || fa.abilityKey === "pesadelo")) {
    room.aiBolhasPesadeloUsed.add(fa.abilityKey);
  }
  if (fa?.type === "TALENT_AUTO" && fa.talentEffect === "bolhasTalento") {
    room.aiBolhasPesadeloUsed.add("bolhas");
  }
}

// D-N01: um follow-up de talento que falhou deixa o talento ativo para
// sempre (TALENT_ALREADY_ACTIVE) — descarta o travado para a partida
// continuar. Só descarta se ainda houver talento ativo (NO_ACTIVE_TALENT
// = já descartado, nada a fazer).
function discardStuckTalent(room, seat) {
  if (!room.gameState?.activeTalent) return null;
  return applyAuthoritativeAction(room, seat,
    { type: "TALENT_DISCARD", playerId: seat }, null, { serverAi: true });
}

/**
 * Escolhe e aplica a próxima ação do turno (fases talent → ult_early → main → ult_end → end).
 */
export function pickAndApplyAiAction(room, seat) {
  ensureAiFlags(room);
  const state = room.gameState;
  const tried = new Set();
  // S2-M13: o estado carrega o Set da guarda de status (ver markAiStatusedFromResult).
  state.aiStatusedUids = room.aiStatusedUids || new Set();
  // D-N07: o estado carrega o Set da guarda BOLHAS/PESADELO (o cérebro
  // veta a 2ª aplicação no turno; marcado no gatilho, nos follow-ups).
  state.aiBolhasPesadeloUsed = room.aiBolhasPesadeloUsed || new Set();
  // S2-M13 passo 1: ataque vencedor ANTES DE TUDO (offline: _win_attack
  // vai antes de invocar/talento/Ultimate — invocar primeiro seria perder
  // a vitória que já estava na mão). Desvio do snippet da proposta: o
  // ataque passa pelo maybeSuspendAiAction (C-A08 — o humano recebe o
  // BLOQUEAR) e pelo applyAuthoritativeAction com { serverAi: true };
  // aplicar direto pularia a pergunta reativa.
  const winAtk = pickWinAttack(state, seat);
  if (winAtk && !tried.has(actionKey(winAtk))) {
    tried.add(actionKey(winAtk));
    const susp = maybeSuspendAiAction(room, seat, winAtk, null);
    if (susp.suspend) {
      return {
        action: winAtk,
        result: {
          ok: true, suspended: true,
          suspendKind: susp.spec.kind, suspendSpec: susp.spec,
          committed: false,
        },
        talentMeta: null,
        phase: "win",
      };
    }
    const beforeWin = room.gameState;
    const res = applyAuthoritativeAction(room, seat, winAtk, null, { serverAi: true });
    if (res.suspended) {
      return { action: winAtk, result: res, talentMeta: null, phase: "win" };
    }
    if (res.ok) {
      markAiStatusedFromResult(room, seat, beforeWin, res.state, winAtk);
      markAiBolhasPesadeloFromEvents(room, res.events);
      return { action: winAtk, result: res, talentMeta: null, phase: "win" };
    }
    // Ataque vencedor falhou (alvo mudou, etc.): cai no loop normal.
  }

  // S2-M13 passo 2: o floor (5 -> 0) é resetado após cada ação bem-sucedida
  // (regra antiga do main: 1 com campo adversário vazio, senão 5).
  const resetFloor = () => {
    room.aiMainFloor = enemyFieldCount(room.gameState, seat) === 0 ? 1 : 5;
  };

  for (let attempt = 0; attempt < 12; attempt++) {
    const legal = listLegal(state, seat);
    let phase = room.aiPhase || "summon";

    // Avança fases automaticamente (S2-M13 passo 2: summon -> talent ->
    // ult_early -> ult_end -> attack -> draw -> end).
    if (phase === "summon") {
      if (!legal.some((a) => a?.type === "SUMMON")) {
        room.aiPhase = "talent";
        phase = "talent";
      }
    }
    if (phase === "talent") {
      const talents = listTalentPlays(state, seat);
      if (!talents.length) {
        room.aiPhase = "ult_early";
        phase = "ult_early";
      }
    }
    if (phase === "ult_early") {
      const ult = pickUltimate(state, seat, false);
      if (!ult) {
        room.aiPhase = "ult_end";
        phase = "ult_end";
      }
    }
    if (phase === "ult_end") {
      const ult = pickUltimate(state, seat, true);
      if (!ult) {
        room.aiPhase = "attack";
        phase = "attack";
      }
    }
    if (phase === "attack") {
      if (!legal.some((a) => a?.type === "ATTACK_RESOLVE")) {
        room.aiPhase = "draw";
        phase = "draw";
      }
    }
    if (phase === "draw") {
      if (!legal.some((a) => a?.type === "DRAW_CARD")) {
        room.aiPhase = "end";
        phase = "end";
      }
    }

    let action = null;
    let score = -9999;

    if (phase === "talent") {
      action = pickNextAction(state, seat, { phase: "talent" });
      if (!action) {
        room.aiPhase = "ult_early";
        continue;
      }
    } else if (phase === "ult_early") {
      action = pickNextAction(state, seat, { phase: "ult_early" });
      if (!action) {
        room.aiPhase = "ult_end";
        continue;
      }
    } else if (phase === "ult_end") {
      action = pickNextAction(state, seat, { phase: "ult_end" });
      if (!action) {
        room.aiPhase = "attack";
        continue;
      }
    } else if (phase === "end") {
      action = { type: "END_TURN", playerId: seat };
    } else if (phase === "summon") {
      // invocar — floor 5 → 0 (como o main antigo); sem invocação boa, avança.
      let floor = room.aiMainFloor ?? 5;
      action = pickBestSummon(state, seat, legal, { minScore: floor });
      score = action?._score ?? scoreLegalAction(state, seat, action);
      if ((!action || action.type === "END_TURN") && floor > 0) {
        room.aiMainFloor = 0;
        action = pickBestSummon(state, seat, legal, { minScore: 0 });
        score = action?._score ?? -9999;
      }
      if (!action || action.type === "END_TURN") {
        room.aiPhase = "talent";
        continue;
      }
    } else if (phase === "attack") {
      // atacar — mesmo floor; sem ataque bom, avança para a compra.
      let floor = room.aiMainFloor ?? 5;
      action = pickBestAttack(state, seat, legal, { minScore: floor });
      score = action?._score ?? scoreLegalAction(state, seat, action);
      if ((!action || action.type === "END_TURN") && floor > 0) {
        room.aiMainFloor = 0;
        action = pickBestAttack(state, seat, legal, { minScore: 0 });
        score = action?._score ?? -9999;
      }
      if (!action || action.type === "END_TURN") {
        room.aiPhase = "draw";
        continue;
      }
    } else if (phase === "draw") {
      // comprar — minScore 0 (o anti-pass antigo usava 0; o caso de campo
      // vazio já está coberto pelo fallback plain do pickBestHardAction).
      action = pickDraw(state, seat, legal);
      score = action?._score ?? -9999;
      if (!action || action.type === "END_TURN") {
        room.aiPhase = "end";
        continue;
      }
    } else {
      action = { type: "END_TURN", playerId: seat };
    }

    if (!action) action = { type: "END_TURN", playerId: seat };
    action = { ...action, playerId: seat };

    if (tried.has(actionKey(action))) {
      if (action.type === "END_TURN") break;
      tried.add(actionKey(action));
      // pula para próxima
      if (phase === "summon") room.aiPhase = "talent";
      else if (phase === "talent") room.aiPhase = "ult_early";
      else if (phase === "ult_early") room.aiPhase = "ult_end";
      else if (phase === "ult_end") room.aiPhase = "attack";
      else if (phase === "attack") {
        room.aiMainFloor = Math.min(room.aiMainFloor ?? 5, 0);
        room.aiPhase = "draw";
      } else if (phase === "draw") room.aiPhase = "end";
      continue;
    }
    tried.add(actionKey(action));

    // Não invoca campeão pago sem ações (paridade vs-IA).
    if (action.type === "SUMMON") {
      const card = state.players[seat]?.hand?.[action.handIdx];
      const acts = state.players[seat]?.actions ?? 0;
      const ritual = !!card?.summonRitual;
      const cost = championSummonCost(card);
      if (!card || (!ritual && acts < cost)) {
        continue;
      }
    }

    // TALENT_START: só inicia; follow-up via TALENT_TARGET / mutações no tick.
    const talentMeta = action._talentEffect ? { ...action } : null;
    const cleanAction = { ...action };
    delete cleanAction._score;
    delete cleanAction._talentEffect;
    delete cleanAction._target;
    delete cleanAction.card;

    // C-B22: a IA invoca ritual como o humano — ação livre + sacrifício
    // (canSummon rejeita ritual sem freeAction desde o fix).
    if (cleanAction.type === "SUMMON") {
      const card = state.players[seat]?.hand?.[cleanAction.handIdx];
      if (card?.summonRitual && !cleanAction.freeAction) {
        const { DfRules } = bootDragonfallEngine();
        const sacs = DfRules?.listRitualSacrificeIndices?.(state, seat, card.summonRitual) || [];
        if (!sacs.length) continue; // sem sacrifício: não invocar (como o humano)
        const sacIdx = sacs[0]; // D5: mínimo viável — o primeiro da lista
        const sac = state.players[seat].field[sacIdx];
        cleanAction.freeAction = true;
        cleanAction.sacrificeIdx = sacIdx;
        cleanAction.sacrificeUid = sac?.uid ?? null;
      }
    }

    // C-A08: a IA pergunta ao humano antes de agir (BLOQUEAR /
    // CONTRAMÁGICA / EXAUSTÃO / PROTEÇÃO). Se suspende, o tick abre a
    // suspensão e só continua na retomada (onAiResume).
    const susp = maybeSuspendAiAction(room, seat, cleanAction, talentMeta);
    if (susp.suspend) {
      return {
        action: cleanAction,
        result: {
          ok: true, suspended: true,
          suspendKind: susp.spec.kind, suspendSpec: susp.spec,
          committed: false,
        },
        talentMeta,
        phase,
      };
    }

    const beforeApply = room.gameState;
    const result = applyAuthoritativeAction(room, seat, cleanAction, null, { serverAi: true });
    if (result.suspended) {
      // C-A05/C-A06/C-A07: a ação ficou suspensa (Ultimate ou reduções) —
      // o tick abre a suspensão e só continua na retomada.
      return {
        action: cleanAction,
        result,
        talentMeta,
        phase,
      };
    }
    if (result.ok) {
      markAiStatusedFromResult(room, seat, beforeApply, result.state, cleanAction);
      markAiBolhasPesadeloFromEvents(room, result.events);
      if (phase === "summon") {
        // Após invocar, tenta mais invocações; senão avança.
        room.aiPhase = "summon";
        resetFloor();
      } else if (phase === "talent") {
        // Após um talento, tenta mais talentos; senão avança.
        room.aiPhase = "talent";
      } else if (phase === "ult_early") {
        room.aiPhase = "ult_end";
        resetFloor();
      } else if (phase === "ult_end") {
        room.aiPhase = "attack";
        resetFloor();
      } else if (phase === "attack") {
        // Após atacar, tenta mais ataques; senão avança.
        room.aiPhase = "attack";
        resetFloor();
      } else if (phase === "draw") {
        // Após comprar, reavalia do início (a carta comprada pode ser
        // jogada) — paridade com o next_action do offline, que recomeça
        // do topo a cada ação.
        room.aiPhase = "summon";
        resetFloor();
      }
      console.info(
        `[server-ai] seat=${seat} phase=${phase} action=${cleanAction.type}`
        + ` score=${score !== -9999 ? score : (action._score ?? "?")}`,
      );
      return {
        action: cleanAction,
        result,
        talentMeta,
        phase,
      };
    }
    console.warn(`[server-ai] reject ${cleanAction.type}`, result?.error || "");
    if (cleanAction.type === "END_TURN") {
      return { action: cleanAction, result, phase };
    }
    // Talent/ult falhou → avança fase.
    if (phase === "summon") room.aiPhase = "talent";
    else if (phase === "talent") room.aiPhase = "ult_early";
    else if (phase === "ult_early") room.aiPhase = "ult_end";
    else if (phase === "ult_end") room.aiPhase = "attack";
    else if (phase === "attack") room.aiPhase = "draw";
    else if (phase === "draw") room.aiPhase = "end";
  }

  const end = applyAuthoritativeAction(room, seat, { type: "END_TURN", playerId: seat }, null, { serverAi: true });
  room.aiPhase = "summon";
  return { action: { type: "END_TURN", playerId: seat }, result: end, phase: "end" };
}

export function buildPendingOnEnterAction(room, seat, summonResult) {
  const events = summonResult?.events || [];
  const pending = events.find((e) => e?.type === "ON_ENTER_PENDING");
  if (!pending) return null;
  const boot = bootDragonfallEngine();
  const DfEngine = boot.DfEngine;
  const ER = boot.DfEffects;
  const state = room.gameState;
  const cIdx = pending.playerId ?? pending.casterIdx ?? seat;
  const fIdx = pending.fieldIdx;
  if (fIdx == null || !state?.players?.[cIdx]?.field?.[fIdx]) return null;
  let plan = null;
  try {
    plan = ER?.planOnEnter?.(state, cIdx, fIdx);
  } catch (e) { /* */ }
  if (!plan?.ok) return null;
  if (plan.mode === "blocked") return null;
  // S2-M12 (offline game_state.gd:495-509): NECROMANCIA da IA resolve com
  // a carta MAIS RECENTE ainda no descarte — autoOnEnterResolution já faz
  // isso (df-engine.js:1429-1432: disc[disc.length - 1]).
  if (plan.mode === "necromancia_pick") {
    let resolution = {};
    try {
      if (typeof DfEngine.autoOnEnterResolution === "function") {
        const aiRng = roomActionRng(room, seat);
        resolution = DfEngine.autoOnEnterResolution(state, cIdx, fIdx, plan, aiRng) || {};
      }
    } catch (e) { /* */ }
    if (!resolution.necromanciaCard) return null;
    return {
      type: "ON_ENTER_RESOLVE",
      playerId: cIdx,
      casterIdx: cIdx,
      fieldIdx: fIdx,
      abilityKey: state.players[cIdx].field[fIdx]?.onEnter || plan.onEnter,
      resolution,
    };
  }

  const abilityKey = state.players[cIdx].field[fIdx]?.onEnter || plan.onEnter;
  let resolution = pickOnEnterResolution(state, seat, abilityKey, cIdx, fIdx) || {};
  if (!resolution || (resolution.targetP == null && resolution.targetI == null
      && resolution.targetPlayerIdx == null && resolution.targetIdx == null)) {
    try {
      if (typeof DfEngine.autoOnEnterResolution === "function") {
        // Determinístico: usar roomActionRng da sala em vez de Math.random (evita decisões não reproduzíveis entre clientes).
        const aiRng = roomActionRng(room, seat);
        resolution = DfEngine.autoOnEnterResolution(state, cIdx, fIdx, plan, aiRng) || {};
      }
    } catch (e) { /* */ }
  }

  return {
    type: "ABILITY_TARGET",
    playerId: cIdx,
    casterIdx: cIdx,
    fieldIdx: fIdx,
    abilityKey,
    targetI: resolution.targetI,
    targetP: resolution.targetP,
    targetPlayerIdx: resolution.targetPlayerIdx ?? resolution.targetIdx,
    resolution,
  };
}

// D-N01: o follow-up de TALENT_START devolve a ação certa por efeito —
// TALENT_TARGET para os 13 com mira, TALENT_AUTO para os AUTO, e
// TALENT_DISCARD quando o alvo sumiu ou o efeito é desconhecido (sem isso
// o talento ficava ativo para sempre e TALENT_ALREADY_ACTIVE travava
// todos os talentos seguintes da partida). Sem talento ativo (ex.:
// CONTRAMÁGICA SIM descartou) — nada a fazer.
const TALENT_TARGET_EFFECTS = new Set([
  "bolaDeFogoTalento", "explosao", "zeroAbsoluto", "medoTalento",
  "baforadaVenenosa", "fortalecerTalento", "investidaTalento",
  "prisaoPrismaticaTalento", "tornadoDeFogo", "trocaDeLugar",
  "corromperTalento", "transformarBichinhoTalento", "doppelganger",
]);
const TALENT_AUTO_EFFECTS = new Set([
  "arsenalDeGuerra", "gritoDeGuerraTalento", "tecnicasDeCombateTalento",
  "podridaoTalento", "barreira", "bolhasTalento", "aceleracao",
  "missemagicos", "desacelerarTalento", "chuvaDeCometas",
  "ressuscitarTalento", "enfraquecerTalento", "invocarDragaoTalento",
  "apodrecidaDescarte",
]);
export function buildTalentFollowUpAction(seat, state, talentMeta) {
  if (!talentMeta?._talentEffect) return null;
  const te = talentMeta._talentEffect;
  if (!state?.activeTalent) return null;
  if (TALENT_TARGET_EFFECTS.has(te)) {
    if (!talentMeta._target) {
      return { type: "TALENT_DISCARD", playerId: seat, talentEffect: te, handIdx: talentMeta.handIdx };
    }
    return {
      type: "TALENT_TARGET",
      playerId: seat,
      talentEffect: te,
      targetP: talentMeta._target.targetP,
      targetI: talentMeta._target.targetI,
      handIdx: talentMeta.handIdx,
    };
  }
  if (TALENT_AUTO_EFFECTS.has(te)) {
    return { type: "TALENT_AUTO", playerId: seat, talentEffect: te, handIdx: talentMeta.handIdx };
  }
  return { type: "TALENT_DISCARD", playerId: seat, talentEffect: te, handIdx: talentMeta.handIdx };
}

async function emitAiEnvelope(room, hooks, seat, action, result) {
  room.actionSeq += 1;
  let presentationEnvelope = result.presentationEnvelope || null;
  if (!presentationEnvelope?.visuals?.length) {
    try {
      presentationEnvelope = buildPresentationEnvelope(
        result.events || [],
        action,
        { causeActionType: action?.type },
      ) || presentationEnvelope;
    } catch (e) { /* */ }
  }
  const envelope = {
    seq: room.actionSeq,
    fromSeat: seat,
    action,
    authoritativeState: result.state || null,
    events: result.events || [],
    serverAi: true,
    presentationEnvelope: presentationEnvelope || undefined,
  };
  // S2-M10: registra quando este envelope foi emitido e quanto dura.
  room.aiLastEnvelopeAt = Date.now();
  room.aiLastEnvelopeDurationMs = presentationEnvelope?.durationMs ?? 0;
  room.aiLastActionType = action?.type || null;
  if (result.state) room.lastSnapshot = { state: result.state, full: true };
  await mirrorRoomNow(room);
  hooks.emitEnvelope(room, envelope);
  // Não chamar onAfterAction completo (resetTurnTimer a cada passo) — só finish check.
  try {
    hooks.onAfterAiStep?.(room, result.state);
  } catch (e) { /* */ }
  try {
    hooks.maybeFinish?.(room, result.state);
  } catch (e) {
    try { hooks.onAfterAction?.(room, result.state); } catch (e2) { /* */ }
  }
  return envelope;
}

/**
 * C-A08 (Lote F): retomada de uma ação da IA suspensa. Chamado pelo
 * módulo de suspensão (hooks.onAiResume) depois que o humano respondeu.
 * `result` é o resultado da autoridade para a ação adiada (null quando a
 * ação foi descartada — EXAUSTÃO SIM / CONTRAMÁGICA SIM). Roda os
 * follow-ups da ação retomada (SUMMON → ABILITY_TARGET, TALENT_START →
 * TALENT_TARGET) com o mesmo tratamento de suspensão do tick, e reagenda.
 * Os follow-ups rodam sem o delay do tick (são parte da mesma jogada);
 * o próximo passo da IA volta a ter o ritmo de 2,5 s.
 */
export async function continueAiAfterResume(room, io, hooks, seat, result, spec) {
  ensureAiFlags(room);
  // A ação suspensa contou como 1 passo quando resolveu.
  if (result?.ok && result?.state) {
    room.aiStepsThisTurn = (room.aiStepsThisTurn || 0) + 1;
  }
  if (room.status !== "playing" || room.gameState?.winner != null) return;
  if (room.gameState?.currentPlayer !== seat || !room.aiControlled[seat]) {
    scheduleServerAi(room, io, hooks);
    return;
  }
  const action = spec?.deferredAction;
  const followActions = [];
  // EXAUSTÃO SIM no SUMMON auto: o campeão entrou sem a instantânea —
  // NÃO construir o follow-up (a habilidade foi cancelada).
  if (action?.type === "SUMMON" && result && !spec?._exaustaoAutoCancelled) {
    const fa = buildPendingOnEnterAction(room, seat, result);
    if (fa) followActions.push(fa);
  }
  if (action?.type === "TALENT_START" && result?.ok && spec?.talentMeta) {
    const fa = buildTalentFollowUpAction(seat, room.gameState, spec.talentMeta);
    if (fa) followActions.push(fa);
  }
  for (const fa of followActions) {
    if (!room.aiControlled[seat] || room.gameState?.currentPlayer !== seat) break;
    if (room.gameState?.winner != null) break;
    const susp = maybeSuspendAiAction(room, seat, fa, spec?.talentMeta);
    if (susp.suspend) {
      await openReactiveSuspension(room, io, reactiveHooksFor(room, io, hooks), susp.spec);
      return;
    }
    const beforeFu = room.gameState;
    const fuResult = applyAuthoritativeAction(room, seat, fa, null, { serverAi: true });
    if (fuResult?.suspended) {
      const s2 = fuResult.suspendSpec || {
        kind: fuResult.suspendKind,
        deferredAction: fuResult.deferredAction,
        defenderSeat: fuResult.defenderSeat,
        askerSeat: fuResult.askerSeat,
      };
      s2.talentMeta = s2.talentMeta || spec?.talentMeta || null;
      if (fuResult.committed) {
        await emitAiEnvelope(room, hooks, seat, fa, fuResult);
      }
      await openReactiveSuspension(room, io, reactiveHooksFor(room, io, hooks), s2);
      return;
    }
    if (fuResult?.ok) {
      markAiStatusedFromResult(room, seat, beforeFu, fuResult.state, fa);
      markAiBolhasPesadeloFromFollowUp(room, fa);
      markAiBolhasPesadeloFromEvents(room, fuResult.events);
      await emitAiEnvelope(room, hooks, seat, fa, fuResult);
      room.aiStepsThisTurn = (room.aiStepsThisTurn || 0) + 1;
    } else if (fa.type === "TALENT_TARGET" || fa.type === "TALENT_AUTO") {
      // D-N01: o follow-up falhou — descarta o talento travado.
      const disc = discardStuckTalent(room, seat);
      if (disc?.ok) {
        await emitAiEnvelope(room, hooks, seat, { type: "TALENT_DISCARD", playerId: seat }, disc);
      }
    }
  }
  scheduleServerAi(room, io, hooks);
}

function scheduleNextTick(room, tickFn) {
  room.aiStepTimer = setTimeout(() => setImmediate(tickFn),
    delayAfterEnvelope(room, room.aiLastActionType || null));
}

/**
 * @param {object} room
 * @param {import('socket.io').Server} io
 * @param {{ emitEnvelope: Function, onAfterAction: Function }} hooks
 */
export function scheduleServerAi(room, io, hooks) {
  ensureAiFlags(room);
  if (room.aiStepTimer) {
    clearTimeout(room.aiStepTimer);
    room.aiStepTimer = null;
  }
  if (room.status !== "playing" || room.gameState?.winner != null) return;

  const cp = room.gameState?.currentPlayer;
  if (cp !== 0 && cp !== 1) return;
  if (!room.aiControlled[cp]) return;

  // Novo turno IA: reinicia fases.
  if (room.aiTurnSeat !== cp) {
    room.aiTurnSeat = cp;
    room.aiPhase = "summon";
    room.aiMainFloor = enemyFieldCount(room.gameState, cp) === 0 ? 1 : 5;
    room.aiStepsThisTurn = 0;
    room.aiStatusedUids = new Set(); // S2-M13: a guarda só vale no turno
    room.aiBolhasPesadeloUsed = new Set(); // D-N07: idem BOLHAS/PESADELO
  }

  const genAtSchedule = room.aiGeneration | 0;

  const tick = () => {
    room.aiStepTimer = null;
    void withRoomLock(room.code, async () => {
      if ((room.aiGeneration | 0) !== genAtSchedule) return;
      if (room.status !== "playing" || room.gameState?.winner != null) return;
      const seat = room.gameState?.currentPlayer;
      if (seat !== 0 && seat !== 1) return;
      if (!room.aiControlled[seat]) return;

      if (room.aiTurnSeat !== seat) {
        room.aiTurnSeat = seat;
        room.aiPhase = "summon";
        room.aiMainFloor = enemyFieldCount(room.gameState, seat) === 0 ? 1 : 5;
        room.aiStepsThisTurn = 0;
        room.aiStatusedUids = new Set(); // S2-M13: a guarda só vale no turno
        room.aiBolhasPesadeloUsed = new Set(); // D-N07: idem BOLHAS/PESADELO
      }

      const pack = pickAndApplyAiAction(room, seat);
      const { action, result, talentMeta } = pack;
      if (!result?.ok) return;
      if ((room.aiGeneration | 0) !== genAtSchedule || !room.aiControlled[seat]) return;

      // C-A05–C-A08: a ação ficou suspensa — não emitir envelope de jogada
      // (o estado intermediário, quando cometido, vai primeiro) e abrir a
      // suspensão; o tick só continua na retomada (onAiResume).
      if (result.suspended) {
        const spec = result.suspendSpec || {
          kind: result.suspendKind,
          deferredAction: result.deferredAction,
          defenderSeat: result.defenderSeat,
          askerSeat: result.askerSeat,
        };
        spec.talentMeta = spec.talentMeta || talentMeta || null;
        if (result.committed) {
          await emitAiEnvelope(room, hooks, seat, action, result);
        }
        await openReactiveSuspension(room, io, reactiveHooksFor(room, io, hooks), spec);
        return;
      }

      await emitAiEnvelope(room, hooks, seat, action, result);
      room.aiStepsThisTurn = (room.aiStepsThisTurn || 0) + 1;

      // Follow-ups com delay dedicado (humano lê a jogada) — apply no emit.
      const followActions = [];
      if (action.type === "SUMMON") {
        const fa = buildPendingOnEnterAction(room, seat, result);
        if (fa) followActions.push(fa);
      }
      if (action.type === "TALENT_START" && talentMeta) {
        const fa = buildTalentFollowUpAction(seat, room.gameState, talentMeta);
        if (fa) followActions.push(fa);
      }

      const stillAiTurn = () => room.status === "playing"
        && room.gameState?.winner == null
        && room.gameState?.currentPlayer === seat
        && room.aiControlled[seat]
        && (room.aiGeneration | 0) === genAtSchedule
        && (room.aiStepsThisTurn || 0) < AI_MAX_STEPS_PER_TURN;

      const runFollowUpsThenContinue = async (idx) => {
        if ((room.aiGeneration | 0) !== genAtSchedule) return;
        if (idx < followActions.length) {
          room.aiStepTimer = setTimeout(() => {
            void withRoomLock(room.code, async () => {
              if (!stillAiTurn()) return;
              const fa = followActions[idx];
              // C-A08: o follow-up também pergunta ao humano (EXAUSTÃO /
              // PROTEÇÃO); se suspende, a retomada continua a cadeia.
              const susp = maybeSuspendAiAction(room, seat, fa, talentMeta);
              if (susp.suspend) {
                await openReactiveSuspension(room, io, reactiveHooksFor(room, io, hooks), susp.spec);
                return;
              }
              const beforeFu = room.gameState;
              const fuResult = applyAuthoritativeAction(room, seat, fa, null, { serverAi: true });
              if (fuResult?.suspended) {
                const s2 = fuResult.suspendSpec || {
                  kind: fuResult.suspendKind,
                  deferredAction: fuResult.deferredAction,
                  defenderSeat: fuResult.defenderSeat,
                  askerSeat: fuResult.askerSeat,
                };
                s2.talentMeta = s2.talentMeta || talentMeta || null;
                if (fuResult.committed) {
                  await emitAiEnvelope(room, hooks, seat, fa, fuResult);
                }
                await openReactiveSuspension(room, io, reactiveHooksFor(room, io, hooks), s2);
                return;
              }
              if (fuResult?.ok) {
                markAiStatusedFromResult(room, seat, beforeFu, fuResult.state, fa);
                markAiBolhasPesadeloFromFollowUp(room, fa);
                markAiBolhasPesadeloFromEvents(room, fuResult.events);
                await emitAiEnvelope(room, hooks, seat, fa, fuResult);
                room.aiStepsThisTurn = (room.aiStepsThisTurn || 0) + 1;
              } else if (fa.type === "TALENT_TARGET" || fa.type === "TALENT_AUTO") {
                // D-N01: o follow-up falhou — descarta o talento travado.
                const disc = discardStuckTalent(room, seat);
                if (disc?.ok) {
                  await emitAiEnvelope(room, hooks, seat, { type: "TALENT_DISCARD", playerId: seat }, disc);
                }
              }
              await runFollowUpsThenContinue(idx + 1);
            }).catch((e) => console.warn("[server-ai] followUp", e?.message || e));
          }, delayAfterEnvelope(room, action.type));
          return;
        }
        if (action.type === "END_TURN") {
          room.aiPhase = "summon";
          room.aiTurnSeat = null;
          if (room.aiControlled[room.gameState?.currentPlayer]
              && (room.aiGeneration | 0) === genAtSchedule) {
            scheduleNextTick(room, tick);
          }
          return;
        }
        if (stillAiTurn()) {
          scheduleNextTick(room, tick);
        } else if (
          room.status === "playing"
          && room.gameState?.winner == null
          && room.aiControlled[room.gameState?.currentPlayer]
          && (room.aiGeneration | 0) === genAtSchedule
        ) {
          scheduleNextTick(room, tick);
        }
      };

      await runFollowUpsThenContinue(0);
    }).catch((e) => console.warn("[server-ai] lock", e?.message || e));
  };

  room.aiStepTimer = setTimeout(() => setImmediate(tick), delayMs());
}

function activateAiSeat(room, seat, io, hooks) {
  room.aiControlled[seat] = true;
  // C-A19: a IA assume SEM renovar o relógio — o prazo de 70 s do turno continua.
  try {
    io.to(room.code).emit("peer_ai_control", {
      seat,
      active: true,
      turnDeadline: room.turnDeadline || null,
    });
  } catch (e) { /* */ }
  try { hooks?.onAiTakeover?.(room, seat); } catch (e) { /* */ }
  try { hooks?.persist?.(); } catch (e) { /* */ }
  // Sempre joga — NÃO forceEndTurn só porque o humano estourou o relógio.
  scheduleServerAi(room, io, hooks);
}

/**
 * Marca assento desconectado; após grace, a IA assume.
 */
export function markSeatDisconnectedForAi(room, seat, io, hooks) {
  ensureAiFlags(room);
  if (seat !== 0 && seat !== 1) return;
  if (room.status !== "playing") return;

  if (room.aiGraceTimer[seat]) {
    clearTimeout(room.aiGraceTimer[seat]);
    room.aiGraceTimer[seat] = null;
  }

  room.aiGraceTimer[seat] = setTimeout(() => {
    room.aiGraceTimer[seat] = null;
    if (room.status !== "playing" || room.gameState?.winner != null) return;
    if (room.sockets[seat]) return;
    activateAiSeat(room, seat, io, hooks);
  }, AI_GRACE_MS);
}

/** Abandono explícito: IA assume imediatamente (sem grace de 8s). */
export function markSeatAbandonedForAi(room, seat, io, hooks) {
  ensureAiFlags(room);
  if (seat !== 0 && seat !== 1) return;
  if (room.status !== "playing") return;
  if (room.aiGraceTimer[seat]) {
    clearTimeout(room.aiGraceTimer[seat]);
    room.aiGraceTimer[seat] = null;
  }
  activateAiSeat(room, seat, io, hooks);
}

export function onHumanReconnectedClearAi(room, seat, io) {
  clearAiSeat(room, seat);
  try {
    io.to(room.code).emit("peer_ai_control", {
      seat,
      active: false,
      turnDeadline: room.turnDeadline || null,
      serverNow: Date.now(),
    });
  } catch (e) { /* */ }
}

export const SERVER_AI_GRACE_MS = AI_GRACE_MS;
export const SERVER_AI_STEP_MS = AI_STEP_MS;
