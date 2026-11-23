/**
 * Cérebro IA Difícil — puro (sem DOM).
 * Usado pela IA de disconnect MP (servidor) e espelha heurísticas do vs-IA Difícil.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// D-10 (Lote F): o cérebro usava `pl.maxUltimateUses ?? 1` — campo nunca
// inicializado (df-match-init só põe `ultimateUses: 0`) — a IA só usava
// 1 Ultimate por partida, enquanto o motor permite 3–4
// (getMaxUltimateUses). Usar a mesma fonte do motor.
import { getEffectiveMaxUltimateUses } from "./motor/df-ultimate-resolve.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_FIELD = 6;
// F7-11 D13: MAX_HAND é 8 no jogo (GameState.MAX_HAND) — o 10 fazia a
// substituta usar a CONJURAÇÃO com a mão cheia (gasto à toa) e liberava
// a compra com 8-9 cartas.
const MAX_HAND = 8;
const MAX_ACTIONS = 3;

let _profile = null;

export function loadHardProfile() {
  if (_profile) return _profile;
  const candidates = [
    join(__dirname, "ai-hard.json"),
    join(__dirname, "..", "artifacts", "dragonfall", "ai-hard.json"),
    join(__dirname, "..", "ai-hard.json"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        _profile = JSON.parse(readFileSync(p, "utf8"));
        return _profile;
      }
    } catch (e) { /* next */ }
  }
  _profile = {
    version: 1,
    globals: { attackScoreMul: 1.08, summonScoreMul: 0.98, drawPenalty: -5, ultimateBias: 1.08 },
    // D-N14 (offline _best_summon, ai_brain.gd:447-745): os pesos vivos
    // são os do offline. Vários ramos usam valores literais no código
    // (condicionais P1/usável — sem um único peso); as chaves mortas
    // (fieldSlotBonus, rapidezAttackFollowUp, fumacaOnlyP1Penalty) foram
    // removidas com os ramos que as usavam.
    onEnter: {
      invokeDragon: 7, rapidez: 7, summonRitual: 23,
      raioDuplo: 8, auraAntiMagia: 4,
      sobrepujar: 6,
    },
    attack: {
      cleanKillBase: 28, cleanKillPerDefPower: 10, lastChampionBonus: 45,
      tradeKillPerPower: 5, tradePenalty: 12,
    },
  };
  return _profile;
}

export function resetHardProfileCache() {
  _profile = null;
}

function g(key, fallback) {
  const v = loadHardProfile()?.globals?.[key];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
}
function onEnterW(key, fallback) {
  const v = loadHardProfile()?.onEnter?.[key];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
}
function atkW(key, fallback) {
  const v = loadHardProfile()?.attack?.[key];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

export function fieldCount(state, pIdx) {
  return (state.players[pIdx]?.field || []).filter(Boolean).length;
}

export function enemyFieldCount(state, seat) {
  let n = 0;
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p !== seat) n += fieldCount(state, p);
  }
  return n;
}

/** S2-A08 (offline ai_brain.gd:19-44): placar do ponto de vista de `seat`.
 *  VP x3 + Poder em campo x1 + cartas na mão x0,5. Positivo = na frente. */
export function evaluateAiPosition(state, seat) {
  const me = state.players[seat] || {};
  const foe = state.players[humanSeat(state, seat)] || {};
  const vpDiff = (me.vp ?? 0) - (foe.vp ?? 0);
  const pow = (pl) => (pl.field || []).reduce((s, c) => s + (c ? (c.currentPower ?? c.power ?? 0) : 0), 0);
  const handDiff = (me.hand?.length ?? 0) - (foe.hand?.length ?? 0);
  return vpDiff * 3 + (pow(me) - pow(foe)) + handDiff * 0.5;
}

/** S2-A08: mitigacao (<= -4) / campo (>= +4) / equilibrio. */
export function aiMode(state, seat) {
  const s = evaluateAiPosition(state, seat);
  if (s <= -4) return "mitigacao";
  if (s >= 4) return "campo";
  return "equilibrio";
}

function enemyHasHand(state, seat) {
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    if ((state.players[p]?.hand?.length || 0) > 0) return true;
  }
  return false;
}

// D-N11: o combatOutcome ingênuo (killD: ap >= dp) foi removido — todos
// os usos agora passam por combatOutcomeOverpower (empate + Sobrepujar).

function isOverpower(c) {
  return !!(c && (c.abilityName === "Sobrepujar" || c.constantEffect === "sobrepujar"
    || c.tecnicasSobrepujar));
}

function hasInvestida(c) {
  return !!(c && (c.constantEffect === "investida"
    || (c.abilityType === "constant" && c.abilityName === "Investida")
    || c.freeAttack));
}
function hasLaco(c) {
  return !!(c && (c.constantEffect === "lacoDeSangue" || c.abilityName === "Laço de Sangue"));
}
function hasInspirar(c) {
  return !!(c && (c.constantEffect === "inspirar" || c.abilityName === "Inspirar"));
}
function hasDesafiante(c) {
  return !!(c && (c.constantEffect === "desafiante" || c.abilityName === "Desafiante"));
}
function enemyHasPowerAtLeast(state, seat, minPow) {
  const min = minPow | 0;
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    for (const c of state.players[p]?.field || []) {
      if (c && (c.currentPower ?? c.power ?? 0) >= min) return true;
    }
  }
  return false;
}

/** Adversários sem contar o próprio enfeitiçado (offline `foes`). */
function foesExcludingCharmed(state, seat) {
  const out = [];
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    (state.players[p]?.field || []).forEach((c, i) => {
      if (c && !(c.charme && c.charmeOriginalOwner === seat)) out.push({ p, i, c });
    });
  }
  return out;
}

/** D-N09/D-N10 (offline _only_p1_targets, ai_brain.gd:269-287): todos os
 *  alvos VÁLIDOS são P1 — a carta é pulada de vez (nem como último recurso). */
function onlyP1Targets(state, seat, oe) {
  const foes = foesExcludingCharmed(state, seat);
  if (!foes.length) return false;
  if (oe === "incendiar") {
    const valid = foes.filter((t) => !(t.c.barrier || t.c.barrierPermanent));
    return valid.length > 0 && valid.every((t) => (t.c.currentPower ?? t.c.power ?? 0) === 1);
  }
  return foes.every((t) => (t.c.currentPower ?? t.c.power ?? 0) === 1);
}

function foeHasP1NoBarrier(state, seat) {
  return foesExcludingCharmed(state, seat).some((t) =>
    (t.c.currentPower ?? t.c.power ?? 0) === 1 && !(t.c.barrier || t.c.barrierPermanent));
}

function hasBolaTarget(state, seat) {
  return foesExcludingCharmed(state, seat).some((t) =>
    !(t.c.barrier || t.c.barrierPermanent)
    && !(t.c.podridao || t.c.name === "APODRECIDA")
    && (t.c.currentPower ?? t.c.power ?? 0) >= 1);
}

function hasUnpoisonedFoe(state, seat) {
  return foesExcludingCharmed(state, seat).some((t) => !t.c.poisoned);
}

function hasUnimprisonedFoe(state, seat) {
  return foesExcludingCharmed(state, seat).some((t) => !t.c.prisaoPrismatica);
}

function hasUnburnedNonBarrierFoe(state, seat) {
  return foesExcludingCharmed(state, seat).some((t) =>
    !t.c.burning && !(t.c.barrier || t.c.barrierPermanent));
}

function hasValidSepararTarget(state, seat) {
  return foesExcludingCharmed(state, seat).some((t) =>
    (t.c.currentPower ?? t.c.power ?? 0) === 2
    && !t.c.inspiracao && !t.c.wallBuff && (t.c.furyStacks ?? 0) <= 0);
}

function hasFoePower(state, seat, pw) {
  return foesExcludingCharmed(state, seat).some((t) =>
    (t.c.currentPower ?? t.c.power ?? 0) === pw);
}
function hasLegalAttackTarget(state, seat, attackerStub) {
  if (!attackerStub) return false;
  const att = { ...attackerStub, tapped: false, frozen: false };
  for (let ep = 0; ep < (state.playersCount || 2); ep++) {
    if (ep === seat) continue;
    for (const d of state.players[ep]?.field || []) {
      if (!d || d.shielded) continue;
      if (!shouldAttack(att, d)) continue;
      return true;
    }
  }
  return false;
}
function canSameTurnAttackAfterSummon(state, seat, card, actionsAfter) {
  if (!card || enemyFieldCount(state, seat) <= 0) return false;
  const free = hasInvestida(card);
  if (!free && (actionsAfter ?? 0) < 1) return false;
  const stub = {
    ...card,
    tapped: false,
    frozen: false,
    freeAttack: free || !!card.freeAttack,
  };
  if (hasDesafiante(card) && fieldCount(state, seat) === 0) {
    stub.currentPower = (card.currentPower ?? card.power ?? 0) + 2;
  }
  return hasLegalAttackTarget(state, seat, stub);
}

/** Premissas 1/15: aliado com Técnicas/Grito deve poder atacar no mesmo turno.
 *  (1.51.96 item 13a) SILENCIADO não recebe Sobrepujar (Técnicas) nem
 *  Fúria (Grito) — não conta como atacante do follow-up. */
function canAllyFollowUpAttackAfterGrant(state, seat, actionsAfter, grant) {
  if ((actionsAfter ?? 0) < 1 || enemyFieldCount(state, seat) <= 0) return false;
  const field = state.players[seat]?.field || [];
  if (!field.length) return false;
  for (const c of field) {
    if (!c || c.tapped || c.frozen || c.silenced) continue;
    const stub = {
      ...c,
      tapped: false,
      frozen: false,
    };
    if (grant === "tecnicas") stub.tecnicasSobrepujar = true;
    if (grant === "grito") stub.fury = true;
    if (hasLegalAttackTarget(state, seat, stub)) return true;
  }
  return false;
}

/** (1.51.96 item 8) espelho de _hook_ready (ai_brain.gd): o Gancho está
 *  pronto para usar neste turno? (herói Gancho, Ultimate disponível e
 *  espaço no próprio campo). */
function hookReady(state, seat) {
  const pl = state.players[seat];
  if (!pl) return false;
  const ultType = pl.heroDef?.ultimateType || pl.ultimateType;
  if (ultType !== "hook") return false;
  const maxUlt = getEffectiveMaxUltimateUses(pl, pl.heroDef?.id || pl.heroId);
  if ((pl.ultimateUses ?? 0) >= maxUlt || pl.usedUltimateThisTurn) return false;
  return (pl.field || []).length < MAX_FIELD;
}

/** (1.51.96 item 11) espelho de _can_attack_after_grito (ai_brain.gd):
 *  depois de pagar o custo, algum aliado com a Fúria (+1 de Poder) pode
 *  atacar E destruir um adversário. A carta invocada NÃO conta (não
 *  recebe a própria Fúria); SILENCIADO não recebe Fúria (item 13a) e a
 *  APODRECIDA nunca ganha Poder — nenhum dos dois conta. */
function canAttackAfterGrito(state, seat, cost) {
  const pl = state.players[seat];
  if (!pl) return false;
  const foes = foesExcludingCharmed(state, seat);
  if (!foes.length) return false;
  const statused = state.aiStatusedUids || new Set();
  for (const a of (pl.field || [])) {
    if (!a || a.silenced || a.podridao || a.name === "APODRECIDA") continue;
    if (a.tapped || a.frozen || a.charme) continue;
    const pa = (a.currentPower ?? a.power ?? 0) + 1;
    for (const { c: f } of foes) {
      if (!f || f.shielded || f.charme) continue;
      if (isResistenteServer(f) && (a.freeAttack || hasInvestida(a)
        || a.prisaoPrismatica || a.urso_pesado || a.name === "URSO PESADO")) continue;
      if ((pl.actions ?? 0) - (cost || 0) < attackActionCost(a, f)) continue;
      const stub = { ...a, currentPower: pa };
      const { killD } = combatOutcomeOverpower(stub, f);
      if (!killD) continue;
      if (statused.has(f.uid)) continue;
      return true;
    }
  }
  return false;
}

/** (1.51.96 item 11) espelho de _grito_worth_it (ai_brain.gd): o Grito
 *  vale com um ataque que aproveite a Fúria — e também sem adversários
 *  em campo, quando o +1 de Poder ainda vale como defesa. */
function gritoWorthIt(state, seat, cost) {
  if (!foesExcludingCharmed(state, seat).length) {
    return (state.players[seat]?.field || []).some((a) => a && !a.silenced
      && !(a.podridao || a.name === "APODRECIDA"));
  }
  return canAttackAfterGrito(state, seat, cost);
}

/** (1.51.96 itens 12 e 14) espelho de _free_attack_kill_possible
 *  (ai_brain.gd): o aliado mais forte que pode receber o ataque livre
 *  da Tina DESTRÓI um adversário com ele. NUNCA num P1, nunca num
 *  SILENCIADO (item 13a), nunca cansado ou apodrecida; a Investida não
 *  ataca Resistente. Devolve { attIdx } ou null. */
