/**
 * DRAGONFALL — Correio (Frente 1, projeto 1.51.103 item 1, 2026-11-25).
 *
 * 3 abas na tela de perfil (mail_screen.gd):
 *   (1) CONVITES DE PARTIDA recebidos  — tipo "invite"
 *   (2) JOGADORES QUE ME SEGUIRAM      — tipo "follow"
 *   (3) COMUNICADOS (do servidor)      — tipo "announcement"
 *
 * Retenção aplicada NA INSERÇÃO (nunca mais que o limite guardado):
 *   invite 10, follow 10, announcement 20. A 11ª (21ª) mensagem apaga
 *   a mais antiga daquela aba daquele jogador.
 *
 * NÃO edita index.mjs nem df-friends.mjs. A integração final (F9) liga
 * este módulo no servidor com:
 *
 *   import { register_mail_routes, initMailSchema } from "./df-mail.mjs";
 *   await initMailSchema();
 *   register_mail_routes(app);
 *
 * E os ganchos que CRIAM as mensagens (dono: F8, em df-friends.mjs):
 *   - convite recebido: no handler "invite_friend" de
 *     register_friends_socket, logo após o emit "invite_received",
 *     chamar  await recordInviteMail(toId, fromId, fromName);
 *   - novo seguidor: no fim de followPlayer(), após o INSERT em
 *     df_follows, chamar  await recordFollowMail(followedId,
 *     followerId, followerName);  (o nome vem de safeGetPlayer.)
 *   - comunicado: a ferramenta para ELA enviar comunicados a todos
 *     os jogadores é um projeto FUTURO e NÃO existe aqui; quando
 *     existir, ela chama recordAnnouncementMail(playerId, title, body)
 *     para cada jogador (ou um broadcast que itere os jogadores).
 *
 * "Enviar" NÃO tem endpoint HTTP próprio: o convite de volta usa o
 * socket invite_friend que já existe (FriendsScreen/mail_screen), e
 * comunicados só podem partir do servidor (ferramenta futura). As
 * rotas HTTP aqui são listar (GET /auth/mail?tab=) e excluir
 * (DELETE /auth/mail/:id). O jogador só vê e só exclui o próprio
 * correio — nunca o de outro jogador.
 *
 * Armazenamento: o padrão do projeto (df-friends.mjs): Postgres
 * (tabela df_mail) quando DATABASE_URL existe; sem Postgres, os
 * mesmos dados em memória (dev local).
 */

import { getPgPool } from "./df-postgres.mjs";
import { authPlayerFromToken } from "./df-auth-store.mjs";

export const MAIL_LIMITS = Object.freeze({
  invite: 10,
  follow: 10,
  announcement: 20,
});

export const MAIL_TYPES = Object.freeze(["invite", "follow", "announcement"]);

/** Aba da tela (e do ?tab=) -> tipo guardado. */
export const TAB_TO_TYPE = Object.freeze({
  invites: "invite",
  followers: "follow",
  announcements: "announcement",
});

const MAIL_SCHEMA = `
CREATE TABLE IF NOT EXISTS df_mail (
  id BIGSERIAL PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  type VARCHAR(16) NOT NULL,
  from_id VARCHAR(64),
  from_name VARCHAR(128),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS df_mail_owner_type ON df_mail (owner_id, type, created_at DESC);
`;

/** Fallback sem Postgres (dev local): os mesmos dados em memória. */
const memMail = [];
let memSeq = 0;

function pg() {
  return getPgPool();
}

export async function initMailSchema() {
  const pool = pg();
  if (!pool) return { enabled: false, mode: "memory" };
  await pool.query(MAIL_SCHEMA);
  return { enabled: true, mode: "postgres" };
}

function normId(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function normName(v, fallback = "Jogador") {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  return s ? s : fallback;
}

function rowOut(r) {
  return {
    id: typeof r.id === "string" ? Number(r.id) : r.id,
    ownerId: String(r.owner_id ?? r.ownerId ?? ""),
    type: String(r.type ?? ""),
    fromId: r.from_id ?? r.fromId ?? null,
    fromName: r.from_name ?? r.fromName ?? null,
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    createdAt: r.created_at instanceof Date
      ? r.created_at.toISOString()
      : String(r.created_at ?? r.createdAt ?? ""),
  };
}

/**
 * Apaga as mensagens além do limite da aba, da mais antiga para a
 * mais nova (só as do dono + tipo). Roda dentro de cada inserção.
 */
async function prune(ownerId, type) {
  const limit = MAIL_LIMITS[type];
  if (!limit) return;
  const pool = pg();
  if (pool) {
    await pool.query(
      `DELETE FROM df_mail WHERE owner_id = $1 AND type = $2 AND id NOT IN (
         SELECT id FROM df_mail WHERE owner_id = $1 AND type = $2
         ORDER BY created_at DESC, id DESC LIMIT $3
       )`,
      [ownerId, type, limit],
    );
    return;
  }
  const kept = memMail
    .filter((m) => m.ownerId === ownerId && m.type === type)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit)
    .map((m) => m.id);
  for (let i = memMail.length - 1; i >= 0; i--) {
    const m = memMail[i];
    if (m.ownerId === ownerId && m.type === type && !kept.includes(m.id)) {
      memMail.splice(i, 1);
    }
  }
}

