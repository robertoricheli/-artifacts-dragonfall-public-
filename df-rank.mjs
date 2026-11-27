/**
 * Dragonfall — Rank por temporada (níveis). Autoridade: o servidor.
 * Progressão por NÍVEIS (decisão dela, 2026-11-25, projeto Perfil do
 * Jogador): divisões none < bronze < prata < ouro < diamante < platina
 * < desafiante < mítico, cada uma com 5 níveis — EXCETO o mítico, que
 * tem nível 0 e ESTRELAS (1.51.105, decisão dele 2026-11-27). Vitória
 * sobe 1 nível, derrota desce 1; nível 5 + vitória = próxima divisão
 * no nível 1; nível 1 + derrota = divisão anterior no nível 5; bronze 1
 * + derrota fica em bronze 1 (piso). O maior rank já alcançado
 * (bestTier/bestLevel/bestStars) é guardado e nunca desce.
 *
 * Colocação (melhor de dez, OCULTA do jogador, vale para TODOS — inclusive
 * quem já joga): as 10 primeiras partidas ranqueadas da temporada contam
 * vitórias E derrotas; enquanto placementDone=false o rank exibido é
 * "sem rank". Depois da 10ª, o rank inicial vem da CONTA NOVA (1.51.105):
 * nível = 2×vitórias − derrotas na escada bronze 1–5 … diamante 1–5
 * (piso bronze 1; 1V = bronze 2; 2V = bronze 4; 2V+1D = bronze 3;
 * 10V = diamante 5). Quem JÁ terminou a MD10 mantém o rank que já tem
 * (não se recalcula o passado); a conta nova vale para a MD10 em
 * andamento e para as que começarem depois. Depois da MD10, vitória +1
 * / derrota −1 como antes.
 *
 * ESTRELAS SÓ NO MÍTICO: chegar no mítico = mítico zero estrelas (não
 * existe mítico 1–5); cada vitória +1 estrela, cada derrota −1 estrela,
 * piso 0 estrelas — sem rebaixamento do mítico (a derrota com 0 estrelas
 * mantém o jogador no mítico com 0). Quem não está no mítico não tem
 * estrela (null). Migração: registro antigo com mítico nível 1–5 vira
 * mítico (nível−1) estrelas, preservando a ordem.
 *
 * ORDEM DA MD10: o servidor passa a guardar o resultado de cada partida
 * da colocação EM ORDEM (placementResults: ["W","L",null ×10]; empate
 * ocupa a vaga com null). Registros anteriores à 1.51.105 só têm os
 * contadores — a ordem é reconstruída do histórico de partidas
 * (df_matches: ranqueada ou casual, nunca com amigo, da temporada atual,
 * da mais antiga para a mais recente) por ensurePlacementResults(), e só
 * é adotada quando a quantidade bate com placementMatches E as vitórias
 * batem com placementWins; senão o fallback são as vagas null (a ordem
 * desconhecida nunca é inventada) e o provisório continua sendo calculado
 * pelos contadores.
 *
 * Top 200: só entra quem já terminou a MD10 (placementDone) — a trava
 * antiga de 15 partidas (MIN_MATCHES) NÃO vale mais para entrar na
 * lista. Ordenação por RANK (mítico no topo, mais estrelas mais alto,
 * depois desafiante 5 até bronze 1); desempate no mesmo rank/nível:
 * mais vitórias na temporada, depois % de vitórias, depois quem chegou
 * primeiro (reachedAt), depois id. Top por país usa o país guardado na
 * conta (display.country); sem geolocalização no servidor.
 *
 * Recompensas (1.51.105, SÓ EXIBIÇÃO — "o que ganharia se a temporada
 * terminasse agora"): bronze 10, prata 15, ouro 20, diamante 25, platina
 * 30, desafiante 35, mítico moldura nova + 40 moedas; 4º–200º por
 * estrelas moldura nova + 50; 3º moldura nova + 5 diamantes + 60;
 * 2º moldura nova + 10 diamantes + 70; 1º moldura nova + 20 diamantes
 * + 80. A "moldura nova" se chama MOLDURA MÍTICA (resposta dele
 * 2026-11-27 13:57; arquivo MOLDURA_M_TICA.png) — o servidor só sinaliza
 * frame:true; a imagem vive no cliente. O pagamento de verdade no fim
 * da temporada NÃO está nesta versão: o mecanismo antigo de pendência
 * (takePending/closeSeason) continua existindo, agora com os valores
 * novos de RANK_TIERS, mas a diferenciação por posição do Top
 * (3º/2º/1º), os diamantes e as molduras ainda não são pagos por ele.
 *
 * O modelo ANTIGO (faixas por % de vitórias, MIN_MATCHES para exibir o
 * tier) foi SUBSTITUÍDO: a % não dita mais o rank. O MMR continua onde
 * sempre esteve (df-ranked-store.mjs) e NÃO dita pareamento nem
 * progressão — o código dele fica dormente, sem ser apagado.
 * Reaproveitado do sistema antigo: tabelas df_rank_players/df_rank_meta,
 * registro de temporada (season/matches/wins/losses/bestTier/pending),
 * endpoints GET /auth/rank e POST /auth/rank/claim e o Top 200.
 * Postgres quando disponível; JSON local como fallback.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPgPool, isPostgresEnabled } from "./df-postgres.mjs";
import { logMp } from "./df-mp-metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.DF_RANK_DATA_PATH || path.join(HERE, "data", "rank.json");
const SEASON_CONFIG_PATH = process.env.DF_RANK_SEASON_CONFIG || path.join(HERE, "df-rank-season.json");

/** Mínimo de partidas da temporada — 1.51.105: NÃO limita mais a entrada
 *  no Top 200 (só placementDone limita). Mantido por compatibilidade. */
