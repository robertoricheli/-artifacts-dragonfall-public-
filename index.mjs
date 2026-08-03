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
  createRoomOrThrow,
  getRoom,
  joinRoom,
  leaveRoom,
  disconnectSocket,
  roomPublicView,
  seatForSocket,
  canHostStart,
  listRoomsCount,
  listActiveMatchCount,
  importPersistedRoom,
  listPlayingRooms,
  touchLastSeen,
} from "./rooms.mjs";
import {
  addToQueue,
  removeFromQueue,
  takePair,
  isInQueue,
  queueSize,
} from "./matchmaking.mjs";
import {
  initRankedMatchmaking,
  shutdownRankedMatchmaking,
  addToRankedQueue,
  removeFromRankedQueue,
  isInRankedQueue,
  getMatchmakingMode,
} from "./bullmq-matchmaking.mjs";
import { rankedQueueSize } from "./matchmaking-ranked.mjs";
import {
  getMmr,
  getRankedProfile,
  recordRankedMatch,
  initRankedStoreSchema,
  rankedStoreMode,
} from "./df-ranked-store.mjs";
import { initPostgres, isPostgresEnabled, getReplayByRoomCode, shutdownPostgres } from "./df-postgres.mjs";
import { initAuthStore, getAuthStoreMode } from "./df-auth.mjs";
import { authPlayerFromToken, startSessionPruneScheduler } from "./df-auth-store.mjs";
import { recordMatchEnd } from "./df-match-history.mjs";
import { applyAuthoritativeAction, seedRoomFromSnapshot, buildReplayPayload, getEngineBootStatus } from "./df-authority.mjs";
import { loadPersistedRooms, schedulePersistRooms, flushPersistRooms } from "./room-persist.mjs";
import {
  initLiveRoomsSchema,
  scheduleLiveRoomPersist,
  flushAllLiveRooms,
  loadLiveRoomsFromPg,
  deleteLiveRoom,
} from "./df-live-rooms.mjs";
import {
  recordActionLatency,
  recordReject,
  recordDisconnect,
  getActionStats,
  logMp,
  startSelfKeepAlive,
} from "./df-mp-metrics.mjs";
import { allowSync, MAX_ROOMS, MAX_QUEUE } from "./df-mp-limits.mjs";
import { ensureSeatTokens, seatTokenFor } from "./df-seat-token.mjs";
import {
  redisConfigured,
  attachSocketRedisAdapter,
  isRedisAdapterAttached,
} from "./df-socket-redis.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { readGameVersion } from "./df-game-version.mjs";
import { createInitialMatchState } from "./df-match-init.mjs";
import { registerAuthRoutes } from "./df-auth.mjs";
import { logMailStatusOnBoot, isMailConfigured } from "./df-auth-mail.mjs";
import {
  markSeatDisconnectedForAi,
  onHumanReconnectedClearAi,
  scheduleServerAi,
  clearAllAi,
} from "./df-server-ai.mjs";
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
const corsOriginRaw = process.env.CORS_ORIGIN || "*";
const corsAllowList = corsOriginRaw.split(",").map((s) => s.trim()).filter(Boolean);
const GAME_VERSION = readGameVersion();
const TURN_TIMEOUT_MS = Number(process.env.DF_TURN_TIMEOUT_MS) || 70000;

const actionRateLimit = createRateLimiter({ maxPerWindow: 28, windowMs: 1000 });

function resolveCorsOrigin(reqOrigin) {
  if (corsAllowList.includes("*")) return "*";
  if (reqOrigin && corsAllowList.includes(reqOrigin)) return reqOrigin;
  return corsAllowList[0] || "null";
}

const restoredRooms = loadPersistedRooms();
for (const saved of restoredRooms) {
  importPersistedRoom(saved);
}
if (restoredRooms.length) {
  console.log(`[persist] ${restoredRooms.length} sala(s) em jogo restaurada(s)`);
}