async function recordMail(ownerId, type, fields) {
  const owner = normId(ownerId);
  if (!owner) return { ok: false, error: "MISSING_OWNER" };
  if (!MAIL_TYPES.includes(type)) return { ok: false, error: "INVALID_TYPE" };
  const title = typeof fields?.title === "string" && fields.title.trim() !== "" ? fields.title : "";
  const body = typeof fields?.body === "string" ? fields.body : "";
  const fromId = normId(fields?.fromId);
  const fromName = typeof fields?.fromName === "string" && fields.fromName.trim() !== ""
    ? fields.fromName.trim()
    : null;
  const pool = pg();
  let out;
  if (pool) {
    const res = await pool.query(
      `INSERT INTO df_mail (owner_id, type, from_id, from_name, title, body)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [owner, type, fromId, fromName, title, body],
    );
    out = rowOut(res.rows[0]);
  } else {
    memSeq += 1;
    out = {
      id: memSeq,
      ownerId: owner,
      type,
      fromId,
      fromName,
      title,
      body,
      createdAt: new Date().toISOString(),
    };
    memMail.push(out);
  }
  await prune(owner, type);
  return { ...out, ok: true };
}

/**
 * Convite de partida recebido (gancho: df-friends.mjs, handler
 * "invite_friend", após o emit "invite_received" ao convidado).
 * O 4º argumento (title) só existe para os testes dirigidos.
 */
export async function recordInviteMail(ownerId, fromId, fromName, title = null) {
  const name = normName(fromName);
  return recordMail(ownerId, "invite", {
    fromId,
    fromName: name,
    title: title || "Convite de partida",
    body: `${name} te convidou para uma partida.`,
  });
}

/**
 * Novo seguidor (gancho: df-friends.mjs, followPlayer(), após o
 * INSERT em df_follows). O 4º argumento (title) só existe para os
 * testes dirigidos.
 */
export async function recordFollowMail(ownerId, fromId, fromName, title = null) {
  const name = normName(fromName);
  return recordMail(ownerId, "follow", {
    fromId,
    fromName: name,
    title: title || "Novo seguidor",
    body: `${name} te seguiu.`,
  });
}

/**
 * Comunicado do servidor para UM jogador. A ferramenta que envia a
 * TODOS os jogadores é um projeto futuro — ela iterará os jogadores
 * e chamará esta função para cada um.
 */
export async function recordAnnouncementMail(ownerId, title, body) {
  return recordMail(ownerId, "announcement", {
    fromId: null,
    fromName: null,
    title: typeof title === "string" && title.trim() !== "" ? title : "Comunicado",
    body: typeof body === "string" ? body : "",
  });
}

/** Lista as mensagens de uma aba do jogador, da mais nova primeiro. */
export async function listMail(ownerId, type) {
  const owner = normId(ownerId);
  if (!owner) return [];
  if (!MAIL_TYPES.includes(type)) return [];
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `SELECT * FROM df_mail WHERE owner_id = $1 AND type = $2 ORDER BY created_at DESC, id DESC`,
      [owner, type],
    );
    return res.rows.map(rowOut);
  }
  return memMail
    .filter((m) => m.ownerId === owner && m.type === type)
    .sort((a, b) => b.id - a.id)
    .map((m) => ({ ...m }));
}

/** Exclui UMA mensagem do próprio correio. De outro jogador: NOT_FOUND. */
export async function deleteMail(ownerId, mailId) {
  const owner = normId(ownerId);
  const id = Number(mailId);
  if (!owner || !Number.isFinite(id)) return { ok: false, error: "INVALID_ID" };
  const pool = pg();
  if (pool) {
    const res = await pool.query(
      `DELETE FROM df_mail WHERE id = $1 AND owner_id = $2`,
      [id, owner],
    );
    if (res.rowCount === 0) return { ok: false, error: "NOT_FOUND" };
    return { ok: true, deleted: true };
  }
  const idx = memMail.findIndex((m) => m.id === id && m.ownerId === owner);
  if (idx < 0) return { ok: false, error: "NOT_FOUND" };
  memMail.splice(idx, 1);
  return { ok: true, deleted: true };
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

export function register_mail_routes(app, _ctx = {}) {
  // GET /auth/mail?tab=invites|followers|announcements
  // (tab omitido = invites). Devolve {ok, tab, type, entries: [...]}.
  app.get("/auth/mail", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const tab = typeof req.query?.tab === "string" && req.query.tab !== "" ? req.query.tab : "invites";
    const type = TAB_TO_TYPE[tab];
    if (!type) return res.status(400).json({ ok: false, error: "INVALID_TAB" });
    const entries = await listMail(me.id, type);
    res.status(200).json({ ok: true, tab, type, entries });
  });

  // DELETE /auth/mail/:id — exclui uma mensagem do próprio correio.
  app.delete("/auth/mail/:id", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const r = await deleteMail(me.id, req.params?.id);
    if (!r.ok) {
      const status = r.error === "INVALID_ID" ? 400 : 404;
      return res.status(status).json(r);
    }
    res.status(200).json(r);
  });
}

/** Só testes: zera o estado em memória (sem tocar no Postgres). */
export function _resetMailMemoryForTests() {
  memMail.length = 0;
  memSeq = 0;
}