function freeAttackKillPossible(state, seat) {
  const pl = state.players[seat];
  if (!pl) return null;
  if (!foesExcludingCharmed(state, seat).length) return null;
  const statused = state.aiStatusedUids || new Set();
  const valid = [];
  (pl.field || []).forEach((a, i) => {
    if (!a || a.tapped || a.podridao || a.name === "APODRECIDA" || a.silenced) return;
    if ((a.currentPower ?? a.power ?? 0) < 2) return;
    if (hasInvestida(a)) return;
    valid.push({ a, i });
  });
  if (!valid.length) return null;
  valid.sort((x, y) => ((y.a.currentPower ?? y.a.power ?? 0) - (x.a.currentPower ?? x.a.power ?? 0)));
  const att = valid[0].a;
  if (att.frozen || att.charme) return null;
  for (const { c: f } of foesExcludingCharmed(state, seat)) {
    if (!f || f.shielded || f.charme) continue;
    if (isResistenteServer(f)) continue;
    const { killD } = combatOutcomeOverpower(att, f);
    if (!killD) continue;
    if (statused.has(f.uid)) continue;
    return { attIdx: valid[0].i };
  }
  return null;
}

/** (1.51.96 item 14) espelho de _investida_talento_worth_it (ai_brain.gd):
 *  o talento INVESTIDA é PERMANENTE — sem adversários, vale com qualquer
 *  aliado livre P2+; com adversários, só quando o ataque livre DESTRÓI
 *  alguém. A Ultimate da Tina continua com o portão estrito
 *  (freeAttackKillPossible): o ataque livre dela é só deste turno. */
function investidaTalentWorthIt(state, seat) {
  const pl = state.players[seat];
  if (!pl) return false;
  const hasAlly = (pl.field || []).some((a) => a && !a.tapped
    && !(a.podridao || a.name === "APODRECIDA") && !a.silenced
    && (a.currentPower ?? a.power ?? 0) >= 2 && !hasInvestida(a));
  if (!hasAlly) return false;
  if (!foesExcludingCharmed(state, seat).length) return true;
  return freeAttackKillPossible(state, seat) != null;
}

/** (1.51.96 item 10) espelho de _decisive_attack (ai_brain.gd): o melhor
 *  ABATE LIMPO disponível agora, promovido antes de invocar SÓ quando
 *  vira o jogo ou pontua bastante — IA ATRÁS (mitigação), abate de 2+ PV,
 *  ou invocar agora gastaria a ação do abate (custo da invocação em
 *  `summonCost` + custo do ataque > ações). A pontuação é IDÊNTICA à do
 *  scoreAttackAction para abates limpos. Devolve ATTACK_RESOLVE ou null. */
export function pickDecisiveAttack(state, seat, summonCost = 0) {
  const pl = state.players[seat];
  if (!pl) return null;
  const statused = state.aiStatusedUids || new Set();
  let best = null;
  let bestScore = 0;
  let bestVp = 0;
  let bestCost = 0;
  for (let ai = 0; ai < (pl.field || []).length; ai++) {
    const att = pl.field[ai];
    if (!att || att.charme) continue;
    for (let ep = 0; ep < (state.playersCount || 2); ep++) {
      if (ep === seat) continue;
      for (let di = 0; di < (state.players[ep]?.field || []).length; di++) {
        const def = state.players[ep].field[di];
        if (!def || def.shielded) continue;
        if (def.charme && def.charmeOriginalOwner === seat) continue;
        if (!shouldAttack(att, def)) continue;
        const { killD, killA, ap, dp } = combatOutcomeOverpower(att, def);
        if (!killD || killA) continue;
        if (statused.has(def.uid)) continue;
        const vpGain = noVpOnDestroy(def) ? 0
          : ((att.constantEffect === "recompensaDupla" && !att.silenced) ? 2 : 1);
        const cost = attackActionCost(att, def);
        let score = 100 + vpGain * 10 + dp * 2;
        if (ap === 1) score += 15;
        if (dp === 1 && killD) score += 15;
        score -= cost * 3;
        if (score > bestScore) {
          bestScore = score;
          bestVp = vpGain;
          bestCost = cost;
          best = { type: "ATTACK_RESOLVE", playerId: seat, attackerIdx: ai, defenderPlayerId: ep, defenderIdx: di };
        }
      }
    }
  }
  if (!best || bestVp <= 0) return null;
  if (aiMode(state, seat) === "mitigacao") return best;
  if (bestVp >= 2) return best;
  if ((summonCost || 0) + bestCost > (pl.actions ?? 0)) return best;
  return null;
}

/** Hard-block único das 15 premissas (paridade vs-IA). */
export function summonPremiseBlocked(state, seat, card, actionsAfter) {
  if (!card || card.category !== "champion") return false;
  const fc = fieldCount(state, seat);
  const enemyFc = enemyFieldCount(state, seat);
  const aa = actionsAfter ?? 0;
  const oe = card.onEnter;

  if (oe === "tecnicasDeCombate") {
    if (fc <= 0 || enemyFc <= 0 || aa < 1) return true;
    if (!canAllyFollowUpAttackAfterGrant(state, seat, aa, "tecnicas")) return true;
  }
  // (1.51.96 item 11) o GRITO agora tem portão próprio no offline
  // (_grito_worth_it, ai_brain.gd): só vale se algum aliado com a
  // Fúria puder atacar E destruir um adversário depois de pagar o
  // custo — ou, sem adversários, se há aliado para guardar o +1 de
  // Poder como defesa. O portão vive em onEnterUsable/scoreSummonCard
  // (gritoWorthIt); aqui fica só o "sem aliados, sem Grito" da premissa.
  if (oe === "gritoDeGuerra") {
    if (fc <= 0) return true;
  }
  // D-N08 (offline _oe_usable("charme"), ai_brain.gd:384-385): o CHARME
  // só exige adversários — rouba P1 também. O P2+ sai daqui (o pick
  // prefere o mais forte, com fallback para P1).
  if (oe === "prisaoPrismatica" || oe === "incendiar") {
    if (!enemyHasPowerAtLeast(state, seat, 2)) return true;
  }
  // S2-M15: DESAFIANTE / VINGANÇA / LEGADO / INSPIRAR / FÚRIA / LAÇO /
  // INVESTIDA / SOBREPUJAR não são gates no offline — são só bônus de
  // score em _best_summon (ai_brain.gd). Os blocos acima foram removidos.
  // S2-B19 (offline ai_brain.gd:363): o FILHOTE precisa de espaço DEPOIS
  // da invocação — com 5 em campo, o invocador não é invocado. NÃO mudar
  // invokeDragonBlocked (df-rules.js:13): ela vale p/ o humano também.
  // (só invokeDragon existe nos dados — o nome cúbico morreu no C-B13.)
  if (oe === "invokeDragon") {
    if (fc >= MAX_FIELD - 1) return true;
  }
  return false;
}

export function championSummonCost(c) {
  const p = c?.currentPower ?? c?.power ?? 0;
  if (p <= 1) return 1;
  // R-04 parcial (D-N02; motor df-rules.js:39-45; offline cobra o Poder
  // atual): P2 custa 2, P3 custa 3, P4 custa 4 — sem teto.
  return p;
}

/** U-D01/U-D05 (rodada 3, offline ai_brain.gd:322-430 _oe_usable): o
 *  onEnter desta carta TERIA efeito agora? "Inútil" = sem efeito — o
 *  offline põe a carta no trilho inútil (só entra sem mais nada jogável),
 *  não veta. O -9999 fica só para os vetos reais (GATE_8, bolhas/pesadelo
 *  2×, roleta, D-N09). */
function onEnterUsable(state, seat, oe, actionsAfter = 0) {
  if (!oe) return true;
  const fc = fieldCount(state, seat);
  const enemyFc = enemyFieldCount(state, seat);
  const pl = state.players[seat];
  switch (oe) {
    case "assassinar": return foeHasP1NoBarrier(state, seat);
    case "transformarBichinho": return foesExcludingCharmed(state, seat).some((t) =>
      (t.c.currentPower ?? t.c.power ?? 0) >= 2 && !(t.c.barrier || t.c.barrierPermanent));
    case "separar": return hasValidSepararTarget(state, seat);
    case "mordidaVenenosa":
    case "fumacaToxica": return hasUnpoisonedFoe(state, seat);
    case "rajadaCongelante": return enemyFc > 0;
    case "prisaoPrismatica": return hasUnimprisonedFoe(state, seat);
    case "bolaDeFogo": return hasBolaTarget(state, seat);
    case "incendiar": return hasUnburnedNonBarrierFoe(state, seat);
    case "necromancia": return (pl?.discard?.length || 0) > 0;
    case "raioDuplo": return hasBolaTarget(state, seat);
    case "energizar": {
      const maxUlt = getEffectiveMaxUltimateUses(pl, pl?.heroId);
      return (pl?.ultimateUses ?? 0) < maxUlt && !pl?.usedUltimateThisTurn;
    }
    case "invokeDragon": return fc < MAX_FIELD - 1;
    case "fortalecer": return (pl?.field || []).some((c) => c && !(c.podridao || c.name === "APODRECIDA"));
    case "ursificacao": return fc > 0;
    case "devorar": return (pl?.field || []).some((c) => c && !(c.podridao || c.name === "APODRECIDA"));
    // F7-11 D4: o nativo Sem Honra É alvo válido de CORROMPER — o offline
    // só exclui quem já tem o flag `corrupted` (ai_brain.gd: _best_talent
    // e _oe_usable "corromper"); o onDestroy nativo não exclui.
    // (1.51.96 item 13a) e nunca num SILENCIADO.
    case "corromper": return (pl?.field || []).some((c) => c && !(c.corruptedNoHonor || c.corrupted) && !c.silenced);
    case "roubar":
    case "bolhas": return enemyHasHand(state, seat);
    case "pesadelo": return true;
    case "enfraquecer": return (state.players[humanSeat(state, seat)]?.vp ?? 0) > 0;
    case "podridao": return (state.players[humanSeat(state, seat)]?.deck?.length || 0) > 0;
    case "gritoDeGuerra":
      // (1.51.96 item 11) o Grito só vale com um ataque que aproveite
      // a Fúria (ou, sem adversários, com aliado para guardar o +1).
      return gritoWorthIt(state, seat, (pl?.actions ?? 0) - (actionsAfter ?? 0));
    case "guardiao":
      // (1.51.96 item 13a) o Guardião protege OS OUTROS aliados — sem
      // um aliado NÃO silenciado, não faz nada.
      return (pl?.field || []).some((c) => c && !c.silenced);
    case "charme": return enemyFc > 0;
    case "trocaInjusta": return hasFoePower(state, seat, 2);
    case "tecnicasDeCombate": return canAllyFollowUpAttackAfterGrant(state, seat, actionsAfter, "tecnicas");
    case "roletaRussa": return enemyFc > fc;
    case "imitar": return imitarUsable(state, seat, actionsAfter);
    default: return true;
  }
}

/** U-D05 (rodada 3, offline ai_brain.gd _oe_usable("imitar") +
 *  _imitar_would_replay_marked): o IMITAR vale se há um aliado copiável
 *  cujo instant copiado vale — ou um aliado sem instant (copiar a
 *  constante vale). Não vale se o único copiável é um BOLHAS/PESADELO
 *  já usado neste turno (o replay seria no-op — D-N07) nem se o aliado
 *  é Ritual, silenciado ou outro IMITAR. */
function imitarUsable(state, seat, actionsAfter = 0) {
  const allies = state.players[seat]?.field || [];
  const used = state.aiBolhasPesadeloUsed || new Set();
  for (const a of allies) {
    if (!a || a.silenced || a.summonRitual) continue;
    if (a.abilityName === "Ritual" || a.abilityName === "Ritual Superior") continue;
    const oe = a.onEnter;
    if (oe === "imitar") continue;
    if (!oe) return true; // sem instant — copiar a constante vale
    if ((oe === "bolhas" || oe === "pesadelo") && used.has(oe)) continue;
    if (onEnterUsable(state, seat, oe, actionsAfter)) return true;
  }
  return false;
}

// F7-11 D2 — espelho de _imitar_would_replay_marked (ai_brain.gd:303-314):
// há um aliado copiável cujo instant é BOLHAS/PESADELO já usado neste
// turno? (Sem nome, Ritual ou silêncio não é copiável.)
function imitarWouldReplayMarked(state, seat) {
  const allies = state.players[seat]?.field || [];
  const used = state.aiBolhasPesadeloUsed || new Set();
  for (const a of allies) {
    if (!a) continue;
    if (!a.abilityName || a.abilityName === "Ritual" || a.abilityName === "Ritual Superior" || a.silenced) continue;
    const copied = a.onEnter || "";
    if ((copied === "bolhas" || copied === "pesadelo") && used.has(copied)) return true;
  }
  return false;
}

function talentPlayCost(c) {
  return c?.currentPower ?? c?.power ?? 0;
}

function humanSeat(state, seat) {
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p !== seat) return p;
  }
  return (seat + 1) % 2;
}

function vpNeeded(state, seat) {
  const win = state.winPoints ?? state.selectedWinPoints ?? 10;
  const vp = state.players[seat]?.vp ?? 0;
  return Math.max(0, win - vp);
}

