/**
 * Cérebro IA Difícil — puro (sem DOM).
 * Usado pela IA de disconnect MP (servidor) e espelha heurísticas do vs-IA Difícil.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_FIELD = 6;
const MAX_HAND = 10;
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
    onEnter: {
      invokeDragon: 10, rapidez: 13, fortalecer: 9, devourar: 8, summonRitual: 23,
      bolaDeFogo: 14, fumacaToxica: 15, raioDuplo: 16, auraDeFogo: 13, auraAntiMagia: 10,
      assassinar: 16, pesadelo: 7, roubar: 10, desacelerar: 9, sobrepujar: 6, fieldSlotBonus: 15,
      rapidezAttackFollowUp: 28, summonBlocksKillPenalty: 55, fumacaOnlyP1Penalty: 16,
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

function enemyHasNonP1(state, seat) {
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    for (const c of state.players[p]?.field || []) {
      if (c && (c.currentPower ?? c.power ?? 0) > 1) return true;
    }
  }
  return false;
}

function enemyHasP1(state, seat) {
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    for (const c of state.players[p]?.field || []) {
      if (c && (c.currentPower ?? c.power ?? 0) === 1) return true;
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

function isOverpower(c) {
  return !!(c && (c.abilityName === "Sobrepujar" || c.constantEffect === "sobrepujar"));
}

export function championSummonCost(c) {
  const p = c?.currentPower ?? c?.power ?? 0;
  if (p <= 1) return 1;
  if (p === 2) return 1;
  return 2;
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
    if (!att || att.tapped || att.frozen || att.pulled) continue;
    for (let ep = 0; ep < (state.playersCount || 2); ep++) {
      if (ep === seat) continue;
      for (let di = 0; di < (state.players[ep]?.field || []).length; di++) {
        const def = state.players[ep].field[di];
        if (!def || def.shielded || def.pulled) continue;
        const o = combatOutcome(att, def);
        if (o.killD && !o.killA) return true;
      }
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
  const summonMul = g("summonScoreMul", 1);
  const pow = card.currentPower ?? card.power ?? 0;
  const cost = championSummonCost(card);
  const actionsAfter = (pl?.actions ?? 0) - cost;
  let score = pow * 4 * summonMul;
  const needTempoKill = hasCleanKill(state, seat);
  if (needTempoKill && actionsAfter < 1 && !card.summonRitual) {
    score -= onEnterW("summonBlocksKillPenalty", 55);
  }
  if (humanNearWin(state, seat) && actionsAfter < 1 && cost >= 2) {
    score -= 90;
  }
  const oe = card.onEnter;
  if (oe === "invokeDragon" || oe === "invokeCubicDragon") score += onEnterW("invokeDragon", 10);
  if (oe === "rapidez") {
    score += onEnterW("rapidez", 13);
    if (enemyFc > 0 && (actionsAfter + 1) >= 1) score += onEnterW("rapidezAttackFollowUp", 28);
    else if (enemyFc > 0) score += 20;
  }
  if (oe === "fortalecer" && fc > 0) score += onEnterW("fortalecer", 9);
  if (oe === "devorar" && fc > 0) score += onEnterW("devourar", 8);
  if (card.summonRitual) score += onEnterW("summonRitual", 23) + pow * 4;
  if (oe === "bolaDeFogo") score += onEnterW("bolaDeFogo", 14);
  if (oe === "fumacaToxica" && enemyFc > 0) {
    score += enemyHasNonP1(state, seat)
      ? onEnterW("fumacaToxica", 15)
      : -onEnterW("fumacaOnlyP1Penalty", 16);
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
    const opp = state.players[humanSeat(state, seat)];
    score += opp && !opp.skipNextAction ? onEnterW("desacelerar", 9) : -6;
  }
  if (oe === "incendiar" && enemyFc > 0) score += 14;
  if (oe === "guardiao" && fc > 0) score += 12;
  if (oe === "furia" || oe === "gritoDeGuerra") score += 11;
  if (oe === "defensor") score += 10;
  if (oe === "necromancia") score += 8;
  if (isOverpower(card)) score += onEnterW("sobrepujar", 6);
  // Encher campo (inimigo vazio / poucas peças).
  if (fc < 2) score += onEnterW("fieldSlotBonus", 15);
  if (enemyFc === 0 && fc < MAX_FIELD) score += 18 + (MAX_FIELD - fc) * 3;
  // Evita encher com lixo sem habilidade quando já tem 2+.
  if (fc >= 2 && !oe && !card.summonRitual) score -= 25;
  if (opts.bestHandIdx === handIdx) score += 400;
  if (opts.plainHandIdx === handIdx) score += 200;
  return score;
}

/**
 * Espelha aiShouldAttack do vs-IA: jamais ataca campeão de Poder maior.
 * Sobrepujar no defensor com poder igual também é recusado (manual §17).
 */
