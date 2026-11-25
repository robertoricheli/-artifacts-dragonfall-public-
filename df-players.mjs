/**
 * DRAGONFALL — Jogadores do país / do mundo + busca por nome
 * (Frente 3, projeto 1.51.103, item 3).
 *
 * NÃO edita index.mjs. A integração (F9) liga este módulo com:
 *
 *   import { register_players_routes, setPresenceProvider }
 *     from "./df-players.mjs";
 *   setPresenceProvider((playerId) => presenceOf(playerId)); // df-presence (F4)
 *   register_players_routes(app, {
 *     presenceSources, // as fontes da F4 (makePresenceSources) — preferido
 *     getOnlinePlayerIds: () => new Set(socketPlayer.values()),
 *     getBusyPlayerIds: () => new Set([...ids em sala ou na fila...]),
 *   });
 *
 * Sem o provider da F4, a presença vem dos mapas que a F9 injeta no
 * ctx (mesma fonte que a F4 vai usar: sockets conectados + salas +
 * filas); sem nenhum dos dois, todo mundo é "offline" e as abas
 * país/mundo voltam vazias — NUNCA inventar presença.
 * (F4 ENTREGUE: df-presence.mjs existe — este módulo importa
 * presenceFor() dele e usa ctx.presenceSources quando a F9 passa as
 * fontes; setPresenceProvider() continua como atalho alternativo.)
 *
 * Contrato do país (F2): campo `country` da conta, ISO 3166-1
 * alpha-3 maiúsculo ("BRA"), null = não escolhido. Até a F2 entregar
 * a coluna, listAllPlayers() detecta a ausência da coluna
 * `df_players.country` e trata todo país como null (a aba país
 * responde NO_COUNTRY; nada quebra).
 *
 * Regras do item 3 (não reabrir sem a usuária):
 * - Aba país: no máximo 30 jogadores ONLINE do país do jogador.
 * - Aba mundo: no máximo 30 jogadores ONLINE (mesmo limite).
 * - Busca: por nome EXATO (sem diferenciar maiúscula/minúscula);
 *   devolve o jogador com a presença dele (online ou não).
 * - Nunca devolver o próprio jogador nem quem bloqueou / foi
 *   bloqueado por ele (o bloqueio é verificado antes do corte de 30,
 *   para um bloqueado não comer vaga da lista).
 * - Cada jogador devolvido traz: id, displayName, level, country,
 *   presence ("available"|"busy"|"offline"), avatar, frame
 *   (+ os apelidos playerId/name/avatarHeroId/avatarFrame, iguais
 *   aos do /auth/friends, para o cliente não precisar de dois
 *   formatos).
 */

import { getPgPool } from "./df-postgres.mjs";
import {
  authPlayerFromToken,
  loadJsonAccountsFile,
} from "./df-auth-store.mjs";
import { isBlockedBetween } from "./df-friends.mjs";
import { levelFromXp } from "./rooms.mjs";
import { presenceFor as presenceFromService } from "./df-presence.mjs";

export const PLAYERS_LIMIT = 30;
export const PRESENCE_VALUES = Object.freeze(["available", "busy", "offline"]);

let _testPlayers = null; // só testes: substitui a leitura do banco/JSON
let _presenceProvider = null; // F4 (df-presence.mjs): (playerId) => presence
let _countryColumnChecked = false;
let _countryColumnExists = false;

/** Só testes: injeta a lista de jogadores (sem tocar no banco). */
export function _setTestPlayers(players) {
  _testPlayers = Array.isArray(players) ? players : null;
}

/** Só testes: limpa os injetados acima. */
export function _resetPlayersForTests() {
  _testPlayers = null;
}

/**
 * Presença da F4: df-presence.mjs registra aqui a função dela
 * (fonte: sockets + fila + salas). A F9 chama isto no boot; sem
 * isto, vale o ctx de register_players_routes (abaixo) e, sem
 * nenhum dos dois, "offline".
 */
export function setPresenceProvider(fn) {
  _presenceProvider = typeof fn === "function" ? fn : null;
}

/** "BRA" / null. Qualquer outra coisa (minúsculo, 2 letras, lixo)
 *  vira null — o país só vale no formato do contrato da F2. */
