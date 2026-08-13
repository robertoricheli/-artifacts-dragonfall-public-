/**
 * IA no servidor para assentos desconectados (Rankeado / PvP).
 * Paridade com vs-IA Difícil: mesmo cérebro + ritmo 1,5s entre ações.
 */
import { applyAuthoritativeAction, buildPresentationEnvelope } from "./df-authority.mjs";
import { withRoomLock, mirrorRoomNow } from "./df-room-store.mjs";
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import {
  pickBestHardAction,
  pickNextAction,
  pickOnEnterResolution,
  scoreLegalAction,
  listTalentPlays,
  pickUltimate,
  championSummonCost,
} from "./df-ai-hard-brain.mjs";

const AI_GRACE_MS = 8000;
/** Ritmo pedido pelo autor: ~1,6s entre ações da IA no disconnect (próximo do vs-IA). */
const AI_STEP_MS = 1600;
const AI_MAX_STEPS_PER_TURN = 18;
const AI_TICK_BUDGET_MS = Number(process.env.DF_AI_TICK_BUDGET_MS) || 40;
/** Renova o relógio do turno quando a IA assume. */
const AI_TURN_EXTEND_MS = Number(process.env.DF_TURN_TIMEOUT_MS) || 70000;

function ensureAiFlags(room) {
  if (!room.aiControlled) room.aiControlled = [false, false];
  if (!room.aiGraceTimer) room.aiGraceTimer = [null, null];
  if (!room.aiStepTimer) room.aiStepTimer = null;
  if (!room.aiPhase) room.aiPhase = "talent";
  if (room.aiMainFloor == null) room.aiMainFloor = 5;
  if (room.aiGeneration == null) room.aiGeneration = 0;
}

export function clearAiSeat(room, seat) {
  ensureAiFlags(room);
  if (seat !== 0 && seat !== 1) return;
  // Nova geração: ticks/follow-ups em voo abortam no check.
  room.aiGeneration = (room.aiGeneration | 0) + 1;
  room.aiControlled[seat] = false;
  if (room.aiGraceTimer[seat]) {
    clearTimeout(room.aiGraceTimer[seat]);
    room.aiGraceTimer[seat] = null;
  }
  // Cancela o próximo passo imediatamente se era a vez deste assento
  // ou se ninguém mais está sob IA.
  const otherAi = room.aiControlled[seat === 0 ? 1 : 0];
  if (room.aiStepTimer && (room.gameState?.currentPlayer === seat || !otherAi)) {
    clearTimeout(room.aiStepTimer);
    room.aiStepTimer = null;
  }
}

export function clearAllAi(room) {
  ensureAiFlags(room);
  room.aiGeneration = (room.aiGeneration | 0) + 1;
  room.aiControlled[0] = false;
  room.aiControlled[1] = false;
  if (room.aiGraceTimer[0]) {
    clearTimeout(room.aiGraceTimer[0]);
    room.aiGraceTimer[0] = null;
  }
  if (room.aiGraceTimer[1]) {
    clearTimeout(room.aiGraceTimer[1]);
    room.aiGraceTimer[1] = null;
  }
  if (room.aiStepTimer) {
    clearTimeout(room.aiStepTimer);
    room.aiStepTimer = null;
  }
  room.aiPhase = "talent";
  room.aiMainFloor = 5;
}

function enemyFieldCount(state, seat) {
  let n = 0;
  for (let p = 0; p < (state.playersCount || 2); p++) {
    if (p === seat) continue;
    n += (state.players[p]?.field || []).filter(Boolean).length;
  }
  return n;
}

function listLegal(state, seat) {
  const { DfEngine } = bootDragonfallEngine();
  return DfEngine.listLegalActions(state, seat, {
    strictFumacaToxica: true,
    avoidEnemyOnEnterWaste: enemyFieldCount(state, seat) === 0,
    allowWastedOnEnter: false,
  }) || [];
}

