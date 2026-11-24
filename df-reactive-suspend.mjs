/**
 * Lote F — Bloco 2 (reações, C-A05/C-A06/C-A07/C-A08): suspensão reativa.
 *
 * Um só mecanismo sustenta os 4 itens (proposta 01, §0): a suspensão vive
 * fora do motor puro, na camada da sala. A autoridade (df-authority.mjs)
 * só DECIDE suspender (retorna `suspended: true`); este módulo orquestra
 * (emitir a QUERY, timer de 8 s, retomada). O motor ganha pontos de
 * parada explícitos (split planejar/aplicar nos resolvers).
 *
 * Estado pendente — um só por sala, NUNCA no gameState (ele é serializado
 * e enviado aos clientes). Desde a Frente 1 (MÉDIA 3, 2026-11-24) os campos
 * PUROS do pendente SÃO persistidos (df-reactive-persist.mjs → rooms.json /
 * df_live_rooms.reactive_ctx / blob do Redis) e reativados no boot
 * (restoreReactiveSuspension): se o servidor reiniciar com pergunta aberta,
 * a pergunta volta (timer com o tempo restante; se expirou na queda,
 * resolve como NÃO). O uso da Ultimate NÃO foi gasto, porque o gasto só
 * acontece na resolução ou no cancelamento confirmado.
 *   room.mpPendingReactive = {
 *     qid, kind, queryType, answerType, askerSeat, defenderSeat,
 *     deferredAction,      // C-A05/C-A06/C-A08: a ação inteira, ainda não aplicada
 *     reductions, finish, appliedReductions, currentReduction,  // C-A07
 *     originAction,        // C-A07: a ação que gerou as reduções (p/ o envelope)
 *     talentMeta,          // C-A08: meta do talento da IA (follow-up)
 *     actionSeq,           // guarda: a retomada só vale se o seq não mudou
 *     createdAt, expiresAt, timer, pendingEvents,
 *   }
 * Timeout 7 s + 1 s de folga de rede = 8 s (auto-NÃO). O relógio de 70 s
 * (C-A19) NÃO para durante a pergunta; o forceServerEndTurn adianta a
 * expiração (resolve como NÃO) antes do END_TURN. A pergunta NÃO renova
 * o prazo. A fila FIFO do §0.2 NÃO foi implementada: a autoridade rejeita
 * qualquer outra ação autoritativa enquanto há pendente (REACTIVE_PENDING),
 * e as cadeias C-A05→C-A06 e C-A07 acontecem dentro de UM pendente só.
 *
 * Hooks (de index.mjs — este módulo não importa index.mjs):
 *   emitEnvelope(room, envelope) — difunde p/ os dois assentos (projetado)
 *   maybeFinish(room, state)     — maybeFinishMatch
 *   persist(room)                — touchPersist + mirrorRoomNow
 *   scheduleAi(room)             — reagenda o tick da IA
 *   answerForAi(room, query, askerSeat) — buildAiReactiveAnswer (S2-A02);
 *     devolve { use } ou null (sem resposta — cai no timer)
 *   onAiResume(room, askerSeat, resumeResult, spec) — follow-ups da IA
 *     após a retomada (df-server-ai.mjs: SUMMON → ABILITY_TARGET,
 *     TALENT_START → TALENT_TARGET); sem ele, a IA só reagenda o tick.
 */
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import { DfData } from "./motor/df-data.js";
import { appendEventLogEntry } from "./motor/df-event-log.js";
import { spendUltimateCancelled } from "./motor/df-ultimate-resolve.js";
import { withRoomLock } from "./df-room-store.mjs";
import { applyAuthoritativeAction, buildProtecaoVisualEnvelope } from "./df-authority.mjs";
import { buildAiReactiveAnswer, consumeAiReactiveCard } from "./df-server-ai-reactive.mjs";

export const REACTIVE_QUESTION_MS = 7000;
export const REACTIVE_ANSWER_GRACE_MS = 1000;
export const REACTIVE_SUSPEND_TIMEOUT_MS = REACTIVE_QUESTION_MS + REACTIVE_ANSWER_GRACE_MS;

const QUERY_TO_ANSWER = Object.freeze({
  REACTIVE_BLOCK_QUERY: "REACTIVE_BLOCK_ANSWER",
  REACTIVE_PROTECTION_QUERY: "REACTIVE_PROTECTION_ANSWER",
  REACTIVE_CANCEL_QUERY: "REACTIVE_CANCEL_ANSWER",
  REACTIVE_EXHAUSTION_QUERY: "REACTIVE_EXHAUSTION_ANSWER",
  REACTIVE_COUNTER_QUERY: "REACTIVE_COUNTER_ANSWER",
});

function eng() {
  return bootDragonfallEngine();
}

function heroUltimateName(heroId) {
  const h = (DfData?.heroDefs || []).find((x) => x && x.id === heroId);
  return h?.ultimateName || "";
}

function champAt(state, p, i) {
  return state?.players?.[p]?.field?.[i] || null;
}

function clearTimer(pendente) {
  if (pendente?.timer) {
    clearTimeout(pendente.timer);
    pendente.timer = null;
  }
}

function armTimer(room, io, hooks, pendente) {
  clearTimer(pendente);
  pendente.expiresAt = Date.now() + REACTIVE_SUSPEND_TIMEOUT_MS;
  pendente.timer = setTimeout(() => {
    void withRoomLock(room.code, async () => {
      await expireReactiveSuspensionLocked(room, io, hooks);
    }).catch((e) => console.warn("[reactive-suspend] expire", e?.message || e));
  }, REACTIVE_SUSPEND_TIMEOUT_MS);
  // O timer não segura o processo aberto sozinho.
  if (typeof pendente.timer.unref === "function") pendente.timer.unref();
}

/**
 * Frente 1 (MÉDIA 3): rearma o timer MANTENDO o expiresAt salvo —
 * o tempo que já passou durante a queda não é devolvido ao defensor.
 * (armTimer zera o prazo; aqui só o restante é armado.)
 */
