/**
 * Dragonfall — contas de jogador em PostgreSQL.
 */
import { getPgPool, isPostgresEnabled } from "./df-postgres.mjs";

const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS df_players (
  id UUID PRIMARY KEY,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_salt TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  password_enc TEXT,
  display_name VARCHAR(32),
  display_name_locked BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_hero_id VARCHAR(32),
  hub_background_id VARCHAR(64),
  custom_decks JSONB,
  xp_total INT NOT NULL DEFAULT 0,
  profile_revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS df_players_email ON df_players (email);
CREATE TABLE IF NOT EXISTS df_sessions (
  token TEXT PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES df_players(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS df_sessions_player ON df_sessions (player_id);
CREATE INDEX IF NOT EXISTS df_sessions_expires ON df_sessions (expires_at);
CREATE TABLE IF NOT EXISTS df_display_names (
  name_key VARCHAR(32) PRIMARY KEY,
  player_id UUID NOT NULL UNIQUE REFERENCES df_players(id) ON DELETE CASCADE
);
`;

function rowToPlayer(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    passwordEnc: row.password_enc,
    displayName: row.display_name,
    displayNameLocked: !!row.display_name_locked,
    avatarHeroId: row.avatar_hero_id,
    hubBackgroundId: row.hub_background_id,
    customDecks: row.custom_decks ?? null,
    xpTotal: row.xp_total ?? 0,
    profileRevision: Number(row.profile_revision ?? 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function playerToRow(p) {
  return [
    p.id,
    p.email,
    p.passwordSalt || "",
    p.passwordHash || "",
    p.passwordEnc ?? null,
    p.displayName ?? null,
    !!p.displayNameLocked,
    p.avatarHeroId ?? null,
    p.hubBackgroundId ?? null,
    p.customDecks != null ? JSON.stringify(p.customDecks) : null,
    p.xpTotal ?? 0,
    Number(p.profileRevision ?? 0),
    p.createdAt || new Date().toISOString(),
  ];
}

export async function initAuthPgSchema() {
  const pool = getPgPool();
  if (!pool) return false;
  await pool.query(AUTH_SCHEMA);
  return true;
}

export async function pgFindPlayerByEmail(email) {
  const pool = getPgPool();
  if (!pool) return null;
  const res = await pool.query(
    "SELECT * FROM df_players WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [email],
  );
  return rowToPlayer(res.rows[0]);
}

export async function pgGetPlayerById(id) {
  const pool = getPgPool();
  if (!pool || !id) return null;
  const res = await pool.query("SELECT * FROM df_players WHERE id = $1 LIMIT 1", [id]);
  return rowToPlayer(res.rows[0]);
}

export async function pgInsertPlayer(player) {
  const pool = getPgPool();
  if (!pool) throw new Error("PG_UNAVAILABLE");
  const vals = playerToRow(player);
  await pool.query(
    `INSERT INTO df_players
      (id, email, password_salt, password_hash, password_enc, display_name, display_name_locked,
       avatar_hero_id, hub_background_id, custom_decks, xp_total, profile_revision, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::timestamptz)`,
    vals,
  );
  return pgGetPlayerById(player.id);
}

export async function pgUpdatePlayer(player, { expectedRevision } = {}) {
  const pool = getPgPool();
  if (!pool) throw new Error("PG_UNAVAILABLE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT profile_revision FROM df_players WHERE id = $1 FOR UPDATE",
      [player.id],
    );
    if (!cur.rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, error: "NOT_FOUND" };
    }
    const currentRev = Number(cur.rows[0].profile_revision ?? 0);
    if (expectedRevision != null && Number(expectedRevision) !== currentRev) {
      const fresh = await pgGetPlayerById(player.id);
      await client.query("ROLLBACK");
      return { ok: false, error: "PROFILE_CONFLICT", player: fresh };
    }
    const nextRev = currentRev + 1;
    await client.query(
      `UPDATE df_players SET
        email = $2, password_salt = $3, password_hash = $4, password_enc = $5,
        display_name = $6, display_name_locked = $7, avatar_hero_id = $8,
        hub_background_id = $9, custom_decks = $10::jsonb, xp_total = $11,
        profile_revision = $12, updated_at = NOW()
       WHERE id = $1`,
      [
        player.id,
        player.email,
        player.passwordSalt || "",
        player.passwordHash || "",
        player.passwordEnc ?? null,
        player.displayName ?? null,
        !!player.displayNameLocked,
        player.avatarHeroId ?? null,
        player.hubBackgroundId ?? null,
        player.customDecks != null ? JSON.stringify(player.customDecks) : null,
        player.xpTotal ?? 0,
        nextRev,
      ],
    );
    await client.query("COMMIT");
    player.profileRevision = nextRev;
    return { ok: true, player: await pgGetPlayerById(player.id) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function pgCreateSession(playerId, token, expiresAt) {
  const pool = getPgPool();
  if (!pool) throw new Error("PG_UNAVAILABLE");
  await pool.query(
    "INSERT INTO df_sessions (token, player_id, expires_at) VALUES ($1, $2, $3)",
    [token, playerId, expiresAt],
  );
}

export async function pgDeleteSession(token) {
  const pool = getPgPool();
  if (!pool) return;
  await pool.query("DELETE FROM df_sessions WHERE token = $1", [token]);
}

export async function pgPruneSessions() {
  const pool = getPgPool();
  if (!pool) return;
  await pool.query("DELETE FROM df_sessions WHERE expires_at < $1", [Date.now()]);
}

export async function pgAuthPlayerFromToken(tokenHash) {
  const pool = getPgPool();
  if (!pool || !tokenHash) return null;
  const res = await pool.query(
    `SELECT p.* FROM df_sessions s
     JOIN df_players p ON p.id = s.player_id
     WHERE s.token = $1 AND s.expires_at >= $2
     LIMIT 1`,
    [tokenHash, Date.now()],
  );
  return rowToPlayer(res.rows[0]);
}

export async function pgGetDisplayNameOwner(nameKey) {
  const pool = getPgPool();
  if (!pool) return null;
  const res = await pool.query(
    "SELECT player_id FROM df_display_names WHERE name_key = $1 LIMIT 1",
    [nameKey],
  );
  return res.rows[0]?.player_id || null;
}

export async function pgSetDisplayName(playerId, oldKey, newKey) {
  const pool = getPgPool();
  if (!pool) throw new Error("PG_UNAVAILABLE");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (oldKey) {
      await client.query("DELETE FROM df_display_names WHERE name_key = $1 AND player_id = $2", [
        oldKey,
        playerId,
      ]);
    }
    if (newKey) {
      const ins = await client.query(
        `INSERT INTO df_display_names (name_key, player_id) VALUES ($1, $2)
         ON CONFLICT (name_key) DO NOTHING
         RETURNING player_id`,
        [newKey, playerId],
      );
      if (!ins.rows[0]) {
        const owner = await client.query(
          "SELECT player_id FROM df_display_names WHERE name_key = $1 LIMIT 1",
          [newKey],
        );
        if (owner.rows[0]?.player_id && owner.rows[0].player_id !== playerId) {
          await client.query("ROLLBACK");
          throw new Error("NAME_TAKEN");
        }
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Mantém no máximo `keep` sessões mais recentes do jogador. */
export async function pgPrunePlayerSessions(playerId, keep = 7) {
  const pool = getPgPool();
  if (!pool || !playerId) return;
  await pool.query(
    `DELETE FROM df_sessions
     WHERE player_id = $1
       AND token NOT IN (
         SELECT token FROM df_sessions
         WHERE player_id = $1
         ORDER BY expires_at DESC
         LIMIT $2
       )`,
    [playerId, Math.max(0, keep | 0)],
  );
}

/** Upsert player + optional display name (migration). */
export async function pgUpsertPlayerFromJson(player, displayNameKey) {
  const pool = getPgPool();
  if (!pool) throw new Error("PG_UNAVAILABLE");
  const existing = await pgGetPlayerById(player.id);
  if (existing) {
    const merged = { ...existing, ...player, profileRevision: existing.profileRevision };
    const r = await pgUpdatePlayer(merged);
    if (!r.ok) throw new Error(r.error || "UPDATE_FAILED");
    if (displayNameKey) await pgSetDisplayName(player.id, null, displayNameKey);
    return r.player;
  }
  await pgInsertPlayer({
    ...player,
    profileRevision: player.profileRevision ?? 0,
  });
  if (displayNameKey) await pgSetDisplayName(player.id, null, displayNameKey);
  return pgGetPlayerById(player.id);
}

export async function pgUpsertSession(token, playerId, expiresAt) {
  const pool = getPgPool();
  if (!pool) return;
  if (expiresAt < Date.now()) return;
  await pool.query(
    `INSERT INTO df_sessions (token, player_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET player_id = EXCLUDED.player_id, expires_at = EXCLUDED.expires_at`,
    [token, playerId, expiresAt],
  );
}

export function pgEnabled() {
  return isPostgresEnabled();
}
