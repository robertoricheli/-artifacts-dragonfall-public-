/**
 * DRAGONFALL — Chat entre jogadores (Frente 4, projeto 1.51.103, item 4).
 *
 * Regra da usuária: CHAT SÓ quando os dois se seguem AO MESMO TEMPO
 * (seguimento mútuo). Sem mútuo, sem chat — o bloqueio é no servidor,
 * não só na tela.
 *
 * NÃO edita index.mjs nem df-friends.mjs. A F9 registra as rotas (ver
 * especificação de registro no RELATORIO.md da F4).
 *
 * Regras aplicadas aqui (servidor é a autoridade):
 * - só mútuo (A segue B E B segue A) pode listar/enviar mensagens;
 * - mensagem de no máximo 100 caracteres (mais que isso é recusado,
 *   não cortado em silêncio — o cliente já trava no campo);
 * - mensagem vazia é recusada;
 * - não dá para mandar mensagem para si mesmo;
 * - bloqueio entre os dois (df-friends) também fecha o chat;
 * - mensagens arquivadas POR PAR de jogadores (a conversa com aquele
 *   jogador reabre depois com o histórico inteiro).
 *
 * Armazenamento: Postgres (tabela df_messages) quando há pool; sem
 * pool (dev local), memória — o mesmo padrão do df-friends.mjs.
 * Em modo memória, o seguimento é verificado pelo `followChecker`
 * injetado (só testes usam isto); sem checker e sem Postgres, o chat
 * fica fechado (fail-closed: sem prova de mútuo, sem chat).
 */

import { getPgPool } from "./df-postgres.mjs";
import { authPlayerFromToken } from "./df-auth-store.mjs";
import { isBlockedBetween } from "./df-friends.mjs";

export const CHAT_MAX_LEN = 100;
export const CHAT_LIST_LIMIT = 100;