function armTimerWithRemaining(room, io, hooks, pendente) {
  clearTimer(pendente);
  const remaining = Math.max(0, (pendente.expiresAt || 0) - Date.now());
  pendente.timer = setTimeout(() => {
    void withRoomLock(room.code, async () => {
      await expireReactiveSuspensionLocked(room, io, hooks);
    }).catch((e) => console.warn("[reactive-suspend] expire", e?.message || e));
  }, remaining);
  if (typeof pendente.timer.unref === "function") pendente.timer.unref();
}

/** Envelope de retomada: mesmo formato do game_action (seq novo, estado cheio). */
async function broadcastResume(room, io, hooks, action, state, events, logAction) {
  if (!room.eventLog) room.eventLog = [];
  room.actionSeq += 1;
  if (logAction) {
    appendEventLogEntry(room.eventLog, room.actionSeq, action?.playerId ?? 0, logAction, events || []);
  }
  const envelope = {
    seq: room.actionSeq,
    fromSeat: action?.playerId ?? action?.queryFrom ?? 0,
    action: action || null,
    authoritativeState: state || null,
    events: events || [],
    turnDeadline: room.turnDeadline || null,
    // (Lote F, t_865) a retomada é transição crítica: o cliente aplica o
    // estado cheio de forma síncrona em `_apply_cancelled_ult` (e o
    // `_do_ultimate_*` depois da intro/VFX); um patch cairia na fila
    // remota atrás da sequência de início de turno (~3 s) e o uso gasto
    // não apareceria no modelo a tempo — o t_865 lia uses=0 mesmo 1 s
    // depois. O comentário acima já dizia "estado cheio": o diff não
    // pode rebaixá-lo para patch.
    forceFullState: true,
  };
  if (state) room.lastSnapshot = { state, full: true };
  hooks.emitEnvelope(room, envelope);
  if (hooks.persist) await hooks.persist(room);
  if (state && hooks.maybeFinish) hooks.maybeFinish(room, state);
  return envelope;
}

/** Emite a QUERY só ao defensor (nunca ao atacante — ele abriria o box). */
function emitQuery(room, io, pendente, query) {
  const sid = room.sockets?.[pendente.defenderSeat];
  if (!sid) return false;
  const asker = pendente.currentReduction?.askerSeat ?? pendente.askerSeat;
  io.to(sid).emit("remote_action", {
    seq: room.actionSeq,
    fromSeat: asker,
    action: query,
    authoritativeState: null,
    events: [],
    serverAi: !!room.aiControlled?.[asker],
    turnDeadline: room.turnDeadline || null,
    // U-B07 / E-N1 Opção 1 (rodada 5): o visual viaja COM a pergunta —
    // o defensor vê a animação e o box DURANTE ela (o cliente toca o
    // envelope e abre o box por cima). Sem ele, a pergunta vinha antes
    // de qualquer animação e o SIM fazia "nada acontecer".
    presentationEnvelope: pendente.presentationEnvelope || undefined,
  });
  return true;
}

/**
 * Reemite a pergunta reativa aberta para o assento que voltou (join_room).
 * O replay não carrega o pendente e o cliente que volta nunca veria o
 * box — sem isto, a pergunta expira como NÃO sem ele saber.
 * NÃO rearma o timer: o prazo original (7 s + 1 s de graça) continua —
 * cair e voltar não dá tempo extra. Devolve true se reemitiu.
 */
export function reemitReactiveQuery(room, io, seat) {
  const pendente = room?.mpPendingReactive;
  if (!pendente) return false;
  if (pendente.defenderSeat !== seat) return false;
  if (pendente.expiresAt != null && pendente.expiresAt <= Date.now()) return false;
  if (room.aiControlled?.[seat]) return false; // a IA responde sozinha
  let query = null;
  if (pendente.kind === "reductions") {
    const r = pendente.currentReduction || pendente.reductions?.[0];
    if (!r) return false;
    // Chuva: a pergunta nomeia o melhor alvo do lote (igual ao avanço).
    const best = pendente.chuvaProtectAll ? bestChuvaProtectTarget(room, pendente) : null;
    query = buildQuery({ ...pendente, kind: "reductions" }, pendente.qid, {
      defenderIdx: best?.idx ?? currentReductionIdx(room, r),
      defenderName: best?.name || r.targetName || "",
      defenderUid: best?.uid || r.targetUid || "",
    });
  } else {
    query = buildQueryForPendente(room, pendente);
  }
  if (!query) return false;
  return emitQuery(room, io, pendente, query);
}

/**
 * Frente 1 (MÉDIA 3): reativa o pendente salvo na persistência após um
 * reinício (chamado por revivePlayingRoomTimers, ANTES do tick da IA).
 * A parte síncrona (recolocar o pendente + rearmar o timer) acontece
 * na hora — o resto (resolver como NÃO se expirou, continuar a fila de
 * reduções) devolve uma promise. A pergunta é reemitida ao defensor no
 * join (reemitReactiveQuery); aqui só se garante que ela continua viva.
 */
export function restoreReactiveSuspension(room, io, hooks) {
  const saved = room._restoredReactiveCtx;
  room._restoredReactiveCtx = null;
  if (!saved?.pending) return Promise.resolve({ status: "none" });
  const pendente = {
    ...saved.pending,
    timer: null,
    _state: room.gameState,
    pendingEvents: Array.isArray(saved.pending.pendingEvents) ? saved.pending.pendingEvents : [],
    reductions: Array.isArray(saved.pending.reductions) ? [...saved.pending.reductions] : [],
    appliedReductions: Array.isArray(saved.pending.appliedReductions) ? [...saved.pending.appliedReductions] : [],
  };
  room.mpPendingReactive = pendente;
  // Expirou durante a queda: resolve como NÃO (o defensor não respondeu).
  if (pendente.expiresAt != null && pendente.expiresAt <= Date.now()) {
    return resolveAsNo(room, io, hooks, pendente, "RESTART_EXPIRED");
  }
  // Fila de reduções: continua de onde parou (repergunta ou aplica).
  if (pendente.kind === "reductions") {
    return advanceReductions(room, io, hooks);
  }
  // Pergunta simples: rearma o timer com o tempo restante e espera a
  // ANSWER (a pergunta é reemitida no join do defensor).
  armTimerWithRemaining(room, io, hooks, pendente);
  return Promise.resolve({ status: "waiting", qid: pendente.qid, restored: true });
}