function humanNearWin(state, seat) {
  const hs = humanSeat(state, seat);
  return vpNeeded(state, hs) <= 2;
}

function hasCleanKill(state, seat) {
  const pl = state.players[seat];
  if (!pl) return false;
  for (let ai = 0; ai < (pl.field || []).length; ai++) {
    const att = pl.field[ai];
    if (!att || att.tapped || att.frozen) continue;
    for (let ep = 0; ep < (state.playersCount || 2); ep++) {
      if (ep === seat) continue;
      for (let di = 0; di < (state.players[ep]?.field || []).length; di++) {
        const def = state.players[ep].field[di];
        if (!def || def.shielded) continue;
        // D-N11: o empate com Sobrepujar só no atacante é abate limpo
        // (offline _combat_outcome) — o combatOutcome ingênuo tratava
        // como troca mútua e o scoreAttackAction desvalorizava o ataque.
        const o = combatOutcomeOverpower(att, def);
        if (o.killD && !o.killA) return true;
      }
    }
  }
  return false;
}

// D-M15-1 (offline game_state.gd _is_resistente; df-rules.js:76 isResistente):
// o hard-brain é puro (sem import do motor) — predicado local.
function isResistenteServer(f) {
  return !!(f && f.abilityName === "Resistente" && !f.silenced);
}

/** S2-M15 (offline ai_brain.gd:15-16 + _can_summon_and_attack): os 8
 *  campeões de ataque imediato só entram quando a IA pode invocar E
 *  atacar com eles no mesmo turno. */
const GATE_8 = new Set(["GRISELDA", "KUMIKO", "POPPY", "A DUELISTA",
  "GAMER", "ARCADIA", "CAVALEIRO SANGUINÁRIO", "SCARLET"]);
export function gate8CanSummonAndAttack(state, seat, card, actionsAfter) {
  const pw = card.currentPower ?? card.power ?? 0;
  const investida = hasInvestida(card);
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    for (const f of (state.players[p]?.field || [])) {
      if (!f) continue;
      if ((f.currentPower ?? f.power ?? 0) > pw) continue;
      if (f.shielded) continue;
      if (f.charme && f.charmeOriginalOwner === seat) continue;
      if (investida && isResistenteServer(f)) continue;
      const atkCost = investida ? 0 : (isResistenteServer(f) ? 2 : 1);
      if ((actionsAfter ?? 0) >= atkCost) return true;
    }
  }
  return false;
}

/** Score de invocação estilo aiSelectBestSummon (sem peeks de mão humana). */
export function scoreSummonCard(state, seat, card, handIdx, opts = {}) {
  if (!card || card.category !== "champion") return -9999;
  const pl = state.players[seat];
  const fc = fieldCount(state, seat);
  const enemyFc = enemyFieldCount(state, seat);
  const pow = card.currentPower ?? card.power ?? 0;
  const cost = championSummonCost(card);
  const actionsAfter = (pl?.actions ?? 0) - cost;
  // U-D01 (rodada 3): a premissa bloqueada NÃO veta mais — a carta cai no
  // trilho "inútil" (-6 no ramo, como o offline) e só entra sem mais nada
  // jogável. O predicado summonPremiseBlocked continua (exportado e
  // testado pelo check-s2-m15.mjs); só deixa de ser veto de score.
  // 8M (offline _best_summon, ai_brain.gd): base Poder×10 (era Poder×4).
  let score = pow * 10;
  const needTempoKill = hasCleanKill(state, seat);
  // D10 (D-F7-4, decisão dela 17/11 ~10:05, opção (a) REMOVER): os pesos
  // −55 (invocar bloquearia um abate limpo) e −90 (humano perto de vencer)
  // foram removidos — o offline não os tem; a substituta invoca e perde o
  // abate, igual ao offline.
  // S2-M15: GATE_8 — os 8 só entram com ataque no mesmo turno.
  if (GATE_8.has(card.name) && !gate8CanSummonAndAttack(state, seat, card, actionsAfter))
    return -9999;
  const oe = card.onEnter;
  // D-N07 (offline _best_summon + ai_bolhas_pesadelo_used, ai_brain.gd:447-560,
  // 1.51.65 T10): BOLHAS/PESADELO nunca 2× no mesmo turno — nem como
  // último recurso (a 2ª aplicação é idempotente).
  if ((oe === "bolhas" || oe === "pesadelo")
      && (state.aiBolhasPesadeloUsed || new Set()).has(oe)) return -9999;
  // D-N14 (offline _best_summon, ai_brain.gd:447-745): pesos alinhados ao
  // offline, ramo por ramo. "Inútil" sem -6 no offline = sem bônus aqui
  // (a carta continua jogável como corpo); com -6 no offline = -6 aqui.
  if (oe === "invokeDragon") score += fc < MAX_FIELD - 1 ? 7 : -6;
  if (oe === "rapidez") score += 7;
  if (oe === "forja") score += 7;
  if (oe === "fortalecer") {
    const allies = pl.field || [];
    if (allies.some((c) => c && (c.currentPower ?? c.power ?? 0) === 1 && !(c.podridao || c.name === "APODRECIDA"))) score += 14;
    else if (allies.some((c) => c && !(c.podridao || c.name === "APODRECIDA"))) score += 4;
  }
  if (oe === "devorar") {
    const allies = pl.field || [];
    if (allies.some((c) => c && (c.currentPower ?? c.power ?? 0) === 1)) score += 14;
    else if (fc > 0) score += 4;
  }
  if (oe === "ursificacao") {
    const allies = pl.field || [];
    if (allies.some((c) => c && (c.currentPower ?? c.power ?? 0) === 1 && !c.urso_pesado && c.name !== "URSO PESADO")) score += 14;
    else if (fc > 0) score += 4;
  }
  if (oe === "corromper") {
    const allies = pl.field || [];
    // F7-11 D4: ver o `case "corromper"` acima — o nativo Sem Honra conta.
    if (allies.some((c) => c && (c.currentPower ?? c.power ?? 0) === 1 && !(c.corruptedNoHonor || c.corrupted))) score += 14;
    else if (allies.some((c) => c && !(c.corruptedNoHonor || c.corrupted))) score += 4;
  }
  // F7-11 D12: sem bônus de ritual — o offline pontua o ritual como corpo
  // comum (Poder×10 - custo×2); o +23 + Poder×4 fazia a substituta
  // preferir o ritual a um corpo melhor (TIAMAT 59 vs WYVERN 31).
  if (oe === "bolaDeFogo") {
    if (foeHasP1NoBarrier(state, seat)) score += 14;
    else if (hasBolaTarget(state, seat)) score += 8;
    else score -= 6;
  }
  if (oe === "transformarBichinho") {
    score += foesExcludingCharmed(state, seat).some((t) =>
      (t.c.currentPower ?? t.c.power ?? 0) >= 2 && !(t.c.barrier || t.c.barrierPermanent)) ? 8 : -6;
  }
  if (oe === "fumacaToxica") {
    // D-N09: só P1 em campo = pular de vez (nem como último recurso).
    if (onlyP1Targets(state, seat, "fumacaToxica")) return -9999;
    score += hasUnpoisonedFoe(state, seat) ? 8 : -6;
  }
  if (oe === "raioDuplo") score += hasBolaTarget(state, seat) ? 8 : -6;
  if (oe === "auraAntiMagia") score += 4;
  if (oe === "assassinar") {
    // F7-11 D1 (offline _best_summon, ai_brain.gd:550-559): sem P1
    // adversário sem barreira, o assassino é PULADO de vez — nem como
    // último recurso (mesmo padrão do INCENDIAR/mordida, D-N09).
    if (!foeHasP1NoBarrier(state, seat)) return -9999;
    score += 10;
  }
  if (oe === "mordidaVenenosa") {
    // D-N09: só P1 em campo = pular de vez (nem como último recurso).
    if (onlyP1Targets(state, seat, "mordidaVenenosa")) return -9999;
    // (1.51.96 item 8) a MORDIDA também não envenena o que o Gancho
    // roubaria: com o Gancho pronto e sem alvo P3+ limpo, envenenar
    // um P1/P2 é estragar o roubo — a carta é pulada de vez.
    if (hookReady(state, seat) && !foesExcludingCharmed(state, seat).some((t) =>
      (t.c.currentPower ?? t.c.power ?? 0) >= 3 && !t.c.poisoned)) return -9999;
    score += hasUnpoisonedFoe(state, seat) ? 8 : -6;
  }
  if (oe === "rajadaCongelante") {
    // D-N09: idem MORDIDA.
    if (onlyP1Targets(state, seat, "rajadaCongelante")) return -9999;
    score += enemyFc > 0 ? 8 : -6;
  }
  if (oe === "prisaoPrismatica") {
    if (onlyP1Targets(state, seat, "prisaoPrismatica")) return -9999;
    score += hasUnimprisonedFoe(state, seat) ? 8 : -6;
  }
  if (oe === "separar") score += hasValidSepararTarget(state, seat) ? 8 : -6;
  if (oe === "energizar") {
    const maxUlt = getEffectiveMaxUltimateUses(pl, pl.heroId);
    score += ((pl.ultimateUses ?? 0) < maxUlt && !pl.usedUltimateThisTurn) ? 5 : -6;
  }
  if (oe === "enfraquecer") {
    const hs = humanSeat(state, seat);
    score += ((state.players[hs]?.vp ?? 0) > 0) ? 5 : -6;
  }
  if (oe === "podridao") {
    const hs = humanSeat(state, seat);
    score += ((state.players[hs]?.deck?.length ?? 0) > 0) ? 5 : -6;
  }
  // (1.51.96 item 7) CAVALEIRA BRINQUEDO: a Troca Injusta só vale com
  // um campeão adversário de Poder 2 exato — sem ele, a carta é pulada
  // de vez (nem como último recurso, item 9).
  if (oe === "trocaInjusta") {
    if (!hasFoePower(state, seat, 2)) return -9999;
    score += 6;
  }
  if (oe === "pesadelo") score += 5;
  if (oe === "roubar") score += enemyHasHand(state, seat) ? 5 : -6;
  if (oe === "bolhas") score += enemyHasHand(state, seat) ? 5 : -6;
  if (oe === "desacelerar") score += 5;
  if (oe === "incendiar") {
    // D-N10: só P1 válidos (sem barreira) = pular de vez.
    if (onlyP1Targets(state, seat, "incendiar")) return -9999;
    score += hasUnburnedNonBarrierFoe(state, seat) ? 8 : -6;
  }
  if (oe === "charme") {
    // D-N08: +6 com adversários (rouba P1 também), -4 sem.
    score += enemyFc > 0 ? 6 : -4;
  }
  if (oe === "guardiao" && fc > 0) score += 4;
  if (oe === "furia") score += 4;
  // (1.51.96 item 11) o GRITO só vale quando alguém com a Fúria puder
  // atacar e destruir um adversário depois de pagar o custo (ou, sem
  // adversários, com aliado para guardar o +1) — sem isso, a carta é
  // pulada de vez (nem como último recurso, item 9).
  if (oe === "gritoDeGuerra") {
    if (!gritoWorthIt(state, seat, cost)) return -9999;
    score += 4;
  }
  if (oe === "tecnicasDeCombate") score += canAllyFollowUpAttackAfterGrant(state, seat, actionsAfter, "tecnicas") ? 10 : -6;
  if (oe === "defensor") score += 4;
  // U-D05 (rodada 3, offline _oe_usable("imitar") + _imitar_would_replay_marked):
  // +8 com aliado copiável cujo instant vale (ou sem instant — copiar a
  // constante vale); -6 sem aliado copiável ou só replay de BOLHAS/PESADELO
  // já usado no turno.
  // F7-11 D2 (offline _best_summon, ai_brain.gd:561-573): com aliado
  // copiável útil, +8; se o ÚNICO instant copiável é BOLHAS/PESADELO já
  // usado no turno, PULA de vez (o re-disparo aconteceria na tela);
  // sem aliado copiável, -6 (inútil, entra como corpo).
  if (oe === "imitar") {
    if (imitarUsable(state, seat, actionsAfter)) score += 8;
    else if (imitarWouldReplayMarked(state, seat)) return -9999;
    else score -= 6;
  }
  // 8M (offline _best_summon): necromancia +5 SÓ com carta no descarte
  // (era +8 fixo, sem checar). Sem descarte, −6 — o offline a rebaixa a
  // "inútil" (só entra sem mais nada jogável); aqui, sem tier de inútil,
  // a penalidade a desprioriza sem vetar.
  if (oe === "necromancia") score += ((pl.discard?.length || 0) > 0 ? 5 : -6);
  if (oe === "roletaRussa") {
    // JAMAIS: rival sem campeões ou IA com mais/igual campeões que o rival.
    if (enemyFc <= 0 || enemyFc <= fc) return -9999;
    score += 2;
  }
  // 8M (offline _best_summon, ai_brain.gd): constantes valiosas — espelho
  // exato. Os bônus ENORMES que estavam aqui (investida +30, laço +28,
  // desafiante +48, legado/vingança +24, inspirar +22, sobrepujar +28)
  // NÃO existem no offline e afogavam a base — removidos (gap t_948/t_946).
  // Sobrepujar: sem bônus no offline (grep 0 em ai_brain.gd) — removido.
  if (hasLaco(card) || hasInvestida(card) || card.constantEffect === "recompensaDupla") score += 5;
  if (hasDesafiante(card) && fc === 0) score += 6;
  if (hasInspirar(card)) score += 3;
  // muralha: +3 (offline) — campo "muralhaNativa || constantEffect muralha"
  if (card.muralhaNativa || card.constantEffect === "muralha") score += 3;
  // Crescimento +4 / Sem Honra +2 (offline _best_summon, ability_name).
  if (card.abilityName === "Crescimento") score += 4;
  if (card.abilityName === "Sem Honra") score += 2;
  // legado/vingança: sem bônus no offline (só o Poder conta) — nada aqui.
  // D-N14: os bônus de "encher campo" (fc<2 +15, inimigo vazio +18+(6-fc)*3)
  // e o -25 para campeão sem onEnter com fc>=2 NÃO existem no offline —
  // removidos.
  // 8M (offline _best_summon): menos custo×2. Usa o `cost` desta função
  // (championSummonCost local do cérebro) — ver plano sobre a divergência
  // desse custo local com o motor (P2→1 vs P2→2), fora deste escopo.
  score -= cost * 2;
  if (opts.bestHandIdx === handIdx) score += 400;
  if (opts.plainHandIdx === handIdx) score += 200;
  return score;
}

