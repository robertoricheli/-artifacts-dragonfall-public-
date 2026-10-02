/**
 * Dragonfall — Conquistas (lógica pura). Autoridade: o servidor.
 * Espelho no cliente: artifacts/dragonfall/js/df-achievements-data.js (paridade testada).
 */

const TIER_COINS = [2, 4, 6, 8, 10];

/** Famílias: métrica, metas por nível (1–5) e Moedas por nível. */
export const ACH_FAMILIES = Object.freeze([
  { family: "duelist", metric: "matches", goals: [10, 50, 100, 200, 500] },
  { family: "scourge", metric: "aiWins", goals: [10, 50, 100, 200, 500] },
  { family: "collector", metric: "cards", goals: [30, 50, 80, 100, 120] },
  { family: "openhand", metric: "coinsSpent", goals: [20, 50, 100, 200, 400] },
  { family: "medal", metric: "rank", locked: true,
    tiers: ["Bronze", "Silver", "Gold", "Diamond", "Platinum", "Challenger", "Mythic"],
    coins: [2, 4, 6, 8, 10, 12, 14] },
  { family: "victor", metric: "pvpWins", goals: [10, 20, 50, 70, 100] },
  { family: "hunter", metric: "champKills", goals: [20, 50, 100, 200, 500] },
  { family: "heroes", metric: "heroes", goals: [5, 10, 15, 20, 25] },
  { family: "fury", metric: "bestStreak", goals: [2, 4, 6, 8, 10] },
  { family: "master", metric: "bigWins", goals: [10, 20, 30, 40, 50] },
]);

export const ACHIEVEMENTS = Object.freeze(ACH_FAMILIES.flatMap((f) => {
  if (f.tiers) {
    return f.tiers.map((t, i) => Object.freeze({
      id: `medal${t}`, family: f.family, tier: i + 1, metric: f.metric, goal: 1, coins: f.coins[i], locked: true,
    }));
  }
  return f.goals.map((goal, i) => Object.freeze({
    id: `${f.family}${i + 1}`, family: f.family, tier: i + 1, metric: f.metric, goal, coins: TIER_COINS[i], locked: false,
  }));
}));

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
export const SHOWCASE_MAX = 5;
export const MATCH_LIMITS = Object.freeze({ maxVp: 30, maxKills: 40 });
export const BIG_WIN_MARGIN = 10;

const STAT_KEYS = ["matches", "aiWins", "pvpWins", "streak", "bestStreak", "champKills", "bigWins", "coinsSpent"];

export function getAchievement(id) {
  return BY_ID.get(String(id)) || null;
}

/** Contadores sanitizados (inteiros ≥ 0). */
export function normalizeStats(raw) {
  const s = {};
  for (const k of STAT_KEYS) s[k] = Math.max(0, Number(raw?.[k]) | 0);
  s.backfilled = !!raw?.backfilled;
  return s;
}

export function normalizeClaimed(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(String).filter((id) => BY_ID.has(id)))];
}

/** Garante os campos de conquista no jogador. Devolve true se mudou. */
export function ensureAchievementState(player) {
  if (!player) return false;
  let changed = false;
  if (!player.achStats || typeof player.achStats !== "object") { player.achStats = normalizeStats(null); changed = true; }
  if (!Array.isArray(player.achClaimed)) { player.achClaimed = []; changed = true; }
  if (!Array.isArray(player.achShowcase)) { player.achShowcase = []; changed = true; }
  return changed;
}

export function metricValue(player, metric) {
  if (metric === "cards") return Array.isArray(player?.ownedCards) ? new Set(player.ownedCards).size : 0;
  if (metric === "heroes") return Array.isArray(player?.ownedHeroes) ? new Set(player.ownedHeroes).size : 0;
  if (metric === "rank") return 0;
  return normalizeStats(player?.achStats)[metric] || 0;
}

/** Progresso de todas as conquistas: { id: { value, goal, done, claimed, locked } }. */
export function progressFor(player) {
  const claimed = new Set(normalizeClaimed(player?.achClaimed));
  const out = {};
  for (const a of ACHIEVEMENTS) {
    const value = a.locked ? 0 : metricValue(player, a.metric);
    out[a.id] = { value, goal: a.goal, done: !a.locked && value >= a.goal, claimed: claimed.has(a.id), locked: a.locked };
  }
  return out;
}

