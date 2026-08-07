/**
 * Métricas + logs estruturados do multiplayer (Fase 0 / Fase 1).
 * Janela deslizante ~60s para health/ops.
 */
const WINDOW_MS = 60_000;
const actionSamples = [];
const presentationSamples = [];
const presentSkewSamples = [];
const gapFillTimes = [];
const disconnectTimes = [];
let rejectCount = 0;
let actionCount = 0;
let presentationCount = 0;
let gapFillTotal = 0;
let stateDiffPatchCount = 0;
let stateDiffFullCount = 0;
let stateDiffSavedBytes = 0;
const stateDiffSamples = [];

function pruneSamples(arr, now = Date.now()) {
  while (arr.length && now - arr[0].t > WINDOW_MS) arr.shift();
}

function pruneTimestamps(arr, now = Date.now()) {
  while (arr.length && now - arr[0] > WINDOW_MS) arr.shift();
}

function isPresentationType(type) {
  return type === "SYNC_STATE" || type === "PLAY_VISUAL" || type === "PRESENT"
    || type === "PRESENT_TELEMETRY"
    || type === "ATTACK_START" || type === "ATTACK_PICK_ATTACKER"
    || type === "ATTACK_PICK_DEFENDER";
}

export function recordActionLatency(ms, meta = {}) {
  const now = Date.now();
  const n = Math.max(0, Number(ms) || 0);
  const type = meta?.type || null;
  if (isPresentationType(type)) {
    presentationSamples.push({ t: now, ms: n });
    pruneSamples(presentationSamples, now);
    presentationCount += 1;
    logMp("presentation", {
      room: meta.roomCode || null,
      seat: meta.seat,
      type,
      seq: meta.seq,
      latencyMs: Math.round(n),
      ok: meta.ok !== false,
    });
    return;
  }
  actionSamples.push({ t: now, ms: n });
  pruneSamples(actionSamples, now);
  actionCount += 1;
  if (type) {
    logMp("action", {
      room: meta.roomCode || null,
      seat: meta.seat,
      type,
      seq: meta.seq,
      latencyMs: Math.round(n),
      ok: meta.ok !== false,
      error: meta.error || null,
    });
  }
}

/** Skew de apresentação do cliente (match_ping.presentSkewMs). */
export function recordPresentSkew(ms, meta = {}) {
  const now = Date.now();
  const n = Math.max(0, Number(ms) || 0);
  presentSkewSamples.push({ t: now, ms: n });
  pruneSamples(presentSkewSamples, now);
  logMp("present_skew", {
    room: meta.roomCode || null,
    seat: meta.seat,
    seq: meta.seq,
    skewMs: Math.round(n),
  });
}

/** Gap-fill: cliente pediu replay com fromSeq atrás do actionSeq da sala. */
export function recordGapFill(meta = {}) {
  const now = Date.now();
  gapFillTimes.push(now);
  pruneTimestamps(gapFillTimes, now);
  gapFillTotal += 1;
  logMp("gap_fill", {
    room: meta.roomCode || null,
    seat: meta.seat,
    fromSeq: meta.fromSeq != null ? (meta.fromSeq | 0) : null,
    actionSeq: meta.actionSeq != null ? (meta.actionSeq | 0) : null,
    gap: meta.gap != null ? (meta.gap | 0) : null,
  });
}

/** Telemetria Fase 5 — patch vs full no remote_action. */
export function recordStateDiff(meta = {}) {
  const now = Date.now();
  const mode = meta.mode === "patch" ? "patch" : "full";
  const fullBytes = Math.max(0, Number(meta.fullBytes) || 0);
  const patchBytes = Math.max(0, Number(meta.patchBytes) || 0);
  if (mode === "patch") {
    stateDiffPatchCount += 1;
    if (fullBytes > patchBytes) stateDiffSavedBytes += fullBytes - patchBytes;
  } else {
    stateDiffFullCount += 1;
  }
  stateDiffSamples.push({ t: now, mode, fullBytes, patchBytes });
  pruneSamples(stateDiffSamples, now);
  logMp("state_diff", {
    room: meta.roomCode || null,
    seat: meta.seat,
    seq: meta.seq,
    mode,
    reason: meta.reason || null,
    fullBytes,
    patchBytes,
    ops: meta.ops != null ? meta.ops : null,
  });
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
  pruneTimestamps(disconnectTimes, now);
  logMp("disconnect", {
    room: meta.roomCode || null,
    seat: meta.seat,
    playing: !!meta.playing,
  });
}

function percentileStats(samples) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0;
  const p95 = ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : 0;
  return { avg: Math.round(avg), p95: Math.round(p95), n: ms.length };
}

export function getActionStats() {
  const now = Date.now();
  pruneSamples(actionSamples, now);
  pruneSamples(presentationSamples, now);
  pruneSamples(presentSkewSamples, now);
  pruneTimestamps(disconnectTimes, now);
  pruneTimestamps(gapFillTimes, now);
  const core = percentileStats(actionSamples);
  const pres = percentileStats(presentationSamples);
  const skew = percentileStats(presentSkewSamples);
  pruneSamples(stateDiffSamples, now);
  const diff1m = stateDiffSamples.length;
  const patch1m = stateDiffSamples.filter((s) => s.mode === "patch").length;
  return {
    avgActionMs: core.avg,
    p95ActionMs: core.p95,
    actions1m: core.n,
    avgPresentationMs: pres.avg,
    p95PresentationMs: pres.p95,
    presentations1m: pres.n,
    avgPresentSkewMs: skew.avg,
    p95PresentSkewMs: skew.p95,
    presentSkew1m: skew.n,
    avgQueueWaitMs: pres.avg,
    p95QueueWaitMs: pres.p95,
    disconnects1m: disconnectTimes.length,
    gapFills1m: gapFillTimes.length,
    gapFillsTotal: gapFillTotal,
    rejectsTotal: rejectCount,
    actionsTotal: actionCount,
    presentationsTotal: presentationCount,
    stateDiffPatchesTotal: stateDiffPatchCount,
    stateDiffFullTotal: stateDiffFullCount,
    stateDiffSavedBytesTotal: stateDiffSavedBytes,
    stateDiff1m: diff1m,
    stateDiffPatches1m: patch1m,
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
