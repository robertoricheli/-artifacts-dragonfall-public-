/**
 * Fila 1v1 — pareia dois jogadores em uma sala nova.
 */
import { MAX_QUEUE } from "./df-mp-limits.mjs";
import { isPairExcluded, exclusionKeyForPlayer } from "./df-pair-exclusion.mjs";
// Frente 3 (Perfil, 2026-11-25): jogador bloqueado NUNCA mais é pareado
// com quem bloqueou — checagem síncrona no cache de df-friends.mjs
// (alimentado por loadBlockCache() no boot e atualizado em block()).
// (F6, 1.51.104 item 9) denúncia na janela de 2 dias: mesmo tratamento.
import { isBlockedSync, isReportedSync } from "./df-friends.mjs";

/** @type {{ socketId: string, playerId: string | null, joinedAt: number, displayName: string | null, avatarHeroId: string | null, level: number, avatarFrame: string | null, country: string | null }[]} */
const queue = [];

export function removeFromQueue(socketId) {
  const i = queue.findIndex((e) => e.socketId === socketId);
  if (i >= 0) queue.splice(i, 1);
}

/**
 * @returns {{ ok: true, size: number } | { ok: false, error: string, size: number }}
 */
export function addToQueue(socketId, displayName = null, profile = null, playerId = null) {
  removeFromQueue(socketId);
  if (queue.length >= MAX_QUEUE) {
    return { ok: false, error: "SERVER_BUSY", size: queue.length };
  }
  // (1.51.95 item 3) o mesmo jogador não entra na busca 2×: um segundo
  // join do mesmo playerId (outra conexão/aparelho) é recusado. O
  // re-join da MESMA conexão continua permitido (removeFromQueue acima
  // já tirou a entrada dela — é só uma atualização). Sem playerId
  // (anônimo) não há como identificar: entra como antes.
  if (playerId && queue.some((e) => e.playerId && e.playerId === playerId)) {
    return { ok: false, error: "ALREADY_IN_QUEUE", size: queue.length };
  }
  // (1.51.75) avatar e nível do perfil, capturados no join_queue —
  // o pareamento os copia para a sala e o roomPublicView os emite.
  // (1.51.80) moldura do avatar: mesmo caminho, para a Partida Encontrada.
  // (F9, 1.51.103 item 3) país: mesmo caminho, para a bandeirinha.
  // (1.51.86) playerId da conta (quando houver): chave da exclusão
  // pós-recusa — sem ele, a chave é o socket id.
  queue.push({
    socketId,
    playerId: playerId || null,
    joinedAt: Date.now(),
    displayName: displayName || null,
    avatarHeroId: profile?.avatarHeroId || null,
    level: profile?.level || 0,
    avatarFrame: profile?.avatarFrame || null,
    country: profile?.country || null,
  });
  return { ok: true, size: queue.length };
}

export function queueWaitSeconds(socketId) {
  const e = queue.find((x) => x.socketId === socketId);
  if (!e) return 0;
  return Math.floor((Date.now() - e.joinedAt) / 1000);
}

export function isInQueue(socketId) {
  return queue.some((e) => e.socketId === socketId);
}

/**
 * Pega o primeiro par da fila que NÃO esteja excluído (1.51.86: par que
 * se recusou fica 30 s sem se parear). Varre em ordem — o jogador mais
 * antigo pareia com o parceiro mais antigo que não seja excluído com
 * ele — mantendo a ordem o máximo possível. Com só 2 jogadores
 * excluídos entre si, devolve null e os dois esperam na fila.
 * @returns {[{ socketId: string, joinedAt: number, displayName: string | null }, { socketId: string, joinedAt: number, displayName: string | null }] | null} */
export function takePair() {
  if (queue.length < 2) return null;
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i];
      const b = queue[j];
      // (1.51.95 item 3) rede de segurança: mesmo que duas entradas do
      // mesmo jogador cheguem à fila (ex.: corrida), nunca pareiam entre
      // si — nem o mesmo playerId, nem o mesmo socket.
      if (a.socketId === b.socketId) continue;
      if (a.playerId && b.playerId && a.playerId === b.playerId) continue;
      // Frente 3 (Perfil): bloqueio mútuo — o par nunca se forma.
      if (isBlockedSync(a.playerId, b.playerId)) continue;
      // (F6, 1.51.104 item 9) denúncia na janela de 2 dias — o par
      // nunca se forma (vale a denúncia mais recente do par).
      if (isReportedSync(a.playerId, b.playerId)) continue;
      if (
        isPairExcluded(
          exclusionKeyForPlayer(a.playerId, a.socketId),
          exclusionKeyForPlayer(b.playerId, b.socketId),
        )
      ) {
        continue;
      }
      queue.splice(j, 1);
      queue.splice(i, 1);
      return [a, b];
    }
  }
  return null;
}

/**
 * Devolve entradas à frente da fila, na mesma ordem (quem entrou primeiro
 * continua primeiro). Usado quando o pareamento falhou (ex.: servidor
 * lotado) — sem isto os dois jogadores saíam da fila sem aviso e ficavam
 * presos em "PROCURANDO PARTIDA…".
 */
export function requeueFront(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    removeFromQueue(e.socketId);
    queue.unshift(e);
  }
}

export function queueSize() {
  return queue.length;
}

/** PlayerIds em fila casual (para a presença da F4 — só "busy"). */
export function queuedPlayerIds() {
  return new Set(queue.map((e) => e.playerId).filter(Boolean));
}
