// @ts-nocheck
/** Dragonfall — DfEffects (motor TS, Fase 2). */
import { DfRules } from "./df-rules.js";
const R = () => DfRules;
let resolveMod = null;
export function bindResolveModule(m) { resolveMod = m; }
function resolveApi() {
    if (resolveMod)
        return resolveMod;
    if (typeof globalThis !== "undefined" && globalThis.DfEffectsResolve) {
        return globalThis.DfEffectsResolve;
    }
    return null;
}
/** @type {Map<string, object>} */
const onEnterRegistry = new Map();
/** @type {Map<string, object>} */
const reactiveRegistry = new Map();
function registerOnEnter(key, spec) {
    if (!key)
        return;
    const prev = onEnterRegistry.get(key) || {};
    onEnterRegistry.set(key, Object.freeze({ key, ...prev, ...spec }));
}
function registerReactive(key, spec) {
    if (!key)
        return;
    const prev = reactiveRegistry.get(key) || {};
    reactiveRegistry.set(key, Object.freeze({ key, ...prev, ...spec }));
}
function getOnEnter(key) {
    return onEnterRegistry.get(key) || null;
}
function getReactive(key) {
    return reactiveRegistry.get(key) || null;
}
function listOnEnterKeys() {
    return [...onEnterRegistry.keys()];
}
function listReactiveKeys() {
    return [...reactiveRegistry.keys()];
}
function canOnEnter(state, pIdx, cardOrChamp, ctx) {
    const rules = R();
    if (!rules)
        return { ok: false, code: "NO_RULES" };
    const onEnter = cardOrChamp?.onEnter;
    if (!onEnter)
        return { ok: true, code: "OK" };
    const spec = getOnEnter(onEnter);
    if (spec?.legal)
        return spec.legal(state, pIdx, cardOrChamp, ctx);
    return rules.canOnEnterResolve(state, pIdx, cardOrChamp, ctx);
}
function canReactive(reactiveKey, state, defOwner, attOwner, extra) {
    const rules = R();
    if (!rules)
        return { ok: false, code: "NO_RULES" };
    const spec = getReactive(reactiveKey);
    if (spec?.legal)
        return spec.legal(state, defOwner, attOwner, extra);
    if (reactiveKey === "bloquearAtaque")
        return rules.canOfferReactiveBlock(state, defOwner, attOwner);
    if (reactiveKey === "protecaoDivina")
        return rules.canOfferReactiveProtection(state, defOwner, attOwner);
    if (reactiveKey === "cancelarUltimate")
        return rules.canOfferCancelUltimate(state, defOwner, attOwner);
    return { ok: false, code: "UNKNOWN_REACTIVE" };
}
function planOnEnter(state, casterIdx, fieldIdx) {
    const caster = state.players[casterIdx]?.field?.[fieldIdx];
    if (!caster?.onEnter || caster.silenced)
        return { ok: true, mode: "none" };
    const rules = R();
    const ctx = { ...(rules?.summonContextForPlayer(state, casterIdx) || {}), fieldIdx };
    const leg = canOnEnter(state, casterIdx, caster, ctx);
    if (leg && !leg.ok)
        return { ok: false, code: leg.code, mode: "blocked" };
    const spec = getOnEnter(caster.onEnter);
    if (spec?.plan)
        return spec.plan(state, casterIdx, fieldIdx, caster, ctx);
    if (resolveApi()?.planOnEnter) {
        return resolveApi().planOnEnter(state, casterIdx, fieldIdx);
    }
    return { ok: true, mode: "auto", ability: caster.onEnter };
}
function applyOnEnter(state, casterIdx, fieldIdx, resolution = {}) {
    const caster = state.players[casterIdx]?.field?.[fieldIdx];
    if (!caster?.onEnter)
        return { ok: true, state, events: [] };
    const spec = getOnEnter(caster.onEnter);
    if (spec?.resolve)
        return spec.resolve(state, casterIdx, fieldIdx, resolution);
    return {
        ok: true,
        state,
        events: [{ type: "ON_ENTER_DELEGATE", onEnter: caster.onEnter, casterIdx, fieldIdx }],
    };
}
function applyReactiveUse(state, defOwner, talentEffect, use) {
    const spec = getReactive(talentEffect);
    if (spec?.resolve)
        return spec.resolve(state, defOwner, talentEffect, use);
    return resolveApi()?.applyReactiveUse(state, defOwner, talentEffect, use)
        || { ok: false, state, events: [], error: "NO_REACTIVE_RESOLVE" };
}
function applyTalentFromHand(state, pIdx, handIdx) {
    return resolveApi()?.applyTalentFromHand(state, pIdx, handIdx)
        || { ok: false, state, events: [], error: "NO_TALENT_RESOLVE" };
}
function bootstrapRegistry() {
    const rules = R();
    if (!rules)
        return;
    const defaultLegal = (state, pIdx, card, ctx) => rules.canOnEnterResolve(state, pIdx, card, ctx);
    (rules.ON_ENTER_NEEDS_ENEMY || []).forEach((key) => {
        registerOnEnter(key, { tags: ["enemy"], legal: defaultLegal });
    });
    [
        "pesadelo", "roubar", "desacelerar", "maldicaoSeteMares", "trocaInjusta",
        "fortalecer", "devorar", "bolaDeFogo", "assassinar", "necromancia",
        "imitar", "ursificacao", "transformarBichinho", "furia", "guardiao",
        "fumacaToxica", "raioDuplo", "auraDeFogo", "auraAntiMagia",
        "invokeDragon", "invokeCubicDragon", "rapidez",
    ].forEach((key) => {
        if (!getOnEnter(key))
            registerOnEnter(key, { legal: defaultLegal });
    });
    registerReactive("bloquearAtaque", {
        legal: (state, defOwner, attOwner) => rules.canOfferReactiveBlock(state, defOwner, attOwner),
    });
    registerReactive("protecaoDivina", {
        legal: (state, defOwner, attOwner) => rules.canOfferReactiveProtection(state, defOwner, attOwner),
    });
    registerReactive("cancelarUltimate", {
        legal: (state, defOwner, attOwner) => rules.canOfferCancelUltimate(state, defOwner, attOwner),
    });
}
bootstrapRegistry();
if (typeof globalThis !== "undefined" && globalThis.resolveMod?.bootstrapResolveRegistry) {
    globalThis.DfEffectsResolve.bootstrapResolveRegistry({
        registerOnEnter,
        registerReactive,
        getOnEnter,
        getReactive,
    });
}
const DfEffects = {
    registerOnEnter,
    registerReactive,
    getOnEnter,
    getReactive,
    listOnEnterKeys,
    listReactiveKeys,
    canOnEnter,
    canReactive,
    bootstrapRegistry,
    planOnEnter,
    applyOnEnter,
    applyReactiveUse,
    applyTalentFromHand,
};
export { DfEffects };
