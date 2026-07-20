/**
 * Histórico de partidas + replays em PostgreSQL (opcional).
 * Ative com DATABASE_URL. Sem URL → no-op (rooms.json continua ativo).
 */
let pool = null;
let enabled = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS df_matches (
  id BIGSERIAL PRIMARY KEY,
  room_code VARCHAR(32) NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  winner_seat SMALLINT,
  hero_0 VARCHAR(64),
  hero_1 VARCHAR(64),
  ranked BOOLEAN NOT NULL DEFAULT FALSE,
  player_0_id VARCHAR(64),
  player_1_id VARCHAR(64),
  action_seq INT NOT NULL DEFAULT 0,
  game_version VARCHAR(24)
);
CREATE INDEX IF NOT EXISTS df_matches_ended_at ON df_matches (ended_at DESC);
CREATE INDEX IF NOT EXISTS df_matches_room_ended ON df_matches (room_code, ended_at DESC);
CREATE TABLE IF NOT EXISTS df_replays (
  match_id BIGINT PRIMARY KEY REFERENCES df_matches(id) ON DELETE CASCADE,
  event_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_state JSONB NOT NULL
);
`;

export async function initPostgres() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    enabled = false;
    return { enabled: false };
  }
  try {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({
      connectionString: url,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    await pool.query(SCHEMA);
    enabled = true;
    console.log("[postgres] histórico/replays ativo");
    return { enabled: true };
  } catch (e) {
    enabled = false;
    pool = null;
    const msg = e?.message || String(e);
    // Produção com DATABASE_URL: nunca cair em accounts.json efêmero (perda de dados).
    if (process.env.NODE_ENV === "production" || process.env.DF_REQUIRE_POSTGRES === "1") {
      console.error("[postgres] FATAL: DATABASE_URL definida mas init falhou:", msg);
      throw new Error(`POSTGRES_REQUIRED_FAILED: ${msg}`);
    }
    console.warn("[postgres] indisponível (dev):", msg);
    return { enabled: false, error: msg };
  }
}

export function isPostgresEnabled() {
  return enabled && !!pool;
}

export function getPgPool() {
  return enabled && pool ? pool : null;
}

/**
 * @param {object} payload
 * @returns {Promise<number|null>} match id
 */
export async function saveMatchHistory(payload) {
  if (!enabled || !pool) return null;
  const {
    roomCode,
    winnerSeat,
    heroIds = [null, null],
    ranked = false,
    rankedPlayerIds = [null, null],
    actionSeq = 0,
    gameVersion = null,
    eventLog = [],
    gameState = null,
  } = payload;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO df_matches
        (room_code, winner_seat, hero_0, hero_1, ranked, player_0_id, player_1_id, action_seq, game_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        roomCode,
        winnerSeat,
        heroIds[0],
        heroIds[1],
        !!ranked,
        rankedPlayerIds[0],
        rankedPlayerIds[1],
        actionSeq,
        gameVersion,
      ],
    );
    const matchId = ins.rows[0]?.id;
    if (matchId != null && gameState) {
      await client.query(
        `INSERT INTO df_replays (match_id, event_log, final_state) VALUES ($1, $2::jsonb, $3::jsonb)`,
        [matchId, JSON.stringify(eventLog || []), JSON.stringify(gameState)],
      );
    }
    await client.query("COMMIT");
    return matchId;
  } catch (e) {
    await client.query("ROLLBACK");
    console.warn("[postgres] save failed:", e.message);
    return null;
  } finally {
    client.release();
  }
}

/** @returns {Promise<object|null>} */
export async function getReplayByRoomCode(roomCode) {
  if (!enabled || !pool || !roomCode) return null;
  const res = await pool.query(
    `SELECT m.*, r.event_log, r.final_state
     FROM df_matches m
     JOIN df_replays r ON r.match_id = m.id
     WHERE m.room_code = $1
     ORDER BY m.ended_at DESC
     LIMIT 1`,
    [String(roomCode).trim().toUpperCase()],
  );
  return res.rows[0] || null;
}

export async function shutdownPostgres() {
  if (pool) {
    await pool.end();
    pool = null;
    enabled = false;
  }
}
