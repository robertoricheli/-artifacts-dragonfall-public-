/**
 * Dragonfall — servidor multiplayer (Passo 7)
 *
 * Uso local:
 *   cd server && npm install && npm start
 *
 * Variáveis:
 *   PORT=8787 (padrão)
 *   CORS_ORIGIN=* ou lista separada por vírgula
 */
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import {
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  roomPublicView,
  seatForSocket,
  canHostStart,
  listRoomsCount,
} from "./rooms.mjs";
import {
  addToQueue,
  removeFromQueue,
  takePair,
  isInQueue,
} from "./matchmaking.mjs";

const PORT = Number(process.env.PORT) || 8787;
const corsOrigin = process.env.CORS_ORIGIN || "*";

const app = express();
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "dragonfall-multiplayer",
    version: 1,
    rooms: listRoomsCount(),
  });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: corsOrigin, methods: ["GET", "POST"] },
  maxHttpBufferSize: 2e6,
});

/** socket.id -> room code */
const socketRoom = new Map();

function leaveSocketRoom(socket) {
  const code = socketRoom.get(socket.id);
  const room = getRoom(code);
  if (room) {
    const info = leaveRoom(room, socket.id);
    socket.leave(room.code);
    emitRoom(room, "peer_left", { seat: info?.seat });
    broadcastRoomState(room);
  }
  socketRoom.delete(socket.id);
}

function startMatchForRoom(room, io) {
  if (room.status !== "lobby") return null;
  if (!room.sockets[0] || !room.sockets[1]) return null;
  if (!room.heroes[0] || !room.heroes[1]) return null;
  room.winPoints = 15;
  room.status = "playing";
  room.actionSeq = 0;
  room.ready = [true, true];
  const firstPlayer = Math.random() < 0.5 ? 0 : 1;
  const deckSeed = Math.floor(Math.random() * 2147483646) + 1;
  const match = {
    heroIds: [room.heroes[0], room.heroes[1]],
    winPoints: room.winPoints,
    firstPlayer,
    deckSeed,
  };
  for (let seat = 0; seat < 2; seat++) {
    const sid = room.sockets[seat];
    if (!sid) continue;
    io.to(sid).emit("match_start", { ...match, yourSeat: seat });
  }
  broadcastRoomState(room);
  return match;
}

function pairQueueSockets(io) {
  let pair = takePair();
  while (pair) {
    const [sid0, sid1] = pair;
    const room = createRoom();
    room.winPoints = 15;
    room.sockets[0] = sid0;
    room.sockets[1] = sid1;
    socketRoom.set(sid0, room.code);
    socketRoom.set(sid1, room.code);
    const s0 = io.sockets.sockets.get(sid0);
    const s1 = io.sockets.sockets.get(sid1);
    s0?.join(room.code);
    s1?.join(room.code);
    io.to(sid0).emit("match_found", { ...roomPublicView(room, 0), seat: 0 });
    io.to(sid1).emit("match_found", { ...roomPublicView(room, 1), seat: 1 });
    broadcastRoomState(room);
    pair = takePair();
  }
}

function emitRoom(room, event, payload) {
  for (const sid of room.sockets) {
    if (sid) io.to(sid).emit(event, payload);
  }
}

function broadcastRoomState(room) {
  for (let seat = 0; seat < 2; seat++) {
    const sid = room.sockets[seat];
    if (!sid) continue;
    io.to(sid).emit("room_state", roomPublicView(room, seat));
  }
}

