/**
 * Dragonfall — fachada de persistência de contas (Postgres ou JSON local).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isPostgresEnabled } from "./df-postgres.mjs";
import {
  initAuthPgSchema,
  pgFindPlayerByEmail,
  pgGetPlayerById,
  pgInsertPlayer,
  pgUpdatePlayer,
  pgCreateSession,
  pgDeleteSession,
  pgAuthPlayerFromToken,
  pgGetDisplayNameOwner,
  pgSetDisplayName,
  pgPrunePlayerSessions,
} from "./df-auth-pg.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "data", "accounts.json");

let mode = "json";
let store = null;

function defaultStore() {
  return { players: {}, sessions: {}, displayNames: {} };
}

function loadJsonStore() {
  try {
    if (!fs.existsSync(DATA_PATH)) return defaultStore();
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    return {
      players: data.players || {},
      sessions: data.sessions || {},
      displayNames: data.displayNames || {},
    };
  } catch (e) {
    console.warn("[auth-store] load failed, reset:", e.message);
    return defaultStore();
  }
}

function saveJsonStore() {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2), "utf8");
}

function ensureJsonPlayerFields(p) {
  if (p.profileRevision == null) p.profileRevision = 0;
  if (!p.updatedAt) p.updatedAt = p.createdAt || new Date().toISOString();
  return p;
}

function pruneJsonSessions() {
  const now = Date.now();
  for (const [tok, sess] of Object.entries(store.sessions)) {
    if (!sess?.expiresAt || sess.expiresAt < now) delete store.sessions[tok];
  }
}

export async function initAuthStore() {
  if (process.env.DATABASE_URL && !isPostgresEnabled()) {
    const msg = "DATABASE_URL definida mas Postgres não está ativo — abortando auth JSON";
    if (process.env.NODE_ENV === "production" || process.env.DF_REQUIRE_POSTGRES === "1") {
      throw new Error(`AUTH_STORE_POSTGRES_REQUIRED: ${msg}`);
    }
    console.warn("[auth-store]", msg);
  }
  if (isPostgresEnabled()) {
    await initAuthPgSchema();
    mode = "postgres";
    console.log("[auth-store] postgres ativo");
    return { mode };
  }
  store = loadJsonStore();
  for (const p of Object.values(store.players)) ensureJsonPlayerFields(p);
  mode = "json";
  console.log("[auth-store] json local (accounts.json)");
  return { mode };
}

export function getAuthStoreMode() {
  return mode;
}

export async function findPlayerByEmail(email) {
  if (mode === "postgres") return pgFindPlayerByEmail(email);
  const e = String(email || "").trim().toLowerCase();
  return Object.values(store.players).find((p) => p.email === e) || null;
}

export async function getPlayerById(id) {
  if (mode === "postgres") return pgGetPlayerById(id);
  return store.players[id] ? ensureJsonPlayerFields(store.players[id]) : null;
}

export async function insertPlayer(player) {
  if (mode === "postgres") return pgInsertPlayer(player);
  ensureJsonPlayerFields(player);
  store.players[player.id] = player;
  saveJsonStore();
  return player;
}

export async function persistPlayer(player, { expectedRevision } = {}) {
  if (mode === "postgres") {
    const r = await pgUpdatePlayer(player, { expectedRevision });
    return r;
  }
  const current = store.players[player.id];
  if (!current) return { ok: false, error: "NOT_FOUND" };
  const currentRev = Number(current.profileRevision ?? 0);
  if (expectedRevision != null && Number(expectedRevision) !== currentRev) {
    return { ok: false, error: "PROFILE_CONFLICT", player: ensureJsonPlayerFields({ ...current }) };
  }
  const nextRev = currentRev + 1;
  player.profileRevision = nextRev;
  player.updatedAt = new Date().toISOString();
  store.players[player.id] = player;
  saveJsonStore();
  return { ok: true, player: ensureJsonPlayerFields({ ...player }) };
}

export async function createSessionRecord(token, playerId, expiresAt) {
  if (mode === "postgres") {
    await pgCreateSession(playerId, token, expiresAt);
    return;
  }
  pruneJsonSessions();
  store.sessions[token] = { playerId, expiresAt };
  saveJsonStore();
}

export async function deleteSessionRecord(token) {
  if (mode === "postgres") {
    await pgDeleteSession(token);
    return;
  }
  delete store.sessions[token];
  saveJsonStore();
}

export async function authPlayerFromToken(token) {
  if (mode === "postgres") return pgAuthPlayerFromToken(token);
  pruneJsonSessions();
  const sess = store.sessions[token];
  if (!sess || sess.expiresAt < Date.now()) return null;
  const p = store.players[sess.playerId];
  return p ? ensureJsonPlayerFields(p) : null;
}

export async function getDisplayNameOwner(nameKey) {
  if (mode === "postgres") return pgGetDisplayNameOwner(nameKey);
  return store.displayNames[nameKey] || null;
}

export async function updateDisplayName(playerId, oldName, newName) {
  const oldKey = oldName ? String(oldName).toLowerCase() : null;
  const newKey = newName ? String(newName).toLowerCase() : null;
  if (mode === "postgres") {
    await pgSetDisplayName(playerId, oldKey, newKey);
    return;
  }
  if (newKey && store.displayNames[newKey] && store.displayNames[newKey] !== playerId) {
    throw new Error("NAME_TAKEN");
  }
  if (oldKey) delete store.displayNames[oldKey];
  if (newKey) store.displayNames[newKey] = playerId;
  saveJsonStore();
}

/** Mantém no máximo `keep` sessões do jogador (login cria +1 depois). */
export async function prunePlayerSessions(playerId, keep = 7) {
  if (mode === "postgres") {
    await pgPrunePlayerSessions(playerId, keep);
    return;
  }
  pruneJsonSessions();
  const entries = Object.entries(store.sessions)
    .filter(([, s]) => s?.playerId === playerId)
    .sort((a, b) => (b[1].expiresAt || 0) - (a[1].expiresAt || 0));
  for (let i = Math.max(0, keep | 0); i < entries.length; i++) {
    delete store.sessions[entries[i][0]];
  }
  saveJsonStore();
}

/** Expor JSON bruto para migração. */
export function loadJsonAccountsFile() {
  return loadJsonStore();
}

export function getJsonDataPath() {
  return DATA_PATH;
}