function actionKey(a) {
  if (!a?.type) return "";
  if (a.type === "SUMMON") return `SUMMON:${a.handIdx}`;
  if (a.type === "ATTACK_RESOLVE") {
    return `ATK:${a.attackerIdx}:${a.defenderPlayerId}:${a.defenderIdx}`;
  }
  if (a.type === "TALENT_START") return `TALENT:${a.handIdx}`;
  if (a.type === "ULTIMATE_PLAY") return `ULT:${a.ultimateType}:${a.targetP}:${a.targetI}`;
  if (a.type === "TALENT_TARGET") return `TT:${a.targetP}:${a.targetI}`;
  return a.type;
}

function delayMs() {
  return Math.max(AI_STEP_MS, AI_TICK_BUDGET_MS);
}

function extendAiTurnDeadline(room, hooks) {
  try {
    room.turnDeadline = Date.now() + AI_TURN_EXTEND_MS;
    if (typeof hooks?.resetTurnTimer === "function") {
      hooks.resetTurnTimer(room);
    } else if (typeof hooks?.onExtendDeadline === "function") {
      hooks.onExtendDeadline(room);
    }
  } catch (e) { /* */ }
}

/**
 * Escolhe e aplica a próxima ação do turno (fases talent → ult_early → main → ult_end → end).
 */
