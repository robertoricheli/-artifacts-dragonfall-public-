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
  deleteRoom,
  roomPublicView,
  levelFromXp,
  seatForSocket,
  canHostStart,
  listRoomsCount,
  listRoomsByStatus,
  listPlayingRoomCodes,
  listActiveMatchCount,
  importPersistedRoom,
  listPlayingRooms,
  touchLastSeen,
  pruneOldRooms,
} from "./rooms.mjs";
import {
  addToQueue,
  removeFromQueue,
  takePair,
  requeueFront,
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
import { rankedQueueSize, requeueRankedFront } from "./matchmaking-ranked.mjs";
import {
  getMmr,
  getRankedProfile,
  recordRankedMatch,
  initRankedStoreSchema,
  rankedStoreMode,
} from "./df-ranked-store.mjs";
import { initPostgres, isPostgresEnabled, getReplayByRoomCode, shutdownPostgres } from "./df-postgres.mjs";
import { initAuthStore, getAuthStoreMode, setSessionRevokedNotifier } from "./df-auth.mjs";
import { authPlayerFromToken, getPlayerById, startSessionPruneScheduler } from "./df-auth-store.mjs";
import { initRankStore, recordRankedSeasonMatch, flushRankStore, rankStoreMode } from "./df-rank.mjs";
import { recordMatchEnd } from "./df-match-history.mjs";
import { turnDeadlineFor } from "./df-turn-clock.mjs";
import { applyAuthoritativeAction, seedRoomFromSnapshot, buildReplayPayload, buildFinalReplayPayload, getEngineBootStatus, projectStateForSeat, projectEventsForSeat, buildPresentationEnvelope } from "./df-authority.mjs";
import { armApodrecidaTimer, clearApodrecidaTimer } from "./df-apodrecida-timer.mjs";
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import { attachPeerStateDiff } from "./df-state-diff.mjs";
import { loadPersistedRooms, schedulePersistRooms, flushPersistRooms } from "./room-persist.mjs";
import {
  initLiveRoomsSchema,
  scheduleLiveRoomPersist,
  flushAllLiveRooms,
  loadLiveRoomsFromPg,
  deleteLiveRoom,
  deleteStaleLiveRooms,
  deleteOrphanLiveRooms,
} from "./df-live-rooms.mjs";
import {
  recordActionLatency,
  recordPresentSkew,
  recordGapFill,
  recordReject,
  recordDisconnect,
  recordStateDiff,
  getActionStats,
  logMp,
  startSelfKeepAlive,
} from "./df-mp-metrics.mjs";
import { allowSync, MAX_ROOMS, MAX_QUEUE } from "./df-mp-limits.mjs";
import {
  recordPairExclusion,
  exclusionKeyForPlayer,
} from "./df-pair-exclusion.mjs";
import { ensureSeatTokens, seatTokenFor } from "./df-seat-token.mjs";
import {
  redisConfigured,
  attachSocketRedisAdapter,
  isRedisAdapterAttached,
} from "./df-socket-redis.mjs";
import {
  initRoomStore,
  hydrateRoomsFromRedis,
  withRoomLock,
  mirrorRoomNow,
  scheduleRoomMirror,
  roomStoreHealth,
} from "./df-room-store.mjs";
import {
  PROCESS_ROLE,
  isGatewayRole,
  isGameRole,
  processRoleHealth,
} from "./df-process-role.mjs";
import {
  getShardCount,
  getLocalShardId,
  shardIdForRoom,
  thisProcessOwnsRoom,
  rememberRoomShard,
  lookupRoomShard,
  buildShardRedirect,
  shardUrlForRoom,
  getGatewayUrl,
  getGameShardUrls,
  shardHealth,
} from "./df-shard-affinity.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import { readGameVersion, readAiPlannerHash } from "./df-game-version.mjs";
import { createInitialMatchState } from "./df-match-init.mjs";
import { registerAuthRoutes } from "./df-auth.mjs";
import { logMailStatusOnBoot, isMailConfigured } from "./df-auth-mail.mjs";
import {
  markSeatDisconnectedForAi,
  markSeatAbandonedForAi,
  onHumanReconnectedClearAi,
  scheduleServerAi,
  clearAllAi,
  continueAiAfterResume,
} from "./df-server-ai.mjs";
import {
  buildAiReactiveAnswer,
  consumeAiReactiveCard,
} from "./df-server-ai-reactive.mjs";
// Lote F — Bloco 2 (reações C-A05–C-A08): suspensão reativa. A autoridade
// só decide suspender; este módulo orquestra (QUERY, timer 8 s, retomada).
import {
  openReactiveSuspension,
  resolveReactiveSuspension,
  expireReactiveSuspensionLocked,
  reemitReactiveQuery,
} from "./df-reactive-suspend.mjs";
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
const AI_PLANNER_HASH = readAiPlannerHash();
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
  if (room) {
    scheduleLiveRoomPersist(room);
    scheduleRoomMirror(room);
  } else {
    for (const r of listPlayingRooms()) {
      scheduleLiveRoomPersist(r);
      scheduleRoomMirror(r);
    }
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
    aiPlanner: AI_PLANNER_HASH,
    rooms: listRoomsCount(),
    roomsByStatus: listRoomsByStatus(),
    activeMatches: listActiveMatchCount(),
    queueCasual: queueSize(),
    queueRanked: rankedQueueSize(),
    maxRooms: MAX_ROOMS,
    maxQueue: MAX_QUEUE,
    matchmaking: getMatchmakingMode(),
    rankedStore: rankedStoreMode(),
    rankStore: rankStoreMode(),
    postgres: isPostgresEnabled(),
    authStore: getAuthStoreMode(),
    mailConfigured: isMailConfigured(),
    avgActionMs: stats.avgActionMs,
    p95ActionMs: stats.p95ActionMs,
    avgPresentationMs: stats.avgPresentationMs,
    p95PresentationMs: stats.p95PresentationMs,
    presentations1m: stats.presentations1m,
    avgPresentSkewMs: stats.avgPresentSkewMs,
    p95PresentSkewMs: stats.p95PresentSkewMs,
    presentSkew1m: stats.presentSkew1m,
    avgQueueWaitMs: stats.avgQueueWaitMs,
    p95QueueWaitMs: stats.p95QueueWaitMs,
    disconnects1m: stats.disconnects1m,
    gapFills1m: stats.gapFills1m,
    gapFillsTotal: stats.gapFillsTotal,
    rejectsTotal: stats.rejectsTotal,
    actionsTotal: stats.actionsTotal,
    actions1m: stats.actions1m,
    redisConfigured: redisConfigured(),
    redisAdapter: isRedisAdapterAttached(),
    stateDiffPatches1m: stats.stateDiffPatches1m,
    stateDiff1m: stats.stateDiff1m,
    stateDiffSavedBytesTotal: stats.stateDiffSavedBytesTotal,
    ...roomStoreHealth(),
    ...processRoleHealth(),
    ...shardHealth(),
  };
  res.status(motor.motorOk ? 200 : 503).json(body);
});

