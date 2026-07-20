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
  disconnectSocket,
  roomPublicView,
  seatForSocket,
  canHostStart,
  listRoomsCount,
  importPersistedRoom,
  listPlayingRooms,
} from "./rooms.mjs";
import {
  addToQueue,
  removeFromQueue,
  takePair,
  isInQueue,
} from "./matchmaking.mjs";
import {
  initRankedMatchmaking,
  shutdownRankedMatchmaking,
  addToRankedQueue,
  removeFromRankedQueue,
  isInRankedQueue,
  getMatchmakingMode,
} from "./bullmq-matchmaking.mjs";
import { getMmr, getRankedProfile, recordRankedMatch } from "./df-ranked-store.mjs";
import { initPostgres, isPostgresEnabled, getReplayByRoomCode, shutdownPostgres } from "./df-postgres.mjs";
import { initAuthStore, getAuthStoreMode } from "./df-auth.mjs";
import { authPlayerFromToken } from "./df-auth-store.mjs";
import { recordMatchEnd } from "./df-match-history.mjs";
import { applyAuthoritativeAction, seedRoomFromSnapshot, buildReplayPayload } from "./df-authority.mjs";
import { loadPersistedRooms, schedulePersistRooms, flushPersistRooms } from "./room-persist.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { readGameVersion } from "./df-game-version.mjs";
import { createInitialMatchState } from "./df-match-init.mjs";
import { registerAuthRoutes } from "./df-auth.mjs";
import { logMailStatusOnBoot, isMailConfigured } from "./df-auth-mail.mjs";
import {
  validateJoinRoom,
  validateSetHero,
  validateSetWinPoints,
  validateSetReady,
  validateGameAction,
  validateGetReplay,
  validateJoinRankedQueue,
} from "./df-schema.mjs";

const PORT = Number(process.env.PORT) || 8787;
const corsOrigin = process.env.CORS_ORIGIN || "*";
const GAME_VERSION = readGameVersion();
const TURN_TIMEOUT_MS = Number(process.env.DF_TURN_TIMEOUT_MS) || 70000;

const actionRateLimit = createRateLimiter({ maxPerWindow: 28, windowMs: 1000 });

const restoredRooms = loadPersistedRooms();
for (const saved of restoredRooms) {
  importPersistedRoom(saved);
}
if (restoredRooms.length) {
  console.log(`[persist] ${restoredRooms.length} sala(s) em jogo restaurada(s)`);
}

function touchPersist() {
  schedulePersistRooms(listPlayingRooms);
}

const app = express();
app.use((req, res, next) => {
  const origin = corsOrigin === "*" ? "*" : corsOrigin;
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "48kb" }));
registerAuthRoutes(app);
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "dragonfall-multiplayer",
    version: 1,
    rooms: listRoomsCount(),
  });
});
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    gameVersion: GAME_VERSION,
    rooms: listRoomsCount(),
    matchmaking: getMatchmakingMode(),
    postgres: isPostgresEnabled(),
    authStore: getAuthStoreMode(),
    mailConfigured: isMailConfigured(),
  });
});

