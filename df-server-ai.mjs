/**
 * IA no servidor para assentos desconectados (Rankeado / PvP).
 * Usa DfEngine.listLegalActions + scoring estilo vs-IA Difícil (ai-hard.json).
 */
import { applyAuthoritativeAction } from "./df-authority.mjs";
import { withRoomLock, mirrorRoomNow } from "./df-room-store.mjs";
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import { pickBestHardAction } from "./df-server-ai-hard.mjs";

const AI_GRACE_MS = 8000;
/** Ritmo pedido pelo autor: ~1,5s entre ações da IA no disconnect. */
const AI_STEP_MS = 1500;
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
  const legal = DfEngine.listLegalActions(state, seat, {
    strictFumacaToxica: true,
    avoidEnemyOnEnterWaste: enemyFieldCount(state, seat) === 0,
    allowWastedOnEnter: false,
  }) || [];
  return pickBestHardAction(state, seat, legal);
}

function enemyFieldCount(state, seat) {
  let n = 0;
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    n += (state.players[p]?.field || []).filter(Boolean).length;
  }
  return n;
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
    void withRoomLock(room.code, async () => {
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
        await mirrorRoomNow(room);
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
      await mirrorRoomNow(room);
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
    }).catch((e) => console.warn("[server-ai] lock", e?.message || e));
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
      io.to(room.code).emit("peer_ai_control", {
        seat,
        active: true,
        turnDeadline: room.turnDeadline || null,
      });
    } catch (e) { /* */ }
    try { hooks?.onAiTakeover?.(room, seat); } catch (e) { /* */ }
    try { hooks?.persist?.(); } catch (e) { /* */ }
    // Deadline já passou no assento desconectado: força fim de turno imediatamente.
    const cp = room.gameState?.currentPlayer;
    const deadlineExpired = room.turnDeadline && room.turnDeadline <= Date.now();
    if (deadlineExpired && cp === seat && typeof hooks?.forceEndTurn === "function") {
      try { hooks.forceEndTurn(room); } catch (e) { /* */ }
    } else {
      scheduleServerAi(room, io, hooks);
    }
  }, AI_GRACE_MS);
}

/** Abandono explícito: IA assume imediatamente (sem grace de 8s). */
export function markSeatAbandonedForAi(room, seat, io, hooks) {
  ensureAiFlags(room);
  if (seat !== 0 && seat !== 1) return;
  if (room.status !== "playing") return;
  if (room.aiGraceTimer[seat]) {
    clearTimeout(room.aiGraceTimer[seat]);
    room.aiGraceTimer[seat] = null;
  }
  if (room.sockets[seat]) {
    // Assento já limpo pelo caller — se ainda houver socket, não forçar.
  }
  room.aiControlled[seat] = true;
  try {
    io.to(room.code).emit("peer_ai_control", {
      seat,
      active: true,
      turnDeadline: room.turnDeadline || null,
    });
  } catch (e) { /* */ }
  try { hooks?.onAiTakeover?.(room, seat); } catch (e) { /* */ }
  try { hooks?.persist?.(); } catch (e) { /* */ }
  const cp = room.gameState?.currentPlayer;
  const deadlineExpired = room.turnDeadline && room.turnDeadline <= Date.now();
  if (deadlineExpired && cp === seat && typeof hooks?.forceEndTurn === "function") {
    try { hooks.forceEndTurn(room); } catch (e) { /* */ }
  } else {
    scheduleServerAi(room, io, hooks);
  }
}

export function onHumanReconnectedClearAi(room, seat, io) {
  clearAiSeat(room, seat);
  try {
    io.to(room.code).emit("peer_ai_control", { seat, active: false });
  } catch (e) { /* */ }
}

export const SERVER_AI_GRACE_MS = AI_GRACE_MS;