/** Lookup de affinity (gateway / ops). */
app.get("/shard/lookup", async (req, res) => {
  const code = String(req.query.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: "BAD_CODE" });
  const shardId = await lookupRoomShard(code);
  res.json({
    ok: true,
    roomCode: code,
    shardId,
    shardCount: getShardCount(),
    serverUrl: shardUrlForRoom(code),
    localShardId: getLocalShardId(),
    ownsHere: thisProcessOwnsRoom(code),
    processRole: PROCESS_ROLE,
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
      // D3/C-B03: replay público, sem autenticação — esconder TODOS os
      // DRAWs com carta (viewerSeat -1) e foguear as mãos do estado
      // final (nenhum espectador definido). A revisão pós-partida com
      // o log completo fica p/ decisão de projeto (Fase 9/10).
      eventLog: projectEventsForSeat(row.event_log, -1),
      gameState: projectStateForSeat(row.final_state, -1),
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

/** Login em 1 dispositivo só (1.51.70, item 7): socket.id -> playerId, para
 *  avisar + derrubar os sockets antigos quando outro aparelho logar. */
const socketPlayer = new Map();

/**
 * Aceite da partida (1.51.86) — Tela de Encontro de Partidas.
 * code -> { accepted: [bool, bool], playerKeys: [chave0, chave1],
 *           socketKeys: [sid0, sid1], entries: [fila0, fila1] | null,
 *           acceptTimer, startTimer }.
 * O estado vive FORA da sala (nunca vai p/ o espelho Postgres/Redis, que
 * não serializa timers) e morre junto com ela na dissolução.
 * Tempos do protocolo: 20 s p/ aceitar (1.51.95 item 7, era 30 s),
 * 5 s de contagem p/ iniciar.
 * (1.51.95 item 4) entries só existe no pareamento casual: é a cópia
 * das entradas da fila, p/ recolocar os dois na busca quando o tempo
 * esgota com os dois aceites (a busca tenta de novo sozinha).
 */
const matchAcceptState = new Map();
const ACCEPT_TIMEOUT_MS = 20000;
const START_COUNTDOWN_MS = 5000;

function clearAcceptState(code) {
  const st = matchAcceptState.get(code);
  if (!st) return;
  if (st.acceptTimer) clearTimeout(st.acceptTimer);
  if (st.startTimer) clearTimeout(st.startTimer);
  matchAcceptState.delete(code);
}

/**
 * Arma o aceite de uma sala recém-pareada (casual ou ranked): 20 s a
 * partir do match_found (1.51.95 item 7, era 30 s). Sem os dois aceites,
 * dissolve como tempo esgotado.
 * (1.51.95 item 4) entry0/entry1 só no casual: cópia das entradas da fila
 * p/ a nova tentativa automática (dissolveLobbyRoom).
 */
function armMatchAccept(room, key0, key1, entry0 = null, entry1 = null) {
  clearAcceptState(room.code);
  const st = {
    accepted: [false, false],
    // Chave do par p/ a exclusão: conta (quando houver) E socket — o
    // cliente volta à busca com o mesmo token, mas mesmo sem ele (ou
    // com outro socket) a exclusão tem de valer p/ os dois aparelhos.
    playerKeys: [key0, key1],
    socketKeys: [room.sockets[0], room.sockets[1]],
    entries: entry0 && entry1 ? [entry0, entry1] : null,
    acceptTimer: null,
    startTimer: null,
  };
  matchAcceptState.set(room.code, st);
  logMp("match_accept_armed", { code: room.code, timeoutMs: ACCEPT_TIMEOUT_MS });
  st.acceptTimer = setTimeout(() => {
    const live = getRoom(room.code);
    if (!live || live.status !== "lobby") {
      clearAcceptState(room.code);
      return;
    }
    const cur = matchAcceptState.get(room.code);
    if (!cur) return;
    // (1.51.95 item 4) DEFEITO REAL (t_1191 RED): o timer desistia
    // quando os dois tinham aceitado — `if (aceitos) return` — mas o
    // início também exige os DOIS HERÓIS (maybeBeginStarting). Se um
    // set_hero não chegou, a sala ficava presa em lobby PARA SEMPRE,
    // sem match_declined e sem ninguém avisar: os dois clientes
    // esperavam até a guarda de silêncio deles agir. O timer tem de
    // dissolver SEMPRE que a partida não começou no prazo, aceites ou
    // não — o início (maybeBeginStarting) já cancela o timer quando sai.
    logMp("match_accept_timeout", {
      code: room.code,
      accepted: [!!cur.accepted[0], !!cur.accepted[1]],
      heroes: [!!live.heroes[0], !!live.heroes[1]],
      sockets: [!!live.sockets[0], !!live.sockets[1]],
    });
    dissolveLobbyRoom(live, "timeout", null);
  }, ACCEPT_TIMEOUT_MS);
  st.acceptTimer.unref?.();
}

/**
 * Os dois aceitaram E os dois heróis estão confirmados: avisa a contagem
 * de 5 s e depois roda o startMatch existente. Também é chamado pelo
 * set_hero — o aceite pode chegar antes dos heróis.
 */
function maybeBeginStarting(room) {
  const st = matchAcceptState.get(room.code);
  if (!st || room.status !== "lobby" || st.startTimer) return;
  if (!st.accepted[0] || !st.accepted[1]) return;
  if (!room.heroes[0] || !room.heroes[1]) return;
  if (!room.sockets[0] || !room.sockets[1]) return;
  if (st.acceptTimer) {
    clearTimeout(st.acceptTimer);
    st.acceptTimer = null;
  }
  emitRoom(room, "match_starting", { countdown: 5 });
  st.startTimer = setTimeout(() => {
    const live = getRoom(room.code);
    if (!live || live.status !== "lobby") {
      clearAcceptState(room.code);
      return;
    }
    const match = startMatchForRoom(live, io);
    clearAcceptState(room.code);
    if (!match) {
      // Herói ou socket sumiu durante a contagem: dissolve como tempo.
      dissolveLobbyRoom(live, "timeout", null);
    }
  }, START_COUNTDOWN_MS);
  st.startTimer.unref?.();
}

/**
 * Dissolve a sala de lobby POR COMPLETO (1.51.86): registra a exclusão
 * do par por 30 s, avisa quem ficou com match_declined, cancela os
 * timers, tira os dois do socketRoom, tira os sockets da sala e apaga
 * a sala do store (+ espelho). Sem isto o join_queue seguinte devolveria
 * a sala velha. Só p/ salas de pareamento (com estado de aceite).
 */
function dissolveLobbyRoom(room, reason, bySeat) {
  const st = matchAcceptState.get(room.code);
  // (1.51.95 item 4) nova tentativa automática: só quando o tempo
  // esgota COM OS DOIS aceites — os dois queriam jogar e alguma coisa
  // travou (ex.: um set_hero não chegou). Quem não aceitou NÃO volta
  // sozinho: jogador ausente não pode ficar sendo pareado. Só vale no
  // casual (entries), e só p/ sockets ainda vivos. A exclusão do par
  // (30 s, registrada abaixo) impede o pareamento imediato com o mesmo
  // adversário — a nova tentativa se forma quando ela expira.
  const bothAccepted = !!(st?.accepted?.[0] && st?.accepted?.[1]);
  const retryEntries = reason === "timeout" && bothAccepted && st?.entries
    ? st.entries.filter((e) => e?.socketId && io.sockets.sockets.get(e.socketId))
    : [];
  if (st?.playerKeys?.[0] && st?.playerKeys?.[1]) {
    recordPairExclusion(st.playerKeys[0], st.playerKeys[1]);
  }
  // Mesmo par, chave por socket: cobre o re-join sem token (mesma
  // conexão) — a exclusão vale p/ o par de aparelhos, não só p/ a conta.
  if (st?.socketKeys?.[0] && st?.socketKeys?.[1]) {
    recordPairExclusion(`s:${st.socketKeys[0]}`, `s:${st.socketKeys[1]}`);
  }
  clearAcceptState(room.code);
  const payload = { bySeat: bySeat ?? null, reason };
  if (reason === "timeout") {
    // Tempo esgotado: os dois ainda estão conectados, avisa os dois.
    emitRoom(room, "match_declined", payload);
  } else if (bySeat === 0 || bySeat === 1) {
    // Recusa/desconexão: só quem ficou precisa saber (quem recusou já
    // recebeu o ack; quem desconectou não está mais aqui).
    const peerSid = room.sockets[bySeat === 0 ? 1 : 0];
    if (peerSid) io.to(peerSid).emit("match_declined", payload);
  }
  for (const sid of room.sockets) {
    if (!sid) continue;
    socketRoom.delete(sid);
    const s = io.sockets.sockets.get(sid);
    try { s?.leave(room.code); } catch (e) { /* */ }
  }
  deleteRoom(room.code);
  void deleteLiveRoom(room.code);
  logMp("lobby_dissolved", { code: room.code, reason, bySeat: bySeat ?? null });
  if (retryEntries.length) {
    requeueFront(retryEntries);
    logMp("lobby_timeout_requeue", { code: room.code, count: retryEntries.length });
  }
}

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
  room.matchStartedAt = Date.now();
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
      // (Fase 6 T1) fog: cada assento recebe só a própria mão; a do
      // adversário vai como contagem (projectStateForSeat).
      gameState: projectStateForSeat(match.gameState, seat),
      yourSeat: seat,
      seatToken: seatTokenFor(room, seat),
      code: room.code,
    });
  }
  broadcastRoomState(room);
  resetTurnTimer(room);
  touchPersist(room);
  // (1.51.78 ponto 2; 1,5 s a partir da 1.51.95 D2) Saque livre do
  // 1º turno de quem começa: 1,5 s após o match_start. Os 4,5 s
  // antigos supunham uma contagem de 3 s DEPOIS do match_start, mas
  // ela não existe no cliente atual: a batalha abre no match_start
  // (a contagem de 5 s acontece ANTES, no match_starting). Com 4,5 s
  // a carta pousava ~3 s depois da mesa aparecer (t_1204 mediu
  // 2,93 s; o pedido do item 5 é 1,5 s). Sem isto quem começa
  // nasceria com 5 cartas na mão. O timer só
  // dispara se a partida ainda estiver no 1º turno sem vencedor; se a
  // sala acabou antes, não faz nada. O envelope vai aos DOIS assentos
  // (emitActionEnvelope projeta a mão do adversário por assento).
  scheduleOpeningFreeDraw(room, io, firstPlayer);
  return match;
}

// (1.51.78 ponto 2; 1,5 s a partir da 1.51.95 D2) Saca a 5ª carta de
// quem começa, 1,5 s após o match_start, e difunde como DRAW_CARD com
// o estado autoritativo.
function scheduleOpeningFreeDraw(room, io, firstPlayer) {
  setTimeout(() => {
    void (async () => {
      try {
        await withRoomLock(room.code, async () => {
          const live = getRoom(room.code);
          if (!live || live.status !== "playing") return;
          const gs = live.gameState;
          if (!gs || gs.winner != null) return;
          if (gs.turnNumber !== 1 || gs.currentPlayer !== firstPlayer) return;
          const opener = gs.players?.[firstPlayer];
          if (!opener?.deck?.length) return;
          if ((opener.hand?.length || 0) >= 8) return; // SEM-QUEIMA: mão cheia não saca.
          const drawn = opener.deck.pop();
          if (!drawn) return;
          opener.hand.push(JSON.parse(JSON.stringify(drawn)));
          live.actionSeq = (live.actionSeq || 0) + 1;
          live.lastSnapshot = { state: gs, full: true };
          emitActionEnvelope(live, {
            seq: live.actionSeq,
            fromSeat: firstPlayer,
            action: { type: "DRAW_CARD", playerId: firstPlayer },
            snapshot: null,
            authoritativeState: gs,
            events: [{ type: "DRAW", playerId: firstPlayer }],
            logEntry: null,
            delegated: false,
            skip: false,
            forfeit: false,
            presentation: null,
            presentationEnvelope: null,
            turnDeadline: live.turnDeadline || null,
          });
          touchPersist(live);
        });
      } catch (e) { /* o saque não pode derrubar a partida */ }
    })();
  }, 1500);
}

