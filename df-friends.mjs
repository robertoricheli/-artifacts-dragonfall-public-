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
 * - (F8, 1.51.103 item 9c) um NOVO convite SUBSTITUI o pendente
 *   (mesmo convidador, mesmo convidado): novo id, novo prazo de
 *   30 s, banner atualizado no convidado. Depois de uma RECUSA, o
 *   mesmo jogador não pode ser convidado de novo por 1 minuto
 *   (INVITE_COOLDOWN); convidar OUTRO jogador continua valendo.
 * - (F8, 1.51.103 item 9c, trava da F4) antes de criar o convite,
 *   canReceiveInvite(playerId): falso para offline/ocupado — o
 *   convite nem é criado (PLAYER_OFFLINE / PLAYER_BUSY /
 *   TARGET_UNAVAILABLE). Sem a F4, vale a checagem local por socket.
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
// (F9, 1.51.103 item 4) ganchos do correio (F1): convite recebido e
// novo seguidor gravam uma mensagem no correio do destinatário.
import { recordInviteMail, recordFollowMail } from "./df-mail.mjs";

export const FRIEND_INVITE_TTL_MS = 30_000;
/** (F8, 1.51.103 item 9b) prazo para os dois lados escolherem
 *  baralho/herói depois de o convite ser aceito. Sem a escolha dos
 *  dois, o convite aceito expira e os dois voltam a poder convidar. */
export const FRIEND_CHOICE_TIMEOUT_MS = 120_000;
/** (F8, 1.51.103 item 9c) depois de uma RECUSA, o mesmo jogador
 *  não pode ser convidado de novo por 1 minuto. Só vale para a
 *  direção recusada (quem recusou pode convidar de volta). */
export const FRIEND_DECLINE_COOLDOWN_MS = 60_000;
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

/** Um jogador segue o outro? (F9, 1.51.103) Fonte única de "seguir"
 *  para o chat (df-chat.mjs): no Postgres lê df_follows; sem ele, o
 *  conjunto em memória — o mesmo que o followPlayer alimenta. Sem
 *  isto, o chat em modo memória leria o próprio memFollows vazio e o
 *  mútuo nunca existiria. */
