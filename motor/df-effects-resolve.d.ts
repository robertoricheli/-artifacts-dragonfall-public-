import type { DfEffectsApi } from "./df-effects.js";
export declare function bindEffectsRef(e: DfEffectsApi): void;
declare function cloneState(state: any): any;
declare function swapFieldChamps(state: any, casterIdx: any, casterFieldIdx: any, enemyP: any, enemyI: any): boolean;
/** @returns {{ ok: boolean, mode: string, targetKind?: string, ability?: string, events?: object[], code?: string }} */
declare function planOnEnterImpl(state: any, casterIdx: any, fieldIdx: any): {
    ok: boolean;
    mode: string;
    code?: undefined;
    ability?: undefined;
    targetKind?: undefined;
} | {
    ok: boolean;
    code: any;
    mode: string;
    ability?: undefined;
    targetKind?: undefined;
} | {
    ok: boolean;
    mode: string;
    ability: any;
    code?: undefined;
    targetKind?: undefined;
} | {
    ok: boolean;
    mode: string;
    targetKind: string;
    ability: any;
    code?: undefined;
};
/**
 * Aplica onEnter com parâmetros de resolução.
 * @param {object} resolution — { targetP, targetI, targetPlayerIdx, stolenHandIdx, necromanciaCard, rng }
 */
declare function applyOnEnterImpl(state: any, casterIdx: any, fieldIdx: any, resolution?: Record<string, unknown>): {
    ok: boolean;
    state: any;
    events: any[];
};
declare function applyReactiveUse(state: any, defOwner: any, talentEffect: any, use: any): {
    ok: boolean;
    state: any;
    events: any[];
    blocked: boolean;
    error?: undefined;
    protected?: undefined;
    cancelled?: undefined;
} | {
    ok: boolean;
    state: any;
    events: any[];
    error: any;
    blocked?: undefined;
    protected?: undefined;
    cancelled?: undefined;
} | {
    ok: boolean;
    state: any;
    events: any[];
    blocked: boolean;
    protected: boolean;
    cancelled: boolean;
    error?: undefined;
};
declare function applyTalentFromHand(state: any, pIdx: any, handIdx: any): {
    ok: boolean;
    state: any;
    events: any[];
    error: string;
    card?: undefined;
} | {
    ok: boolean;
    state: any;
    events: {
        type: string;
        playerId: any;
        handIdx: any;
        talentEffect: any;
        card: any;
    }[];
    card: any;
    error?: undefined;
};
/** Registra plan + resolve por string no DfEffects (registry unificado). */
declare function bootstrapResolveRegistry(E: any): void;
declare const DfEffectsResolve: {
    cloneState: typeof cloneState;
    planOnEnter: typeof planOnEnterImpl;
    applyOnEnter: typeof applyOnEnterImpl;
    applyReactiveUse: typeof applyReactiveUse;
    applyTalentFromHand: typeof applyTalentFromHand;
    swapFieldChamps: typeof swapFieldChamps;
    bootstrapResolveRegistry: typeof bootstrapResolveRegistry;
};
export type DfEffectsResolveApi = typeof DfEffectsResolve;
export declare function wireEffectsResolveRegistry(effects: DfEffectsApi): void;
export { DfEffectsResolve };
