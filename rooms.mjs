/**
 * Salas 1v1 — código DRAGON-XXXX
 */

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

/** @typedef {{ id: string, seat: 0|1, name: string, heroId: string|null, ready: boolean }} RoomPlayer */
/** @typedef {{
 *   code: string,
 *   createdAt: number,
 *   status: 'lobby'|'playing'|'ended',
 *   sockets: [string|null, string|null],
 *   heroes: [string|null, string|null],
 *   winPoints: number,
 *   ready: [boolean, boolean],
 *   lastSnapshot: object|null,
 *   actionSeq: number,
 * }} Room */

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

/** @returns {Room} */
export function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    status: "lobby",
    sockets: [null, null],
    heroes: [null, null],
    winPoints: 15,
    ready: [false, false],
    lastSnapshot: null,
    actionSeq: 0,
  };
  rooms.set(code, room);
  return room;
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
export function joinRoom(code, socketId, preferCreate = false) {
  pruneOldRooms();
  let room = getRoom(code);

  if (!room && preferCreate) {
    room = createRoom();
    if (code && code !== room.code) {
      rooms.delete(room.code);
      room.code = String(code).trim().toUpperCase();
      rooms.set(room.code, room);
    }
  }

  if (!room) return { ok: false, error: "ROOM_NOT_FOUND" };

  const existing = seatForSocket(room, socketId);
  if (existing !== null) return { ok: true, seat: existing, room };

  if (!room.sockets[0]) {
    room.sockets[0] = socketId;
    return { ok: true, seat: 0, room };
  }
  if (!room.sockets[1]) {
    room.sockets[1] = socketId;
    return { ok: true, seat: 1, room };
  }
  return { ok: false, error: "ROOM_FULL" };
}

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
  if (room.status === "playing") room.status = "lobby";
  return { deleted: false, seat };
}

export function roomPublicView(room, yourSeat = null) {
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
  };
}

export function canHostStart(room, socketId) {
  return room.sockets[0] === socketId && roomPublicView(room).canStart;
}

export function listRoomsCount() {
  return rooms.size;
}
