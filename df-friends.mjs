/**
 * DRAGONFALL — Amigos, convites, bloqueios, denúncias, histórico e visita
 * ao perfil (Frente 3, projeto Perfil do Jogador, 2026-11-25).
 *
 * NÃO edita index.mjs, df-auth.mjs nem df-rank.mjs. A integração final liga
 * este módulo no servidor com:
 *
 *   import { register_friends_routes, register_friends_socket,
 *            initFriendsSchema, loadBlockCache } from "./df-friends.mjs";
 *   await initFriendsSchema();
 *   await loadBlockCache();
 *   register_friends_routes(app);
 *   register_friends_socket(io, {
 *     playerIdForSocket: (socket) => socketPlayer.get(socket.id) ?? null,
 *     createFriendRoom: async (inviterId, inviteeId) => ({ ok, roomCode }),
 *   });
 *
 * Pré-requisitos da integração (já existem no index.mjs de hoje):
 * - o handler `authenticate` do socket faz `socket.join(`player:${id}`)`
 *   (é por essa sala que o convite chega NA HORA ao convidado);
 * - `createFriendRoom` é implementado pela integração com os mesmos
 *   passos do pareamento casual (createRoomOrThrow + sockets + seat
 *   tokens + `match_found` para os dois), marcando a sala com
 *   `room.friend_match = true`, `room.ranked = false` e
 *   `room.playerIds = [inviterId, inviteeId]` — sem valer rank.
 *
 * Decisões (registradas; não reabrir sem a usuária):
 * - "seguir" é unilateral; "amigos" = quem o jogador segue + quem segue ele.
 * - bloqueio vale por tempo indeterminado; bloqueado NUNCA mais é pareado
 *   com quem bloqueou (filtro síncrono em matchmaking.takePair via
 *   isBlockedSync + cache em memória, alimentado por loadBlockCache() e
 *   atualizado a cada block()).
 * - partida com amigo ENTRA no histórico, marcada friendMatch=true e
 *   ranked=false (não entra "como ranqueada"; fica visível para as ações
 *   por entrada: adicionar/seguir/bloquear/reportar). Nunca conta rank:
 *   o registro de rank do servidor só olha salas com room.ranked.
 * - convite expira em 30 s sem resposta.
 * - GET /auth/profile/:id NUNCA devolve moedas, diamantes, e-mail ou
 *   dados de conta — só o perfil público.
 */

import { getPgPool, getPlayerHistory } from "./df-postgres.mjs";
import {
  authPlayerFromToken,
  getPlayerById,
} from "./df-auth-store.mjs";
import { rankPublic, seasonPublic, bestTierOf, tierId } from "./df-rank.mjs";
import { levelFromXp } from "./rooms.mjs";

export const FRIEND_INVITE_TTL_MS = 30_000;
export const HISTORY_LIMIT = 10;
export const REPORT_REASONS = Object.freeze(["trapaça", "mau comportamento"]);

const FRIENDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS df_follows (
  follower_id VARCHAR(64) NOT NULL,
  followed_id VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, followed_id)
);
CREATE INDEX IF NOT EXISTS df_follows_followed ON df_follows (followed_id);
CREATE TABLE IF NOT EXISTS df_blocks (
  blocker_id VARCHAR(64) NOT NULL,
  blocked_id VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS df_blocks_blocked ON df_blocks (blocked_id);
CREATE TABLE IF NOT EXISTS df_reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id VARCHAR(64) NOT NULL,
  reported_id VARCHAR(64) NOT NULL,
  reason VARCHAR(32) NOT NULL,
  match_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS df_reports_reported ON df_reports (reported_id);
`;

/** Fallback sem Postgres (dev local): os mesmos dados em memória. */
const memFollows = new Set(); // "follower|followed"
const memBlocks = new Set(); // "blocker|blocked"
const memReports = [];

/**
 * Cache síncrono de bloqueios para o pareamento (matchmaking.takePair é
 * síncrono e não pode esperar o Postgres). Chave ordenada "a|b".
 * Alimentado por loadBlockCache() no boot e atualizado em block().
 */
const blockCache = new Set();

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pg() {
  return getPgPool();
}

export async function initFriendsSchema() {
  const pool = pg();
  if (!pool) return { enabled: false, mode: "memory" };
  await pool.query(FRIENDS_SCHEMA);
  return { enabled: true, mode: "postgres" };
}

/** Carrega TODOS os bloqueios para o cache síncrono do pareamento. */
export async function loadBlockCache() {
  blockCache.clear();
  const pool = pg();
  if (pool) {
    const res = await pool.query(`SELECT blocker_id, blocked_id FROM df_blocks`);
    for (const r of res.rows) blockCache.add(pairKey(String(r.blocker_id), String(r.blocked_id)));
  } else {
    for (const k of memBlocks) {
      const [a, b] = k.split("|");
      blockCache.add(pairKey(a, b));
    }
  }
  return { size: blockCache.size };
}

/** Síncrono, para takePair(): há bloqueio mútuo entre a e b? */
export function isBlockedSync(a, b) {
  if (!a || !b || a === b) return false;
  return blockCache.has(pairKey(String(a), String(b)));
}

/** Fonte da verdade (Postgres ou memória); atualiza o cache. */
export async function isBlockedBetween(a, b) {
  if (!a || !b || a === b) return false;
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `SELECT 1 FROM df_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
      [String(a), String(b)],
    );
    const blocked = res.rows.length > 0;
    if (blocked) blockCache.add(pairKey(String(a), String(b)));
    return blocked;
  }
  return memBlocks.has(`${a}|${b}`) || memBlocks.has(`${b}|${a}`);
}

