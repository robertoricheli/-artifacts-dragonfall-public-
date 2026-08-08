/**
 * Diff estrutural de gameState projetado (Fase 5) — patches no remote_action.
 *
 * Formato: { op: "set", path: "players.0.actions", value: ... }
 * path: chaves com índices numéricos (players.0.field).
 */
const ROOT_KEYS = [
  "started",
  "currentPlayer",
  "playersCount",
  "turnNumber",
  "winPoints",
  "winner",
  "activeTalent",
];

const PLAYER_KEYS = [
  "name",
  "isAI",
  "heroId",
  "vp",
  "actions",
  "skipDraw",
  "skipNextAction",
  "ultimateUses",
  "usedUltimateThisTurn",
  "hand",
  "field",
  "deckCount",
  "discard",
  "onEnterUsedThisTurn",
  "lastDestroyedSummon",
  "destroyedChampions",
  "maldicaoForgetNext",
  "wallActive",
  "necromanciaPending",
];

function stableStringify(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  return stableStringify(a) === stableStringify(b);
}

function pushSet(patches, path, value) {
  patches.push({ op: "set", path, value: value === undefined ? null : value });
}

/**
 * Diff entre dois estados já projetados (fog aplicado).
 * @returns {Array<{op:string,path:string,value:unknown}>}
 */
export function diffProjectedStates(before, after) {
  const patches = [];
  if (!after || typeof after !== "object") return patches;
  if (!before || typeof before !== "object") {
    // Sem base — caller deve enviar full.
    return patches;
  }

  for (const key of ROOT_KEYS) {
    if (!valuesEqual(before[key], after[key])) {
      pushSet(patches, key, after[key] ?? null);
    }
  }

  const bPlayers = before.players || [];
  const aPlayers = after.players || [];
  const n = Math.max(bPlayers.length, aPlayers.length, after.playersCount | 0, 2);
  for (let i = 0; i < n; i++) {
    const bp = bPlayers[i];
    const ap = aPlayers[i];
    if (!ap) {
      if (bp) pushSet(patches, `players.${i}`, null);
      continue;
    }
    if (!bp) {
      pushSet(patches, `players.${i}`, ap);
      continue;
    }
    for (const key of PLAYER_KEYS) {
      if (!valuesEqual(bp[key], ap[key])) {
        pushSet(patches, `players.${i}.${key}`, ap[key] ?? null);
      }
    }
  }

  return patches;
}

/**
 * Aplica patches in-place (mutates target). Retorna target.
 */
export function applyStatePatches(target, patches) {
  if (!target || !Array.isArray(patches)) return target;
  for (const p of patches) {
    if (!p || p.op !== "set" || typeof p.path !== "string") continue;
    setPath(target, p.path, p.value);
  }
  return target;
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const idx = /^\d+$/.test(key) ? Number(key) : key;
    const nextKey = parts[i + 1];
    const nextIsIdx = /^\d+$/.test(nextKey);
    if (cur[idx] == null || typeof cur[idx] !== "object") {
      cur[idx] = nextIsIdx ? [] : {};
    }
    cur = cur[idx];
  }
  const last = parts[parts.length - 1];
  const lastKey = /^\d+$/.test(last) ? Number(last) : last;
  cur[lastKey] = value;
}

export function estimateJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch (e) {
    return 0;
  }
}

/**
 * Decide se patches valem a pena vs full (economia mínima 10%).
 */
export function preferPatches(patches, fullState, opts = {}) {
  if (!Array.isArray(patches) || !patches.length) return false;
  if (patches.length > (opts.maxOps || 80)) return false;
  const fullBytes = estimateJsonBytes(fullState);
  const patchBytes = estimateJsonBytes(patches);
  if (fullBytes <= 0) return false;
  const ratio = opts.maxRatio != null ? opts.maxRatio : 0.9;
  return patchBytes < fullBytes * ratio;
}

/**
 * Monta envelope peer com stateDiff (ou full).
 * Atualiza room._peerProj / room._peerProjSeq.
 * @param {(meta: object) => void} [recordFn] — recordStateDiff opcional
 */
export function attachPeerStateDiff(room, envelope, seat, projectFn, recordFn = null) {
  const auth = envelope?.authoritativeState;
  if (!auth?.players?.length || typeof projectFn !== "function") {
    return envelope;
  }
  const projected = projectFn(auth, seat);
  const seq = envelope.seq | 0;
  const useDiff = String(process.env.DF_STATE_DIFF || "1") !== "0";
  const actType = envelope?.action?.type;
  // SUMMON/END_TURN: full state — evita peer sem campo por patch dropado.
  const forceFull = actType === "SUMMON" || actType === "END_TURN";

  if (!room._peerProj) room._peerProj = [null, null];
  if (!room._peerProjSeq) room._peerProjSeq = [0, 0];

  const prev = room._peerProj[seat];
  const prevSeq = room._peerProjSeq[seat] | 0;
  const fullBytes = estimateJsonBytes(projected);
  let out;

  if (forceFull) {
    if (typeof recordFn === "function") {
      recordFn({
        mode: "full",
        reason: "force_" + String(actType || "action").toLowerCase(),
        roomCode: room.code,
        seat,
        seq,
        fullBytes,
        patchBytes: fullBytes,
      });
    }
    out = {
      ...envelope,
      authoritativeState: projected,
      stateDiff: { seq, full: true, reason: "force_" + String(actType || "action").toLowerCase() },
    };
    room._peerProj[seat] = projected;
    room._peerProjSeq[seat] = seq;
    return out;
  }

  if (useDiff && prev && prevSeq > 0 && prevSeq === seq - 1) {
    const patches = diffProjectedStates(prev, projected);
    const patchBytes = estimateJsonBytes(patches);
    if (preferPatches(patches, projected)) {
      if (typeof recordFn === "function") {
        recordFn({
          mode: "patch",
          roomCode: room.code,
          seat,
          seq,
          fullBytes,
          patchBytes,
          ops: patches.length,
        });
      }
      out = {
        ...envelope,
        authoritativeState: null,
        stateDiff: {
          baseSeq: prevSeq,
          seq,
          full: false,
          patches,
        },
      };
    } else {
      if (typeof recordFn === "function") {
        recordFn({
          mode: "full",
          reason: patches.length ? "not_smaller" : "empty",
          roomCode: room.code,
          seat,
          seq,
          fullBytes,
          patchBytes,
          ops: patches.length,
        });
      }
      out = {
        ...envelope,
        authoritativeState: projected,
        stateDiff: { seq, full: true, reason: patches.length ? "not_smaller" : "empty" },
      };
    }
  } else {
    if (typeof recordFn === "function") {
      recordFn({
        mode: "full",
        reason: !prev ? "no_base" : "seq_gap",
        roomCode: room.code,
        seat,
        seq,
        fullBytes,
        patchBytes: fullBytes,
      });
    }
    out = {
      ...envelope,
      authoritativeState: projected,
      stateDiff: {
        seq,
        full: true,
        reason: !prev ? "no_base" : "seq_gap",
      },
    };
  }

  room._peerProj[seat] = projected;
  room._peerProjSeq[seat] = seq;
  return out;
}