function pickAndApplyAiAction(room, seat) {
  ensureAiFlags(room);
  const state = room.gameState;
  const tried = new Set();

  for (let attempt = 0; attempt < 12; attempt++) {
    const legal = listLegal(state, seat);
    const actionsLeft = state.players[seat]?.actions ?? 0;
    let phase = room.aiPhase || "talent";

    // Avança fases automaticamente.
    if (phase === "talent") {
      const talents = listTalentPlays(state, seat);
      if (!talents.length) {
        room.aiPhase = "ult_early";
        phase = "ult_early";
      }
    }
    if (phase === "ult_early") {
      const ult = pickUltimate(state, seat, false);
      if (!ult) {
        room.aiPhase = "main";
        room.aiMainFloor = enemyFieldCount(state, seat) === 0 ? 1 : 5;
        phase = "main";
      }
    }
    if (phase === "main" && actionsLeft <= 0) {
      room.aiPhase = "ult_end";
      phase = "ult_end";
    }
    if (phase === "ult_end") {
      const ult = pickUltimate(state, seat, true);
      if (!ult) {
        room.aiPhase = "end";
        phase = "end";
      }
    }

    let action = null;
    let score = -9999;

    if (phase === "talent") {
      action = pickNextAction(state, seat, { phase: "talent" });
    } else if (phase === "ult_early") {
      action = pickNextAction(state, seat, { phase: "ult_early" });
      if (!action) {
        room.aiPhase = "main";
        continue;
      }
    } else if (phase === "ult_end") {
      action = pickNextAction(state, seat, { phase: "ult_end" });
      if (!action) {
        room.aiPhase = "end";
        continue;
      }
    } else if (phase === "end") {
      action = { type: "END_TURN", playerId: seat };
    } else {
      // main — floor 5 → 0 → força jogada
      let floor = room.aiMainFloor ?? 5;
      action = pickBestHardAction(state, seat, legal, { minScore: floor });
      score = action?._score ?? scoreLegalAction(state, seat, action);
      if ((!action || action.type === "END_TURN") && floor > 0) {
        room.aiMainFloor = 0;
        action = pickBestHardAction(state, seat, legal, { minScore: 0 });
        score = action?._score ?? -9999;
      }
      // Anti-pass: paridade vs-IA — NÃO forçar summons[0] (isso invocava
      // sem estratégia). Só joga se o score for aceitável; com campo vazio
      // prefere o melhor summon (plain), senão compra, senão passa.
      if (action?.type === "END_TURN") {
        const fc = (state.players[seat]?.field || []).filter(Boolean).length;
        const summons = legal.filter((a) => a?.type === "SUMMON");
        const draws = legal.filter((a) => a?.type === "DRAW_CARD");
        if (actionsLeft > 0 && (summons.length || draws.length)) {
          const pool = fc === 0 && summons.length
            ? summons
            : [...summons, ...draws];
          const picked = pickBestHardAction(state, seat, pool, {
            minScore: fc === 0 ? -5 : 0,
          });
          if (picked && picked.type !== "END_TURN") {
            action = picked;
            score = picked._score ?? scoreLegalAction(state, seat, picked);
          }
        }
      }
    }

    if (!action) action = { type: "END_TURN", playerId: seat };
    action = { ...action, playerId: seat };

    if (tried.has(actionKey(action))) {
      if (action.type === "END_TURN") break;
      tried.add(actionKey(action));
      // pula para próxima
      if (phase === "talent") room.aiPhase = "ult_early";
      else if (phase === "ult_early") room.aiPhase = "main";
      else if (phase === "main") room.aiMainFloor = Math.min(room.aiMainFloor ?? 5, 0);
      else if (phase === "ult_end") room.aiPhase = "end";
      continue;
    }
    tried.add(actionKey(action));

    // Não invoca campeão pago sem ações (paridade vs-IA).
    if (action.type === "SUMMON") {
      const card = state.players[seat]?.hand?.[action.handIdx];
      const acts = state.players[seat]?.actions ?? 0;
      const ritual = !!card?.summonRitual;
      const cost = championSummonCost(card);
      if (!card || (!ritual && acts < cost)) {
        continue;
      }
    }

    // TALENT_START: só inicia; follow-up via TALENT_TARGET / mutações no tick.
    const talentMeta = action._talentEffect ? { ...action } : null;
    const cleanAction = { ...action };
    delete cleanAction._score;
    delete cleanAction._talentEffect;
    delete cleanAction._target;
    delete cleanAction.card;

    const result = applyAuthoritativeAction(room, seat, cleanAction, null);
    if (result.ok) {
      if (phase === "talent") {
        // Após um talento, tenta mais talentos; senão avança.
        room.aiPhase = "talent";
      } else if (phase === "ult_early") {
        room.aiPhase = "main";
        room.aiMainFloor = enemyFieldCount(room.gameState, seat) === 0 ? 1 : 5;
      } else if (phase === "ult_end") {
        room.aiPhase = "end";
      } else if (phase === "main") {
        room.aiMainFloor = enemyFieldCount(room.gameState, seat) === 0 ? 1 : 5;
      }
      console.info(
        `[server-ai] seat=${seat} phase=${phase} action=${cleanAction.type}`
        + ` score=${score !== -9999 ? score : (action._score ?? "?")}`,
      );
      return {
        action: cleanAction,
        result,
        talentMeta,
        phase,
      };
    }
    console.warn(`[server-ai] reject ${cleanAction.type}`, result?.error || "");
    if (cleanAction.type === "END_TURN") {
      return { action: cleanAction, result, phase };
    }
    // Talent/ult falhou → avança fase.
    if (phase === "talent") room.aiPhase = "ult_early";
    else if (phase === "ult_early") room.aiPhase = "main";
    else if (phase === "ult_end") room.aiPhase = "end";
  }

  const end = applyAuthoritativeAction(room, seat, { type: "END_TURN", playerId: seat }, null);
  room.aiPhase = "talent";
  return { action: { type: "END_TURN", playerId: seat }, result: end, phase: "end" };
}