/** Quantas conquistas concluídas ainda não foram resgatadas. */
export function pendingClaims(player) {
  return Object.values(progressFor(player)).filter((p) => p.done && !p.claimed).length;
}

export function claimAchievement(player, id) {
  const a = getAchievement(id);
  if (!a) return { ok: false, error: "BAD_ID" };
  if (a.locked) return { ok: false, error: "LOCKED" };
  const claimed = normalizeClaimed(player?.achClaimed);
  if (claimed.includes(a.id)) return { ok: false, error: "ALREADY_CLAIMED" };
  if (metricValue(player, a.metric) < a.goal) return { ok: false, error: "NOT_REACHED" };
  return {
    ok: true,
    reward: { id: a.id, coins: a.coins },
    achClaimed: [...claimed, a.id],
    coins: Math.max(0, player.coins | 0) + a.coins,
  };
}

/** Vitrine do perfil: até 5 ids distintos, todos já resgatados. */
export function validateShowcase(ids, claimed) {
  if (!Array.isArray(ids)) return { ok: false, error: "BAD_SHOWCASE" };
  const owned = new Set(normalizeClaimed(claimed));
  const list = [...new Set(ids.map(String))];
  if (list.length > SHOWCASE_MAX) return { ok: false, error: "BAD_SHOWCASE" };
  if (list.some((id) => !owned.has(id))) return { ok: false, error: "NOT_CLAIMED" };
  return { ok: true, showcase: list };
}

const clampInt = (v, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, Math.trunc(n)));
};

/**
 * Fim de partida (todas as modalidades). Derrota (inclui abandono) zera a sequência.
 * @param {object} stats achStats atual
 * @param {{ matchType: string, outcome: "win"|"lose", myVp?: number, oppVp?: number, champKills?: number }} m
 */
export function applyMatchToStats(stats, m) {
  const s = normalizeStats(stats);
  const win = m?.outcome === "win";
  const isPvp = m?.matchType === "pvp";
  s.matches += 1;
  if (win && isPvp) s.pvpWins += 1;
  if (win && !isPvp) s.aiWins += 1;
  if (win) {
    s.streak += 1;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  } else {
    s.streak = 0;
  }
  const kills = clampInt(m?.champKills, MATCH_LIMITS.maxKills);
  if (kills) s.champKills += kills;
  const myVp = clampInt(m?.myVp, MATCH_LIMITS.maxVp);
  const oppVp = clampInt(m?.oppVp, MATCH_LIMITS.maxVp);
  if (win && myVp != null && oppVp != null && myVp - oppVp >= BIG_WIN_MARGIN) s.bigWins += 1;
  return s;
}

export function addCoinsSpent(stats, amount) {
  const s = normalizeStats(stats);
  const n = Math.max(0, Number(amount) | 0);
  s.coinsSpent += n;
  return s;
}

/** Retroativo (uma vez por conta): partidas e vitórias do histórico do servidor. */
export function applyBackfill(stats, counts) {
  const s = normalizeStats(stats);
  if (s.backfilled) return s;
  if (counts) {
    s.matches = Math.max(s.matches, Math.max(0, Number(counts.matches) | 0));
    s.aiWins = Math.max(s.aiWins, Math.max(0, Number(counts.aiWins) | 0));
    s.pvpWins = Math.max(s.pvpWins, Math.max(0, Number(counts.pvpWins) | 0));
  }
  s.backfilled = true;
  return s;
}

/** Payload público (cliente calcula a barra com o espelho dos dados). */
export function achievementsPublic(player) {
  const stats = normalizeStats(player?.achStats);
  const claimed = normalizeClaimed(player?.achClaimed);
  const showcase = (Array.isArray(player?.achShowcase) ? player.achShowcase.map(String) : [])
    .filter((id) => claimed.includes(id)).slice(0, SHOWCASE_MAX);
  return { achStats: stats, achClaimed: claimed, achShowcase: showcase, achPending: pendingClaims(player) };
}
