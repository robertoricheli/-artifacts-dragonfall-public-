export const ACTION_TYPES = Object.freeze({
    LOBBY_CREATE: "LOBBY_CREATE",
    LOBBY_JOIN: "LOBBY_JOIN",
    SETUP_HERO: "SETUP_HERO",
    SETUP_WIN_POINTS: "SETUP_WIN_POINTS",
    MATCH_START: "MATCH_START",
    END_TURN: "END_TURN",
    DRAW_CARD: "DRAW_CARD",
    SURRENDER: "SURRENDER",
    RESTART_MATCH: "RESTART_MATCH",
    SUMMON: "SUMMON",
    ATTACK_START: "ATTACK_START",
    ATTACK_PICK_ATTACKER: "ATTACK_PICK_ATTACKER",
    ATTACK_PICK_DEFENDER: "ATTACK_PICK_DEFENDER",
    ATTACK_RESOLVE: "ATTACK_RESOLVE",
    REACTIVE_BLOCK_QUERY: "REACTIVE_BLOCK_QUERY",
    REACTIVE_BLOCK_ANSWER: "REACTIVE_BLOCK_ANSWER",
    REACTIVE_PROTECTION_QUERY: "REACTIVE_PROTECTION_QUERY",
    REACTIVE_PROTECTION_ANSWER: "REACTIVE_PROTECTION_ANSWER",
    ON_ENTER_RESOLVE: "ON_ENTER_RESOLVE",
    TALENT_START: "TALENT_START",
    TALENT_TARGET: "TALENT_TARGET",
    ABILITY_START: "ABILITY_START",
    ABILITY_TARGET: "ABILITY_TARGET",
    ULTIMATE_START: "ULTIMATE_START",
    ULTIMATE_TARGET: "ULTIMATE_TARGET",
    MENU_CHOICE: "MENU_CHOICE",
    NECROMANCIA_PICK: "NECROMANCIA_PICK",
    UNFREEZE_CONFIRM: "UNFREEZE_CONFIRM",
    OPEN_DISCARD: "OPEN_DISCARD",
    SYNC_STATE: "SYNC_STATE",
    ULTIMATE_PLAY: "ULTIMATE_PLAY",
    PLAY_VISUAL: "PLAY_VISUAL",
});
export const GAME_PHASES = Object.freeze([
    "normal",
    "select-attacker",
    "select-defender",
    "target-champion",
    "target-ally",
    "ultimate-target",
    "reactive-block",
    "menu",
    "necromancia",
    "summon-placement",
    "detail",
    "discard",
]);
export const REQUIRES_NORMAL_PHASE = new Set([
    ACTION_TYPES.SUMMON,
    ACTION_TYPES.ATTACK_START,
    ACTION_TYPES.ATTACK_RESOLVE,
    ACTION_TYPES.TALENT_START,
    ACTION_TYPES.ABILITY_START,
    ACTION_TYPES.ULTIMATE_START,
    ACTION_TYPES.DRAW_CARD,
    ACTION_TYPES.END_TURN,
]);
export function validateActionShape(action) {
    if (!action || typeof action !== "object") {
        return { ok: false, error: "INVALID_ACTION" };
    }
    const a = action;
    if (!a.type || typeof a.type !== "string") {
        return { ok: false, error: "MISSING_TYPE" };
    }
    if (!Object.values(ACTION_TYPES).includes(a.type)) {
        return { ok: false, error: "UNKNOWN_TYPE" };
    }
    if (a.playerId !== undefined && a.playerId !== 0 && a.playerId !== 1) {
        return { ok: false, error: "INVALID_PLAYER_ID" };
    }
    return { ok: true, action: a };
}
export function createAction(type, fields = {}) {
    return { type, ...fields };
}
export const DfProtocol = Object.freeze({
    VERSION: 2,
    ACTION_TYPES,
    GAME_PHASES,
    REQUIRES_NORMAL_PHASE,
    validateActionShape,
    createAction,
});
