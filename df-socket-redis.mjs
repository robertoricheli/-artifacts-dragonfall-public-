/**
 * Socket.IO Redis adapter (Fase 3) — multi-instância quando REDIS_URL está definido.
 * Sem Redis: no-op (single node).
 */
import { logMp } from "./df-mp-metrics.mjs";

let adapterAttached = false;

export function redisConfigured() {
  return !!process.env.REDIS_URL;
}

export async function attachSocketRedisAdapter(io) {
  const url = process.env.REDIS_URL;
  if (!url) {
    logMp("redis_adapter", { ok: false, reason: "NO_REDIS_URL" });
    return false;
  }
  try {
    const { createAdapter } = await import("@socket.io/redis-adapter");
    const { Redis } = await import("ioredis");
    const pub = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
    const sub = pub.duplicate();
    io.adapter(createAdapter(pub, sub));
    adapterAttached = true;
    logMp("redis_adapter", { ok: true });
    console.log("[socket] Redis adapter ativo");
    return true;
  } catch (e) {
    logMp("redis_adapter", { ok: false, error: e?.message || String(e) });
    console.warn("[socket] Redis adapter indisponível:", e?.message || e);
    return false;
  }
}

export function isRedisAdapterAttached() {
  return adapterAttached;
}
