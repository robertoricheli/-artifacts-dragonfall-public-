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
  game_version VARCHAR(24),
  -- Frente 3 (Perfil, 2026-11-25): placar final (PV) dos dois lados e
  -- se foi partida com amigo (nunca vale rank). Colunas acrescentadas
  -- tambem via ALTER abaixo, para bancos ja criados.
  score_0 INT,
  score_1 INT,
  friend_match BOOLEAN NOT NULL DEFAULT FALSE
);
-- Bancos criados antes da Frente 3 nao tem as colunas novas: o CREATE
-- acima nao as acrescenta, entao o ALTER garante (idempotente).
ALTER TABLE df_matches ADD COLUMN IF NOT EXISTS score_0 INT;
ALTER TABLE df_matches ADD COLUMN IF NOT EXISTS score_1 INT;
ALTER TABLE df_matches ADD COLUMN IF NOT EXISTS friend_match BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS df_matches_player0 ON df_matches (player_0_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS df_matches_player1 ON df_matches (player_1_id, ended_at DESC);
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
      // Folga para logins/partidas em paralelo (era 4; o pool serializava
      // tudo sob carga). Ajustável sem código: DF_PG_POOL_MAX.
      max: Number(process.env.DF_PG_POOL_MAX || 8) || 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    // Frente 1 (ALTA 3, 2026-11-24): um soluço do banco (conexão parada
    // derrubada, reinício do Postgres) NÃO pode derrubar o servidor
    // inteiro com as salas. Sem este listener, o 'error' do pool é
    // lançado e mata o processo (pg-pool: "Unhandled 'error' event").
    // O pool recria a conexão sozinho na próxima query.
    pool.on("error", (err) => {
      console.error("[postgres] pool error (cliente ocioso):", err?.message || err);
    });
    await pool.query(SCHEMA);
    // O schema de analytics usa getPgPool(), que exige `enabled` — marcar
    // aqui, com o pool criado e o schema base aplicado. Antes, `enabled`
    // só virava true DEPOIS deste bloco e o initAnalyticsSchema()
    // retornava false em silêncio no primeiro boot: o histórico de
    // partidas nunca era gravado no Postgres (S76-T13).
    enabled = true;
    try {
      const { initAnalyticsSchema } = await import("./df-analytics-pg.mjs");
      await initAnalyticsSchema();
    } catch (e) {
      console.warn("[postgres] analytics schema:", e?.message || e);
    }
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
 * Frente 3 (Perfil, 2026-11-25): payload aceita playerIds (ids dos
 * dois jogadores tambem em partida casual), scores ([pv0, pv1]) e
 * friendMatch. Devolve { id, prunedIds }: a retencao apaga as partidas
 * alem das 10 mais recentes de cada jogador (df_matches + df_replays
 * via ON DELETE CASCADE); os ids apagados vao em prunedIds para o
 * JSONL tambem ser podado pelo chamador.
 * @param {object} payload
 * @returns {Promise<{id:number,prunedIds:number[]}|null>}
 */
export async function saveMatchHistory(payload) {
  if (!enabled || !pool) return null;
  const {
    roomCode,
    winnerSeat,
    heroIds = [null, null],
    ranked = false,
    rankedPlayerIds = [null, null],
    playerIds = null,
    scores = [null, null],
    friendMatch = false,
    actionSeq = 0,
    gameVersion = null,
    eventLog = [],
    gameState = null,
    startedAt = null,
    durationMs = null,
    turnNumber = null,
  } = payload;

  // Frente 1 (ALTA 3, 2026-11-24): o pool.connect() ficava FORA do try —
  // um soluço do banco aqui derrubava quem chamava (e, sem o
  // pool.on('error'), o processo inteiro). Sem conexão, devolve null
  // (o histórico é best-effort; a partida não depende dele).
  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO df_matches
        (room_code, winner_seat, hero_0, hero_1, ranked, player_0_id, player_1_id,
         action_seq, game_version, started_at, duration_ms, turn_number,
         score_0, score_1, friend_match)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        roomCode,
        winnerSeat,
        heroIds[0],
        heroIds[1],
        !!ranked,
        (playerIds || rankedPlayerIds)[0],
        (playerIds || rankedPlayerIds)[1],
        actionSeq,
        gameVersion,
        startedAt ? new Date(startedAt).toISOString() : null,
        durationMs != null ? Math.max(0, Number(durationMs) | 0) : null,
        turnNumber != null ? Math.max(0, Number(turnNumber) | 0) : null,
        // (Frente 4, 1.51.102 item 7) placar ausente e 0, nunca NULL:
        // o cliente quebrava com int(null) no historico. Defesa em
        // profundidade junto com df-match-history.mjs; linhas antigas com
        // NULL nao sao reescritas - o /auth/history coalesce na leitura.
        scores?.[0] != null ? Math.max(0, Number(scores[0]) | 0) : 0,
        scores?.[1] != null ? Math.max(0, Number(scores[1]) | 0) : 0,
        !!friendMatch,
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
    // Retencao (Frente 3): so as 10 ultimas partidas por jogador.
    const prunedIds = [];
    const ids = (playerIds || rankedPlayerIds || []).filter(Boolean);
    for (const pid of [...new Set(ids.map(String))]) {
      try {
        const del = await pool.query(
          `DELETE FROM df_matches WHERE id IN (
             SELECT id FROM df_matches
             WHERE player_0_id = $1 OR player_1_id = $1
             ORDER BY ended_at DESC, id DESC OFFSET 10
           ) RETURNING id`,
          [pid],
        );
        for (const r of del.rows) prunedIds.push(Number(r.id));
      } catch (e) {
        console.warn("[postgres] retention failed:", e.message);
      }
    }
    return { id: matchId, prunedIds };
  } catch (e) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch (e2) { /* sem conexão */ }
    }
    console.warn("[postgres] save failed:", e.message);
    return null;
  } finally {
    client?.release();
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

/**
 * Frente 3: ultimas `limit` partidas de um jogador (qualquer tipo:
 * ranqueada, casual ou com amigo), da mais recente para a mais antiga.
 * Sem Postgres -> [] (o historico e best-effort).
 */
export async function getPlayerHistory(playerId, limit = 10) {
  if (!enabled || !pool || !playerId) return [];
  const lim = Math.max(1, Math.min(50, Number(limit) || 10));
  const res = await pool.query(
    `SELECT id, room_code, ended_at, winner_seat, hero_0, hero_1, ranked,
            player_0_id, player_1_id, action_seq, game_version,
            score_0, score_1, friend_match, started_at, duration_ms, turn_number
     FROM df_matches
     WHERE player_0_id = $1 OR player_1_id = $1
     ORDER BY ended_at DESC, id DESC
     LIMIT $2`,
    [String(playerId), lim],
  );
  return res.rows;
}

export async function shutdownPostgres() {
  if (pool) {
    await pool.end();
    pool = null;
    enabled = false;
  }
}