/**
 * Espelha aiShouldAttack do vs-IA: jamais ataca campeão de Poder maior.
 * Sobrepujar no defensor com poder igual também é recusado (manual §17).
 */
// D-M13-1: DfRules.combatOutcome == _combat_outcome offline (Sobrepujar no
// empate). O combatOutcome local do brain é ingênuo (killD: ap >= dp) —
// NÃO usá-lo onde o empate com Sobrepujar importa (pickWinAttack).
function combatOutcomeOverpower(att, def) {
  const ap = att.currentPower ?? att.power ?? 0;
  const dp = def.currentPower ?? def.power ?? 0;
  const oa = isOverpower(att);
  const od = isOverpower(def);
  if (ap > dp) return { killD: true, killA: false, ap, dp };
  if (ap < dp) return { killD: false, killA: true, ap, dp };
  if (oa && !od) return { killD: true, killA: false, ap, dp, over: true };
  if (!oa && od) return { killD: false, killA: true, ap, dp, over: true };
  if (oa && od) return { killD: false, killA: false, ap, dp };
  return { killD: true, killA: true, ap, dp };
}

// S2-M13 (offline _no_vp, ai_brain.gd:1095): corrompido não dá PV mesmo
// silenciado; silenciado desativa o Sem Honra nativo/copiado.
function noVpOnDestroy(c) {
  if (!c) return false;
  if (c.corruptedNoHonor || c.corrupted) return true;
  if (c.silenced) return false;
  return c.onDestroy === "noHonor" || c.abilityName === "Sem Honra";
}

/** S2-M13 (offline _win_attack, ai_brain.gd:963): ataque que vence AGORA.
 *  Retorna ATTACK_RESOLVE ou null. Prefere abate limpo; mútuo só fallback.
 *  Usa combatOutcomeOverpower (Sobrepujar no empate, como o offline). */
export function pickWinAttack(state, seat) {
  const pl = state.players[seat];
  const win = state.winPoints ?? state.selectedWinPoints ?? 10;
  const statused = state.aiStatusedUids || new Set();
  let mutual = null;
  for (let ai = 0; ai < (pl.field || []).length; ai++) {
    const att = pl.field[ai];
    if (!att || att.tapped || att.frozen) continue;
    for (let ep = 0; ep < (state.playersCount || 2); ep++) {
      if (ep === seat) continue;
      for (let di = 0; di < (state.players[ep]?.field || []).length; di++) {
        const def = state.players[ep].field[di];
        if (!def || def.shielded) continue;
        if (statused.has(def.uid)) continue; // S2-M13: nunca no statusado
        if (!shouldAttack(att, def)) continue;
        const { killD, killA } = combatOutcomeOverpower(att, def);
        if (!killD) continue;
        const vpGain = noVpOnDestroy(def) ? 0
          : ((att.constantEffect === "recompensaDupla" && !att.silenced) ? 2 : 1);
        if ((pl.vp ?? 0) + vpGain < win) continue;
        const atk = { type: "ATTACK_RESOLVE", playerId: seat,
          attackerIdx: ai, defenderPlayerId: ep, defenderIdx: di };
        if (!killA) return atk;
        if (!mutual) mutual = atk;
      }
    }
  }
  return mutual;
}

export function shouldAttack(attacker, defender) {
  if (!attacker || !defender) return false;
  if (defender.shielded) return false;
  if (attacker.tapped || attacker.frozen) return false;
  const aPow = attacker.currentPower ?? attacker.power ?? 0;
  const dPow = defender.currentPower ?? defender.power ?? 0;
  const overA = isOverpower(attacker);
  const overD = isOverpower(defender);
  if (aPow < dPow) return false;
  // U-D02 (rodada 3, offline _best_attack): o empate Sobrepujar×Sobrepujar
  // é um ataque válido (nem morre ninguém, score 5) — o offline ataca.
  if (aPow === dPow && overA && overD) return true;
  if (overD && aPow <= dPow) return false;
  if (aPow > dPow) return true;
  if (aPow === dPow && overA && !overD) return true;
  if (aPow === dPow && !overA && !overD) return true;
  return false;
}

/** U-D04 (rodada 3): custo do ataque espelhando o motor getAttackActionCost
 *  (df-rules.js:1156) — urso→2, prisão→2, freeAttack→0, Resistente→2,
 *  Pesado→2, senão 1. O cérebro é puro (sem import do motor). */
function attackActionCost(att, def) {
  if (att && (att.urso_pesado || att.name === "URSO PESADO")) return 2;
  if (att && att.prisaoPrismatica) return 2;
  if (att && att.freeAttack && !(att.abilityName === "Pesado Demais" && !att.silenced) && !att.prisaoPrismatica) return 0;
  let cost = 1;
  if (def && def.abilityName === "Resistente" && !def.silenced) cost = 2;
  if (att && att.abilityName === "Pesado Demais" && !att.silenced) cost = Math.max(cost, 2);
  return cost;
}

export function scoreAttackAction(state, seat, action) {
  const pl = state.players[seat];
  const att = pl?.field?.[action.attackerIdx];
  const def = state.players[action.defenderPlayerId]?.field?.[action.defenderIdx];
  if (!att || !def || def.shielded) return -9999;
  if (att.tapped || att.frozen) return -9999;
  if (!shouldAttack(att, def)) return -9999;
  // D-N11: ver hasCleanKill — o empate com Sobrepujar é abate limpo.
  const { killD, killA, ap, dp } = combatOutcomeOverpower(att, def);
  // S2-M13 (offline _best_attack): não DESTRUIR no mesmo turno o campeão
  // que a IA statusou (o status seria desperdiçado). Atacar sem destruir
  // continua valendo — por isso o veto é só no ramo killD.
  if (killD && (state.aiStatusedUids || new Set()).has(def.uid)) return -9999;
  // U-D04 (rodada 3, offline _best_attack ai_brain.gd:1017-1090, fórmula
  // exata — sem o +700, sem o ×1,08 e sem os bônus +45/+80/+25, que
  // invertiam o ranking: matar P1 valia menos que matar P2, e a mútua
  // P3xP3 valia mais que a P1xP1).
  const vpGain = killD && !noVpOnDestroy(def)
    ? ((att.constantEffect === "recompensaDupla" && !att.silenced) ? 2 : 1)
    : 0;
  let score;
  if (killD && !killA) {
    score = 100 + vpGain * 10 + dp * 2;
  } else if (killD && killA) {
    // S2-A08 (offline _best_attack): em CAMPO a troca mútua é pulada,
    // EXCETO P1xP1; em MITIGAÇÃO limpar o campo vale +30.
    const mode = aiMode(state, seat);
    if (mode === "campo" && !(ap === 1 && dp === 1)) return -9999;
    score = 40 + vpGain * 10 + (dp - ap) * 2;
    if (mode === "mitigacao") score += 30;
  } else if (killA) {
    score = -50;
  } else {
    // Empate (Sobrepujar×Sobrepujar): nem morre ninguém.
    score = 5;
  }
  if (ap === 1) score += 15;
  if (dp === 1 && killD) score += 15;
  score -= attackActionCost(att, def) * 3;
  return score;
}

export function scoreDrawAction(state, seat) {
  const pl = state.players[seat];
  if (!pl) return -9999;
  const deckLeft = pl.deckCount != null ? pl.deckCount : (pl.deck?.length ?? 0);
  if (deckLeft <= 0 || (pl.hand?.length || 0) >= MAX_HAND) return -9999;
  // D-N21 (offline next_action passo 4, ai_brain.gd:49-152): só compra se
  // não há carta barata jogável na mão ou a mão tem ≤ 2 cartas — senão,
  // joga a carta barata em vez de comprar.
  const hand = pl.hand || [];
  const actions = pl.actions ?? 0;
  const fc = fieldCount(state, seat);
  let hasCheap = false;
  for (const c of hand) {
    if (!c || c.podridao || c.name === "APODRECIDA") continue;
    const cost = c.category === "talent" ? talentPlayCost(c) : championSummonCost(c);
    if (cost <= actions && (c.category === "talent" || fc < MAX_FIELD)) { hasCheap = true; break; }
  }
  if (hasCheap && hand.length > 2) return -9999;
  // F7-11 D9: sem os vetos -100 (abate limpo travado) e -80 (humano perto
  // de vencer) — o offline compra no passo 4 (o passo de ataque já passou);
  // os vetos faziam a substituta passar o turno com a mão vazia.
  if (enemyFieldCount(state, seat) > 0 && fieldCount(state, seat) > 0) {
    return g("drawPenalty", -5) + 8;
  }
  if (fieldCount(state, seat) >= MAX_FIELD) return 14;
  return 10;
}

export function scoreLegalAction(state, seat, action, meta = {}) {
  if (!action?.type || action.type === "END_TURN") return -9999;
  if (action.type === "SUMMON") {
    const card = state.players[seat]?.hand?.[action.handIdx];
    return scoreSummonCard(state, seat, card, action.handIdx, meta);
  }
  if (action.type === "ATTACK_RESOLVE") return scoreAttackAction(state, seat, action);
  if (action.type === "DRAW_CARD") return scoreDrawAction(state, seat);
  if (action.type === "TALENT_START") return scoreTalentStart(state, seat, action);
  if (action.type === "ULTIMATE_PLAY") return 30;
  return 1;
}