function touchPersist(room = null) {
  // Produção com Postgres: live rooms é a fonte; JSON só em fallback local.
  if (!isPostgresEnabled()) {
    schedulePersistRooms(listPlayingRooms);
  }
  if (room) scheduleLiveRoomPersist(room);
  else {
    for (const r of listPlayingRooms()) scheduleLiveRoomPersist(r);
  }
}

const app = express();
app.use((req, res, next) => {
  const origin = resolveCorsOrigin(req.headers.origin);
  res.header("Access-Control-Allow-Origin", origin);
  if (origin !== "*") res.header("Vary", "Origin");
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
  const stats = getActionStats();
  const motor = getEngineBootStatus();
  const body = {
    ok: !!motor.motorOk,
    motorOk: !!motor.motorOk,
    motorError: motor.error || null,
    gameVersion: GAME_VERSION,
    rooms: listRoomsCount(),
    activeMatches: listActiveMatchCount(),
    queueCasual: queueSize(),
    queueRanked: rankedQueueSize(),
    maxRooms: MAX_ROOMS,
    maxQueue: MAX_QUEUE,
    matchmaking: getMatchmakingMode(),
    rankedStore: rankedStoreMode(),
    postgres: isPostgresEnabled(),
    authStore: getAuthStoreMode(),
    mailConfigured: isMailConfigured(),
    avgActionMs: stats.avgActionMs,
    p95ActionMs: stats.p95ActionMs,
    avgPresentationMs: stats.avgPresentationMs,
    p95PresentationMs: stats.p95PresentationMs,
    presentations1m: stats.presentations1m,
    disconnects1m: stats.disconnects1m,
    actions1m: stats.actions1m,
    redisConfigured: redisConfigured(),
    redisAdapter: isRedisAdapterAttached(),
  };
  res.status(motor.motorOk ? 200 : 503).json(body);
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
  cors: {
    origin: corsAllowList.includes("*") ? true : corsAllowList,
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 2e6,
  // Mobile/abas em segundo plano: evita disconnect falso por ping curto.
  pingInterval: 25000,
  pingTimeout: 60000,
});

/** socket.id -> room code */
const socketRoom = new Map();

function leaveSocketRoom(socket, peerLeftExtra = null) {
  const code = socketRoom.get(socket.id);
  const room = getRoom(code);
  if (room) {
    const info = leaveRoom(room, socket.id);
    socket.leave(room.code);
    emitRoom(room, "peer_left", {
      seat: info?.seat,
      ...(peerLeftExtra && typeof peerLeftExtra === "object" ? peerLeftExtra : {}),
    });
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
  room.eventLog = room.eventLog || [];
  room.ready = [true, true];
  const firstPlayer = Math.random() < 0.5 ? 0 : 1;
  const deckSeed = Math.floor(Math.random() * 2147483646) + 1;
  const arenaPool = [
    "floresta-runica",
    "ceu-e-inferno",
    "arena-cristal",
    "deserto-sem-fim",
    "o-fundo-do-mar",
    "castelo-da-alianca",
  ];
  const arenaScenarioId = arenaPool[Math.floor(Math.random() * arenaPool.length)];
  const gameState = createInitialMatchState({
    heroIds: [room.heroes[0], room.heroes[1]],
    winPoints: room.winPoints,
    firstPlayer,
    deckSeed,
    deckCardNames: room.deckCardNames || null,
  });
  room.gameState = gameState;
  room.lastSnapshot = { state: gameState, full: true };
  room.deckSeed = deckSeed;
  room.arenaScenarioId = arenaScenarioId;
  ensureSeatTokens(room);
  const match = {
    heroIds: [room.heroes[0], room.heroes[1]],
    winPoints: room.winPoints,
    firstPlayer,
    deckSeed,
    arenaScenarioId,
    gameState,
  };
  for (let seat = 0; seat < 2; seat++) {
    const sid = room.sockets[seat];
    if (!sid) continue;
    io.to(sid).emit("match_start", {
      ...match,
      yourSeat: seat,
      seatToken: seatTokenFor(room, seat),
      code: room.code,
    });
  }
  broadcastRoomState(room);
  resetTurnTimer(room);
  touchPersist(room);
  return match;
}

function pairRankedSockets(io, entry0, entry1) {
  const sid0 = entry0.socketId;
  const sid1 = entry1.socketId;
  let room;
  try {
    room = createRoomOrThrow();
  } catch (e) {
    logMp("pair_ranked_busy", { error: e?.message });
    return;
  }
  room.ranked = true;
  room.rankedPlayerIds = [entry0.playerId, entry1.playerId];
  room.winPoints = 15;
  room.sockets[0] = sid0;
  room.sockets[1] = sid1;
  ensureSeatTokens(room);
  socketRoom.set(sid0, room.code);
  socketRoom.set(sid1, room.code);
  const s0 = io.sockets.sockets.get(sid0);
  const s1 = io.sockets.sockets.get(sid1);
  s0?.join(room.code);
  s1?.join(room.code);
  io.to(sid0).emit("ranked_match_found", {
    ...roomPublicView(room, 0),
    seat: 0,
    seatToken: seatTokenFor(room, 0),
    mmr: entry0.mmr,
    opponentMmr: entry1.mmr,
  });
  io.to(sid1).emit("ranked_match_found", {
    ...roomPublicView(room, 1),
    seat: 1,
    seatToken: seatTokenFor(room, 1),
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
    void deleteLiveRoom(room.code);
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
    let room;
    try {
      room = createRoomOrThrow();
    } catch (e) {
      logMp("pair_casual_busy", { error: e?.message });
      break;
    }
    room.winPoints = 15;
    room.sockets[0] = sid0;
    room.sockets[1] = sid1;
    ensureSeatTokens(room);
    socketRoom.set(sid0, room.code);
    socketRoom.set(sid1, room.code);
    const s0 = io.sockets.sockets.get(sid0);
    const s1 = io.sockets.sockets.get(sid1);
    s0?.join(room.code);
    s1?.join(room.code);
    io.to(sid0).emit("match_found", {
      ...roomPublicView(room, 0),
      seat: 0,
      seatToken: seatTokenFor(room, 0),
    });
    io.to(sid1).emit("match_found", {
      ...roomPublicView(room, 1),
      seat: 1,
      seatToken: seatTokenFor(room, 1),
    });
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
    // Em playing, ainda manda gameState no room_state (reconciliação); lobby é leve.
    io.to(sid).emit("room_state", roomPublicView(room, seat));
  }
}

function emitActionEnvelope(room, envelope) {
  for (let s = 0; s < 2; s++) {
    const sid = room.sockets[s];
    if (!sid) continue;
    io.to(sid).emit("remote_action", envelope);
  }
}

function afterAuthoritativeAction(room, state) {
  broadcastRoomState(room);
  resetTurnTimer(room);
  touchPersist(room);
  maybeFinishMatch(room, state);
  if (room.status === "playing" && state?.winner == null) {
    scheduleServerAi(room, io, {
      emitEnvelope: emitActionEnvelope,
      onAfterAction: afterAuthoritativeAction,
    });
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
    touchPersist(room);
    maybeFinishMatch(room, result.state);
    scheduleServerAi(room, io, {
      emitEnvelope: emitActionEnvelope,
      onAfterAction: afterAuthoritativeAction,
    });
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
    let room;
    try {
      room = createRoomOrThrow();
    } catch (e) {
      ack?.({ ok: false, error: e?.code || e?.message || "SERVER_BUSY" });
      return;
    }
    const joined = joinRoom(room.code, socket.id, false);
    if (!joined.ok) {
      ack?.({ ok: false, error: joined.error });
      return;
    }
    socketRoom.set(socket.id, room.code);
    socket.join(room.code);
    const view = roomPublicView(room, joined.seat);
    ack?.({
      ok: true,
      ...view,
      seat: joined.seat,
      seatToken: joined.seatToken || seatTokenFor(room, joined.seat),
    });
    broadcastRoomState(room);
  });

  socket.on("join_room", (payload, ack) => {
    const schema = validateJoinRoom(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
    const code = payload?.code;
    const seatToken = payload?.seatToken ? String(payload.seatToken) : null;
    const joined = joinRoom(code, socket.id, payload?.preferSeat, seatToken);
    if (!joined.ok) {
      ack?.({ ok: false, error: joined.error });
      return;
    }
    socketRoom.set(socket.id, joined.room.code);
    socket.join(joined.room.code);
    touchLastSeen(joined.room, joined.seat);
    const view = roomPublicView(joined.room, joined.seat);
    const replay = replayPayload(joined.room);
    ack?.({
      ok: true,
      ...view,
      seat: joined.seat,
      seatToken: joined.seatToken || seatTokenFor(joined.room, joined.seat),
      reconnected: !!joined.reconnected,
      replay,
      gameVersion: GAME_VERSION,
    });
    broadcastRoomState(joined.room);
    if (joined.reconnected) {
      onHumanReconnectedClearAi(joined.room, joined.seat, io);
    }
    if (joined.room.status === "playing") {
      resetTurnTimer(joined.room);
      scheduleServerAi(joined.room, io, {
        emitEnvelope: emitActionEnvelope,
        onAfterAction: afterAuthoritativeAction,
      });
    }
  });

  socket.on("match_ping", (_payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    touchLastSeen(room, seat);
    ack?.({ ok: true, serverTime: Date.now(), turnDeadline: room.turnDeadline || null });
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
    // Rankeado: mesmos heróis permitidos nos dois assentos.
    room.heroes[seat] = heroId;
    room.ready[seat] = false;
    if (!room.deckCardNames) room.deckCardNames = [null, null];
    if (Array.isArray(payload?.deckCardNames) && payload.deckCardNames.length >= 10) {
      room.deckCardNames[seat] = payload.deckCardNames
        .map((n) => String(n || "").trim())
        .filter(Boolean)
        .slice(0, 24);
    }
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
    if (info?.ok === false) {
      ack?.({ ok: false, error: info.error || "SERVER_BUSY" });
      return;
    }
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
    const queued = addToQueue(socket.id);
    if (queued?.ok === false) {
      ack?.({ ok: false, error: queued.error || "SERVER_BUSY" });
      return;
    }
    pairQueueSockets(io);
    const paired = socketRoom.get(socket.id);
    if (paired) {
      const room = getRoom(paired);
      const seat = seatForSocket(room, socket.id);
      ack?.({
        ok: true,
        matched: true,
        ...roomPublicView(room, seat),
        seat,
        seatToken: seatTokenFor(room, seat),
      });
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
    const t0 = Date.now();
    const actionType = payload?.action?.type || payload?.type;
    const skipRate =
      actionType === "SYNC_STATE" ||
      actionType === "PLAY_VISUAL" ||
      actionType === "ATTACK_START" ||
      actionType === "ATTACK_PICK_ATTACKER" ||
      actionType === "ATTACK_PICK_DEFENDER";
    if (actionType === "SYNC_STATE" && !allowSync(socket.id)) {
      return ack?.({ ok: false, error: "SYNC_RATE" });
    }
    if (!skipRate && !actionRateLimit(socket.id)) {
      recordReject("RATE_LIMIT", { type: actionType });
      return ack?.({ ok: false, error: "RATE_LIMIT" });
    }
    const schema = validateGameAction(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });

    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    if (room.status !== "playing") return ack?.({ ok: false, error: "NOT_PLAYING" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    touchLastSeen(room, seat);

    const action = schema.action;
    if (action.playerId !== undefined && action.playerId !== seat) {
      return ack?.({ ok: false, error: "WRONG_PLAYER" });
    }
    action.playerId = seat;

    // Idempotência: cliente pode reenviar o mesmo clientActionId após ACK_TIMEOUT.
    const clientActionId = payload?.clientActionId != null
      ? String(payload.clientActionId)
      : (action.clientActionId != null ? String(action.clientActionId) : null);
    if (clientActionId) {
      if (!room._ackedClientActions) room._ackedClientActions = new Map();
      const prevAck = room._ackedClientActions.get(`${seat}:${clientActionId}`);
      if (prevAck) {
        return ack?.(prevAck);
      }
    }

    const result = applyAuthoritativeAction(room, seat, action, payload?.snapshot || null);
    if (!result.ok) {
      const auth = room.gameState?.players?.length ? room.gameState : null;
      recordReject(result.error || "ILLEGAL_ACTION", {
        roomCode: room.code,
        seat,
        type: action.type,
      });
      recordActionLatency(Date.now() - t0, {
        roomCode: room.code,
        seat,
        type: action.type,
        ok: false,
        error: result.error,
      });
      return ack?.({
        ok: false,
        error: result.error || "ILLEGAL_ACTION",
        authoritativeState: auth,
      });
    }

    room.actionSeq += 1;
    // Delta: peer recebe authoritativeState; snapshot do cliente só em anim/UI.
    // ATTACK_RESOLVE: nunca retransmitir snapshot pré-combate (clobber / revive).
    const sendClientSnap = (action.type === "PLAY_VISUAL" || !!action.anim)
        && action.type !== "ATTACK_RESOLVE";
    const envelope = {
      seq: room.actionSeq,
      fromSeat: seat,
      action,
      snapshot: sendClientSnap ? (payload?.snapshot || null) : null,
      authoritativeState: result.state || room.gameState || null,
      events: result.events || [],
      logEntry: result.logEntry || null,
      delegated: !!result.delegated,
      skip: !!result.skip,
      forfeit: action.type === "SURRENDER",
      presentation: result.presentation || null,
    };
    if (result.state && !result.skip) {
      room.lastSnapshot = { state: result.state, full: true };
    }

    for (let s = 0; s < 2; s++) {
      const sid = room.sockets[s];
      if (!sid || sid === socket.id) continue;
      io.to(sid).emit("remote_action", envelope);
    }

    resetTurnTimer(room);
    touchPersist(room);
    maybeFinishMatch(room, result.state);
    scheduleServerAi(room, io, {
      emitEnvelope: emitActionEnvelope,
      onAfterAction: afterAuthoritativeAction,
    });

    recordActionLatency(Date.now() - t0, {
      roomCode: room.code,
      seat,
      type: action.type,
      seq: room.actionSeq,
      ok: true,
    });

    const ackPayload = {
      ok: true,
      seq: room.actionSeq,
      authoritativeState: result.state || room.gameState || null,
      events: result.events || [],
      logEntry: result.logEntry || null,
      skip: !!result.skip,
      presentation: result.presentation || null,
    };
    if (clientActionId) {
      room._ackedClientActions.set(`${seat}:${clientActionId}`, ackPayload);
      // Limite simples — evita crescimento infinito.
      if (room._ackedClientActions.size > 200) {
        const first = room._ackedClientActions.keys().next().value;
        room._ackedClientActions.delete(first);
      }
    }
    ack?.(ackPayload);
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

  socket.on("sync_snapshot", (payload, ack) => {
    // Gate: só host da sala em playing, com token de assento — sem seed arbitrário.
    const room = getRoom(socketRoom.get(socket.id));
    if (!room || room.status !== "playing") {
      return ack?.({ ok: false, error: "NOT_PLAYING" });
    }
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    // Desabilitado em produção: estado só via game_action autoritativo.
    if (process.env.NODE_ENV === "production" || process.env.DF_ALLOW_SYNC_SNAPSHOT !== "1") {
      logMp("sync_snapshot_denied", { room: room.code, seat });
      return ack?.({ ok: false, error: "SYNC_SNAPSHOT_DISABLED" });
    }
    if (payload?.snapshot) seedRoomFromSnapshot(room, payload.snapshot);
    ack?.({ ok: true, seq: room.actionSeq });
  });

  socket.on("leave_room", (payload, ack) => {
    removeFromQueue(socket.id);
    removeFromRankedQueue(socket.id);
    const room = getRoom(socketRoom.get(socket.id));
    const seat = room ? seatForSocket(room, socket.id) : null;
    let forfeitPayload = null;
    const wantForfeit = !!(payload && typeof payload === "object" && payload.forfeit);
    // Saída voluntária / desistência: vitória imediata do oponente.
    if (room && seat !== null && (room.status === "playing" || room.status === "ended")) {
      if (room.gameState?.winner == null && room.status === "playing") {
        const result = applyAuthoritativeAction(room, seat, { type: "SURRENDER", playerId: seat }, null);
        if (result.ok) {
          room.actionSeq += 1;
          const envelope = {
            seq: room.actionSeq,
            fromSeat: seat,
            action: { type: "SURRENDER", playerId: seat },
            snapshot: null,
            authoritativeState: result.state || null,
            events: result.events || [],
            forfeit: true,
          };
          if (result.state) {
            room.lastSnapshot = { state: result.state, full: true };
          }
          for (let s = 0; s < 2; s++) {
            const sid = room.sockets[s];
            if (!sid || sid === socket.id) continue;
            io.to(sid).emit("remote_action", envelope);
          }
          maybeFinishMatch(room, result.state);
          const winner = result.state?.winner ?? ((seat + 1) % 2);
          forfeitPayload = { forfeit: true, winner, seat };
        }
      } else if (room.gameState?.winner != null || wantForfeit) {
        // SURRENDER já aplicado (status ended) — ainda avisa o peer com forfeit.
        const winner = room.gameState?.winner != null
          ? room.gameState.winner
          : ((seat + 1) % 2);
        forfeitPayload = { forfeit: true, winner, seat };
      }
    }
    leaveSocketRoom(socket, forfeitPayload);
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
    recordDisconnect({
      roomCode: room.code,
      seat: info?.seat,
      playing: room.status === "playing",
    });
    emitRoom(room, "peer_disconnected", { seat: info?.seat, canReconnect: room.status === "playing" });
    if (room.status === "playing" && info?.seat != null) {
      markSeatDisconnectedForAi(room, info.seat, io, {
        emitEnvelope: emitActionEnvelope,
        onAfterAction: afterAuthoritativeAction,
      });
    }
    broadcastRoomState(room);
    touchPersist(room);
  });
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logMp("shutdown", { signal });
  try {
    io.emit("server_restarting", { ok: true, reason: signal, gameVersion: GAME_VERSION });
  } catch (e) { /* */ }
  shutdownRankedMatchmaking();
  try {
    await flushAllLiveRooms(listPlayingRooms);
  } catch (e) { /* */ }
  flushPersistRooms(listPlayingRooms);
  try {
    await shutdownPostgres();
  } catch (e) { /* */ }
  setTimeout(() => process.exit(0), 400);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

await initPostgres();
await initLiveRoomsSchema();
await initRankedStoreSchema();
await initAuthStore();
startSessionPruneScheduler();

// Restaura salas de PG (preferência) além do rooms.json.
try {
  const live = await loadLiveRoomsFromPg();
  let n = 0;
  for (const saved of live) {
    if (importPersistedRoom(saved)) n += 1;
  }
  if (n) console.log(`[live-rooms] ${n} sala(s) restaurada(s) do Postgres`);
} catch (e) {
  console.warn("[live-rooms] restore:", e?.message || e);
}

await initRankedMatchmaking(async (entry0, entry1) => {
  pairRankedSockets(io, entry0, entry1);
});

// Warm motor + Redis adapter antes do listen.
getEngineBootStatus();
await attachSocketRedisAdapter(io);

httpServer.listen(PORT, () => {
  console.log(`Dragonfall server em http://localhost:${PORT}`);
  console.log(`WebSocket (Socket.IO) na mesma porta`);
  logMailStatusOnBoot();
  startSelfKeepAlive(PORT);
  const motor = getEngineBootStatus();
  logMp("boot", {
    gameVersion: GAME_VERSION,
    rooms: listRoomsCount(),
    postgres: isPostgresEnabled(),
    matchmaking: getMatchmakingMode(),
    motorOk: motor.motorOk,
    redisAdapter: isRedisAdapterAttached(),
  });
});