function buildQuery(pendente, qid, extra = {}) {
  // O asker é por redução (reductions): o burst carrega o dono do
  // campeão destruído; os demais kinds usam o asker do pendente.
  const asker = pendente.currentReduction?.askerSeat ?? pendente.askerSeat;
  const base = {
    qid,
    queryFrom: asker,
    defenderPlayerId: pendente.defenderSeat,
    attOwner: asker,
  };
  switch (pendente.kind) {
    case "cancelUltimate":
    case "protecaoDivina": {
      const a = pendente.deferredAction || {};
      const heroId = a.heroId || room_hero(pendente, a);
      // U-B01/U-B02 (rodada 3): a pergunta nomeia a origem — habilidade
      // (abilityName/onEnter), talento (talentName/talentEffect) ou
      // Ultimate (ultimateName). O box do defensor lê estes campos
      // (online_battle.gd: _ask_protecao_for_ability/_for_talent).
      const st = pendente._state || {};
      let abilityName = "";
      let onEnter = "";
      let talentName = "";
      let talentEffect = "";
      if (a.type === "ABILITY_TARGET") {
        const caster = st.players?.[a.casterIdx ?? pendente.askerSeat]?.field?.[a.fieldIdx];
        abilityName = caster?.abilityName || a.abilityName || "";
        onEnter = a.abilityKey || caster?.onEnter || "";
      } else if (a.type === "TALENT_TARGET") {
        talentEffect = a.talentEffect || "";
        talentName = st.activeTalent?.card?.name || a.talentName || "";
      }
      return {
        type: pendente.kind === "cancelUltimate" ? "REACTIVE_CANCEL_QUERY" : "REACTIVE_PROTECTION_QUERY",
        ...base,
        ultimateName: heroUltimateName(heroId),
        heroId,
        casterP: pendente.askerSeat,
        defenderIdx: extra.defenderIdx ?? -1,
        defenderName: extra.defenderName || "",
        defenderUid: extra.defenderUid || "",
        talentName,
        talentEffect,
        abilityName,
        onEnter,
      };
    }
    case "bloquearAtaque":
      return {
        type: "REACTIVE_BLOCK_QUERY", ...base,
        attackerIdx: extra.attackerIdx ?? -1,
        defenderIdx: extra.defenderIdx ?? -1,
        attackerName: extra.attackerName || "",
        defenderName: extra.defenderName || "",
      };
    case "exaustao":
    case "exaustaoAuto":
      return {
        type: "REACTIVE_EXHAUSTION_QUERY", ...base,
        casterIdx: extra.casterIdx ?? pendente.askerSeat,
        fieldIdx: extra.fieldIdx ?? -1,
        onEnter: extra.onEnter || "",
        abilityName: extra.abilityName || "",
        championName: extra.championName || "",
      };
    case "contramagica":
      return {
        type: "REACTIVE_COUNTER_QUERY", ...base,
        talentEffect: extra.talentEffect || "",
        talentName: extra.talentName || "",
      };
    case "reductions": {
      const r = pendente.currentReduction;
      return {
        type: "REACTIVE_PROTECTION_QUERY", ...base,
        defenderIdx: extra.defenderIdx ?? -1,
        defenderName: extra.defenderName || "",
        defenderUid: extra.defenderUid || "",
        talentName: r?.source === "chuvaDeCometas" ? "CHUVA DE COMETAS" : "",
        abilityName: r?.source === "chuvaDeCometas" ? "" : (r?.sourceLabel || ""),
        ultimateName: "",
      };
    }
    default:
      return null;
  }
}

// Herói do caster (p/ o ultimateName da QUERY): da ação ou do estado.
function room_hero(pendente, action) {
  if (action?.heroId) return action.heroId;
  const st = pendente._state;
  return st?.players?.[pendente.askerSeat]?.heroId || "";
}

/**
 * Abre a suspensão a partir de um resultado `suspended` da autoridade
 * (spec com kind/deferredAction/reductions/finish) ou de um spec da IA
 * (maybeSuspendAiAction). Chamado DENTRO do lock (game_action / tick).
 * Devolve { status: "waiting", qid } | { status: "done" } | { status: "busy" }.
 */
export async function openReactiveSuspension(room, io, hooks, spec) {
  if (room.mpPendingReactive) return { status: "busy" };
  if (!room.gameState?.players) return { status: "done", reason: "NO_GAME_STATE" };
  const qid = (room._reactiveSeq = (room._reactiveSeq || 0) + 1);
  const pendente = {
    qid,
    kind: spec.kind,
    queryType: null,
    answerType: null,
    askerSeat: spec.askerSeat,
    defenderSeat: spec.defenderSeat,
    deferredAction: spec.deferredAction || null,
    reductions: Array.isArray(spec.reductions) ? [...spec.reductions] : [],
    finish: spec.finish || null,
    appliedReductions: [],
    currentReduction: null,
    originAction: spec.originAction || spec.deferredAction || null,
    talentMeta: spec.talentMeta || null,
    exaustaoCtx: spec.exaustaoCtx || null,
    contramagicaCtx: spec.contramagicaCtx || null,
    // U-B07 / E-N1 Opção 1 (rodada 5): o visual da suspensão (1 das 7
    // fontes que reduzem Poder) viaja na query do defensor — a animação
    // toca e o box aparece DURANTE ela. Vem do spec (autoridade ou IA).
    presentationEnvelope: spec.presentationEnvelope || null,
    actionSeq: room.actionSeq,
    createdAt: Date.now(),
    expiresAt: null,
    timer: null,
    pendingEvents: [],
    _state: room.gameState,
  };
  room.mpPendingReactive = pendente;
  const result = pendente.kind === "reductions"
    ? await advanceReductions(room, io, hooks)
    : await openSingleQuestion(room, io, hooks, pendente);
  // Frente 1 (MÉDIA 3): a pergunta aberta (ou o estado mudado por uma
  // resposta imediata da IA) é persistida NA HORA — o touchPersist do
  // game_action já passou ou nem existe neste caminho. Sem isto, um
  // reinício no meio da pergunta a apagava. O persist é debounced
  // (200 ms PG / 400 ms rooms.json); o shutdown gracioso descarrega.
  try { if (typeof hooks?.persist === "function") await hooks.persist(room); } catch (e) { /* best-effort */ }
  return result;
}

