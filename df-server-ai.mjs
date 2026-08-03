/**
 * IA no servidor para assentos desconectados (Rankeado / PvP).
 * Usa DfEngine.listLegalActions + política simples (Difícil-lite).
 */
import { applyAuthoritativeAction } from "./df-authority.mjs";
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";

const AI_GRACE_MS = 8000;
const AI_STEP_MS = 900;
const AI_MAX_STEPS_PER_TURN = 12;
/** Budget de CPU por tick — cede o event loop (Fase 3). */
const AI_TICK_BUDGET_MS = Number(process.env.DF_AI_TICK_BUDGET_MS) || 40;

function ensureAiFlags(room) {
  if (!room.aiControlled) room.aiControlled = [false, false];
  if (!room.aiGraceTimer) room.aiGraceTimer = [null, null];
  if (!room.aiStepTimer) room.aiStepTimer = null;
}

export function clearAiSeat(room, seat) {
  ensureAiFlags(room);
  if (seat !== 0 && seat !== 1) return;
  room.aiControlled[seat] = false;
  if (room.aiGraceTimer[seat]) {
    clearTimeout(room.aiGraceTimer[seat]);
    room.aiGraceTimer[seat] = null;
  }
}

export function clearAllAi(room) {
  ensureAiFlags(room);
  clearAiSeat(room, 0);
  clearAiSeat(room, 1);
  if (room.aiStepTimer) {
    clearTimeout(room.aiStepTimer);
    room.aiStepTimer = null;
  }
}

function pickAiAction(state, seat) {
  const { DfEngine } = bootDragonfallEngine();
  const legal = DfEngine.listLegalActions(state, seat, {}) || [];
  if (!legal.length) {
    return { type: "END_TURN", playerId: seat };
  }
  const byType = (t) => legal.filter((a) => a?.type === t);
  const attacks = byType("ATTACK_RESOLVE");
  if (attacks.length) {
    return { ...attacks[Math.floor(Math.random() * attacks.length)], playerId: seat };
  }
  const summons = byType("SUMMON");
  if (summons.length) {
    return { ...summons[Math.floor(Math.random() * summons.length)], playerId: seat };
  }
  const draws = byType("DRAW_CARD");
  if (draws.length) {
    return { ...draws[0], playerId: seat };
  }
  const talents = byType("TALENT_START");
  if (talents.length) {
    return { ...talents[Math.floor(Math.random() * talents.length)], playerId: seat };
  }
  const end = byType("END_TURN");
  if (end.length) return { ...end[0], playerId: seat };
  return { type: "END_TURN", playerId: seat };
}

/**
 * @param {object} room
 * @param {import('socket.io').Server} io
 * @param {{ emitEnvelope: Function, onAfterAction: Function }} hooks
 */
export function scheduleServerAi(room, io, hooks) {
  ensureAiFlags(room);
  if (room.aiStepTimer) {
    clearTimeout(room.aiStepTimer);
    room.aiStepTimer = null;
  }
  if (room.status !== "playing" || room.gameState?.winner != null) return;

  const cp = room.gameState?.currentPlayer;
  if (cp !== 0 && cp !== 1) return;
  if (!room.aiControlled[cp]) return;

  let steps = 0;
  const tick = () => {
    room.aiStepTimer = null;
    if (room.status !== "playing" || room.gameState?.winner != null) return;
    const seat = room.gameState?.currentPlayer;
    if (seat !== 0 && seat !== 1) return;
    if (!room.aiControlled[seat]) return;

    const action = pickAiAction(room.gameState, seat);
    const result = applyAuthoritativeAction(room, seat, action, null);
    if (!result.ok) {
      const end = applyAuthoritativeAction(room, seat, { type: "END_TURN", playerId: seat }, null);
      if (!end.ok) return;
      room.actionSeq += 1;
      const envelope = {
        seq: room.actionSeq,
        fromSeat: seat,
        action: { type: "END_TURN", playerId: seat },
        authoritativeState: end.state || null,
        events: end.events || [],
        serverAi: true,
      };
      if (end.state) room.lastSnapshot = { state: end.state, full: true };
      hooks.emitEnvelope(room, envelope);
      hooks.onAfterAction(room, end.state);
      return;
    }

    room.actionSeq += 1;
    const envelope = {
      seq: room.actionSeq,
      fromSeat: seat,
      action,
      authoritativeState: result.state || null,
      events: result.events || [],
      serverAi: true,
    };
    if (result.state) room.lastSnapshot = { state: result.state, full: true };
    hooks.emitEnvelope(room, envelope);
    hooks.onAfterAction(room, result.state);

    steps += 1;
    const stillAiTurn =
      room.status === "playing"
      && room.gameState?.winner == null
      && room.gameState?.currentPlayer === seat
      && room.aiControlled[seat]
      && action.type !== "END_TURN"
      && steps < AI_MAX_STEPS_PER_TURN;

    if (stillAiTurn) {
      // Cede o event loop antes do próximo passo (não bloqueia Socket.IO).
      const delay = Math.max(AI_STEP_MS, AI_TICK_BUDGET_MS);
      room.aiStepTimer = setTimeout(() => {
        setImmediate(tick);
      }, delay);
    } else if (
      room.status === "playing"
      && room.gameState?.winner == null
      && room.aiControlled[room.gameState?.currentPlayer]
    ) {
      room.aiStepTimer = setTimeout(() => setImmediate(tick), AI_STEP_MS);
    }
  };

  room.aiStepTimer = setTimeout(() => setImmediate(tick), AI_STEP_MS);
}

/**
 * Marca assento desconectado; após grace, a IA assume.
 */
export function markSeatDisconnectedForAi(room, seat, io, hooks) {
  ensureAiFlags(room);
  if (seat !== 0 && seat !== 1) return;
  if (room.status !== "playing") return;

  if (room.aiGraceTimer[seat]) {
    clearTimeout(room.aiGraceTimer[seat]);
    room.aiGraceTimer[seat] = null;
  }

  room.aiGraceTimer[seat] = setTimeout(() => {
    room.aiGraceTimer[seat] = null;
    if (room.status !== "playing" || room.gameState?.winner != null) return;
    if (room.sockets[seat]) return; // reconectou
    room.aiControlled[seat] = true;
    try {
      io.to(room.code).emit("peer_ai_control", { seat, active: true });
    } catch (e) { /* */ }
    scheduleServerAi(room, io, hooks);
  }, AI_GRACE_MS);
}

export function onHumanReconnectedClearAi(room, seat, io) {
  clearAiSeat(room, seat);
  try {
    io.to(room.code).emit("peer_ai_control", { seat, active: false });
  } catch (e) { /* */ }
}

export const SERVER_AI_GRACE_MS = AI_GRACE_MS;
