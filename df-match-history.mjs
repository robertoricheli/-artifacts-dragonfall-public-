/**
 * Persistência de fim de partida — PostgreSQL (se ativo) + log local opcional.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isPostgresEnabled, saveMatchHistory } from "./df-postgres.mjs";
import { getDisplayNameOwner } from "./df-auth-store.mjs";
import { recordOnlineMatchEnd } from "./df-analytics.mjs";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const JSONL = path.join(DATA_DIR, "match-history.jsonl");

/**
 * E-N5 (decisão dela 16/11): o histórico não anota as cartas sacadas.
 * O DRAW do saque pago (df-engine.js DRAW_CARD) e da CONJURAÇÃO
 * (drawCardFree) carregam `card`; o do upkeep não. O cliente oficial
 * ignora, mas quem lê o arquivo vê a carta. Tira só a carta do DRAW —
 * o evento (quem sacou, quando, por quê) fica; o resto do log intocado.
 * Pura (não muta a entrada) — o eventLog vivo da sala não muda.
 */
export function sanitizeHistoryEventLog(eventLog) {
  if (!Array.isArray(eventLog)) return eventLog;
  return eventLog.map((entry) => {
    if (!entry || !Array.isArray(entry.events)) return entry;
    let changed = false;
    const events = entry.events.map((e) => {
      if (!e || e.type !== "DRAW" || (e.card === undefined && e.cardName === undefined)) return e;
      changed = true;
      const { card, cardName, ...rest } = e;
      return rest;
    });
    return changed ? { ...entry, events } : entry;
  });
}

/**
 * Frente 3 (Perfil, 2026-11-25): ids dos jogadores tambem em partida
 * casual e placar final. Fonte dos ids, nesta ordem: room.playerIds
 * (a integracao do pareamento pode preencher), room.rankedPlayerIds e,
 * por ultimo, o nome exibido na sala (df_display_names: nome -> id).
 * Placar: state.players[i].vp (PV). friendMatch: room.friend_match.
 */
async function resolveMatchPlayerIds(room) {
  const direct = Array.isArray(room.playerIds) && room.playerIds.length === 2
    ? room.playerIds
    : (room.rankedPlayerIds || [null, null]);
  const ids = [direct[0] || null, direct[1] || null];
  const names = room.playerNames || [null, null];
  for (let seat = 0; seat < 2; seat++) {
    if (ids[seat] || !names[seat]) continue;
    try {
      ids[seat] = await getDisplayNameOwner(String(names[seat]).toLowerCase());
    } catch (e) { /* sem id: a partida fica sem dono nesse assento */ }
  }
  return ids;
}

/** Poda do JSONL os ids apagados pela retencao no Postgres. */
function pruneJsonlByPgIds(prunedIds) {
  if (!Array.isArray(prunedIds) || !prunedIds.length) return;
  const drop = new Set(prunedIds.map(Number));
  try {
    if (!fs.existsSync(JSONL)) return;
    const kept = fs.readFileSync(JSONL, "utf8")
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          const row = JSON.parse(line);
          return row?.pgId == null || !drop.has(Number(row.pgId));
        } catch (e) {
          return true;
        }
      });
    fs.writeFileSync(JSONL, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  } catch (e) {
    console.warn("[match-history] jsonl prune failed:", e.message);
  }
}

export async function recordMatchEnd(room, state, gameVersion) {
  if (!room || state?.winner == null) return null;
  // Frente 7: COPIA dos herois ANTES do primeiro await - o payload
  // guardava a referencia viva de room.heroes e o save (async:
  // resolveMatchPlayerIds + INSERT) rodava DEPOIS do leaveRoom do
  // desistente zerar room.heroes[seat] (o leave_room com forfeit
  // chama maybeFinishMatch/recordMatchEnd e, na sequencia, leaveRoom;
  // e o primeiro await ja devolve o controle antes do payload ser
  // montado). Sem a copia feita aqui, o INSERT gravava o heroi null
  // de quem desistiu e a tela de historico quebrava no cliente
  // (String(null) em Godot 4.7). O leaveRoom nao muda.
  const heroIds = [...(room.heroes || [null, null])];
  const startedAt = room.matchStartedAt || null;
  const endedAt = Date.now();
  const durationMs = startedAt ? Math.max(0, endedAt - startedAt) : null;
  const turnNumber = state.turnNumber ?? null;
  const playerIds = await resolveMatchPlayerIds(room);
  const scores = [
    state.players?.[0]?.vp ?? null,
    state.players?.[1]?.vp ?? null,
  ];
  const payload = {
    roomCode: room.code,
    winnerSeat: state.winner,
    heroIds,
    ranked: !!room.ranked,
    rankedPlayerIds: room.rankedPlayerIds || [null, null],
    playerIds,
    scores,
    friendMatch: !!room.friend_match,
    actionSeq: room.actionSeq || 0,
    gameVersion,
    eventLog: sanitizeHistoryEventLog(room.eventLog || []),
    gameState: state,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    durationMs,
    turnNumber,
  };

  let pgId = null;
  let prunedIds = [];
  if (isPostgresEnabled()) {
    const saved = await saveMatchHistory(payload);
    pgId = saved?.id ?? null;
    prunedIds = saved?.prunedIds || [];
  }

  try {
    recordOnlineMatchEnd(room, state, { startedAt, durationMs });
  } catch (e) { /* analytics never blocks */ }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(JSONL, `${JSON.stringify({ ...payload, pgId, at: Date.now() })}\n`, "utf8");
    pruneJsonlByPgIds(prunedIds);
  } catch (e) {
    console.warn("[match-history] jsonl append failed:", e.message);
  }

  return { pgId, prunedIds };
}
