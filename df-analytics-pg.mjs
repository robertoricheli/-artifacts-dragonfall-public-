/**
 * Dragonfall — schema e persistência de analytics (PostgreSQL).
 * Aditivo: não altera regras nem gameplay.
 */
import { getPgPool, isPostgresEnabled } from "./df-postgres.mjs";

const ANALYTICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS df_player_activity (
  id BIGSERIAL PRIMARY KEY,
  player_id UUID NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind VARCHAR(24) NOT NULL
);
CREATE INDEX IF NOT EXISTS df_player_activity_at ON df_player_activity (at DESC);
CREATE INDEX IF NOT EXISTS df_player_activity_player_at ON df_player_activity (player_id, at DESC);

CREATE TABLE IF NOT EXISTS df_match_stats (
  id BIGSERIAL PRIMARY KEY,
  player_id UUID,
  opponent_id UUID,
  match_type VARCHAR(16) NOT NULL,
  outcome VARCHAR(8),
  hero_id VARCHAR(64),
  duration_ms INT,
  turn_number INT,
  action_seq INT,
  deck_cards JSONB,
  ended_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS df_match_stats_ended_at ON df_match_stats (ended_at DESC);
CREATE INDEX IF NOT EXISTS df_match_stats_player ON df_match_stats (player_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS df_match_stats_hero ON df_match_stats (hero_id);

ALTER TABLE df_matches ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE df_matches ADD COLUMN IF NOT EXISTS duration_ms INT;
ALTER TABLE df_matches ADD COLUMN IF NOT EXISTS turn_number INT;
`;

export async function initAnalyticsSchema() {
  const pool = getPgPool();
  if (!pool) return false;
  await pool.query(ANALYTICS_SCHEMA);
  return true;
}

export async function pgInsertActivity(playerId, kind, at = null) {
  const pool = getPgPool();
  if (!pool || !playerId || !kind) return;
  if (at) {
    await pool.query(
      "INSERT INTO df_player_activity (player_id, at, kind) VALUES ($1, $2::timestamptz, $3)",
      [String(playerId), at, String(kind).slice(0, 24)],
    );
    return;
  }
  await pool.query(
    "INSERT INTO df_player_activity (player_id, kind) VALUES ($1, $2)",
    [String(playerId), String(kind).slice(0, 24)],
  );
}

/**
 * @param {object} row
 */
export async function pgInsertMatchStat(row) {
  const pool = getPgPool();
  if (!pool || !row?.matchType) return;
  await pool.query(
    `INSERT INTO df_match_stats
      (player_id, opponent_id, match_type, outcome, hero_id, duration_ms, turn_number, action_seq, deck_cards, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)`,
    [
      row.playerId || null,
      row.opponentId || null,
      String(row.matchType).slice(0, 16),
      row.outcome ? String(row.outcome).slice(0, 8) : null,
      row.heroId ? String(row.heroId).slice(0, 64) : null,
      row.durationMs != null ? Math.max(0, Number(row.durationMs) | 0) : null,
      row.turnNumber != null ? Math.max(0, Number(row.turnNumber) | 0) : null,
      row.actionSeq != null ? Math.max(0, Number(row.actionSeq) | 0) : null,
      row.deckCards != null ? JSON.stringify(row.deckCards) : null,
      row.endedAt || new Date().toISOString(),
    ],
  );
}

/**
 * Histórico de partidas de um jogador (conquistas retroativas). Só as linhas de /auth/match-xp
 * (action_seq NULL): uma por partida e por jogador; as de fim de partida online duplicariam o PvP.
 * @returns {Promise<{ matches: number, aiWins: number, pvpWins: number } | null>}
 */
export async function pgCountPlayerMatches(playerId) {
  const pool = getPgPool();
  if (!pool || !playerId) return null;
  const res = await pool.query(
    `SELECT COUNT(*)::int AS matches,
            COUNT(*) FILTER (WHERE match_type LIKE 'ai%' AND outcome = 'win')::int AS ai_wins,
            COUNT(*) FILTER (WHERE match_type = 'pvp' AND outcome = 'win')::int AS pvp_wins
       FROM df_match_stats
      WHERE player_id = $1 AND action_seq IS NULL`,
    [String(playerId)],
  );
  const row = res.rows[0] || {};
  return { matches: row.matches | 0, aiWins: row.ai_wins | 0, pvpWins: row.pvp_wins | 0 };
}

export function analyticsPgEnabled() {
  return isPostgresEnabled();
}