/**
 * Avisa o par de lotado uma vez só por entrada na fila (o timer ranked
 * tenta a cada 500 ms — sem isto o cliente receberia `queue_busy` 2×/s
 * enquanto o servidor estiver lotado).
 */
function notifyQueueBusyOnce(io, entry0, entry1, ranked) {
  const busy = { ok: false, error: "SERVER_BUSY", inQueue: true, ...(ranked ? { ranked: true } : {}) };
  for (const entry of [entry0, entry1]) {
    if (!entry || entry._busyNotified) continue;
    entry._busyNotified = true;
    io.to(entry.socketId).emit("queue_busy", busy);
  }
}

function pairRankedSockets(io, entry0, entry1) {
  const sid0 = entry0.socketId;
  const sid1 = entry1.socketId;
  // Socket morto na fila não pode virar sala. Devolve o vivo à fila.
  const s0alive = !!io.sockets.sockets.get(sid0);
  const s1alive = !!io.sockets.sockets.get(sid1);
  if (!s0alive || !s1alive) {
    if (s0alive) requeueRankedFront([entry0]);
    if (s1alive) requeueRankedFront([entry1]);
    logMp("pair_ranked_dead_socket", { s0alive, s1alive });
    return;
  }
  // Gateway-only: não hospeda authority — redireciona ambos ao game shard.
  if (!isGameRole()) {
    const urls = getGameShardUrls();
    const serverUrl = urls[0] || getGatewayUrl();
    const payload = {
      ok: true,
      shardRedirect: true,
      reason: "GATEWAY_TO_GAME",
      serverUrl,
      ranked: true,
      processRole: PROCESS_ROLE,
    };
    if (!serverUrl) {
      logMp("pair_ranked_no_shard_url", {});
      requeueRankedFront([entry0, entry1]);
      notifyQueueBusyOnce(io, entry0, entry1, true);
      return false;
    }
    io.to(sid0).emit("shard_redirect", { ...payload, seatHint: 0 });
    io.to(sid1).emit("shard_redirect", { ...payload, seatHint: 1 });
    return true;
  }
  let room;
  try {
    room = createRoomOrThrow(createRoomOptsForLocalShard());
  } catch (e) {
    // Servidor lotado: o par volta à fila e é avisado (o timer tenta de
    // novo sozinho) — sem isto os dois sumiam da fila sem erro.
    logMp("pair_ranked_busy", { error: e?.message });
    requeueRankedFront([entry0, entry1]);
    notifyQueueBusyOnce(io, entry0, entry1, true);
    return false;
  }
  void rememberRoomShard(room.code);
  room.ranked = true;
  room.rankedPlayerIds = [entry0.playerId, entry1.playerId];
  // (1.51.75) avatar e nível de cada jogador, para a tela de Partida
  // Encontrada — capturados na fila; o roomPublicView os emite.
  // (1.51.80) moldura do avatar, mesmo caminho.
  room.playerAvatars = [entry0.avatarHeroId || null, entry1.avatarHeroId || null];
  room.playerLevels = [entry0.level || 0, entry1.level || 0];
  room.playerFrames = [entry0.avatarFrame || null, entry1.avatarFrame || null];
  room.winPoints = 15;
  room.sockets[0] = sid0;
  room.sockets[1] = sid1;
  // (1.51.95 item 5) o pareamento marca a última vez visto: sem isto a
  // regra de partida abandonada usaria a criação como relógio.
  touchLastSeen(room, 0);
  touchLastSeen(room, 1);
  ensureSeatTokens(room);
  socketRoom.set(sid0, room.code);
  socketRoom.set(sid1, room.code);
  const s0 = io.sockets.sockets.get(sid0);
  const s1 = io.sockets.sockets.get(sid1);
  s0?.join(room.code);
  s1?.join(room.code);
  // (1.51.86) aceite: 20 s a partir do ranked_match_found (1.51.95 item 7).
  armMatchAccept(
    room,
    exclusionKeyForPlayer(entry0.playerId, sid0),
    exclusionKeyForPlayer(entry1.playerId, sid1),
  );
  io.to(sid0).emit("ranked_match_found", {
    ...roomPublicView(room, 0),
    seat: 0,
    seatToken: seatTokenFor(room, 0),
    mmr: entry0.mmr,
    opponentMmr: entry1.mmr,
    shardId: shardIdForRoom(room.code),
  });
  io.to(sid1).emit("ranked_match_found", {
    ...roomPublicView(room, 1),
    seat: 1,
    seatToken: seatTokenFor(room, 1),
    mmr: entry1.mmr,
    opponentMmr: entry0.mmr,
    shardId: shardIdForRoom(room.code),
  });
  broadcastRoomState(room);
}

function maybeFinishMatch(room, state) {
  if (!room || state?.winner == null) return null;
  if (!room.matchHistoryRecorded) {
    room.matchHistoryRecorded = true;
    room.status = "ended";
    room.endedAt = Date.now();
    // C-N10: partida encerrada — o timer da apodrecida não dispara mais.
    clearApodrecidaTimer(room);
    void recordMatchEnd(room, state, GAME_VERSION);
    void deleteLiveRoom(room.code);
  }
  maybeRecordRankSeason(room, state);
  return maybeRecordRankedResult(room, state);
}

function rankMatchKey(room) {
  return `${room.code}:${room.createdAt || 0}`;
}

/** Rank da temporada: fim normal da partida rankeada (vitória/derrota). */
function maybeRecordRankSeason(room, state) {
  if (!room?.ranked || room.rankSeasonRecorded || state?.winner == null) return;
  room.rankSeasonRecorded = true;
  const w = state.winner | 0;
  const ids = room.rankedPlayerIds || [];
  void recordRankedSeasonMatch(rankMatchKey(room), [
    { id: ids[0] || null, outcome: w === 0 ? "win" : "loss" },
    { id: ids[1] || null, outcome: w === 1 ? "win" : "loss" },
  ]).catch((e) => logMp("rank_record_err", { error: e?.message || String(e) }));
}

