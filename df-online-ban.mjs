/**
 * Pausa do online (1.51.88 item 8) — fechar a tela de encontro.
 *
 * FIM DA REGRA EM 1.51.95 (item 7, decisão dela): fechar a tela de
 * encontro NÃO bane mais. Este módulo fica guardado sem uso (nenhum
 * caminho do index.mjs o chama mais) — não apagar: o deploy ao vivo
 * (e604ec21) ainda tem o módulo e a remoção do arquivo exigiria
 * sincronizar a lista SERVER_FILES; o custo de manter é zero.
 *
 * Regra antiga (só p/ referência): fechar em PARTIDA ENCONTRADA deixava
 * a conta 30 s sem jogar partida Online; em PARTIDA INICIANDO, 60 s.
 */

export const ONLINE_BAN_FOUND_SECONDS = 30;
export const ONLINE_BAN_STARTING_SECONDS = 60;

/** @type {Map<string, number>} chave -> pode jogar de novo em (ms) */
const banned = new Map();

export function onlineBanKeyForPlayer(playerId, socketId) {
  if (playerId) return `u:${playerId}`;
  return `s:${socketId}`;
}

export function recordOnlineBan(key, seconds) {
  if (!key || !(seconds > 0)) return 0;
  const until = Date.now() + seconds * 1000;
  banned.set(key, until);
  return until;
}

/** Instante (ms) em que a pausa acaba; 0 = sem pausa. */
export function onlineBanUntil(key) {
  if (!key) return 0;
  const until = banned.get(key);
  if (!until) return 0;
  if (Date.now() >= until) {
    banned.delete(key);
    return 0;
  }
  return until;
}

export function onlineBanRemainingMs(key) {
  const until = onlineBanUntil(key);
  if (!until) return 0;
  return until - Date.now();
}

export function onlineBanRemainingSeconds(key) {
  return Math.ceil(onlineBanRemainingMs(key) / 1000);
}

export function pruneOnlineBans() {
  const now = Date.now();
  for (const [k, until] of banned) {
    if (now >= until) banned.delete(k);
  }
}
