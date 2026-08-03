/**
 * Servidor autoritativo — valida + aplica ações via DfEngine + event log.
 */
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import {
  appendEventLogEntry,
  exportEventLog,
} from "./motor/df-event-log.js";
import {
  unwrapGameState,
  validateSnapshotUpdate,
} from "./df-snapshot-guard.mjs";

/** Tipos aplicados no servidor — espelha DfEngine.applyAction (motor TS). */
export const AUTHORITATIVE_TYPES = new Set([
  "SUMMON",
  "DRAW_CARD",
  "ATTACK_RESOLVE",
  "END_TURN",
  "ON_ENTER_RESOLVE",
  "REACTIVE_BLOCK_ANSWER",
  "REACTIVE_PROTECTION_ANSWER",
  "TALENT_START",
  "ULTIMATE_PLAY",
  "SURRENDER",
  "FIELD_COMMIT",
]);

/** Tipos só-UI — não alteram estado no servidor. */
export const UI_ONLY_TYPES = new Set([
  "PLAY_VISUAL",
  "ATTACK_START",
  "ATTACK_PICK_ATTACKER",
  "ATTACK_PICK_DEFENDER",
  "REACTIVE_BLOCK_QUERY",
  "REACTIVE_PROTECTION_QUERY",
  "ABILITY_START",
  "ULTIMATE_START",
  "OPEN_DISCARD",
]);

/** Tipos delegados — snapshot se motor ainda CLIENT_ONLY / NOT_IMPLEMENTED. */
export const DELEGATED_TYPES = new Set([
  "ABILITY_TARGET",
  "ULTIMATE_TARGET",
  "MENU_CHOICE",
  "NECROMANCIA_PICK",
  "UNFREEZE_CONFIRM",
  "SYNC_STATE",
  // TALENT_TARGET: promovido a autoritativo quando applyTalentTarget existe;
  // permanece aqui só como fallback snapshot se motor retornar NOT_IMPLEMENTED.
  "TALENT_TARGET",
]);

let engine = null;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RNG determinístico por sala/ação (ultimates no servidor). */
export function roomActionRng(room, seat) {
  const seed = ((room.actionSeq + 1) * 2654435761 + seat * 40503 + (room.deckSeed || 0)) >>> 0;
  return mulberry32(seed);
}

function getEngine() {
  if (!engine) engine = bootDragonfallEngine();
  return engine;
}

/** Health: motor carregou (DfEngine.applyAction disponível). */
export function getEngineBootStatus() {
  try {
    const eng = getEngine();
    const ok = !!(eng?.DfEngine?.applyAction && eng?.DfEngine?.applyActionWithOnEnter);
    return { motorOk: ok, error: ok ? null : "ENGINE_INCOMPLETE" };
  } catch (e) {
    return { motorOk: false, error: e?.message || String(e) };
  }
}

function resolveGameState(room) {
  if (room.gameState?.players) return room.gameState;
  const snap = room.lastSnapshot;
  const fromSnap = unwrapGameState(snap);
  if (fromSnap?.players) {
    room.gameState = fromSnap;
    return room.gameState;
  }
  return null;
}

/** Inicializa estado + log ao receber snapshot ou match_start. */
export function seedRoomFromSnapshot(room, snapshot) {
  if (!snapshot) return;
  const st = unwrapGameState(snapshot);
  if (st?.players) {
    room.gameState = st;
    room.lastSnapshot = snapshot.state ? snapshot : { state: st, full: true };
  }
  if (!room.eventLog) room.eventLog = [];
}

function mergeValidatedSnapshot(room, seat, action, snapshot) {
  const prev = resolveGameState(room);
  const next = unwrapGameState(snapshot);
  const guard = validateSnapshotUpdate(prev, next, seat, action.type, action);
  if (!guard.ok) return guard;

  room.gameState = next;
  room.lastSnapshot = snapshot.state ? snapshot : { state: next, full: true };
  const entry = appendEventLogEntry(room.eventLog, room.actionSeq + 1, seat, action, [
    { type: "SNAPSHOT_MERGE", actionType: action.type },
  ]);
  return {
    ok: true,
    state: next,
    events: [{ type: "SNAPSHOT_MERGE", actionType: action.type }],
    logEntry: entry,
    delegated: true,
  };
}

/**
 * SYNC_STATE não reescreve o tabuleiro — servidor permanece a fonte de verdade.
 * O peer recebe authoritativeState; animação vai em action.anim.
 */
function applySyncStateCosmetic(room, seat, action) {
  const state = resolveGameState(room);
  if (!state?.players) return { ok: false, error: "NO_GAME_STATE" };
  const entry = appendEventLogEntry(room.eventLog, room.actionSeq + 1, seat, action, [
    { type: "SYNC_COSMETIC" },
  ]);
  return {
    ok: true,
    skip: true,
    uiOnly: true,
    state,
    events: [{ type: "SYNC_COSMETIC" }],
    logEntry: entry,
  };
}