/** Uma pergunta só (C-A05/C-A06/C-A08): emite ou resolve na hora. */
async function openSingleQuestion(room, io, hooks, pendente) {
  const state = room.gameState;
  // Sem carta (re-checado aqui — a mão pode ter mudado): resolve como NÃO.
  const offer = canOfferForKind(state, pendente);
  if (!offer.ok) {
    return resolveAsNo(room, io, hooks, pendente, "NO_CARD");
  }
  // Defensor IA: responde na hora (S2-A02 — buildAiReactiveAnswer).
  // Sem resposta da IA (sem carta / sem módulo): resolve como NÃO na
  // hora — não há humano nesse assento para responder depois.
  if (room.aiControlled?.[pendente.defenderSeat]) {
    const query = buildQueryForPendente(room, pendente);
    const ans = answerForAi(room, hooks, query, pendente.askerSeat);
    return resolveWithAnswer(room, io, hooks, pendente, aiAnswerUse(ans), "AI");
  }
  const query = buildQueryForPendente(room, pendente);
  if (!query) {
    return resolveAsNo(room, io, hooks, pendente, "NO_QUERY");
  }
  pendente.queryType = query.type;
  pendente.answerType = QUERY_TO_ANSWER[query.type] || null;
  pendente._state = state;
  if (!emitQuery(room, io, pendente, query)) {
    // Defensor sem socket e sem IA: o timer resolve como NÃO.
    console.warn("[reactive-suspend] defensor sem socket, qid", pendente.qid);
  }
  armTimer(room, io, hooks, pendente);
  return { status: "waiting", qid: pendente.qid };
}

/** Monta a QUERY da pergunta única a partir do kind + contexto do spec. */
function buildQueryForPendente(room, pendente) {
  const state = room.gameState;
  const a = pendente.deferredAction || {};
  switch (pendente.kind) {
    case "cancelUltimate": {
      const heroId = a.heroId || state.players?.[pendente.askerSeat]?.heroId || "";
      return buildQuery({ ...pendente, kind: "cancelUltimate" }, pendente.qid, {});
    }
    case "protecaoDivina": {
      const tp = a.targetP;
      const ti = a.targetI;
      const t = champAt(state, tp, ti);
      return buildQuery({ ...pendente, kind: "protecaoDivina" }, pendente.qid, {
        defenderIdx: ti ?? -1,
        defenderName: t?.name || "",
        defenderUid: t?.uid || "",
      });
    }
    case "bloquearAtaque": {
      const att = champAt(state, pendente.askerSeat, a.attackerIdx);
      const def = champAt(state, pendente.defenderSeat, a.defenderIdx);
      return buildQuery(pendente, pendente.qid, {
        attackerIdx: a.attackerIdx ?? -1,
        defenderIdx: a.defenderIdx ?? -1,
        attackerName: att?.name || "",
        defenderName: def?.name || "",
      });
    }
    case "exaustao":
    case "exaustaoAuto": {
      const ctx = pendente.exaustaoCtx || {};
      const ch = champAt(state, ctx.casterIdx ?? pendente.askerSeat, ctx.fieldIdx);
      return buildQuery(pendente, pendente.qid, {
        casterIdx: ctx.casterIdx ?? pendente.askerSeat,
        fieldIdx: ctx.fieldIdx ?? -1,
        onEnter: ctx.onEnter || "",
        abilityName: ctx.abilityName || "",
        championName: ctx.championName || ch?.name || "",
      });
    }
    case "contramagica": {
      const ctx = pendente.contramagicaCtx || {};
      return buildQuery(pendente, pendente.qid, {
        talentEffect: ctx.talentEffect || a.talentEffect || "",
        talentName: ctx.talentName || "",
      });
    }
    default:
      return null;
  }
}

function canOfferForKind(state, pendente) {
  const { DfRules } = eng();
  const def = pendente.defenderSeat;
  const ask = pendente.askerSeat;
  switch (pendente.kind) {
    case "cancelUltimate":
      return DfRules?.canOfferCancelUltimate?.(state, def, ask) || { ok: false };
    case "protecaoDivina":
      return DfRules?.canOfferReactiveProtection?.(state, def, ask) || { ok: false };
    case "bloquearAtaque":
      return DfRules?.canOfferReactiveBlock?.(state, def, ask) || { ok: false };
    case "exaustao":
    case "exaustaoAuto":
      return DfRules?.canOfferExaustao?.(state, def, ask) || { ok: false };
    case "contramagica":
      return DfRules?.canOfferContramagica?.(state, def, ask) || { ok: false };
    default:
      return { ok: false };
  }
}

function answerForAi(room, hooks, query, askerSeat) {
  try {
    if (typeof hooks?.answerForAi === "function") {
      return hooks.answerForAi(room, query, askerSeat);
    }
    const ans = buildAiReactiveAnswer(room, query, askerSeat, { seatOffline: false });
    return ans || null;
  } catch (e) {
    console.warn("[reactive-suspend] answerForAi", e?.message || e);
    return null;
  }
}

/** B-N01 (achado da sonda probe-r2-motor): buildAiReactiveAnswer devolve
 *  `{ type, payload }` e o SIM mora em `payload.use` — os 4 usos de
 *  `ans?.use` liam sempre `undefined` e a IA NUNCA dizia SIM a nenhuma
 *  pergunta reativa (BLOQUEAR, PROTEÇÃO, CANCELAR, EXAUSTÃO,
 *  CONTRAMÁGICA). O `ans?.use` fica como fallback (algum hook pode
 *  devolver o formato achatado). */
function aiAnswerUse(ans) {
  return ans?.payload?.use === true || ans?.use === true;
}

