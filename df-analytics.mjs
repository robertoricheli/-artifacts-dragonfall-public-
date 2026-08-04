/**
 * Dragonfall — telemetria de analytics (fire-and-forget, nunca bloqueia auth/partida).
 */
import {
  initAnalyticsSchema,
  pgInsertActivity,
  pgInsertMatchStat,
} from "./df-analytics-pg.mjs";

const SYNC_DEBOUNCE_MS = 30 * 60 * 1000;
const lastSyncByPlayer = new Map();

export async function initAnalytics() {
  try {
    await initAnalyticsSchema();
    return true;
  } catch (e) {
    console.warn("[analytics] schema init failed:", e?.message || e);
    return false;
  }
}

export function recordActivity(playerId, kind) {
  if (!playerId || !kind) return;
  void pgInsertActivity(playerId, kind).catch(() => {});
}

export function recordActivitySync(playerId) {
  if (!playerId) return;
  const now = Date.now();
  const last = lastSyncByPlayer.get(playerId) || 0;
  if (now - last < SYNC_DEBOUNCE_MS) return;
  lastSyncByPlayer.set(playerId, now);
  recordActivity(playerId, "sync");
}

export function recordMatchStat(row) {
  if (!row?.matchType) return;
  void pgInsertMatchStat(row).catch(() => {});
}

/**
 * Partida online encerrada — atividade + stats para ambos assentos.
 * @param {object} room
 * @param {object} state
 * @param {{ startedAt?: number, durationMs?: number }} timing
 */
export function recordOnlineMatchEnd(room, state, timing = {}) {
  if (!room || state?.winner == null) return;
  const heroIds = room.heroes || [null, null];
  const playerIds = room.rankedPlayerIds || [null, null];
  const winnerSeat = state.winner;
  const turnNumber = state.turnNumber ?? null;
  const actionSeq = room.actionSeq || 0;
  const durationMs = timing.durationMs ?? null;
  const endedAt = new Date().toISOString();
  const deckNames = room.deckCardNames || [null, null];

  for (let seat = 0; seat < 2; seat++) {
    const playerId = playerIds[seat];
    if (playerId) {
      recordActivity(playerId, "match_end");
    }
    const opponentSeat = seat === 0 ? 1 : 0;
    const outcome = winnerSeat === seat ? "win" : winnerSeat === opponentSeat ? "lose" : null;
    const cards = Array.isArray(deckNames[seat])
      ? deckNames[seat].filter(Boolean)
      : null;
    recordMatchStat({
      playerId,
      opponentId: playerIds[opponentSeat] || null,
      matchType: room.ranked ? "pvp" : "pvp",
      outcome,
      heroId: heroIds[seat],
      durationMs,
      turnNumber,
      actionSeq,
      deckCards: cards,
      endedAt,
    });
  }
}

/**
 * Partida vs-IA reportada via /auth/match-xp (sem mudança no cliente).
 */
export function recordMatchXpEvent(player, body) {
  if (!player?.id) return;
  recordActivity(player.id, "match_xp");
  const rawType = body?.matchType;
  const matchType = rawType === "pvp" || rawType === "ai" || rawType === "ai_hard" || rawType === "ai_normal"
    ? rawType
    : "ai";
  const outcome = body?.outcome === "win" ? "win" : body?.outcome === "lose" ? "lose" : null;
  recordMatchStat({
    playerId: player.id,
    opponentId: null,
    matchType,
    outcome,
    heroId: body?.heroId ? String(body.heroId) : null,
    durationMs: body?.durationMs != null ? Number(body.durationMs) : null,
    turnNumber: body?.turnNumber != null ? Number(body.turnNumber) : null,
    actionSeq: null,
    deckCards: null,
    endedAt: new Date().toISOString(),
  });
}

/** Expõe debounce para testes. */
export function _resetSyncDebounceForTests() {
  lastSyncByPlayer.clear();
}

export function _getSyncDebounceMs() {
  return SYNC_DEBOUNCE_MS;
}