/**
 * Aplica ação no estado da sala (fonte da verdade no servidor).
 */
export function applyAuthoritativeAction(room, seat, action, snapshot = null) {
  if (!action?.type) return { ok: false, error: "BAD_ACTION" };

  if (!room.eventLog) room.eventLog = [];

  if (UI_ONLY_TYPES.has(action.type)) {
    return { ok: true, skip: true, uiOnly: true };
  }

  let state = resolveGameState(room);
  if (!state?.players) {
    return { ok: false, error: "NO_GAME_STATE" };
  }

  const { DfEngine } = getEngine();
  const shaped = { ...action, playerId: seat };

  // SYNC: cosmético — nunca merge de snapshot de tabuleiro.
  if (shaped.type === "SYNC_STATE") {
    return applySyncStateCosmetic(room, seat, shaped);
  }

  const v = DfEngine.validateAction(state, shaped);
  if (v.ok === false && v.code && v.code !== "DELEGATE") {
    return { ok: false, error: v.code || v.error || "ILLEGAL" };
  }

  /** CLIENT_ONLY / estado idêntico = motor não aplicou — não promover. */
  function isClientOnlyNoop(applied, before) {
    if (!applied?.ok || !applied.state?.players) return true;
    const evs = applied.events || [];
    if (evs.some((e) => e && e.type === "CLIENT_ONLY")) return true;
    if (!evs.length) {
      try {
        return JSON.stringify(before.players) === JSON.stringify(applied.state.players)
          && before.currentPlayer === applied.state.currentPlayer
          && before.winner === applied.state.winner;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  // Delegados: motor real → senão snapshot validado (nunca ACK vazio).
  if (DELEGATED_TYPES.has(shaped.type)) {
    try {
      const applied = DfEngine.applyAction(DfEngine.cloneState(state), shaped, {
        rng: roomActionRng(room, seat),
      });
      if (applied?.ok && applied.state?.players && !isClientOnlyNoop(applied, state)) {
        room.gameState = applied.state;
        const entry = appendEventLogEntry(
          room.eventLog,
          room.actionSeq + 1,
          seat,
          shaped,
          applied.events || [],
        );
        return {
          ok: true,
          state: applied.state,
          events: applied.events || [],
          logEntry: entry,
          promoted: true,
        };
      }
    } catch (e) { /* fallback */ }
    if (!snapshot) {
      return { ok: false, error: "SNAPSHOT_REQUIRED" };
    }
    return mergeValidatedSnapshot(room, seat, shaped, snapshot);
  }

  if (!AUTHORITATIVE_TYPES.has(action.type)) {
    return { ok: false, error: "UNKNOWN_ACTION" };
  }

  // SUMMON: resolve on-enter auto (tokens Wyvern/Cubo, rapidez…) no servidor.
  const applyFn = typeof DfEngine.applyActionWithOnEnter === "function"
    && (shaped.type === "SUMMON" || shaped.type === "ON_ENTER_RESOLVE")
    ? DfEngine.applyActionWithOnEnter
    : DfEngine.applyAction;
  const applied = applyFn(DfEngine.cloneState(state), shaped, {
    rng: roomActionRng(room, seat),
  });
  if (!applied.ok) {
    return { ok: false, error: applied.error || "APPLY_FAILED" };
  }

  room.gameState = applied.state;
  const entry = appendEventLogEntry(
    room.eventLog,
    room.actionSeq + 1,
    seat,
    shaped,
    applied.events || [],
  );

  const presentation = (applied.events || [])
    .filter((e) => e && e.visual)
    .map((e) => ({ kind: e.visual, ...e }));

  return {
    ok: true,
    state: applied.state,
    events: applied.events || [],
    logEntry: entry,
    presentation: presentation.length ? presentation : undefined,
  };
}

/** @deprecated use applyAuthoritativeAction */
export function validateGameAction(room, seat, action, snapshot) {
  return applyAuthoritativeAction(room, seat, action, snapshot);
}

export function getRoomEventLogExport(room) {
  if (!room?.eventLog?.length) return null;
  return exportEventLog(room.eventLog, {
    roomCode: room.code,
    actionSeq: room.actionSeq,
  });
}

export function getRoomReplaySlice(room, fromSeq = 0) {
  if (!room?.eventLog) return [];
  return room.eventLog.filter((e) => e.seq > fromSeq);
}

export function buildReplayPayload(room) {
  if (!room || room.status !== "playing") return null;
  return {
    seq: room.actionSeq,
    entries: getRoomReplaySlice(room, 0),
    snapshot: room.lastSnapshot || null,
    gameState: room.gameState || null,
    heroIds: room.heroes || [null, null],
    arenaScenarioId: room.arenaScenarioId || null,
    deckSeed: room.deckSeed != null ? room.deckSeed : null,
    reconnected: true,
  };
}
