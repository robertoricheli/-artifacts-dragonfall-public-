/**
 * Resolução autoritativa de Ultimates (servidor / anti-trapaça).
 * Espelha regras de df-talent-ultimate-presenter + df-game-view (sem DOM).
 */
import type { GameAction, GameEvent, GameState } from "./df-types.js";
type Rng = () => number;
export declare function getMaxUltimateUses(heroId: string): number;
export declare function validateUltimatePlay(state: GameState, action: GameAction): {
    ok: boolean;
    code?: string;
};
export declare function applyUltimatePlay(state: GameState, action: GameAction, rng?: Rng): {
    ok: boolean;
    state: GameState;
    events: GameEvent[];
    error?: string;
};
export declare const DfUltimateResolve: Readonly<{
    getMaxUltimateUses: typeof getMaxUltimateUses;
    validateUltimatePlay: typeof validateUltimatePlay;
    applyUltimatePlay: typeof applyUltimatePlay;
}>;
export {};
