/**
 * Fila 1v1 — pareia dois jogadores em uma sala nova.
 */

/** @type {{ socketId: string, joinedAt: number }[]} */
const queue = [];

export function removeFromQueue(socketId) {
  const i = queue.findIndex((e) => e.socketId === socketId);
  if (i >= 0) queue.splice(i, 1);
}

export function addToQueue(socketId) {
  removeFromQueue(socketId);
  queue.push({ socketId, joinedAt: Date.now() });
  return queue.length;
}

export function queueWaitSeconds(socketId) {
  const e = queue.find((x) => x.socketId === socketId);
  if (!e) return 0;
  return Math.floor((Date.now() - e.joinedAt) / 1000);
}

export function isInQueue(socketId) {
  return queue.some((e) => e.socketId === socketId);
}

/** @returns {[string, string] | null} */
export function takePair() {
  if (queue.length < 2) return null;
  const a = queue.shift();
  const b = queue.shift();
  return [a.socketId, b.socketId];
}

export function queueSize() {
  return queue.length;
}
