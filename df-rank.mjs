/**
 * Dragonfall — Rank por temporada (níveis). Autoridade: o servidor.
 * Progressão por NÍVEIS (decisão dela, 2026-11-25, projeto Perfil do
 * Jogador): divisões none < bronze < prata < ouro < diamante < platina
 * < desafiante < mítico, cada uma com 5 níveis. Vitória sobe 1 nível,
 * derrota desce 1; nível 5 + vitória = próxima divisão no nível 1;
 * nível 1 + derrota = divisão anterior no nível 5; bronze 1 + derrota
 * fica em bronze 1 (piso). O maior rank já alcançado (bestTier/bestLevel)
 * é guardado e nunca desce.
 *
 * Colocação (melhor de dez, OCULTA do jogador, vale para TODOS — inclusive
 * quem já joga): as 10 primeiras partidas ranqueadas da temporada contam
 * vitórias; enquanto placementDone=false o rank exibido é "sem rank".
 * Depois da 10ª, o rank inicial vem do mapa placementRank(). Quem já tinha
 * partidas ranqueadas antes desta versão faz a colocação nas PRÓXIMAS 10
 * partidas (não retroativo); os contadores da temporada não são zerados.
 *
 * O modelo ANTIGO (faixas por % de vitórias, MIN_MATCHES para exibir o
 * tier) foi SUBSTITUÍDO: a % não dita mais o rank. O MMR continua onde
 * sempre esteve (df-ranked-store.mjs) e NÃO dita pareamento nem
 * progressão — o código dele fica dormente, sem ser apagado.
 * Reaproveitado do sistema antigo: tabelas df_rank_players/df_rank_meta,
 * registro de temporada (season/matches/wins/losses/bestTier/pending),
 * endpoints GET /auth/rank e POST /auth/rank/claim e o Top 200 (por
 * vitórias da temporada). Postgres quando disponível; JSON local como
 * fallback.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPgPool, isPostgresEnabled } from "./df-postgres.mjs";
import { logMp } from "./df-mp-metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.DF_RANK_DATA_PATH || path.join(HERE, "data", "rank.json");
const SEASON_CONFIG_PATH = process.env.DF_RANK_SEASON_CONFIG || path.join(HERE, "df-rank-season.json");

/** Mínimo de partidas da temporada para entrar no Top 200 (não limita mais o rank exibido). */
export const MIN_MATCHES = 15;
export const TOP_SIZE = 200;
export const TOP_COINS = 50;
/** Níveis por divisão (decisão dela: 5 níveis, nunca "estrelas"). */
export const LEVELS_PER_TIER = 5;
/** Partidas da colocação (melhor de dez). */
export const PLACEMENT_MATCHES = 10;
/** Divisões em ordem crescente; índice 0 = sem rank. */
export const TIER_IDS = Object.freeze(["none", "bronze", "prata", "ouro", "diamante", "platina", "desafiante", "mitico"]);
/** Moedas de fim de temporada por divisão (mesmos valores do modelo antigo). */
export const RANK_TIERS = Object.freeze([
  { id: "bronze", coins: 10 },
  { id: "prata", coins: 20 },
  { id: "ouro", coins: 30 },
  { id: "diamante", coins: 40 },
  { id: "platina", coins: 50 },
  { id: "desafiante", coins: 60 },
  { id: "mitico", coins: 70 },
].map((t) => Object.freeze(t)));

