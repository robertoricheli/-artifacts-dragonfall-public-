/**
 * Persistência quente de salas em Postgres (Fase 2).
 * Fallback: room-persist.json quando PG off.
 */
import { getPgPool, isPostgresEnabled } from "./df-postgres.mjs";
import { logMp } from "./df-mp-metrics.mjs";
// Frente 1 (MÉDIA 3): contexto reativo persistível (pergunta aberta).
import { serializeReactiveContext } from "./df-reactive-persist.mjs";

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
  reactive_ctx JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Frente 1 (MÉDIA 3): a tabela já existe no Render sem esta coluna.
ALTER TABLE df_live_rooms ADD COLUMN IF NOT EXISTS reactive_ctx JSONB;
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
    reactive_ctx: serializeReactiveContext(room),
  };
}

export function scheduleLiveRoomPersist(room) {
  if (!room?.code || room.status !== "playing") return;
  if (!isPostgresEnabled() || !schemaReady) return;
  pending.set(room.code, room);
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
  for (const room of batch) {
    // A sala pode ter encerrado depois do agendamento — não ressuscitar.
    if (!room?.code || room.status !== "playing") continue;
    const row = serializeRoom(room);
    try {
      await pool.query(
        `INSERT INTO df_live_rooms (
          code, status, game_state, last_snapshot, event_log, action_seq,
          heroes, ready, win_points, deck_seed, arena_scenario_id,
          ranked, ranked_player_ids, seat_tokens, reactive_ctx, updated_at
        ) VALUES (
          $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,
          $7::jsonb,$8::jsonb,$9,$10,$11,
          $12,$13::jsonb,$14::jsonb,$15::jsonb, NOW()
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
          reactive_ctx = EXCLUDED.reactive_ctx,
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
          JSON.stringify(row.reactive_ctx),
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
      `SELECT * FROM df_live_rooms WHERE status = 'playing' AND updated_at > NOW() - INTERVAL '2 hours' ORDER BY updated_at DESC LIMIT 200`,
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
      reactiveCtx: r.reactive_ctx || null,
    }));
  } catch (e) {
    logMp("live_room_load_err", { error: e?.message || String(e) });
    return [];
  }
}

/** Apaga linhas órfãs: encerradas (corrida agenda-antes-do-fim) e
 *  'playing' sem atualização há mais de 2 h (servidor caiu e a linha
 *  nunca mais seria restaurada). Só roda no intervalo de poda. */
export async function deleteStaleLiveRooms() {
  if (!isPostgresEnabled() || !schemaReady) return 0;
  const pool = getPgPool();
  if (!pool) return 0;
  try {
    const res = await pool.query(
      `DELETE FROM df_live_rooms WHERE status <> 'playing' OR updated_at < NOW() - INTERVAL '2 hours'`,
    );
    return res.rowCount | 0;
  } catch (e) {
    logMp("live_room_stale_delete_err", { error: e?.message || String(e) });
    return 0;
  }
}

/** Apaga linhas 'playing' sem sala viva na memória (a memória é a
 *  fonte — a linha é órfã de poda por outro caminho, de corrida antiga
 *  ou de shutdown). Roda só no intervalo de poda, com 1 shard. */
export async function deleteOrphanLiveRooms(liveCodes) {
  if (!isPostgresEnabled() || !schemaReady) return 0;
  const pool = getPgPool();
  if (!pool) return 0;
  try {
    const codes = liveCodes ? [...liveCodes] : [];
    const res = codes.length
      ? await pool.query(
          `DELETE FROM df_live_rooms WHERE status = 'playing' AND NOT (code = ANY($1))`,
          [codes],
        )
      : await pool.query(`DELETE FROM df_live_rooms WHERE status = 'playing'`);
    return res.rowCount | 0;
  } catch (e) {
    logMp("live_room_orphan_delete_err", { error: e?.message || String(e) });
    return 0;
  }
}

export async function flushAllLiveRooms(listPlayingRoomsFn) {
  if (typeof listPlayingRoomsFn === "function") {
    for (const room of listPlayingRoomsFn()) {
      if (room?.status === "playing") pending.set(room.code, room);
    }
  }
  await flushLiveRoomPending();
}