export async function isFollowing(followerId, followedId) {
  if (!followerId || !followedId || followerId === followedId) return false;
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `SELECT 1 FROM df_follows WHERE follower_id = $1 AND followed_id = $2 LIMIT 1`,
      [String(followerId), String(followedId)],
    );
    return res.rows.length > 0;
  }
  return memFollows.has(`${followerId}|${followedId}`);
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
  let isNew = false;
  if (pool) {
    const res = await pool.query(
      `INSERT INTO df_follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [followerId, followedId],
    );
    isNew = (res?.rowCount || 0) > 0;
  } else {
    const key = `${followerId}|${followedId}`;
    isNew = !memFollows.has(key);
    memFollows.add(key);
  }
  // (F9, 1.51.103 item 4) só o seguir NOVO grava no correio de quem
  // foi seguido; seguir de novo não duplica a mensagem. O correio
  // nunca pode quebrar o seguir: erro aqui só é registrado.
  if (isNew) {
    try {
      const follower = await safeGetPlayer(followerId);
      await recordFollowMail(followedId, followerId, follower?.displayName || null);
    } catch (e) {
      console.warn("[mail] recordFollowMail falhou:", e?.message || e);
    }
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
    // (F9, 1.51.103 item 3) país, para a bandeirinha na visita ao
    // perfil; null quando o jogador não escolheu país.
    country: p.country || null,
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
 *   (F8, 1.51.103 item 9b) a sala SÓ é criada quando os DOIS lados
 *   já escolheram baralho/herói (evento friend_choice_ready dos
 *   dois): a janela de aceite de 20 s do servidor começava NA
 *   CRIAÇÃO da sala, e a escolha de baralho/herói comia esse tempo
 *   — a sala morria antes de os dois apertarem ACEITAR. Sem isto,
 *   o aceite do convite só registra o convite aceito (accepted) e
 *   avisa os dois lados (invite_accepted, sem roomCode); cada lado
 *   escolhe baralho/herói e manda friend_choice_ready; com os dois
 *   prontos, createFriendRoom cria a sala e o match_found abre a
 *   sala de espera com a janela inteira pela frente.
 *   Sem isto, o aceite só avisa os dois lados (invite_accepted) e a
 *   partida fica para a integração abrir.
 * @param {(playerId: string) => boolean|Promise<boolean>} [ctx.canReceiveInvite]
 *   — (F8, 1.51.103 item 9, trava da F4) falso quando o jogador
 *   está offline ou ocupado. A F9 liga o helper de ./df-presence.mjs
 *   (com as fontes do boot) neste ctx; sem ele, vale a checagem
 *   local por socket (ver _canReceiveInviteFallback).
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

  /** "de|para" -> timestamp ms da última RECUSA (item 9c). */
  const declinedAt = new Map();
  const declineKey = (fromId, toId) => `${fromId}|${toId}`;

  // (F8, 1.51.103 item 9c, trava da F4) canReceiveInvite, nesta
  // ordem: 1) ctx.canReceiveInvite (a F9 ligou o helper da F4 na
  // integração — É o vivo: df-presence.mjs com as fontes do boot);
  // 2) checagem local por socket (abaixo).
  // (F9) o passo antigo "2) import dinâmico de ./df-presence.mjs" foi
  // REMOVIDO: ele chamava canReceiveInvite(playerId) SEM as fontes
  // (sempre offline) e o normalizePresenceResult lia o {ok:false} da
  // F4 como allowed:true — o convite passaria para offline/ocupado.
  // Com o ctx ligado, o import nunca era alcançado; sem ele, o
  // fallback local por socket é o correto (e honesto sobre a fila).
  const ctxPresence = typeof ctx.canReceiveInvite === "function" ? ctx.canReceiveInvite : null;
  function normalizePresenceResult(r) {
    if (r === false) return { allowed: false, reason: "unavailable" };
    if (r === true) return { allowed: true, reason: null };
    if (r && typeof r === "object") {
      // Forma da F4 ({ok, status, error}): nunca confundir com allowed.
      if (typeof r.ok === "boolean") {
        return {
          allowed: r.ok,
          reason: r.ok ? null : r.error === "INVITE_BUSY" || r.status === "busy" ? "busy" : "offline",
        };
      }
      return { allowed: r.allowed !== false, reason: r.reason || null };
    }
    return { allowed: true, reason: null };
  }
  async function checkCanReceiveInvite(playerId) {
    try {
      if (ctxPresence) return normalizePresenceResult(await ctxPresence(playerId));
    } catch { /* cai para o fallback local */ }
    return canReceiveInviteFallback(playerId);
  }
  /** Fallback local (sem a F4): online = tem socket na sala
   *  player:<id>; ocupado = algum socket dele está numa sala de
   *  partida viva (rooms do socket além do próprio sid e de
   *  player:<id>). A FILA não aparece nos rooms do socket — só a
   *  presença da F4 (mapa no servidor) cobre esse caso; sem ela,
   *  "na fila" conta como livre. */
  function canReceiveInviteFallback(playerId) {
    const room = io.sockets.adapter.rooms.get(`player:${playerId}`);
    if (!room || room.size === 0) return { allowed: false, reason: "offline" };
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      for (const r of s.rooms) {
        if (r !== sid && r !== `player:${playerId}`) return { allowed: false, reason: "busy" };
      }
    }
    return { allowed: true, reason: null };
  }

  /** inviteId -> { id, fromId, toId, timer } */
  const pending = new Map();
  /** (F8, 1.51.103 item 9b) convites ACEITOS aguardando a escolha
   *  de baralho/herói dos dois lados:
   *  inviteId -> { id, fromId, toId, ready: Set<playerId>, timer }.
   *  A sala só nasce quando os dois mandam friend_choice_ready. */
  const accepted = new Map();

  function expireInvite(invite, reason = "expired") {
    if (!invite) return;
    clearTimeout(invite.timer);
    pending.delete(invite.id);
    io.to(`player:${invite.fromId}`).emit("invite_expired", { inviteId: invite.id, reason });
    io.to(`player:${invite.toId}`).emit("invite_expired", { inviteId: invite.id, reason });
  }

  /** Um convite aceito expirou (escolha não veio a tempo, cancelado
   *  ou um dos lados desconectou): avisa os DOIS lados. */
  function expireAccepted(acc, reason = "choice_timeout") {
    if (!acc) return;
    clearTimeout(acc.timer);
    accepted.delete(acc.id);
    io.to(`player:${acc.fromId}`).emit("invite_expired", { inviteId: acc.id, reason });
    io.to(`player:${acc.toId}`).emit("invite_expired", { inviteId: acc.id, reason });
  }

  function cancelInvitesOf(playerId, reason = "disconnected") {
    for (const invite of [...pending.values()]) {
      if (invite.fromId === playerId || invite.toId === playerId) {
        expireInvite(invite, reason);
      }
    }
    for (const acc of [...accepted.values()]) {
      if (acc.fromId === playerId || acc.toId === playerId) {
        expireAccepted(acc, reason);
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
      // (F8, 1.51.103 item 9c, trava da F4) jogador offline ou
      // ocupado não recebe convite — nem cria o pendente.
      const presence = await checkCanReceiveInvite(toId);
      if (!presence.allowed) {
        const err = presence.reason === "offline" ? "PLAYER_OFFLINE"
          : presence.reason === "busy" ? "PLAYER_BUSY" : "TARGET_UNAVAILABLE";
        return ack?.({ ok: false, error: err });
      }
      // (F8, 1.51.103 item 9c) depois de uma RECUSA, o MESMO
      // jogador não pode ser convidado de novo por 1 minuto. Só
      // vale para a direção recusada; outro jogador segue valendo.
      const lastDecline = declinedAt.get(declineKey(fromId, toId));
      if (lastDecline) {
        const waited = Date.now() - lastDecline;
        if (waited < FRIEND_DECLINE_COOLDOWN_MS) {
          return ack?.({ ok: false, error: "INVITE_COOLDOWN", retryAfterMs: FRIEND_DECLINE_COOLDOWN_MS - waited });
        }
        declinedAt.delete(declineKey(fromId, toId));
      }
      // (F8, 1.51.103 item 9c) um NOVO convite SUBSTITUI o
      // pendente (mesmo convidador, mesmo convidado): o timer do
      // antigo morre aqui e o convidado recebe o novo (o banner
      // troca o id e o prazo recomeça em 30 s).
      let replaced = false;
      for (const inv of [...pending.values()]) {
        if (inv.fromId === fromId && inv.toId === toId) {
          clearTimeout(inv.timer);
          pending.delete(inv.id);
          replaced = true;
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
      // (F9, 1.51.103 item 4) o convite recebido grava no correio
      // do convidado (aba CONVITES DE PARTIDA). O correio nunca
      // pode quebrar o convite: erro aqui só é registrado.
      try {
        await recordInviteMail(toId, fromId, me?.displayName || null);
      } catch (e) {
        console.warn("[mail] recordInviteMail falhou:", e?.message || e);
      }
      ack?.({ ok: true, inviteId, expiresInMs: inviteTtlMs, replaced });
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
        // (F8, 1.51.103 item 9c) RECUSA: o mesmo jogador não pode
        // ser convidado de novo por 1 minuto (só esta direção).
        declinedAt.set(declineKey(invite.fromId, invite.toId), Date.now());
        io.to(`player:${invite.fromId}`).emit("invite_declined", { inviteId: invite.id, byPlayerId: responderId });
        return ack?.({ ok: true, accepted: false });
      }
      // (F8, 1.51.103 item 9b) ACEITOU: a sala NÃO nasce aqui. A
      // janela de aceite de 20 s do servidor começaria agora e a
      // escolha de baralho/herói (que vem depois) a comeria — a
      // sala morria antes de os dois apertarem ACEITAR (a causa do
      // 9b, provada na sonda). Registra o convite aceito (120 s
      // para os dois escolherem) e avisa o convidador; a sala só
      // nasce quando os dois mandarem friend_choice_ready.
      const acc = { id: invite.id, fromId: invite.fromId, toId: invite.toId, ready: new Set(), timer: null };
      acc.timer = setTimeout(() => expireAccepted(acc, "choice_timeout"), FRIEND_CHOICE_TIMEOUT_MS);
      accepted.set(acc.id, acc);
      io.to(`player:${invite.fromId}`).emit("invite_accepted", {
        inviteId: invite.id,
        byPlayerId: responderId,
        fromPlayerId: invite.fromId,
        toPlayerId: invite.toId,
        roomCode: null,
      });
      ack?.({ ok: true, accepted: true, inviteId: invite.id, fromPlayerId: invite.fromId, toPlayerId: invite.toId, roomCode: null });
    });

    // (F8, 1.51.103 item 9b) "já escolhi baralho e herói": com os
    // DOIS prontos, a sala de amigo nasce AGORA (createFriendRoom
    // da integração) e o match_found abre a sala de espera com a
    // janela de aceite de 20 s inteira pela frente — os dois já
    // estão olhando para ela. O primeiro pronto só espera.
    socket.on("friend_choice_ready", async (payload, ack) => {
      const pid = playerIdForSocket(socket);
      if (!pid) return ack?.({ ok: false, error: "UNAUTHORIZED" });
      const inviteId = normId(payload?.inviteId);
      const acc = inviteId ? accepted.get(inviteId) : null;
      if (!acc) return ack?.({ ok: false, error: "INVITE_NOT_FOUND" });
      if (pid !== acc.fromId && pid !== acc.toId) return ack?.({ ok: false, error: "NOT_INVITEE" });
      acc.ready.add(pid);
      if (acc.ready.size < 2) return ack?.({ ok: true, waiting: true });
      clearTimeout(acc.timer);
      accepted.delete(acc.id);
      if (!createFriendRoom) {
        io.to(`player:${acc.fromId}`).emit("invite_failed", { inviteId: acc.id, error: "ROOM_FAILED" });
        io.to(`player:${acc.toId}`).emit("invite_failed", { inviteId: acc.id, error: "ROOM_FAILED" });
        return ack?.({ ok: false, error: "ROOM_FAILED" });
      }
      let room = null;
      try {
        room = await createFriendRoom(acc.fromId, acc.toId);
      } catch (e) {
        room = { ok: false, error: e?.message || "ROOM_FAILED" };
      }
      if (!room?.ok) {
        io.to(`player:${acc.fromId}`).emit("invite_failed", { inviteId: acc.id, error: room?.error || "ROOM_FAILED" });
        io.to(`player:${acc.toId}`).emit("invite_failed", { inviteId: acc.id, error: room?.error || "ROOM_FAILED" });
        return ack?.({ ok: false, error: room?.error || "ROOM_FAILED" });
      }
      return ack?.({ ok: true, roomCode: room.roomCode });
    });

    // (F8, 1.51.103 item 9b) um lado desistiu depois de aceitar
    // (fechou a espera, voltou ao menu): o outro lado fica sabendo
    // na hora, em vez de esperar os 120 s.
    socket.on("friend_choice_cancel", async (payload, ack) => {
      const pid = playerIdForSocket(socket);
      if (!pid) return ack?.({ ok: false, error: "UNAUTHORIZED" });
      const inviteId = normId(payload?.inviteId);
      const acc = inviteId ? accepted.get(inviteId) : null;
      if (!acc) return ack?.({ ok: true, cancelled: false });
      if (pid !== acc.fromId && pid !== acc.toId) return ack?.({ ok: false, error: "NOT_INVITEE" });
      const peer = pid === acc.fromId ? acc.toId : acc.fromId;
      clearTimeout(acc.timer);
      accepted.delete(acc.id);
      io.to(`player:${peer}`).emit("invite_expired", { inviteId: acc.id, reason: "cancelled" });
      return ack?.({ ok: true, cancelled: true });
    });

    socket.on("disconnect", () => {
      const pid = playerIdForSocket(socket);
      if (pid) cancelInvitesOf(pid, "disconnected");
    });
  });

  return {
    /** Só testes: quantos convites pendentes. */
    pendingCount: () => pending.size,
    /** Só testes: quantos convites aceitos aguardando a escolha. */
    acceptedCount: () => accepted.size,
    /** Só testes: limpa convites e timers. */
    _clearForTests: () => {
      for (const inv of pending.values()) clearTimeout(inv.timer);
      pending.clear();
      for (const acc of accepted.values()) clearTimeout(acc.timer);
      accepted.clear();
      declinedAt.clear();
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
