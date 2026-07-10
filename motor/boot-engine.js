/**
 * Boot do motor Dragonfall no Node — regras/dados/efeitos TS + protocol/engine TS.
 */
import { registerEngineGlobals } from "./df-engine.js";
import { DfRules } from "./df-rules.js";
import { DfData } from "./df-data.js";
import { DfEffects, bindResolveModule } from "./df-effects.js";
import { DfEffectsResolve, wireEffectsResolveRegistry } from "./df-effects-resolve.js";
let cached = null;
function wireEffectsStack() {
    bindResolveModule(DfEffectsResolve);
    wireEffectsResolveRegistry(DfEffects);
}
export function bootDragonfallEngine() {
    if (cached)
        return cached;
    wireEffectsStack();
    const g = globalThis;
    registerEngineGlobals(g);
    g.DfRules = DfRules;
    g.DfData = DfData;
    g.DfEffects = DfEffects;
    cached = {
        DfProtocol: g.DfProtocol,
        DfRules,
        DfData,
        DfEffects,
        DfEngine: g.DfEngine,
    };
    return cached;
}
export function clearEngineCache() {
    cached = null;
}