function scoreTalentStart(state, seat, action) {
  const card = state.players[seat]?.hand?.[action.handIdx];
  if (!card || card.category !== "talent") return -9999;
  const cost = talentPlayCost(card);
  if ((state.players[seat]?.actions ?? 0) < cost) return -9999;
  const te = card.talentEffect;
  const pl = state.players[seat];
  const fc = fieldCount(state, seat);
  // D-N13 (offline _best_talent, ai_brain.gd:805-961): os gates de talento
  // do offline — sem eles, a IA jogava talentos sem efeito (e, antes do
  // fix D-N01, travava a partida). `foes` exclui o próprio enfeitiçado.
  const foes = foesExcludingCharmed(state, seat);
  const enemyFc = foes.length;
  const enemyHand = (state.players[humanSeat(state, seat)]?.hand?.length ?? 0);
  const mark = state.aiBolhasPesadeloUsed || new Set();
  const actionsAfter = (pl?.actions ?? 0) - cost;
  if (te === "aceleracao") {
    // U-B09 (rodada 5): o offline joga com 3 ações (play=true) e o resolve
    // soma +1 SEM teto (game_state.gd:4862); o motor também não tem teto.
    return 40;
  }
  if (te === "chuvaDeCometas") return enemyFc > fc ? 8 : -9999;
  if (te === "barreira") return (fc > 0 && enemyFc > 0) ? 35 : -9999;
  // D-N07: BOLHAS talento exige mão adversária E a marca livre.
  if (te === "bolhasTalento") return (enemyHand > 0 && !mark.has("bolhas")) ? 8 : -9999;
  if (te === "doppelganger") {
    const hasP2 = (pl.field || []).some((c) => c && (c.currentPower ?? c.power ?? 0) === 2);
    return (fc > 0 && fc < MAX_FIELD && hasP2) ? 34 : -9999;
  }
  if (te === "investidaTalento") {
    // (1.51.96 item 14) o talento INVESTIDA é PERMANENTE — sem
    // adversários vale com aliado livre P2+; com adversários, só
    // quando o ataque livre DESTRÓI alguém. Nunca em P1, nunca num
    // SILENCIADO (item 13a: não recebe status).
    return investidaTalentWorthIt(state, seat) ? 8 : -9999;
  }
  if (te === "corromperTalento") {
    // U-B10 (rodada 5): o offline só exclui quem já tem o flag `corrupted`
    // ("corromper nunca 2x") — aliado nativo Sem Honra (onDestroy noHonor)
    // é jogado e o efeito é desperdiçado, igual ao offline.
    // (1.51.96 item 13a) e nunca num SILENCIADO.
    const ok = (pl.field || []).some((c) => c && !c.corrupted && !c.silenced);
    return ok ? 8 : -9999;
  }
  if (te === "ressuscitarTalento") {
    // U-B05 (rodada 5): o offline só escolhe com P2 no descarte E espaço
    // no campo (ai_brain.gd:901-902). Sem o gate, a IA jogava, a recusa
    // NO_P2_DISCARD avançava a fase e ela perdia os outros talentos.
    const hasP2 = (pl.discard || []).some((c) => c
      && c.category === "champion" && (c.power ?? 0) === 2);
    return (hasP2 && fc < MAX_FIELD) ? 8 : -9999;
  }
  if (te === "tornadoDeFogo") {
    // U-B08 (rodada 5): o offline exige adversário sem Barreira E Poder
    // diferente de 1 E sem queimadura (ai_brain.gd:845-847).
    const ok = foes.some((t) => !(t.c.barrier || t.c.barrierPermanent)
      && (t.c.currentPower ?? t.c.power ?? 0) !== 1
      && !(t.c.burning || (t.c.burningTurns ?? 0) > 0));
    return ok ? 8 : -9999;
  }
  if (te === "tecnicasDeCombateTalento") {
    return canAllyFollowUpAttackAfterGrant(state, seat, actionsAfter, "tecnicas") ? 8 : -9999;
  }
  if (te === "gritoDeGuerraTalento") {
    // (1.51.96 item 11) o Grito só vale se algum aliado com a Fúria
    // puder atacar e destruir um adversário depois de pagar o custo —
    // sem ataque que aproveite o efeito, a carta é guardada. Sem
    // adversários, o +1 de Poder ainda vale.
    return gritoWorthIt(state, seat, cost) ? 8 : -9999;
  }
  if (te === "explosao") {
    const ok = foes.some((t) => (t.c.currentPower ?? t.c.power ?? 0) !== 1
      && !(t.c.barrier || t.c.barrierPermanent));
    return ok ? 48 : -9999;
  }
  if (te === "zeroAbsoluto") {
    const ok = foes.some((t) => t.c.frozen || (t.c.currentPower ?? t.c.power ?? 0) >= 2);
    return ok ? 42 : -9999;
  }
  if (te === "medoTalento") {
    const ok = foes.some((t) => (t.c.currentPower ?? t.c.power ?? 0) === 2);
    return ok ? 38 : -9999;
  }
  if (te === "trocaDeLugar") {
    const hasP1 = (pl.field || []).some((c) => c && (c.currentPower ?? c.power ?? 0) === 1);
    const hasP2 = foes.some((t) => (t.c.currentPower ?? t.c.power ?? 0) === 2);
    return (hasP1 && hasP2) ? 8 : -9999;
  }
  if (te === "podridaoTalento") {
    const hs = humanSeat(state, seat);
    return ((state.players[hs]?.deck?.length ?? 0) > 0) ? 8 : -9999;
  }
  if (te === "enfraquecerTalento") {
    const hs = humanSeat(state, seat);
    return ((state.players[hs]?.vp ?? 0) > 0) ? 8 : -9999;
  }
  if (te === "invocarDragaoTalento") return fc < MAX_FIELD ? 8 : -9999;
  if (te === "bolaDeFogoTalento") {
    const ok = foes.some((t) => !(t.c.barrier || t.c.barrierPermanent));
    return ok ? 45 : -9999;
  }
  if (te === "baforadaVenenosa") {
    // (1.51.96 item 8) com o Gancho pronto, a Baforada só vale num alvo
    // que o Gancho NÃO pode roubar (P3+): envenenar um P1/P2 é estragar
    // o roubo — roubar o campeão vale mais que envenená-lo.
    if (hookReady(state, seat)) {
      const ok = foes.some((t) => (t.c.currentPower ?? t.c.power ?? 0) >= 3 && !t.c.poisoned);
      return ok ? 36 : -9999;
    }
    const ok = foes.some((t) => (t.c.currentPower ?? t.c.power ?? 0) !== 1 && !t.c.poisoned);
    return ok ? 36 : -9999;
  }
  if (te === "missemagicos") return enemyFc > 0 ? 44 : -9999;
  if (te === "fortalecerTalento") {
    const ok = (pl.field || []).some((c) => c && !(c.podridao || c.name === "APODRECIDA"));
    return ok ? 32 : -9999;
  }
  return 8;
}

/**
 * Escolhe melhor ação entre legais com floor (estilo vs-IA: 5 → 0).
 * Nunca END_TURN se houver ação com score >= 0.
 */
export function pickBestHardAction(state, seat, legal, opts = {}) {
  const minScore = opts.minScore != null ? opts.minScore : 0;
  if (!Array.isArray(legal) || !legal.length) {
    return { type: "END_TURN", playerId: seat, _score: -9999 };
  }
  // Metas para boost de "melhor summon".
  // U-D01 (rodada 3, offline _best_summon ai_brain.gd:447-560): dois
  // trilhos — o ÚTIL vence sempre; o INÚTIL (onEnter sem efeito) só entra
  // sem mais nada jogável. Antes, o maior score ganhava e a inútil
  // (ex.: LICH 10) vencia a útil (ex.: COME PEDRA 8).
  let bestSummonIdx = null;
  let bestSummonScore = -Infinity;
  let bestUselessIdx = null;
  let bestUselessScore = -Infinity;
  for (const a of legal) {
    if (a?.type !== "SUMMON") continue;
    const card = state.players[seat]?.hand?.[a.handIdx];
    const s = scoreSummonCard(state, seat, card, a.handIdx, {});
    if (s <= -9999) continue;
    const actionsAfter = (state.players[seat]?.actions ?? 0) - championSummonCost(card);
    // (1.51.96 item 9) REGRA GERAL: um campeão de habilidade INSTANTÂNEA
    // cuja pré-condição falha NÃO é invocado — nem como último recurso
    // (o corpo não compensa a habilidade perdida). O GRITO tem portão
    // próprio no score e fica fora daqui.
    const oe = card?.onEnter;
    if (oe && oe !== "gritoDeGuerra" && !onEnterUsable(state, seat, oe, actionsAfter)) continue;
    const useless = !onEnterUsable(state, seat, card?.onEnter, actionsAfter);
    if (!useless && s > bestSummonScore) {
      bestSummonScore = s;
      bestSummonIdx = a.handIdx;
    }
    if (useless && s > bestUselessScore) {
      bestUselessScore = s;
      bestUselessIdx = a.handIdx;
    }
  }
  if (bestSummonIdx == null) {
    bestSummonIdx = bestUselessIdx;
    bestSummonScore = bestUselessScore;
  }
  // Plain: o melhor summon pelo score REAL, no trilho (útil primeiro).
  // O Poder×3−custo escolhia o maior corpo e ignorava o score — o
  // offline invoca o melhor disponível pelo score, não o maior corpo.
  // O plain nunca supera o melhor (raw <= bestSummonScore): o boost +200
  // não pode furar o +400 do trilho útil. E nunca força um -9999.
  let plainIdx = null;
  let plainScore = -Infinity;
  let plainUselessIdx = null;
  let plainUselessScore = -Infinity;
  for (const a of legal) {
    if (a?.type !== "SUMMON") continue;
    const card = state.players[seat]?.hand?.[a.handIdx];
    const s = scoreSummonCard(state, seat, card, a.handIdx, {});
    if (s <= -9999 || s > bestSummonScore) continue;
    // (1.51.96 item 9) o fallback plain também não força uma instantânea
    // sem pré-condição (ver o trilho acima): sem ela, a IA guarda a carta.
    const actionsAfterPlain = (state.players[seat]?.actions ?? 0) - championSummonCost(card);
    const oePlain = card?.onEnter;
    if (oePlain && oePlain !== "gritoDeGuerra" && !onEnterUsable(state, seat, oePlain, actionsAfterPlain)) continue;
    // Plain: sem onEnter que exige inimigo, ou qualquer quando board vazio.
    const needsEnemy = card && [
      "bolaDeFogo", "assassinar", "fumacaToxica", "raioDuplo", "mordidaVenenosa",
      "incendiar", "pesadelo", "roubar", "desacelerar", "corromper",
    ].includes(card.onEnter);
    // S2-M15: o fallback plain NÃO pode furar o GATE_8 (os 8 só entram com
    // ataque no mesmo turno) — sem isto, o campo vazio forçava a GRISELDA
    // mesmo sem alvo atacável.
    const gate8Blocked = card && GATE_8.has(card.name)
      && !gate8CanSummonAndAttack(state, seat, card, actionsAfterPlain);
    if ((!needsEnemy || enemyFieldCount(state, seat) > 0) && !gate8Blocked) {
      const useless = !onEnterUsable(state, seat, card?.onEnter, actionsAfterPlain);
      if (!useless && s > plainScore) {
        plainScore = s;
        plainIdx = a.handIdx;
      }
      if (useless && s > plainUselessScore) {
        plainUselessScore = s;
        plainUselessIdx = a.handIdx;
      }
    }
  }
  if (plainIdx == null) {
    plainIdx = plainUselessIdx;
    plainScore = plainUselessScore;
  }
  const meta = { bestHandIdx: bestSummonIdx, plainHandIdx: plainIdx };

  let best = null;
  let bestScore = -Infinity;
  for (const a of legal) {
    if (!a?.type || a.type === "END_TURN") continue;
    // (1.51.96 item 9) o laço principal re-pontua cada ação — o veto da
    // instantânea sem pré-condição vale aqui também, senão o score bruto
    // (sem o boost do trilho útil) ainda escolheria a carta sozinha.
    if (a.type === "SUMMON") {
      const cardMain = state.players[seat]?.hand?.[a.handIdx];
      const oeMain = cardMain?.onEnter;
      const aaMain = (state.players[seat]?.actions ?? 0) - championSummonCost(cardMain);
      if (oeMain && oeMain !== "gritoDeGuerra" && !onEnterUsable(state, seat, oeMain, aaMain)) continue;
    }
    const s = scoreLegalAction(state, seat, a, meta);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }

  if (best && bestScore >= minScore) {
    return { ...best, playerId: seat, _score: bestScore };
  }
  // Fallback anti-pass: qualquer ação não-negativa.
  if (best && bestScore >= 0) {
    return { ...best, playerId: seat, _score: bestScore };
  }
  // Campo vazio: força o melhor summon "plain" (paridade vs-IA), não qualquer carta.
  if (plainIdx != null && fieldCount(state, seat) === 0) {
    return { type: "SUMMON", playerId: seat, handIdx: plainIdx, _score: plainScore };
  }
  // Sem forçar jogadas ruins (score << 0) — vs-IA também passa nesses casos.
  const end = legal.find((a) => a?.type === "END_TURN");
  return end
    ? { ...end, playerId: seat, _score: -9999 }
    : { type: "END_TURN", playerId: seat, _score: -9999 };
}

/** S2-M13 passo 2 (offline ai_brain.gd: next_action): a ordem das fases
 *  separa as categorias — invocar, depois talento, depois Ultimate, depois
 *  atacar, depois comprar. Os wrappers delegam ao pickBestHardAction com a
 *  lista filtrada (mesmo floor, mesmo fallback plain, sem mudar os scores). */
export function pickBestSummon(state, seat, legal, opts = {}) {
  return pickBestHardAction(state, seat, (legal || []).filter((a) => a?.type === "SUMMON"), opts);
}
export function pickBestAttack(state, seat, legal, opts = {}) {
  return pickBestHardAction(state, seat, (legal || []).filter((a) => a?.type === "ATTACK_RESOLVE"), opts);
}
export function pickDraw(state, seat, legal) {
  return pickBestHardAction(state, seat, (legal || []).filter((a) => a?.type === "DRAW_CARD"), { minScore: 0 });
}