export function normalizeCountry(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

function countryOf(p) {
  if (!p) return null;
  return normalizeCountry(p.country ?? p.countryCode ?? null);
}

async function countryColumnExists() {
  if (_countryColumnChecked) return _countryColumnExists;
  _countryColumnChecked = true;
  const pool = getPgPool();
  if (!pool) return false;
  try {
    const res = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'df_players' AND column_name = 'country' LIMIT 1`,
    );
    _countryColumnExists = res.rows.length > 0;
  } catch (_) {
    _countryColumnExists = false;
  }
  return _countryColumnExists;
}

function normalizePlayer(p) {
  if (!p) return null;
  return {
    id: p.id ?? p.playerId ?? null,
    displayName: p.displayName ?? p.display_name ?? p.name ?? null,
    xpTotal: Number(p.xpTotal ?? p.xp_total ?? p.xp ?? 0) || 0,
    avatarHeroId: p.avatarHeroId ?? p.avatar_hero_id ?? p.avatar ?? null,
    avatarFrame: p.avatarFrame ?? p.avatar_frame ?? p.frame ?? null,
    country: countryOf(p),
  };
}

/** Todos os jogadores (Postgres ou JSON local; testes: injetados). */
export async function listAllPlayers() {
  if (_testPlayers) return _testPlayers.map(normalizePlayer).filter(Boolean);
  const pool = getPgPool();
  if (pool) {
    const hasCountry = await countryColumnExists();
    const cols = hasCountry
      ? "id, display_name, xp_total, avatar_hero_id, avatar_frame, country"
      : "id, display_name, xp_total, avatar_hero_id, avatar_frame";
    const res = await pool.query(`SELECT ${cols} FROM df_players`);
    return res.rows.map(normalizePlayer).filter(Boolean);
  }
  const data = loadJsonAccountsFile();
  return Object.values(data.players || {}).map(normalizePlayer).filter(Boolean);
}

/** Presença a partir de dois conjuntos (online / ocupado). Pura,
 *  para testes e para a F9 montar a partir dos mapas do index.mjs. */
export function presenceFromSets(onlineIds, busyIds, playerId) {
  if (!playerId) return "offline";
  if (busyIds && busyIds.has(playerId)) return "busy";
  if (onlineIds && onlineIds.has(playerId)) return "available";
  return "offline";
}

/** Presença de um jogador (ordem): fontes da F4 no ctx >
 *  provider registrado > conjuntos do ctx > offline. */
export function presenceFor(playerId, ctx = {}) {
  if (ctx.presenceSources) {
    const v = presenceFromService(playerId, ctx.presenceSources);
    if (PRESENCE_VALUES.includes(v)) return v;
  }
  if (_presenceProvider) {
    const v = _presenceProvider(playerId);
    if (PRESENCE_VALUES.includes(v)) return v;
  }
  const online = ctx.getOnlinePlayerIds ? ctx.getOnlinePlayerIds() : ctx.onlineIds;
  const busy = ctx.getBusyPlayerIds ? ctx.getBusyPlayerIds() : ctx.busyIds;
  const onlineSet = online instanceof Set ? online : null;
  const busySet = busy instanceof Set ? busy : null;
  if (onlineSet || busySet) return presenceFromSets(onlineSet, busySet, playerId);
  return "offline";
}

/** Cartão público de um jogador na lista / busca (contrato do item 3). */
export function playerCard(p, presence) {
  if (!p) return null;
  return {
    id: p.id,
    playerId: p.id,
    displayName: p.displayName || null,
    name: p.displayName || null,
    level: levelFromXp(p.xpTotal || 0),
    country: p.country || null,
    presence: PRESENCE_VALUES.includes(presence) ? presence : "offline",
    avatar: p.avatarHeroId || null,
    avatarHeroId: p.avatarHeroId || null,
    frame: p.avatarFrame || null,
    avatarFrame: p.avatarFrame || null,
  };
}

function compareCards(a, b) {
  if (b.level !== a.level) return b.level - a.level;
  const an = String(a.displayName || "").toLowerCase();
  const bn = String(b.displayName || "").toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : 0;
}

async function filterVisible(me, candidates, ctx) {
  const isBlocked =
    typeof ctx.isBlocked === "function" ? ctx.isBlocked : isBlockedBetween;
  const out = [];
  for (const p of candidates) {
    if (!p || !p.id || p.id === me.id) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isBlocked(me.id, p.id)) continue;
    out.push(p);
  }
  return out;
}

/**
 * Aba país: ONLINE do país do jogador, no máximo PLAYERS_LIMIT.
 * Sem país escolhido: { ok:false, error:"NO_COUNTRY" }.
 */
export async function listByCountry(me, ctx = {}) {
  const myCountry = countryOf(me);
  if (!myCountry) return { ok: false, error: "NO_COUNTRY" };
  const all = ctx.allPlayers || (await listAllPlayers());
  const visible = await filterVisible(me, all, ctx);
  const cards = visible
    .filter((p) => p.country === myCountry)
    .map((p) => playerCard(p, presenceFor(p.id, ctx)))
    .filter((c) => c.presence !== "offline")
    .sort(compareCards)
    .slice(0, PLAYERS_LIMIT);
  return { ok: true, country: myCountry, players: cards };
}

/** Aba mundo: ONLINE de qualquer país, no máximo PLAYERS_LIMIT. */
export async function listWorld(me, ctx = {}) {
  const all = ctx.allPlayers || (await listAllPlayers());
  const visible = await filterVisible(me, all, ctx);
  const cards = visible
    .map((p) => playerCard(p, presenceFor(p.id, ctx)))
    .filter((c) => c.presence !== "offline")
    .sort(compareCards)
    .slice(0, PLAYERS_LIMIT);
  return { ok: true, players: cards };
}

/**
 * Busca por nome EXATO (maiúscula/minúscula não importa; espaços nas
 * pontas não importam). Devolve quem achou, online ou não, com a
 * presença — no máximo PLAYERS_LIMIT (nome exato costuma ser 1).
 */
export async function searchByName(me, q, ctx = {}) {
  const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
  if (!needle) return { ok: false, error: "MISSING_QUERY" };
  const all = ctx.allPlayers || (await listAllPlayers());
  const visible = await filterVisible(me, all, ctx);
  const cards = visible
    .filter((p) => String(p.displayName || "").trim().toLowerCase() === needle)
    .map((p) => playerCard(p, presenceFor(p.id, ctx)))
    .sort(compareCards)
    .slice(0, PLAYERS_LIMIT);
  return { ok: true, query: q.trim(), players: cards };
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

export function register_players_routes(app, ctx = {}) {
  app.get("/auth/players/by-country", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const r = await listByCountry(me, ctx);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.get("/auth/players/world", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const r = await listWorld(me, ctx);
    res.status(200).json(r);
  });

  app.get("/auth/players/search", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const q = typeof req.query?.q === "string" ? req.query.q : "";
    if (!q.trim()) return res.status(400).json({ ok: false, error: "MISSING_QUERY" });
    const r = await searchByName(me, q, ctx);
    res.status(r.ok ? 200 : 400).json(r);
  });
}