io.on("connection", (socket) => {
  socket.emit("hello", { ok: true, serverVersion: 1 });

  socket.on("create_room", (_payload, ack) => {
    const room = createRoom();
    const joined = joinRoom(room.code, socket.id, false);
    if (!joined.ok) {
      ack?.({ ok: false, error: joined.error });
      return;
    }
    socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    const view = roomPublicView(room, joined.seat);
    ack?.({ ok: true, ...view, seat: joined.seat });
    broadcastRoomState(room);
  });

  socket.on("join_room", (payload, ack) => {
    const code = payload?.code;
    const joined = joinRoom(code, socket.id, false);
    if (!joined.ok) {
      ack?.({ ok: false, error: joined.error });
      return;
    }
    socketRoom.set(socket.id, joined.room.code);
    socket.join(joined.room.code);
    ack?.({ ok: true, ...roomPublicView(joined.room, joined.seat), seat: joined.seat });
    broadcastRoomState(joined.room);
  });

  socket.on("set_hero", (payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    if (room.status !== "lobby") return ack?.({ ok: false, error: "NOT_LOBBY" });
    const heroId = payload?.heroId;
    if (!heroId || typeof heroId !== "string") return ack?.({ ok: false, error: "BAD_HERO" });
    room.heroes[seat] = heroId;
    room.ready[seat] = false;
    broadcastRoomState(room);
    if (room.heroes[0] && room.heroes[1]) {
      startMatchForRoom(room, io);
    }
    ack?.({ ok: true });
  });

  socket.on("set_win_points", (payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat !== 0) return ack?.({ ok: false, error: "HOST_ONLY" });
    if (room.status !== "lobby") return ack?.({ ok: false, error: "NOT_LOBBY" });
    const wp = Number(payload?.winPoints);
    if (wp !== 10 && wp !== 15) return ack?.({ ok: false, error: "BAD_WIN_POINTS" });
    room.winPoints = wp;
    broadcastRoomState(room);
    ack?.({ ok: true });
  });

  socket.on("set_ready", (payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    if (room.status !== "lobby") return ack?.({ ok: false, error: "NOT_LOBBY" });
    if (!room.heroes[seat]) return ack?.({ ok: false, error: "PICK_HERO_FIRST" });
    room.ready[seat] = !!payload?.ready;
    broadcastRoomState(room);
    ack?.({ ok: true, canStart: roomPublicView(room).canStart });
  });

  socket.on("start_match", (_payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    if (!canHostStart(room, socket.id)) return ack?.({ ok: false, error: "CANNOT_START" });
    const match = startMatchForRoom(room, io);
    if (!match) return ack?.({ ok: false, error: "CANNOT_START" });
    ack?.({ ok: true, ...match });
  });

  socket.on("join_queue", (_payload, ack) => {
    removeFromQueue(socket.id);
    const code = socketRoom.get(socket.id);
    if (code) {
      const room = getRoom(code);
      const seat = room ? seatForSocket(room, socket.id) : null;
      if (room && seat !== null) {
        ack?.({ ok: true, matched: true, ...roomPublicView(room, seat), seat });
        return;
      }
    }
    leaveSocketRoom(socket);
    addToQueue(socket.id);
    pairQueueSockets(io);
    const paired = socketRoom.get(socket.id);
    if (paired) {
      const room = getRoom(paired);
      const seat = seatForSocket(room, socket.id);
      ack?.({ ok: true, matched: true, ...roomPublicView(room, seat), seat });
      return;
    }
    ack?.({ ok: true, inQueue: true, joinedAt: Date.now() });
  });

  socket.on("leave_queue", (_payload, ack) => {
    removeFromQueue(socket.id);
    ack?.({ ok: true });
  });

  socket.on("game_action", (payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    if (room.status !== "playing") return ack?.({ ok: false, error: "NOT_PLAYING" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });

    const action = payload?.action;
    if (!action || typeof action.type !== "string") {
      return ack?.({ ok: false, error: "BAD_ACTION" });
    }
    if (action.playerId !== undefined && action.playerId !== seat) {
      return ack?.({ ok: false, error: "WRONG_PLAYER" });
    }
    action.playerId = seat;

    room.actionSeq += 1;
    const envelope = {
      seq: room.actionSeq,
      fromSeat: seat,
      action,
      snapshot: payload?.snapshot || null,
    };
    if (payload?.snapshot) room.lastSnapshot = payload.snapshot;

    for (let s = 0; s < 2; s++) {
      const sid = room.sockets[s];
      if (!sid || sid === socket.id) continue;
      io.to(sid).emit("remote_action", envelope);
    }

    ack?.({ ok: true, seq: room.actionSeq });
  });

  socket.on("sync_snapshot", (payload) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room || room.status !== "playing") return;
    if (payload?.snapshot) room.lastSnapshot = payload.snapshot;
  });

  socket.on("leave_room", (_payload, ack) => {
    removeFromQueue(socket.id);
    leaveSocketRoom(socket);
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    const code = socketRoom.get(socket.id);
    const room = getRoom(code);
    if (!room) return;
    const info = leaveRoom(room, socket.id);
    socketRoom.delete(socket.id);
    emitRoom(room, "peer_disconnected", { seat: info?.seat });
    broadcastRoomState(room);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Dragonfall server em http://localhost:${PORT}`);
  console.log(`WebSocket (Socket.IO) na mesma porta`);
});
