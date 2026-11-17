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

/**
 * Escape de emergência: DF_FORCE_SNAPSHOT_FALLBACK=1 mantém estes tipos em
 * DELEGATED_TYPES (snapshot validado) em vez de AUTHORITATIVE_TYPES.
 */
const FORCE_SNAPSHOT_FALLBACK = String(process.env.DF_FORCE_SNAPSHOT_FALLBACK || "") === "1";

/** Tipos promovidos na Fase 2 (motor aplica de verdade). */
export const PHASE2_AUTHORITATIVE_TYPES = Object.freeze([
  "ABILITY_TARGET",
  "ULTIMATE_TARGET",
  "MENU_CHOICE",
  "NECROMANCIA_PICK",
  "TALENT_TARGET",
  "TALENT_AUTO",
]);

/** Tipos aplicados no servidor — espelha DfEngine.applyAction (motor TS). */
export const AUTHORITATIVE_TYPES = new Set([
  "SUMMON",
  "DRAW_CARD",
  "ATTACK_RESOLVE",
  "END_TURN",
  "ON_ENTER_RESOLVE",
  "RITUAL_EXHAUSTED",
  "REACTIVE_BLOCK_ANSWER",
  "REACTIVE_PROTECTION_ANSWER",
  "REACTIVE_CANCEL_ANSWER",
  "REACTIVE_EXHAUSTION_ANSWER",
  "REACTIVE_COUNTER_ANSWER",
  "TALENT_START",
  "TALENT_DISCARD",
  "ULTIMATE_PLAY",
  "SURRENDER",
  "FIELD_COMMIT",
  ...(FORCE_SNAPSHOT_FALLBACK ? [] : PHASE2_AUTHORITATIVE_TYPES),
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
  "REACTIVE_EXHAUSTION_QUERY",
  "REACTIVE_COUNTER_QUERY",
  "ABILITY_START",
  "ULTIMATE_START",
  "OPEN_DISCARD",
]);

/**
 * Tipos delegados — tenta motor; snapshot só se CLIENT_ONLY / NOT_IMPLEMENTED.
 * SYNC_STATE é cosmético (caminho especial). Com DF_FORCE_SNAPSHOT_FALLBACK=1,
 * a Fase 2 volta a este conjunto.
 */