/** Rank da temporada: quem abandona/desconecta (IA assume) perde; quem fica vence na hora. */
function recordRankAbandon(room, seat) {
  if (!room?.ranked || room.rankSeasonRecorded || room.gameState?.winner != null) return;
  if (seat !== 0 && seat !== 1) return;
  room.rankSeasonRecorded = true;
  const ids = room.rankedPlayerIds || [];
  void recordRankedSeasonMatch(rankMatchKey(room), [
    { id: ids[0] || null, outcome: seat === 0 ? "loss" : "win" },
    { id: ids[1] || null, outcome: seat === 1 ? "loss" : "win" },
  ]).catch((e) => logMp("rank_record_err", { error: e?.message || String(e) }));
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
    const [e0, e1] = pair;
    const sid0 = e0.socketId;
    const sid1 = e1.socketId;
    // Socket morto na fila não pode virar sala (um lado morto + o outro
    // preso no lobby). Devolve o vivo à frente da fila e tenta o próximo par.
    const s0alive = !!io.sockets.sockets.get(sid0);
    const s1alive = !!io.sockets.sockets.get(sid1);
    if (!s0alive || !s1alive) {
      if (s0alive) requeueFront([e0]);
      if (s1alive) requeueFront([e1]);
      logMp("pair_dead_socket", { s0alive, s1alive });
      pair = takePair();
      continue;
    }
    if (!isGameRole()) {
      const urls = getGameShardUrls();
      const serverUrl = urls[0] || getGatewayUrl();
      if (serverUrl) {
        const payload = {
          ok: true,
          shardRedirect: true,
          reason: "GATEWAY_TO_GAME",
          serverUrl,
          processRole: PROCESS_ROLE,
        };
        io.to(sid0).emit("shard_redirect", { ...payload, seatHint: 0 });
        io.to(sid1).emit("shard_redirect", { ...payload, seatHint: 1 });
        pair = takePair();
        continue;
      } else {
        logMp("pair_casual_no_shard_url", {});
        requeueFront([e0, e1]);
        const busy = { ok: false, error: "SERVER_BUSY", inQueue: true };
        io.to(sid0).emit("queue_busy", busy);
        io.to(sid1).emit("queue_busy", busy);
        break;
      }
    }
    let room;
    try {
      room = createRoomOrThrow(createRoomOptsForLocalShard());
    } catch (e) {
      // Servidor lotado: o par volta à fila e é avisado — sem isto os dois
      // saíam da fila sem erro e ficavam em "PROCURANDO PARTIDA…" para sempre.
      logMp("pair_casual_busy", { error: e?.message });
      requeueFront([e0, e1]);
      const busy = { ok: false, error: "SERVER_BUSY", inQueue: true };
      io.to(sid0).emit("queue_busy", busy);
      io.to(sid1).emit("queue_busy", busy);
      break;
    }
    void rememberRoomShard(room.code);
    room.winPoints = 15;
    room.sockets[0] = sid0;
    room.sockets[1] = sid1;
    // (1.51.95 item 5) o pareamento marca a última vez visto: sem isto a
    // regra de partida abandonada usaria a criação como relógio.
    touchLastSeen(room, 0);
    touchLastSeen(room, 1);
    // Nome do jogador na sala (Fase 5, decisão 4): vem da fila; sem
    // token o nome fica null e o cliente mostra só o herói.
    room.playerNames = [e0.displayName || null, e1.displayName || null];
    // (1.51.75) avatar e nível de cada jogador, para a tela de Partida
    // Encontrada — capturados na fila; o roomPublicView os emite.
    // (1.51.80) moldura do avatar, mesmo caminho.
    room.playerAvatars = [e0.avatarHeroId || null, e1.avatarHeroId || null];
    room.playerLevels = [e0.level || 0, e1.level || 0];
    room.playerFrames = [e0.avatarFrame || null, e1.avatarFrame || null];
    ensureSeatTokens(room);
    socketRoom.set(sid0, room.code);
    socketRoom.set(sid1, room.code);
    const s0 = io.sockets.sockets.get(sid0);
    const s1 = io.sockets.sockets.get(sid1);
    s0?.join(room.code);
    s1?.join(room.code);
    // (1.51.86) aceite: 20 s a partir do match_found (1.51.95 item 7).
    // (1.51.95 item 4) as entradas da fila vão junto: se o tempo
    // esgotar com os dois aceites, o servidor as recoloca na busca.
    armMatchAccept(
      room,
      exclusionKeyForPlayer(e0.playerId, sid0),
      exclusionKeyForPlayer(e1.playerId, sid1),
      e0,
      e1,
    );
    io.to(sid0).emit("match_found", {
      ...roomPublicView(room, 0),
      seat: 0,
      seatToken: seatTokenFor(room, 0),
      shardId: shardIdForRoom(room.code),
    });
    io.to(sid1).emit("match_found", {
      ...roomPublicView(room, 1),
      seat: 1,
      seatToken: seatTokenFor(room, 1),
      shardId: shardIdForRoom(room.code),
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
    let peerEnv = envelope.authoritativeState
      ? attachPeerStateDiff(room, envelope, s, projectStateForSeat, recordStateDiff)
      : envelope;
    // C-B03: DRAW do oponente não pode carregar a carta (fog). Cópia
    // rasa: o envelope pode ser o mesmo objeto p/ os dois assentos.
    if (peerEnv?.events) peerEnv = { ...peerEnv, events: projectEventsForSeat(peerEnv.events, s) };
    io.to(sid).emit("remote_action", peerEnv);
  }
  // C-N10 (Opção A — timer por sala): toda publicação de estado pode ter
  // posto uma apodrecida no campo — rearmar para o prazo mais próximo.
  armApodrecidaTimer(room, apodrecidaTimerDeps());
}

/** Deps do timer da apodrecida (C-N10): injetadas aqui, fakes na sonda. */
function apodrecidaTimerDeps() {
  return {
    getRoom,
    withRoomLock,
    emitEnvelope: emitActionEnvelope,
    persist: async (r) => {
      touchPersist(r);
      await mirrorRoomNow(r);
    },
    expireApodrecidas: (state, now) => bootDragonfallEngine().DfRules.expireApodrecidas(state, now),
    buildPresentationEnvelope: (events, action) => buildPresentationEnvelope(events, action),
  };
}

/**
 * Responde no lugar de um assento sob IA a uma pergunta reativa (MP apenas).
 *
 * Sem isto o atacante espera o timeout inteiro (10–11s) porque não existe
 * navegador no assento desconectado para responder — era a causa do
 * "jogo congelou depois de escolher o alvo".
 *
 * @returns {boolean} true se respondeu (a pergunta foi consumida pela IA).
 */
function maybeAnswerReactiveForAi(room, action, askerSeat) {
  let answer = null;
  const defSeat = action?.defenderPlayerId;
  const seatOffline = (defSeat === 0 || defSeat === 1) && !room.sockets?.[defSeat];
  try {
    answer = buildAiReactiveAnswer(room, action, askerSeat, { seatOffline });
  } catch (e) {
    console.warn("[DF ai-reactive] build", e?.message || e);
  }
  if (!answer) return false;

  const askerSid = room.sockets[askerSeat];

  // Usar a carta consome-a de fato: o estado do servidor é a fonte da verdade.
  if (answer.payload.use) {
    try { consumeAiReactiveCard(room, defSeat, action.type); } catch (e) { /* */ }
  }

  room.actionSeq += 1;
  // Sem authoritativeState: a ANSWER percorre o mesmo caminho "só-UI" do
  // envelope enviado por um humano (REACTIVE_*_ANSWER está em
  // DF_MP_NOSNAP_TYPES). Anexar estado aqui arriscaria o cliente descartar o
  // envelope no materialize do state diff — e o atacante voltaria a travar.
  const envelope = {
    seq: room.actionSeq,
    fromSeat: defSeat,
    action: answer.payload,
    authoritativeState: null,
    events: [],
    serverAi: true,
    serverAiReactive: true,
  };
  if (askerSid) io.to(askerSid).emit("remote_action", envelope);

  // Quando a IA usa a Reação, o humano precisa VER a carta sendo jogada.
  if (answer.payload.use) {
    const anim = buildAiReactiveVisual(action, answer.payload, askerSeat);
    if (anim && askerSid) {
      room.actionSeq += 1;
      io.to(askerSid).emit("remote_action", {
        seq: room.actionSeq,
        fromSeat: defSeat,
        action: { type: "PRESENT", playerId: defSeat, anim },
        events: [],
        serverAi: true,
        serverAiReactive: true,
      });
    }
  }
  return true;
}

/** Visual da carta de Reação jogada pela IA, para o cliente do humano. */
function buildAiReactiveVisual(action, payload, askerSeat) {
  const defOwner = payload.defenderPlayerId;
  if (action.type === "REACTIVE_BLOCK_QUERY") {
    return {
      kind: "blocked_attack",
      defOwner,
      defIdx: payload.defenderIdx,
      cardName: "BLOQUEAR ATAQUE",
      talentEffect: "bloquearAtaque",
    };
  }
  if (action.type === "REACTIVE_PROTECTION_QUERY") {
    return {
      kind: "divine_protection",
      defOwner,
      defenderPlayerId: defOwner,
      defenderName: payload.defenderName,
      defenderUid: payload.defenderUid,
      cardName: "PROTEÇÃO DIVINA",
      talentEffect: "protecaoDivina",
    };
  }
  if (action.type === "REACTIVE_CANCEL_QUERY") {
    return {
      kind: "cancel_ultimate",
      casterP: askerSeat,
      ultimateName: payload.ultimateName,
      cardName: "CANCELAR ULTIMATE",
      talentEffect: "cancelarUltimate",
    };
  }
  if (action.type === "REACTIVE_EXHAUSTION_QUERY") {
    return {
      kind: "exaustao",
      casterP: askerSeat,
      championName: payload.championName,
      abilityName: payload.abilityName,
      onEnter: payload.onEnter,
      cardName: "EXAUSTÃO",
      talentEffect: "exaustao",
    };
  }
  if (action.type === "REACTIVE_COUNTER_QUERY") {
    return {
      kind: "contramagica",
      casterP: askerSeat,
      talentName: payload.talentName,
      talentEffect: payload.talentEffect,
      cardName: "CONTRAMÁGICA",
    };
  }
  return null;
}

function afterAuthoritativeAction(room, state) {
  broadcastRoomState(room);
  // C-A19: NÃO renovar o relógio após ação (70 s fixos por turno, igual ao offline).
  resetTurnTimerOnTurnChange(room);
  touchPersist(room);
  maybeFinishMatch(room, state);
  if (room.status === "playing" && state?.winner == null) {
    scheduleServerAi(room, io, serverAiHooks(room));
  }
}

/** Hooks da IA disconnect — sem reentrar schedule a cada passo. */
function serverAiHooks(room) {
  return {
    emitEnvelope: emitActionEnvelope,
    onAfterAction: afterAuthoritativeAction,
    onAfterAiStep: (r, state) => {
      // t_1010 (F7-06): a virada de turno pela IA tem de renovar o
      // relógio — sem isto o próximo jogador herda o prazo velho e o
      // turnTimer antigo pode encerrar o turno dele antes dos 70 s.
      // Só age na virada (o guarda compara _clockTurnPlayer); no meio
      // do turno da IA não renova nada (C-A19).
      resetTurnTimerOnTurnChange(r);
      broadcastRoomState(r);
      touchPersist(r);
      maybeFinishMatch(r, state);
    },
    maybeFinish: (r, state) => maybeFinishMatch(r, state),
    persist: () => touchPersist(room),
    onAiTakeover: (_r, seat) => {
      // C-A19: takeover NÃO é virada de turno — o relógio continua de onde estava.
      emitTurnDeadline(room);
      recordRankAbandon(room, seat);
    },
  };
}

/**
 * Lote F — Bloco 2 (reações C-A05–C-A08): hooks do módulo de suspensão
 * reativa (df-reactive-suspend.mjs). A retomada difunde por aqui
 * (emitEnvelope projetado p/ os dois assentos) e persiste como o game_action.
 */
function reactiveHooks(room) {
  return {
    emitEnvelope: (r, env) => emitActionEnvelope(r, env),
    maybeFinish: (r, state) => maybeFinishMatch(r, state),
    persist: async (r) => {
      touchPersist(r);
      await mirrorRoomNow(r);
    },
    scheduleAi: (r) => scheduleServerAi(r, io, serverAiHooks(r)),
    answerForAi: (r, query, askerSeat) => {
      try {
        return buildAiReactiveAnswer(r, query, askerSeat, { seatOffline: false });
      } catch (e) {
        console.warn("[reactive-suspend] answerForAi", e?.message || e);
        return null;
      }
    },
    onAiResume: (r, seat, result, spec) =>
      continueAiAfterResume(r, io, serverAiHooks(r), seat, result, spec),
  };
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnDeadline = null;
}

function emitTurnDeadline(room) {
  try {
    emitRoom(room, "turn_deadline", {
      turnDeadline: room.turnDeadline || null,
      serverNow: Date.now(),
      serverTime: Date.now(),
    });
  } catch (e) { /* */ }
}

function onTurnTimerExpired(room) {
  if (room.status !== "playing") return;
  const cp = room.gameState?.currentPlayer;
  if ((cp === 0 || cp === 1) && room.aiControlled?.[cp]) {
    // C-A19: expiração força o fim do turno como no offline (antes renovava o
    // relógio e reagendava a IA, adiando o fim do turno indefinidamente).
    forceServerEndTurn(room);
    return;
  }
  forceServerEndTurn(room);
}

function armTurnTimer(room, ms) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  const delay = Math.max(0, ms | 0);
  room.turnTimer = setTimeout(() => onTurnTimerExpired(room), delay);
}

