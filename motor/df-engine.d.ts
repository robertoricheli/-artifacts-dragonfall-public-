/**
 * Dragonfall — motor de ações puro (fonte TS).
 */
import type { GameAction, GameEvent, GameState, ApplyResult } from "./df-types.js";
import { DfProtocol } from "./df-protocol.js";
export type { GameState, ApplyResult };
export interface RulesApi {
    canEndTurn(state: GameState, pid: number): {
        ok: boolean;
        code?: string;
    };
    canBuyCard(state: GameState, pid: number, limits?: unknown): {
        ok: boolean;
        code?: string;
    };
    canSummon(state: GameState, pid: number, handIdx: number, ctx: Record<string, unknown>): {
        ok: boolean;
        code?: string;
        ritual?: boolean;
    };
    canAttack(state: GameState, pid: number, attIdx: number, defP: number, defIdx: number, ctx?: EngineContext): {
        ok: boolean;
        code?: string;
        actionCost?: number;
    };
    canOfferReactiveBlock(state: GameState, pid: number, attOwner: number): {
        ok: boolean;
        code?: string;
    };
    canOfferReactiveProtection(state: GameState, pid: number, attOwner: number): {
        ok: boolean;
        code?: string;
    };
    canResolveOnEnter(state: GameState, casterIdx: number, fieldIdx: number, ctx?: EngineContext): {
        ok: boolean;
        code?: string;
    };
    summonContextForPlayer(state: GameState, pid: number): Record<string, unknown>;
    defaultSummonInsertIndex(fieldLen: number): number;
    championSummonCost(card: Record<string, unknown>): number;
    combatOutcome(att: Record<string, unknown>, def: Record<string, unknown>): Record<string, unknown>;
    combatVictoryPointReward(champ: Record<string, unknown>): number;
    hasNoHonor(champ: Record<string, unknown>): boolean;
    applyOnDestroyBurst(state: GameState, ownerIdx: number, champ: Record<string, unknown>, reason: string, rng?: () => number): {
        ability?: string | null;
        targets?: Record<string, unknown>[];
        applied?: Record<string, unknown>[];
    };
    getAttackActionCost(att: Record<string, unknown>, def: Record<string, unknown>): number;
    applyMaintenanceCounters(state: GameState, pid: number): void;
    computeMaintenancePlan(state: GameState, pid: number): {
        passiveVpGain: number;
        poisonKills: Record<string, unknown>[];
    };
    applyTurnRefresh(state: GameState, pid: number): void;
    findWinnerIndex(state: GameState): number | null;
    runTurnMaintenance(state: GameState, pIdx: number, limits?: unknown): {
        poisonDestroyed: Record<string, unknown>[];
        passiveVpGain: number;
        poisonVpGain: number;
        returned: Record<string, unknown>[];
        skipDraw: boolean;
    };
    gatherEnemyTargets(state: GameState, casterIdx: number, filterFn?: (c: Record<string, unknown>) => boolean): Array<{
        p: number;
        i: number;
    }>;
    gatherAllyTargets(state: GameState, casterIdx: number, exclude: number, filter?: (c: Record<string, unknown>) => boolean): Array<{
        p: number;
        i: number;
    }>;
    listLegalActions(state: GameState, pIdx: number, opts?: Record<string, unknown>): GameAction[];
    LIMITS?: {
        MAX_HAND?: number;
        MAX_FIELD?: number;
    };
    championPrintedPower?(c: Record<string, unknown>): number;
    isPesadoDemais?(c: Record<string, unknown>): boolean;
    reduceChampionPower?(champ: Record<string, unknown>, amount: number, opts?: Record<string, unknown>): {
        dissolvedWall?: boolean;
    };
}
export interface EffectsApi {
    planOnEnter?(state: GameState, casterIdx: number, fieldIdx: number): Record<string, unknown>;
    applyOnEnter(state: GameState, casterIdx: number, fieldIdx: number, resolution: Record<string, unknown>): {
        ok: boolean;
        events?: GameEvent[];
        error?: string;
    };
    applyReactiveUse(state: GameState, pid: number, key: string, use: boolean): {
        ok: boolean;
        events?: GameEvent[];
        error?: string;
    };
    applyTalentFromHand(state: GameState, pid: number, handIdx: number): {
        ok: boolean;
        events?: GameEvent[];
        error?: string;
    };
}
export interface EngineContext {
    strictFumacaToxica?: boolean;
    avoidEnemyOnEnterWaste?: boolean;
    allowWastedOnEnter?: boolean;
    limits?: unknown;
    /** RNG determinístico no servidor (ultimates com sorteio). */
    rng?: () => number;
}
export interface DispatchAdapter {
    getState?: () => GameState | null;
    setState?: (s: GameState) => void;
    applyVisual?: (a: GameAction) => Promise<Record<string, unknown>>;
}
type GlobalMotor = {
    DfProtocol?: typeof DfProtocol;
    DfRules?: RulesApi;
    DfEffects?: EffectsApi;
    DfEngine?: DfEngineApi;
    __DF_ENGINE_CORE?: DfEngineApi;
};
/** Define o global usado por validate/apply (Node vm vs browser window). */
export declare function setMotorContext(g: GlobalMotor): void;
export declare function cloneState<T>(state: T): T;
export declare function validateAction(state: GameState, action: GameAction, ctx?: EngineContext): import("./df-protocol.js").ValidateShapeResult | {
    ok: boolean;
    code?: string;
};
export declare function applyAction(state: GameState, action: GameAction, ctx?: EngineContext): ApplyResult;
/** Resolução automática de onEnter para simulador / IA (modos auto). */
export declare function autoOnEnterResolution(state: GameState, casterIdx: number, fieldIdx: number, plan: Record<string, unknown>, rng?: () => number): Record<string, unknown>;
/** Aplica ação e resolve onEnter pendentes (auto) em cadeia. */
export declare function applyActionWithOnEnter(state: GameState, action: GameAction, ctx?: EngineContext): ApplyResult;
export declare function listLegalActions(state: GameState, pIdx: number, opts?: Record<string, unknown>): GameAction[];
export declare function dispatch(action: GameAction, adapter: DispatchAdapter, ctx?: EngineContext): Promise<Record<string, unknown> | ApplyResult>;
export declare const DfEngine: Readonly<{
    cloneState: typeof cloneState;
    validateAction: typeof validateAction;
    applyAction: typeof applyAction;
    applyActionWithOnEnter: typeof applyActionWithOnEnter;
    autoOnEnterResolution: typeof autoOnEnterResolution;
    listLegalActions: typeof listLegalActions;
    dispatch: typeof dispatch;
}>;
export type DfEngineApi = typeof DfEngine;
/** Registra motor TS no global (browser / vm). */
export declare function registerEngineGlobals(g?: GlobalMotor): void;