export const DELEGATED_TYPES = new Set([
  "SYNC_STATE",
  ...(FORCE_SNAPSHOT_FALLBACK ? PHASE2_AUTHORITATIVE_TYPES : []),
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
  // barrier_grant / guardian aliases
  if (out.indices == null && Array.isArray(out.picks)) {
    /* keep picks */
  }
  if (kind === "barrier_grant") {
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
  // Rajada Congelante emite freeze/freeze_shatter — não confundir com Zero Absoluto.
  if (kind === "freeze") out.kind = "rajada_congelante";
  if (kind === "freeze_shatter") out.kind = "rajada_congelante_destroy";
  if (kind === "poison") out.kind = "mordida_venenosa";
  if (kind === "shield") out.kind = "shield";
  if (kind === "barrier_block") out.kind = "barrier_block";
  // Raio Duplo: motor emite hits[]; peer/replay esperam picks[].
  if (kind === "raio_duplo") {
    if (!out.picks?.length && Array.isArray(out.hits)) {
      out.picks = out.hits.map((h) => ({ p: h.p, i: h.i }));
    }
    if (!out.fieldPatches?.length && Array.isArray(out.hits)) {
      out.fieldPatches = out.hits.map((h) => {
        if (h.after != null && (h.after | 0) <= 0) {
          return { targetP: h.p, targetI: h.i, removed: true };
        }
        if (h.after != null) {
          return { targetP: h.p, targetI: h.i, currentPower: h.after | 0 };
        }
        const before = h.before != null ? (h.before | 0) : null;
        return {
          targetP: h.p,
          targetI: h.i,
          currentPower: before != null ? Math.max(0, before - 1) : undefined,
        };
      }).filter((p) => p.currentPower != null || p.removed);
    }
  }
  return out;
}

function mapEventTypeToVisual(ev) {
  const TYPE_KIND = {
    ROUBAR: "roubar",
    DESACELERAR: "desacelerar",
    MORDIDA_VENENOSA: "mordida_venenosa",
    PESADELO: "pesadelo",
    FUMACA_TOXICA: "fumaca_toxica",
    NECROMANCIA: "necromancia",
    RAPIDEZ: "wings",
    FORJA: "card_draw",
    FORTALECER: "strong_arm",
    GUARDIAO: "guardian",
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
    DRAGON_TOKEN_SUMMON: "dragon_token_summon",
    DESTROY: "destroy",
    POWER_REDUCED: null,
    STATUS_SET: null,
    COMBAT: "combat",
    COMBAT_RESOLVED: "combat",
    ATTACK_RESOLVED: "combat",
    COMBAT_BLOCKED: "blocked_attack",
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
    LEGADO: "legado",
    DEFENSOR: "shield",
    FURIA: "fury",
    GRITO_DE_GUERRA: "fury",
    TECNICAS_DE_COMBATE: "tecnicas_combate",
    ROLETA_RUSSA: "roleta_russa",
    PODRIDAO: "podridao",
    PODRIDAO_FIZZLE: "podridao_fizzle",
    BARRIER_BLOCKED: "barrier_block",
    BOLA_DE_FOGO: "bola_de_fogo",
    TRANSFORM_VULN_DESTROY: "transformar_bichinho",
    POISON_KILL: "poison_kill",
    BURN_TICK: "burn_tick",
    BURN_KILL: "burn_kill",
  };
  const kind = TYPE_KIND[ev.type];
  if (!kind) return null;
  // Upkeep DRAW: cliente anima via dfOnlinePlayUpkeepDrawFromEvents — sem card_draw no envelope.
  if (ev.type === "DRAW") return null;
  const out = normalizeOnEnterVisual({ ...ev, visual: kind });
  if (!out) return null;
  // Combate: peer espera attOwner/attIdx/defOwner/defIdx (+ kills).
  if (kind === "combat" || kind === "blocked_attack") {
    if (ev.attacker) {
      if (out.attOwner == null) out.attOwner = ev.attacker.p;
      if (out.attIdx == null) out.attIdx = ev.attacker.i;
    }
    if (ev.defender) {
      if (out.defOwner == null) out.defOwner = ev.defender.p;
      if (out.defIdx == null) out.defIdx = ev.defender.i;
    }
    if (ev.outcome) {
      out.killA = !!ev.outcome.killA;
      out.killD = !!ev.outcome.killD;
    }
  }
  // Token dragão: ownerP + insertIdx para land no peer.
  if (kind === "dragon_token_summon") {
    if (out.ownerP == null && out.casterIdx != null) out.ownerP = out.casterIdx;
    if (out.fieldIdx == null && out.insertIdx != null) out.fieldIdx = out.insertIdx;
  }
  // Veneno: indices p/i → ownerIdx/fieldIdx para o VFX no cliente.
  if (kind === "poison_kill") {
    if (out.ownerIdx == null && out.p != null) out.ownerIdx = out.p;
    if (out.fieldIdx == null && out.i != null) out.fieldIdx = out.i;
  }
  // Em Chamas: idem (tick e kill).
  if (kind === "burn_tick" || kind === "burn_kill") {
    if (out.ownerIdx == null && out.p != null) out.ownerIdx = out.p;
    if (out.fieldIdx == null && out.i != null) out.fieldIdx = out.i;
  }
  return out;
}

/** Kinds que podem rodar em paralelo no peer (FX). */
const PARALLEL_FX_KINDS = new Set([
  "pesadelo", "wings", "roubar", "desacelerar", "strong_arm",
  "bola_de_fogo", "assassinar",
  "devour", "imitar", "ursificacao", "transformar_bichinho", "fury",
  "guardiao", "guardian", "fumaca_toxica", "raio_duplo",
  "explosao", "zero_absoluto", "barrier_grant", "baforada_venenosa",
  "incendiar", "mordida_venenosa", "poison", "land_impact", "card_draw",
  "combat_telegraph", "burn_tick",
  "misseis_magicos", "divine_protection", "cancel_ultimate",
  "blocked_attack", "vinganca", "necromancia", "thunder_discard",
  "aceleracao", "rajada_congelante", "rajada_congelante_destroy",
  "corrupt", "legado", "doppel_cast",
  "shield", "barrier_block",
]);

const BOARD_SERIAL_KINDS = new Set([
  "talent_cast", "talent_discard", "summon_land", "combat", "destroy",
  "dragon_token_summon", "scare_return", "doppel_clone", "troca_injusta",
  "poison_kill", "burn_kill",
]);

/**
 * U-B07 / E-N1 Opção 1 (rodada 5): envelope só-visual de uma habilidade ou
 * talento que reduz Poder, para viajar COM a suspensão da PROTEÇÃO DIVINA
 * (ack do ator + query do defensor) — a animação toca e o box aparece
 * DURANTE ela, igual ao offline. O envelope NUNCA carrega mudança de
 * estado (fieldPatches zerados — a suspensão não muda nada; o dano só cai
 * na retomada). Devolve null quando a ação não é uma das 7 fontes.
 */
export function buildProtecaoVisualEnvelope(action, state, seatHint) {
  if (!action || typeof action !== "object") return null;
  const seat = action.playerId ?? seatHint ?? action.casterIdx ?? 0;
  const tp = action.targetP ?? action.targetPlayerId;
  const ti = action.targetI ?? action.targetFieldIdx;
  if (tp == null || ti == null) return null;
  let ev = null;
  if (action.type === "ABILITY_TARGET") {
    const key = action.abilityKey || "";
    const fieldIdx = action.fieldIdx ?? action.casterIdx;
    if (key === "bolaDeFogo") ev = { type: "BOLA_DE_FOGO", casterIdx: seat, fieldIdx, targetP: tp, targetI: ti, visual: "bola_de_fogo" };
    else if (key === "assassinar") ev = { type: "ASSASSINAR", casterIdx: seat, fieldIdx, targetP: tp, targetI: ti, visual: "assassinar" };
    else if (key === "transformarBichinho") ev = { type: "TRANSFORMAR_BICHINHO", casterIdx: seat, fieldIdx, targetP: tp, targetI: ti, visual: "transformar_bichinho" };
    else if (key === "incendiar") ev = { type: "INCENDIAR", casterIdx: seat, fieldIdx, targetP: tp, targetI: ti, visual: "incendiar" };
  } else if (action.type === "TALENT_TARGET") {
    const te = action.talentEffect || "";
    if (te === "bolaDeFogoTalento") ev = { type: "TALENT_BOLA_DE_FOGO", targetP: tp, targetI: ti, visual: "bola_de_fogo" };
    else if (te === "explosao") ev = { type: "TALENT_EXPLOSAO", targetP: tp, targetI: ti, visual: "explosao" };
    else if (te === "transformarBichinhoTalento") ev = { type: "TALENT_TRANSFORMAR_BICHINHO", targetP: tp, targetI: ti, visual: "transformar_bichinho" };
  }
  if (!ev) return null;
  const envelope = buildPresentationEnvelope([ev], action);
  if (!envelope) return null;
  // A suspensão não muda o estado: zerar os patches (o INCENDIAR geraria
  // o patch burning:true no alvo antes da resposta).
  const out = { ...envelope, fieldPatches: [] };
  if (Array.isArray(out.visuals)) {
    out.visuals = out.visuals.map((v) => (v && typeof v === "object" ? { ...v, fieldPatches: [] } : v));
  }
  return out;
}

/**
 * Monta envelope de apresentação a partir dos events do motor.
 * Clientes aplicam fieldPatches (após VFX quando deferBoardApply) sem confiar em snapshots.
 */
/**
 * S2-M10: duração estimada (ms) de cada kind visual, p/ o gate da IA.
 * Valores medidos no plano do Lote C (raízes ult_*) ou estimativa
 * conservadora (duração da VFX no cliente + margem). Sem entrada aqui, o
 * fallback é FALLBACK_VISUAL_MS (o comportamento atual). A ROLETA RUSSA
 * dura 6 s (ciclo completo, MANUAL_DE_REGRAS) — é o kind mais longo.
 * As Ultimates NÃO geram kind no envelope (a VFX delas vem do
 * ultimateType da ação) — a duração delas está em ULTIMATE_DURATION_MS.
 */
const VISUAL_DURATION_MS = Object.freeze({
  combat: 1500, blocked_attack: 1500, summon: 1050, summon_land: 1050,
  destroy: 500, talent_cast: 800, talent_discard: 500,
  bola_de_fogo: 1500, explosao: 2000, raio_duplo: 1500,
  zero_absoluto: 2000, rajada_congelante: 1500, rajada_congelante_destroy: 2000,
  mordida_venenosa: 1500, baforada_venenosa: 1700, misseis_magicos: 2500,
  incendiar: 2000, fumaca_toxica: 1500, assassinar: 1500, imitar: 1500,
  ursificacao: 1500, transformar_bichinho: 1500, corrupt: 1500, devour: 1500,
  roubar: 1500, desacelerar: 1500, pesadelo: 1500, necromancia: 1500,
  podridao: 1500, podridao_fizzle: 1000, strong_arm: 1500, wings: 1500,
  guardian: 1500, guardiao: 1500, shield: 1500, barrier_grant: 1500,
  barrier_block: 1000, fury: 1500, tecnicas_combate: 2000,
  roleta_russa: 6500, legado: 1500, vinganca: 2000,
  poison: 1500, poison_kill: 1500, burn_tick: 1000, burn_kill: 1500,
  card_draw: 1000, thunder_discard: 2900, divine_protection: 1500,
  cancel_ultimate: 1500, aceleracao: 1000, combat_telegraph: 500,
  land_impact: 1000, dragon_token_summon: 1800,
  doppel_clone: 2000, doppel_cast: 2000, scare_return: 1750,
  troca_injusta: 1500,
});
/** S2-M10: duração (ms) de cada Ultimate, por ultimateType (Lote C). */
const ULTIMATE_DURATION_MS = Object.freeze({
  targetEnemy: 2500, targetEnemyFreeze: 2500, targetAlly: 2500,
  targetAllyFreeAttack: 2000, drawCard: 2000, targetAllyShield: 2700,
  trickerySwap: 1100, thunderDiscard: 2900, fireAndIce: 2000,
  summonDragon: 1800, hook: 1600, resurrect: 1400, potion: 2000,
  vampirism: 2000, banish: 1600, poison: 1700, infinitePower: 2500,
  scareReturn: 1750, cometStarfall: 1800, incinerate: 2000,
  reuseInstant: 1500,
});
const FALLBACK_VISUAL_MS = 2500;

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
    if (ev.type === "TECNICAS_DE_COMBATE" && Array.isArray(ev.applied)) {
      for (const t of ev.applied) {
        if (t?.p == null || t?.i == null) continue;
        visuals.push({
          kind: "tecnicas_combate",
          casterIdx: ev.casterIdx,
          ownerP: t.p,
          fieldIdx: t.i,
          fieldPatches: [{
            targetP: t.p,
            targetI: t.i,
            tecnicasSobrepujar: true,
            tecnicasSobrepujarTurns: 1,
          }],
        });
        deferBoardApply = true;
      }
      continue;
    }
    if (ev.type === "ROLETA_RUSSA") {
      visuals.push({
        kind: "roleta_russa",
        casterIdx: ev.casterIdx,
        pickIndex: ev.pickIndex,
        candidates: ev.candidates,
        targetP: ev.targetP,
        targetUid: ev.targetUid,
        targetName: ev.targetName,
        vpGain: ev.vpGain,
      });
      continue;
    }
    if (ev.visual) {
      const n = normalizeOnEnterVisual(ev);
      if (n) {
        // Combate com visual inline (sem TYPE_KIND) — enriquecer alvos.
        if ((n.kind === "combat" || n.kind === "blocked_attack") && ev.attacker) {
          if (n.attOwner == null) n.attOwner = ev.attacker.p;
          if (n.attIdx == null) n.attIdx = ev.attacker.i;
        }
        if ((n.kind === "combat" || n.kind === "blocked_attack") && ev.defender) {
          if (n.defOwner == null) n.defOwner = ev.defender.p;
          if (n.defIdx == null) n.defIdx = ev.defender.i;
        }
        if (n.kind === "combat" && ev.outcome) {
          n.killA = !!ev.outcome.killA;
          n.killD = !!ev.outcome.killD;
        }
        if (n.kind === "dragon_token_summon") {
          if (n.ownerP == null && n.casterIdx != null) n.ownerP = n.casterIdx;
          if (n.fieldIdx == null && n.insertIdx != null) n.fieldIdx = n.insertIdx;
        }
        if (n.kind === "shield") {
          if (n.ownerP == null && n.casterIdx != null) n.ownerP = n.casterIdx;
          if (n.fieldIdx == null && ev.fieldIdx != null) n.fieldIdx = ev.fieldIdx;
          if (!n.indices?.length && n.fieldIdx != null) n.indices = [n.fieldIdx];
        }
        if (n.kind === "fury" && n.ownerP == null && n.casterIdx != null) {
          n.ownerP = n.casterIdx;
        }
        if (n.kind === "barrier_block") {
          if (n.targetP == null && ev.targetP != null) n.targetP = ev.targetP;
          if (n.targetI == null && ev.targetI != null) n.targetI = ev.targetI;
        }
        visuals.push(n);
        if (n.kind === "combat" || n.kind === "destroy" || n.kind === "dragon_token_summon"
            || n.kind === "blocked_attack" || n.killA || n.killD
            || n.kind === "devour" || n.kind === "scare_return"
            || n.kind === "assassinar" || n.kind === "rajada_congelante_destroy"
            || n.kind === "transformar_bichinho"
            || n.kind === "bola_de_fogo" || n.kind === "incendiar"
            || n.kind === "explosao" || n.kind === "misseis_magicos"
            || n.kind === "poison_kill" || n.kind === "vinganca"
            || n.kind === "burn_tick" || n.kind === "burn_kill") {
          deferBoardApply = true;
        }
      }
    } else if (ev.type) {
      const mapped = mapEventTypeToVisual(ev);
      if (mapped) {
        visuals.push(mapped);
        if (mapped.kind === "combat" || mapped.kind === "destroy"
            || mapped.kind === "dragon_token_summon" || mapped.kind === "blocked_attack"
            || mapped.killA || mapped.killD
            || mapped.kind === "devour" || mapped.kind === "scare_return"
            || mapped.kind === "assassinar" || mapped.kind === "bola_de_fogo"
            || mapped.kind === "incendiar" || mapped.kind === "explosao"
            || mapped.kind === "misseis_magicos" || mapped.kind === "poison_kill"
            || mapped.kind === "rajada_congelante_destroy"
            || mapped.kind === "transformar_bichinho" || mapped.kind === "vinganca"
            || mapped.kind === "burn_tick" || mapped.kind === "burn_kill") {
          deferBoardApply = true;
        }
      }
    }
    if (ev.type === "STATUS_SET" && ev.targetP != null && ev.targetI != null) {
      fieldPatches.push({
        targetP: ev.targetP,
        targetI: ev.targetI,
        ...(ev.flags || {}),
      });
    }
    // IMITAR: identidade mimética no caster (ícone + nome no peer).
    if (ev.type === "IMITAR" && ev.casterIdx != null && ev.fieldIdx != null) {
      fieldPatches.push({
        targetP: ev.casterIdx,
        targetI: ev.fieldIdx,
        mimico: true,
        mimicAbilityName: ev.abilityName || "Habilidade",
        mimicAbilityDesc: ev.mimicAbilityDesc || "",
        mimicSourceName: ev.mimicName || "",
        mimicOnEnter: ev.copiedOnEnter ?? null,
        mimicOnDestroy: ev.mimicOnDestroy ?? null,
        mimicConstantEffect: ev.copiedConstantEffect ?? null,
        abilityName: ev.abilityName || null,
        onEnter: ev.copiedOnEnter ?? null,
      });
      deferBoardApply = true;
      // Anexa patches ao visual já empurrado.
      const last = visuals[visuals.length - 1];
      if (last && last.kind === "imitar" && !last.fieldPatches?.length) {
        last.fieldPatches = [fieldPatches[fieldPatches.length - 1]];
        last.mimicAbilityName = ev.abilityName || "Habilidade";
        last.mimicSourceName = ev.mimicName || "";
        last.allyP = ev.allyP ?? ev.casterIdx;
        last.allyI = ev.allyI;
        last.casterP = ev.casterIdx;
        last.casterFieldIdx = ev.fieldIdx;
      }
    }
    // INCENDIAR: status Em Chamas nos dois clientes.
    if (ev.type === "INCENDIAR" && ev.targetP != null && ev.targetI != null) {
      fieldPatches.push({
        targetP: ev.targetP,
        targetI: ev.targetI,
        burning: true,
        burningTurns: ev.burningTurns ?? 4,
        burningByP: ev.burningByP ?? ev.casterIdx,
      });
      deferBoardApply = true;
      const last = visuals[visuals.length - 1];
      if (last && last.kind === "incendiar" && !last.fieldPatches?.length) {
        last.fieldPatches = [fieldPatches[fieldPatches.length - 1]];
      }
    }
    // DEFENSOR: escudo permanente no caster.
    if (ev.type === "DEFENSOR" && ev.casterIdx != null) {
      const fi = ev.fieldIdx != null ? (ev.fieldIdx | 0) : null;
      if (fi != null) {
        const patch = {
          targetP: ev.casterIdx,
          targetI: fi,
          shielded: true,
          shieldedPermanent: true,
          shieldedTurns: 0,
        };
        fieldPatches.push(patch);
        deferBoardApply = true;
        const last = visuals[visuals.length - 1];
        if (last && last.kind === "shield") {
          last.ownerP = ev.casterIdx;
          last.fieldIdx = fi;
          last.indices = [fi];
          if (!last.fieldPatches?.length) last.fieldPatches = [patch];
        }
      }
    }
    // FURIA (single): stacks no caster.
    if (ev.type === "FURIA" && ev.casterIdx != null) {
      const fi = ev.fieldIdx != null ? (ev.fieldIdx | 0) : null;
      if (fi != null) {
        const patch = {
          targetP: ev.casterIdx,
          targetI: fi,
          fury: true,
          furyStacks: ev.furyStacks ?? 1,
        };
        fieldPatches.push(patch);
        deferBoardApply = true;
        const last = visuals[visuals.length - 1];
        if (last && last.kind === "fury") {
          last.ownerP = ev.casterIdx;
          last.fieldIdx = fi;
          last.furyStacks = ev.furyStacks ?? 1;
          if (!last.fieldPatches?.length) last.fieldPatches = [patch];
        }
      }
    }
    // C-A17: BARRIER_BLOCKED significa "bloqueou e a Barreira FICOU" — não
    // há patch de consumo (o bloco antigo zerava barrier/barrierTurns no
    // modelo do cliente após o VFX, re-consumindo a Barreira pela porta
    // dos fundos). O visual "barrier_block" (mapa :303) continua intacto.
    // RAJADA freeze: status gelo.
    if (ev.type === "RAJADA_CONGELANTE_FREEZE" && ev.targetP != null && ev.targetI != null) {
      const patch = {
        targetP: ev.targetP,
        targetI: ev.targetI,
        frozen: true,
        frozenTurns: 1,
      };
      fieldPatches.push(patch);
      deferBoardApply = true;
      const last = visuals[visuals.length - 1];
      if (last && (last.kind === "rajada_congelante" || last.kind === "freeze")
          && !last.fieldPatches?.length) {
        last.fieldPatches = [patch];
      }
    }
    // MORDIDA: veneno no alvo.
    if (ev.type === "MORDIDA_VENENOSA" && ev.applied && ev.targetP != null && ev.targetI != null) {
      const patch = {
        targetP: ev.targetP,
        targetI: ev.targetI,
        poisoned: true,
        poisonTurns: ev.poisonTurns ?? 2,
        poisonedByP: ev.poisonedByP ?? ev.casterIdx,
      };
      fieldPatches.push(patch);
      deferBoardApply = true;
      const last = visuals[visuals.length - 1];
      if (last && (last.kind === "mordida_venenosa" || last.kind === "poison")
          && !last.fieldPatches?.length) {
        last.fieldPatches = [patch];
      }
    }
    // FORTALECER / TALENT_FORTALECER: poder no alvo.
    if ((ev.type === "FORTALECER" || ev.type === "TALENT_FORTALECER" || ev.type === "STRONG_ARM")
        && ev.targetP != null && ev.targetI != null) {
      const patch = {
        targetP: ev.targetP,
        targetI: ev.targetI,
        currentPower: ev.powerAfter ?? ev.currentPower,
      };
      if (patch.currentPower != null) {
        fieldPatches.push(patch);
        deferBoardApply = true;
        const last = visuals[visuals.length - 1];
        if (last && last.kind === "strong_arm" && !last.fieldPatches?.length) {
          last.fieldPatches = [patch];
        }
      }
    }
    // GUARDIÃO: escudo temporário nos picks.
    if (ev.type === "GUARDIAO" && Array.isArray(ev.picks)) {
      for (const pk of ev.picks) {
        if (pk?.p == null || pk?.i == null) continue;
        fieldPatches.push({
          targetP: pk.p,
          targetI: pk.i,
          shielded: true,
          shieldedTurns: 1,
        });
      }
      deferBoardApply = true;
      const last = visuals[visuals.length - 1];
      if (last && last.kind === "guardian" && !last.fieldPatches?.length) {
        last.fieldPatches = fieldPatches.filter((p) => p.shielded);
      }
    }
    // AURA ANTI-MAGIA: barreira permanente.
    if (ev.type === "AURA_ANTI_MAGIA" && ev.casterIdx != null && ev.fieldIdx != null) {
      const patch = {
        targetP: ev.casterIdx,
        targetI: ev.fieldIdx,
        barrier: true,
        barrierPermanent: true,
        barrierTurns: 0,
      };
      fieldPatches.push(patch);
      deferBoardApply = true;
      const last = visuals[visuals.length - 1];
      if (last && last.kind === "barrier_grant") {
        last.ownerP = ev.casterIdx;
        last.indices = [ev.fieldIdx];
        if (!last.fieldPatches?.length) last.fieldPatches = [patch];
      }
    }
    // CORROMPER: Sem Honra no alvo.
    if (ev.type === "CORROMPER" && !ev.alreadyNoHonor && ev.targetP != null && ev.targetI != null) {
      const patch = {
        targetP: ev.targetP,
        targetI: ev.targetI,
        corruptedNoHonor: true,
      };
      fieldPatches.push(patch);
      deferBoardApply = true;
      const last = visuals[visuals.length - 1];
      if (last && last.kind === "corrupt" && !last.fieldPatches?.length) {
        last.fieldPatches = [patch];
      }
    }
    // FUMACA: vulnerável.
    if (ev.type === "FUMACA_TOXICA" && Array.isArray(ev.picks)) {
      for (const pk of ev.picks) {
        if (pk?.p == null || pk?.i == null) continue;
        fieldPatches.push({ targetP: pk.p, targetI: pk.i, vulnerable: true });
      }
      deferBoardApply = true;
    }
    // DEVORAR: buff no caster + remoção da presa (VFX antes do remove no peer).
    if (ev.type === "DEVOUR" && ev.casterIdx != null && ev.devouredI != null) {
      const preyI = ev.devouredI | 0;
      let casterI = ev.fieldIdx != null ? (ev.fieldIdx | 0) : null;
      if (casterI == null && ev.casterFieldIdx != null) casterI = ev.casterFieldIdx | 0;
      const devourPatches = [];
      if (casterI != null) {
        devourPatches.push({
          targetP: ev.casterIdx,
          targetI: casterI,
          currentPower: ev.powerAfter ?? undefined,
        });
      }
      devourPatches.push({
        targetP: ev.casterIdx,
        targetI: preyI,
        removed: true,
      });
      for (const p of devourPatches) fieldPatches.push(p);
      deferBoardApply = true;
      const last = visuals[visuals.length - 1];
      if (last && last.kind === "devour") {
        last.fieldPatches = devourPatches;
        last.targetP = ev.casterIdx;
        last.targetI = preyI;
        last.casterFieldIdx = casterI;
        last.deferBoardApply = true;
      }
    }
    if (ev.type === "DESTROY" && (ev.p != null || ev.targetP != null)) {
      fieldPatches.push({
        targetP: ev.targetP ?? ev.p,
        targetI: ev.targetI ?? ev.i,
        removed: true,
      });
      deferBoardApply = true;
    }
    if (ev.type === "ON_DESTROY_BURST" && ev.ability === "legado") {
      for (const t of ev.applied || []) {
        if (t?.p == null) continue;
        if (t.currentPower != null) {
          fieldPatches.push({ targetP: t.p, targetI: t.i, currentPower: t.currentPower });
        }
        visuals.push({
          kind: "legado",
          ownerP: ev.ownerIdx,
          targetP: t.p,
          targetI: t.i,
          powerAfter: t.currentPower,
        });
      }
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
          // R-05 (parcial): o uid da fonte (o vingador destruído) — o
          // motor já emite ev.uid; o envelope o descartava e o cliente
          // animava a carta errada. O cliente lê sourceUid primeiro.
          sourceUid: ev.uid || null,
          targetP: t.p,
          targetI: t.i,
          powerAfter: t.currentPower,
          fieldPatches: t.removed
            ? [{ targetP: t.p, targetI: t.i, removed: true }]
            : [{ targetP: t.p, targetI: t.i, currentPower: t.currentPower }],
        });
        deferBoardApply = true;
      }
      // C-A07 (Lote F): a redução da VINGANÇA agora é pendente
      // (pendingReduction), não aplicada inline — `applied` vem
      // vazio e o visual nunca era emitido (regressão: o marcador
      // vinganca_fx sumiu — t_753 / t_907 VINGANÇA). Emite o visual
      // a partir do alvo pendente; a redução em si chega depois
      // (suspensão/resume) com seu próprio evento e patch.
      const pr = ev.pendingReduction;
      if ((ev.applied || []).length === 0 && pr && pr.targetP != null && pr.targetI != null) {
        visuals.push({
          kind: "vinganca",
          ownerP: ev.ownerIdx,
          sourceUid: ev.uid || null,
          targetP: pr.targetP,
          targetI: pr.targetI,
          fieldPatches: [],
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
        if (h.after != null && (h.after | 0) <= 0) {
          fieldPatches.push({ targetP: h.p, targetI: h.i, removed: true });
          deferBoardApply = true;
        } else if (h.after != null) {
          fieldPatches.push({ targetP: h.p, targetI: h.i, currentPower: h.after | 0 });
        } else if (h.before != null) {
          fieldPatches.push({
            targetP: h.p,
            targetI: h.i,
            currentPower: Math.max(0, (h.before | 0) - 1),
          });
        }
      }
    }
  }

  if (action?.anim?.kind) {
    visuals.push(action.anim);
    if (Array.isArray(action.anim.fieldPatches)) {
      for (const p of action.anim.fieldPatches) fieldPatches.push(p);
      if (action.anim.fieldPatches.some((p) => p?.removed || p?.insert)) {
        deferBoardApply = true;
      }
    }
    // Talentos MP: VFX no peer ANTES do auth (clone/medo/destrutivos).
    if (action.anim.kind === "doppel_clone" || action.anim.kind === "scare_return"
        || action.anim.kind === "misseis_magicos" || action.anim.kind === "devour"
        || action.anim.kind === "assassinar" || action.anim.kind === "transformar_bichinho"
        || action.anim.kind === "combat" || action.anim.kind === "destroy"
        || action.anim.kind === "bola_de_fogo" || action.anim.kind === "incendiar"
        || action.anim.kind === "explosao" || action.anim.kind === "poison_kill"
        || action.anim.kind === "vinganca" || action.anim.kind === "blocked_attack") {
      deferBoardApply = true;
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

  // S2-M10: quanto tempo o cliente leva para tocar este envelope — o maior
  // kind visual, ou a duração da Ultimate (a ação carrega o ultimateType).
  // Uma Ultimate sem visuals AINDA gera envelope (só com durationMs): a VFX
  // dela toca no cliente a partir da ação, e o gate da IA precisa da duração.
  const ultDur = (action?.type === "ULTIMATE_PLAY" || action?.type === "ULTIMATE_TARGET")
    ? (ULTIMATE_DURATION_MS[action?.ultimateType] ?? FALLBACK_VISUAL_MS)
    : 0;
  if (!visuals.length && !fieldPatches.length && !ultDur) return null;
  const visualsDur = visuals.reduce((m, v) => Math.max(m,
    VISUAL_DURATION_MS[v?.kind] ?? FALLBACK_VISUAL_MS), 0);
  return {
    visuals,
    fieldPatches,
    deferBoardApply,
    skipBoardApply: false,
    causeActionType: action?.type || meta.causeActionType || null,
    seed: meta.seed != null ? meta.seed : null,
    applyPolicy: deferBoardApply ? "after_vfx" : "with_vfx",
    durationMs: Math.max(visualsDur, ultDur),
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
 * C-B03: fog nos EVENTOS — o oponente nunca recebe a identidade de carta
 * comprada. O dono recebe o evento integral (a carta é dele). O formato
 * fog é o mesmo da mão projetada: { fog: true, category: "hidden" }.
 * type/playerId/reason/burned são preservados (o cliente conta os saques
 * por assento). viewerSeat -1 (replay público, sem espectador definido)
 * esconde TODOS os DRAWs com carta.
 */
export function projectEventsForSeat(events, viewerSeat) {
  if (!Array.isArray(events)) return events;
  return events.map((ev) => {
    if (!ev || ev.type !== "DRAW" || ev.playerId === viewerSeat) return ev;
    if (!ev.card) return ev; // upkeep DRAW já não traz carta
    return { ...ev, card: { fog: true, category: "hidden" } };
  });
}

/**
 * Aplica ação no estado da sala (fonte da verdade no servidor).
 */
export function applyAuthoritativeAction(room, seat, action, snapshot = null, opts = {}) {
  if (!action?.type) return { ok: false, error: "BAD_ACTION" };

  if (!room.eventLog) room.eventLog = [];

  if (UI_ONLY_TYPES.has(action.type)) {
    // QUERY UI-only: só repasse (a suspensão server-side vive em
    // room.mpPendingReactive — df-reactive-suspend.mjs). Sem janelas.
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

  const { DfEngine, DfRules, DfData, DfEffects } = getEngine();
  const shaped = { ...action, playerId: seat };

  // C-A05/C-A06/C-A07/C-A08 (Lote F): suspensão reativa. Uma ANSWER com
  // qid diferente do pendente atual é descartada (resposta fora do
  // prazo — o pendente já expirou ou outra pergunta está aberta).
  if (shaped.type.startsWith("REACTIVE_") && shaped.type.endsWith("_ANSWER")
      && room.mpPendingReactive && shaped.qid != null
      && shaped.qid !== room.mpPendingReactive.qid) {
    return { ok: false, error: "REACTIVE_EXPIRED" };
  }
  // Enquanto há pergunta aberta, nenhuma outra ação autoritativa entra
  // (o estado sob a ação suspensa não pode mudar — o actionSeq é a
  // guarda da retomada). Exceções: a própria ANSWER e o SURRENDER.
  if (room.mpPendingReactive && AUTHORITATIVE_TYPES.has(shaped.type)
      && !shaped.type.endsWith("_ANSWER") && shaped.type !== "SURRENDER") {
    return { ok: false, error: "REACTIVE_PENDING" };
  }

  // SYNC: cosmético — nunca merge de snapshot de tabuleiro.
  if (shaped.type === "SYNC_STATE") {
    return applySyncStateCosmetic(room, seat, shaped);
  }

  // C-A05 (Lote F): SEM lockout. O cancelamento da Ultimate gasta o uso
  // (spendUltimateCancelled, motor) em vez de barrar as próximas 120 s.
  // A suspensão vive em room.mpPendingReactive (§0.2 da proposta 01);
  // ULTIMATE_PLAY / ULTIMATE_TARGET nunca mais são rejeitados por terem
  // sido cancelados. Os códigos ULTIMATE_CANCELLED / ULTIMATE_CANCEL_PENDING
  // foram removidos do protocolo (não reutilizar — um cliente velho os
  // interpretaria como lockout).

  // Proteção Divina: barrar FIELD_COMMIT reducePower no alvo protegido.
  if (shaped.type === "FIELD_COMMIT" && room.mpProtectedTarget) {
    const prot = room.mpProtectedTarget;
    if (prot.until > Date.now() && Array.isArray(shaped.mutations)) {
      const hitsProt = shaped.mutations.some((m) => {
        if (!m || m.op !== "reducePower") return false;
        if (m.targetP !== prot.targetP || m.targetI !== prot.targetI) return false;
        if (prot.uid && m.uid && String(m.uid) !== String(prot.uid)) return false;
        return true;
      });
      if (hitsProt) {
        return { ok: false, error: "TARGET_PROTECTED" };
      }
    }
  }

  const v = DfEngine.validateAction(state, shaped);
  if (v.ok === false && v.code && v.code !== "DELEGATE") {
    // C-N4 (rodada 3): a REUTILIZAÇÃO com instantânea inválida GASTA o uso
    // (fizzle) — o fizzle mora em applyUltimatePlay e esta pré-validação
    // barraria antes (a rodada 2 o pôs no motor, mas a autoridade nunca o
    // alcançava). Delega o INVALID_TARGET do reuseInstant com alvo próprio
    // existente para o motor (espelho do applyAction, df-engine.js:375-385).
    // As demais Ultimates continuam rejeitadas aqui (uso preservado).
    // C-N4 (rodada 4, t_961): a delegação da rodada 3 tinha DOIS buracos
    // e nunca disparava no caminho real do jogador — (a) só casava
    // ULTIMATE_PLAY, mas o cliente envia ULTIMATE_TARGET para ultimates
    // com mira (online_battle.gd:2874); (b) lia `shaped.ultimateType`,
    // mas o cliente NUNCA envia ultimateType (só heroId/targetP/targetI
    // — online_battle.gd:2874/2926, online_actions.gd:999/1003). O tipo
    // é derivado do heroId (mesmo padrão do bloco de suspensão abaixo).
    const pid0 = shaped.playerId ?? state.currentPlayer;
    const heroId0 = shaped.heroId || state.players[pid0]?.heroId;
    const heroDef0 = (DfData?.heroDefs || []).find((h) => h && h.id === heroId0);
    const ut0 = shaped.ultimateType || heroDef0?.ultimateType;
    const isReuseFizzle = (shaped.type === "ULTIMATE_PLAY" || shaped.type === "ULTIMATE_TARGET")
      && v.code === "INVALID_TARGET"
      && ut0 === "reuseInstant"
      && shaped.targetP === pid0
      && state.players[pid0]?.field?.[shaped.targetI];
    if (!isReuseFizzle) {
      return { ok: false, error: v.code || v.error || "ILLEGAL" };
    }
  }

  // C-A05/C-A06 (Lote F): a Ultimate resolve SOB SUSPENSÃO — o defensor
  // é perguntado ANTES do efeito (e o uso só é gasto na retomada).
  // O cliente novo marca a ação com `reactiveServerDriven: true` e NÃO
  // pergunta antes de enviar; sem a marca (cliente velho, que já
  // perguntou), aplica direto. A IA do servidor é sempre server-driven
  // (opts.serverAi — C-A08). A emissão da QUERY e o timer vivem em
  // index.mjs / df-reactive-suspend.mjs (a autoridade só decide).
  // opts.resume: retomada de uma suspensão — nunca re-suspender.
  // C-A05: CANCELAR ULTIMATE primeiro. C-A06: sem CANCELAR, a PROTEÇÃO
  // DIVINA é perguntada DIRETO (só BOMBA/VAMPIRISMO — targetEnemy/
  // vampirism; COMETA/FOGO E GELO/INCINERAR fora do escopo, D-2) — no
  // offline as duas perguntas são independentes.
  if ((shaped.type === "ULTIMATE_PLAY" || shaped.type === "ULTIMATE_TARGET")
      && (shaped.reactiveServerDriven === true || opts?.serverAi === true)
      && !room.mpPendingReactive && !opts?.resume) {
    const defSeat = 1 - seat;
    const canAsk = DfRules?.canOfferCancelUltimate?.(state, defSeat, seat);
    if (canAsk?.ok) {
      // NÃO aplicar ainda: guardar a ação inteira e devolver "suspenso".
      return {
        ok: true, suspended: true, suspendKind: "cancelUltimate",
        deferredAction: shaped, defenderSeat: defSeat, askerSeat: seat,
        committed: false,
        state, events: [],
      };
    }
    const heroId = shaped.heroId || state.players?.[seat]?.heroId;
    const heroDef = (DfData?.heroDefs || []).find((h) => h && h.id === heroId);
    const ut = shaped.ultimateType || heroDef?.ultimateType;
    if ((ut === "targetEnemy" || ut === "vampirism")
        && DfRules?.canOfferReactiveProtection?.(state, defSeat, seat)?.ok) {
      return {
        ok: true, suspended: true, suspendKind: "protecaoDivina",
        deferredAction: shaped, defenderSeat: defSeat, askerSeat: seat,
        committed: false,
        state, events: [],
      };
    }
    // Sem CANCELAR nem PROTEÇÃO na mão do defensor: aplica direto (o
    // offline nem pergunta — _try_cancel_ultimate retorna false sem a carta).
  }

  // U-B07 / E-N1 Opção 1 (rodada 5): a PROTEÇÃO DIVINA das 7 fontes que
  // reduzem Poder (BOLA/ASSASSINAR/TRANSFORMAR/INCENDIAR como habilidade;
  // BOLA/EXPLOSÃO/TRANSFORMAR como talento) é perguntada DURANTE a
  // animação — igual ao offline. O cliente novo marca a ação com
  // `reactiveServerDriven: true` e NÃO pré-pergunta; a IA do servidor é
  // sempre server-driven (opts.serverAi — C-A08). Sem a marca (cliente
  // velho, que já perguntou), aplica direto. A suspensão é NÃO cometida:
  // nada muda no estado até a resposta; o visual viaja com a suspensão
  // (ack do ator + query do defensor, via suspendSpec) e a retomada NÃO o
  // re-emite (o resume não tem envelope). opts.resume: nunca re-suspender.
  // Ordem EXAUSTÃO → PROTEÇÃO preservada: o cliente pergunta a EXAUSTÃO
  // antes de enviar (humano); a IA suspende a EXAUSTÃO primeiro em
  // maybeSuspendAiAction e encadeia a PROTEÇÃO na resposta NÃO.
  if ((shaped.type === "ABILITY_TARGET" || shaped.type === "TALENT_TARGET")
      && (shaped.reactiveServerDriven === true || opts?.serverAi === true)
      && !room.mpPendingReactive && !opts?.resume) {
    const defSeat = 1 - seat;
    const abilityKey = shaped.type === "ABILITY_TARGET"
      ? (shaped.abilityKey || state.players?.[seat]?.field?.[shaped.fieldIdx]?.onEnter || "")
      : "";
    const talentEffect = shaped.type === "TALENT_TARGET"
      ? (shaped.talentEffect || state.activeTalent?.card?.talentEffect || "")
      : "";
    const isProtecaoTarget =
      (shaped.type === "ABILITY_TARGET" && ["bolaDeFogo", "assassinar", "transformarBichinho", "incendiar"].includes(abilityKey))
      || (shaped.type === "TALENT_TARGET" && ["bolaDeFogoTalento", "explosao", "transformarBichinhoTalento"].includes(talentEffect));
    if (isProtecaoTarget && DfRules?.canOfferReactiveProtection?.(state, defSeat, seat)?.ok) {
      const presentationEnvelope = buildProtecaoVisualEnvelope(shaped, state, seat);
      return {
        ok: true, suspended: true, suspendKind: "protecaoDivina",
        deferredAction: shaped, defenderSeat: defSeat, askerSeat: seat,
        committed: false,
        state, events: [],
        presentationEnvelope: presentationEnvelope || undefined,
        presentation: presentationEnvelope?.visuals,
        suspendSpec: {
          kind: "protecaoDivina",
          deferredAction: shaped, defenderSeat: defSeat, askerSeat: seat,
          presentationEnvelope: presentationEnvelope || undefined,
        },
      };
    }
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
  // DF_FORCE_SNAPSHOT_FALLBACK=1: ignora motor e exige snapshot (escape Fase 2).
  if (DELEGATED_TYPES.has(shaped.type)) {
    if (FORCE_SNAPSHOT_FALLBACK && shaped.type !== "SYNC_STATE") {
      if (!snapshot) {
        return { ok: false, error: "SNAPSHOT_REQUIRED" };
      }
      return mergeValidatedSnapshot(room, seat, shaped, snapshot);
    }
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

  // SUMMON/ULTIMATE: resolve on-enter auto (tokens Wyvern/Cubo, rapidez…)
  // no servidor. ULTIMATE_* entra aqui por C-A04 (REUTILIZAÇÃO re-dispara
  // a instantânea "auto" no mesmo ack; "target" fica pendente p/ o cliente).
  // opts.noOnEnterAuto (C-A08 EXAUSTÃO): o campeão entra SEM a
  // instantânea — SUMMON pelo applyAction puro.
  const applyFn = typeof DfEngine.applyActionWithOnEnter === "function"
    && (shaped.type === "ON_ENTER_RESOLVE"
      || shaped.type === "ULTIMATE_PLAY" || shaped.type === "ULTIMATE_TARGET"
      || (shaped.type === "SUMMON" && !opts?.noOnEnterAuto))
    ? DfEngine.applyActionWithOnEnter
    : DfEngine.applyAction;
  const applied = applyFn(DfEngine.cloneState(state), shaped, {
    rng: roomActionRng(room, seat),
  });
  if (!applied.ok) {
    return { ok: false, error: applied.error || "APPLY_FAILED" };
  }

  room.gameState = applied.state;

  // Proteção Divina: alvo protegido contra próximo reducePower.
  // (Fluxo antigo — cliente pergunta antes; mantido. D-3: o FIELD_COMMIT
  // continua barrado; a suspensão mid-resolution (C-A07) não o substitui
  // para BOLA/EXPLOSÃO/ASSASSINAR, que são redução única por resolução.)
  if (shaped.type === "REACTIVE_PROTECTION_ANSWER"
      && (shaped.protected === true || shaped.use === true)) {
    const targetP = shaped.defenderPlayerId ?? shaped.targetP;
    let targetI = shaped.defenderIdx ?? shaped.targetI;
    const uid = shaped.defenderUid || null;
    if ((targetI == null || targetI < 0) && uid != null) {
      const field = state.players?.[targetP | 0]?.field || [];
      targetI = field.findIndex((c) => c && String(c.uid) === String(uid));
    }
    if (targetP != null && targetI != null && targetI >= 0) {
      room.mpProtectedTarget = {
        targetP: targetP | 0,
        targetI: targetI | 0,
        uid: uid || state.players?.[targetP | 0]?.field?.[targetI | 0]?.uid || null,
        until: Date.now() + 30000,
      };
    }
  }

  // C-A07 (Lote F): o motor suspendeu reduções (RAIO/CHUVA via
  // `applied.suspended`, VINGANÇA via `pendingReduction` nos eventos —
  // ON_DESTROY_BURST, ou POISON_KILL/BURN_KILL dos ticks de manutenção).
  // A fila é: reduções do resolver primeiro, depois os bursts na ordem
  // dos eventos (VINGANÇA em cadeia vai para o fim da fila).
  const motorReductions = Array.isArray(applied.suspended?.reductions)
    ? applied.suspended.reductions.filter(Boolean) : [];
  const burstReductions = [];
  for (const e of (applied.events || [])) {
    if (!e || typeof e !== "object") continue;
    const pr = e.pendingReduction || e.burst?.pendingReduction;
    // O asker do burst é o DONO do campeão destruído (ev.ownerIdx) —
    // não o assento da ação. Sem isso, canOfferReactiveProtection vê
    // defOwner === attOwner (SAME_PLAYER) e a PROTEÇÃO nunca é
    // oferecida para VINGANÇA (t_902). Reduções do motor usam o
    // askerSeat do pendente (o caster = assento da ação).
    if (pr) burstReductions.push({ ...pr, askerSeat: e.ownerIdx ?? seat });
  }

  // C-A07 inline (Lote F, t_753/t_907): quando a fila tem SÓ bursts
  // (VINGANÇA — sem finisher do motor) e NENHUM é perguntável (o
  // defensor não tem PROTEÇÃO DIVINA na mão), não há pergunta a
  // fazer — aplicar inline, sem suspensão e sem resume. Antes, o
  // resume imediato difundia o estado sem a FURIOSA ANTES do ack do
  // ataque, e o cliente apagava a vista do vingador antes do visual
  // `vinganca` tocar — o marcador nunca aparecia (t_753/t_907).
  // Reduções do motor (RAIO/CHUVA, com finisher) seguem sempre pela
  // suspensão (comportamento anterior, sem mudança).
  let curState = applied.state;
  let extraEvents = [];
  let remaining = null;
  if (burstReductions.length && !motorReductions.length) {
    const queue = [...burstReductions];
    while (queue.length) {
      const r = queue[0];
      const offer = DfRules?.canOfferReactiveProtection?.(curState, r.targetP, r.askerSeat ?? seat);
      if (offer?.ok) break; // perguntável -> suspende com o restante
      const res = DfEffects?.applyPlannedReduction?.(curState, r, { skip: false });
      if (!res?.ok) break; // não aplicou -> suspende (não perde a redução)
      queue.shift();
      curState = res.state;
      extraEvents.push(...(res.events || []));
      if (res.newPendingReduction) queue.push({ ...res.newPendingReduction, askerSeat: r.targetP });
    }
    if (queue.length) remaining = queue;
  }
  // O estado intermediário JÁ foi cometido acima (room.gameState =
  // applied.state); o inline muta o mesmo objeto, mas comete de novo
  // explicitamente (se applyPlannedReduction um dia clonar, não some).
  room.gameState = curState;
  const allEvents = [...(applied.events || []), ...extraEvents];

  const entry = appendEventLogEntry(
    room.eventLog,
    room.actionSeq + 1,
    seat,
    shaped,
    allEvents,
  );

  const presentationEnvelope = buildPresentationEnvelope(allEvents, shaped, {
    causeActionType: shaped.type,
    seed: ((room.actionSeq + 1) * 2654435761 + seat * 40503 + (room.deckSeed || 0)) >>> 0,
  });
  const presentation = presentationEnvelope?.visuals?.length
    ? presentationEnvelope.visuals
    : allEvents
      .filter((e) => e && e.visual)
      .map((e) => ({ kind: e.visual, ...e }));

  const allReductions = [...motorReductions, ...burstReductions];
  if (remaining || motorReductions.length) {
    // Suspensão: `remaining` (bursts restantes, sem finisher) ou a fila
    // completa (motor presente — comportamento anterior, sem mudança).
    // `remaining` nulo + só bursts = tudo aplicado inline -> NÃO suspende.
    // O estado intermediário JÁ foi cometido acima (room.gameState); a
    // orquestração (pergunta, timer, retomada) vive em index.mjs /
    // df-reactive-suspend.mjs.
    const specReductions = remaining || allReductions;
    return {
      ok: true, suspended: true, suspendKind: "reductions",
      suspendSpec: {
        kind: "reductions",
        reductions: specReductions,
        finish: applied.suspended?.finish || null,
        askerSeat: seat,
        deferredAction: null,
        originAction: shaped,
      },
      committed: true,
      state: curState,
      events: allEvents,
      logEntry: entry,
      presentation: presentation?.length ? presentation : undefined,
      presentationEnvelope: presentationEnvelope || undefined,
    };
  }

  return {
    ok: true,
    state: curState,
    events: allEvents,
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
    turnDeadline: room.turnDeadline || null,
    serverNow: Date.now(),
    // (F7, t_1020) o rejoin precisa saber se o oponente segue sob a IA:
    // o broadcast peer_ai_control foi perdido enquanto o cliente estava
    // fora, e o cliente restaura o indicador a partir daqui.
    aiControlled: Array.isArray(room.aiControlled) ? [...room.aiControlled] : [false, false],
    reconnected: true,
  };
}

/**
 * (§14.6) Payload final para o rejoin de uma sala encerrada: o replay
 * normal devolve null quando a sala não está jogando, mas o jogador que
 * volta depois do fim precisa do estado final — senão a batalha fica
 * travada (o cliente não tem o que aplicar). Só o estado final, com a
 * mão do oponente embaçada (espelho de roomPublicView — sem importar
 * rooms.mjs aqui). Usado SÓ no `join_room`; o `get_replay` mantém
 * NOT_PLAYING para salas encerradas.
 */
export function buildFinalReplayPayload(room, yourSeat = null) {
  if (!room || room.status !== "ended") return null;
  if (!room.gameState?.players?.length) return null;
  let gameState = null;
  try {
    gameState = JSON.parse(JSON.stringify(room.gameState));
    if (yourSeat === 0 || yourSeat === 1) {
      for (let i = 0; i < (gameState.players || []).length; i++) {
        if (i === yourSeat) continue;
        const pl = gameState.players[i];
        if (!pl?.hand) continue;
        const n = pl.hand.length;
        pl.hand = Array.from({ length: n }, () => ({ fog: true, category: "hidden" }));
        if (Array.isArray(pl.deck)) {
          pl.deckCount = pl.deck.length;
          pl.deck = [];
        }
      }
    }
  } catch (e2) { /* keep raw */ }
  return {
    seq: room.actionSeq,
    entries: [],
    snapshot: null,
    gameState,
    heroIds: room.heroes || [null, null],
    arenaScenarioId: room.arenaScenarioId || null,
    deckSeed: room.deckSeed != null ? room.deckSeed : null,
    turnDeadline: null,
    serverNow: Date.now(),
    aiControlled: [false, false],
    reconnected: true,
    final: true,
  };
}
