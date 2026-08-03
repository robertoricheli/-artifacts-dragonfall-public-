/**
 * Persistência quente de salas em Postgres (Fase 2).
 * Fallback: room-persist.json quando PG off.
 */
import { getPgPool, isPostgresEnabled } from "./df-postgres.mjs";
import { logMp } from "./df-mp-metrics.mjs";

const LIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS df_live_rooms (
  code VARCHAR(32) PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'playing',
  game_state JSONB,
  last_snapshot JSONB,
  event_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_seq INT NOT NULL DEFAULT 0,
  heroes JSONB NOT NULL DEFAULT '[null,null]'::jsonb,
  ready JSONB NOT NULL DEFAULT '[false,false]'::jsonb,
  win_points INT NOT NULL DEFAULT 15,
  deck_seed BIGINT,
  arena_scenario_id VARCHAR(64),
  ranked BOOLEAN NOT NULL DEFAULT FALSE,
  ranked_player_ids JSONB,
  seat_tokens JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS df_live_rooms_status ON df_live_rooms (status);
CREATE INDEX IF NOT EXISTS df_live_rooms_updated ON df_live_rooms (updated_at DESC);
`;

const pending = new Map();
let flushTimer = null;
let schemaReady = false;

export async function initLiveRoomsSchema() {
  const pool = getPgPool();
  if (!pool) return false;
  try {
    await pool.query(LIVE_SCHEMA);
    schemaReady = true;
    logMp("live_rooms_schema", { ok: true });
    return true;
  } catch (e) {
    schemaReady = false;
    logMp("live_rooms_schema", { ok: false, error: e?.message || String(e) });
    return false;
  }
}

function serializeRoom(room) {
  return {
    code: room.code,
    status: room.status,
    game_state: room.gameState || null,
    last_snapshot: room.lastSnapshot || null,
    event_log: room.eventLog || [],
    action_seq: room.actionSeq || 0,
    heroes: room.heroes || [null, null],
    ready: room.ready || [false, false],
    win_points: room.winPoints ?? 15,
    deck_seed: room.deckSeed != null ? room.deckSeed : null,
    arena_scenario_id: room.arenaScenarioId || null,
    ranked: !!room.ranked,
    ranked_player_ids: room.rankedPlayerIds || null,
    seat_tokens: room.seatTokens || null,
  };
}

export function scheduleLiveRoomPersist(room) {
  if (!room?.code || room.status !== "playing") return;
  if (!isPostgresEnabled() || !schemaReady) return;
  pending.set(room.code, serializeRoom(room));
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLiveRoomPending();
  }, 200);
}

export async function flushLiveRoomPending() {
  if (!isPostgresEnabled() || !schemaReady) {
    pending.clear();
    return;
  }
  const pool = getPgPool();
  if (!pool) return;
  const batch = [...pending.values()];
  pending.clear();
  for (const row of batch) {
    try {
      await pool.query(
        `INSERT INTO df_live_rooms (
          code, status, game_state, last_snapshot, event_log, action_seq,
          heroes, ready, win_points, deck_seed, arena_scenario_id,
          ranked, ranked_player_ids, seat_tokens, updated_at
        ) VALUES (
          $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,
          $7::jsonb,$8::jsonb,$9,$10,$11,
          $12,$13::jsonb,$14::jsonb, NOW()
        )
        ON CONFLICT (code) DO UPDATE SET
          status = EXCLUDED.status,
          game_state = EXCLUDED.game_state,
          last_snapshot = EXCLUDED.last_snapshot,
          event_log = EXCLUDED.event_log,
          action_seq = EXCLUDED.action_seq,
          heroes = EXCLUDED.heroes,
          ready = EXCLUDED.ready,
          win_points = EXCLUDED.win_points,
          deck_seed = EXCLUDED.deck_seed,
          arena_scenario_id = EXCLUDED.arena_scenario_id,
          ranked = EXCLUDED.ranked,
          ranked_player_ids = EXCLUDED.ranked_player_ids,
          seat_tokens = EXCLUDED.seat_tokens,
          updated_at = NOW()`,
        [
          row.code,
          row.status,
          JSON.stringify(row.game_state),
          JSON.stringify(row.last_snapshot),
          JSON.stringify(row.event_log || []),
          row.action_seq,
          JSON.stringify(row.heroes),
          JSON.stringify(row.ready),
          row.win_points,
          row.deck_seed,
          row.arena_scenario_id,
          row.ranked,
          JSON.stringify(row.ranked_player_ids),
          JSON.stringify(row.seat_tokens),
        ],
      );
    } catch (e) {
      logMp("live_room_flush_err", { code: row.code, error: e?.message || String(e) });
    }
  }
}

export async function deleteLiveRoom(code) {
  if (!code || !isPostgresEnabled() || !schemaReady) return;
  const pool = getPgPool();
  if (!pool) return;
  try {
    await pool.query(`DELETE FROM df_live_rooms WHERE code = $1`, [String(code).toUpperCase()]);
  } catch (e) {
    logMp("live_room_delete_err", { code, error: e?.message || String(e) });
  }
}

export async function loadLiveRoomsFromPg() {
  if (!isPostgresEnabled() || !schemaReady) return [];
  const pool = getPgPool();
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT * FROM df_live_rooms WHERE status = 'playing' ORDER BY updated_at DESC LIMIT 200`,
    );
    return (res.rows || []).map((r) => ({
      code: r.code,
      createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
      status: r.status || "playing",
      heroes: r.heroes || [null, null],
      winPoints: r.win_points ?? 15,
      ready: r.ready || [false, false],
      lastSnapshot: r.last_snapshot || null,
      gameState: r.game_state || null,
      eventLog: r.event_log || [],
      actionSeq: r.action_seq || 0,
      deckSeed: r.deck_seed != null ? Number(r.deck_seed) : null,
      arenaScenarioId: r.arena_scenario_id || null,
      ranked: !!r.ranked,
      rankedPlayerIds: r.ranked_player_ids || null,
      seatTokens: r.seat_tokens || null,
    }));
  } catch (e) {
    logMp("live_room_load_err", { error: e?.message || String(e) });
    return [];
  }
}

export async function flushAllLiveRooms(listPlayingRoomsFn) {
  if (typeof listPlayingRoomsFn === "function") {
    for (const room of listPlayingRoomsFn()) {
      if (room?.status === "playing") pending.set(room.code, serializeRoom(room));
    }
  }
  await flushLiveRoomPending();
}
