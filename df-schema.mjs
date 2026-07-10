/**
 * Validação mínima de payloads Socket.IO (Fase 4).
 */

function isObj(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function bad(error) {
  return { ok: false, error };
}

export function validateJoinRoom(payload) {
  if (!isObj(payload)) return bad("BAD_PAYLOAD");
  if (payload.code != null && typeof payload.code !== "string") return bad("BAD_CODE");
  if (payload.preferSeat != null && payload.preferSeat !== 0 && payload.preferSeat !== 1) {
    return bad("BAD_SEAT");
  }
  return { ok: true };
}

export function validateSetHero(payload) {
  if (!isObj(payload) || typeof payload.heroId !== "string" || !payload.heroId) {
    return bad("BAD_HERO");
  }
  return { ok: true };
}

export function validateSetWinPoints(payload) {
  if (!isObj(payload)) return bad("BAD_PAYLOAD");
  const wp = Number(payload.winPoints);
  if (wp !== 10 && wp !== 15) return bad("BAD_WIN_POINTS");
  return { ok: true };
}

export function validateSetReady(payload) {
  if (!isObj(payload)) return bad("BAD_PAYLOAD");
  return { ok: true };
}

export function validateGameAction(payload) {
  if (!isObj(payload)) return bad("BAD_PAYLOAD");
  const action = payload.action;
  if (!isObj(action) || typeof action.type !== "string" || !action.type) {
    return bad("BAD_ACTION");
  }
  if (payload.snapshot != null && !isObj(payload.snapshot)) return bad("BAD_SNAPSHOT");
  return { ok: true, action };
}

export function validateGetReplay(payload) {
  if (payload == null) return { ok: true };
  if (!isObj(payload)) return bad("BAD_PAYLOAD");
  if (payload.fromSeq != null && Number.isNaN(Number(payload.fromSeq))) return bad("BAD_SEQ");
  return { ok: true };
}

export function validateJoinRankedQueue(payload) {
  if (payload == null) return { ok: true, playerId: null };
  if (!isObj(payload)) return bad("BAD_PAYLOAD");
  if (payload.playerId != null && typeof payload.playerId !== "string") return bad("BAD_PLAYER_ID");
  const playerId = payload.playerId ? String(payload.playerId).slice(0, 64) : null;
  return { ok: true, playerId };
}