/** Chaves de partida já contadas ficam guardadas por 2 dias (reinício do servidor no meio da partida). */
const RECORDED_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const TICK_MS = 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS df_rank_players (
  player_id VARCHAR(64) PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS df_rank_meta (
  key VARCHAR(32) PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/* ================= Regras puras ================= */

/** Índice da divisão (0 = none .. 7 = mítico). Desconhecido vira 0. */
export function tierIndex(tier) {
  if (typeof tier === "number") return Math.min(TIER_IDS.length - 1, Math.max(0, tier | 0));
  const i = TIER_IDS.indexOf(String(tier || ""));
  return i >= 0 ? i : 0;
}

/** Índice numérico (0..7, compatível com o modelo antigo e com as conquistas) → id da divisão. null = sem valor. */
export function tierId(tier) {
  if (tier == null) return null;
  return TIER_IDS[tierIndex(tier)] || null;
}

function clampLevel(v) {
  return Math.min(LEVELS_PER_TIER, Math.max(1, Number(v) | 0 || 1));
}

/**
 * Mapa da colocação (decisão dela, 2026-11-25 — interpolação linear
 * entre os pontos que ela deu: 10 vitórias = prata 5; 3 = bronze 3;
 * 5 = bronze 5; 6 = prata 1).
 *   0-1 vitórias = bronze 1; 2 = bronze 2; 3 = bronze 3; 4 = bronze 4;
 *   5 = bronze 5; 6 = prata 1; 7 = prata 2; 8 = prata 3; 9 = prata 4;
 *   10 = prata 5.
 */
export function placementRank(wins) {
  const w = Math.min(PLACEMENT_MATCHES, Math.max(0, Number(wins) | 0));
  const table = [
    ["bronze", 1], ["bronze", 1], ["bronze", 2], ["bronze", 3], ["bronze", 4], ["bronze", 5],
    ["prata", 1], ["prata", 2], ["prata", 3], ["prata", 4], ["prata", 5],
  ];
  const [tier, level] = table[w];
  return { tier, level };
}

/**
 * Um passo de progressão por NÍVEIS. outcome = "win" | "loss" | "tie".
 * Empate não move o rank. "none" não anda (só a colocação define o rank).
 * Mítico 5 + vitória fica no topo; bronze 1 + derrota fica no piso.
 */
export function stepLevel(tier, level, outcome) {
  let t = tierIndex(tier);
  let l = clampLevel(level);
  if (t === 0) return { tier: "none", level: 1 };
  if (outcome === "win") {
    if (l < LEVELS_PER_TIER) l += 1;
    else if (t < TIER_IDS.length - 1) { t += 1; l = 1; }
  } else if (outcome === "loss") {
    if (l > 1) l -= 1;
    else if (t > 1) { t -= 1; l = LEVELS_PER_TIER; }
  }
  return { tier: TIER_IDS[t], level: l };
}

/** Compara dois ranks ({tier, level}): -1 (a < b), 0 (iguais), 1 (a > b). */
export function compareRank(a, b) {
  const ta = tierIndex(a?.tier);
  const tb = tierIndex(b?.tier);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const la = clampLevel(a?.level);
  const lb = clampLevel(b?.level);
  if (la === lb) return 0;
  return la < lb ? -1 : 1;
}

/** % de vitórias para exibição (arredondada para baixo). */
export function winPct(wins, matches) {
  const m = Math.max(0, matches | 0);
  return m ? Math.floor((Math.max(0, wins | 0) * 100) / m) : 0;
}

/** Ordem do Top: vitórias, depois % de vitórias, depois quem chegou primeiro. */
export function compareTop(a, b) {
  if (b.wins !== a.wins) return b.wins - a.wins;
  const byPct = b.wins * a.matches - a.wins * b.matches;
  if (byPct !== 0) return byPct;
  if ((a.reachedAt || 0) !== (b.reachedAt || 0)) return (a.reachedAt || 0) - (b.reachedAt || 0);
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

/* ================= Estado ================= */

const players = new Map();
let meta = normalizeMeta(null);
let mode = "memory";
let loaded = false;
let seasonCfgOverride = null;
let topCache = null;
let tickTimer = null;
let jsonTimer = null;
let displayResolver = null;
const pgChains = new Map();

function nonNeg(v) {
  return Math.max(0, Number(v) | 0);
}

function normalizeDisplay(d) {
  if (!d || typeof d !== "object") return null;
  return {
    name: d.name ? String(d.name).slice(0, 32) : null,
    avatarHeroId: d.avatarHeroId ? String(d.avatarHeroId).slice(0, 40) : null,
    level: Math.max(1, Number(d.level) | 0),
  };
}

function normalizePending(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p === "object").map((p) => ({
    season: nonNeg(p.season),
    // tier histórico: número no modelo antigo, id no modelo de níveis.
    tier: p.tier == null ? null : p.tier,
    level: p.level == null ? null : clampLevel(p.level),
    pos: p.pos == null ? null : nonNeg(p.pos),
    matches: nonNeg(p.matches),
    wins: nonNeg(p.wins),
    rankCoins: nonNeg(p.rankCoins),
    topCoins: nonNeg(p.topCoins),
  }));
}

function normalizeRecord(id, raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  // Maior rank já alcançado: aceita o formato novo (string) e o antigo
  // (número 0..7, mesma ordem de divisões) — nunca desce.
  let bestTier = "none";
  let bestLevel = 1;
  if (typeof r.bestTier === "string" && TIER_IDS.includes(r.bestTier)) {
    bestTier = r.bestTier;
    bestLevel = clampLevel(r.bestLevel);
  } else if (typeof r.bestTier === "number") {
    bestTier = tierId(r.bestTier) || "none";
    bestLevel = 1;
  }
  // Rank atual: só vale depois da colocação. Registros do modelo antigo
  // (sem tier/placement) recomeçam a colocação nas próximas 10 partidas.
  let tier = "none";
  let level = 1;
  if (typeof r.tier === "string" && TIER_IDS.includes(r.tier)) {
    tier = r.tier;
    level = clampLevel(r.level);
  }
  let placementDone = !!r.placementDone;
  let placementWins = Math.min(nonNeg(r.placementWins), PLACEMENT_MATCHES);
  let placementMatches = Math.min(nonNeg(r.placementMatches), PLACEMENT_MATCHES);
  if (placementDone && tier === "none") {
    placementDone = false;
    placementWins = 0;
    placementMatches = 0;
  }
  if (!placementDone) {
    tier = "none";
    level = 1;
  }
  return {
    id: String(id),
    season: nonNeg(r.season) || meta.season,
    matches: nonNeg(r.matches),
    wins: nonNeg(r.wins),
    losses: nonNeg(r.losses),
    ties: nonNeg(r.ties),
    reachedAt: Math.max(0, Number(r.reachedAt) || 0),
    totalMatches: nonNeg(r.totalMatches),
    totalWins: nonNeg(r.totalWins),
    tier,
    level,
    bestTier,
    bestLevel,
    placementDone,
    placementWins,
    placementMatches,
    display: normalizeDisplay(r.display),
    pending: normalizePending(r.pending),
  };
}

function normalizeMeta(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  const recorded = {};
  if (m.recorded && typeof m.recorded === "object") {
    for (const [k, v] of Object.entries(m.recorded)) recorded[String(k)] = Number(v) || 0;
  }
  return {
    season: nonNeg(m.season) || 1,
    startedAt: Math.max(0, Number(m.startedAt) || 0),
    closed: Array.isArray(m.closed) ? m.closed.filter((c) => c && typeof c === "object") : [],
    recorded,
  };
}

/* ================= Persistência ================= */

function loadJson() {
  players.clear();
  meta = normalizeMeta(null);
  try {
    if (fs.existsSync(DATA_PATH)) {
      const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8").replace(/^\uFEFF/, ""));
      meta = normalizeMeta(data.meta);
      for (const [id, rec] of Object.entries(data.players || {})) players.set(id, normalizeRecord(id, rec));
    }
  } catch (e) {
    logMp("rank_json_load_err", { error: e?.message || String(e) });
  }
}

function writeJsonNow() {
  if (jsonTimer) { clearTimeout(jsonTimer); jsonTimer = null; }
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    const out = { meta, players: Object.fromEntries(players) };
    fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 2), "utf8");
  } catch (e) {
    logMp("rank_json_save_err", { error: e?.message || String(e) });
  }
}

