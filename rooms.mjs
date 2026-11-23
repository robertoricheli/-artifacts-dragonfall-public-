/**
 * Salas 1v1 — código DRAGON-XXXX
 */
import { MAX_ROOMS } from "./df-mp-limits.mjs";
import { ensureSeatTokens, seatTokenFor } from "./df-seat-token.mjs";
import { scheduleRoomMirror, scheduleRoomMirrorDelete } from "./df-room-store.mjs";

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
// Sala encerrada: só precisa ficar viva p/ o jogador que volta ver o fim
// (replay final) — depois disso é vaga ocupada à toa no limite de 40.
// Ajustável por ambiente (DF_ENDED_ROOM_TTL_MS), como DF_MAX_ROOMS.
const ENDED_ROOM_TTL_MS = Number(process.env.DF_ENDED_ROOM_TTL_MS) || 10 * 60 * 1000;
// Lobby sem ninguém conectado: ninguém vai voltar a ele.
const EMPTY_LOBBY_TTL_MS = 10 * 60 * 1000;
// (1.51.95 item 5) Partida em jogo ABANDONADA: os dois jogadores
// desconectaram (a IA assume os dois lados) e ninguém mais é visto.
// Antes só o TTL de 2 h a removia — cada run de teste deixava ~1 sala
// e com 40/40 a busca travava em SERVER_BUSY. Com os dois sockets
// mortos e ninguém visto por este tempo, a partida é órfã: a IA já
// teria terminado o jogo bem antes (o relógio de 70 s força o turno);
// se não terminou, está travada. 10 min é folga de sobra p/ quem caiu
// e volta — e com UM socket vivo a regra nem se aplica (a partida
// continua). Ajustável por ambiente (DF_PLAYING_IDLE_TTL_MS).
const PLAYING_IDLE_TTL_MS = Number(process.env.DF_PLAYING_IDLE_TTL_MS) || 10 * 60 * 1000;

const rooms = new Map();

