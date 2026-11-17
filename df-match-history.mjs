/**
 * Persistência de fim de partida — PostgreSQL (se ativo) + log local opcional.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isPostgresEnabled, saveMatchHistory } from "./df-postgres.mjs";
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

export async function recordMatchEnd(room, state, gameVersion) {
  if (!room || state?.winner == null) return null;
  const startedAt = room.matchStartedAt || null;
  const endedAt = Date.now();
  const durationMs = startedAt ? Math.max(0, endedAt - startedAt) : null;
  const turnNumber = state.turnNumber ?? null;
  const payload = {
    roomCode: room.code,
    winnerSeat: state.winner,
    heroIds: room.heroes || [null, null],
    ranked: !!room.ranked,
    rankedPlayerIds: room.rankedPlayerIds || [null, null],
    actionSeq: room.actionSeq || 0,
    gameVersion,
    eventLog: sanitizeHistoryEventLog(room.eventLog || []),
    gameState: state,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    durationMs,
    turnNumber,
  };

  let pgId = null;
  if (isPostgresEnabled()) {
    pgId = await saveMatchHistory(payload);
  }

  try {
    recordOnlineMatchEnd(room, state, { startedAt, durationMs });
  } catch (e) { /* analytics never blocks */ }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(JSONL, `${JSON.stringify({ ...payload, pgId, at: Date.now() })}\n`, "utf8");
  } catch (e) {
    console.warn("[match-history] jsonl append failed:", e.message);
  }

  return { pgId };
}