function scheduleJsonSave() {
  if (jsonTimer) return;
  jsonTimer = setTimeout(writeJsonNow, 300);
  jsonTimer.unref?.();
}

function pgQueue(key, sql, params) {
  const pool = getPgPool();
  if (!pool) return;
  const prev = pgChains.get(key) || Promise.resolve();
  const next = prev
    .then(() => pool.query(sql, params))
    .catch((e) => logMp("rank_pg_save_err", { key, error: e?.message || String(e) }));
  pgChains.set(key, next);
  void next.finally(() => { if (pgChains.get(key) === next) pgChains.delete(key); });
}

function savePlayer(rec) {
  if (mode === "postgres") {
    pgQueue(`p:${rec.id}`,
      `INSERT INTO df_rank_players (player_id, data, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (player_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [rec.id, JSON.stringify(rec)]);
  } else if (mode === "json") {
    scheduleJsonSave();
  }
}

function saveMeta() {
  if (mode === "postgres") {
    pgQueue("meta",
      `INSERT INTO df_rank_meta (key, data, updated_at) VALUES ('season', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify(meta)]);
  } else if (mode === "json") {
    scheduleJsonSave();
  }
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  mode = "json";
  loadJson();
  if (!meta.startedAt) { meta.startedAt = Date.now(); saveMeta(); }
}