function randomChunk(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function makeRoomCode(opts = {}) {
  const preferShard = opts.preferShard;
  const shardCount = opts.shardCount != null ? opts.shardCount : 1;
  let code;
  let tries = 0;
  do {
    code = `DRAGON-${randomChunk(4)}`;
    tries += 1;
    if (preferShard == null || shardCount <= 1) {
      if (!rooms.has(code)) break;
    } else {
      // Import circular avoided — caller passa hashFn
      const id = typeof opts.shardIdFor === "function" ? opts.shardIdFor(code) : preferShard;
      if (!rooms.has(code) && id === preferShard) break;
    }
  } while (tries < 80);
  return code;
}

/** @returns {{ ok: true, room: object } | { ok: false, error: string }} */
export function createRoom(opts = {}) {
  pruneOldRooms();
  if (rooms.size >= MAX_ROOMS) {
    return { ok: false, error: "SERVER_BUSY" };
  }
  const code = makeRoomCode(opts);
  if (opts.preferShard != null && opts.shardCount > 1 && typeof opts.shardIdFor === "function") {
    if (opts.shardIdFor(code) !== opts.preferShard) {
      return { ok: false, error: "SHARD_CODE_FAIL" };
    }
  }
  const room = {
    code,
    createdAt: Date.now(),
    status: "lobby",
    sockets: [null, null],
    heroes: [null, null],
    playerNames: [null, null],
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
  scheduleRoomMirror(room);
  return { ok: true, room };
}

/** Compat: createRoom always returned room before — wrappers use createRoomSafe. */
export function createRoomOrThrow(opts = {}) {
  const r = createRoom(opts);
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
  scheduleRoomMirrorDelete(code);
}

/**
 * Remove salas vencidas. Devolve as removidas ({ code, status }) para o
 * chamador limpar também os espelhos (Postgres/Redis). Antes só rodava
 * em create/join e só com TTL de 2 h p/ tudo — salas encerradas ficavam
 * ocupando vaga no limite de 40 até 2 h, e com 40/40 a busca travava
 * sem erro visível.
 */
export function pruneOldRooms() {
  const now = Date.now();
  const pruned = [];
  for (const [code, room] of rooms) {
    let expired = now - room.createdAt > ROOM_TTL_MS;
    if (!expired && room.status === "ended") {
      const endRef = room.endedAt || room.createdAt;
      expired = now - endRef > ENDED_ROOM_TTL_MS;
    }
    if (!expired && room.status === "lobby" && !room.sockets[0] && !room.sockets[1]) {
      expired = now - room.createdAt > EMPTY_LOBBY_TTL_MS;
    }
    if (!expired && room.status === "playing" && !room.sockets[0] && !room.sockets[1]) {
      // (1.51.95 item 5) partida abandonada: o relógio é a última vez
      // que um humano foi visto (match_ping/join tocam lastSeen); sem
      // nenhum toque, vale a criação (pareamento não tocava lastSeen
      // até a 1.51.95 — ver pairQueueSockets). Só poda com os DOIS
      // sockets mortos: com um vivo, a partida continua.
      const seen = Math.max(room.lastSeen?.[0] || 0, room.lastSeen?.[1] || 0);
      const idleRef = seen > 0 ? seen : room.createdAt;
      expired = now - idleRef > PLAYING_IDLE_TTL_MS;
    }
    if (expired) {
      rooms.delete(code);
      scheduleRoomMirrorDelete(code);
      pruned.push({ code, status: room.status });
    }
  }
  return pruned;
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

  // Token válido casa com o assento dele mesmo sem preferSeat (volta com
  // o código guardado, sem dizer o assento) — ANTES do "primeiro vazio",
  // senão quem volta ao assento 1 cai no 0 e a IA não sai do lugar certo.
  if (seatToken) {
    ensureSeatTokens(room);
    const tokenSeat = room.seatTokens[0] === seatToken ? 0 : room.seatTokens[1] === seatToken ? 1 : null;
    if (tokenSeat !== null) {
      room.sockets[tokenSeat] = socketId;
      touchLastSeen(room, tokenSeat);
      return {
        ok: true,
        seat: tokenSeat,
        room,
        reconnected: true,
        seatToken: seatTokenFor(room, tokenSeat),
      };
    }
  }

  if (!room.sockets[0]) {
    room.sockets[0] = socketId;
    touchLastSeen(room, 0);
    // Em partida os dois assentos já têm dono — ocupar um assento vazio
    // aqui é volta de humano, não entrada nova.
    return { ok: true, seat: 0, room, reconnected: room.status === "playing", seatToken: seatTokenFor(room, 0) };
  }
  if (!room.sockets[1]) {
    room.sockets[1] = socketId;
    touchLastSeen(room, 1);
    return { ok: true, seat: 1, room, reconnected: room.status === "playing", seatToken: seatTokenFor(room, 1) };
  }
  return { ok: false, error: "ROOM_FULL" };
}

export function touchLastSeen(room, seat) {
  if (!room.lastSeen) room.lastSeen = [0, 0];
  if (seat === 0 || seat === 1) room.lastSeen[seat] = Date.now();
  scheduleRoomMirror(room);
}

/** Queda de conexão — preserva partida para reconexão. */
export function disconnectSocket(room, socketId) {
  const seat = seatForSocket(room, socketId);
  if (seat === null) return null;
  room.sockets[seat] = null;
  scheduleRoomMirror(room);
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
  scheduleRoomMirror(room);
  return { deleted: false, seat };
}

/**
 * Nível do perfil — MESMA fórmula do cliente (Profile.level(),
 * DRAGONFALL/scripts/profile.gd: XP_PER_LEVEL=10, JOURNEY_MAX_LEVEL=62):
 * 1 + floor(xp/10), entre 1 e 62. NÃO usar statsFromTotalXp de
 * df-auth.mjs aqui: aquela curva (custo level+1 por nível) é outra e
 * divergiria do nível que o próprio jogador vê no perfil dele.
 */
export function levelFromXp(xp) {
  const n = Math.floor((Number(xp) || 0) / 10);
  return Math.min(62, Math.max(1, 1 + n));
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
        displayName: (room.playerNames || [null, null])[0] || null,
        // (1.51.75) avatar e nível do perfil, para a tela de Partida
        // Encontrada — preenchidos no pareamento; sem eles, null/0 e
        // o cliente usa o retrato do herói / esconde o nível.
        // (1.51.80) moldura do avatar, mesmo caminho (room.playerFrames);
        // sem ela, null e o cliente usa a borda dourada de hoje.
        avatarHeroId: (room.playerAvatars || [null, null])[0] || null,
        level: (room.playerLevels || [0, 0])[0] || 0,
        avatarFrame: (room.playerFrames || [null, null])[0] || null,
        ready: room.ready[0],
        isYou: yourSeat === 0,
      },
      {
        seat: 1,
        connected: !!room.sockets[1],
        heroId: room.heroes[1],
        displayName: (room.playerNames || [null, null])[1] || null,
        avatarHeroId: (room.playerAvatars || [null, null])[1] || null,
        level: (room.playerLevels || [0, 0])[1] || 0,
        avatarFrame: (room.playerFrames || [null, null])[1] || null,
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

/** Códigos das salas em jogo (para reconciliar o espelho no Postgres). */
export function listPlayingRoomCodes() {
  const out = new Set();
  for (const room of rooms.values()) {
    if (room.status === "playing") out.add(room.code);
  }
  return out;
}

export function listRoomsByStatus() {
  const out = { lobby: 0, playing: 0, ended: 0 };
  for (const room of rooms.values()) {
    if (room.status === "playing") out.playing += 1;
    else if (room.status === "ended") out.ended += 1;
    else out.lobby += 1;
  }
  return out;
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
  // Não ressuscitar sala velha demais (ex.: linha 'playing' de horas
  // atrás que escapou do filtro de idade na leitura).
  const ageRef = data.createdAt || Date.now();
  if (Date.now() - ageRef > ROOM_TTL_MS) return null;
  // Sala com vencedor já definido está encerrada, mesmo que o registro
  // diga 'playing' (corrida da persistência antes do fim) — sem isto ela
  // ressuscita e ocupa vaga até o TTL de 2 h.
  if (data.gameState?.winner != null && data.status !== "ended") {
    data = {
      ...data,
      status: "ended",
      endedAt: data.updatedAt ? Date.parse(data.updatedAt) : Date.now(),
    };
  }
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
    // (1.51.95 item 5) restaurada ganha olhos novos: sem isto o lastSeen
    // [0,0] herdado + createdAt antigo fariam a regra de partida
    // abandonada podar a sala no primeiro sweep após o boot — e quem
    // voltou depois de um restart do servidor perderia a partida.
    lastSeen: [Date.now(), Date.now()],
    aiControlled: Array.isArray(data.aiControlled)
      ? [!!data.aiControlled[0], !!data.aiControlled[1]]
      : [false, false],
  };
  ensureSeatTokens(room);
  rooms.set(room.code, room);
  scheduleRoomMirror(room);
  return room;
}

export function listPlayingRooms() {
  return [...rooms.values()].filter((r) => r.status === "playing");
}
