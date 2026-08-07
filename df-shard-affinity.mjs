/**
 * Affinity de sala → shard (Fase 6).
 *
 * DF_SHARD_COUNT=1 (default) — sem redirect.
 * DF_SHARD_ID=0..N-1 — id deste processo game.
 * DF_GAME_SHARD_URLS=url0,url1 — URLs públicas dos game shards.
 * DF_GATEWAY_URL — URL do gateway (para game rejeitar lobby com redirect).
 *
 * Hash estável do roomCode → índice. Redis opcional: df:room:{CODE}:shard.
 */
import { getRedisClient, redisClientReady } from "./df-redis-client.mjs";
import { logMp } from "./df-mp-metrics.mjs";

function parseUrls(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function getShardCount() {
  const n = Number(process.env.DF_SHARD_COUNT) || 1;
  return Math.max(1, Math.min(16, n | 0));
}

export function getLocalShardId() {
  const n = Number(process.env.DF_SHARD_ID);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(getShardCount() - 1, n | 0);
}

export function getGameShardUrls() {
  return parseUrls(process.env.DF_GAME_SHARD_URLS);
}

export function getGatewayUrl() {
  const u = String(process.env.DF_GATEWAY_URL || "").trim().replace(/\/$/, "");
  return u || null;
}

/** FNV-1a 32-bit — estável entre processos. */
export function hashRoomCode(code) {
  const s = String(code || "").trim().toUpperCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shardIdForRoom(code) {
  const count = getShardCount();
  if (count <= 1) return 0;
  return hashRoomCode(code) % count;
}

export function shardUrlForRoom(code) {
  const urls = getGameShardUrls();
  const id = shardIdForRoom(code);
  if (urls[id]) return urls[id];
  if (urls.length === 1) return urls[0];
  return null;
}

export function thisProcessOwnsRoom(code) {
  if (getShardCount() <= 1) return true;
  return shardIdForRoom(code) === getLocalShardId();
}

function shardKey(code) {
  return `df:room:${String(code || "").trim().toUpperCase()}:shard`;
}

/** Persiste affinity no Redis (best-effort). */
export async function rememberRoomShard(code, shardId = null) {
  const id = shardId != null ? shardId : shardIdForRoom(code);
  const redis = getRedisClient();
  if (!redis || !redisClientReady()) return id;
  try {
    await redis.set(shardKey(code), String(id), "EX", 3 * 60 * 60);
  } catch (e) {
    logMp("shard_remember_fail", { code, error: e?.message || String(e) });
  }
  return id;
}

export async function lookupRoomShard(code) {
  const redis = getRedisClient();
  if (redis && redisClientReady()) {
    try {
      const raw = await redis.get(shardKey(code));
      if (raw != null && raw !== "") {
        const id = Number(raw);
        if (Number.isFinite(id)) return id | 0;
      }
    } catch (e) { /* fall through */ }
  }
  return shardIdForRoom(code);
}

/**
 * Payload de redirect para o cliente (WRONG_SHARD / shard_redirect).
 */
export function buildShardRedirect(code, reason = "WRONG_SHARD") {
  const shardId = shardIdForRoom(code);
  const serverUrl = shardUrlForRoom(code);
  return {
    ok: false,
    error: reason,
    reason,
    shardId,
    shardCount: getShardCount(),
    serverUrl,
    roomCode: String(code || "").trim().toUpperCase() || null,
  };
}

export function shardHealth() {
  return {
    shardId: getLocalShardId(),
    shardCount: getShardCount(),
    gameShardUrls: getGameShardUrls().length,
    gatewayUrl: getGatewayUrl(),
  };
}