app.get("/history/replay/:code", async (req, res) => {
  if (!isPostgresEnabled()) {
    return res.status(503).json({ ok: false, error: "POSTGRES_DISABLED" });
  }
  try {
    const row = await getReplayByRoomCode(req.params.code);
    if (!row) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    res.json({
      ok: true,
      roomCode: row.room_code,
      endedAt: row.ended_at,
      winnerSeat: row.winner_seat,
      heroes: [row.hero_0, row.hero_1],
      ranked: row.ranked,
      actionSeq: row.action_seq,
      gameVersion: row.game_version,
      eventLog: row.event_log,
      gameState: row.final_state,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "QUERY_FAILED" });
  }
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
  if (room.heroes[0] === room.heroes[1]) return null;
  room.winPoints = 15;
  room.status = "playing";
  room.actionSeq = 0;
  room.eventLog = room.eventLog || [];
  room.ready = [true, true];
  const firstPlayer = Math.random() < 0.5 ? 0 : 1;
  const deckSeed = Math.floor(Math.random() * 2147483646) + 1;
  const gameState = createInitialMatchState({
    heroIds: [room.heroes[0], room.heroes[1]],
    winPoints: room.winPoints,
    firstPlayer,
    deckSeed,
  });
  room.gameState = gameState;
  room.lastSnapshot = { state: gameState, full: true };
  room.deckSeed = deckSeed;
  const match = {
    heroIds: [room.heroes[0], room.heroes[1]],
    winPoints: room.winPoints,
    firstPlayer,
    deckSeed,
    gameState,
  };
  for (let seat = 0; seat < 2; seat++) {
    const sid = room.sockets[seat];
    if (!sid) continue;
    io.to(sid).emit("match_start", { ...match, yourSeat: seat });
  }
  broadcastRoomState(room);
  resetTurnTimer(room);
  return match;
}

function pairRankedSockets(io, entry0, entry1) {
  const sid0 = entry0.socketId;
  const sid1 = entry1.socketId;
  const room = createRoom();
  room.ranked = true;
  room.rankedPlayerIds = [entry0.playerId, entry1.playerId];
  room.winPoints = 15;
  room.sockets[0] = sid0;
  room.sockets[1] = sid1;
  socketRoom.set(sid0, room.code);
  socketRoom.set(sid1, room.code);
  const s0 = io.sockets.sockets.get(sid0);
  const s1 = io.sockets.sockets.get(sid1);
  s0?.join(room.code);
  s1?.join(room.code);
  io.to(sid0).emit("ranked_match_found", {
    ...roomPublicView(room, 0),
    seat: 0,
    mmr: entry0.mmr,
    opponentMmr: entry1.mmr,
  });
  io.to(sid1).emit("ranked_match_found", {
    ...roomPublicView(room, 1),
    seat: 1,
    mmr: entry1.mmr,
    opponentMmr: entry0.mmr,
  });
  broadcastRoomState(room);
}

function maybeFinishMatch(room, state) {
  if (!room || state?.winner == null) return null;
  if (!room.matchHistoryRecorded) {
    room.matchHistoryRecorded = true;
    room.status = "ended";
    void recordMatchEnd(room, state, GAME_VERSION);
  }
  return maybeRecordRankedResult(room, state);
}

function maybeRecordRankedResult(room, state) {
  if (!room?.ranked || room.rankedRecorded || state?.winner == null) return null;
  const wSeat = state.winner;
  const lSeat = wSeat === 0 ? 1 : 0;
  const winnerId = room.rankedPlayerIds?.[wSeat];
  const loserId = room.rankedPlayerIds?.[lSeat];
  if (!winnerId || !loserId) return null;
  room.rankedRecorded = true;
  const result = recordRankedMatch(winnerId, loserId);
  emitRoom(room, "ranked_result", result);
  return result;
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

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnDeadline = null;
}

function resetTurnTimer(room) {
  clearTurnTimer(room);
  if (room.status !== "playing" || !room.gameState?.players) return;
  room.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  room.turnTimer = setTimeout(() => {
    const cp = room.gameState?.currentPlayer;
    if (cp == null || room.status !== "playing") return;
    const result = applyAuthoritativeAction(room, cp, { type: "END_TURN", playerId: cp });
    if (!result.ok) return;
    room.actionSeq += 1;
    const envelope = {
      seq: room.actionSeq,
      fromSeat: cp,
      action: { type: "END_TURN", playerId: cp },
      authoritativeState: result.state || null,
      events: result.events || [],
      logEntry: result.logEntry || null,
      forced: true,
    };
    if (result.state) room.lastSnapshot = { state: result.state, full: true };
    emitRoom(room, "remote_action", envelope);
    broadcastRoomState(room);
    resetTurnTimer(room);
    touchPersist();
    maybeFinishMatch(room, result.state);
  }, TURN_TIMEOUT_MS);
}

function replayPayload(room) {
  return buildReplayPayload(room);
}

io.on("connection", (socket) => {
  socket.emit("hello", {
    ok: true,
    serverVersion: 1,
    gameVersion: GAME_VERSION,
    protocolVersion: 2,
    turnTimeoutMs: TURN_TIMEOUT_MS,
  });

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
    const schema = validateJoinRoom(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
    const code = payload?.code;
    const joined = joinRoom(code, socket.id, payload?.preferSeat);
    if (!joined.ok) {
      ack?.({ ok: false, error: joined.error });
      return;
    }
    socketRoom.set(socket.id, joined.room.code);
    socket.join(joined.room.code);
    const view = roomPublicView(joined.room, joined.seat);
    const replay = replayPayload(joined.room);
    ack?.({
      ok: true,
      ...view,
      seat: joined.seat,
      reconnected: !!joined.reconnected,
      replay,
      gameVersion: GAME_VERSION,
    });
    broadcastRoomState(joined.room);
    if (joined.room.status === "playing") resetTurnTimer(joined.room);
  });

  socket.on("set_hero", (payload, ack) => {
    const schema = validateSetHero(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    if (room.status !== "lobby") return ack?.({ ok: false, error: "NOT_LOBBY" });
    const heroId = payload?.heroId;
    if (!heroId || typeof heroId !== "string") return ack?.({ ok: false, error: "BAD_HERO" });
    const otherSeat = seat === 0 ? 1 : 0;
    if (room.heroes[otherSeat] && room.heroes[otherSeat] === heroId) {
      return ack?.({ ok: false, error: "HERO_TAKEN", takenBy: otherSeat });
    }
    room.heroes[seat] = heroId;
    room.ready[seat] = false;
    broadcastRoomState(room);
    if (room.heroes[0] && room.heroes[1]) {
      startMatchForRoom(room, io);
    }
    ack?.({ ok: true });
  });

  socket.on("set_win_points", (payload, ack) => {
    const schema = validateSetWinPoints(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
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
    const schema = validateSetReady(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
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

  socket.on("join_ranked_queue", async (payload, ack) => {
    const schema = validateJoinRankedQueue(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
    removeFromQueue(socket.id);
    removeFromRankedQueue(socket.id);
    const code = socketRoom.get(socket.id);
    if (code) {
      const room = getRoom(code);
      const seat = room ? seatForSocket(room, socket.id) : null;
      if (room && seat !== null) {
        ack?.({ ok: true, matched: true, ...roomPublicView(room, seat), seat, ranked: !!room.ranked });
        return;
      }
    }
    leaveSocketRoom(socket);
    let playerId = schema.playerId || null;
    const tok = payload?.token || payload?.authToken;
    if (tok) {
      try {
        const account = await authPlayerFromToken(String(tok));
        if (account?.id) playerId = account.id;
      } catch (e) { /* keep schema playerId */ }
    }
    if (!playerId) playerId = `anon-${socket.id.slice(0, 12)}`;
    const info = addToRankedQueue(socket.id, playerId);
    ack?.({
      ok: true,
      inQueue: true,
      ranked: true,
      mmr: info.mmr,
      joinedAt: Date.now(),
      mode: getMatchmakingMode(),
      playerId,
    });
  });

  socket.on("leave_ranked_queue", (_payload, ack) => {
    removeFromRankedQueue(socket.id);
    ack?.({ ok: true });
  });

  socket.on("get_ranked_profile", (payload, ack) => {
    const schema = validateJoinRankedQueue(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
    const playerId = schema.playerId || `anon-${socket.id.slice(0, 12)}`;
    ack?.({ ok: true, playerId, ...getRankedProfile(playerId) });
  });

  socket.on("join_queue", (_payload, ack) => {
    removeFromRankedQueue(socket.id);
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
    removeFromRankedQueue(socket.id);
    ack?.({ ok: true });
  });

  socket.on("game_action", (payload, ack) => {
    if (!actionRateLimit(socket.id)) {
      return ack?.({ ok: false, error: "RATE_LIMIT" });
    }
    const schema = validateGameAction(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });

    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    if (room.status !== "playing") return ack?.({ ok: false, error: "NOT_PLAYING" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });

    const action = schema.action;
    if (action.playerId !== undefined && action.playerId !== seat) {
      return ack?.({ ok: false, error: "WRONG_PLAYER" });
    }
    action.playerId = seat;

    const result = applyAuthoritativeAction(room, seat, action, payload?.snapshot || null);
    if (!result.ok) {
      return ack?.({ ok: false, error: result.error || "ILLEGAL_ACTION" });
    }

    room.actionSeq += 1;
    const envelope = {
      seq: room.actionSeq,
      fromSeat: seat,
      action,
      snapshot: payload?.snapshot || null,
      authoritativeState: result.state || null,
      events: result.events || [],
      logEntry: result.logEntry || null,
      delegated: !!result.delegated,
      skip: !!result.skip,
    };
    if (result.state) {
      room.lastSnapshot = { state: result.state, full: true };
    }

    for (let s = 0; s < 2; s++) {
      const sid = room.sockets[s];
      if (!sid || sid === socket.id) continue;
      io.to(sid).emit("remote_action", envelope);
    }

    resetTurnTimer(room);
    touchPersist();
    maybeFinishMatch(room, result.state);

    ack?.({
      ok: true,
      seq: room.actionSeq,
      authoritativeState: result.state || null,
      events: result.events || [],
      logEntry: result.logEntry || null,
      skip: !!result.skip,
    });
  });

  socket.on("get_replay", (payload, ack) => {
    const schema = validateGetReplay(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const fromSeq = Number(payload?.fromSeq) || 0;
    const full = buildReplayPayload(room);
    if (!full) return ack?.({ ok: false, error: "NOT_PLAYING" });
    ack?.({
      ok: true,
      seq: full.seq,
      entries: full.entries.filter((e) => e.seq > fromSeq),
      snapshot: full.snapshot,
      gameState: full.gameState,
      heroIds: full.heroIds,
    });
  });

  socket.on("sync_snapshot", (payload) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room || room.status !== "playing") return;
    if (payload?.snapshot) seedRoomFromSnapshot(room, payload.snapshot);
  });

  socket.on("leave_room", (_payload, ack) => {
    removeFromQueue(socket.id);
    removeFromRankedQueue(socket.id);
    leaveSocketRoom(socket);
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    removeFromRankedQueue(socket.id);
    const code = socketRoom.get(socket.id);
    const room = getRoom(code);
    if (!room) return;
    const info = disconnectSocket(room, socket.id);
    socketRoom.delete(socket.id);
    emitRoom(room, "peer_disconnected", { seat: info?.seat, canReconnect: room.status === "playing" });
    broadcastRoomState(room);
    touchPersist();
  });
});

process.on("SIGINT", () => {
  shutdownRankedMatchmaking();
  void shutdownPostgres();
  flushPersistRooms(listPlayingRooms);
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdownRankedMatchmaking();
  void shutdownPostgres();
  flushPersistRooms(listPlayingRooms);
  process.exit(0);
});

await initPostgres();
await initAuthStore();
await initRankedMatchmaking(async (entry0, entry1) => {
  pairRankedSockets(io, entry0, entry1);
});

httpServer.listen(PORT, () => {
  console.log(`Dragonfall server em http://localhost:${PORT}`);
  console.log(`WebSocket (Socket.IO) na mesma porta`);
  logMailStatusOnBoot();
});