/** Reconexão: mantém turnDeadline existente — não reinicia 70s para os dois peers. */
function rearmTurnTimerPreserveDeadline(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.status !== "playing" || !room.gameState?.players) return;
  if (!room.turnDeadline) {
    resetTurnTimer(room);
    return;
  }
  emitTurnDeadline(room);
  const remaining = room.turnDeadline - Date.now();
  if (remaining <= 0) {
    onTurnTimerExpired(room);
    return;
  }
  armTurnTimer(room, remaining);
}

/** END_TURN forçado (timer esgotado / disconnect com deadline passado). */
function forceServerEndTurn(room) {
  void withRoomLock(room.code, async () => {
    const cp = room.gameState?.currentPlayer;
    if (cp == null || room.status !== "playing") return;
    // Lote F — Bloco 2: pergunta reativa aberta expira como NÃO antes do
    // fim forçado (o relógio de 70 s não para durante a pergunta — C-A19).
    // Drena em loop limitado: a retomada pode encadear outra pergunta
    // (C-A06/C-A07) — cada iteração resolve uma como NÃO.
    for (let i = 0; i < 20 && room.mpPendingReactive; i++) {
      await expireReactiveSuspensionLocked(room, io, reactiveHooks(room));
    }
    if (room.mpPendingReactive) {
      console.warn("[forceEndTurn] pendente reativo sobreviveu ao dreno", room.code);
    }
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
    resetTurnTimer(room);
    envelope.turnDeadline = room.turnDeadline || null;
    emitActionEnvelope(room, envelope);
    await mirrorRoomNow(room);
    touchPersist(room);
    maybeFinishMatch(room, result.state);
    if (room.status === "playing" && result.state?.winner == null) {
      scheduleServerAi(room, io, serverAiHooks(room));
    }
  }).catch((e) => console.warn("[forceEndTurn]", e?.message || e));
  return true;
}

function resetTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.status !== "playing" || !room.gameState?.players) {
    room.turnDeadline = null;
    return;
  }
  // E-N4 (decisão dela 16/11): o deadline dá 70 s DEPOIS do banner
  // (turn_number >= 3) — o jogador mantém 70 s úteis, igual ao offline.
  // Nos turnos 1–2 não há banner e o prazo segue 70 s exatos.
  room.turnDeadline = turnDeadlineFor(room.gameState?.turnNumber, Date.now(), TURN_TIMEOUT_MS);
  room._clockTurnPlayer = room.gameState?.currentPlayer ?? null;
  emitTurnDeadline(room);
  armTurnTimer(room, Math.max(0, room.turnDeadline - Date.now()));
}

// C-A19 (Lote F): o relógio é FIXO por turno (70 s, igual ao offline) — ações
// NÃO renovam o prazo. Só a virada de turno redefine o deadline. Este helper é
// o único caminho de reset fora da virada de turno (match start / forceServerEndTurn
// / join / reconnect / revive já chamam resetTurnTimer direto porque o turno mudou).
function resetTurnTimerOnTurnChange(room) {
  if (room._clockTurnPlayer !== room.gameState?.currentPlayer) {
    resetTurnTimer(room);
  }
}

/** Pós-boot: salas restauradas vêm com turnTimer:null — reativa relógio + IA.
 * O deadline SALVO é preservado (rearmTurnTimerPreserveDeadline): dar 70 s
 * novos no boot reiniciava o relógio de quem voltou (S76-T11). Se o prazo
 * já passou, o fim forçado acontece uma vez só dentro do rearm. */
function revivePlayingRoomTimers() {
  for (const room of listPlayingRooms()) {
    if (room.gameState?.winner != null) continue;
    rearmTurnTimerPreserveDeadline(room);
    scheduleServerAi(room, io, serverAiHooks(room));
  }
}

function replayPayload(room) {
  return buildReplayPayload(room);
}

function createRoomOptsForLocalShard() {
  if (getShardCount() <= 1) return {};
  return {
    preferShard: getLocalShardId(),
    shardCount: getShardCount(),
    shardIdFor: shardIdForRoom,
  };
}

function rejectUnlessGateway(ack, event) {
  if (isGatewayRole()) return false;
  ack?.({
    ok: false,
    error: "WRONG_ROLE",
    reason: "GATEWAY_ONLY",
    event,
    processRole: PROCESS_ROLE,
    serverUrl: getGatewayUrl(),
  });
  return true;
}

function rejectUnlessGame(ack, event) {
  if (isGameRole()) return false;
  const urls = shardHealth().gameShardUrls;
  ack?.({
    ok: false,
    error: "WRONG_ROLE",
    reason: "GAME_ONLY",
    event,
    processRole: PROCESS_ROLE,
    serverUrl: shardUrlForRoom("DRAGON-HOME") || null,
    gameShardUrls: urls,
  });
  return true;
}

