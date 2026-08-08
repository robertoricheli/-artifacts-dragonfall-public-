/**
 * IA no servidor para assentos desconectados (Rankeado / PvP).
 * Usa DfEngine.listLegalActions + scoring estilo vs-IA Difícil (ai-hard.json).
 */
import { applyAuthoritativeAction } from "./df-authority.mjs";
import { withRoomLock, mirrorRoomNow } from "./df-room-store.mjs";
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import { pickBestHardAction, scoreLegalAction } from "./df-server-ai-hard.mjs";

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

function listLegal(state, seat) {
  const { DfEngine } = bootDragonfallEngine();
  return DfEngine.listLegalActions(state, seat, {
    strictFumacaToxica: true,
    avoidEnemyOnEnterWaste: enemyFieldCount(state, seat) === 0,
    allowWastedOnEnter: false,
  }) || [];
}

function enemyFieldCount(state, seat) {
  let n = 0;
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    n += (state.players[p]?.field || []).filter(Boolean).length;
  }
  return n;
}

function actionKey(a) {
  if (!a?.type) return "";
  if (a.type === "SUMMON") return `SUMMON:${a.handIdx}`;
  if (a.type === "ATTACK_RESOLVE") {
    return `ATK:${a.attackerIdx}:${a.defenderPlayerId}:${a.defenderIdx}`;
  }
  if (a.type === "TALENT_START") return `TALENT:${a.handIdx}`;
  return a.type;
}

/**
 * Escolhe ação; em falha tenta a próxima melhor (não END_TURN imediato).
 */
function pickAndApplyAiAction(room, seat) {
  const tried = new Set();
  for (let attempt = 0; attempt < 10; attempt++) {
    const legal = listLegal(room.gameState, seat);
    const candidates = legal
      .filter((a) => a?.type && a.type !== "END_TURN" && !tried.has(actionKey(a)))
      .map((a) => ({ a, s: scoreLegalAction(room.gameState, seat, a) }))
      .sort((x, y) => y.s - x.s);

    let action = null;
    if (candidates.length && candidates[0].s >= -20) {
      action = { ...candidates[0].a, playerId: seat };
    } else {
      action = pickBestHardAction(room.gameState, seat, legal);
    }
    if (!action) action = { type: "END_TURN", playerId: seat };

    tried.add(actionKey(action));
    const result = applyAuthoritativeAction(room, seat, action, null);
    if (result.ok) {
      return { action, result };
    }
    if (action.type === "END_TURN") {
      return { action, result };
    }
  }
  const end = applyAuthoritativeAction(room, seat, { type: "END_TURN", playerId: seat }, null);
  return { action: { type: "END_TURN", playerId: seat }, result: end };
}

/**
 * Após SUMMON: resolve on-enter com alvo (ABILITY_TARGET) se ainda pendente.
 */
function tryResolvePendingOnEnter(room, seat, summonResult) {
  const events = summonResult?.events || [];
  const pending = events.find((e) => e?.type === "ON_ENTER_PENDING");
  if (!pending) return null;
  const boot = bootDragonfallEngine();
  const DfEngine = boot.DfEngine;
  const ER = boot.DfEffects;
  const state = room.gameState;
  const cIdx = pending.playerId ?? pending.casterIdx ?? seat;
  const fIdx = pending.fieldIdx;
  if (fIdx == null || !state?.players?.[cIdx]?.field?.[fIdx]) return null;
  let plan = null;
  try {
    plan = ER?.planOnEnter?.(state, cIdx, fIdx);
  } catch (e) { /* */ }
  if (!plan?.ok) return null;
  if (plan.mode === "blocked" || plan.mode === "necromancia_pick") return null;
  let resolution = {};
  try {
    if (typeof DfEngine.autoOnEnterResolution === "function") {
      resolution = DfEngine.autoOnEnterResolution(state, cIdx, fIdx, plan, Math.random) || {};
    }
  } catch (e) { /* */ }
  const abilityKey = state.players[cIdx].field[fIdx]?.onEnter || plan.onEnter;
  const action = {
    type: "ABILITY_TARGET",
    playerId: cIdx,
    casterIdx: cIdx,
    fieldIdx: fIdx,
    abilityKey,
    targetI: resolution.targetI,
    targetP: resolution.targetP,
    targetPlayerIdx: resolution.targetPlayerIdx ?? resolution.targetIdx,
    resolution,
  };
  const result = applyAuthoritativeAction(room, seat, action, null);
  if (!result.ok) return null;
  return { action, result };
}

async function emitAiEnvelope(room, hooks, seat, action, result) {
  room.actionSeq += 1;
  const envelope = {
    seq: room.actionSeq,
    fromSeat: seat,
    action,
    authoritativeState: result.state || null,
    events: result.events || [],
    serverAi: true,
    presentationEnvelope: result.presentationEnvelope || undefined,
  };
  if (result.state) room.lastSnapshot = { state: result.state, full: true };
  await mirrorRoomNow(room);
  hooks.emitEnvelope(room, envelope);
  hooks.onAfterAction(room, result.state);
  return envelope;
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

      const { action, result } = pickAndApplyAiAction(room, seat);
      if (!result?.ok) return;

      await emitAiEnvelope(room, hooks, seat, action, result);

      // SUMMON → on-enter com alvo no mesmo “passo lógico”, mas envelope separado
      // após o delay padrão (humano lê a invocação).
      let followUp = null;
      if (action.type === "SUMMON") {
        followUp = tryResolvePendingOnEnter(room, seat, result);
      }

      steps += 1;
      const stillAiTurn =
        room.status === "playing"
        && room.gameState?.winner == null
        && room.gameState?.currentPlayer === seat
        && room.aiControlled[seat]
        && action.type !== "END_TURN"
        && steps < AI_MAX_STEPS_PER_TURN;

      if (followUp?.result?.ok) {
        const delay = Math.max(AI_STEP_MS, AI_TICK_BUDGET_MS);
        room.aiStepTimer = setTimeout(() => {
          void withRoomLock(room.code, async () => {
            if (room.status !== "playing" || room.gameState?.winner != null) return;
            if (room.gameState?.currentPlayer !== seat || !room.aiControlled[seat]) return;
            await emitAiEnvelope(room, hooks, seat, followUp.action, followUp.result);
            steps += 1;
            if (
              room.status === "playing"
              && room.gameState?.winner == null
              && room.gameState?.currentPlayer === seat
              && room.aiControlled[seat]
              && steps < AI_MAX_STEPS_PER_TURN
            ) {
              room.aiStepTimer = setTimeout(() => setImmediate(tick), AI_STEP_MS);
            }
          }).catch((e) => console.warn("[server-ai] onEnter", e?.message || e));
        }, delay);
        return;
      }

      if (stillAiTurn) {
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
    const cpNow = room.gameState?.currentPlayer;
    const deadlineExpired = room.turnDeadline && room.turnDeadline <= Date.now();
    if (deadlineExpired && cpNow === seat && typeof hooks?.forceEndTurn === "function") {
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
  const cpNow = room.gameState?.currentPlayer;
  const deadlineExpired = room.turnDeadline && room.turnDeadline <= Date.now();
  if (deadlineExpired && cpNow === seat && typeof hooks?.forceEndTurn === "function") {
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