export async function initRankStore() {
  const pool = getPgPool();
  loaded = false;
  if (pool && isPostgresEnabled()) {
    try {
      await pool.query(SCHEMA);
      const m = await pool.query("SELECT data FROM df_rank_meta WHERE key = 'season'");
      meta = normalizeMeta(m.rows[0]?.data);
      const rows = await pool.query("SELECT player_id, data FROM df_rank_players");
      players.clear();
      for (const r of rows.rows) players.set(r.player_id, normalizeRecord(r.player_id, r.data));
      mode = "postgres";
      loaded = true;
      if (!meta.startedAt) { meta.startedAt = Date.now(); saveMeta(); }
    } catch (e) {
      logMp("rank_pg_init_err", { error: e?.message || String(e) });
    }
  }
  ensureLoaded();
  topCache = null;
  tickSeason();
  if (!tickTimer) {
    tickTimer = setInterval(() => { try { tickSeason(); } catch (e) { /* */ } }, TICK_MS);
    tickTimer.unref?.();
  }
  logMp("rank_store", { mode, players: players.size, season: meta.season });
  return { mode, players: players.size, season: meta.season };
}

export function rankStoreMode() {
  return mode;
}

/** Grava pendências (JSON) imediatamente — testes e desligamento. */
export function flushRankStore() {
  if (mode === "json") writeJsonNow();
}

/* ================= Temporada ================= */