io.on("connection", (socket) => {
  socket.emit("hello", {
    ok: true,
    serverVersion: 1,
    gameVersion: GAME_VERSION,
    protocolVersion: 2,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    processRole: PROCESS_ROLE,
    shardId: getLocalShardId(),
    shardCount: getShardCount(),
  });

  socket.on("authenticate", async (payload, ack) => {
    const tok = typeof payload?.token === "string" ? payload.token : null;
    const account = tok ? await authPlayerFromToken(tok) : null;
    if (!account) return ack?.({ ok: false, error: "UNAUTHORIZED" });
    socketPlayer.set(socket.id, account.id);
    socket.join(`player:${account.id}`);
    ack?.({ ok: true, playerId: account.id });
  });

  socket.on("create_room", (_payload, ack) => {
    if (rejectUnlessGame(ack, "create_room")) return;
    let room;
    try {
      room = createRoomOrThrow(createRoomOptsForLocalShard());
    } catch (e) {
      ack?.({ ok: false, error: e?.code || e?.message || "SERVER_BUSY" });
      return;
    }
    void rememberRoomShard(room.code);
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
      shardId: shardIdForRoom(room.code),
    });
    broadcastRoomState(room);
  });

  socket.on("join_room", async (payload, ack) => {
    if (rejectUnlessGame(ack, "join_room")) return;
    const schema = validateJoinRoom(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
    const code = payload?.code;
    if (getShardCount() > 1 && code && !thisProcessOwnsRoom(code)) {
      void rememberRoomShard(code);
      return ack?.(buildShardRedirect(code, "WRONG_SHARD"));
    }
    const seatToken = payload?.seatToken ? String(payload.seatToken) : null;
    const joined = joinRoom(code, socket.id, payload?.preferSeat, seatToken);
    if (!joined.ok) {
      // Sala inexistente neste processo — pode viver noutro shard.
      if (joined.error === "ROOM_NOT_FOUND" && getShardCount() > 1 && code) {
        const id = await lookupRoomShard(code);
        if (id !== getLocalShardId()) {
          return ack?.(buildShardRedirect(code, "WRONG_SHARD"));
        }
      }
      ack?.({ ok: false, error: joined.error });
      return;
    }
    void rememberRoomShard(joined.room.code);
    socketRoom.set(socket.id, joined.room.code);
    socket.join(joined.room.code);
    touchLastSeen(joined.room, joined.seat);
    const view = roomPublicView(joined.room, joined.seat);
    // Limpar a IA ANTES de montar o replay: o ack carrega aiControlled e
    // é dele que o cliente que volta restaura o indicador (F7, t_1020) —
    // montado antes, o replay diria que a IA ainda está no assento.
    // Em partida, retomar um assento é sempre volta de humano — mesmo sem
    // token (ex.: jogo reaberto) — e a IA tem de sair do assento. O
    // reconnected já vem true nesses casos, mas o guarda fica aqui também
    // para nenhum caminho de entrada deixar a IA jogando no lugar dele.
    if (joined.reconnected || joined.room.status === "playing") {
      onHumanReconnectedClearAi(joined.room, joined.seat, io);
    }
    // (§14.6) sala encerrada: o replay normal é null — o jogador que
    // volta depois do fim precisa do estado final no ack, senão a
    // batalha fica travada sem o que aplicar.
    const replay = replayPayload(joined.room) ?? buildFinalReplayPayload(joined.room, joined.seat);
    ack?.({
      ok: true,
      ...view,
      seat: joined.seat,
      seatToken: joined.seatToken || seatTokenFor(joined.room, joined.seat),
      reconnected: !!joined.reconnected,
      replay,
      gameVersion: GAME_VERSION,
      shardId: shardIdForRoom(joined.room.code),
    });
    broadcastRoomState(joined.room);
    // Pergunta reativa aberta para quem volta: reemite a QUERY (mesmo qid,
    // mesmo prazo) — sem isto o box nunca reabre e a pergunta expira
    // como NÃO sem o jogador saber.
    reemitReactiveQuery(joined.room, io, joined.seat);
    if (joined.room.status === "playing") {
      if (joined.reconnected) {
        rearmTurnTimerPreserveDeadline(joined.room);
      } else {
        resetTurnTimer(joined.room);
      }
      scheduleServerAi(joined.room, io, serverAiHooks(joined.room));
    }
  });

  socket.on("match_ping", (payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    touchLastSeen(room, seat);
    // Telemetria opcional do cliente (presentSkew / queueWait) — separados.
    if (payload && typeof payload === "object") {
      const seatMeta = { roomCode: room.code, seat, seq: room.actionSeq };
      if (payload.queueWaitMs != null) {
        recordActionLatency(Number(payload.queueWaitMs) || 0, {
          ...seatMeta,
          type: "PRESENT_TELEMETRY",
          ok: true,
        });
      }
      if (payload.presentSkewMs != null) {
        recordPresentSkew(Number(payload.presentSkewMs) || 0, seatMeta);
      }
      if (payload.gapFill === true || payload.gapDetected === true) {
        recordGapFill({
          ...seatMeta,
          fromSeq: payload.fromSeq,
          actionSeq: room.actionSeq,
          gap: payload.gapSize,
        });
      }
    }
    ack?.({
      ok: true,
      serverTime: Date.now(),
      serverNow: Date.now(),
      turnDeadline: room.turnDeadline || null,
      lastSeq: room.actionSeq | 0,
      presentBudgetMs: 2500,
      gameVersion: GAME_VERSION,
    });
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
      // (1.51.86) o início agora exige os dois aceites: quando os heróis
      // estão confirmados, só falta o aceite — a contagem de 5 s só
      // começa quando os dois assentos aceitarem (maybeBeginStarting).
      // Sala sem estado de aceite (create_room legado, sem pareamento)
      // mantém o comportamento de hoje: inicia na hora.
      if (matchAcceptState.has(room.code)) maybeBeginStarting(room);
      else startMatchForRoom(room, io);
    }
    ack?.({ ok: true });
  });

  // (1.51.86) Aceite da partida — só em lobby de pareamento.
  socket.on("accept_match", (_payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    if (room.status !== "lobby") return ack?.({ ok: false, error: "NOT_LOBBY" });
    const st = matchAcceptState.get(room.code);
    if (!st) return ack?.({ ok: false, error: "NOT_IN_MATCH" });
    if (st.startTimer) return ack?.({ ok: true, alreadyStarting: true });
    st.accepted[seat] = true;
    const peer = seat === 0 ? 1 : 0;
    if (room.sockets[peer]) {
      io.to(room.sockets[peer]).emit("opponent_accepted", { seat });
    }
    maybeBeginStarting(room);
    ack?.({ ok: true });
  });

  // (1.51.86) Recusa da partida — só em lobby de pareamento. Dissolve a
  // sala por completo e exclui o par por 30 s (o outro volta à busca).
  socket.on("decline_match", (_payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    if (room.status !== "lobby") return ack?.({ ok: false, error: "NOT_LOBBY" });
    if (!matchAcceptState.has(room.code)) return ack?.({ ok: false, error: "NOT_IN_MATCH" });
    ack?.({ ok: true });
    dissolveLobbyRoom(room, "decline", seat);
  });

  // (1.51.88 item 8, FIM DA REGRA EM 1.51.95 item 7) Fechar a tela de
  // encontro em PARTIDA ENCONTRADA ou PARTIDA INICIANDO dissolve a sala
  // como uma recusa — o adversário recebe o mesmo match_declined de
  // sempre e volta a procurar. NÃO há mais pausa/banimento: quem fechou
  // volta à busca na hora (ack com banSeconds 0, p/ clientes antigos
  // lerem "sem pausa"). O botão RECUSAR continua sem passar por aqui.
  socket.on("leave_encontro", (payload, ack) => {
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const seat = seatForSocket(room, socket.id);
    if (seat === null) return ack?.({ ok: false, error: "NO_SEAT" });
    if (room.status !== "lobby") return ack?.({ ok: false, error: "NOT_LOBBY" });
    const st = matchAcceptState.get(room.code);
    if (!st) return ack?.({ ok: false, error: "NOT_IN_MATCH" });
    ack?.({ ok: true, banSeconds: 0, bannedUntil: 0 });
    dissolveLobbyRoom(room, "decline", seat);
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
    if (rejectUnlessGateway(ack, "join_ranked_queue")) return;
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
    let verified = false;
    // (1.51.75) avatar e nível do perfil, para a tela de Partida Encontrada.
    let rankedProfile = null;
    const tok = payload?.token || payload?.authToken;
    if (tok) {
      try {
        const account = await authPlayerFromToken(String(tok));
        if (account?.id) {
          playerId = account.id;
          verified = true;
          rankedProfile = {
            avatarHeroId: account.avatarHeroId || null,
            level: levelFromXp(account.xpTotal || 0),
            avatarFrame: account.avatarFrame || null,
          };
        }
      } catch (e) { /* keep schema playerId */ }
    }
    // Id de conta sem sessão válida não conta como aquela conta (Rank da temporada é só de contas logadas).
    if (!verified && playerId) {
      try {
        if (await getPlayerById(playerId)) playerId = `u-${playerId}`.slice(0, 64);
      } catch (e) { /* */ }
    }
    if (!playerId) playerId = `anon-${socket.id.slice(0, 12)}`;
    // (1.51.95 item 7) FIM DA REGRA DE BANIMENTO: fechar a tela de
    // encontro não deixa mais a conta sem entrar na fila (o bloco
    // ONLINE_BAN da 1.51.88 foi removido daqui).
    const info = addToRankedQueue(socket.id, playerId, rankedProfile);
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

  socket.on("join_queue", async (payload, ack) => {
    if (rejectUnlessGateway(ack, "join_queue")) return;
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
    // Nome na fila (Fase 5): token opcional; sem token ou inválido,
    // entra anônimo (displayName null) como o cliente antigo.
    let displayName = null;
    // (1.51.75) avatar e nível do perfil, para a tela de Partida Encontrada.
    let queueProfile = null;
    // (1.51.86) playerId da conta: chave da exclusão pós-recusa.
    let queuePlayerId = null;
    const tok = payload?.token || payload?.authToken;
    if (tok) {
      try {
        const account = await authPlayerFromToken(String(tok));
        if (account?.displayName) displayName = account.displayName;
        if (account) {
          queuePlayerId = account.id || null;
          queueProfile = {
            avatarHeroId: account.avatarHeroId || null,
            level: levelFromXp(account.xpTotal || 0),
            avatarFrame: account.avatarFrame || null,
          };
        }
      } catch (e) { /* anônimo */ }
    }
    // (1.51.95 item 7) FIM DA REGRA DE BANIMENTO: fechar a tela de
    // encontro não deixa mais a conta sem entrar na fila (o bloco
    // ONLINE_BAN da 1.51.88 foi removido daqui).
    const queued = addToQueue(socket.id, displayName, queueProfile, queuePlayerId);
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
    if (rejectUnlessGame(ack, "game_action")) return;
    void (async () => {
    const t0 = Date.now();
    const actionType = payload?.action?.type || payload?.type;
    const skipRate =
      actionType === "SYNC_STATE" ||
      actionType === "PLAY_VISUAL" ||
      actionType === "PRESENT" ||
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

    const roomCode = socketRoom.get(socket.id);
    const roomProbe = getRoom(roomCode);
    if (!roomProbe) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    if (roomProbe.status !== "playing") return ack?.({ ok: false, error: "NOT_PLAYING" });
    if (seatForSocket(roomProbe, socket.id) === null) return ack?.({ ok: false, error: "NO_SEAT" });

    try {
      await withRoomLock(roomProbe.code, async () => {
        const room = getRoom(roomCode);
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
          const prev = room._ackedClientActions.get(`${seat}:${clientActionId}`);
          // (1.51.96 item 6) o clientActionId do cliente recomeça do
          // zero a cada reabertura do jogo ("a-<assento>-<seq>"): uma
          // ação NOVA com o mesmo id de uma ação ANTIGA recebia o ack
          // guardado sem ser aplicada — o jogador que voltava não
          // conseguia agir (o END_TURN voltava ok=true com o estado
          // antigo). O replay só vale para o reenvio DA MESMA ação
          // (após ACK_TIMEOUT); ação diferente com o mesmo id é
          // processada normalmente e substitui o registro.
          if (prev && prev.actionJson === JSON.stringify(action)) {
            return ack?.(prev.ack);
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
            // (Fase 6 T1) fog: o estado de reconciliação também é projetado.
            authoritativeState: auth ? projectStateForSeat(auth, seat) : null,
          });
        }

        // Lote F — Bloco 2 (C-A05/C-A06): Ultimate suspensa sem estado
        // cometido — nada a difundir (o defensor só vê a QUERY); abrir a
        // suspensão e responder o ack como suspenso. Sem authoritativeState
        // no ack (nada mudou — evita clobber num reenvio idempotente).
        if (result.suspended && !result.committed) {
          const spec = result.suspendSpec || {
            kind: result.suspendKind,
            deferredAction: result.deferredAction,
            defenderSeat: result.defenderSeat,
            askerSeat: result.askerSeat,
          };
          const opened = await openReactiveSuspension(room, io, reactiveHooks(room), spec);
          const ackSuspended = {
            ok: true, suspended: true,
            qid: opened.qid ?? room.mpPendingReactive?.qid ?? null,
            expiresAt: room.mpPendingReactive?.expiresAt ?? null,
            seq: room.actionSeq,
            authoritativeState: null,
            turnDeadline: room.turnDeadline || null,
            // U-B07 / E-N1 Opção 1 (rodada 5): o visual viaja COM a
            // suspensão — o ator vê a animação enquanto o defensor
            // responde (o pendente guarda o envelope da query).
            presentationEnvelope: result.presentationEnvelope
              || room.mpPendingReactive?.presentationEnvelope || undefined,
            presentation: result.presentation
              || room.mpPendingReactive?.presentationEnvelope?.visuals || undefined,
          };
          if (clientActionId) {
            room._ackedClientActions.set(`${seat}:${clientActionId}`, { ack: ackSuspended, actionJson: JSON.stringify(action) });
            if (room._ackedClientActions.size > 200) {
              const first = room._ackedClientActions.keys().next().value;
              room._ackedClientActions.delete(first);
            }
          }
          return ack?.(ackSuspended);
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
          authoritativeState: (result.omitAuthoritativeState || (result.skip && result.uiOnly))
            ? null
            : (result.state || room.gameState || null),
          events: result.events || [],
          logEntry: result.logEntry || null,
          delegated: !!result.delegated,
          skip: !!result.skip,
          forfeit: action.type === "SURRENDER",
          presentation: result.presentation || null,
          presentationEnvelope: result.presentationEnvelope || null,
        };
        if (result.state && !result.skip) {
          room.lastSnapshot = { state: result.state, full: true };
        }

        // Relógio do turno: ambos os clientes sincronizam a partir do deadline.
        // C-A19: 70 s FIXOS por turno (igual ao offline) — a ação só redefine o
        // deadline se o turno virou (ex.: END_TURN); senão o prazo continua.
        resetTurnTimerOnTurnChange(room);
        envelope.turnDeadline = room.turnDeadline || null;

        for (let s = 0; s < 2; s++) {
          const sid = room.sockets[s];
          if (!sid || sid === socket.id) continue;
          let peerEnv = envelope.authoritativeState
            ? attachPeerStateDiff(room, envelope, s, projectStateForSeat, recordStateDiff)
            : envelope;
          // C-B03: fog no DRAW do oponente (cópia rasa — envelope compartilhado).
          if (peerEnv?.events) peerEnv = { ...peerEnv, events: projectEventsForSeat(peerEnv.events, s) };
          io.to(sid).emit("remote_action", peerEnv);
        }

        // C-N10 (Opção A — timer por sala): a ação pode ter posto uma
        // apodrecida no campo — rearmar para o prazo mais próximo.
        armApodrecidaTimer(room, apodrecidaTimerDeps());

        // Pergunta reativa para assento sob IA: responder já, senão o atacante
        // fica preso no timeout de 10s (jogo "congelado" após escolher o alvo).
        // Suspenso (Lote F): a suspensão é dona da pergunta — não responder
        // aqui (dobraria a resposta e consumiria a carta duas vezes).
        if (!result.suspended) {
          maybeAnswerReactiveForAi(room, action, seat);
        }

        touchPersist(room);
        await mirrorRoomNow(room);
        maybeFinishMatch(room, result.state);
        // Suspenso: o tick da IA só continua na retomada (onAiResume).
        if (!result.suspended) {
          scheduleServerAi(room, io, serverAiHooks(room));
        }

        // Lote F — Bloco 2 (reações): reduções cometidas (C-A07) abrem a
        // suspensão DEPOIS de difundir o estado intermediário; a ANSWER
        // casa com o pendente (por qid) e retoma a ação suspensa.
        let resolvedSuspension = null;
        if (result.suspended && result.committed) {
          const spec = result.suspendSpec || {
            kind: result.suspendKind,
            deferredAction: result.deferredAction,
            defenderSeat: result.defenderSeat,
            askerSeat: result.askerSeat,
          };
          await openReactiveSuspension(room, io, reactiveHooks(room), spec);
        } else if (action.type?.startsWith("REACTIVE_") && action.type?.endsWith("_ANSWER")
            && room.mpPendingReactive) {
          resolvedSuspension = await resolveReactiveSuspension(room, io, reactiveHooks(room), action);
        }

        recordActionLatency(Date.now() - t0, {
          roomCode: room.code,
          seat,
          type: action.type,
          seq: room.actionSeq,
          ok: true,
        });

        // (Fase 6 T1) fog: o ack leva o estado projetado por assento —
        // a mão do adversário nunca viaja para o ator. Após uma retomada
        // (Lote F), o estado é o ATUAL (room.gameState), não o da ANSWER.
        const ackStateRaw = resolvedSuspension
          ? (room.gameState || null)
          : ((result.omitAuthoritativeState || (result.skip && result.uiOnly))
            ? (room.gameState || null)
            : (result.state || room.gameState || null));
        const ackPayload = {
          ok: true,
          seq: room.actionSeq,
          authoritativeState: ackStateRaw ? projectStateForSeat(ackStateRaw, seat) : null,
          events: result.events || [],
          logEntry: result.logEntry || null,
          skip: !!result.skip,
          presentation: result.presentation || null,
          presentationEnvelope: result.presentationEnvelope || null,
          turnDeadline: room.turnDeadline || null,
          // Lote F: uma suspensão encadeada ficou aberta (C-A06/C-A07).
          ...(room.mpPendingReactive
            ? {
              suspended: true,
              qid: room.mpPendingReactive.qid,
              expiresAt: room.mpPendingReactive.expiresAt,
            }
            : {}),
        };
        if (clientActionId) {
          room._ackedClientActions.set(`${seat}:${clientActionId}`, { ack: ackPayload, actionJson: JSON.stringify(action) });
          // Limite simples — evita crescimento infinito.
          if (room._ackedClientActions.size > 200) {
            const first = room._ackedClientActions.keys().next().value;
            room._ackedClientActions.delete(first);
          }
        }
        ack?.(ackPayload);
      });
    } catch (e) {
      const errCode = e?.code || e?.message;
      if (errCode === "ROOM_LOCK_TIMEOUT") {
        recordReject("ROOM_LOCK_TIMEOUT", { type: actionType });
        return ack?.({ ok: false, error: "ROOM_LOCK_TIMEOUT" });
      }
      console.warn("[game_action]", e?.message || e);
      return ack?.({ ok: false, error: "SERVER_ERROR" });
    }
    })();
  });

  socket.on("get_replay", (payload, ack) => {
    if (rejectUnlessGame(ack, "get_replay")) return;
    const schema = validateGetReplay(payload);
    if (!schema.ok) return ack?.({ ok: false, error: schema.error });
    const room = getRoom(socketRoom.get(socket.id));
    if (!room) return ack?.({ ok: false, error: "NOT_IN_ROOM" });
    const fromSeq = Number(payload?.fromSeq) || 0;
    const seat = seatForSocket(room, socket.id);
    const actionSeq = room.actionSeq | 0;
    // Gap-fill mid-match (fromSeq>0 atrás do seq) — fromSeq=0 = resume/reconnect, não conta.
    const isGapFill = fromSeq > 0 && fromSeq < actionSeq;
    if (isGapFill) {
      recordGapFill({
        roomCode: room.code,
        seat,
        fromSeq,
        actionSeq,
        gap: actionSeq - fromSeq,
      });
    }
    const full = buildReplayPayload(room);
    if (!full) return ack?.({ ok: false, error: "NOT_PLAYING" });
    ack?.({
      ok: true,
      seq: full.seq,
      entries: full.entries.filter((e) => e.seq > fromSeq),
      snapshot: full.snapshot,
      gameState: full.gameState,
      heroIds: full.heroIds,
      gapFill: isGapFill,
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
    void (async () => {
    removeFromQueue(socket.id);
    removeFromRankedQueue(socket.id);
    const room = getRoom(socketRoom.get(socket.id));
    const seat = room ? seatForSocket(room, socket.id) : null;
    let forfeitPayload = null;
    const wantForfeit = !!(payload && typeof payload === "object" && payload.forfeit);
    const wantAbandon = !!(payload && typeof payload === "object" && payload.abandon);

    if (room && seat !== null && room.status === "playing" && room.gameState?.winner == null) {
      if (wantForfeit) {
        // Desistir: vitória imediata do oponente.
        await withRoomLock(room.code, async () => {
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
              let peerEnv = attachPeerStateDiff(
                room,
                envelope,
                s,
                projectStateForSeat,
                recordStateDiff,
              );
              // C-B03: fog no DRAW do oponente (cópia rasa — envelope compartilhado).
              if (peerEnv?.events) peerEnv = { ...peerEnv, events: projectEventsForSeat(peerEnv.events, s) };
              io.to(sid).emit("remote_action", peerEnv);
            }
            await mirrorRoomNow(room);
            maybeFinishMatch(room, result.state);
            const winner = result.state?.winner ?? ((seat + 1) % 2);
            forfeitPayload = { forfeit: true, winner, seat, canReconnect: false };
          }
        });
        leaveSocketRoom(socket, forfeitPayload);
        ack?.({ ok: true });
        return;
      }

      // Abandono / sair da partida: assento fica livre para reconexão; IA assume.
      // (igual queda de rede, mas IA imediata)
      const info = disconnectSocket(room, socket.id);
      socketRoom.delete(socket.id);
      try { socket.leave(room.code); } catch (e) { /* */ }
      emitRoom(room, "peer_disconnected", {
        seat: info?.seat ?? seat,
        canReconnect: true,
        abandoned: true,
        turnDeadline: room.turnDeadline || null,
      });
      markSeatAbandonedForAi(room, seat, io, serverAiHooks(room));
      touchPersist(room);
      ack?.({ ok: true, abandoned: true });
      return;
    }

    // Voltar ao Menu após vitória/derrota (sem forfeit): saída limpa.
    if (room && seat !== null && room.status === "ended" && !wantForfeit) {
      leaveSocketRoom(socket, null);
      ack?.({ ok: true });
      return;
    }

    // SURRENDER já aplicado via game_action: peer_left ainda precisa de forfeit+winner.
    if (room && seat !== null && wantForfeit && room.gameState?.winner != null) {
      forfeitPayload = {
        forfeit: true,
        winner: room.gameState.winner | 0,
        seat,
        canReconnect: false,
      };
    } else if (room && seat !== null && wantForfeit && room.gameState?.winner == null) {
      const winner = (seat + 1) % 2;
      forfeitPayload = { forfeit: true, winner, seat, canReconnect: false };
    }
    leaveSocketRoom(socket, forfeitPayload);
    ack?.({ ok: true });
  })();
  });

  socket.on("disconnect", () => {
    socketPlayer.delete(socket.id);
    removeFromQueue(socket.id);
    removeFromRankedQueue(socket.id);
    const code = socketRoom.get(socket.id);
    const room = getRoom(code);
    if (!room) return;
    // (1.51.86) queda durante o aceite = recusa: dissolve a sala de
    // lobby por completo (exclusão do par por 30 s) e avisa o outro
    // assento com match_declined {reason:"disconnect"}. Em partida o
    // comportamento de hoje não muda (IA assume, volta por rejoin).
    if (room.status === "lobby" && matchAcceptState.has(room.code)) {
      const seat = seatForSocket(room, socket.id);
      socketRoom.delete(socket.id);
      recordDisconnect({
        roomCode: room.code,
        seat: seat ?? null,
        playing: false,
      });
      if (seat !== null) dissolveLobbyRoom(room, "disconnect", seat);
      else clearAcceptState(room.code);
      return;
    }
    const info = disconnectSocket(room, socket.id);
    socketRoom.delete(socket.id);
    recordDisconnect({
      roomCode: room.code,
      seat: info?.seat,
      playing: room.status === "playing",
    });
    const win = room.gameState?.winner;
    if (win != null && (room.status === "ended" || room.status === "playing")) {
      emitRoom(room, "peer_disconnected", {
        seat: info?.seat,
        forfeit: true,
        winner: win | 0,
        canReconnect: false,
        turnDeadline: room.turnDeadline || null,
      });
    } else {
      emitRoom(room, "peer_disconnected", {
        seat: info?.seat,
        canReconnect: room.status === "playing",
        turnDeadline: room.turnDeadline || null,
      });
    }
    if (room.status === "playing" && info?.seat != null) {
      markSeatDisconnectedForAi(room, info.seat, io, serverAiHooks(room));
    }
    broadcastRoomState(room);
    touchPersist(room);
  });
});

