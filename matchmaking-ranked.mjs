/**
 * Fila ranked 1v1 — pareamento por MMR (janela expande com espera).
 */
import { getMmr } from "./df-ranked-store.mjs";
import { isPairExcluded, exclusionKeyForPlayer } from "./df-pair-exclusion.mjs";
// (F6, 1.51.104 itens 7 e 9) o ranked NÃO checava bloqueio (só o casual
// checava, desde a Frente 3) nem denúncia: o par bloqueado/denunciado
// nunca se forma — mesma checagem síncrona por cache do df-friends.mjs.
import { isBlockedSync, isReportedSync } from "./df-friends.mjs";

/** @type {{ socketId: string, playerId: string, mmr: number, joinedAt: number, avatarHeroId: string | null, level: number, avatarFrame: string | null, country: string | null }[]} */
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
  // (1.51.95 item 3) mesmo guarda da fila casual: o mesmo jogador não
  // entra na busca 2× (outra conexão/aparelho). Re-join da mesma
  // conexão continua permitido (removeFromRankedQueue acima já a tirou).
  if (playerId && queue.some((e) => e.playerId && e.playerId === String(playerId))) {
    return { ok: false, error: "ALREADY_IN_QUEUE", mmr: getMmr(playerId), position: queue.length };
  }
  const mmr = getMmr(playerId);
  // (1.51.75) avatar e nível do perfil, capturados no join_ranked_queue.
  // (1.51.80) moldura do avatar: mesmo caminho, para a Partida Encontrada.
  // (F9, 1.51.103 item 3) país: mesmo caminho, para a bandeirinha.
  queue.push({
    socketId,
    playerId: String(playerId),
    mmr,
    joinedAt: Date.now(),
    avatarHeroId: profile?.avatarHeroId || null,
    level: profile?.level || 0,
    avatarFrame: profile?.avatarFrame || null,
    country: profile?.country || null,
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

/** PlayerIds em fila ranked (para a presença da F4 — só "busy"). */
export function queuedRankedPlayerIds() {
  return new Set(queue.map((e) => e.playerId).filter(Boolean));
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
      // (1.51.95 item 3) rede de segurança: o mesmo jogador nunca pareia
      // com ele mesmo — nem o mesmo playerId, nem o mesmo socket.
      if (a.socketId === b.socketId) continue;
      if (a.playerId && b.playerId && a.playerId === b.playerId) continue;
      // (F6, 1.51.104 itens 7 e 9) bloqueio ou denúncia na janela de
      // 2 dias: o par nunca se forma — pula e tenta o próximo da fila.
      if (isBlockedSync(a.playerId, b.playerId)) continue;
      if (isReportedSync(a.playerId, b.playerId)) continue;
      if (Math.abs(a.mmr - b.mmr) <= window) {
        // (1.51.86) par excluído pós-recusa: pula e tenta o próximo.
        // A chave é a formatada (u:<conta> / s:<socket>), igual ao
        // registro em dissolveLobbyRoom — o playerId cru nunca bateria
        // com ela (correção 2026-11-21, t_1127).
        if (
          isPairExcluded(
            exclusionKeyForPlayer(a.playerId, a.socketId),
            exclusionKeyForPlayer(b.playerId, b.socketId),
          )
        ) continue;
        queue.splice(j, 1);
        queue.splice(i, 1);
        return [a, b];
      }
    }
  }
  // Fallback: pareia os dois mais antigos após 60s de espera
  if (now - queue[0].joinedAt >= 60000 && queue.length >= 2) {
    // (1.51.95 item 3) o fallback também não pareia o jogador com ele
    // mesmo (o guarda do add já barra, isto é a rede de segurança).
    if (queue[0].socketId === queue[1].socketId) return null;
    if (queue[0].playerId && queue[0].playerId === queue[1].playerId) return null;
    // (F6, 1.51.104 itens 7 e 9) nem o fallback fura bloqueio ou
    // denúncia na janela de 2 dias.
    if (isBlockedSync(queue[0].playerId, queue[1].playerId)) return null;
    if (isReportedSync(queue[0].playerId, queue[1].playerId)) return null;
    // (1.51.86) nem o fallback fura a exclusão de 30 s (mesma chave
    // formatada da busca por MMR acima).
    if (
      isPairExcluded(
        exclusionKeyForPlayer(queue[0].playerId, queue[0].socketId),
        exclusionKeyForPlayer(queue[1].playerId, queue[1].socketId),
      )
    ) return null;
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