/** Heurística de alvo on-enter (estilo aiPickOnEnterResolution, sem peeks). */
export function pickOnEnterResolution(state, seat, ability, casterIdx, fieldIdx) {
  const gatherEnemy = (pred) => {
    const out = [];
    for (let p = 0; p < (state.playersCount || 2); p++) {
      if (p === casterIdx) continue;
      (state.players[p]?.field || []).forEach((c, i) => {
        // D-N04: o próprio enfeitiçado nunca é alvo (o motor recusa) —
        // vale para TODOS os pools de inimigo (bola, rajada, mordida,
        // separar, troca injusta, charme, prisão...).
        if (!c || (c.charme && c.charmeOriginalOwner === casterIdx)) return;
        if (!pred || pred(c, p, i)) out.push({ p, i, c });
      });
    }
    return out;
  };
  const gatherAlly = (pred) => {
    const out = [];
    (state.players[casterIdx]?.field || []).forEach((c, i) => {
      if (i === fieldIdx) return;
      if (c && (!pred || pred(c, casterIdx, i))) out.push({ p: casterIdx, i, c });
    });
    return out;
  };

  if (ability === "pesadelo" || ability === "roubar" || ability === "desacelerar") {
    const hs = humanSeat(state, seat);
    return { targetPlayerIdx: hs, targetIdx: hs };
  }
  if (ability === "trocaInjusta") {
    const pool = gatherEnemy((c) => Number(c.currentPower ?? c.power) === 2);
    if (!pool.length) return {};
    // D-N20 (offline auto_pick_uid): o pool já vem em ordem de campo —
    // empate P2 pega o 1º (determinístico, sem Math.random).
    const pick = pool[0];
    return { targetP: pick.p, targetI: pick.i, enemyP: pick.p, enemyI: pick.i };
  }
  if (ability === "charme") {
    // D-N08 (offline _oe_usable("charme")): basta haver adversários —
    // rouba P1 também; o mais forte primeiro, com fallback para P1.
    let pool = gatherEnemy(() => true);
    if (!pool.length) return null;
    pool.sort((a, b) => (b.c.currentPower ?? 0) - (a.c.currentPower ?? 0));
    return { targetP: pool[0].p, targetI: pool[0].i };
  }
  if (ability === "prisaoPrismatica") {
    let pool = gatherEnemy((c) => c && !c.prisaoPrismatica
      && (c.currentPower ?? c.power ?? 0) >= 2);
    if (!pool.length) return null;
    pool.sort((a, b) => (b.c.currentPower ?? 0) - (a.c.currentPower ?? 0));
    return { targetP: pool[0].p, targetI: pool[0].i };
  }
  if (ability === "separar") {
    const maxF = 6;
    let pool = gatherEnemy((c) => c && (c.currentPower ?? c.power) === 2);
    pool = pool.filter((t) => (state.players[t.p]?.field?.length ?? 0) < maxF);
    // D-N05 (offline _pode_separar): sem INSPIRAR, sem MURALHA, sem FÚRIA
    // — o motor recusa, e o sort antigo PREFERIA o inválido (INSPIRAR é
    // constantEffect). O válido mais forte primeiro (empate P2 → 1º).
    pool = pool.filter((t) => !t.c.inspiracao && !t.c.wallBuff && (t.c.furyStacks ?? 0) <= 0);
    if (!pool.length) return null;
    pool.sort((a, b) => (b.c.currentPower ?? 0) - (a.c.currentPower ?? 0));
    return { targetP: pool[0].p, targetI: pool[0].i };
  }
  if (ability === "corromper") {
    // F7-11 D4: o nativo Sem Honra É alvo válido de CORROMPER (o offline
    // só exclui quem já tem o flag `corrupted`).
    // (1.51.96 item 13a) e nunca num SILENCIADO.
    const allies = gatherAlly((c) => c && !c.corruptedNoHonor && !c.silenced
      && (c.currentPower ?? c.power ?? 0) === 1);
    if (!allies.length) return null;
    return { targetP: allies[0].p, targetI: allies[0].i };
  }
  if (ability === "bolaDeFogo") {
    // D-N03 (offline auto_pick_uid, game_state.gd:2200-2205): a BOLA mira
    // o mais FRACO com Poder ≥1, nunca apodrecida, nunca Barreira (o motor
    // recusa — o pick explícito sobrescrevia o fallback correto).
    let pool = gatherEnemy((c) => !c.shielded && !(c.barrier || c.barrierPermanent)
      && !(c.podridao || c.name === "APODRECIDA")
      && (c.currentPower ?? c.power ?? 0) >= 1);
    if (!pool.length) return null;
    pool.sort((a, b) => (a.c.currentPower ?? 0) - (b.c.currentPower ?? 0));
    return { targetP: pool[0].p, targetI: pool[0].i };
  }
  if (ability === "assassinar" || ability === "incendiar"
      || ability === "mordidaVenenosa"
      || ability === "rajadaCongelante" || ability === "transformarBichinho") {
    // Proteção bloqueia ataques; Assassinar/Transformar ignoram Proteção
    // (Transformar: só Barreira; Assassinar: destruição, não ataque).
    let pool = (ability === "transformarBichinho" || ability === "assassinar")
      ? gatherEnemy(() => true)
      : gatherEnemy((c) => !c.shielded);
    if (ability === "assassinar") {
      // C-M10: a IA nunca mira P1 com Barreira (o resolve rejeitaria).
      pool = pool.filter((t) => (t.c.currentPower ?? t.c.power ?? 0) === 1 && !t.c.barrier && !t.c.barrierPermanent);
    }
    if (ability === "mordidaVenenosa") {
      // D-N04: a MORDIDA nunca mira Barreira (o motor recusa).
      pool = pool.filter((t) => !t.c.poisoned && (t.c.currentPower ?? t.c.power ?? 0) > 1
        && !t.c.barrier && !t.c.barrierPermanent);
    }
    if (ability === "incendiar") {
      pool = pool.filter((t) => !(t.c.barrier || t.c.barrierPermanent)
        && (t.c.currentPower ?? t.c.power ?? 0) >= 2);
      // D-N10 (offline _status_target_ok): prefere alvo sem queimadura.
      const clean = pool.filter((t) => !t.c.burning);
      if (clean.length) pool = clean;
    }
    if (ability === "rajadaCongelante") {
      // D-N04: a RAJADA nunca mira Barreira; prefere alvo sem
      // congelamento (offline _status_target_ok — mirar um já-congelado
      // é abate, então o fallback usa o pool inteiro).
      pool = pool.filter((t) => !t.c.barrier && !t.c.barrierPermanent);
      const clean = pool.filter((t) => !t.c.frozen);
      if (clean.length) pool = clean;
    }
    if (ability === "transformarBichinho") {
      pool = pool.filter((t) => (t.c.currentPower ?? t.c.power ?? 0) >= 2 && !t.c.barrier);
    }
    if (!pool.length) return null;
    pool.sort((a, b) => (b.c.currentPower ?? 0) - (a.c.currentPower ?? 0));
    return { targetP: pool[0].p, targetI: pool[0].i };
  }
  if (ability === "fortalecer" || ability === "devorar" || ability === "ursificacao"
      || ability === "imitar") {
    let allies = gatherAlly(() => true);
    // S2-M14: FORTALECER nunca mira apodrecida; URSIFICAÇÃO nunca mira urso
    // (o motor recusa — a ação seria desperdiçada).
    if (ability === "fortalecer") allies = allies.filter((t) => !(t.c.podridao || t.c.name === "APODRECIDA"));
    if (ability === "ursificacao") allies = allies.filter((t) => t.c.name !== "URSO PESADO" && !t.c.urso_pesado);
    // R-08 (offline auto_pick_uid, game_state.gd:2178): DEVORAR nunca
    // mira a APODRECIDA (Poder 0) — o motor recusa (INVALID_TARGET,
    // df-rules.js:685-688) e a resolução do on-enter é desperdiçada.
    if (ability === "devorar") allies = allies.filter((t) => !(t.c.podridao || t.c.name === "APODRECIDA"));
    if (!allies.length) return null;
    if (ability === "devorar") {
      allies.sort((a, b) => (a.c.currentPower ?? 0) - (b.c.currentPower ?? 0));
    } else if (ability === "fortalecer") {
      // R-07 (offline auto_pick_uid, game_state.gd:2155-2157; 1.51.55
      // item 3): FORTALECER mira o aliado mais FRACO, não o mais forte.
      allies.sort((a, b) => (a.c.currentPower ?? 0) - (b.c.currentPower ?? 0));
    } else {
      // R-07: URSIFICAÇÃO também mira o mais FRACO (offline, idem);
      // IMITAR mantém o mais forte (não é alvo de buff).
      if (ability === "ursificacao")
        allies.sort((a, b) => (a.c.currentPower ?? 0) - (b.c.currentPower ?? 0));
      else
        allies.sort((a, b) => (b.c.currentPower ?? 0) - (a.c.currentPower ?? 0));
    }
    return { targetP: allies[0].p, targetI: allies[0].i };
  }
  return {};
}

/**
 * Lista talentos jogáveis como TALENT_START (+ target embutido quando possível).
 */
export function listTalentPlays(state, seat) {
  const pl = state.players[seat];
  if (!pl?.hand?.length) return [];
  // U-D03 (rodada 3, offline _best_talent): com o campo cheio (6) o
  // offline segura o talento — a 7ª carta do campo só pode ser talento
  // ou reação JOGADA PELO HUMANO; a IA não a joga com o campo cheio.
  if (fieldCount(state, seat) >= MAX_FIELD) return [];
  const plays = [];
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (!c || c.category !== "talent") continue;
    // Reativas não se jogam no próprio turno.
    if (c.talentEffect === "bloquearAtaque" || c.talentEffect === "protecaoDivina"
        || c.talentEffect === "cancelarUltimate"
        || c.talentEffect === "exaustao"
        || c.talentEffect === "contramagica") continue;
    const cost = talentPlayCost(c);
    if ((pl.actions ?? 0) < cost) continue;
    const score = scoreTalentStart(state, seat, { type: "TALENT_START", handIdx: i });
    if (score < 0) continue;
    const play = {
      type: "TALENT_START",
      playerId: seat,
      handIdx: i,
      card: { name: c.name, talentEffect: c.talentEffect, category: "talent" },
      _score: score,
      _talentEffect: c.talentEffect,
    };
    // Anexa alvo sugerido para o follow-up (D-N01: TODOS os talentos com
    // mira precisam de _target — sem ele o follow-up nunca era construído
    // e o talento travava a partida; os AUTO resolvem sem alvo).
    const te = c.talentEffect;
    const foes = [];
    for (let p = 0; p < (state.playersCount || 2); p++) {
      if (p === seat) continue;
      (state.players[p]?.field || []).forEach((ch, fi) => {
        if (!ch || ch.shielded) return;
        // D-N04: o próprio enfeitiçado nunca é alvo.
        if (ch.charme && ch.charmeOriginalOwner === seat) return;
        foes.push({ p, i: fi, ch, pw: ch.currentPower ?? ch.power ?? 0 });
      });
    }
    const noBarrier = (t) => !(t.ch.barrier || t.ch.barrierPermanent);
    if (te === "bolaDeFogoTalento") {
      // D-N03: a BOLA (talento) mira o mais FRACO ≥1, sem Barreira.
      const pool = foes.filter((t) => t.pw >= 1 && noBarrier(t)
        && !(t.ch.podridao || t.ch.name === "APODRECIDA"));
      if (!pool.length) continue;
      pool.sort((a, b) => a.pw - b.pw);
      play._target = { targetP: pool[0].p, targetI: pool[0].i };
    }
    if (te === "explosao") {
      const pool = foes.filter((t) => t.pw >= 2 && noBarrier(t));
      if (!pool.length) continue;
      pool.sort((a, b) => b.pw - a.pw);
      play._target = { targetP: pool[0].p, targetI: pool[0].i };
    }
    if (te === "zeroAbsoluto") {
      if (!foes.length) continue;
      foes.sort((a, b) => b.pw - a.pw);
      play._target = { targetP: foes[0].p, targetI: foes[0].i };
    }
    if (te === "medoTalento") {
      // D-N13: AMEDRONTAR só vale em P2 exato (nunca P1).
      const pool = foes.filter((t) => t.pw === 2);
      if (!pool.length) continue;
      play._target = { targetP: pool[0].p, targetI: pool[0].i };
    }
    if (te === "baforadaVenenosa") {
      // (1.51.96 item 8) com o Gancho pronto, só mira o que o Gancho
      // NÃO pode roubar (P3+): o alvo da Baforada nunca é um P1/P2
      // que o roubo levaria limpo.
      const pool = hookReady(state, seat)
        ? foes.filter((t) => t.pw >= 3 && !t.ch.poisoned)
        : foes.filter((t) => t.pw > 1 && !t.ch.poisoned);
      if (!pool.length) continue;
      pool.sort((a, b) => b.pw - a.pw);
      play._target = { targetP: pool[0].p, targetI: pool[0].i };
    }
    if (te === "transformarBichinhoTalento") {
      const pool = foes.filter((t) => t.pw >= 2 && noBarrier(t));
      if (!pool.length) continue;
      pool.sort((a, b) => b.pw - a.pw);
      play._target = { targetP: pool[0].p, targetI: pool[0].i };
    }
    if (te === "prisaoPrismaticaTalento") {
      const pool = foes.filter((t) => t.pw >= 2 && !t.ch.prisaoPrismatica);
      if (!pool.length) continue;
      pool.sort((a, b) => b.pw - a.pw);
      play._target = { targetP: pool[0].p, targetI: pool[0].i };
    }
    if (te === "tornadoDeFogo") {
      const pool = foes.filter((t) => noBarrier(t));
      if (!pool.length) continue;
      pool.sort((a, b) => b.pw - a.pw);
      play._target = { targetP: pool[0].p, targetI: pool[0].i };
    }
    if (te === "fortalecerTalento") {
      // R-07 parcial (D-N12; offline auto_pick_uid, game_state.gd:2165-2178):
      // FORTALECER mira o aliado mais FRACO, sem teto de Poder, nunca
      // apodrecida (o motor recusa — e o talento travava, D-N01).
      let best = null;
      let bestP = Infinity;
      (pl.field || []).forEach((ch, fi) => {
        if (!ch || ch.podridao || ch.name === "APODRECIDA") return;
        const pw = ch.currentPower ?? ch.power ?? 0;
        if (pw < bestP) {
          bestP = pw;
          best = fi;
        }
      });
      if (best == null) continue;
      play._target = { targetP: seat, targetI: best };
    }
    if (te === "investidaTalento") {
      // (1.51.96 item 14) NUNCA num P1, nunca num SILENCIADO (13a:
      // não recebe status), nunca cansado ou apodrecida; o motor
      // escolhe o mais forte entre os válidos.
      const pool = [];
      (pl.field || []).forEach((ch, fi) => {
        if (!ch || ch.tapped || ch.podridao || ch.name === "APODRECIDA" || ch.silenced) return;
        const pw = ch.currentPower ?? ch.power ?? 0;
        if (pw < 2 || hasInvestida(ch)) return;
        pool.push({ i: fi, pw });
      });
      if (!pool.length) continue;
      pool.sort((a, b) => b.pw - a.pw);
      play._target = { targetP: seat, targetI: pool[0].i };
    }
    if (te === "trocaDeLugar") {
      let best = null;
      (pl.field || []).forEach((ch, fi) => {
        if (best == null && ch && (ch.currentPower ?? ch.power ?? 0) === 1) best = fi;
      });
      if (best == null) continue;
      play._target = { targetP: seat, targetI: best };
    }
    if (te === "corromperTalento") {
      // U-B10 (rodada 5): espelho do gate do score — o offline só exclui
      // quem já tem o flag `corrupted`; o nativo Sem Honra é alvo válido
      // (o efeito é desperdiçado, igual ao offline).
      // (1.51.96 item 13a) e nunca num SILENCIADO.
      let best = null;
      let bestP = Infinity;
      (pl.field || []).forEach((ch, fi) => {
        if (!ch || ch.corrupted || ch.silenced) return;
        if (ch.podridao || ch.name === "APODRECIDA") return;
        const pw = ch.currentPower ?? ch.power ?? 0;
        if (pw < bestP) {
          bestP = pw;
          best = fi;
        }
      });
      if (best == null) continue;
      play._target = { targetP: seat, targetI: best };
    }
    if (te === "doppelganger") {
      let best = null;
      (pl.field || []).forEach((ch, fi) => {
        if (best == null && ch && (ch.currentPower ?? ch.power ?? 0) === 2) best = fi;
      });
      if (best == null) continue;
      play._target = { targetP: seat, targetI: best };
    }
    plays.push(play);
  }
  return plays;
}