export function shouldAttack(attacker, defender) {
  if (!attacker || !defender) return false;
  if (defender.shielded || defender.pulled) return false;
  if (attacker.tapped || attacker.frozen || attacker.pulled) return false;
  const aPow = attacker.currentPower ?? attacker.power ?? 0;
  const dPow = defender.currentPower ?? defender.power ?? 0;
  const overA = isOverpower(attacker);
  const overD = isOverpower(defender);
  if (aPow < dPow) return false;
  if (overD && aPow <= dPow) return false;
  if (aPow === dPow && overA && overD) return false;
  if (aPow > dPow) return true;
  if (aPow === dPow && overA && !overD) return true;
  if (aPow === dPow && !overA && !overD) return true;
  return false;
}

export function scoreAttackAction(state, seat, action) {
  const pl = state.players[seat];
  const att = pl?.field?.[action.attackerIdx];
  const def = state.players[action.defenderPlayerId]?.field?.[action.defenderIdx];
  if (!att || !def || def.shielded || def.pulled) return -9999;
  if (att.tapped || att.frozen || att.pulled) return -9999;
  if (!shouldAttack(att, def)) return -9999;
  const { killD, killA, ap, dp } = combatOutcome(att, def);
  const atkMul = g("attackScoreMul", 1);
  // Não suicidar sem necessidade.
  if (!killD && killA && dp > ap + 1) return -40;
  if (killD && !killA) {
    let score = atkW("cleanKillBase", 28) + dp * atkW("cleanKillPerDefPower", 10);
    if (fieldCount(state, action.defenderPlayerId) <= 1) {
      score += atkW("lastChampionBonus", 45);
    }
    if (humanNearWin(state, seat)) score += 80;
    if (isOverpower(att)) score += 25;
    return score * atkMul + 700;
  }
  if (killD && killA) {
    return (ap * atkW("tradeKillPerPower", 5) - atkW("tradePenalty", 12)) * atkMul + 40;
  }
  // Pressão / Sobrepujar empate.
  if (ap === dp && isOverpower(att)) return 120 * atkMul;
  return 25 + (ap - dp) * 3;
}

