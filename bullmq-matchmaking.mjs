/**
 * BullMQ para fila ranked — usa Redis quando REDIS_URL está definido.
 * Sem Redis: pareamento in-memory via matchmaking-ranked.mjs.
 */
import {
  addToRankedQueue,
  removeFromRankedQueue,
  takeRankedPair,
  rankedQueueSize,
  isInRankedQueue,
} from "./matchmaking-ranked.mjs";

let mode = "memory";
let pairTimer = null;
let bullQueue = null;

async function tryPairLoop(onPair) {
  let pair = takeRankedPair();
  while (pair) {
    await onPair(pair[0], pair[1]);
    pair = takeRankedPair();
  }
}

export async function initRankedMatchmaking(onPair) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    mode = "memory";
    if (pairTimer) clearInterval(pairTimer);
    pairTimer = setInterval(() => { void tryPairLoop(onPair); }, 500);
    return { mode, rankedQueueSize };
  }

  try {
    const { Queue, Worker } = await import("bullmq");
    const connection = { url: redisUrl };
    bullQueue = new Queue("df-ranked-matchmaking", { connection });
    const worker = new Worker(
      "df-ranked-matchmaking",
      async () => { await tryPairLoop(onPair); },
      { connection, concurrency: 1 },
    );
    worker.on("failed", (job, err) => {
      console.warn("[bullmq] job failed", job?.id, err?.message);
    });
    await bullQueue.add(
      "tick",
      {},
      { repeat: { every: 500 }, removeOnComplete: 100, removeOnFail: 50 },
    );
    mode = "bullmq";
    console.log("[bullmq] ranked matchmaking ativo (Redis)");
    return { mode, rankedQueueSize };
  } catch (e) {
    console.warn("[bullmq] fallback memory:", e.message);
    mode = "memory";
    if (pairTimer) clearInterval(pairTimer);
    pairTimer = setInterval(() => { void tryPairLoop(onPair); }, 500);
    return { mode, rankedQueueSize };
  }
}

export function shutdownRankedMatchmaking() {
  if (pairTimer) {
    clearInterval(pairTimer);
    pairTimer = null;
  }
}

export {
  addToRankedQueue,
  removeFromRankedQueue,
  takeRankedPair,
  rankedQueueSize,
  isInRankedQueue,
};

export function getMatchmakingMode() {
  return mode;
}