/**
 * Ultimate jogável (heurística vs-IA, sem peeks).
 * @param {boolean} forceEndOfTurn — iceWitch/pirate só no fim.
 */
export function pickUltimate(state, seat, forceEndOfTurn = false) {
  const pl = state.players[seat];
  if (!pl) return null;
  const hero = pl.heroDef || null;
  const heroId = hero?.id || pl.heroId;
  if (!heroId) return null;
  const maxUlt = getEffectiveMaxUltimateUses(pl, heroId);
  if ((pl.ultimateUses ?? 0) >= maxUlt || pl.usedUltimateThisTurn) return null;
  const ultType = hero?.ultimateType || pl.ultimateType;
  if (!ultType) return null;
  if ((heroId === "iceWitch" || heroId === "pirate") && !forceEndOfTurn) return null;

  const base = {
    type: "ULTIMATE_PLAY",
    playerId: seat,
    ultimateType: ultType,
    heroId,
  };

  if (ultType === "targetEnemy" || ultType === "targetEnemyFreeze") {
    if (ultType === "targetEnemyFreeze" && !forceEndOfTurn) return null;
    // D-N16/D-N17 (offline _ult_damage_worth_it, ai_brain.gd:161-242): o
    // GATE olha o mais forte INCLUINDO congelados (CONGELAR) e Protegidos
    // (BOMBA); só o PICK exclui o que o motor não aceita. O comentário
    // antigo afirmava o contrário (que o pool devia excluir congelados)
    // e estava errado — o gate do offline inclui o congelado.
    const gatePool = [];
    const pickPool = [];
    for (let p = 0; p < (state.playersCount || 2); p++) {
      if (p === seat) continue;
      (state.players[p]?.field || []).forEach((c, i) => {
        // S2-A10: fora o próprio enfeitiçado (offline: foes exclui _own_charmed).
        if (!c || (c.charme && c.charmeOriginalOwner === seat)) return;
        gatePool.push({ p, i, pw: c.currentPower ?? c.power ?? 0, frozen: !!c.frozen });
        if (!c.shielded && !(ultType === "targetEnemyFreeze" && c.frozen))
          pickPool.push({ p, i, pw: c.currentPower ?? c.power ?? 0, frozen: !!c.frozen });
      });
    }
    if (!gatePool.length || !pickPool.length) return null;
    gatePool.sort((a, b) => b.pw - a.pw);
    pickPool.sort((a, b) => b.pw - a.pw);
    // BOMBA (offline _ult_damage_worth_it): só se o mais forte for P<=1.
    if (ultType === "targetEnemy" && gatePool[0].pw > 1) return null;
    // CONGELAR (offline): só no mais forte P>=2 NÃO-congelado.
    if (ultType === "targetEnemyFreeze" && (gatePool[0].pw < 2 || gatePool[0].frozen)) return null;
    return { ...base, targetP: pickPool[0].p, targetI: pickPool[0].i };
  }
  if (ultType === "targetAllyShield") {
    // Bastion: Proteção em todos os aliados de Poder 1 — usa no fim do turno.
    if (!forceEndOfTurn) return null;
    // D-N18 (offline next_action): basta qualquer P1 — a Proteção renova.
    // (1.51.96 item 13a) e o P1 tem de NÃO estar silenciado: SILENCIADO
    // não recebe outros status.
    const anyP1 = (pl.field || []).some((c) => c
      && (c.currentPower ?? c.power) === 1 && !c.silenced);
    if (!anyP1) return null;
    return { ...base, targetP: null, targetI: null };
  }
  if (ultType === "incinerate") {
    const pool = [];
    for (let p = 0; p < (state.playersCount || 2); p++) {
      if (p === seat) continue;
      (state.players[p]?.field || []).forEach((c, i) => {
        if (!c || c.barrier || c.barrierPermanent || c.burning) return;
        const pw = c.currentPower ?? c.power ?? 0;
        if (pw >= 2) pool.push({ p, i, pw });
      });
    }
    if (!pool.length) return null;
    pool.sort((a, b) => b.pw - a.pw);
    return { ...base, targetP: pool[0].p, targetI: pool[0].i };
  }
  if (ultType === "targetAlly" || ultType === "targetAllyFreeAttack") {
    if (ultType === "targetAllyFreeAttack" && !forceEndOfTurn) return null;
    if (ultType === "targetAllyFreeAttack") {
      // (1.51.96 itens 12 e 14) a Ultimate da Tina só vale quando o
      // ataque livre DESTRÓI um adversário — NUNCA num aliado de Poder
      // 1, nunca num SILENCIADO (não recebe status). O motor escolhe
      // o aliado mais forte; o portão olha para ele.
      const kill = freeAttackKillPossible(state, seat);
      if (!kill) return null;
      return { ...base, targetP: seat, targetI: kill.attIdx };
    }
    // U-D06 (rodada 3, offline use_ultimate game_state.gd:1449-1485):
    // FORTALECER mira o mais forte entre os NÃO-apodrecidos. (A INVESTIDA
    // — targetAllyFreeAttack — sai pelo portão estrito acima, 1.51.96.)
    const field = pl.field || [];
    if (!field.length) return null;
    let idx = -1;
    let best = -1;
    field.forEach((c, i) => {
      if (!c) return;
      if (c.podridao || c.name === "APODRECIDA") return;
      const pw = c.currentPower ?? c.power ?? 0;
      if (pw > best) {
        best = pw;
        idx = i;
      }
    });
    if (idx < 0) return null;
    return { ...base, targetP: seat, targetI: idx };
  }
  if (ultType === "drawCard") {
    // D-N15 (offline next_action, ai_brain.gd:49-152): a Ultimate de compra
    // é usada SEMPRE (só a mão cheia veta) — o gate de mão/ações guardava
    // a carta à toa.
    if ((pl.hand?.length || 0) >= MAX_HAND) return null;
    return { ...base, targetP: null, targetI: null };
  }
  // Ultimates sem alvo / auto.
  if (ultType === "fireAndIce") {
    const hs = humanSeat(state, seat);
    // S2-A10 (offline): recusa SÓ adversário único P1. Veneno não entra no gate.
    const foes = (state.players[hs]?.field || []).filter((c) => c
      && !(c.charme && c.charmeOriginalOwner === seat));
    if (!foes.length) return null;
    if (foes.length === 1 && (foes[0].currentPower ?? foes[0].power ?? 0) === 1) return null;
    return { ...base, targetP: null, targetI: null };
  }
  if (ultType === "banish") {
    const pool = [];
    for (let p = 0; p < (state.playersCount || 2); p++) {
      if (p === seat) continue;
      (state.players[p]?.field || []).forEach((c, i) => {
        if (!c) return;
        // (C5-03, rodada 9) a mira offline (ultBanir) só exige P≤2
        // e o motor aceita banir o protegido (championBanishable só
        // olha o Poder) — o veto a `shielded` guardava um banimento
        // válido; a IA nunca usava OUTRA DIMENSÃO num protegido.
        if (c.charme && c.charmeOriginalOwner === seat) return;
        // (1.51.96 item 12) NUNCA num P1: banir um P1 não dá PV e
        // gasta a Ultimate à toa. Só vale com um P2 exato.
        const cur = c.currentPower ?? c.power ?? 0;
        if (cur !== 2) return;
        pool.push({ p, i, noHonor: !!(c.noHonor || c.corrupted) });
      });
    }
    if (!pool.length) return null;
    pool.sort((a, b) => (a.noHonor ? 1 : 0) - (b.noHonor ? 1 : 0));
    return { ...base, targetP: pool[0].p, targetI: pool[0].i };
  }
  if (ultType === "infinitePower") {
    // S2-A09 (offline ai_brain.gd:84-85): FORÇA INFINITA vale com qualquer
    // aliado em campo. (C5-05, rodada 9) o gate antigo exigia um aliado
    // sem Crescimento — o offline usa e gasta o uso à toa; o motor
    // aceita (validate só exige campo não vazio; o apply não faz nada
    // de novo quando todos já têm Crescimento).
    // (1.51.96 item 13a) a Força Infinita dá CRESCIMENTO (status) — num
    // campo só de SILENCIADOS ela não faz nada; a IA guarda o uso.
    if (!(pl.field || []).some((c) => c && !c.silenced))
      return null;
    return { ...base, targetP: null, targetI: null };
  }
  if (ultType === "reuseInstant") {
    // S2-A09 (offline ai_brain.gd:87-92 + _reuse_candidate_ok): só vale
    // com um aliado de Habilidade Instantânea, sem SILÊNCIO — e nunca
    // re-dispara BOLHAS/PESADELO já usados neste turno. O motor
    // (canReuseInstant) valida o alvo de verdade no ULTIMATE_PLAY.
    // (1.51.96 item 7) SÓ a TROCA INJUSTA ganha a checagem da
    // pré-condição aqui: reutilizá-la sem um P2 adversário gasta a
    // Ultimate à toa — esse candidato é pulado, e o próximo vale.
    const usedThisTurn = pl.onEnterUsedThisTurn || [];
    let idx = -1;
    (pl.field || []).forEach((c, i) => {
      if (idx >= 0 || !c || c.silenced || c.abilityType !== "instant" || !c.onEnter)
        return;
      if ((c.onEnter === "bolhas" || c.onEnter === "pesadelo") && usedThisTurn.includes(c.onEnter))
        return;
      if (c.onEnter === "trocaInjusta" && !hasFoePower(state, seat, 2))
        return;
      idx = i;
    });
    if (idx < 0)
      return null;
    return { ...base, targetP: seat, targetI: idx };
  }
  if (ultType === "trickerySwap") {
    // S2-A09 (offline ai_brain.gd:123-126): precisa de um aliado de Poder
    // 1 (o alvo) e de um P2 adversário (sem contar o próprio enfeitiçado).
    // O motor escolhe o P2 (prioriza P2, depois 3+, depois 1).
    let allyIdx = -1;
    (pl.field || []).forEach((c, i) => {
      if (allyIdx >= 0 || !c)
        return;
      if ((c.currentPower ?? c.power ?? 0) === 1)
        allyIdx = i;
    });
    if (allyIdx < 0)
      return null;
    const hs = humanSeat(state, seat);
    const foeHasP2 = (state.players[hs]?.field || []).some((c) => c
      && (c.currentPower ?? c.power ?? 0) === 2
      && !(c.charme && c.charmeOriginalOwner === seat));
    if (!foeHasP2)
      return null;
    return { ...base, targetP: seat, targetI: allyIdx };
  }
  // S2-A10 — gates offline (ai_brain.gd: _ult_damage_worth_it / next_action).
  if (ultType === "potion") {
    // POÇÃO: só em P2 exato não-apodrecido, nunca P1.
    const hasP2 = (pl.field || []).some((c) => c && (c.currentPower ?? c.power ?? 0) === 2
      && !(c.podridao || c.name === "APODRECIDA"));
    if (!hasP2) return null;
    // (C5-01, rodada 9) o pick devolvia alvo nulo e o motor recusava
    // com TARGET_REQUIRED — espelha o auto_pick_uid offline (ultPocao):
    // o mais fraco entre os não-apodrecidos com Poder >= 2.
    const pool = (pl.field || [])
      .map((c, i) => ({ c, i, pw: c.currentPower ?? c.power ?? 0 }))
      .filter((t) => t.c && t.pw >= 2 && !(t.c.podridao || t.c.name === "APODRECIDA"));
    if (!pool.length) return null;
    pool.sort((a, b) => a.pw - b.pw);
    return { ...base, targetP: seat, targetI: pool[0].i };
  }
  if (ultType === "thunderDiscard") {
    // TROVOADA: só se o adversário tiver cartas na mão.
    const hs = humanSeat(state, seat);
    if (!((state.players[hs]?.hand?.length ?? 0) > 0)) return null;
    return { ...base, targetP: null, targetI: null };
  }
  if (ultType === "cometStarfall") {
    // COMETA: só se o adversário perde mais P1 que a IA E tem mais campeões.
    const myP1 = (pl.field || []).filter((c) => c && (c.currentPower ?? c.power ?? 0) <= 1).length;
    const hs = humanSeat(state, seat);
    const foes = (state.players[hs]?.field || []).filter((c) => c
      && !(c.charme && c.charmeOriginalOwner === seat));
    const foeP1 = foes.filter((c) => (c.currentPower ?? c.power ?? 0) <= 1).length;
    if (!(foeP1 > myP1 && foes.length > (pl.field || []).length)) return null;
    return { ...base, targetP: null, targetI: null };
  }
  if (ultType === "hook") {
    // PUXÃO (C5-02, decisão dela 17/11 ~06:04): espaço no próprio
    // campo + alvo P1/P2 — COM OU SEM Proteção (temporária ou
    // permanente), não-apodrecida. Único critério: Poder 1 ou 2.
    // BARREIRA não bloqueia (offline, 1.51.65 T7).
    // (1.51.96 item 8) EXCETO envenenado: roubar um campeão com veneno
    // é ficar com um campeão que morre em 2 rodadas no próprio campo
    // — só vale com um P1/P2 LIMPO para roubar.
    if ((pl.field || []).length >= MAX_FIELD) return null;
    const hs = humanSeat(state, seat);
    const ok = (state.players[hs]?.field || []).some((c) => c
      && [1, 2].includes(c.currentPower ?? c.power ?? 0)
      && !(c.podridao || c.name === "APODRECIDA")
      && !c.poisoned
      && !(c.charme && c.charmeOriginalOwner === seat));
    if (!ok) return null;
    return { ...base, targetP: null, targetI: null };
  }
  if (ultType === "poison") {
    // ENVENENAR (offline): vale com qualquer adversário em campo.
    // (1.51.96 item 12) o mais forte morre em 2 rodadas — mas NUNCA
    // num P1 (morre fácil de qualquer jeito) e nunca 2x no mesmo
    // campeão (reaplicar só refresca o timer). Só vale com um P2+
    // ainda sem veneno.
    if (enemyFieldCount(state, seat) <= 0) return null;
    // (C5-01, rodada 9) o pick devolvia alvo nulo e o motor recusava
    // com TARGET_REQUIRED — espelha o auto_pick_uid offline
    // (ultEnvenenar): o mais forte entre os adversários, menos o
    // próprio enfeitiçado.
    const foes = foesExcludingCharmed(state, seat)
      .filter((t) => (t.c.currentPower ?? t.c.power ?? 0) >= 2 && !t.c.poisoned);
    if (!foes.length) return null;
    foes.sort((a, b) => (b.c.currentPower ?? b.c.power ?? 0) - (a.c.currentPower ?? a.c.power ?? 0));
    return { ...base, targetP: foes[0].p, targetI: foes[0].i };
  }
  if (ultType === "vampirism") {
    // VAMPIRISMO: adversário P2+ E aliado não-apodrecida.
    const foes = foesExcludingCharmed(state, seat)
      .filter((t) => (t.c.currentPower ?? t.c.power ?? 0) >= 2);
    const allyOk = (pl.field || []).some((c) => c && !(c.podridao || c.name === "APODRECIDA"));
    if (!foes.length || !allyOk) return null;
    // (C5-01, rodada 9) o pick devolvia alvo nulo e o motor recusava
    // com TARGET_REQUIRED — espelha o auto_pick_uid offline: o mais
    // forte P2+ entre os adversários, menos o próprio enfeitiçado.
    foes.sort((a, b) => (b.c.currentPower ?? b.c.power ?? 0) - (a.c.currentPower ?? a.c.power ?? 0));
    return { ...base, targetP: foes[0].p, targetI: foes[0].i };
  }
  if (ultType === "scareReturn") {
    // AMEDRONTAR (offline): só com P2 exato (nunca P1).
    const foes = foesExcludingCharmed(state, seat)
      .filter((t) => (t.c.currentPower ?? t.c.power ?? 0) === 2);
    if (!foes.length) return null;
    // (C5-01, rodada 9) o pick devolvia alvo nulo e o motor recusava
    // com TARGET_REQUIRED — espelha o auto_pick_uid offline
    // (ultAssustar): o mais forte entre os P2 (o pool offline é P≤2
    // e a porta exige um P2 exato, então o mais forte é sempre P2).
    return { ...base, targetP: foes[0].p, targetI: foes[0].i };
  }
  if (ultType === "summonDragon") {
    // INVOCAR DRAGÃO (offline): precisa de espaço livre no próprio campo.
    if ((pl.field || []).length >= MAX_FIELD) return null;
    return { ...base, targetP: null, targetI: null };
  }
  if (ultType === "resurrect") {
    // RESSUSCITAR (offline): P2 no descarte + espaço no campo.
    const ok = (pl.discard || []).some((c) => c && c.category === "champion"
      && (c.power ?? c.basePower ?? 0) === 2) && (pl.field || []).length < MAX_FIELD;
    if (!ok) return null;
    return { ...base, targetP: null, targetI: null };
  }
  // Os dois tipos mortos (C-B01): nenhum dos 21 heróis (df-data.js:5-66) tem
  // esses tipos e o offline também não tem ramo — removidos do catch-all.
  return null;
}