function buildPendingOnEnterAction(room, seat, summonResult) {
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

  const abilityKey = state.players[cIdx].field[fIdx]?.onEnter || plan.onEnter;
  let resolution = pickOnEnterResolution(state, seat, abilityKey, cIdx, fIdx) || {};
  if (!resolution || (resolution.targetP == null && resolution.targetI == null
      && resolution.targetPlayerIdx == null && resolution.targetIdx == null)) {
    try {
      if (typeof DfEngine.autoOnEnterResolution === "function") {
        resolution = DfEngine.autoOnEnterResolution(state, cIdx, fIdx, plan, Math.random) || {};
      }
    } catch (e) { /* */ }
  }

  return {
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
}

function buildTalentTargetAction(seat, talentMeta) {
  if (!talentMeta?._talentEffect || !talentMeta._target) return null;
  const te = talentMeta._talentEffect;
  const needsTarget = [
    "bolaDeFogoTalento", "explosao", "zeroAbsoluto", "medoTalento",
    "baforadaVenenosa", "fortalecerTalento",
  ].includes(te);
  if (!needsTarget) return null;
  return {
    type: "TALENT_TARGET",
    playerId: seat,
    talentEffect: te,
    targetP: talentMeta._target.targetP,
    targetI: talentMeta._target.targetI,
    handIdx: talentMeta.handIdx,
  };
}

async function emitAiEnvelope(room, hooks, seat, action, result) {
  room.actionSeq += 1;
  let presentationEnvelope = result.presentationEnvelope || null;
  if (!presentationEnvelope?.visuals?.length) {
    try {
      presentationEnvelope = buildPresentationEnvelope(
        result.events || [],
        action,
        { causeActionType: action?.type },
      ) || presentationEnvelope;
    } catch (e) { /* */ }
  }
  const envelope = {
    seq: room.actionSeq,
    fromSeat: seat,
    action,
    authoritativeState: result.state || null,
    events: result.events || [],
    serverAi: true,
    presentationEnvelope: presentationEnvelope || undefined,
  };
  if (result.state) room.lastSnapshot = { state: result.state, full: true };
  await mirrorRoomNow(room);
  hooks.emitEnvelope(room, envelope);
  // Não chamar onAfterAction completo (resetTurnTimer a cada passo) — só finish check.
  try {
    hooks.onAfterAiStep?.(room, result.state);
  } catch (e) { /* */ }
  try {
    hooks.maybeFinish?.(room, result.state);
  } catch (e) {
    try { hooks.onAfterAction?.(room, result.state); } catch (e2) { /* */ }
  }
  return envelope;
}

function scheduleNextTick(room, tickFn) {
  room.aiStepTimer = setTimeout(() => setImmediate(tickFn), delayMs());
}

/**
 * @param {object} room
 * @param {import('socket.io').Server} io
 * @param {{ emitEnvelope: Function, onAfterAction: Function, resetTurnTimer?: Function }} hooks
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

  // Novo turno IA: reinicia fases.
  if (room.aiTurnSeat !== cp) {
    room.aiTurnSeat = cp;
    room.aiPhase = "talent";
    room.aiMainFloor = enemyFieldCount(room.gameState, cp) === 0 ? 1 : 5;
    room.aiStepsThisTurn = 0;
  }

  const genAtSchedule = room.aiGeneration | 0;

  const tick = () => {
    room.aiStepTimer = null;
    void withRoomLock(room.code, async () => {
      if ((room.aiGeneration | 0) !== genAtSchedule) return;
      if (room.status !== "playing" || room.gameState?.winner != null) return;
      const seat = room.gameState?.currentPlayer;
      if (seat !== 0 && seat !== 1) return;
      if (!room.aiControlled[seat]) return;

      if (room.aiTurnSeat !== seat) {
        room.aiTurnSeat = seat;
        room.aiPhase = "talent";
        room.aiMainFloor = enemyFieldCount(room.gameState, seat) === 0 ? 1 : 5;
        room.aiStepsThisTurn = 0;
      }

      const pack = pickAndApplyAiAction(room, seat);
      const { action, result, talentMeta } = pack;
      if (!result?.ok) return;
      if ((room.aiGeneration | 0) !== genAtSchedule || !room.aiControlled[seat]) return;

      await emitAiEnvelope(room, hooks, seat, action, result);
      room.aiStepsThisTurn = (room.aiStepsThisTurn || 0) + 1;

      // Follow-ups com delay dedicado (humano lê a jogada) — apply no emit.
      const followActions = [];
      if (action.type === "SUMMON") {
        const fa = buildPendingOnEnterAction(room, seat, result);
        if (fa) followActions.push(fa);
      }
      if (action.type === "TALENT_START" && talentMeta) {
        const fa = buildTalentTargetAction(seat, talentMeta);
        if (fa) followActions.push(fa);
      }

      const stillAiTurn = () => room.status === "playing"
        && room.gameState?.winner == null
        && room.gameState?.currentPlayer === seat
        && room.aiControlled[seat]
        && (room.aiGeneration | 0) === genAtSchedule
        && (room.aiStepsThisTurn || 0) < AI_MAX_STEPS_PER_TURN;

      const runFollowUpsThenContinue = async (idx) => {
        if ((room.aiGeneration | 0) !== genAtSchedule) return;
        if (idx < followActions.length) {
          room.aiStepTimer = setTimeout(() => {
            void withRoomLock(room.code, async () => {
              if (!stillAiTurn()) return;
              const fa = followActions[idx];
              const fuResult = applyAuthoritativeAction(room, seat, fa, null);
              if (fuResult?.ok) {
                await emitAiEnvelope(room, hooks, seat, fa, fuResult);
                room.aiStepsThisTurn = (room.aiStepsThisTurn || 0) + 1;
              }
              await runFollowUpsThenContinue(idx + 1);
            }).catch((e) => console.warn("[server-ai] followUp", e?.message || e));
          }, delayMs());
          return;
        }
        if (action.type === "END_TURN") {
          room.aiPhase = "talent";
          room.aiTurnSeat = null;
          if (room.aiControlled[room.gameState?.currentPlayer]
              && (room.aiGeneration | 0) === genAtSchedule) {
            scheduleNextTick(room, tick);
          }
          return;
        }
        if (stillAiTurn()) {
          scheduleNextTick(room, tick);
        } else if (
          room.status === "playing"
          && room.gameState?.winner == null
          && room.aiControlled[room.gameState?.currentPlayer]
          && (room.aiGeneration | 0) === genAtSchedule
        ) {
          scheduleNextTick(room, tick);
        }
      };

      await runFollowUpsThenContinue(0);
    }).catch((e) => console.warn("[server-ai] lock", e?.message || e));
  };

  room.aiStepTimer = setTimeout(() => setImmediate(tick), delayMs());
}

function activateAiSeat(room, seat, io, hooks) {
  room.aiControlled[seat] = true;
  extendAiTurnDeadline(room, hooks);
  try {
    io.to(room.code).emit("peer_ai_control", {
      seat,
      active: true,
      turnDeadline: room.turnDeadline || null,
    });
  } catch (e) { /* */ }
  try { hooks?.onAiTakeover?.(room, seat); } catch (e) { /* */ }
  try { hooks?.persist?.(); } catch (e) { /* */ }
  // Sempre joga — NÃO forceEndTurn só porque o humano estourou o relógio.
  scheduleServerAi(room, io, hooks);
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
    if (room.sockets[seat]) return;
    activateAiSeat(room, seat, io, hooks);
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
  activateAiSeat(room, seat, io, hooks);
}

export function onHumanReconnectedClearAi(room, seat, io) {
  clearAiSeat(room, seat);
  try {
    io.to(room.code).emit("peer_ai_control", {
      seat,
      active: false,
      turnDeadline: room.turnDeadline || null,
      serverNow: Date.now(),
    });
  } catch (e) { /* */ }
}

export const SERVER_AI_GRACE_MS = AI_GRACE_MS;
export const SERVER_AI_STEP_MS = AI_STEP_MS;