/** C-A07: avança a fila de reduções (pergunta por redução, mão relida). */
export async function advanceReductions(room, io, hooks) {
  const pendente = room.mpPendingReactive;
  if (!pendente || pendente.kind !== "reductions") return { status: "done" };
  const { DfRules, DfEffects } = eng();
  // B-N01 (offline battle_screen.gd:3093 / game_state.gd:1054-1059): UMA
  // PROTEÇÃO cancela a chuva INTEIRA — uma pergunta só, ANTES de qualquer
  // redução cair (offline a pergunta abre antes da chuva). O SIM pula
  // TODAS as reduções do lote; o NÃO deixa a chuva cair inteira sem mais
  // perguntas. Sem isto, o SIM pulava só o campeão da pergunta e os
  // anteriores já tinham perdido Poder.
  if (pendente.finish?.kind === "chuvaDeCometas" && !pendente.chuvaProtectAsked) {
    pendente.chuvaProtectAsked = true;
    const casterSeat = pendente.askerSeat ?? 0;
    const opponentSeat = (casterSeat + 1) % 2;
    const offer = DfRules?.canOfferReactiveProtection?.(room.gameState, opponentSeat, casterSeat);
    if (offer?.ok) {
      pendente.defenderSeat = opponentSeat;
      pendente.chuvaProtectAll = true;
      const best = bestChuvaProtectTarget(room, pendente);
      pendente.currentReduction = pendente.reductions[0] || null;
      const query = buildQuery({ ...pendente, kind: "reductions" }, pendente.qid, {
        defenderIdx: best?.idx ?? currentReductionIdx(room, pendente.reductions[0] || {}),
        defenderName: best?.name || pendente.reductions[0]?.targetName || "",
        defenderUid: best?.uid || pendente.reductions[0]?.targetUid || "",
      });
      pendente.queryType = query.type;
      pendente.answerType = QUERY_TO_ANSWER[query.type] || null;
      await flushPendingEvents(room, io, hooks, pendente);
      // Defensor IA: responde na hora (S2-A02) — o SIM cancela o lote.
      if (room.aiControlled?.[opponentSeat]) {
        const ans = answerForAi(room, hooks, query, pendente.askerSeat);
        const use = aiAnswerUse(ans);
        // B-N01: o SIM gasta a PROTEÇÃO (uma carta, um uso) — sem isto
        // a IA protegeria chuvas infinitas com a mesma carta (o caminho
        // direto answerForAi não passa pelo applyReactiveUse do humano).
        if (use) consumeAiReactiveCard(room, opponentSeat, "REACTIVE_PROTECTION_QUERY");
        while (pendente.reductions.length) {
          const rr = pendente.reductions.shift();
          applyOneReduction(room, pendente, rr, use);
        }
        pendente.currentReduction = null;
        return finishReductions(room, io, hooks);
      }
      if (!emitQuery(room, io, pendente, query)) {
        console.warn("[reactive-suspend] defensor sem socket (chuva), qid", pendente.qid);
      }
      armTimer(room, io, hooks, pendente);
      return { status: "waiting", qid: pendente.qid };
    }
  }
  while (pendente.reductions.length) {
    // Jogo acabou no meio da fila: drena sem perguntar (o vencedor já está decidido).
    if (room.gameState?.winner != null) {
      while (pendente.reductions.length) {
        const r = pendente.reductions.shift();
        applyOneReduction(room, pendente, r, false);
      }
      return finishReductions(room, io, hooks);
    }
    const r = pendente.reductions[0];
    const state = room.gameState;
    const defSeat = r.targetP;
    // O defensor é por redução (o dono do alvo): atualizar o
    // pendente.defenderSeat a cada pergunta — o emitQuery e o
    // buildQuery leem dele. Sem isso, o defenderSeat fica undefined
    // (a spec de reduções não o traz) e a QUERY nunca é emitida
    // (emitQuery retorna false, "defensor sem socket") — t_902.
    pendente.defenderSeat = defSeat;
    // O asker é por redução: o burst carrega o dono do campeão
    // destruído (r.askerSeat); o motor usa o asker do pendente (caster).
    const offer = DfRules?.canOfferReactiveProtection?.(state, defSeat, r.askerSeat ?? pendente.askerSeat);
    if (!offer?.ok) {
      pendente.reductions.shift();
      applyOneReduction(room, pendente, r, false);
      continue;
    }
    // Defensor IA: responde na hora (S2-A02).
    if (room.aiControlled?.[defSeat]) {
      pendente.currentReduction = r;
      const query = buildQuery({ ...pendente, kind: "reductions" }, pendente.qid, {
        defenderIdx: currentReductionIdx(room, r),
        defenderName: r.targetName || "",
        defenderUid: r.targetUid || "",
      });
      const ans = answerForAi(room, hooks, query, pendente.askerSeat);
      // B-N01: o SIM gasta a PROTEÇÃO (uma carta, um uso) — ver o bloco
      // da chuva acima; o caminho direto não passa pelo applyReactiveUse.
      if (aiAnswerUse(ans)) consumeAiReactiveCard(room, defSeat, "REACTIVE_PROTECTION_QUERY");
      pendente.reductions.shift();
      applyOneReduction(room, pendente, r, aiAnswerUse(ans));
      continue;
    }
    // Humano: abre a pergunta e espera a ANSWER (ou o timer).
    pendente.currentReduction = r;
    const query = buildQuery({ ...pendente, kind: "reductions" }, pendente.qid, {
      defenderIdx: currentReductionIdx(room, r),
      defenderName: r.targetName || "",
      defenderUid: r.targetUid || "",
    });
    pendente.queryType = query.type;
    pendente.answerType = QUERY_TO_ANSWER[query.type] || null;
    // Difunde o que já foi aplicado sem pergunta, antes do box.
    await flushPendingEvents(room, io, hooks, pendente);
    if (!emitQuery(room, io, pendente, query)) {
      console.warn("[reactive-suspend] defensor sem socket (redução), qid", pendente.qid);
    }
    armTimer(room, io, hooks, pendente);
    return { status: "waiting", qid: pendente.qid };
  }
  return finishReductions(room, io, hooks);
}

