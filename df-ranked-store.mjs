/**
 * MMR ranked — persistência JSON (mínimo; PostgreSQL fica para ciclo futuro).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const STORE_PATH = path.join(DATA_DIR, "ranked.json");

const DEFAULT_MMR = 1000;
const K_FACTOR = 32;

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

export function getMmr(playerId) {
  if (!playerId) return DEFAULT_MMR;
  const store = loadStore();
  return store.players[playerId]?.mmr ?? DEFAULT_MMR;
}

export function getRankedProfile(playerId) {
  if (!playerId) return { mmr: DEFAULT_MMR, wins: 0, losses: 0 };
  const store = loadStore();
  const p = store.players[playerId];
  return p ? { ...p } : { mmr: DEFAULT_MMR, wins: 0, losses: 0 };
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export function recordRankedMatch(winnerId, loserId) {
  if (!winnerId || !loserId || winnerId === loserId) return null;
  const store = loadStore();
  if (!store.players[winnerId]) {
    store.players[winnerId] = { mmr: DEFAULT_MMR, wins: 0, losses: 0, updatedAt: Date.now() };
  }
  if (!store.players[loserId]) {
    store.players[loserId] = { mmr: DEFAULT_MMR, wins: 0, losses: 0, updatedAt: Date.now() };
  }
  const w = store.players[winnerId];
  const l = store.players[loserId];
  const ew = expectedScore(w.mmr, l.mmr);
  const el = expectedScore(l.mmr, w.mmr);
  w.mmr = Math.round(w.mmr + K_FACTOR * (1 - ew));
  l.mmr = Math.max(100, Math.round(l.mmr + K_FACTOR * (0 - el)));
  w.wins = (w.wins || 0) + 1;
  l.losses = (l.losses || 0) + 1;
  w.updatedAt = Date.now();
  l.updatedAt = Date.now();
  saveStore(store);
  return {
    winner: { playerId: winnerId, mmr: w.mmr, delta: Math.round(K_FACTOR * (1 - ew)) },
    loser: { playerId: loserId, mmr: l.mmr, delta: Math.round(K_FACTOR * (0 - el)) },
  };
}

export function listRankedCount() {
  return Object.keys(loadStore().players || {}).length;
}
