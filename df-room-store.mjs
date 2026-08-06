/**
 * RoomStore — memória (primary) + mirror Redis opcional + lock por sala.
 *
 * DF_ROOM_STORE=memory (default) — só Map em rooms.mjs; lock local.
 * DF_ROOM_STORE=redis — dual-write Memory + Redis; lock Redis NX + local.
 *
 * Blob Redis: df:room:{CODE} (JSON sem sockets/timers).
 * Lock: df:room:{CODE}:lock (SET NX PX).
 *
 * Socket IDs e turnTimer nunca vão no blob.
 */
import { randomUUID } from "node:crypto";
import { logMp } from "./df-mp-metrics.mjs";
import {
  getRedisClient,
  initRedisClient,
  redisClientReady,
  redisUrlConfigured,
} from "./df-redis-client.mjs";

const ROOM_KEY_PREFIX = "df:room:";
const LOCK_SUFFIX = ":lock";
const ROOM_TTL_SEC = 3 * 60 * 60; // 3h — alinhado ao TTL de salas
const LOCK_TTL_MS = 5000;
const LOCK_WAIT_MS = 2500;

/** @type {"memory"|"redis"} */
let mode = "memory";
let redisMirrorOk = false;
const pendingMirror = new Map();
let mirrorTimer = null;

/** Cadeia de locks locais por código (sempre ativa). */
const localChains = new Map();

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function roomKey(code) {
  return `${ROOM_KEY_PREFIX}${normalizeCode(code)}`;
}

function lockKey(code) {
  return `${roomKey(code)}${LOCK_SUFFIX}`;
}

export function getRoomStoreMode() {
  return mode;
}

export function isRedisRoomMirrorActive() {
  return mode === "redis" && redisMirrorOk && redisClientReady();
}

/**
 * Serializa estado persistível — sem sockets, timers, Maps locais.
 */
export function serializeRoomBlob(room) {
  if (!room?.code) return null;
  return {
    code: room.code,
    createdAt: room.createdAt || Date.now(),
    status: room.status || "lobby",
    heroes: room.heroes || [null, null],
    deckCardNames: room.deckCardNames || [null, null],
    winPoints: room.winPoints ?? 15,
    ready: room.ready || [false, false],
    lastSnapshot: room.lastSnapshot || null,
    gameState: room.gameState || null,
    eventLog: room.eventLog || [],
    actionSeq: room.actionSeq || 0,
    turnDeadline: room.turnDeadline || null,
    deckSeed: room.deckSeed != null ? room.deckSeed : null,
    arenaScenarioId: room.arenaScenarioId || null,
    ranked: !!room.ranked,
    rankedPlayerIds: room.rankedPlayerIds || null,
    seatTokens: room.seatTokens || [null, null],
    aiControlled: Array.isArray(room.aiControlled)
      ? [!!room.aiControlled[0], !!room.aiControlled[1]]
      : [false, false],
    lastSeen: room.lastSeen || [0, 0],
  };
}

/**
 * Boot: decide mode + conecta Redis se pedido.
 * Fallback memory se Redis falhar e DF_REQUIRE_REDIS≠1.
 */
export async function initRoomStore() {
  const raw = String(process.env.DF_ROOM_STORE || "memory").toLowerCase().trim();
  mode = raw === "redis" ? "redis" : "memory";
  redisMirrorOk = false;

  if (mode !== "redis") {
    logMp("room_store", { mode, redis: false });
    return { mode, redis: false };
  }

  if (!redisUrlConfigured()) {
    console.warn("[room-store] DF_ROOM_STORE=redis sem REDIS_URL — fallback memory");
    mode = "memory";
    logMp("room_store", { mode, redis: false, reason: "NO_REDIS_URL" });
    return { mode, redis: false };
  }

  const client = await initRedisClient();
  if (!client) {
    if (process.env.DF_REQUIRE_REDIS === "1") {
      throw new Error("DF_ROOM_STORE=redis exige Redis (DF_REQUIRE_REDIS=1)");
    }
    console.warn("[room-store] Redis indisponível — fallback memory");
    mode = "memory";
    logMp("room_store", { mode, redis: false, reason: "REDIS_CONNECT_FAILED" });
    return { mode, redis: false };
  }

  redisMirrorOk = true;
  logMp("room_store", { mode, redis: true });
  console.log("[room-store] dual-write Memory+Redis ativo");
  return { mode, redis: true };
}

async function writeRoomBlob(blob) {
  const redis = getRedisClient();
  if (!redis || !blob?.code) return false;
  try {
    await redis.set(roomKey(blob.code), JSON.stringify(blob), "EX", ROOM_TTL_SEC);
    return true;
  } catch (e) {
    logMp("room_mirror_fail", { code: blob.code, error: e?.message || String(e) });
    return false;
  }
}

async function deleteRoomBlob(code) {
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    await redis.del(roomKey(code));
    return true;
  } catch (e) {
    return false;
  }
}

export async function flushRoomMirrorPending() {
  if (!isRedisRoomMirrorActive()) {
    pendingMirror.clear();
    return;
  }
  const batch = [...pendingMirror.entries()];
  pendingMirror.clear();
  for (const [code, blob] of batch) {
    if (blob === null) await deleteRoomBlob(code);
    else await writeRoomBlob(blob);
  }
}

