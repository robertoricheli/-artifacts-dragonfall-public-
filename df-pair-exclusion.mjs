/**
 * Exclusão pós-recusa (1.51.86) — Tela de Encontro de Partidas.
 *
 * Quando um par se recusa (recusa, tempo esgotado ou desconexão durante o
 * aceite), os dois jogadores não podem voltar a se parear por 30 s: o
 * pareamento pula o par excluído e tenta o próximo da fila. Com só 2
 * jogadores na fila que se excluíram, nenhum par forma por 30 s; expirado,
 * o par pode formar de novo — exatamente a correção dela (17:44).
 *
 * Chave pelo par de jogadores: playerId da conta quando houver, senão
 * socket id (prefixo u:/s: para um id de conta nunca colidir com um id
 * de socket). Só vive em memória; 30 s passam sozinhos.
 */

export const EXCLUSION_TTL_MS = 30000;

/** @type {Map<string, number>} chave do par -> expira em (ms) */
const excluded = new Map();

export function exclusionKeyForPlayer(playerId, socketId) {
  if (playerId) return `u:${playerId}`;
  return `s:${socketId}`;
}

function pairKey(keyA, keyB) {
  return keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
}

export function recordPairExclusion(keyA, keyB, ttlMs = EXCLUSION_TTL_MS) {
  if (!keyA || !keyB || keyA === keyB) return;
  excluded.set(pairKey(keyA, keyB), Date.now() + ttlMs);
}

export function isPairExcluded(keyA, keyB) {
  if (!keyA || !keyB || keyA === keyB) return false;
  const k = pairKey(keyA, keyB);
  const until = excluded.get(k);
  if (!until) return false;
  if (Date.now() >= until) {
    excluded.delete(k);
    return false;
  }
  return true;
}

export function pruneExclusions() {
  const now = Date.now();
  for (const [k, until] of excluded) {
    if (now >= until) excluded.delete(k);
  }
}
