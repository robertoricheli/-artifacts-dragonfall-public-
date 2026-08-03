/**
 * MMR ranked — Postgres quando disponível; JSON local como fallback (Fase 2).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPgPool, isPostgresEnabled } from "./df-postgres.mjs";
import { logMp } from "./df-mp-metrics.mjs";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const STORE_PATH = path.join(DATA_DIR, "ranked.json");

const DEFAULT_MMR = 1000;
const K_FACTOR = 32;

const RANKED_SCHEMA = `
CREATE TABLE IF NOT EXISTS df_ranked_players (
  player_id VARCHAR(64) PRIMARY KEY,
  mmr INT NOT NULL DEFAULT 1000,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

let rankedPgReady = false;
const memCache = new Map();

export async function initRankedStoreSchema() {
  const pool = getPgPool();
  if (!pool) {
    rankedPgReady = false;
    return false;
  }
  try {
    await pool.query(RANKED_SCHEMA);
    rankedPgReady = true;
    logMp("ranked_pg_schema", { ok: true });
    return true;
  } catch (e) {
    rankedPgReady = false;
    logMp("ranked_pg_schema", { ok: false, error: e?.message || String(e) });
    return false;
  }
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ players: {} }, null, 2), "utf8");
  }
}

function loadStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (_) {
    return { players: {} };
  }
}

function saveStore(data) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

async function pgGetProfile(playerId) {
  const pool = getPgPool();
  if (!pool || !rankedPgReady || !playerId) return null;
  const res = await pool.query(
    `SELECT player_id, mmr, wins, losses, EXTRACT(EPOCH FROM updated_at)*1000 AS updated_at
     FROM df_ranked_players WHERE player_id = $1`,
    [playerId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    mmr: row.mmr ?? DEFAULT_MMR,
    wins: row.wins || 0,
    losses: row.losses || 0,
    updatedAt: Number(row.updated_at) || Date.now(),
  };
}

async function pgUpsertProfile(playerId, profile) {
  const pool = getPgPool();
  if (!pool || !rankedPgReady || !playerId) return;
  await pool.query(
    `INSERT INTO df_ranked_players (player_id, mmr, wins, losses, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (player_id) DO UPDATE SET
       mmr = EXCLUDED.mmr,
       wins = EXCLUDED.wins,
       losses = EXCLUDED.losses,
       updated_at = NOW()`,
    [playerId, profile.mmr, profile.wins || 0, profile.losses || 0],
  );
}

export function getMmr(playerId) {
  if (!playerId) return DEFAULT_MMR;
  if (memCache.has(playerId)) return memCache.get(playerId).mmr ?? DEFAULT_MMR;
  if (rankedPgReady && isPostgresEnabled()) {
    // Sync path: cache miss → default until async warm (callers are sync).
    // Warm in background.
    void pgGetProfile(playerId).then((p) => {
      if (p) memCache.set(playerId, p);
    }).catch(() => {});
  }
  const store = loadStore();
  const p = store.players[playerId];
  if (p) {
    memCache.set(playerId, p);
    return p.mmr ?? DEFAULT_MMR;
  }
  return DEFAULT_MMR;
}

export function getRankedProfile(playerId) {
  if (!playerId) return { mmr: DEFAULT_MMR, wins: 0, losses: 0 };
  if (memCache.has(playerId)) return { ...memCache.get(playerId) };
  const store = loadStore();
  const p = store.players[playerId];
  if (p) {
    memCache.set(playerId, p);
    return { ...p };
  }
  if (rankedPgReady && isPostgresEnabled()) {
    void pgGetProfile(playerId).then((prof) => {
      if (prof) memCache.set(playerId, prof);
    }).catch(() => {});
  }
  return { mmr: DEFAULT_MMR, wins: 0, losses: 0 };
}

export function recordRankedMatch(winnerId, loserId) {
  if (!winnerId || !loserId || winnerId === loserId) return null;

  const w = { ...(memCache.get(winnerId) || loadStore().players[winnerId] || { mmr: DEFAULT_MMR, wins: 0, losses: 0 }) };
  const l = { ...(memCache.get(loserId) || loadStore().players[loserId] || { mmr: DEFAULT_MMR, wins: 0, losses: 0 }) };
  const ew = expectedScore(w.mmr, l.mmr);
  const el = expectedScore(l.mmr, w.mmr);
  const wDelta = Math.round(K_FACTOR * (1 - ew));
  const lDelta = Math.round(K_FACTOR * (0 - el));
  w.mmr = Math.round(w.mmr + wDelta);
  l.mmr = Math.max(100, Math.round(l.mmr + lDelta));
  w.wins = (w.wins || 0) + 1;
  l.losses = (l.losses || 0) + 1;
  w.updatedAt = Date.now();
  l.updatedAt = Date.now();

  memCache.set(winnerId, w);
  memCache.set(loserId, l);

  const store = loadStore();
  store.players[winnerId] = w;
  store.players[loserId] = l;
  saveStore(store);

  if (rankedPgReady && isPostgresEnabled()) {
    void Promise.all([
      pgUpsertProfile(winnerId, w),
      pgUpsertProfile(loserId, l),
    ]).catch((e) => logMp("ranked_pg_save_err", { error: e?.message || String(e) }));
  }

  return {
    winner: { playerId: winnerId, mmr: w.mmr, delta: wDelta },
    loser: { playerId: loserId, mmr: l.mmr, delta: lDelta },
  };
}

export function listRankedCount() {
  return Object.keys(loadStore().players || {}).length;
}

export function rankedStoreMode() {
  return rankedPgReady && isPostgresEnabled() ? "postgres" : "json";
}
