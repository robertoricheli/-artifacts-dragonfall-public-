/**
 * Detecção de dessincronia servidor x cliente (Frente 1, ALTA 2, 2026-11-24).
 *
 * O servidor não tinha nenhuma assinatura do estado: um cliente com a
 * tela velha (patch perdido) nunca era percebido. O mecanismo é mínimo:
 *
 *   hash = SHA-256 dos primeiros 16 hex do estado PROJETADO (o que o
 *   assento vê) serializado com chaves ordenadas (canônico).
 *
 * - Cada envelope de estado (ack de game_action, remote_action,
 *   room_state, replay do rejoin, match_start) carrega `stateHash`
 *   + `seq` (actionSeq).
 * - O servidor guarda o histórico dos últimos ~100 seqs por sala
 *   (por assento) em room._stateHashes.
 * - O cliente pode devolver o hash que tem (match_ping {seq, stateHash}
 *   ou evento state_check {seq, stateHash}): se diverge de um seq
 *   conhecido, o servidor registra state_desync e responde com
 *   resync:true + o estado completo projetado (o cliente reaplica).
 * - Seq desconhecido (fora do histórico) também volta com resync.
 *
 * ESPEC DO CLIENTE (trabalho posterior, dono do cliente): o cliente
 * calcula o MESMO hash sobre o último authoritativeState projetado
 * recebido (ou sobre o modelo após aplicar os patches, se a aplicação
 * reproduzir exatamente o estado projetado do servidor): stringify
 * canônico (chaves de objeto ordenadas, arrays na ordem), SHA-256,
 * 16 primeiros hex. O hash cobre o gameState projetado inteiro
 * (mão própria completa, mão do oponente embaçada, deckCount).
 */
import { createHash } from "node:crypto";

const HASH_HISTORY_MAX = 100;

/** Serialização canônica: chaves de objeto ordenadas, arrays na ordem. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Hash de um estado projetado (16 hex do SHA-256). */
export function computeStateHash(projectedState) {
  if (!projectedState) return null;
  try {
    return createHash("sha256").update(stableStringify(projectedState)).digest("hex").slice(0, 16);
  } catch (e) {
    return null;
  }
}

function historyMap(room) {
  if (!room._stateHashes) room._stateHashes = new Map();
  return room._stateHashes;
}

/** Guarda o hash do estado projetado de um assento num seq. */
export function recordStateHash(room, seat, seq, hash) {
  if (!room || seat == null || seq == null || !hash) return;
  const map = historyMap(room);
  map.set(`${seat}:${seq}`, hash);
  while (map.size > HASH_HISTORY_MAX) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

/** Hash guardado para (assento, seq), ou undefined se fora do histórico. */
export function lookupStateHash(room, seat, seq) {
  if (!room?._stateHashes || seat == null || seq == null) return undefined;
  return room._stateHashes.get(`${seat}:${seq}`);
}

/**
 * Compara o hash do cliente com o do servidor para um seq.
 * Devolve { known, match, serverHash }.
 */
export function checkClientState(room, seat, seq, clientHash) {
  const serverHash = lookupStateHash(room, seat, seq);
  if (serverHash == null) return { known: false, match: false, serverHash: null };
  return { known: true, match: serverHash === clientHash, serverHash };
}
