/**
 * Limites de capacidade multiplayer (Fase 3).
 */
export const MAX_ROOMS = Number(process.env.DF_MAX_ROOMS) || 40;
export const MAX_QUEUE = Number(process.env.DF_MAX_QUEUE) || 24;
export const MAX_SYNC_PER_SEC = Number(process.env.DF_MAX_SYNC_PER_SEC) || 8;

/** Cap por socket para SYNC_STATE (não afeta jogadas). */
const syncBuckets = new Map();

export function allowSync(socketId) {
  const now = Date.now();
  let b = syncBuckets.get(socketId);
  if (!b || now - b.windowStart >= 1000) {
    b = { windowStart: now, count: 0 };
    syncBuckets.set(socketId, b);
  }
  b.count += 1;
  return b.count <= MAX_SYNC_PER_SEC;
}

export function pruneSyncBuckets() {
  const now = Date.now();
  for (const [id, b] of syncBuckets) {
    if (now - b.windowStart > 5000) syncBuckets.delete(id);
  }
}

setInterval(pruneSyncBuckets, 30_000).unref?.();
