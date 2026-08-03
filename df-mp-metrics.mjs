/**
 * Métricas + logs estruturados do multiplayer (Fase 0).
 * Janela deslizante ~60s para health/ops.
 */
const WINDOW_MS = 60_000;
const actionSamples = [];
const disconnectTimes = [];
let rejectCount = 0;
let actionCount = 0;

function prune(arr, now = Date.now()) {
  while (arr.length && now - arr[0] > WINDOW_MS) arr.shift();
}

export function recordActionLatency(ms, meta = {}) {
  const now = Date.now();
  const n = Math.max(0, Number(ms) || 0);
  actionSamples.push({ t: now, ms: n });
  prune(actionSamples, now);
  actionCount += 1;
  if (meta?.type && meta.type !== "SYNC_STATE" && meta.type !== "PLAY_VISUAL") {
    logMp("action", {
      room: meta.roomCode || null,
      seat: meta.seat,
      type: meta.type,
      seq: meta.seq,
      latencyMs: Math.round(n),
      ok: meta.ok !== false,
      error: meta.error || null,
    });
  }
}

export function recordReject(error, meta = {}) {
  rejectCount += 1;
  logMp("reject", {
    room: meta.roomCode || null,
    seat: meta.seat,
    type: meta.type || null,
    error: String(error || "REJECT"),
  });
}

export function recordDisconnect(meta = {}) {
  const now = Date.now();
  disconnectTimes.push(now);
  prune(disconnectTimes, now);
  logMp("disconnect", {
    room: meta.roomCode || null,
    seat: meta.seat,
    playing: !!meta.playing,
  });
}

export function getActionStats() {
  const now = Date.now();
  prune(actionSamples, now);
  prune(disconnectTimes, now);
  const ms = actionSamples.map((s) => s.ms).sort((a, b) => a - b);
  const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0;
  const p95 = ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : 0;
  return {
    avgActionMs: Math.round(avg),
    p95ActionMs: Math.round(p95),
    actions1m: ms.length,
    disconnects1m: disconnectTimes.length,
    rejectsTotal: rejectCount,
    actionsTotal: actionCount,
  };
}

/** Log JSON numa linha — fácil de filtrar no Render. */
export function logMp(event, fields = {}) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      svc: "df-mp",
      event,
      ...fields,
    }));
  } catch (e) { /* */ }
}

/**
 * Keep-alive: pinga o próprio /health periodicamente (evita sleep em planos que dormem).
 * Desliga com DF_KEEPALIVE=0.
 */
export function startSelfKeepAlive(port, opts = {}) {
  if (process.env.DF_KEEPALIVE === "0") return () => {};
  const intervalMs = Number(process.env.DF_KEEPALIVE_MS) || opts.intervalMs || 4 * 60 * 1000;
  const url = process.env.DF_KEEPALIVE_URL
    || `http://127.0.0.1:${port}/health`;
  const tick = () => {
    fetch(url, { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.json())
      .then((d) => {
        if (!d?.ok) logMp("keepalive_warn", { ok: false });
      })
      .catch((e) => {
        logMp("keepalive_err", { error: e?.message || String(e) });
      });
  };
  const id = setInterval(tick, intervalMs);
  // Primeiro ping após 30s (dá tempo do listen).
  setTimeout(tick, 30_000);
  return () => clearInterval(id);
}