function currentReductionIdx(room, r) {
  const field = room.gameState?.players?.[r.targetP]?.field || [];
  const idx = field.findIndex((c) => c && String(c.uid) === String(r.targetUid));
  return idx >= 0 ? idx : (r.targetI ?? -1);
}

/**
 * B-N01: o alvo da pergunta do lote da CHUVA — o campeão do oponente no
 * lote que mais vale proteger (P<=1 morre com -1, ou P>=3 — o mesmo
 * critério do _ai_wants_protect offline). A IA responde SIM por ele; o
 * humano vê o nome dele no box. Sem campeão que valha a pena, o primeiro
 * do lote (a IA responde NÃO e a chuva cai).
 */
function bestChuvaProtectTarget(room, pendente) {
  const state = room.gameState;
  const opponentSeat = pendente.defenderSeat;
  let first = null;
  for (const r of pendente.reductions || []) {
    if (r.targetP !== opponentSeat) continue;
    const field = state?.players?.[r.targetP]?.field || [];
    const idx = field.findIndex((c) => c && String(c.uid) === String(r.targetUid));
    const c = idx >= 0 ? field[idx] : field[r.targetI];
    if (!c) continue;
    const entry = { idx: idx >= 0 ? idx : (r.targetI ?? -1), name: c.name, uid: c.uid };
    if (!first) first = entry;
    const pw = c.currentPower ?? c.power ?? 0;
    if (pw <= 1 || pw >= 3) return entry;
  }
  return first;
}

function applyOneReduction(room, pendente, r, skip) {
  const { DfEffects } = eng();
  const res = DfEffects?.applyPlannedReduction?.(room.gameState, r, { skip });
  if (!res?.ok) return;
  room.gameState = res.state;
  pendente.pendingEvents.push(...(res.events || []));
  pendente.appliedReductions.push({
    targetP: r.targetP,
    targetI: res.events?.find((e) => e?.type === "POWER_REDUCTION")?.targetI ?? r.targetI,
    targetName: r.targetName,
    before: res.before ?? null,
    after: res.after ?? null,
    skipped: res.skipped === true,
    gone: res.gone === true,
  });
  if (res.newPendingReduction) {
    // VINGANÇA em cadeia: entra no FIM da fila.
    pendente.reductions.push(res.newPendingReduction);
  }
}

async function flushPendingEvents(room, io, hooks, pendente) {
  if (!pendente.pendingEvents.length) return;
  const events = pendente.pendingEvents;
  pendente.pendingEvents = [];
  await broadcastResume(room, io, hooks,
    pendente.originAction || { type: "REACTIVE_RESUME", playerId: pendente.askerSeat },
    room.gameState, events, pendente.originAction || null);
}

async function finishReductions(room, io, hooks) {
  const pendente = room.mpPendingReactive;
  if (!pendente) return { status: "done" };
  const { DfEffects } = eng();
  const events = [...pendente.pendingEvents];
  pendente.pendingEvents = [];
  const finish = pendente.finish;
  if (finish?.kind === "raioDuplo") {
    const res = DfEffects?.finishRaioDuplo?.(room.gameState, finish, pendente.appliedReductions);
    if (res?.ok) {
      room.gameState = res.state;
      events.push(...(res.events || []));
    }
  } else if (finish?.kind === "chuvaDeCometas") {
    const res = DfEffects?.finishChuvaDeCometas?.(room.gameState, finish, pendente.appliedReductions);
    if (res?.ok) {
      room.gameState = res.state;
      events.push(...(res.events || []));
    }
  }
  const origin = pendente.originAction || { type: "REACTIVE_RESUME", playerId: pendente.askerSeat };
  clearTimer(pendente);
  room.mpPendingReactive = null;
  await broadcastResume(room, io, hooks, origin, room.gameState, events, origin);
  return { status: "done" };
}

/** Resolve como NÃO sem perguntar (sem carta / sem query / sem socket). */
async function resolveAsNo(room, io, hooks, pendente, reason) {
  return resolveWithAnswer(room, io, hooks, pendente, false, reason);
}

/**
 * Retomada com uma resposta (ANSWER do defensor, NÃO do timer, ou
 * resposta imediata da IA). Assume o lock (chamado de game_action,
 * do timer com lock, ou do forceServerEndTurn). Devolve o status.
 */
export async function resolveWithAnswer(room, io, hooks, pendente, use, via) {
  if (!pendente || room.mpPendingReactive !== pendente) return { status: "none" };
  // Guarda do §0.2: o estado mudou sob a suspensão — descarta a ação.
  // A própria ANSWER (via game_action) incrementa o actionSeq ANTES
  // do resolve — permitir +1 para ela (o resolve direto, sem game_action,
  // deixa o seq em N). Os demais vias (AI/TIMEOUT/NO_CARD) resolvem sem
  // passar pelo game_action, então exigem o seq exato. (Antes, o guarda
  // descartava TODA ANSWER — o uso da Ultimate nunca era gasto no SIM
  // do CANCELAR; t_901.)
  const seqOk = via === "ANSWER"
    ? (room.actionSeq === pendente.actionSeq || room.actionSeq === pendente.actionSeq + 1)
    : (room.actionSeq === pendente.actionSeq);
  if (!seqOk) {
    console.warn("[reactive-suspend] actionSeq mudou sob a suspensão (qid",
      pendente.qid, "— ação descartada");
    clearTimer(pendente);
    room.mpPendingReactive = null;
    return { status: "discarded" };
  }
  switch (pendente.kind) {
    case "cancelUltimate":
      return resolveCancelUltimate(room, io, hooks, pendente, use);
    case "protecaoDivina":
      return resolveProtecaoDivina(room, io, hooks, pendente, use);
    case "bloquearAtaque":
    case "exaustao":
    case "exaustaoAuto":
    case "contramagica":
      return resolveAiAction(room, io, hooks, pendente, use, via);
    case "reductions": {
      // B-N01: a pergunta do lote da CHUVA resolve TODAS as reduções de
      // uma vez (SIM = chuva cancelada; NÃO/timeout = chuva cai inteira).
      if (pendente.chuvaProtectAll === true) {
        while (pendente.reductions.length) {
          const rr = pendente.reductions.shift();
          applyOneReduction(room, pendente, rr, use);
        }
        pendente.currentReduction = null;
        clearTimer(pendente);
        return finishReductions(room, io, hooks);
      }
      // A ANSWER responde à pergunta da currentReduction.
      const r = pendente.currentReduction;
      if (!r) {
        clearTimer(pendente);
        room.mpPendingReactive = null;
        return { status: "done" };
      }
      pendente.reductions.shift();
      applyOneReduction(room, pendente, r, use);
      pendente.currentReduction = null;
      clearTimer(pendente);
      return advanceReductions(room, io, hooks);
    }
    default:
      clearTimer(pendente);
      room.mpPendingReactive = null;
      return { status: "done" };
  }
}

