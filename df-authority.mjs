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
  "REACTIVE_CANCEL_ANSWER",
  "TALENT_START",
  "TALENT_DISCARD",
  "ULTIMATE_PLAY",
  "SURRENDER",
  "FIELD_COMMIT",
]);

/** Tipos só-UI — não alteram estado no servidor. */
export const UI_ONLY_TYPES = new Set([
  "PLAY_VISUAL",
  "PRESENT",
  "ATTACK_START",
  "ATTACK_PICK_ATTACKER",
  "ATTACK_PICK_DEFENDER",
  "REACTIVE_BLOCK_QUERY",
  "REACTIVE_PROTECTION_QUERY",
  "REACTIVE_CANCEL_QUERY",
  "ABILITY_START",
  "ULTIMATE_START",
  "OPEN_DISCARD",
]);

/** Tipos delegados — tenta motor; snapshot só se CLIENT_ONLY / NOT_IMPLEMENTED. */
export const DELEGATED_TYPES = new Set([
  "ABILITY_TARGET",
  "ULTIMATE_TARGET",
  "MENU_CHOICE",
  "NECROMANCIA_PICK",
  "UNFREEZE_CONFIRM",
  "SYNC_STATE",
  // Motor aplica os talentos conhecidos; demais ainda usam snapshot validado.
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
 * O peer NÃO deve aplicar authoritativeState (stale vs FIELD_COMMIT / patches).
 * Animação vai em action.anim / presentationEnvelope.
 */
function applySyncStateCosmetic(room, seat, action) {
  const state = resolveGameState(room);
  if (!state?.players) return { ok: false, error: "NO_GAME_STATE" };
  const entry = appendEventLogEntry(room.eventLog, room.actionSeq + 1, seat, action, [
    { type: "SYNC_COSMETIC" },
  ]);
  const presentationEnvelope = {
    visuals: action.anim?.kind ? [action.anim] : [],
    fieldPatches: Array.isArray(action.anim?.fieldPatches) ? action.anim.fieldPatches : [],
    deferBoardApply: false,
    skipBoardApply: true,
  };
  return {
    ok: true,
    skip: true,
    uiOnly: true,
    // Não retransmitir state cosmético — peer usa só presentation.
    state: null,
    omitAuthoritativeState: true,
    events: [{ type: "SYNC_COSMETIC" }],
    logEntry: entry,
    presentationEnvelope,
  };
}

/**
 * Normaliza events do motor → anim replay no cliente (casterIdx→casterP, etc.).
 */
function normalizeOnEnterVisual(ev) {
  const kind = ev.visual || ev.kind;
  if (!kind) return null;
  const out = { ...ev, kind };
  if (out.casterP == null && out.casterIdx != null) out.casterP = out.casterIdx;
  if (out.ownerP == null && out.casterIdx != null) out.ownerP = out.casterIdx;
  if (out.casterFieldIdx == null && out.fieldIdx != null) out.casterFieldIdx = out.fieldIdx;
  if (out.casterField == null && out.fieldIdx != null) out.casterField = out.fieldIdx;
  if (out.cardName == null && out.card != null) {
    out.cardName = typeof out.card === "string" ? out.card : (out.card.name || null);
  }
  // fire_aura / barrier_grant / guardian aliases
  if (out.indices == null && Array.isArray(out.picks)) {
    /* keep picks */
  }
  if (kind === "fire_aura" || kind === "barrier_grant") {
    if (out.ownerP == null && out.casterIdx != null) out.ownerP = out.casterIdx;
    if (!out.indices && Array.isArray(out.indices) === false && Array.isArray(ev.indices)) {
      out.indices = ev.indices;
    }
  }
  if (kind === "guardian" || kind === "guardiao") {
    out.kind = "guardian";
    if (out.casterP == null && out.casterIdx != null) out.casterP = out.casterIdx;
  }
  if (kind === "em_chamas") out.kind = "incendiar";
  if (kind === "freeze") out.kind = "zero_absoluto";
  // Raio Duplo: motor emite hits[]; peer/replay esperam picks[].
  if (kind === "raio_duplo") {
    if (!out.picks?.length && Array.isArray(out.hits)) {
      out.picks = out.hits.map((h) => ({ p: h.p, i: h.i }));
    }
    if (!out.fieldPatches?.length && Array.isArray(out.hits)) {
      out.fieldPatches = out.hits.map((h) => (
        (h.after | 0) <= 0
          ? { targetP: h.p, targetI: h.i, removed: true }
          : { targetP: h.p, targetI: h.i, currentPower: h.after | 0 }
      ));
    }
  }
  return out;
}

function mapEventTypeToVisual(ev) {
  const TYPE_KIND = {
    ROUBAR: "roubar",
    DESACELERAR: "desacelerar",
    PESADELO: "pesadelo",
    MALDICAO_SETE_MARES: "maldicao_sete_mares",
    FUMACA_TOXICA: "fumaca_toxica",
    NECROMANCIA: "necromancia",
    RAPIDEZ: "wings",
    FORTALECER: "strong_arm",
    GUARDIAO: "guardian",
    AURA_DE_FOGO: "fire_aura",
    AURA_ANTI_MAGIA: "barrier_grant",
    RAIO_DUPLO: "raio_duplo",
    DRAW: "card_draw",
    THUNDER_DISCARD: "thunder_discard",
    TALENT_BOLA_DE_FOGO: "bola_de_fogo",
    TALENT_EXPLOSAO: "explosao",
    TALENT_FORTALECER: "strong_arm",
    TALENT_VENENO: "baforada_venenosa",
    TALENT_ZERO: "zero_absoluto",
    TALENT_ZERO_SHATTER: "zero_absoluto",
    TALENT_ZERO_FREEZE: "zero_absoluto",
    TALENT_RESOLVED: null,
    REACTIVE_USED: null,
    SCARE_RETURN: "scare_return",
    TOKEN_INSERT: "dragon_token_summon",
    DESTROY: "destroy",
    POWER_REDUCED: null,
    STATUS_SET: null,
    COMBAT_RESOLVED: "combat",
    ATTACK_RESOLVED: "combat",
    DEVOUR: "devour",
    ASSASSINAR: "assassinar",
    TROCA_INJUSTA: "troca_injusta",
    IMITAR: "imitar",
    URSIFICACAO: "ursificacao",
    TRANSFORMAR_BICHINHO: "transformar_bichinho",
    INCENDIAR: "incendiar",
    STRONG_ARM: "strong_arm",
    WINGS: "wings",
    RAJADA_CONGELANTE_FREEZE: "rajada_congelante",
    RAJADA_CONGELANTE_DESTROY: "rajada_congelante_destroy",
    CORROMPER: "corrupt",
  };
  const kind = TYPE_KIND[ev.type];
  if (!kind) return null;
  // Upkeep DRAW: cliente anima via dfOnlinePlayUpkeepDrawFromEvents — sem card_draw no envelope.
  if (ev.type === "DRAW") return null;
  return normalizeOnEnterVisual({ ...ev, visual: kind });
}

/** Kinds que podem rodar em paralelo no peer (FX). */
const PARALLEL_FX_KINDS = new Set([
  "pesadelo", "wings", "roubar", "desacelerar", "strong_arm",
  "bola_de_fogo", "assassinar", "maldicao_sete_mares", "troca_injusta",
  "devour", "imitar", "ursificacao", "transformar_bichinho", "fury",
  "fire_aura", "guardiao", "guardian", "fumaca_toxica", "raio_duplo",
  "explosao", "zero_absoluto", "barrier_grant", "baforada_venenosa",
  "incendiar", "land_impact", "card_draw", "combat_telegraph",
  "misseis_magicos", "divine_protection", "cancel_ultimate",
  "blocked_attack", "vinganca", "necromancia", "thunder_discard",
  "scare_return", "aceleracao", "rajada_congelante", "rajada_congelante_destroy",
  "corrupt", "legado",
]);

const BOARD_SERIAL_KINDS = new Set([
  "talent_cast", "talent_discard", "summon_land", "combat", "destroy",
  "dragon_token_summon",
]);

/**
 * Monta envelope de apresentação a partir dos events do motor.
 * Clientes aplicam fieldPatches (após VFX quando deferBoardApply) sem confiar em snapshots.
 */
export function buildPresentationEnvelope(events = [], action = null, meta = {}) {
  const visuals = [];
  const fieldPatches = [];
  let deferBoardApply = false;

  for (const ev of events || []) {
    if (!ev || typeof ev !== "object") continue;
    // Grito: expandir por aliado (não um fury genérico sem fieldIdx).
    if (ev.type === "GRITO_DE_GUERRA" && Array.isArray(ev.applied)) {
      const ownerP = ev.casterIdx ?? ev.ownerP ?? 0;
      for (const t of ev.applied) {
        if (t?.p == null || t?.i == null) continue;
        visuals.push({
          kind: "fury",
          ownerP,
          fieldIdx: t.i,
          furyStacks: t.furyStacks,
          fieldPatches: [{
            targetP: t.p,
            targetI: t.i,
            fury: true,
            furyStacks: t.furyStacks ?? 1,
          }],
        });
        deferBoardApply = true;
      }
      continue;
    }
    if (ev.visual) {
      const n = normalizeOnEnterVisual(ev);
      if (n) visuals.push(n);
    } else if (ev.type) {
      const mapped = mapEventTypeToVisual(ev);
      if (mapped) visuals.push(mapped);
    }
    if (ev.type === "STATUS_SET" && ev.targetP != null && ev.targetI != null) {
      fieldPatches.push({
        targetP: ev.targetP,
        targetI: ev.targetI,
        ...(ev.flags || {}),
      });
    }
    if (ev.type === "DESTROY" && (ev.p != null || ev.targetP != null)) {
      fieldPatches.push({
        targetP: ev.targetP ?? ev.p,
        targetI: ev.targetI ?? ev.i,
        removed: true,
      });
      deferBoardApply = true;
    }
    if (ev.type === "ON_DESTROY_BURST" && ev.ability === "vinganca") {
      for (const t of ev.applied || []) {
        if (t?.p == null) continue;
        if (t.removed) {
          fieldPatches.push({ targetP: t.p, targetI: t.i, removed: true });
          deferBoardApply = true;
        } else if (t.currentPower != null) {
          fieldPatches.push({
            targetP: t.p,
            targetI: t.i,
            currentPower: t.currentPower,
          });
        }
        visuals.push({
          kind: "vinganca",
          ownerP: ev.ownerIdx,
          targetP: t.p,
          targetI: t.i,
          powerAfter: t.currentPower,
          fieldPatches: t.removed
            ? [{ targetP: t.p, targetI: t.i, removed: true }]
            : [{ targetP: t.p, targetI: t.i, currentPower: t.currentPower }],
        });
        deferBoardApply = true;
      }
    }
    if (ev.type === "POWER_REDUCED" && ev.targetP != null && ev.targetI != null) {
      if (ev.removed || (ev.currentPower != null && ev.currentPower <= 0)) {
        fieldPatches.push({ targetP: ev.targetP, targetI: ev.targetI, removed: true });
        deferBoardApply = true;
      } else if (ev.currentPower != null) {
        fieldPatches.push({
          targetP: ev.targetP,
          targetI: ev.targetI,
          currentPower: ev.currentPower,
        });
      }
    }
    if (ev.type === "POWER_CHANGED" && ev.targetP != null && ev.targetI != null
        && ev.currentPower != null) {
      fieldPatches.push({
        targetP: ev.targetP,
        targetI: ev.targetI,
        currentPower: ev.currentPower | 0,
      });
    }
    if (ev.type === "RAIO_DUPLO" && Array.isArray(ev.hits)) {
      for (const h of ev.hits) {
        if (!h || h.p == null) continue;
        if ((h.after | 0) <= 0) {
          fieldPatches.push({ targetP: h.p, targetI: h.i, removed: true });
          deferBoardApply = true;
        } else {
          fieldPatches.push({ targetP: h.p, targetI: h.i, currentPower: h.after | 0 });
        }
      }
    }
  }

  if (action?.anim?.kind) {
    visuals.push(action.anim);
    if (Array.isArray(action.anim.fieldPatches)) {
      for (const p of action.anim.fieldPatches) fieldPatches.push(p);
      if (action.anim.fieldPatches.some((p) => p?.removed)) deferBoardApply = true;
    }
  }

  // Anexa parallelGroup / timingHint a cada visual.
  for (const v of visuals) {
    if (!v || !v.kind) continue;
    if (!v.parallelGroup) {
      if (BOARD_SERIAL_KINDS.has(v.kind)) v.parallelGroup = "board";
      else if (PARALLEL_FX_KINDS.has(v.kind)) v.parallelGroup = "fx";
      else v.parallelGroup = "board";
    }
  }

  if (!visuals.length && !fieldPatches.length) return null;
  return {
    visuals,
    fieldPatches,
    deferBoardApply,
    skipBoardApply: false,
    causeActionType: action?.type || meta.causeActionType || null,
    seed: meta.seed != null ? meta.seed : null,
    applyPolicy: deferBoardApply ? "after_vfx" : "with_vfx",
  };
}

/**
 * Fog-of-war: peer recebe mãos adversárias só como contagem (anti-cheat).
 * Viewer vê a própria mão completa.
 */
export function projectStateForSeat(state, viewerSeat) {
  if (!state?.players?.length) return state;
  try {
    const next = JSON.parse(JSON.stringify(state));
    for (let i = 0; i < next.players.length; i++) {
      if (i === viewerSeat) continue;
      const pl = next.players[i];
      if (!pl?.hand) continue;
      const n = pl.hand.length;
      pl.hand = Array.from({ length: n }, () => ({ fog: true, category: "hidden" }));
      if (pl.deck && Array.isArray(pl.deck)) {
        pl.deckCount = pl.deck.length;
        // Não vazar ordem do baralho.
        pl.deck = [];
      }
    }
    return next;
  } catch (e) {
    return state;
  }
}

/**
 * Aplica ação no estado da sala (fonte da verdade no servidor).
 */
export function applyAuthoritativeAction(room, seat, action, snapshot = null) {
  if (!action?.type) return { ok: false, error: "BAD_ACTION" };

  if (!room.eventLog) room.eventLog = [];

  if (UI_ONLY_TYPES.has(action.type)) {
    const presentationEnvelope = buildPresentationEnvelope([], action);
    return {
      ok: true,
      skip: true,
      uiOnly: true,
      omitAuthoritativeState: true,
      state: null,
      presentationEnvelope: presentationEnvelope || undefined,
      presentation: presentationEnvelope?.visuals,
    };
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
          presentationEnvelope: buildPresentationEnvelope(applied.events || [], shaped) || undefined,
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

  const presentationEnvelope = buildPresentationEnvelope(applied.events || [], shaped, {
    causeActionType: shaped.type,
    seed: ((room.actionSeq + 1) * 2654435761 + seat * 40503 + (room.deckSeed || 0)) >>> 0,
  });
  const presentation = presentationEnvelope?.visuals?.length
    ? presentationEnvelope.visuals
    : (applied.events || [])
      .filter((e) => e && e.visual)
      .map((e) => ({ kind: e.visual, ...e }));

  return {
    ok: true,
    state: applied.state,
    events: applied.events || [],
    logEntry: entry,
    presentation: presentation?.length ? presentation : undefined,
    presentationEnvelope: presentationEnvelope || undefined,
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
  if (!room.gameState?.players?.length) return null;
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
