/**
 * Salas 1v1 — código DRAGON-XXXX
 */
import { MAX_ROOMS } from "./df-mp-limits.mjs";
import { ensureSeatTokens, seatTokenFor } from "./df-seat-token.mjs";

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

const rooms = new Map();

function randomChunk(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function makeRoomCode() {
  let code;
  do {
    code = `DRAGON-${randomChunk(4)}`;
  } while (rooms.has(code));
  return code;
}

/** @returns {{ ok: true, room: object } | { ok: false, error: string }} */
export function createRoom() {
  pruneOldRooms();
  if (rooms.size >= MAX_ROOMS) {
    return { ok: false, error: "SERVER_BUSY" };
  }
  const code = makeRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    status: "lobby",
    sockets: [null, null],
    heroes: [null, null],
    deckCardNames: [null, null],
    winPoints: 15,
    ready: [false, false],
    lastSnapshot: null,
    gameState: null,
    eventLog: [],
    actionSeq: 0,
    aiControlled: [false, false],
    seatTokens: [null, null],
    lastSeen: [0, 0],
  };
  ensureSeatTokens(room);
  rooms.set(code, room);
  return { ok: true, room };
}

/** Compat: createRoom always returned room before — wrappers use createRoomSafe. */
export function createRoomOrThrow() {
  const r = createRoom();
  if (!r.ok) {
    const err = new Error(r.error || "SERVER_BUSY");
    err.code = r.error;
    throw err;
  }
  return r.room;
}

/** @returns {Room|null} */
export function getRoom(code) {
  if (!code) return null;
  return rooms.get(String(code).trim().toUpperCase()) || null;
}

export function deleteRoom(code) {
  rooms.delete(code);
}

export function pruneOldRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
  }
}

/** @returns {0|1|null} */
export function seatForSocket(room, socketId) {
  if (room.sockets[0] === socketId) return 0;
  if (room.sockets[1] === socketId) return 1;
  return null;
}

/**
 * @returns {{ ok: true, seat: 0|1, room: Room } | { ok: false, error: string }}
 */
export function joinRoom(code, socketId, preferSeat = null, seatToken = null) {
  pruneOldRooms();
  let room = getRoom(code);

  if (!room) return { ok: false, error: "ROOM_NOT_FOUND" };

  const existing = seatForSocket(room, socketId);
  if (existing !== null) {
    touchLastSeen(room, existing);
    return {
      ok: true,
      seat: existing,
      room,
      reconnected: true,
      seatToken: seatTokenFor(room, existing),
    };
  }

  if (preferSeat === 0 || preferSeat === 1) {
    ensureSeatTokens(room);
    const tokenOk = !seatToken || room.seatTokens[preferSeat] === seatToken;
    if (!tokenOk) return { ok: false, error: "BAD_SEAT_TOKEN" };
    // Reconecta se assento livre OU mesmo token (socket antigo caiu).
    if (!room.sockets[preferSeat] || (seatToken && room.seatTokens[preferSeat] === seatToken)) {
      room.sockets[preferSeat] = socketId;
      touchLastSeen(room, preferSeat);
      return {
        ok: true,
        seat: preferSeat,
        room,
        reconnected: true,
        seatToken: seatTokenFor(room, preferSeat),
      };
    }
  }

  if (!room.sockets[0]) {
    room.sockets[0] = socketId;
    touchLastSeen(room, 0);
    return { ok: true, seat: 0, room, seatToken: seatTokenFor(room, 0) };
  }
  if (!room.sockets[1]) {
    room.sockets[1] = socketId;
    touchLastSeen(room, 1);
    return { ok: true, seat: 1, room, seatToken: seatTokenFor(room, 1) };
  }
  return { ok: false, error: "ROOM_FULL" };
}

export function touchLastSeen(room, seat) {
  if (!room.lastSeen) room.lastSeen = [0, 0];
  if (seat === 0 || seat === 1) room.lastSeen[seat] = Date.now();
}

/** Queda de conexão — preserva partida para reconexão. */
export function disconnectSocket(room, socketId) {
  const seat = seatForSocket(room, socketId);
  if (seat === null) return null;
  room.sockets[seat] = null;
  return { deleted: false, seat, disconnected: true };
}