async function resolveCancelUltimate(room, io, hooks, pendente, use) {
  const deferred = pendente.deferredAction;
  if (use === true) {
    // SIM: o uso é gasto, sem efeito (C-A05).
    const res = spendUltimateCancelled(room.gameState, deferred);
    clearTimer(pendente);
    room.mpPendingReactive = null;
    if (!res.ok) {
      console.warn("[reactive-suspend] spendUltimateCancelled", res.error);
      return { status: "done" };
    }
    room.gameState = res.state;
    await broadcastResume(room, io, hooks, deferred, room.gameState, res.events, deferred);
    return { status: "done" };
  }
  // NÃO: encadeia a PROTEÇÃO DIVINA (C-A06) quando a Ultimate é
  // BOMBA/VAMPIRISMO e o defensor tem a carta — mesma ação suspensa,
  // novo qid (nunca dois pendentes).
  const ut = ultimateTypeOf(room, deferred);
  if ((ut === "targetEnemy" || ut === "vampirism")) {
    const { DfRules } = eng();
    if (DfRules?.canOfferReactiveProtection?.(room.gameState, pendente.defenderSeat, pendente.askerSeat)?.ok) {
      pendente.kind = "protecaoDivina";
      pendente.qid = (room._reactiveSeq = (room._reactiveSeq || 0) + 1);
      pendente.currentReduction = null;
      clearTimer(pendente);
      return openSingleQuestion(room, io, hooks, pendente);
    }
  }
  // Sem 2ª pergunta: a Ultimate resolve. resume:true evita re-suspender
  // a mesma Ultimate (o defensor ainda tem a carta).
  clearTimer(pendente);
  room.mpPendingReactive = null;
  return applyDeferred(room, io, hooks, pendente, deferred, { resume: true });
}

async function resolveProtecaoDivina(room, io, hooks, pendente, use) {
  const deferred = pendente.deferredAction;
  clearTimer(pendente);
  room.mpPendingReactive = null;
  // SIM: a Ultimate resolve SEM a redução (skipPower); NÃO: normal.
  const action = use === true ? { ...deferred, skipPower: true } : { ...deferred };
  return applyDeferred(room, io, hooks, pendente, action, { resume: true });
}

/** Aplica a ação adiada (NÃO/timeout) e difunde; encadeia nova suspensão se houver. */
async function applyDeferred(room, io, hooks, pendente, action, opts) {
  const clean = { ...action };
  delete clean.reactiveServerDriven;
  const result = applyAuthoritativeAction(room, pendente.askerSeat, clean, null, opts);
  if (!result.ok) {
    console.warn("[reactive-suspend] applyDeferred", result.error);
    return afterAiResume(room, io, hooks, pendente, null);
  }
  // A ação adiada pode suspender de novo (ex.: VINGANÇA no alvo da
  // Ultimate) — abre o novo pendente com o mesmo qid-sequência.
  if (result.suspended && (result.suspendSpec || result.suspendKind)) {
    const spec = result.suspendSpec || {
      kind: result.suspendKind,
      deferredAction: result.deferredAction,
      defenderSeat: result.defenderSeat,
      askerSeat: result.askerSeat,
    };
    spec.originAction = spec.originAction || clean;
    // O envelope intermediário já foi difundido? Não — a ação adiada
    // ainda não difundiu nada; difundir o estado intermediário agora
    // (mesmo formato do game_action: seq novo, logEntry, presentation).
    // U-B07 / E-N1 Opção 1 (rodada 5): o visual da ação adiada JÁ tocou
    // na suspensão — não re-emitir no envelope intermediário (exatamente
    // 1 vez). O visual da NOVA suspensão (ex.: VINGANÇA) continua.
    const playedKinds = new Set((pendente.presentationEnvelope?.visuals || [])
      .map((v) => v?.kind).filter(Boolean));
    const stripPlayedVisuals = (env) => {
      if (!env || !playedKinds.size) return env;
      return { ...env, visuals: (env.visuals || []).filter((v) => !playedKinds.has(v?.kind)) };
    };
    const stripPlayedList = (list) => (Array.isArray(list) && playedKinds.size
      ? list.filter((v) => !playedKinds.has(v?.kind)) : list);
    room.actionSeq += 1;
    const envelope = {
      seq: room.actionSeq,
      fromSeat: pendente.askerSeat,
      action: clean,
      authoritativeState: result.state || null,
      events: result.events || [],
      logEntry: result.logEntry || null,
      presentation: stripPlayedList(result.presentation) || undefined,
      presentationEnvelope: stripPlayedVisuals(result.presentationEnvelope) || undefined,
      turnDeadline: room.turnDeadline || null,
    };
    if (result.state) room.lastSnapshot = { state: result.state, full: true };
    hooks.emitEnvelope(room, envelope);
    if (hooks.persist) await hooks.persist(room);
    const opened = await openReactiveSuspension(room, io, hooks, spec);
    return { status: opened.status === "waiting" ? "waiting" : "done", qid: opened.qid };
  }
  await broadcastResume(room, io, hooks, clean, result.state, result.events || [], clean);
  return afterAiResume(room, io, hooks, pendente, result);
}