export function scoreDrawAction(state, seat) {
  const pl = state.players[seat];
  if (!pl) return -9999;
  const deckLeft = pl.deckCount != null ? pl.deckCount : (pl.deck?.length ?? 0);
  if (deckLeft <= 0 || (pl.hand?.length || 0) >= MAX_HAND) return -9999;
  if (hasCleanKill(state, seat)) return -100;
  if (humanNearWin(state, seat)) return -80;
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
  const enemyFc = enemyFieldCount(state, seat);
  const fc = fieldCount(state, seat);
  if (te === "aceleracao") {
    if ((state.players[seat]?.actions ?? 0) >= MAX_ACTIONS) return -9999;
    return 40;
  }
  if (te === "barreira") return fc > 0 ? 35 : -9999;
  if (te === "fortalecerTalento") return fc > 0 ? 32 : -9999;
  if (te === "bolaDeFogoTalento") return enemyFc > 0 ? 45 : -9999;
  if (te === "explosao") return enemyHasNonP1(state, seat) ? 48 : -9999;
  if (te === "zeroAbsoluto") return enemyFc > 0 ? 42 : -9999;
  if (te === "medoTalento") return enemyFc > 0 ? 38 : -9999;
  if (te === "baforadaVenenosa") return enemyHasNonP1(state, seat) ? 36 : -9999;
  if (te === "missemagicos") return enemyFc > 0 ? 44 : -9999;
  if (te === "doppelganger") return fc > 0 && fc < MAX_FIELD ? 34 : -9999;
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
  let bestSummonIdx = null;
  let bestSummonScore = -Infinity;
  let plainIdx = null;
  let plainScore = -Infinity;
  for (const a of legal) {
    if (a?.type !== "SUMMON") continue;
    const card = state.players[seat]?.hand?.[a.handIdx];
    const s = scoreSummonCard(state, seat, card, a.handIdx, {});
    if (s > bestSummonScore) {
      bestSummonScore = s;
      bestSummonIdx = a.handIdx;
    }
    // Plain: sem onEnter que exige inimigo, ou qualquer quando board vazio.
    const needsEnemy = card && [
      "bolaDeFogo", "assassinar", "fumacaToxica", "raioDuplo", "mordidaVenenosa",
      "incendiar", "pesadelo", "roubar", "desacelerar", "corromper",
    ].includes(card.onEnter);
    if (!needsEnemy || enemyFieldCount(state, seat) > 0) {
      const ps = (card?.currentPower ?? card?.power ?? 0) * 3 - championSummonCost(card);
      if (ps > plainScore) {
        plainScore = ps;
        plainIdx = a.handIdx;
      }
    }
  }
  const meta = { bestHandIdx: bestSummonIdx, plainHandIdx: plainIdx };

  let best = null;
  let bestScore = -Infinity;
  for (const a of legal) {
    if (!a?.type || a.type === "END_TURN") continue;
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
  // Ainda assim: se há SUMMON/ATTACK legal, pega o menos pior (não passa).
  if (best && bestScore > -9999) {
    const hasPlay = legal.some((a) => a?.type === "SUMMON" || a?.type === "ATTACK_RESOLVE");
    if (hasPlay && bestScore >= -20) {
      return { ...best, playerId: seat, _score: bestScore };
    }
    // Campo vazio + summon possível: força plain.
    if (plainIdx != null && fieldCount(state, seat) < MAX_FIELD) {
      return { type: "SUMMON", playerId: seat, handIdx: plainIdx, _score: plainScore };
    }
    if (hasPlay) {
      return { ...best, playerId: seat, _score: bestScore };
    }
  }
  const end = legal.find((a) => a?.type === "END_TURN");
  return end
    ? { ...end, playerId: seat, _score: -9999 }
    : { type: "END_TURN", playerId: seat, _score: -9999 };
}

/** Heurística de alvo on-enter (estilo aiPickOnEnterResolution, sem peeks). */
export function pickOnEnterResolution(state, seat, ability, casterIdx, fieldIdx) {
  const gatherEnemy = (pred) => {
    const out = [];
    for (let p = 0; p < (state.playersCount || 2); p++) {
      if (p === casterIdx) continue;
      (state.players[p]?.field || []).forEach((c, i) => {
        if (c && (!pred || pred(c, p, i))) out.push({ p, i, c });
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
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { targetP: pick.p, targetI: pick.i, enemyP: pick.p, enemyI: pick.i };
  }
  if (ability === "bolaDeFogo" || ability === "assassinar" || ability === "incendiar"
      || ability === "mordidaVenenosa" || ability === "corromper"
      || ability === "rajadaCongelante" || ability === "transformarBichinho") {
    // Proteção bloqueia ataques; Assassinar/Transformar ignoram Proteção
    // (Transformar: só Barreira; Assassinar: destruição, não ataque).
    let pool = (ability === "transformarBichinho" || ability === "assassinar")
      ? gatherEnemy(() => true)
      : gatherEnemy((c) => !c.shielded);
    if (ability === "assassinar") {
      pool = pool.filter((t) => (t.c.currentPower ?? t.c.power ?? 0) === 1);
    }
    if (ability === "mordidaVenenosa") {
      pool = pool.filter((t) => !t.c.poisoned && (t.c.currentPower ?? t.c.power ?? 0) > 1);
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
    const allies = gatherAlly(() => true);
    if (!allies.length) return null;
    if (ability === "devorar") {
      allies.sort((a, b) => (a.c.currentPower ?? 0) - (b.c.currentPower ?? 0));
    } else if (ability === "fortalecer") {
      allies.sort((a, b) => (b.c.currentPower ?? 0) - (a.c.currentPower ?? 0));
    } else {
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
  const plays = [];
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (!c || c.category !== "talent") continue;
    // Reativas não se jogam no próprio turno.
    if (c.talentEffect === "bloquearAtaque" || c.talentEffect === "protecaoDivina"
        || c.talentEffect === "cancelarUltimate") continue;
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
    // Anexa alvo sugerido para o follow-up.
    const te = c.talentEffect;
    if (te === "bolaDeFogoTalento" || te === "explosao" || te === "zeroAbsoluto"
        || te === "medoTalento" || te === "baforadaVenenosa") {
      const minP = te === "explosao" ? 2 : 1;
      const pool = [];
      for (let p = 0; p < (state.playersCount || 2); p++) {
        if (p === seat) continue;
        (state.players[p]?.field || []).forEach((ch, fi) => {
          if (!ch || ch.shielded) return;
          const pw = ch.currentPower ?? ch.power ?? 0;
          if (pw < minP) return;
          if (te === "baforadaVenenosa" && (pw <= 1 || ch.poisoned)) return;
          pool.push({ p, i: fi, pw });
        });
      }
      if (!pool.length) continue;
      pool.sort((a, b) => b.pw - a.pw);
      play._target = { targetP: pool[0].p, targetI: pool[0].i };
    }
    if (te === "fortalecerTalento") {
      let best = null;
      let bestP = -1;
      (pl.field || []).forEach((ch, fi) => {
        if (!ch) return;
        const pw = ch.currentPower ?? ch.power ?? 0;
        if (pw > bestP && pw < 4) {
          bestP = pw;
          best = fi;
        }
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
  const maxUlt = pl.maxUltimateUses ?? 1;
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
    const pool = [];
    for (let p = 0; p < (state.playersCount || 2); p++) {
      if (p === seat) continue;
      (state.players[p]?.field || []).forEach((c, i) => {
        if (c && !c.shielded) pool.push({ p, i, pw: c.currentPower ?? c.power ?? 0, frozen: !!c.frozen });
      });
    }
    if (!pool.length) return null;
    if (ultType === "targetEnemyFreeze") {
      pool.sort((a, b) => (b.frozen ? 1 : 0) - (a.frozen ? 1 : 0) || b.pw - a.pw);
    } else {
      pool.sort((a, b) => b.pw - a.pw);
    }
    return { ...base, targetP: pool[0].p, targetI: pool[0].i };
  }
  if (ultType === "targetAlly" || ultType === "targetAllyShield" || ultType === "targetAllyFreeAttack") {
    if (ultType === "targetAllyFreeAttack" && !forceEndOfTurn) return null;
    const field = pl.field || [];
    if (!field.length) return null;
    let idx = 0;
    let best = -1;
    field.forEach((c, i) => {
      if (!c) return;
      const pw = c.currentPower ?? c.power ?? 0;
      if (ultType === "targetAllyShield") {
        if (best < 0 || pw < best) {
          best = pw;
          idx = i;
        }
      } else if (pw > best) {
        best = pw;
        idx = i;
      }
    });
    return { ...base, targetP: seat, targetI: idx };
  }
  if (ultType === "drawCard") {
    const bias = g("ultimateBias", 1);
    const handThresh = bias >= 1.12 ? 4 : 3;
    if ((pl.hand?.length || 0) >= MAX_HAND) return null;
    if ((pl.hand?.length || 0) < handThresh || (pl.actions ?? 0) > 0) {
      return { ...base, targetP: null, targetI: null };
    }
    return null;
  }
  // Ultimates sem alvo / auto.
  if (ultType === "fireAndIce") {
    const hs = humanSeat(state, seat);
    const humanChamps = (state.players[hs]?.field || []).filter(Boolean).length;
    if (humanChamps <= 1) return null;
    let anyNonPoison = false;
    for (let p = 0; p < (state.playersCount || 2); p++) {
      if (p === seat) continue;
      for (const c of (state.players[p]?.field || [])) {
        if (c && !c.poisoned) { anyNonPoison = true; break; }
      }
      if (anyNonPoison) break;
    }
    if (!anyNonPoison) return null;
    return { ...base, targetP: null, targetI: null };
  }
  if (["summonDragon", "thunderDiscard", "wallProtect", "poison", "warOverpower",
    "cometStarfall", "banish", "hook", "potion", "vampirism",
    "scareReturn", "resurrect"].includes(ultType)) {
    if (!forceEndOfTurn && ["scareReturn", "banish"].includes(ultType)) {
      // precisa de inimigo
      if (enemyFieldCount(state, seat) <= 0) return null;
    }
    return { ...base, targetP: null, targetI: null };
  }
  return null;
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
    talents.sort((a, b) => (b._score || 0) - (a._score || 0));
    return talents[0];
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
  scoreSummonCard,
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
  AI_STEP_MS: 1500,
};

export default DfAiHardBrain;