/** Debounce mirror (não bloqueia o hot path). */
export function scheduleRoomMirror(room) {
  if (!isRedisRoomMirrorActive() || !room?.code) return;
  if (room.status !== "playing" && room.status !== "lobby") {
    // ended → remove blob
    pendingMirror.set(normalizeCode(room.code), null);
  } else {
    pendingMirror.set(normalizeCode(room.code), serializeRoomBlob(room));
  }
  if (mirrorTimer) return;
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    void flushRoomMirrorPending();
  }, 50);
}

export function scheduleRoomMirrorDelete(code) {
  if (!isRedisRoomMirrorActive() || !code) return;
  pendingMirror.set(normalizeCode(code), null);
  if (mirrorTimer) return;
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    void flushRoomMirrorPending();
  }, 50);
}

/** Mirror síncrono (após apply — garante seq no Redis antes do ACK). */
export async function mirrorRoomNow(room) {
  if (!isRedisRoomMirrorActive() || !room?.code) return false;
  pendingMirror.delete(normalizeCode(room.code));
  return writeRoomBlob(serializeRoomBlob(room));
}

export async function loadRoomBlob(code) {
  const redis = getRedisClient();
  if (!redis || !isRedisRoomMirrorActive()) return null;
  try {
    const raw = await redis.get(roomKey(code));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Lista blobs playing/lobby no Redis (SCAN).
 * @returns {Promise<object[]>}
 */
export async function listRoomBlobsFromRedis() {
  const redis = getRedisClient();
  if (!redis || !isRedisRoomMirrorActive()) return [];
  const out = [];
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${ROOM_KEY_PREFIX}*`, "COUNT", 50);
      cursor = next;
      for (const key of keys || []) {
        if (String(key).endsWith(LOCK_SUFFIX)) continue;
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const blob = JSON.parse(raw);
          if (blob?.code) out.push(blob);
        } catch (e) { /* */ }
      }
    } while (cursor !== "0");
  } catch (e) {
    logMp("room_hydrate_scan", { ok: false, error: e?.message || String(e) });
  }
  return out;
}

/**
 * Restaura salas do Redis via importPersistedRoom (sockets=null).
 * @param {(data: object) => object|null} importFn
 */
export async function hydrateRoomsFromRedis(importFn) {
  if (!isRedisRoomMirrorActive() || typeof importFn !== "function") return 0;
  const blobs = await listRoomBlobsFromRedis();
  let n = 0;
  for (const blob of blobs) {
    if (blob.status !== "playing" && blob.status !== "lobby") continue;
    const mapped = {
      code: blob.code,
      createdAt: blob.createdAt,
      status: blob.status,
      heroes: blob.heroes,
      winPoints: blob.winPoints,
      ready: blob.ready,
      lastSnapshot: blob.lastSnapshot,
      gameState: blob.gameState,
      eventLog: blob.eventLog,
      actionSeq: blob.actionSeq,
      turnDeadline: blob.turnDeadline,
      deckSeed: blob.deckSeed,
      arenaScenarioId: blob.arenaScenarioId,
      ranked: blob.ranked,
      rankedPlayerIds: blob.rankedPlayerIds,
      seatTokens: blob.seatTokens,
      aiControlled: blob.aiControlled,
    };
    if (importFn(mapped)) n += 1;
  }
  if (n) console.log(`[room-store] ${n} sala(s) restaurada(s) do Redis`);
  logMp("room_hydrate", { ok: true, count: n });
  return n;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquireRedisLock(code, token) {
  const redis = getRedisClient();
  if (!redis) return false;
  const key = lockKey(code);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const ok = await redis.set(key, token, "PX", LOCK_TTL_MS, "NX");
    if (ok === "OK") return true;
    await sleep(15 + Math.floor(Math.random() * 20));
  }
  return false;
}

async function releaseRedisLock(code, token) {
  const redis = getRedisClient();
  if (!redis) return;
  const key = lockKey(code);
  try {
    // Só apaga se ainda for o nosso token.
    const cur = await redis.get(key);
    if (cur === token) await redis.del(key);
  } catch (e) { /* */ }
}

/**
 * Serializa applies na mesma sala (local sempre; Redis NX quando mirror ativo).
 * @template T
 * @param {string} code
 * @param {() => (T|Promise<T>)} fn
 * @returns {Promise<T>}
 */
export function withRoomLock(code, fn) {
  const key = normalizeCode(code);
  const prev = localChains.get(key) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(async () => {
      const useRedis = isRedisRoomMirrorActive();
      const token = useRedis ? randomUUID() : null;
      if (useRedis) {
        const got = await acquireRedisLock(key, token);
        if (!got) {
          const err = new Error("ROOM_LOCK_TIMEOUT");
          err.code = "ROOM_LOCK_TIMEOUT";
          throw err;
        }
      }
      try {
        return await fn();
      } finally {
        if (useRedis && token) await releaseRedisLock(key, token);
      }
    });
  // Próximo waiter encadeia após este (mesmo se falhar).
  const tail = run.catch(() => {}).then(() => {});
  localChains.set(key, tail);
  return run;
}

export function roomStoreHealth() {
  return {
    roomStore: mode,
    roomStoreRedis: isRedisRoomMirrorActive(),
    roomStoreRedisConfigured: redisUrlConfigured(),
  };
}