function readSeasonConfig() {
  if (seasonCfgOverride) return seasonCfgOverride;
  try {
    const raw = fs.readFileSync(SEASON_CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    return Array.isArray(data?.seasons) ? data.seasons : [];
  } catch (e) {
    return [];
  }
}

/** Só testes: substitui o arquivo df-rank-season.json. */
export function configureSeasonsForTests(seasons) {
  seasonCfgOverride = Array.isArray(seasons) ? seasons : null;
}

function endsAtFor(season) {
  const entry = readSeasonConfig().find((s) => Number(s?.id) === season);
  if (!entry?.endsAt) return null;
  const t = Date.parse(entry.endsAt);
  return Number.isFinite(t) ? t : null;
}

/** Início declarado da temporada (df-rank-season.json; null quando ausente). */
function startsAtFor(season) {
  const entry = readSeasonConfig().find((s) => Number(s?.id) === season);
  return typeof entry?.startsAt === "string" && entry.startsAt ? entry.startsAt : null;
}

export function seasonPublic(now = Date.now()) {
  ensureLoaded();
  return { id: meta.season, startedAt: meta.startedAt || null, startsAt: startsAtFor(meta.season), endsAt: endsAtFor(meta.season), now };
}

function rollSeason(rec) {
  if (rec.season === meta.season) return;
  rec.season = meta.season;
  rec.matches = 0;
  rec.wins = 0;
  rec.losses = 0;
  rec.ties = 0;
  rec.reachedAt = 0;
  // Temporada nova = colocação nova; o MAIOR rank (best) nunca desce.
  rec.tier = "none";
  rec.level = 1;
  rec.placementDone = false;
  rec.placementWins = 0;
  rec.placementMatches = 0;
}

function qualifiedSorted() {
  if (topCache && topCache.season === meta.season) return topCache.list;
  const list = [...players.values()]
    .filter((r) => r.season === meta.season && r.matches >= MIN_MATCHES)
    .sort(compareTop);
  topCache = { season: meta.season, list };
  return list;
}

/** Fecha a temporada: Moedas de Rank + Top 200 viram pendência de resgate; estatísticas zeram. */
function closeSeason(season, now) {
  const ranked = qualifiedSorted();
  const posById = new Map(ranked.map((r, i) => [r.id, i + 1]));
  let rewarded = 0;
  for (const rec of players.values()) {
    if (rec.season !== season) continue;
    const pos = posById.get(rec.id) || null;
    const rankCoins = rec.tier !== "none" ? (RANK_TIERS[tierIndex(rec.tier) - 1]?.coins || 0) : 0;
    const topCoins = pos && pos <= TOP_SIZE ? TOP_COINS : 0;
    if (rankCoins + topCoins > 0) {
      rec.pending.push({ season, tier: rec.tier, level: rec.level, pos, matches: rec.matches, wins: rec.wins, rankCoins, topCoins });
      rewarded++;
    }
    rec.season = season + 1;
    rec.matches = 0;
    rec.wins = 0;
    rec.losses = 0;
    rec.ties = 0;
    rec.reachedAt = 0;
    rec.tier = "none";
    rec.level = 1;
    rec.placementDone = false;
    rec.placementWins = 0;
    rec.placementMatches = 0;
    savePlayer(rec);
  }
  meta.closed.push({ season, at: now, rewarded });
  meta.season = season + 1;
  meta.startedAt = now;
  saveMeta();
  topCache = null;
  logMp("rank_season_closed", { season, rewarded });
}

export function tickSeason(now = Date.now()) {
  ensureLoaded();
  for (let guard = 0; guard < 24; guard++) {
    const end = endsAtFor(meta.season);
    if (end == null || now < end) break;
    closeSeason(meta.season, now);
  }
}

/* ================= Registro de partidas ================= */

/** Resolve conta → exibição ({ name, avatarHeroId, level }) ou null se não for conta. */
export function setRankDisplayResolver(fn) {
  displayResolver = typeof fn === "function" ? fn : null;
}

/** Marca a partida como contada (idempotente). false = já contada antes. */
export function claimMatchKey(key, now = Date.now()) {
  ensureLoaded();
  const k = String(key || "");
  if (!k) return false;
  if (meta.recorded[k]) return false;
  for (const [old, at] of Object.entries(meta.recorded)) {
    if (now - at > RECORDED_TTL_MS) delete meta.recorded[old];
  }
  meta.recorded[k] = now;
  saveMeta();
  return true;
}

/** Soma uma partida à temporada da conta: outcome = "win" | "loss" | "tie". */
export function recordOutcome(id, outcome, { now = Date.now(), display = null } = {}) {
  ensureLoaded();
  tickSeason(now);
  if (!id || !["win", "loss", "tie"].includes(outcome)) return null;
  const key = String(id);
  const rec = players.get(key) || normalizeRecord(key, null);
  rollSeason(rec);
  rec.matches += 1;
  rec.totalMatches += 1;
  if (outcome === "win") {
    rec.wins += 1;
    rec.totalWins += 1;
    rec.reachedAt = now;
  } else if (outcome === "loss") {
    rec.losses += 1;
  } else {
    rec.ties += 1;
  }
  if (!rec.placementDone) {
    // Colocação: as 10 primeiras partidas ranqueadas da temporada.
    rec.placementMatches += 1;
    if (outcome === "win") rec.placementWins += 1;
    if (rec.placementMatches >= PLACEMENT_MATCHES) {
      rec.placementDone = true;
      const start = placementRank(rec.placementWins);
      rec.tier = start.tier;
      rec.level = start.level;
    }
  } else {
    const next = stepLevel(rec.tier, rec.level, outcome);
    rec.tier = next.tier;
    rec.level = next.level;
  }
  const disp = normalizeDisplay(display);
  if (disp) rec.display = disp;
  // O maior rank nunca desce.
  if (compareRank({ tier: rec.tier, level: rec.level }, { tier: rec.bestTier, level: rec.bestLevel }) > 0) {
    rec.bestTier = rec.tier;
    rec.bestLevel = rec.level;
  }
  players.set(key, rec);
  topCache = null;
  savePlayer(rec);
  return rankPublic(key, now);
}

/**
 * Fim de uma partida rankeada (ou abandono): conta uma vez por partida e só para contas reais.
 * @param {string} matchKey chave única da partida
 * @param {{ id: string|null, outcome: "win"|"loss"|"tie" }[]} entries
 */
export async function recordRankedSeasonMatch(matchKey, entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e?.id);
  if (list.length === 2 && list[0].id === list[1].id) return [];
  if (!list.length || !claimMatchKey(matchKey)) return [];
  const out = [];
  for (const e of list) {
    let display = null;
    try {
      display = displayResolver ? await displayResolver(String(e.id)) : null;
    } catch (err) {
      display = null;
    }
    if (!display) continue;
    const r = recordOutcome(String(e.id), e.outcome, { display });
    if (r) out.push({ id: String(e.id), rank: r });
  }
  return out;
}