/** Saída voluntária — limpa assento e encerra sala se vazia. */
export function leaveRoom(room, socketId) {
  const seat = seatForSocket(room, socketId);
  if (seat === null) return null;
  room.sockets[seat] = null;
  room.ready[seat] = false;
  room.heroes[seat] = null;
  if (!room.sockets[0] && !room.sockets[1]) {
    deleteRoom(room.code);
    return { deleted: true, seat };
  }
  if (room.status === "playing" && !room.sockets[0] && !room.sockets[1]) {
    room.status = "ended";
  }
  return { deleted: false, seat };
}

/**
 * Vista pública. Em lobby não envia gameState (Fase 2 — payload leve).
 * Em playing, includeGameState=false para broadcasts de lobby-like.
 * Fog-of-war: mãos adversárias projetadas por seat.
 */
export function roomPublicView(room, yourSeat = null, opts = {}) {
  const includeGame =
    opts.includeGameState !== false && room.status === "playing";
  let gameState = includeGame ? room.gameState || null : null;
  if (gameState && (yourSeat === 0 || yourSeat === 1)) {
    try {
      gameState = JSON.parse(JSON.stringify(gameState));
      for (let i = 0; i < (gameState.players || []).length; i++) {
        if (i === yourSeat) continue;
        const pl = gameState.players[i];
        if (!pl?.hand) continue;
        const n = pl.hand.length;
        pl.hand = Array.from({ length: n }, () => ({ fog: true, category: "hidden" }));
        if (Array.isArray(pl.deck)) {
          pl.deckCount = pl.deck.length;
          pl.deck = [];
        }
      }
    } catch (e2) { /* keep raw */ }
  }
  return {
    code: room.code,
    status: room.status,
    winPoints: room.winPoints,
    players: [
      {
        seat: 0,
        connected: !!room.sockets[0],
        heroId: room.heroes[0],
        ready: room.ready[0],
        isYou: yourSeat === 0,
      },
      {
        seat: 1,
        connected: !!room.sockets[1],
        heroId: room.heroes[1],
        ready: room.ready[1],
        isYou: yourSeat === 1,
      },
    ],
    bothConnected: !!(room.sockets[0] && room.sockets[1]),
    canStart:
      room.status === "lobby" &&
      !!(room.sockets[0] && room.sockets[1]) &&
      room.heroes[0] &&
      room.heroes[1] &&
      room.ready[0] &&
      room.ready[1],
    actionSeq: room.actionSeq || 0,
    turnDeadline: room.turnDeadline || null,
    arenaScenarioId: room.arenaScenarioId || null,
    gameState,
    seatToken: yourSeat === 0 || yourSeat === 1 ? seatTokenFor(room, yourSeat) : null,
  };
}

export function canHostStart(room, socketId) {
  return room.sockets[0] === socketId && roomPublicView(room).canStart;
}

export function listRoomsCount() {
  return rooms.size;
}

export function listActiveMatchCount() {
  let n = 0;
  for (const room of rooms.values()) {
    if (room.status === "playing") n += 1;
  }
  return n;
}

/** Restaura sala persistida (sem sockets — reconexão preenche assentos). */
export function importPersistedRoom(data) {
  if (!data?.code || rooms.has(data.code)) return null;
  if (rooms.size >= MAX_ROOMS) return null;
  const room = {
    code: data.code,
    createdAt: data.createdAt || Date.now(),
    status: data.status || "playing",
    sockets: [null, null],
    heroes: data.heroes || [null, null],
    winPoints: data.winPoints ?? 15,
    ready: data.ready || [false, false],
    lastSnapshot: data.lastSnapshot || null,
    gameState: data.gameState || null,
    eventLog: data.eventLog || [],
    actionSeq: data.actionSeq || 0,
    turnDeadline: data.turnDeadline || null,
    turnTimer: null,
    deckSeed: data.deckSeed != null ? data.deckSeed : null,
    arenaScenarioId: data.arenaScenarioId || null,
    ranked: !!data.ranked,
    rankedPlayerIds: data.rankedPlayerIds || null,
    seatTokens: data.seatTokens || [null, null],
    lastSeen: [0, 0],
    aiControlled: [false, false],
  };
  ensureSeatTokens(room);
  rooms.set(room.code, room);
  return room;
}

export function listPlayingRooms() {
  return [...rooms.values()].filter((r) => r.status === "playing");
}