export const MIN_MATCHES = 15;
export const TOP_SIZE = 200;
export const TOP_COINS = 50;
/** Níveis por divisão (decisão dela: 5 níveis, nunca "estrelas" — exceto
 *  no mítico, que tem nível 0 e estrelas, decisão dele 2026-11-27). */
export const LEVELS_PER_TIER = 5;
/** Partidas da colocação (melhor de dez). */
export const PLACEMENT_MATCHES = 10;
/** Divisões em ordem crescente; índice 0 = sem rank. */
export const TIER_IDS = Object.freeze(["none", "bronze", "prata", "ouro", "diamante", "platina", "desafiante", "mitico"]);
/** Rótulos em português das divisões (tela de Recompensas). */
export const TIER_LABELS = Object.freeze({
  bronze: "Bronze",
  prata: "Prata",
  ouro: "Ouro",
  diamante: "Diamante",
  platina: "Platina",
  desafiante: "Desafiante",
  mitico: "Mítico",
});
/**
 * Moedas de fim de temporada por divisão (1.51.105 — SUBSTITUEM os valores
 * antigos bronze 10 → mítico 70). `frame` = moldura nova de recompensa
 * (só o mítico entre as divisões). `diamonds` = 0 nas divisões.
 */
export const RANK_TIERS = Object.freeze([
  { id: "bronze", coins: 10, diamonds: 0, frame: false },
  { id: "prata", coins: 15, diamonds: 0, frame: false },
  { id: "ouro", coins: 20, diamonds: 0, frame: false },
  { id: "diamante", coins: 25, diamonds: 0, frame: false },
  { id: "platina", coins: 30, diamonds: 0, frame: false },
  { id: "desafiante", coins: 35, diamonds: 0, frame: false },
  { id: "mitico", coins: 40, diamonds: 0, frame: true },
].map((t) => Object.freeze(t)));
/**
 * Recompensas por posição no Top 200 (1.51.105 — SÓ EXIBIÇÃO nesta versão;
 * o pagamento de verdade no fim da temporada não entra aqui).
 */
