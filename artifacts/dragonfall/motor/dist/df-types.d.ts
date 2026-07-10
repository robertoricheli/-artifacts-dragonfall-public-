/** Tipos compartilhados do motor Dragonfall (protocolo + event log + regras). */
export type PlayerId = 0 | 1 | 2 | 3;
export type ActionType = "LOBBY_CREATE" | "LOBBY_JOIN" | "SETUP_HERO" | "SETUP_WIN_POINTS" | "MATCH_START" | "END_TURN" | "DRAW_CARD" | "SURRENDER" | "RESTART_MATCH" | "SUMMON" | "ATTACK_START" | "ATTACK_PICK_ATTACKER" | "ATTACK_PICK_DEFENDER" | "ATTACK_RESOLVE" | "REACTIVE_BLOCK_QUERY" | "REACTIVE_BLOCK_ANSWER" | "REACTIVE_PROTECTION_QUERY" | "REACTIVE_PROTECTION_ANSWER" | "ON_ENTER_RESOLVE" | "TALENT_START" | "TALENT_TARGET" | "ABILITY_START" | "ABILITY_TARGET" | "ULTIMATE_START" | "ULTIMATE_TARGET" | "MENU_CHOICE" | "NECROMANCIA_PICK" | "UNFREEZE_CONFIRM" | "OPEN_DISCARD" | "SYNC_STATE" | "ULTIMATE_PLAY" | "PLAY_VISUAL";
export interface GameAction {
    type: ActionType | string;
    playerId?: PlayerId;
    handIdx?: number;
    insertIdx?: number;
    uid?: string;
    freeAction?: boolean;
    attackerIdx?: number;
    defenderPlayerId?: PlayerId;
    defenderIdx?: number;
    attOwner?: PlayerId;
    casterIdx?: number;
    fieldIdx?: number;
    resolution?: Record<string, unknown>;
    use?: boolean;
    [key: string]: unknown;
}
export type GameEventType = "DRAW" | "SUMMON" | "ON_ENTER_PENDING" | "ON_ENTER_RESOLVED" | "COMBAT" | "DESTROY" | "VP_GAIN" | "POISON_KILL" | "TURN_START" | "GAME_OVER" | "REACTIVE_USED" | "TALENT_STARTED" | "SURRENDER";
export interface GameEvent {
    type: GameEventType | string;
    playerId?: PlayerId;
    [key: string]: unknown;
}
export interface EventLogEntry {
    seq: number;
    seat: PlayerId;
    action: GameAction;
    events: GameEvent[];
    t: number;
}
export interface AuthoritativeResult {
    ok: boolean;
    error?: string;
    skip?: boolean;
    state?: GameState;
    events?: GameEvent[];
    logEntry?: EventLogEntry;
}
export interface LimitsConfig {
    MAX_ACTIONS: number;
    MAX_FIELD: number;
    MAX_HAND: number;
    PASSIVE_VP_PER_TURN_CAP: number;
    INVOKE_DRAGON_MAX_FIELD: number;
}
export interface HeroDef {
    id: string;
    name: string;
    emoji?: string;
    image?: string;
    ultimateName?: string;
    ultimateDesc?: string;
    ultimateType?: string;
    [key: string]: unknown;
}
export interface CardDef {
    name: string;
    power?: number;
    category?: string;
    hidden?: boolean;
    onEnter?: string | null;
    onDestroy?: string | null;
    talentEffect?: string;
    abilityName?: string;
    abilityType?: string;
    abilityDesc?: string;
    [key: string]: unknown;
}
export interface ChampionCard extends CardDef {
    uid?: string;
    currentPower?: number;
    basePower?: number;
    tapped?: boolean;
    frozen?: boolean;
    frozenTurns?: number;
    shielded?: boolean;
    shieldedTurns?: number;
    silenced?: boolean;
    poisoned?: boolean;
    poisonTurns?: number;
    [key: string]: unknown;
}
export interface PlayerState {
    name?: string;
    vp: number;
    actions: number;
    hand: ChampionCard[];
    field: ChampionCard[];
    deck: ChampionCard[];
    discard: ChampionCard[];
    isAI?: boolean;
    skipDraw?: boolean;
    skipNextAction?: boolean;
    onEnterUsedThisTurn?: string[];
    heroId?: string;
    [key: string]: unknown;
}
export interface GameState {
    started?: boolean;
    winner?: number | null;
    currentPlayer?: number;
    playersCount?: number;
    turnNumber?: number;
    winPoints?: number;
    players: PlayerState[];
    activeTalent?: Record<string, unknown> | null;
    [key: string]: unknown;
}
export interface LegalCheck {
    ok: boolean;
    code?: string;
    error?: string;
    ritual?: boolean;
    actionCost?: number;
    handIdx?: number;
}
export interface ApplyResult {
    ok: boolean;
    state: GameState;
    events: GameEvent[];
    error?: string;
}
export interface EffectApplyResult {
    ok: boolean;
    state: GameState;
    events: GameEvent[];
    error?: string;
    blocked?: boolean;
    protected?: boolean;
    cancelled?: boolean;
    card?: ChampionCard;
}
export interface OnEnterPlan {
    ok: boolean;
    mode: string;
    targetKind?: string;
    ability?: string;
    code?: string;
    events?: GameEvent[];
}
