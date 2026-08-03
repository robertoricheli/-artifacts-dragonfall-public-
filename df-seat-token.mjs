/**
 * Tokens de assento para reconexão segura (Fase 1).
 */
import crypto from "crypto";

export function mintSeatToken() {
  return crypto.randomBytes(24).toString("base64url");
}

/** Garante room.seatTokens = [token0, token1]. */
export function ensureSeatTokens(room) {
  if (!room.seatTokens) room.seatTokens = [null, null];
  if (!room.seatTokens[0]) room.seatTokens[0] = mintSeatToken();
  if (!room.seatTokens[1]) room.seatTokens[1] = mintSeatToken();
  return room.seatTokens;
}

export function seatTokenFor(room, seat) {
  ensureSeatTokens(room);
  return room.seatTokens[seat] || null;
}

/**
 * Valida reconexão: preferSeat + seatToken (se enviado).
 * @returns {{ ok: true, seat: 0|1 } | { ok: false, error: string }}
 */
export function validateSeatToken(room, preferSeat, seatToken) {
  if (preferSeat !== 0 && preferSeat !== 1) return { ok: false, error: "BAD_SEAT" };
  if (!seatToken) return { ok: true, seat: preferSeat, weak: true };
  ensureSeatTokens(room);
  if (room.seatTokens[preferSeat] && room.seatTokens[preferSeat] === seatToken) {
    return { ok: true, seat: preferSeat };
  }
  return { ok: false, error: "BAD_SEAT_TOKEN" };
}
