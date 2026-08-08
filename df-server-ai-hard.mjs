/**
 * Scoring estilo vs-IA Difícil para IA de disconnect (servidor MP).
 * Sem DOM — usa ai-hard.json + heurísticas do df-ai-controller.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _profile = null;

function loadProfile() {
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
    } catch (e) { /* try next */ }
  }
  // Fallback: pesos embutidos (mesmo perfil vs-IA Difícil).
  _profile = {
    globals: {
      attackScoreMul: 1.08,
      summonScoreMul: 0.98,
      drawPenalty: -5,
    },
    onEnter: {
      invokeDragon: 10, rapidez: 13, fortalecer: 9, devourar: 8,
      summonRitual: 23, bolaDeFogo: 14, fumacaToxica: 15, raioDuplo: 16,
      auraDeFogo: 13, auraAntiMagia: 10, assassinar: 16, pesadelo: 7,
      roubar: 10, desacelerar: 9, sobrepujar: 6, fieldSlotBonus: 15,
    },
    attack: {
      cleanKillBase: 28, cleanKillPerDefPower: 10, lastChampionBonus: 45,
      tradeKillPerPower: 5, tradePenalty: 12,
    },
  };
  return _profile;
}

function g(key, fallback) {
  const v = loadProfile()?.globals?.[key];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function onEnterW(key, fallback) {
  const v = loadProfile()?.onEnter?.[key];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function atkW(key, fallback) {
  const v = loadProfile()?.attack?.[key];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function fieldCount(state, pIdx) {
  return (state.players[pIdx]?.field || []).filter(Boolean).length;
}

function enemyFieldCount(state, seat) {
  let n = 0;
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p !== seat) n += fieldCount(state, p);
  }
  return n;
}

function enemyHasNonP1(state, seat) {
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    for (const c of state.players[p]?.field || []) {
      if (!c) continue;
      if ((c.currentPower ?? c.power ?? 0) > 1) return true;
    }
  }
  return false;
}

function enemyHasP1(state, seat) {
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    for (const c of state.players[p]?.field || []) {
      if (!c) continue;
      if ((c.currentPower ?? c.power ?? 0) === 1) return true;
    }
  }
  return false;
}

function enemyHasHand(state, seat) {
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    if ((state.players[p]?.hand?.length || 0) > 0) return true;
  }
  return false;
}

function combatOutcome(att, def) {
  const ap = att.currentPower ?? att.power ?? 0;
  const dp = def.currentPower ?? def.power ?? 0;
  return { killD: ap >= dp, killA: dp >= ap, ap, dp };
}

function scoreSummon(state, seat, action) {
  const pl = state.players[seat];
  const card = pl?.hand?.[action.handIdx];
  if (!card || card.category !== "champion") return -9999;
  const fc = fieldCount(state, seat);
  const enemyFc = enemyFieldCount(state, seat);
  const summonMul = g("summonScoreMul", 1);
  const pow = card.currentPower ?? card.power ?? 0;
  let score = pow * 4 * summonMul;
  const oe = card.onEnter;
  if (oe === "invokeDragon" || oe === "invokeCubicDragon") score += onEnterW("invokeDragon", 10);
  if (oe === "rapidez") {
    score += onEnterW("rapidez", 13);
    if (enemyFc > 0) score += 20;
  }
  if (oe === "fortalecer" && fc > 0) score += onEnterW("fortalecer", 9);
  if (oe === "devorar" && fc > 0) score += onEnterW("devourar", 8);
  if (card.summonRitual) score += onEnterW("summonRitual", 23) + pow * 4;
  if (oe === "bolaDeFogo") score += onEnterW("bolaDeFogo", 14);
  if (oe === "fumacaToxica" && enemyFc > 0) {
    score += enemyHasNonP1(state, seat)
      ? onEnterW("fumacaToxica", 15)
      : -16;
  }
  if (oe === "raioDuplo" && enemyFc > 0) score += onEnterW("raioDuplo", 16);
  if (oe === "auraDeFogo" && fc > 0) score += onEnterW("auraDeFogo", 13);
  if (oe === "auraAntiMagia") score += onEnterW("auraAntiMagia", 10);
  if (oe === "assassinar") {
    score += onEnterW("assassinar", 16);
    score += enemyHasP1(state, seat) ? 35 : -12;
  }
  if (oe === "mordidaVenenosa" && enemyFc > 0) {
    score += enemyHasNonP1(state, seat) ? 13 : -18;
  }
  if (oe === "pesadelo") score += onEnterW("pesadelo", 7);
  if (oe === "roubar") {
    score += enemyHasHand(state, seat) ? onEnterW("roubar", 10) : -8;
  }
  if (oe === "desacelerar") {
    const opp = state.players[(seat + 1) % 2];
    score += opp && !opp.skipNextAction ? onEnterW("desacelerar", 9) : -6;
  }
  if (oe === "incendiar" && enemyFc > 0) score += 14;
  if (card.abilityName === "Sobrepujar") score += onEnterW("sobrepujar", 6);
  if (fc < 2) score += onEnterW("fieldSlotBonus", 15);
  if (fc >= 2 && !oe && !card.summonRitual) score -= 40;
  return score;
}

function scoreAttack(state, seat, action) {
  const pl = state.players[seat];
  const att = pl?.field?.[action.attackerIdx];
  const def = state.players[action.defenderPlayerId]?.field?.[action.defenderIdx];
  if (!att || !def || def.shielded || def.pulled) return -9999;
  const { killD, killA, ap, dp } = combatOutcome(att, def);
  const atkMul = g("attackScoreMul", 1);
  if (killD && !killA) {
    let score = atkW("cleanKillBase", 28) + dp * atkW("cleanKillPerDefPower", 10);
    if (fieldCount(state, action.defenderPlayerId) <= 1) {
      score += atkW("lastChampionBonus", 45);
    }
    return score * atkMul + 700;
  }
  if (killD && killA) {
    return (ap * atkW("tradeKillPerPower", 5) - atkW("tradePenalty", 12)) * atkMul + 40;
  }
  return (ap - dp) * 2;
}

function scoreDraw(state, seat) {
  const pl = state.players[seat];
  if (!pl) return -9999;
  const deckLeft = pl.deckCount != null ? pl.deckCount : (pl.deck?.length ?? 0);
  if (deckLeft <= 0 || (pl.hand?.length || 0) >= 10) return -9999;
  if (enemyFieldCount(state, seat) > 0 && fieldCount(state, seat) > 0) {
    return g("drawPenalty", -5) + 8;
  }
  return 10;
}

/**
 * Escolhe a melhor ação legal (estilo Difícil).
 * @param {object} state
 * @param {number} seat
 * @param {Array<object>} legal
 */
export function pickBestHardAction(state, seat, legal) {
  if (!Array.isArray(legal) || !legal.length) {
    return { type: "END_TURN", playerId: seat };
  }
  let best = null;
  let bestScore = -Infinity;
  for (const a of legal) {
    if (!a?.type || a.type === "END_TURN") continue;
    let s = 0;
    if (a.type === "SUMMON") s = scoreSummon(state, seat, a);
    else if (a.type === "ATTACK_RESOLVE") s = scoreAttack(state, seat, a);
    else if (a.type === "DRAW_CARD") s = scoreDraw(state, seat);
    else if (a.type === "TALENT_START") s = 12;
    else s = 1;
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  if (!best || bestScore < 1) {
    const end = legal.find((a) => a?.type === "END_TURN");
    return end ? { ...end, playerId: seat } : { type: "END_TURN", playerId: seat };
  }
  return { ...best, playerId: seat };
}
