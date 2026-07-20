/**
 * Validação de snapshots delegados (anti-trapaça — habilidades, menus, sync).
 * Ultimates autoritativos no motor; não passam por merge de snapshot.
 */

export function unwrapGameState(snapshot) {
  if (!snapshot) return null;
  if (snapshot.players?.length) return snapshot;
  if (snapshot.state?.players?.length) return snapshot.state;
  return null;
}

const SNAPSHOT_MERGE_TYPES = new Set([
  "SYNC_STATE",
  "ULTIMATE_TARGET",
  "TALENT_TARGET",
  "ABILITY_TARGET",
  "ABILITY_START",
  "MENU_CHOICE",
  "NECROMANCIA_PICK",
  "UNFREEZE_CONFIRM",
]);

export function isSnapshotMergeType(type) {
  return SNAPSHOT_MERGE_TYPES.has(type);
}

function countField(state) {
  let n = 0;
  for (const pl of state?.players || []) n += pl?.field?.length ?? 0;
  return n;
}

function totalHandCards(state) {
  let n = 0;
  for (const pl of state?.players || []) n += pl?.hand?.length ?? 0;
  return n;
}

function vpTotal(state) {
  return (state?.players || []).reduce((s, pl) => s + (pl?.vp ?? 0), 0);
}

/** Validações comuns a qualquer merge delegado. */
function validateCommonBounds(prev, next, seat, actionType) {
  if (!next?.players?.length) return { ok: false, error: "EMPTY_SNAPSHOT" };
  if (next.playersCount != null && next.playersCount !== 2) {
    return { ok: false, error: "BAD_PLAYERS_COUNT" };
  }

  for (let p = 0; p < next.players.length; p++) {
    const pl = next.players[p];
    if ((pl.hand?.length ?? 0) > 8) return { ok: false, error: "HAND_OVERFLOW" };
    if ((pl.field?.length ?? 0) > 6) return { ok: false, error: "FIELD_OVERFLOW" };
    if (pl.actions != null && (pl.actions < 0 || pl.actions > 3)) return { ok: false, error: "BAD_ACTIONS" };
    if (pl.vp != null && (pl.vp < 0 || pl.vp > 20)) return { ok: false, error: "BAD_VP" };
  }

  if (prev?.players?.length) {
    const vpDelta = vpTotal(next) - vpTotal(prev);
    if (vpDelta > 2) return { ok: false, error: "VP_SPIKE" };
    if (vpDelta < 0) return { ok: false, error: "VP_DROP" };

    const fieldDelta = countField(next) - countField(prev);
    if (fieldDelta > 2) return { ok: false, error: "FIELD_SPIKE" };
    if (fieldDelta < -4) return { ok: false, error: "FIELD_DROP" };

    const handDelta = totalHandCards(next) - totalHandCards(prev);
    if (handDelta > 3) return { ok: false, error: "HAND_SPIKE" };

    if (prev.currentPlayer != null && prev.currentPlayer !== seat && actionType !== "SYNC_STATE") {
      return { ok: false, error: "NOT_YOUR_TURN" };
    }

    if (
      actionType !== "SYNC_STATE"
      && next.currentPlayer != null
      && prev.currentPlayer != null
      && next.currentPlayer !== prev.currentPlayer
    ) {
      return { ok: false, error: "TURN_CHANGED" };
    }

    const prevPl = prev.players[seat];
    const nextPl = next.players[seat];
    if (prevPl && nextPl && actionType !== "SYNC_STATE") {
      const actDrop = (prevPl.actions ?? 0) - (nextPl.actions ?? 0);
      if (actDrop > 2) return { ok: false, error: "ACTIONS_SPIKE" };
      if (actDrop < -1) return { ok: false, error: "ACTIONS_REFUND" };
    }
  }

  return { ok: true };
}

/** Regras extras por tipo delegado (habilidades / menus). */
function validateActionSpecific(prev, next, seat, actionType, action) {
  if (actionType === "MENU_CHOICE") {
    if (prev?.currentPlayer != null && prev.currentPlayer !== seat) {
      return { ok: false, error: "MENU_NOT_YOUR_TURN" };
    }
  }

  if (actionType === "ABILITY_TARGET" || actionType === "TALENT_TARGET") {
    if (prev?.currentPlayer != null && prev.currentPlayer !== seat) {
      return { ok: false, error: "TARGET_NOT_YOUR_TURN" };
    }
    const tp = action?.targetP;
    const ti = action?.targetI;
    if (tp != null && ti != null) {
      const tgt = next?.players?.[tp]?.field?.[ti];
      if (!tgt && actionType === "ABILITY_TARGET") {
        return { ok: false, error: "INVALID_ABILITY_TARGET" };
      }
    }
  }

  if (actionType === "NECROMANCIA_PICK") {
    if (prev?.currentPlayer != null && prev.currentPlayer !== seat) {
      return { ok: false, error: "NECRO_NOT_YOUR_TURN" };
    }
    const disc = prev?.players?.[seat]?.discard;
    if (disc && action?.cardName) {
      const has = disc.some((c) => c?.name === action.cardName);
      if (!has) return { ok: false, error: "NECRO_BAD_CARD" };
    }
  }

  if (actionType === "UNFREEZE_CONFIRM") {
    if (prev?.currentPlayer != null && prev.currentPlayer !== seat) {
      return { ok: false, error: "UNFREEZE_NOT_YOUR_TURN" };
    }
  }

  if (actionType === "SYNC_STATE") {
    const prevUlt = prev?.players?.[seat]?.usedUltimateThisTurn;
    const nextUlt = next?.players?.[seat]?.usedUltimateThisTurn;
    if (nextUlt && !prevUlt) {
      return { ok: false, error: "ULTIMATE_VIA_SYNC" };
    }
  }

  return { ok: true };
}

export function validateSnapshotUpdate(prev, next, seat, actionType, action = null) {
  const common = validateCommonBounds(prev, next, seat, actionType);
  if (!common.ok) return common;
  return validateActionSpecific(prev, next, seat, actionType, action);
}