/** Retomada de ação da IA (C-A08): descarta, aplica ou segue o fluxo. */
async function resolveAiAction(room, io, hooks, pendente, use, via) {
  const deferred = pendente.deferredAction;
  clearTimer(pendente);
  room.mpPendingReactive = null;
  switch (pendente.kind) {
    case "bloquearAtaque": {
      // SIM: o ataque é bloqueado (custo cobrado, atacante tapped).
      const action = use === true ? { ...deferred, blocked: true } : { ...deferred };
      return applyDeferred(room, io, hooks, pendente, action, { resume: true, serverAi: true });
    }
    case "exaustao": {
      // SIM: o follow-up é descartado — a habilidade nunca resolve.
      if (use === true) return afterAiResume(room, io, hooks, pendente, null);
      // NÃO: encadeia a PROTEÇÃO DIVINA (U-B01, rodada 3) quando a
      // habilidade é uma das 4 que reduzem Poder e o defensor tem a
      // carta — mesma ação suspensa, novo qid (nunca dois pendentes).
      // Ordem do offline: EXAUSTÃO primeiro, PROTEÇÃO depois (espelho
      // do encadeamento CANCELAR → PROTEÇÃO em resolveCancelUltimate).
      const abKey = deferred?.abilityKey || pendente.exaustaoCtx?.onEnter || "";
      if (["bolaDeFogo", "assassinar", "transformarBichinho", "incendiar"].includes(abKey)) {
        const { DfRules } = eng();
        if (DfRules?.canOfferReactiveProtection?.(room.gameState, pendente.defenderSeat, pendente.askerSeat)?.ok) {
          pendente.kind = "protecaoDivina";
          pendente.qid = (room._reactiveSeq = (room._reactiveSeq || 0) + 1);
          pendente.currentReduction = null;
          // U-B07 / E-N1 Opção 1: o visual da PROTEÇÃO encadeada viaja
          // na query (a pergunta aparece DURANTE a animação).
          pendente.presentationEnvelope = buildProtecaoVisualEnvelope(deferred, room.gameState, pendente.askerSeat)
            || pendente.presentationEnvelope || null;
          clearTimer(pendente);
          // resolveAiAction zerou room.mpPendingReactive no início —
          // re-registrar o pendente (a cadeia CANCELAR → PROTEÇÃO não
          // zera, por isso não precisa; aqui precisa).
          room.mpPendingReactive = pendente;
          return openSingleQuestion(room, io, hooks, pendente);
        }
      }
      return applyDeferred(room, io, hooks, pendente, deferred, { resume: true, serverAi: true });
    }
    case "exaustaoAuto": {
      // SIM: o campeão entra SEM a instantânea (SUMMON sem o auto-resolve).
      // NÃO: o SUMMON resolve com o auto (applyActionWithOnEnter).
      if (use === true) {
        // A retomada NÃO pode construir o follow-up ABILITY_TARGET: a
        // habilidade foi cancelada (continueAiAfterResume lê a flag).
        pendente._exaustaoAutoCancelled = true;
        return applyDeferred(room, io, hooks, pendente, deferred,
          { resume: true, serverAi: true, noOnEnterAuto: true });
      }
      return applyDeferred(room, io, hooks, pendente, deferred, { resume: true, serverAi: true });
    }
    case "contramagica": {
      // SIM: o talento é descartado da mão, sem efeito e sem custo.
      if (use === true) {
        const { DfEffects } = eng();
        const res = DfEffects?.discardTalentFromHand?.(room.gameState, pendente.askerSeat, deferred.handIdx);
        if (!res?.ok) {
          console.warn("[reactive-suspend] discardTalentFromHand", res?.error);
          return afterAiResume(room, io, hooks, pendente, null);
        }
        room.gameState = res.state;
        await broadcastResume(room, io, hooks, deferred, room.gameState, res.events, deferred);
        return afterAiResume(room, io, hooks, pendente, null);
      }
      return applyDeferred(room, io, hooks, pendente, deferred, { resume: true, serverAi: true });
    }
    default:
      return afterAiResume(room, io, hooks, pendente, null);
  }
}

/** Após a retomada de uma ação da IA: follow-ups + reagenda o tick. */
async function afterAiResume(room, io, hooks, pendente, result) {
  if (room.aiControlled?.[pendente.askerSeat]) {
    try {
      if (typeof hooks?.onAiResume === "function") {
        await hooks.onAiResume(room, pendente.askerSeat, result, pendente);
      } else if (typeof hooks?.scheduleAi === "function") {
        hooks.scheduleAi(room);
      }
    } catch (e) {
      console.warn("[reactive-suspend] onAiResume", e?.message || e);
    }
  }
  return { status: "done" };
}

function ultimateTypeOf(room, action) {
  const heroId = action?.heroId || room.gameState?.players?.[action?.playerId ?? 0]?.heroId;
  const h = (DfData?.heroDefs || []).find((x) => x && x.id === heroId);
  return h?.ultimateType || action?.ultimateType || "";
}

/**
 * Chamado por index.mjs quando uma REACTIVE_*_ANSWER chega (após a
 * ANSWER aplicar e difundir). Casa por qid; fora do prazo → ignorado
 * (a autoridade já rejeita com REACTIVE_EXPIRED antes de aplicar).
 */
export async function resolveReactiveSuspension(room, io, hooks, answerAction) {
  const pendente = room.mpPendingReactive;
  if (!pendente) return { status: "none" };
  if (answerAction?.qid != null && answerAction.qid !== pendente.qid) {
    return { status: "stale" };
  }
  const use = answerAction?.use === true;
  clearTimer(pendente);
  return resolveWithAnswer(room, io, hooks, pendente, use, "ANSWER");
}

/** Expiração do timer (8 s → auto-NÃO). Assume o lock (chamado com lock). */
export async function expireReactiveSuspensionLocked(room, io, hooks) {
  const pendente = room.mpPendingReactive;
  if (!pendente) return { status: "none" };
  clearTimer(pendente);
  return resolveWithAnswer(room, io, hooks, pendente, false, "TIMEOUT");
}

/** Expiração com lock (timer / forceServerEndTurn fora do lock). */
export async function expireReactiveSuspension(room, io, hooks) {
  return withRoomLock(room.code, async () => {
    await expireReactiveSuspensionLocked(room, io, hooks);
  }).catch((e) => console.warn("[reactive-suspend] expire", e?.message || e));
}
