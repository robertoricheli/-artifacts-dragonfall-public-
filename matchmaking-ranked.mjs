/**
 * Fila ranked 1v1 — pareamento por MMR (janela expande com espera).
 */
import { getMmr } from "./df-ranked-store.mjs";

/** @type {{ socketId: string, playerId: string, mmr: number, joinedAt: number, avatarHeroId: string | null, level: number }[]} */
const queue = [];

export function removeFromRankedQueue(socketId) {
  const i = queue.findIndex((e) => e.socketId === socketId);
  if (i >= 0) queue.splice(i, 1);
}

export function addToRankedQueue(socketId, playerId, profile = null) {
  removeFromRankedQueue(socketId);
  let max = 24;
  try {
    // dynamic import sync not available — use env
    max = Number(process.env.DF_MAX_QUEUE) || 24;
  } catch (e) { /* */ }
  if (queue.length >= max) {
    return { ok: false, error: "SERVER_BUSY", mmr: getMmr(playerId), position: queue.length };
  }
  const mmr = getMmr(playerId);
  // (1.51.75) avatar e nível do perfil, capturados no join_ranked_queue.
  queue.push({
    socketId,
    playerId: String(playerId),
    mmr,
    joinedAt: Date.now(),
    avatarHeroId: profile?.avatarHeroId || null,
    level: profile?.level || 0,
  });
  queue.sort((a, b) => a.joinedAt - b.joinedAt);
  return { ok: true, mmr, position: queue.length };
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

/**
 * Devolve entradas à frente da fila ranked, na mesma ordem. Mesmo motivo
 * que requeueFront() na fila casual: pareamento falho não pode perder
 * os jogadores nem deixá-los sem resposta.
 */
export function requeueRankedFront(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    removeFromRankedQueue(e.socketId);
    queue.unshift(e);
  }
  queue.sort((a, b) => a.joinedAt - b.joinedAt);
}