/** Atualiza nome/avatar/nível exibidos no Top (só para quem já tem registro). */
export function touchRankDisplay(id, display) {
  ensureLoaded();
  const rec = players.get(String(id || ""));
  const disp = normalizeDisplay(display);
  if (!rec || !disp) return;
  const cur = rec.display || {};
  if (cur.name === disp.name && cur.avatarHeroId === disp.avatarHeroId && cur.level === disp.level) return;
  rec.display = disp;
  savePlayer(rec);
}

/* ================= Leitura ================= */

export function positionOf(id) {
  const i = qualifiedSorted().findIndex((r) => r.id === String(id));
  return i >= 0 ? i + 1 : null;
}

/** Melhor divisão já alcançada, como número 0..7 (Medalhas das Conquistas — df-achievements.mjs lê número). */
export function bestTierOf(id) {
  ensureLoaded();
  return tierIndex(players.get(String(id || ""))?.bestTier || "none");
}

export function rankPublic(id, now = Date.now()) {
  ensureLoaded();
  tickSeason(now);
  const rec = players.get(String(id || ""));
  const cur = rec && rec.season === meta.season ? rec : null;
  const matches = cur?.matches || 0;
  const wins = cur?.wins || 0;
  const tier = cur?.tier || "none";
  const level = cur?.level || 1;
  const pending = rec ? rec.pending.map((p) => ({ ...p })) : [];
  return {
    season: meta.season,
    startsAt: startsAtFor(meta.season),
    endsAt: endsAtFor(meta.season),
    minMatches: MIN_MATCHES,
    // aliases que a Frente 3 (visita ao perfil) já lê:
    matches,
    wins,
    losses: cur?.losses || 0,
    ties: cur?.ties || 0,
    // contrato do /auth/me (projeto Perfil do Jogador):
    seasonMatches: matches,
    seasonWins: wins,
    seasonLosses: cur?.losses || 0,
    winPct: winPct(wins, matches),
    tier,
    tierId: tier,
    level,
    bestTier: rec?.bestTier || "none",
    bestLevel: rec?.bestLevel || 1,
    placementDone: cur ? !!cur.placementDone : false,
    placementWins: cur?.placementWins || 0,
    pos: tier === "none" ? null : positionOf(id),
    totalMatches: rec?.totalMatches || 0,
    totalWins: rec?.totalWins || 0,
    totalPct: winPct(rec?.totalWins || 0, rec?.totalMatches || 0),
    pending,
    pendingCoins: pending.reduce((s, p) => s + p.rankCoins + p.topCoins, 0),
  };
}

/** Top 200 da temporada (sem ids de conta). */
export function topPublic(limit = TOP_SIZE, now = Date.now()) {
  ensureLoaded();
  tickSeason(now);
  return qualifiedSorted().slice(0, Math.max(0, limit | 0)).map((r, i) => ({
    pos: i + 1,
    name: r.display?.name || null,
    avatarHeroId: r.display?.avatarHeroId || null,
    level: r.display?.level || 1,
    wins: r.wins,
    matches: r.matches,
    winPct: winPct(r.wins, r.matches),
    tier: r.tier,
    tierId: r.tier,
    level: r.level,
    bestTier: r.bestTier,
    bestLevel: r.bestLevel,
  }));
}

/* ================= Resgate ================= */

/** Retira as recompensas pendentes (o chamador credita as Moedas ou devolve com restorePending). */
export function takePending(id) {
  ensureLoaded();
  const rec = players.get(String(id || ""));
  if (!rec || !rec.pending.length) return { list: [], coins: 0 };
  const list = rec.pending;
  rec.pending = [];
  savePlayer(rec);
  return { list, coins: list.reduce((s, p) => s + p.rankCoins + p.topCoins, 0) };
}

export function restorePending(id, list) {
  const rec = players.get(String(id || ""));
  if (!rec || !Array.isArray(list) || !list.length) return;
  rec.pending = normalizePending(list).concat(rec.pending);
  savePlayer(rec);
}

/** Só testes: estado vazio em memória/JSON. */
export function resetRankStoreForTests() {
  players.clear();
  meta = normalizeMeta(null);
  meta.startedAt = Date.now();
  topCache = null;
  mode = "json";
  loaded = true;
}