const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS df_messages (
  id BIGSERIAL PRIMARY KEY,
  from_id VARCHAR(64) NOT NULL,
  to_id VARCHAR(64) NOT NULL,
  text VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS df_messages_pair ON df_messages (from_id, to_id, created_at);
CREATE INDEX IF NOT EXISTS df_messages_pair_rev ON df_messages (to_id, from_id, created_at);
`;

/** Fallback sem Postgres (dev local): as mesmas mensagens em memória. */
const memMessages = []; // { id, fromId, toId, text, createdAt }
let memNextId = 1;
/** Segue mútuo em memória (só testes): "a|b" = a segue b. */
const memFollows = new Set();
/** Checker injetado (só testes): (a, b) => Promise<boolean>. */
let injectedFollowChecker = null;

function pg() {
  return getPgPool();
}

export async function initChatSchema() {
  const pool = pg();
  if (!pool) return { enabled: false, mode: "memory" };
  await pool.query(CHAT_SCHEMA);
  return { enabled: true, mode: "postgres" };
}

/** Só testes: define quem segue quem no modo memória. */
export function __setFollowForTests(followerId, followedId, following = true) {
  const key = `${followerId}|${followedId}`;
  if (following) memFollows.add(key);
  else memFollows.delete(key);
}

/** Só testes: injeta o verificador de seguimento (a, b) => boolean. */
export function setFollowChecker(fn) {
  injectedFollowChecker = typeof fn === "function" ? fn : null;
}

/** Só testes: zera mensagens e seguimentos em memória. */
export function _resetChatMemoryForTests() {
  memMessages.length = 0;
  memNextId = 1;
  memFollows.clear();
  injectedFollowChecker = null;
}

function normId(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

async function followsOneWay(a, b) {
  if (injectedFollowChecker) return !!(await injectedFollowChecker(a, b));
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `SELECT 1 FROM df_follows WHERE follower_id = $1 AND followed_id = $2 LIMIT 1`,
      [String(a), String(b)],
    );
    return res.rows.length > 0;
  }
  return memFollows.has(`${a}|${b}`);
}

/** Seguimento MÚTUO: A segue B E B segue A. */
export async function isMutualFollow(a, b) {
  if (!a || !b || a === b) return false;
  const [ab, ba] = await Promise.all([followsOneWay(a, b), followsOneWay(b, a)]);
  return ab && ba;
}

/** Validação do texto (a mesma nos dois lados; o servidor decide). */
export function validateMessageText(raw) {
  if (typeof raw !== "string") return { ok: false, error: "EMPTY_MESSAGE" };
  const text = raw.trim();
  if (text === "") return { ok: false, error: "EMPTY_MESSAGE" };
  if (text.length > CHAT_MAX_LEN) return { ok: false, error: "MESSAGE_TOO_LONG", maxLen: CHAT_MAX_LEN };
  return { ok: true, text };
}

function rowToMessage(r) {
  return {
    id: r.id,
    fromId: r.from_id ?? r.fromId,
    toId: r.to_id ?? r.toId,
    text: r.text,
    createdAt: r.created_at ?? r.createdAt,
  };
}

/**
 * Envia uma mensagem. Devolve { ok:true, message } ou
 * { ok:false, error } — NOT_MUTUAL | BLOCKED | CANNOT_MESSAGE_SELF |
 * EMPTY_MESSAGE | MESSAGE_TOO_LONG.
 */
export async function sendMessage(fromId, toId, rawText) {
  const from = normId(fromId);
  const to = normId(toId);
  if (!from || !to) return { ok: false, error: "MISSING_PLAYER" };
  if (from === to) return { ok: false, error: "CANNOT_MESSAGE_SELF" };
  const v = validateMessageText(rawText);
  if (!v.ok) return v;
  if (await isBlockedBetween(from, to)) return { ok: false, error: "BLOCKED" };
  if (!(await isMutualFollow(from, to))) return { ok: false, error: "NOT_MUTUAL" };
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `INSERT INTO df_messages (from_id, to_id, text) VALUES ($1, $2, $3) RETURNING id, from_id, to_id, text, created_at`,
      [from, to, v.text],
    );
    return { ok: true, message: rowToMessage(res.rows[0]) };
  }
  const msg = { id: memNextId++, fromId: from, toId: to, text: v.text, createdAt: new Date().toISOString() };
  memMessages.push(msg);
  return { ok: true, message: { ...msg } };
}

/**
 * Lista o histórico do par (ordem cronológica, até CHAT_LIST_LIMIT).
 * Sem mútuo, recusa com NOT_MUTUAL — nem a existência de mensagens
 * vaza para quem não é amigo mútuo.
 */
export async function listMessages(meId, peerId, limit = CHAT_LIST_LIMIT) {
  const me = normId(meId);
  const peer = normId(peerId);
  if (!me || !peer) return { ok: false, error: "MISSING_PLAYER" };
  if (me === peer) return { ok: false, error: "CANNOT_MESSAGE_SELF" };
  if (await isBlockedBetween(me, peer)) return { ok: false, error: "BLOCKED" };
  if (!(await isMutualFollow(me, peer))) return { ok: false, error: "NOT_MUTUAL" };
  const n = Math.max(1, Math.min(Number(limit) || CHAT_LIST_LIMIT, CHAT_LIST_LIMIT));
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `SELECT id, from_id, to_id, text, created_at FROM df_messages
        WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
        ORDER BY created_at ASC, id ASC LIMIT $3`,
      [me, peer, n],
    );
    return { ok: true, peerId: peer, messages: res.rows.map(rowToMessage) };
  }
  const rows = memMessages
    .filter((m) => (m.fromId === me && m.toId === peer) || (m.fromId === peer && m.toId === me))
    .sort((a, b) => a.id - b.id)
    .slice(-n);
  return { ok: true, peerId: peer, messages: rows.map((m) => ({ ...m })) };
}

/**
 * Conversas do jogador: cada par MÚTUO com a última mensagem (para a
 * tela de chat saber com quem há conversa). Pares sem nenhuma mensagem
 * aparecem com lastMessage null — o chat abre do mesmo jeito.
 * Em modo Postgres lê os pares da df_follows (mútuo) e a última
 * mensagem de cada par; em memória usa o checker/memFollows + as
 * mensagens em memória (sem checker, lista vazia).
 */
export async function listConversations(meId) {
  const me = normId(meId);
  if (!me) return { ok: false, error: "MISSING_PLAYER" };
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `SELECT f.followed_id AS peer FROM df_follows f
        WHERE f.follower_id = $1
          AND EXISTS (SELECT 1 FROM df_follows g WHERE g.follower_id = f.followed_id AND g.followed_id = $1)
        ORDER BY f.created_at DESC`,
      [me],
    );
    const out = [];
    for (const r of res.rows) {
      const peer = String(r.peer);
      const last = await pool.query(
        `SELECT id, from_id, to_id, text, created_at FROM df_messages
          WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [me, peer],
      );
      out.push({ peerId: peer, lastMessage: last.rows[0] ? rowToMessage(last.rows[0]) : null });
    }
    return { ok: true, conversations: out };
  }
  // Memória: pares mútuos conhecidos pelo checker ou pelo set de teste.
  const peers = new Set();
  for (const k of memFollows) {
    const [f, t] = k.split("|");
    if (f === me && memFollows.has(`${t}|${me}`)) peers.add(t);
  }
  if (injectedFollowChecker) {
    // O checker não enumera pares; as conversas vêm das mensagens.
    for (const m of memMessages) {
      if (m.fromId === me) peers.add(m.toId);
      if (m.toId === me) peers.add(m.fromId);
    }
    const kept = [];
    for (const p of peers) if (await isMutualFollow(me, p)) kept.push(p);
    peers.clear();
    for (const p of kept) peers.add(p);
  }
  const out = [];
  for (const peer of peers) {
    const msgs = memMessages.filter(
      (m) => (m.fromId === me && m.toId === peer) || (m.fromId === peer && m.toId === me),
    );
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    out.push({ peerId: peer, lastMessage: last ? { ...last } : null });
  }
  return { ok: true, conversations: out };
}

function bearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * Rotas de chat (a F9 registra; NÃO mexer no index.mjs aqui).
 *
 *   GET  /auth/chat            -> { ok, conversations: [{peerId, lastMessage}] }
 *   GET  /auth/chat/:peerId    -> { ok, peerId, messages: [...] }
 *   POST /auth/chat/:peerId    -> { ok, message }  (body: { text })
 *
 * `opts.auth` permite injetar a autenticação (só testes usam isto).
 */
export function register_chat_routes(app, opts = {}) {
  const authFn = typeof opts.auth === "function" ? opts.auth : authPlayerFromToken;

  async function authed(req, res) {
    const player = await authFn(bearerToken(req));
    if (!player) {
      res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      return null;
    }
    return player;
  }

  app.get("/auth/chat", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const r = await listConversations(me.id);
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.get("/auth/chat/:peerId", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const peerId = normId(req.params?.peerId);
    if (!peerId) return res.status(400).json({ ok: false, error: "MISSING_PLAYER" });
    const r = await listMessages(me.id, peerId);
    // (F13, 1.51.103 problema 3) o cliente rotula as mensagens
    // próprias como "Você" a partir de myId (chat_screen.gd lê
    // r.myId no refresh) — sem ele, _my_id fica "" e o
    // format_message rotula tudo com o nome do outro. O id devolvido
    // é o do solicitante (quem pediu a conversa).
    res.status(r.ok ? 200 : 403).json(r.ok ? { ...r, myId: me.id } : r);
  });

  app.post("/auth/chat/:peerId", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const peerId = normId(req.params?.peerId);
    if (!peerId) return res.status(400).json({ ok: false, error: "MISSING_PLAYER" });
    const r = await sendMessage(me.id, peerId, req.body?.text);
    res.status(r.ok ? 200 : 403).json(r);
  });
}