const REMOVAL_TALENTS = new Set(["bolaDeFogoTalento", "explosao", "tornadoDeFogo",
  "baforadaVenenosa", "missemagicos", "transformarBichinhoTalento",
  "prisaoPrismaticaTalento", "medoTalento", "zeroAbsoluto", "chuvaDeCometas"]);
const BUFF_TALENTS = new Set(["fortalecerTalento", "investidaTalento", "doppelganger",
  "corromperTalento", "tecnicasDeCombateTalento", "gritoDeGuerraTalento", "barreira"]);

// S2-A08 — espelho de _removal_kill_value (ai_brain.gd:746): quanto Poder
// adversário o talento tira do campo AGORA (0 = nada agora, ex. veneno/queimadura).
export function removalKillValue(state, seat, eff) {
  const foes = [];
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    for (const c of (state.players[p]?.field || [])) {
      if (c && !(c.charme && c.charmeOriginalOwner === seat)) foes.push(c);
    }
  }
  if (!foes.length) return 0;
  const pw = (c) => c.currentPower ?? c.power ?? 0;
  const hasBarrier = (c) => !!(c.barrier || (c.barrierTurns ?? 0) > 0);
  const isFrozen = (c) => !!(c.frozen || (c.frozenTurns ?? 0) > 0);
  switch (eff) {
    case "bolaDeFogoTalento":
      return foes.some((c) => pw(c) === 1 && !hasBarrier(c)) ? 1 : 0;
    case "explosao": {
      let best = 0;
      for (const c of foes) if (!hasBarrier(c) && pw(c) <= 2) best = Math.max(best, pw(c));
      return best;
    }
    case "missemagicos":
    case "chuvaDeCometas":
      return foes.some((c) => pw(c) === 1 && !hasBarrier(c)) ? 1 : 0;
    case "transformarBichinhoTalento": {
      let best = 0;
      for (const c of foes) if (!hasBarrier(c) && pw(c) >= 2) best = Math.max(best, pw(c) - 1);
      return best;
    }
    case "prisaoPrismaticaTalento": {
      let best = 0;
      for (const c of foes) best = Math.max(best, pw(c));
      return best;
    }
    case "medoTalento": {
      let best = 0;
      for (const c of foes) if (pw(c) <= 2) best = Math.max(best, pw(c));
      return best;
    }
    case "zeroAbsoluto": {
      let best = 0;
      for (const c of foes) if (isFrozen(c)) best = Math.max(best, pw(c));
      return best;
    }
    case "tornadoDeFogo":
    case "baforadaVenenosa":
      return 0;
    default:
      return 0;
  }
}

/** S2-A08 (offline _best_talent): mitigação -> melhor remoção primeiro;
 *  campo -> reforço primeiro, remoção só se matar alguém (kill>=1). */
// F7-11 D5-D8 — espelho de _best_talent (ai_brain.gd:813-970): a ORDEM DA
// MÃO decide, nunca o score fixo. best_removal só com valor de abate > 0
// (empate = 1º da mão, `>` estrito — uma remoção sem abate nunca vence o
// CORROMPER); best_corromper = CORROMPER com P1 não corrompido em campo.
// mitigação: melhor remoção → CORROMPER → 1ª remoção → 1º da mão.
// campo: CORROMPER → 1º reforço → melhor remoção (se matar ≥1) → nada.
// equilíbrio: CORROMPER → 1º da mão.
export function pickTalentByMode(state, seat, talents) {
  const mode = aiMode(state, seat);
  const hand = state.players[seat]?.hand || [];
  const byEffect = (t) => hand[t.handIdx]?.talentEffect;
  const allies = state.players[seat]?.field || [];
  const hasP1Uncorrupted = allies.some((c) => c
    && (c.currentPower ?? c.power ?? 0) === 1 && !c.corrupted);
  let first = null;
  let firstRemoval = null;
  let bestRemoval = null;
  let bestRemovalValue = 0;
  let firstBuff = null;
  let bestCorromper = null;
  for (const t of talents) {
    if (first == null) first = t;
    const eff = byEffect(t);
    if (eff === "corromperTalento" && bestCorromper == null && hasP1Uncorrupted) {
      bestCorromper = t;
    }
    if (REMOVAL_TALENTS.has(eff)) {
      if (firstRemoval == null) firstRemoval = t;
      const kv = removalKillValue(state, seat, eff);
      if (kv > bestRemovalValue) {
        bestRemovalValue = kv;
        bestRemoval = t;
      }
    } else if (BUFF_TALENTS.has(eff) && firstBuff == null) {
      firstBuff = t;
    }
  }
  if (mode === "mitigacao") {
    if (bestRemoval) return bestRemoval;
    if (bestCorromper) return bestCorromper;
    if (firstRemoval) return firstRemoval;
  } else if (mode === "campo") {
    if (bestCorromper) return bestCorromper;
    if (firstBuff) return firstBuff;
    if (bestRemoval && bestRemovalValue >= 1) return bestRemoval;
    return null;
  }
  if (bestCorromper) return bestCorromper;
  return first;
}

/**
 * Próxima ação do turno IA (fase: talent | main | ult_end | end).
 */
export function pickNextAction(state, seat, phaseCtx = {}) {
  const phase = phaseCtx.phase || "main";
  const legal = phaseCtx.legal || [];
  const minScore = phaseCtx.minScore != null ? phaseCtx.minScore : 5;

  if (phase === "talent") {
    const talents = listTalentPlays(state, seat);
    if (!talents.length) return null;
    // F7-11 D5-D8: SEM ordenar por score — o pickTalentByMode decide pela
    // ordem da mão (espelho de _best_talent); a lista já vem na ordem da mão.
    // S2-A08 (offline _best_talent): o modo escolhe a categoria do talento.
    return pickTalentByMode(state, seat, talents);
  }
  if (phase === "ult_early") {
    return pickUltimate(state, seat, false);
  }
  if (phase === "ult_end") {
    return pickUltimate(state, seat, true);
  }
  if (phase === "end") {
    return { type: "END_TURN", playerId: seat, _score: -9999 };
  }
  // main
  const picked = pickBestHardAction(state, seat, legal, { minScore });
  if (picked?.type === "END_TURN" && minScore > 0) {
    return pickBestHardAction(state, seat, legal, { minScore: 0 });
  }
  return picked;
}

export const DfAiHardBrain = {
  loadHardProfile,
  resetHardProfileCache,
  fieldCount,
  enemyFieldCount,
  evaluateAiPosition,
  aiMode,
  removalKillValue,
  pickTalentByMode,
  gate8CanSummonAndAttack,
  pickWinAttack,
  pickDecisiveAttack,
  pickBestSummon,
  pickBestAttack,
  pickDraw,
  scoreSummonCard,
  summonPremiseBlocked,
  shouldAttack,
  scoreAttackAction,
  scoreDrawAction,
  scoreLegalAction,
  pickBestHardAction,
  pickOnEnterResolution,
  listTalentPlays,
  pickUltimate,
  pickNextAction,
  MAX_FIELD,
  MAX_HAND,
  AI_STEP_MS: 2500,
};

export default DfAiHardBrain;