function normId(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/**
 * getPlayerById LANÇA com id malformado (df_players.id é UUID: um
 * "inexistente" vira erro 22P02 no Postgres). Para as rotas, id
 * inválido é só "jogador não encontrado" — nunca 500.
 */
async function safeGetPlayer(id) {
  try {
    return await getPlayerById(id);
  } catch (e) {
    return null;
  }
}

function miniProfile(p) {
  if (!p) return null;
  return {
    playerId: p.id,
    name: p.displayName || null,
    level: levelFromXp(p.xpTotal || 0),
    avatarHeroId: p.avatarHeroId || null,
    avatarFrame: p.avatarFrame || null,
  };
}

export async function listFriends(playerId) {
  const pool = pg();
  let followingIds = [];
  let followerIds = [];
  if (pool) {
    const [a, b] = await Promise.all([
      pool.query(`SELECT followed_id FROM df_follows WHERE follower_id = $1 ORDER BY created_at DESC`, [playerId]),
      pool.query(`SELECT follower_id FROM df_follows WHERE followed_id = $1 ORDER BY created_at DESC`, [playerId]),
    ]);
    followingIds = a.rows.map((r) => r.followed_id);
    followerIds = b.rows.map((r) => r.follower_id);
  } else {
    for (const k of memFollows) {
      const [f, t] = k.split("|");
      if (f === playerId) followingIds.push(t);
      if (t === playerId) followerIds.push(f);
    }
  }
  const load = async (ids) => {
    const out = [];
    for (const id of ids) {
      const p = await safeGetPlayer(id);
      if (p) out.push(miniProfile(p));
    }
    return out;
  };
  return {
    following: await load(followingIds),
    followers: await load(followerIds),
  };
}

export async function followPlayer(followerId, followedId) {
  if (followerId === followedId) return { ok: false, error: "CANNOT_FOLLOW_SELF" };
  const target = await safeGetPlayer(followedId);
  if (!target) return { ok: false, error: "PLAYER_NOT_FOUND" };
  if (await isBlockedBetween(followerId, followedId)) return { ok: false, error: "BLOCKED" };
  const pool = pg();
  if (pool) {
    await pool.query(
      `INSERT INTO df_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [followerId, followedId],
    );
  } else {
    memFollows.add(`${followerId}|${followedId}`);
  }
  return { ok: true, following: true };
}

export async function unfollowPlayer(followerId, followedId) {
  const pool = pg();
  if (pool) {
    await pool.query(`DELETE FROM df_follows WHERE follower_id = $1 AND followed_id = $2`, [followerId, followedId]);
  } else {
    memFollows.delete(`${followerId}|${followedId}`);
  }
  return { ok: true, following: false };
}

/**
 * Bloqueia por tempo indeterminado. Também desfaz os "seguir" nos dois
 * sentidos (não faz sentido continuar seguindo quem se bloqueou).
 */
export async function blockPlayer(blockerId, blockedId) {
  if (blockerId === blockedId) return { ok: false, error: "CANNOT_BLOCK_SELF" };
  const target = await safeGetPlayer(blockedId);
  if (!target) return { ok: false, error: "PLAYER_NOT_FOUND" };
  const pool = pg();
  if (pool) {
    await pool.query(
      `INSERT INTO df_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [blockerId, blockedId],
    );
    await pool.query(
      `DELETE FROM df_follows WHERE (follower_id = $1 AND followed_id = $2) OR (follower_id = $2 AND followed_id = $1)`,
      [blockerId, blockedId],
    );
  } else {
    memBlocks.add(`${blockerId}|${blockedId}`);
    memFollows.delete(`${blockerId}|${blockedId}`);
    memFollows.delete(`${blockedId}|${blockerId}`);
  }
  blockCache.add(pairKey(String(blockerId), String(blockedId)));
  return { ok: true, blocked: true };
}

export async function reportPlayer(reporterId, reportedId, reason, matchId = null) {
  if (reporterId === reportedId) return { ok: false, error: "CANNOT_REPORT_SELF" };
  if (!REPORT_REASONS.includes(reason)) return { ok: false, error: "INVALID_REASON" };
  const target = await safeGetPlayer(reportedId);
  if (!target) return { ok: false, error: "PLAYER_NOT_FOUND" };
  const pool = pg();
  if (pool) {
    await pool.query(
      `INSERT INTO df_reports (reporter_id, reported_id, reason, match_id) VALUES ($1, $2, $3, $4)`,
      [reporterId, reportedId, reason, matchId ? String(matchId) : null],
    );
  } else {
    memReports.push({ reporterId, reportedId, reason, matchId, createdAt: new Date().toISOString() });
  }
  return { ok: true, reported: true };
}

/** Perfil PÚBLICO de um jogador — nunca inclui moedas, diamantes, e-mail. */
export function publicProfile(p) {
  if (!p) return null;
  const rank = rankPublic(p.id);
  const season = seasonPublic();
  const seasonMatches = rank?.matches || 0;
  const seasonWins = rank?.wins || 0;
  // rank.level (nível dentro da divisão, 1–5) ainda não existe no
  // sistema de rank atual (só tier por % de vitórias): a frente de
  // ranking preenche quando o campo existir. Não inventar número.
  const rankLevel = rank?.level ?? null;
  const bestLevel = rank?.bestLevel ?? null;
  const xpTotal = Math.max(0, p.xpTotal | 0);
  return {
    playerId: p.id,
    name: p.displayName || null,
    avatarHeroId: p.avatarHeroId || null,
    avatarFrame: p.avatarFrame || null,
    profileBg: p.profileBg ?? p.profile_background ?? null,
    level: levelFromXp(p.xpTotal || 0),
    xp: {
      total: xpTotal,
      inLevel: xpTotal % 10,
      toNext: 10,
    },
    season: {
      id: season?.id ?? rank?.season ?? null,
      winRate: seasonMatches > 0 ? seasonWins / seasonMatches : null,
      matches: seasonMatches,
      wins: seasonWins,
    },
    rank: { tier: rank?.tierId ?? null, level: rankLevel },
    bestRank: { tier: tierId(bestTierOf(p.id)), level: bestLevel },
  };
}

/* ================= HTTP ================= */

function bearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

async function authed(req, res) {
  const player = await authPlayerFromToken(bearerToken(req));
  if (!player) {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    return null;
  }
  return player;
}

export function register_friends_routes(app, _ctx = {}) {
  app.get("/auth/friends", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const lists = await listFriends(me.id);
    res.status(200).json({ ok: true, ...lists });
  });

  app.post("/auth/friends/follow", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const targetId = normId(req.body?.playerId);
    if (!targetId) return res.status(400).json({ ok: false, error: "MISSING_PLAYER" });
    const r = await followPlayer(me.id, targetId);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post("/auth/friends/unfollow", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const targetId = normId(req.body?.playerId);
    if (!targetId) return res.status(400).json({ ok: false, error: "MISSING_PLAYER" });
    const r = await unfollowPlayer(me.id, targetId);
    res.status(200).json(r);
  });

  app.post("/auth/friends/block", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const targetId = normId(req.body?.playerId);
    if (!targetId) return res.status(400).json({ ok: false, error: "MISSING_PLAYER" });
    const r = await blockPlayer(me.id, targetId);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post("/auth/friends/report", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const targetId = normId(req.body?.playerId);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const matchId = normId(req.body?.matchId) || normId(req.body?.roomCode);
    if (!targetId) return res.status(400).json({ ok: false, error: "MISSING_PLAYER" });
    const r = await reportPlayer(me.id, targetId, reason, matchId);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.get("/auth/history", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const targetId = normId(req.query?.playerId) || me.id;
    const rows = await getPlayerHistory(targetId, HISTORY_LIMIT);
    const entries = [];
    for (const row of rows) {
      const mySeat = String(row.player_0_id) === String(targetId) ? 0 : 1;
      const oppSeat = 1 - mySeat;
      const oppId = oppSeat === 0 ? row.player_0_id : row.player_1_id;
      const opp = oppId ? await safeGetPlayer(oppId) : null;
      // (Frente 4, 1.51.102 item 7) linhas ANTIGAS podem ter score NULL
      // (gravado antes da normalização em recordMatchEnd/saveMatchHistory):
      // o cliente quebrava com int(null). Coalesce SÓ na leitura — o
      // banco não é reescrito e o sentido do histórico não muda (0 = sem
      // ponto registrado). Registros novos já chegam com 0.
      const score0 = row.score_0 ?? 0;
      const score1 = row.score_1 ?? 0;
      entries.push({
        matchId: row.id,
        roomCode: row.room_code,
        endedAt: row.ended_at,
        result: row.winner_seat == null ? null : (row.winner_seat === mySeat ? "win" : "loss"),
        score: [score0, score1],
        myScore: mySeat === 0 ? score0 : score1,
        opponentScore: mySeat === 0 ? score1 : score0,
        myHero: mySeat === 0 ? row.hero_0 : row.hero_1,
        opponentHero: mySeat === 0 ? row.hero_1 : row.hero_0,
        heroIds: [row.hero_0, row.hero_1],
        opponent: opp ? miniProfile(opp) : { playerId: oppId, name: null, level: 0, avatarHeroId: null, avatarFrame: null },
        ranked: !!row.ranked,
        friendMatch: !!row.friend_match,
      });
    }
    res.status(200).json({ ok: true, playerId: targetId, entries });
  });

  app.get("/auth/profile/:id", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const targetId = normId(req.params?.id);
    if (!targetId) return res.status(400).json({ ok: false, error: "MISSING_PLAYER" });
    const p = await safeGetPlayer(targetId);
    if (!p) return res.status(404).json({ ok: false, error: "PLAYER_NOT_FOUND" });
    res.status(200).json({ ok: true, player: publicProfile(p) });
  });
}

