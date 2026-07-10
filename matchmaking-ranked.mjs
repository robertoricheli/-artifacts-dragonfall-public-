/**
 * Fila ranked 1v1 — pareamento por MMR (janela expande com espera).
 */
import { getMmr } from "./df-ranked-store.mjs";

/** @type {{ socketId: string, playerId: string, mmr: number, joinedAt: number }[]} */
const queue = [];

export function removeFromRankedQueue(socketId) {
  const i = queue.findIndex((e) => e.socketId === socketId);
  if (i >= 0) queue.splice(i, 1);
}

export function addToRankedQueue(socketId, playerId) {
  removeFromRankedQueue(socketId);
  const mmr = getMmr(playerId);
  queue.push({ socketId, playerId: String(playerId), mmr, joinedAt: Date.now() });
  queue.sort((a, b) => a.joinedAt - b.joinedAt);
  return { mmr, position: queue.length };
}

export function isInRankedQueue(socketId) {
  return queue.some((e) => e.socketId === socketId);
}

export function rankedQueueSize() {
  return queue.length;
}

function mmrWindow(waitMs) {
  const sec = Math.floor(waitMs / 1000);
  return 50 + Math.floor(sec / 5) * 25;
}

/** @returns {[typeof queue[0], typeof queue[0]] | null} */
export function takeRankedPair() {
  if (queue.length < 2) return null;
  const now = Date.now();
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    const window = mmrWindow(now - a.joinedAt);
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      if (Math.abs(a.mmr - b.mmr) <= window) {
        queue.splice(j, 1);
        queue.splice(i, 1);
        return [a, b];
      }
    }
  }
  // Fallback: pareia os dois mais antigos após 60s de espera
  if (now - queue[0].joinedAt >= 60000 && queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    return [a, b];
  }
  return null;
}