/**
 * Login em 1 dispositivo só (1.51.70, item 7): quando um aparelho loga numa
 * conta, os sockets antigos da conta recebem `session_revoked` (o emit
 * atravessa processos via Redis adapter) e são derrubados ~500 ms depois.
 * A lista de alvos é fotografada NA HORA do aviso: um socket novo que
 * autenticar dentro da janela de 500 ms NÃO é derrubado.
 */
setSessionRevokedNotifier((playerId, { deviceLabel } = {}) => {
  io.to(`player:${playerId}`).emit("session_revoked", {
    reason: "LOGGED_IN_ELSEWHERE",
    deviceLabel: deviceLabel || null,
  });
  const targets = [...socketPlayer.entries()]
    .filter(([, pid]) => pid === playerId)
    .map(([sid]) => sid);
  if (!targets.length) return;
  setTimeout(() => {
    for (const sid of targets) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.disconnect(true);
    }
  }, 500);
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
  flushRankStore();
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
await initRankStore();
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

// RoomStore Redis (dual-write) — após PG para não duplicar; Redis preenche gaps.
try {
  await initRoomStore();
  await hydrateRoomsFromRedis(importPersistedRoom);
} catch (e) {
  console.error("[room-store] init:", e?.message || e);
  if (process.env.DF_REQUIRE_REDIS === "1") process.exit(1);
}

// Relógio + IA das salas restauradas (JSON/PG deixam turnTimer:null).
try {
  revivePlayingRoomTimers();
} catch (e) {
  console.warn("[boot] revive timers:", e?.message || e);
}

await initRankedMatchmaking(async (entry0, entry1) => {
  return pairRankedSockets(io, entry0, entry1);
});

// Warm motor + Redis adapter antes do listen.
getEngineBootStatus();
const redisOk = await attachSocketRedisAdapter(io);
if (process.env.DF_REQUIRE_REDIS === "1" && !redisOk) {
  console.error("[boot] DF_REQUIRE_REDIS=1 mas Redis adapter falhou — abortando.");
  process.exit(1);
}

httpServer.listen(PORT, () => {
  console.log(`Dragonfall server em http://localhost:${PORT}`);
  console.log(`WebSocket (Socket.IO) na mesma porta`);
  logMailStatusOnBoot();
  startSelfKeepAlive(PORT);
  const motor = getEngineBootStatus();
  logMp("boot", {
    gameVersion: GAME_VERSION,
    rooms: listRoomsCount(),
    processRole: PROCESS_ROLE,
    shardId: getLocalShardId(),
    shardCount: getShardCount(),
    postgres: isPostgresEnabled(),
    matchmaking: getMatchmakingMode(),
    motorOk: !!motor.motorOk,
    redisAdapter: isRedisAdapterAttached(),
  });
});

// Poda periódica de salas (T3): sem ela, sala encerrada só era podada num
// create/join novo e ocupava vaga no limite de 40 até 2 h.
setInterval(() => {
  try {
    const pruned = pruneOldRooms();
    for (const p of pruned) {
      // (1.51.86) sala podada não pode deixar timer de aceite órfão.
      clearAcceptState(p.code);
      // Apaga o espelho de toda sala podada (qualquer status — a linha
      // pode existir como 'playing' órfã de uma corrida antiga).
      void deleteLiveRoom(p.code);
    }
    // (1.51.95 item 5) a poda tem de chegar aos espelhos: sem isto uma
    // sala podada da memória voltava no próximo boot pelo rooms.json
    // (quando o Postgres está desligado) — o vazamento ressuscitava.
    if (pruned.length) touchPersist();
    void deleteStaleLiveRooms();
    // Reconciliação: linha 'playing' sem sala viva na memória é órfã
    // (podada por outro caminho, ex.: create/join). Só com 1 shard — com
    // vários, cada processo só conhece as próprias salas.
    if (getShardCount() <= 1) void deleteOrphanLiveRooms(listPlayingRoomCodes());
  } catch (e) { /* nunca derrubar o servidor por causa da poda */ }
}, 60_000).unref?.();

// (1.51.86) Varredura da fila casual (1 s): sem ela, um par cuja
// exclusão de 30 s expirou ficaria esperando para sempre — o pareamento
// casual só acontecia no join_queue. Com <2 na fila o takePair volta
// na hora; com o par excluído, volta null e tenta de novo no próximo
// segundo, até a exclusão expirar e o par formar.
setInterval(() => {
  try {
    pairQueueSockets(io);
  } catch (e) { /* nunca derrubar o servidor por causa da varredura */ }
}, 1000).unref?.();