/* ================= Socket.IO — convites em tempo real ================= */

/**
 * @param {object} io Socket.IO server
 * @param {object} ctx
 * @param {(socket: object) => string|null} ctx.playerIdForSocket
 *   — como descobrir a conta dona do socket (a integração lê o mapa
 *   socketPlayer do index.mjs). Sem isto, o convite exige
 *   socket.data.playerId.
 * @param {(fromId: string, toId: string) => Promise<{ok:boolean,roomCode?:string,error?:string}>} ctx.createFriendRoom
 *   — cria a sala de amigo (integração: mesmos passos do pareamento
 *   casual + room.friend_match=true + match_found aos dois).
 *   Sem isto, o aceite só avisa os dois lados (invite_accepted) e a
 *   partida fica para a integração abrir.
 */
export function register_friends_socket(io, ctx = {}) {
  const playerIdForSocket =
    typeof ctx.playerIdForSocket === "function"
      ? ctx.playerIdForSocket
      : (socket) => socket?.data?.playerId || null;
  const createFriendRoom =
    typeof ctx.createFriendRoom === "function" ? ctx.createFriendRoom : null;
  // Só testes: encurtar o TTL do convite (produção: 30 s).
  const inviteTtlMs = Number(ctx.inviteTtlMs) > 0 ? Number(ctx.inviteTtlMs) : FRIEND_INVITE_TTL_MS;

  /** inviteId -> { id, fromId, toId, timer } */
  const pending = new Map();

  function expireInvite(invite, reason = "expired") {
    if (!invite) return;
    clearTimeout(invite.timer);
    pending.delete(invite.id);
    io.to(`player:${invite.fromId}`).emit("invite_expired", { inviteId: invite.id, reason });
    io.to(`player:${invite.toId}`).emit("invite_expired", { inviteId: invite.id, reason });
  }

  function cancelInvitesOf(playerId, reason = "disconnected") {
    for (const invite of [...pending.values()]) {
      if (invite.fromId === playerId || invite.toId === playerId) {
        expireInvite(invite, reason);
      }
    }
  }

  io.on("connection", (socket) => {
    socket.on("invite_friend", async (payload, ack) => {
      const fromId = playerIdForSocket(socket);
      if (!fromId) return ack?.({ ok: false, error: "UNAUTHORIZED" });
      const toId = normId(payload?.toPlayerId) || normId(payload?.playerId);
      if (!toId) return ack?.({ ok: false, error: "MISSING_PLAYER" });
      if (toId === fromId) return ack?.({ ok: false, error: "CANNOT_INVITE_SELF" });
      const target = await safeGetPlayer(toId);
      if (!target) return ack?.({ ok: false, error: "PLAYER_NOT_FOUND" });
      if (await isBlockedBetween(fromId, toId)) return ack?.({ ok: false, error: "BLOCKED" });
      for (const inv of pending.values()) {
        if (inv.fromId === fromId && inv.toId === toId) {
          return ack?.({ ok: false, error: "INVITE_ALREADY_PENDING", inviteId: inv.id });
        }
      }
      const me = await safeGetPlayer(fromId);
      const inviteId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const invite = { id: inviteId, fromId, toId, timer: null };
      invite.timer = setTimeout(() => expireInvite(invite, "expired"), inviteTtlMs);
      pending.set(inviteId, invite);
      io.to(`player:${toId}`).emit("invite_received", {
        inviteId,
        fromPlayerId: fromId,
        fromName: me?.displayName || null,
        fromLevel: levelFromXp(me?.xpTotal || 0),
        fromHero: me?.avatarHeroId || null,
      });
      ack?.({ ok: true, inviteId, expiresInMs: inviteTtlMs });
    });

    socket.on("invite_response", async (payload, ack) => {
      const responderId = playerIdForSocket(socket);
      if (!responderId) return ack?.({ ok: false, error: "UNAUTHORIZED" });
      const inviteId = normId(payload?.inviteId);
      const invite = inviteId ? pending.get(inviteId) : null;
      if (!invite) return ack?.({ ok: false, error: "INVITE_NOT_FOUND" });
      if (invite.toId !== responderId) return ack?.({ ok: false, error: "NOT_INVITEE" });
      const accept = payload?.accept === true;
      clearTimeout(invite.timer);
      pending.delete(invite.id);
      if (!accept) {
        io.to(`player:${invite.fromId}`).emit("invite_declined", { inviteId: invite.id, byPlayerId: responderId });
        return ack?.({ ok: true, accepted: false });
      }
      let room = null;
      if (createFriendRoom) {
        try {
          room = await createFriendRoom(invite.fromId, invite.toId);
        } catch (e) {
          room = { ok: false, error: e?.message || "ROOM_FAILED" };
        }
        if (!room?.ok) {
          io.to(`player:${invite.fromId}`).emit("invite_failed", { inviteId: invite.id, error: room?.error || "ROOM_FAILED" });
          io.to(`player:${invite.toId}`).emit("invite_failed", { inviteId: invite.id, error: room?.error || "ROOM_FAILED" });
          return ack?.({ ok: false, error: room?.error || "ROOM_FAILED" });
        }
      }
      io.to(`player:${invite.fromId}`).emit("invite_accepted", {
        inviteId: invite.id,
        byPlayerId: responderId,
        roomCode: room?.roomCode || null,
      });
      ack?.({ ok: true, accepted: true, roomCode: room?.roomCode || null });
    });

    socket.on("disconnect", () => {
      const pid = playerIdForSocket(socket);
      if (pid) cancelInvitesOf(pid, "disconnected");
    });
  });

  return {
    /** Só testes: quantos convites pendentes. */
    pendingCount: () => pending.size,
    /** Só testes: limpa convites e timers. */
    _clearForTests: () => {
      for (const inv of pending.values()) clearTimeout(inv.timer);
      pending.clear();
    },
  };
}

/** Só testes: zera o estado em memória (sem tocar no Postgres). */
export function _resetFriendsMemoryForTests() {
  memFollows.clear();
  memBlocks.clear();
  memReports.length = 0;
  blockCache.clear();
}