export const TOP_POSITION_REWARDS = Object.freeze([
  { label: "Top 200 (4º–200º)", tier: "top200", coins: 50, diamonds: 0, frame: true },
  { label: "3º lugar", tier: "top3", coins: 60, diamonds: 5, frame: true },
  { label: "2º lugar", tier: "top2", coins: 70, diamonds: 10, frame: true },
  { label: "1º lugar", tier: "top1", coins: 80, diamonds: 20, frame: true },
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

/** Nível dentro da divisão; o mítico tem nível 0 (não 1–5). */
function clampLevelForTier(tier, v) {
  return tier === "mitico" ? 0 : clampLevel(v);
}

/**
 * Mapa da colocação — CONTA NOVA (decisão dele, 2026-11-27, 1.51.105):
 * nível = 2×vitórias − derrotas na escada bronze 1–5, prata 1–5,
 * ouro 1–5, diamante 1–5, platina 1–5, desafiante 1–5, mítico 0;
 * piso bronze 1. Exemplos dele: 1V = bronze 2; 2V = bronze 4;
 * 2V+1D = bronze 3; 10V sem derrota = diamante 5. Com 10 partidas o
 * máximo é 20 (diamante 5) — a colocação nunca chega ao mítico.
 * placementRank(wins) sem derrotas mantém o comportamento antigo de
 * 1 argumento (só vitórias).
 */
export function placementRank(wins, losses = 0) {
  const w = Math.min(PLACEMENT_MATCHES, Math.max(0, Number(wins) | 0));
  const l = Math.min(PLACEMENT_MATCHES, Math.max(0, Number(losses) | 0));
  const score = Math.max(1, Math.min(20, 2 * w - l));
  const tier = TIER_IDS[Math.ceil(score / LEVELS_PER_TIER)];
  const level = ((score - 1) % LEVELS_PER_TIER) + 1;
  return { tier, level };
}

/**
 * Um passo de progressão por NÍVEIS. outcome = "win" | "loss" | "tie".
 * Empate não move o rank. "none" não anda (só a colocação define o rank).
 * Devolve { tier, level, stars } — stars é null fora do mítico.
 * MÍTICO (1.51.105): nível sempre 0; vitória +1 estrela, derrota
 * −1 estrela com piso 0, SEM rebaixamento do mítico. Chegar no mítico
 * (desafiante 5 + vitória) = mítico zero estrelas.
 */
export function stepLevel(tier, level, outcome, stars = 0) {
  let t = tierIndex(tier);
  if (t === 0) return { tier: "none", level: 1, stars: null };
  if (TIER_IDS[t] === "mitico") {
    let s = Math.max(0, Number(stars) | 0 || 0);
    if (outcome === "win") s += 1;
    else if (outcome === "loss") s = Math.max(0, s - 1);
    return { tier: "mitico", level: 0, stars: s };
  }
  let l = clampLevel(level);
  if (outcome === "win") {
    if (l < LEVELS_PER_TIER) l += 1;
    else if (t < TIER_IDS.length - 1) {
      t += 1;
      if (TIER_IDS[t] === "mitico") return { tier: "mitico", level: 0, stars: 0 };
      l = 1;
    }
  } else if (outcome === "loss") {
    if (l > 1) l -= 1;
    else if (t > 1) { t -= 1; l = LEVELS_PER_TIER; }
  }
  return { tier: TIER_IDS[t], level: l, stars: null };
}

/** Compara dois ranks ({tier, level, stars}): -1 (a < b), 0 (iguais), 1 (a > b). No mítico comparam-se as estrelas, não o nível. */
export function compareRank(a, b) {
  const ta = tierIndex(a?.tier);
  const tb = tierIndex(b?.tier);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (TIER_IDS[ta] === "mitico") {
    const sa = Math.max(0, Number(a?.stars) | 0 || 0);
    const sb = Math.max(0, Number(b?.stars) | 0 || 0);
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }
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

/**
 * Ordem do Top (1.51.105): RANK primeiro — mítico no topo (mais
 * estrelas mais alto), depois desafiante 5 até bronze 1. Desempate no
 * mesmo rank/nível: mais vitórias na temporada, depois % de vitórias,
 * depois quem chegou primeiro (reachedAt), depois id.
 */
export function compareTop(a, b) {
  const byRank = compareRank(
    { tier: a.tier, level: a.level, stars: a.stars },
    { tier: b.tier, level: b.level, stars: b.stars },
  );
  if (byRank !== 0) return -byRank;
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
    // País guardado na conta (ISO alpha-3, maiúsculo); o Top por país
    // filtra por ele. null = jogador sem país definido.
    country: typeof d.country === "string" && d.country
      ? String(d.country).toUpperCase().slice(0, 3)
      : null,
  };
}

/**
 * Resultados da colocação EM ORDEM: array de até 10 entradas "W" | "L"
 * | null (null = empate ou vaga futura). Qualquer outro valor vira null.
 * null = registro anterior à 1.51.105 (só contadores, sem ordem).
 */
function normalizePlacementResults(r) {
  if (!Array.isArray(r?.placementResults)) return null;
  return r.placementResults
    .slice(0, PLACEMENT_MATCHES)
    .map((v) => (v === "W" || v === "L" ? v : null));
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
  let bestStars = null;
  if (typeof r.bestTier === "string" && TIER_IDS.includes(r.bestTier)) {
    bestTier = r.bestTier;
    bestLevel = clampLevelForTier(bestTier, r.bestLevel);
    if (bestTier === "mitico") {
      // Migração 1.51.105: mítico nível 1–5 antigo vira (nível−1) estrelas.
      bestStars = typeof r.bestStars === "number"
        ? Math.max(0, r.bestStars | 0)
        : (typeof r.bestLevel === "number" && r.bestLevel >= 1 && r.bestLevel <= 5
          ? (r.bestLevel | 0) - 1
          : 0);
    }
  } else if (typeof r.bestTier === "number") {
    bestTier = tierId(r.bestTier) || "none";
    bestLevel = bestTier === "mitico" ? 0 : 1;
    if (bestTier === "mitico") bestStars = 0;
  }
  // Rank atual: só vale depois da colocação. Registros do modelo antigo
  // (sem tier/placement) recomeçam a colocação nas próximas 10 partidas.
  let tier = "none";
  let level = 1;
  let stars = null;
  if (typeof r.tier === "string" && TIER_IDS.includes(r.tier)) {
    tier = r.tier;
    level = clampLevelForTier(tier, r.level);
    if (tier === "mitico") {
      // Migração 1.51.105: mítico nível 1–5 antigo vira (nível−1) estrelas.
      stars = typeof r.stars === "number"
        ? Math.max(0, r.stars | 0)
        : (typeof r.level === "number" && r.level >= 1 && r.level <= 5
          ? (r.level | 0) - 1
          : 0);
    }
  }
  let placementDone = !!r.placementDone;
  // A lista de resultados (1.51.105) é a fonte da verdade dos contadores
  // quando existe; sem ela valem os contadores antigos.
  let placementResults = normalizePlacementResults(r);
  let placementWins;
  let placementMatches;
  if (placementResults) {
    placementMatches = placementResults.length;
    placementWins = placementResults.filter((v) => v === "W").length;
  } else {
    placementWins = Math.min(nonNeg(r.placementWins), PLACEMENT_MATCHES);
    placementMatches = Math.min(nonNeg(r.placementMatches), PLACEMENT_MATCHES);
  }
  if (placementDone && tier === "none") {
    placementDone = false;
    placementWins = 0;
    placementMatches = 0;
    placementResults = null;
  }
  if (!placementDone) {
    tier = "none";
    level = 1;
    stars = null;
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
    stars,
    bestTier,
    bestLevel,
    bestStars,
    placementDone,
    placementWins,
    placementMatches,
    placementResults,
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
  rec.stars = null;
  rec.placementDone = false;
  rec.placementWins = 0;
  rec.placementMatches = 0;
  rec.placementResults = null;
}

function qualifiedSorted() {
  if (topCache && topCache.season === meta.season) return topCache.list;
  // 1.51.105: só entra quem já terminou a MD10 (placementDone). A trava
  // antiga de 15 partidas (MIN_MATCHES) não vale mais para a lista.
  const list = [...players.values()]
    .filter((r) => r.season === meta.season && r.placementDone && r.tier !== "none")
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
    rec.stars = null;
    rec.placementDone = false;
    rec.placementWins = 0;
    rec.placementMatches = 0;
    rec.placementResults = null;
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
    // Colocação: as 10 primeiras partidas ranqueadas da temporada, com o
    // resultado de cada uma guardado EM ORDEM (placementResults).
    // Registro anterior à 1.51.105 (só contadores): as vagas anteriores
    // ficam null (ordem desconhecida) e a atual entra na posição certa;
    // ensurePlacementResults() tenta preencher a ordem pelo histórico.
    if (!Array.isArray(rec.placementResults)) {
      rec.placementResults = Array(Math.min(rec.placementMatches, PLACEMENT_MATCHES)).fill(null);
    }
    rec.placementResults.push(outcome === "win" ? "W" : outcome === "loss" ? "L" : null);
    rec.placementResults = rec.placementResults.slice(0, PLACEMENT_MATCHES);
    rec.placementMatches = rec.placementResults.length;
    rec.placementWins = rec.placementResults.filter((v) => v === "W").length;
    if (rec.placementMatches >= PLACEMENT_MATCHES) {
      rec.placementDone = true;
      // Conta nova (1.51.105): 2×vitórias − derrotas. Quem já tinha
      // terminado a MD10 não passa por aqui — o rank dele não é recalculado.
      const losses = rec.placementResults.filter((v) => v === "L").length;
      const start = placementRank(rec.placementWins, losses);
      rec.tier = start.tier;
      rec.level = start.level;
      rec.stars = null;
    }
  } else {
    const next = stepLevel(rec.tier, rec.level, outcome, rec.stars);
    rec.tier = next.tier;
    rec.level = next.level;
    rec.stars = next.stars;
  }
  const disp = normalizeDisplay(display);
  if (disp) rec.display = disp;
  // O maior rank nunca desce (no mítico contam as estrelas).
  if (compareRank(
    { tier: rec.tier, level: rec.level, stars: rec.stars },
    { tier: rec.bestTier, level: rec.bestLevel, stars: rec.bestStars },
  ) > 0) {
    rec.bestTier = rec.tier;
    rec.bestLevel = rec.level;
    rec.bestStars = rec.stars;
  }
  players.set(key, rec);
  topCache = null;
  savePlayer(rec);
  return rankPublic(key, now);
}

/**
 * Reconstrói a ordem da MD10 de quem já está no meio da colocação sem
 * placementResults (registro anterior à 1.51.105, só contadores).
 *
 * Fonte: o histórico de partidas (df_matches via getPlayerHistory):
 * TODA partida online pela fila normal conta (fila casual E ranqueada),
 * EXCETO partida com amigo — a mesma regra que o index.mjs usa para
 * contar (maybeRecordRankSeason). Da mais antiga para a mais recente,
 * só da temporada atual, até placementMatches partidas.
 *
 * A ordem só é adotada quando (a) a quantidade reconstruída bate com
 * placementMatches E (b) as vitórias batem com placementWins E (c) não
 * há conflito com resultados já registrados ao vivo. Senão devolve null
 * e o registro fica como está (vagas null = ordem desconhecida; o
 * provisório continua pelos contadores). Sem Postgres (JSON) ou sem
 * getPlayerHistory na árvore (caso da árvore fase1-server antiga), não
 * há o que reconstruir — devolve null.
 */
export async function ensurePlacementResults(id) {
  ensureLoaded();
  const key = String(id || "");
  const rec = players.get(key);
  if (!rec || rec.season !== meta.season || rec.placementDone || !rec.placementMatches) return null;
  let rows = [];
  try {
    const pg = await import("./df-postgres.mjs");
    if (typeof pg.getPlayerHistory === "function") rows = await pg.getPlayerHistory(key, 50);
  } catch (e) {
    rows = [];
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const seasonStart = meta.startedAt || 0;
  const ordered = rows
    .filter((row) => row && !row.friend_match)
    .filter((row) => String(row.player_0_id) === key || String(row.player_1_id) === key)
    .filter((row) => !seasonStart || !row.ended_at || Date.parse(row.ended_at) >= seasonStart)
    .sort((a, b) => {
      const ta = Date.parse(a?.ended_at || 0) || 0;
      const tb = Date.parse(b?.ended_at || 0) || 0;
      if (ta !== tb) return ta - tb;
      return (Number(a?.id) || 0) - (Number(b?.id) || 0);
    })
    .slice(0, rec.placementMatches)
    .map((row) => {
      const seat = String(row.player_0_id) === key ? 0 : String(row.player_1_id) === key ? 1 : -1;
      if (seat < 0 || row.winner_seat == null) return null;
      return Number(row.winner_seat) === seat ? "W" : "L";
    });
  if (ordered.length !== rec.placementMatches) return null;
  if (ordered.filter((v) => v === "W").length !== rec.placementWins) return null;
  const cur = Array.isArray(rec.placementResults) ? rec.placementResults : [];
  for (let i = 0; i < ordered.length; i++) {
    if (cur[i] != null && cur[i] !== ordered[i]) return null;
  }
  rec.placementResults = ordered;
  players.set(key, rec);
  savePlayer(rec);
  return [...ordered];
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
    // Quem está no meio da MD10 sem ordem registrada: tenta reconstruir
    // a ordem pelo histórico ANTES de somar esta partida (best-effort).
    try { await ensurePlacementResults(String(e.id)); } catch (err) { /* sem histórico: segue com os contadores */ }
    const r = recordOutcome(String(e.id), e.outcome, { display });
    if (r) out.push({ id: String(e.id), rank: r });
  }
  return out;
}

/** Atualiza nome/avatar/nível/país exibidos no Top (só para quem já tem registro).
 *  1.51.105 (F3b): o país também entra na comparação — antes, só
 *  nome/avatar/nível eram comparados e a troca de país sozinha caía no
 *  retorno antecipado, deixando o `display.country` do registro de rank
 *  no país antigo até a próxima partida (F3 §3.3a). */
export function touchRankDisplay(id, display) {
  ensureLoaded();
  const rec = players.get(String(id || ""));
  const disp = normalizeDisplay(display);
  if (!rec || !disp) return;
  const cur = rec.display || {};
  if (cur.name === disp.name && cur.avatarHeroId === disp.avatarHeroId && cur.level === disp.level && cur.country === disp.country) return;
  rec.display = disp;
  savePlayer(rec);
}

/* ================= Leitura ================= */

/** Posição no Top 200 global (null fora da lista). */
export function positionOf(id) {
  const i = qualifiedSorted().findIndex((r) => r.id === String(id));
  return i >= 0 ? i + 1 : null;
}

/** Posição no Top 200 do país (null sem país ou fora da lista). */
export function positionOfCountry(id, country) {
  const c = typeof country === "string" ? country.toUpperCase() : null;
  if (!c) return null;
  const list = qualifiedSorted().filter((r) => r.display?.country === c);
  const i = list.findIndex((r) => r.id === String(id));
  return i >= 0 ? i + 1 : null;
}

/** Melhor divisão já alcançada, como número 0..7 (Medalhas das Conquistas — df-achievements.mjs lê número). */
export function bestTierOf(id) {
  ensureLoaded();
  return tierIndex(players.get(String(id || ""))?.bestTier || "none");
}

/** Resultados da colocação em 10 vagas (["W","L",null ×10]; null = empate ou vaga futura/desconhecida). */
function placementResults10(rec) {
  const arr = Array.isArray(rec?.placementResults) ? rec.placementResults : [];
  const out = [];
  for (let i = 0; i < PLACEMENT_MATCHES; i++) out.push(arr[i] === "W" || arr[i] === "L" ? arr[i] : null);
  return out;
}

/** Derrotas da colocação (da lista ordenada quando existe; senão dos contadores da temporada — durante a colocação, toda partida da temporada é da colocação). */
function placementLosses(rec) {
  if (Array.isArray(rec?.placementResults)) return rec.placementResults.filter((v) => v === "L").length;
  if (!rec) return 0;
  return Math.max(0, (rec.placementMatches || 0) - (rec.placementWins || 0));
}

export function rankPublic(id, now = Date.now()) {
  ensureLoaded();
  tickSeason(now);
  const rec = players.get(String(id || ""));
  const cur = rec && rec.season === meta.season ? rec : null;
  const matches = cur?.matches || 0;
  const wins = cur?.wins || 0;
  const tier = cur?.tier || "none";
  // Cuidado: nível 0 (mítico) é válido — usar ?? e não ||.
  const level = cur?.level ?? 1;
  const stars = tier === "mitico" ? (cur?.stars ?? 0) : null;
  const country = cur?.display?.country || null;
  const pending = rec ? rec.pending.map((p) => ({ ...p })) : [];
  // Rank provisório da MD10 (conta nova, 2×vitórias − derrotas): enquanto
  // a colocação não terminou; depois, o rank confirmado.
  const provisional = !cur || !cur.placementDone
    ? placementRank(cur?.placementWins || 0, placementLosses(cur))
    : { tier, level };
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
    // 1.51.105: `level` acima é o nível DENTRO da divisão (legado, como
    // sempre foi aqui); `tierLevel` é o mesmo valor com nome explícito e
    // `accountLevel` é o nível da conta (display). Na linha do Top e no
    // `me` do /auth/rank, `level` é o nível da conta (ver df-auth.mjs).
    tierLevel: level,
    accountLevel: cur?.display?.level ?? null,
    stars,
    country,
    bestTier: rec?.bestTier || "none",
    bestLevel: rec?.bestLevel ?? 1,
    bestStars: rec?.bestTier === "mitico" ? (rec?.bestStars ?? 0) : null,
    placementDone: cur ? !!cur.placementDone : false,
    placementWins: cur?.placementWins || 0,
    placement: {
      results: placementResults10(cur),
      provisionalTier: provisional.tier,
      provisionalLevel: provisional.level,
      wins: cur?.placementWins || 0,
      losses: placementLosses(cur),
      matches: cur?.placementMatches || 0,
    },
    pos: tier === "none" ? null : positionOf(id),
    posCountry: tier === "none" ? null : positionOfCountry(id, country),
    totalMatches: rec?.totalMatches || 0,
    totalWins: rec?.totalWins || 0,
    totalPct: winPct(rec?.totalWins || 0, rec?.totalMatches || 0),
    pending,
    pendingCoins: pending.reduce((s, p) => s + p.rankCoins + p.topCoins, 0),
  };
}

/**
 * Uma linha do Top (contrato 1.51.105): `level` = nível da conta,
 * `tierLevel` = nível dentro da divisão (0 no mítico), `stars` = null
 * fora do mítico. Extras mantidos para o cliente antigo: avatarHeroId,
 * wins, matches, winPct, bestTier, bestLevel.
 */
function topRow(r, i) {
  return {
    pos: i + 1,
    hero: r.display?.avatarHeroId || null,
    avatarHeroId: r.display?.avatarHeroId || null,
    name: r.display?.name || null,
    country: r.display?.country || null,
    level: r.display?.level || 1,
    tier: r.tier,
    tierId: r.tier,
    tierLevel: r.level,
    stars: r.tier === "mitico" ? (r.stars ?? 0) : null,
    wins: r.wins,
    matches: r.matches,
    winPct: winPct(r.wins, r.matches),
    bestTier: r.bestTier,
    bestLevel: r.bestLevel,
  };
}

/** Top 200 da temporada (sem ids de conta). */
export function topPublic(limit = TOP_SIZE, now = Date.now()) {
  ensureLoaded();
  tickSeason(now);
  return qualifiedSorted().slice(0, Math.max(0, limit | 0)).map(topRow);
}

/** Top 200 do país (mesma ordenação do global; [] sem país). */
export function topCountryPublic(country, limit = TOP_SIZE, now = Date.now()) {
  ensureLoaded();
  tickSeason(now);
  const c = typeof country === "string" ? country.toUpperCase() : null;
  if (!c) return [];
  return qualifiedSorted()
    .filter((r) => r.display?.country === c)
    .slice(0, Math.max(0, limit | 0))
    .map(topRow);
}

/**
 * Recompensas da temporada (1.51.105, 11 linhas — SÓ EXIBIÇÃO: "o que o
 * jogador ganharia se a temporada terminasse agora"). 7 divisões +
 * 4 posições do Top. `frame` = moldura nova (a imagem dela ainda não
 * existe — o cliente usa o ícone de moldura existente como marcador).
 */
export function rewardsPublic() {
  const tiers = RANK_TIERS.map((t) => ({
    label: TIER_LABELS[t.id] || t.id,
    tier: t.id,
    coins: t.coins,
    diamonds: t.diamonds || 0,
    frame: !!t.frame,
  }));
  const tops = TOP_POSITION_REWARDS.map((r) => ({ ...r }));
  return [...tiers, ...tops];
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
