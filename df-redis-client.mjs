/**
 * Cliente Redis compartilhado (ioredis) — opcional.
 * Usado por room-store, lock e (já existente) Socket.IO adapter / BullMQ.
 */
import { logMp } from "./df-mp-metrics.mjs";

let client = null;
let initAttempted = false;
let lastError = null;

export function redisUrlConfigured() {
  return !!process.env.REDIS_URL;
}

/** @returns {import("ioredis").Redis | null} */
export function getRedisClient() {
  return client;
}

export function redisClientReady() {
  return !!(client && client.status === "ready");
}

/**
 * Conecta um cliente dedicado ao room-store (não compartilha com Socket.IO pub/sub).
 * Sem REDIS_URL → null. Falha → null (salvo DF_REQUIRE_REDIS=1 no boot do servidor).
 */
export async function initRedisClient() {
  if (initAttempted) return client;
  initAttempted = true;
  const url = process.env.REDIS_URL;
  if (!url) {
    logMp("redis_client", { ok: false, reason: "NO_REDIS_URL" });
    return null;
  }
  try {
    const { Redis } = await import("ioredis");
    const redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    redis.on("error", (e) => {
      lastError = e?.message || String(e);
    });
    await redis.connect();
    client = redis;
    lastError = null;
    logMp("redis_client", { ok: true });
    return client;
  } catch (e) {
    lastError = e?.message || String(e);
    client = null;
    logMp("redis_client", { ok: false, error: lastError });
    console.warn("[redis] cliente room-store indisponível:", lastError);
    return null;
  }
}

export function redisClientError() {
  return lastError;
}

/** Testes / shutdown. */
export async function closeRedisClient() {
  if (!client) return;
  try { await client.quit(); } catch (e) { /* */ }
  client = null;
  initAttempted = false;
}

/** Injeta cliente fake (testes). */
export function setRedisClientForTests(fake) {
  client = fake;
  initAttempted = true;
  lastError = null;
}
