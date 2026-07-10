/**
 * Servidor autoritativo — valida + aplica ações via DfEngine + event log.
 */
import { bootDragonfallEngine } from "../scripts/lib/df-node-boot.mjs";
import {
  appendEventLogEntry,
  exportEventLog,
} from "../artifacts/dragonfall/motor/dist/df-event-log.js";
import {
  unwrapGameState,
  validateSnapshotUpdate,
} from "./df-snapshot-guard.mjs";

/** Tipos aplicados no servidor — espelha DfEngine.applyAction (motor TS). */
export const AUTHORITATIVE_TYPES = new Set([
  "DRAW_CARD",
  "SUMMON",
  "ATTACK_RESOLVE",
  "END_TURN",
  "ON_ENTER_RESOLVE",
  "REACTIVE_BLOCK_ANSWER",
  "REACTIVE_PROTECTION_ANSWER",
  "TALENT_START",
  "ULTIMATE_PLAY",
  "SURRENDER",
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

/** Tipos delegados — snapshot validado antes de merge (menus / sync parcial). */
export const DELEGATED_TYPES = new Set([
  "TALENT_TARGET",
  "ABILITY_TARGET",
  "ULTIMATE_TARGET",
  "MENU_CHOICE",
  "NECROMANCIA_PICK",
  "UNFREEZE_CONFIRM",
  "SYNC_STATE",
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

  const v = DfEngine.validateAction(state, shaped);
  if (v.ok === false && v.code && v.code !== "DELEGATE") {
    return { ok: false, error: v.code || v.error || "ILLEGAL" };
  }

  if (DELEGATED_TYPES.has(action.type)) {
    if (!snapshot) {
      return { ok: false, error: "SNAPSHOT_REQUIRED" };
    }
    return mergeValidatedSnapshot(room, seat, shaped, snapshot);
  }

  if (!AUTHORITATIVE_TYPES.has(action.type)) {
    return { ok: false, error: "UNKNOWN_ACTION" };
  }

  const applied = DfEngine.applyAction(DfEngine.cloneState(state), shaped, {
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

  return {
    ok: true,
    state: applied.state,
    events: applied.events || [],
    logEntry: entry,
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
    reconnected: true,
  };
}
