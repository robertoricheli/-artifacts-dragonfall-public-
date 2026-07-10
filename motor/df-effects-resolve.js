// @ts-nocheck
/** Dragonfall — DfEffectsResolve (motor TS, Fase 2). */
import { DfRules } from "./df-rules.js";
import { DfData } from "./df-data.js";
const R = () => DfRules;
const D = () => DfData;
let DfEffectsRef = null;
export function bindEffectsRef(e) { DfEffectsRef = e; }
function getEffectsApi() {
    return (typeof globalThis !== "undefined" && globalThis.DfEffects) || DfEffectsRef;
}
function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
}
function markOnEnterUsed(state, pIdx, key) {
    const p = state.players[pIdx];
    if (!p.onEnterUsedThisTurn)
        p.onEnterUsedThisTurn = [];
    if (key && !p.onEnterUsedThisTurn.includes(key))
        p.onEnterUsedThisTurn.push(key);
}
function swapFieldChamps(state, casterIdx, casterFieldIdx, enemyP, enemyI) {
    const a = state.players[casterIdx].field[casterFieldIdx];
    const e = state.players[enemyP].field[enemyI];
    if (!a || !e)
        return false;
    for (const ch of [a, e]) {
        ch.freeAttack = false;
        ch.shielded = false;
        ch.shieldedTurns = 0;
        ch.guerraBuff = false;
        ch.guerraBuffTurns = 0;
    }
    state.players[casterIdx].field[casterFieldIdx] = e;
    state.players[enemyP].field[enemyI] = a;
    return true;
}
function reduceChampionPower(champ, amt) {
    const rules = R();
    if (rules?.reduceChampionPower)
        return rules.reduceChampionPower(champ, amt);
    if (!champ)
        return { dissolvedWall: false };
    champ.currentPower = Math.max(0, (champ.currentPower ?? 0) - amt);
    return { dissolvedWall: false };
}
function destroyAtField(state, p, i, events, reason) {
    const champ = state.players[p]?.field?.[i];
    if (!champ)
        return;
    state.players[p].field.splice(i, 1);
    state.players[p].discard = state.players[p].discard || [];
    state.players[p].discard.push(champ);
    events.push({ type: "DESTROY", p, i, reason, name: champ.name });
}
function findCardDef(name) {
    return D()?.cardDefs?.find((c) => c.name === name) || null;
}
function clearChampionFieldStatuses(c) {
    if (!c)
        return;
    c.frozen = false;
    c.frozenTurns = 0;
    c.shielded = false;
    c.shieldedTurns = 0;
    c.freeAttack = false;
    c.silenced = false;
    c.poisoned = false;
    c.poisonTurns = 0;
    c.poisonedByP = -1;
    c.pulled = false;
    c.pulledFromOwner = -1;
    c.pulledTurns = 0;
    c.wallBuff = false;
    c.wallBuffApplied = false;
    c.wallBuffSnapshot = 0;
    c.foreverGrowth = false;
    c.guerraBuff = false;
    c.guerraBuffTurns = 0;
    c.barrier = false;
    c.barrierTurns = 0;
    c.barrierPermanent = false;
    c.fireAura = false;
    c.fireAuraTurns = 0;
    c.fury = false;
    c.furyTurns = 0;
    c.furyBonusActive = false;
    c.vulnerable = false;
}
function inferConstantOnDestroy(card) {
    if (!card || card.onDestroy)
        return card?.onDestroy || null;
    const norm = (s) => String(s || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const n = norm(card.mimicAbilityName || card.abilityName);
    if (!n)
        return null;
    if (n === "legado")
        return "legado";
    if (n === "vinganca" || n.includes("furia vermelha"))
        return "vinganca";
    if (n.includes("sem honra"))
        return "noHonor";
    return null;
}
function inferConstantEffect(card) {
    if (!card || card.silenced)
        return null;
    if (card.constantEffect)
        return card.constantEffect;
    if (card.abilityType !== "constant" || !card.abilityName)
        return null;
    const n = card.abilityName;
    if (n === "Inspirar")
        return "inspirar";
    if (n === "Investida")
        return "investida";
    if (n === "Tiro Duplo")
        return "tiroDuplo";
    return null;
}
function pickRandomEnemyChamps(state, casterIdx, count, opts = {}) {
    const pool = [];
    const n = state.playersCount ?? state.players.length;
    for (let ep = 0; ep < n; ep++) {
        if (ep === casterIdx)
            continue;
        (state.players[ep]?.field || []).forEach((c, i) => {
            if (!c)
                return;
            if (opts.avoidPower1 && (c.currentPower ?? 0) === 1)
                return;
            pool.push({ p: ep, i });
        });
    }
    for (let k = pool.length - 1; k > 0; k--) {
        const j = Math.floor((opts.rng || Math.random)() * (k + 1));
        [pool[k], pool[j]] = [pool[j], pool[k]];
    }
    return pool.slice(0, count);
}
function applyTokenTransform(target, tokenDef, newPower) {
    target.name = tokenDef.name;
    target.power = newPower;
    target.basePower = 0;
    target.currentPower = newPower;
    target.abilityType = tokenDef.abilityType;
    target.abilityName = tokenDef.abilityName;
    target.abilityDesc = tokenDef.abilityDesc;
    target.onEnter = null;
    target.onDestroy = null;
    target.talentEffect = null;
    target.summonRitual = undefined;
    target.constantEffect = null;
    target.isToken = true;
    target.hidden = true;
    clearChampionFieldStatuses(target);
}
/** @returns {{ ok: boolean, mode: string, targetKind?: string, ability?: string, events?: object[], code?: string }} */
function planOnEnterImpl(state, casterIdx, fieldIdx) {
    const caster = state.players[casterIdx]?.field?.[fieldIdx];
    if (!caster?.onEnter)
        return { ok: true, mode: "none" };
    const key = caster.onEnter;
    const ctx = R()?.summonContextForPlayer(state, casterIdx) || {};
    const leg = getEffectsApi()?.canOnEnter?.(state, casterIdx, caster, ctx);
    if (leg && !leg.ok)
        return { ok: false, code: leg.code, mode: "blocked" };
    const instantAuto = new Set([
        "fumacaToxica", "raioDuplo", "pesadelo", "roubar", "desacelerar",
    ]);
    const targetEnemy = new Set([
        "bolaDeFogo", "assassinar", "transformarBichinho",
    ]);
    const targetAlly = new Set(["fortalecer", "devorar", "imitar", "ursificacao"]);
    /* pesadelo/roubar/desacelerar migraram pra instantAuto — set vazio
       evita ReferenceError se algum onEnter novo usar targetKind player. */
    const targetPlayer = new Set([]);
    if (instantAuto.has(key))
        return { ok: true, mode: "auto", ability: key };
    if (key === "invokeDragon" || key === "invokeCubicDragon") {
        return { ok: true, mode: "visual_only", ability: key };
    }
    if (targetEnemy.has(key))
        return { ok: true, mode: "target", targetKind: "enemy", ability: key };
    if (targetAlly.has(key))
        return { ok: true, mode: "target", targetKind: "ally", ability: key };
    if (targetPlayer.has(key))
        return { ok: true, mode: "target", targetKind: "player", ability: key };
    if (key === "necromancia")
        return { ok: true, mode: "necromancia_pick" };
    return { ok: true, mode: "auto", ability: key };
}
/**
 * Aplica onEnter com parâmetros de resolução.
 * @param {object} resolution — { targetP, targetI, targetPlayerIdx, stolenHandIdx, necromanciaCard, rng }
 */
function applyOnEnterImpl(state, casterIdx, fieldIdx, resolution = {}) {
    const events = [];
    const caster = state.players[casterIdx]?.field?.[fieldIdx];
    if (!caster?.onEnter)
        return { ok: true, state, events };
    const key = caster.onEnter;
    const rng = resolution.rng || Math.random;
    switch (key) {
        case "rapidez": {
            state.players[casterIdx].actions = (state.players[casterIdx].actions ?? 0) + 1;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "RAPIDEZ", casterIdx, visual: "wings" });
            break;
        }
        case "pesadelo": {
            let t = resolution.targetPlayerIdx ?? resolution.targetIdx;
            if (t == null || t === casterIdx) {
                for (let p = 0; p < state.playersCount; p++) {
                    if (p !== casterIdx) {
                        t = p;
                        break;
                    }
                }
            }
            if (t == null || t === casterIdx || state.players[t]?.skipDraw)
                break;
            state.players[t].skipDraw = true;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "PESADELO", casterIdx, targetIdx: t, visual: "pesadelo" });
            break;
        }
        case "desacelerar": {
            let t = resolution.targetPlayerIdx ?? resolution.targetIdx;
            if (t == null || t === casterIdx) {
                for (let p = 0; p < state.playersCount; p++) {
                    if (p !== casterIdx) {
                        t = p;
                        break;
                    }
                }
            }
            if (t == null || t === casterIdx || state.players[t]?.skipNextAction)
                break;
            state.players[t].skipNextAction = true;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "DESACELERAR", casterIdx, targetIdx: t, visual: "desacelerar" });
            break;
        }
        case "roubar": {
            let t = resolution.targetPlayerIdx ?? resolution.targetIdx;
            if (t == null || t === casterIdx) {
                for (let p = 0; p < state.playersCount; p++) {
                    if (p !== casterIdx) {
                        t = p;
                        break;
                    }
                }
            }
            const targetP = state.players[t];
            const casterP = state.players[casterIdx];
            if (!targetP?.hand?.length || !casterP)
                break;
            const idx = resolution.stolenHandIdx != null
                ? resolution.stolenHandIdx
                : Math.floor(rng() * targetP.hand.length);
            const stolen = targetP.hand.splice(idx, 1)[0];
            casterP.hand.push(stolen);
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "ROUBAR", casterIdx, targetIdx: t, card: stolen.name, visual: "roubar" });
            break;
        }
        case "maldicaoSeteMares": {
            for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
                if (p === casterIdx)
                    continue;
                const opp = state.players[p];
                opp.maldicaoForgetNext = true;
                (opp.hand || []).forEach((card) => {
                    if (card?.category === "champion")
                        card.silencedInHand = true;
                });
            }
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "MALDICAO_SETE_MARES", casterIdx, visual: "maldicao_sete_mares" });
            break;
        }
        case "trocaInjusta": {
            const ep = resolution.enemyP ?? resolution.targetP;
            const ei = resolution.enemyI ?? resolution.targetI;
            if (ep == null || ei == null)
                break;
            if (swapFieldChamps(state, casterIdx, fieldIdx, ep, ei)) {
                markOnEnterUsed(state, casterIdx, key);
                events.push({
                    type: "TROCA_INJUSTA", casterIdx, fieldIdx, enemyP: ep, enemyI: ei,
                    visual: "troca_injusta",
                });
            }
            break;
        }
        case "fortalecer": {
            const ti = resolution.targetI;
            const ally = state.players[casterIdx]?.field?.[ti];
            if (ally) {
                const base = R()?.championSummonCost?.(ally) ?? ally.currentPower ?? ally.power ?? 0;
                ally.currentPower = base + 1;
                markOnEnterUsed(state, casterIdx, key);
                events.push({ type: "FORTALECER", casterIdx, targetP: casterIdx, targetI: ti, visual: "strong_arm" });
            }
            break;
        }
        case "devorar": {
            const ti = resolution.targetI;
            const ally = state.players[casterIdx]?.field?.[ti];
            if (!ally || ally.inspiracao)
                break;
            const pow = ally.currentPower ?? 0;
            destroyAtField(state, casterIdx, ti, events, "devorar");
            const newIdx = ti < fieldIdx ? fieldIdx - 1 : fieldIdx;
            const c2 = state.players[casterIdx].field[newIdx];
            if (c2)
                c2.currentPower = (c2.currentPower ?? 0) + pow;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "DEVOUR", casterIdx, devouredI: ti, visual: "devour" });
            break;
        }
        case "bolaDeFogo": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const t = state.players[tp]?.field?.[ti];
            if (!t)
                break;
            reduceChampionPower(t, 1);
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "BOLA_DE_FOGO", casterIdx, targetP: tp, targetI: ti, visual: "bola_de_fogo" });
            if (t.currentPower <= 0)
                destroyAtField(state, tp, ti, events, "bolaDeFogo");
            break;
        }
        case "assassinar": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const t = state.players[tp]?.field?.[ti];
            if (!t || t.currentPower !== 1 || t.shielded)
                break;
            destroyAtField(state, tp, ti, events, "assassinar");
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "ASSASSINAR", casterIdx, targetP: tp, targetI: ti, visual: "assassinar" });
            break;
        }
        case "necromancia": {
            const card = resolution.necromanciaCard;
            const discard = state.players[casterIdx]?.discard || [];
            if (!card)
                break;
            const di = discard.findIndex((c) => c.uid === card.uid || c.name === card.name);
            if (di >= 0)
                discard.splice(di, 1);
            state.players[casterIdx].hand.push(card);
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "NECROMANCIA", casterIdx, card: card.name, visual: "necromancia" });
            break;
        }
        case "imitar": {
            const ti = resolution.targetI;
            const ally = state.players[casterIdx]?.field?.[ti];
            if (!ally || ally.onEnter === "imitar")
                break;
            const copiedConstant = inferConstantEffect(ally);
            if (!ally.abilityName && !ally.onEnter && !ally.onDestroy && !copiedConstant)
                break;
            caster.abilityType = ally.abilityType;
            caster.abilityName = ally.abilityName;
            caster.abilityDesc = ally.abilityDesc;
            caster.onEnter = ally.onEnter;
            caster.onDestroy = ally.onDestroy || inferConstantOnDestroy(ally);
            caster.constantEffect = copiedConstant;
            caster.talentEffect = ally.talentEffect || null;
            caster.mimico = true;
            caster.mimicAbilityName = ally.abilityName || "Habilidade";
            caster.mimicAbilityDesc = ally.abilityDesc || "";
            caster.mimicSourceName = ally.name;
            caster.mimicOnDestroy = caster.onDestroy;
            caster.mimicOnEnter = ally.onEnter;
            caster.mimicConstantEffect = copiedConstant;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "IMITAR", casterIdx, fieldIdx, allyP: casterIdx, allyI: ti,
                copiedOnEnter: caster.onEnter, copiedConstantEffect: copiedConstant,
                casterUid: caster.uid,
                mimicName: ally.name, abilityName: ally.abilityName,
            });
            break;
        }
        case "ursificacao": {
            const ti = resolution.targetI;
            const target = state.players[casterIdx]?.field?.[ti];
            const banjoDef = findCardDef("BANJO");
            if (!target || !banjoDef)
                break;
            const replacedPower = typeof target.currentPower === "number"
                ? target.currentPower
                : (target.basePower || target.power || 0);
            const newPower = replacedPower + 2;
            const origName = target.name;
            applyTokenTransform(target, banjoDef, newPower);
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "URSIFICACAO", casterIdx, targetI: ti, origName,
                newPower, visual: "ursificacao",
            });
            break;
        }
        case "transformarBichinho": {
            const tp = resolution.targetP;
            let ti = resolution.targetI;
            const target = state.players[tp]?.field?.[ti];
            if (!target || (target.currentPower ?? 0) < 2 || target.barrier)
                break;
            const success = resolution.success != null ? !!resolution.success : rng() < 0.90;
            const origPower = target.currentPower;
            const origName = target.name;
            if (success && target.vulnerable) {
                destroyAtField(state, tp, ti, events, "transformarBichinho");
                markOnEnterUsed(state, casterIdx, key);
                events.push({
                    type: "TRANSFORM_VULN_DESTROY", casterIdx, targetP: tp, targetI: ti,
                    origName, visual: "transformar_bichinho",
                });
                break;
            }
            const tokenDef = findCardDef(success ? "BICHINHO FOFINHO" : "TERRÍVEL MONSTRO");
            if (!tokenDef)
                break;
            const newPower = success ? Math.floor(origPower / 2) : (origPower + 1);
            applyTokenTransform(target, tokenDef, newPower);
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "TRANSFORMAR_BICHINHO", casterIdx, fieldIdx, targetP: tp, targetI: ti,
                success, origName, origPower, newPower, visual: "transformar_bichinho",
            });
            break;
        }
        case "furia": {
            if (caster.silenced)
                break;
            caster.fury = true;
            caster.furyTurns = 1;
            caster.furyBonusActive = true;
            caster.currentPower = (caster.currentPower ?? 0) + 1;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "FURIA", casterIdx, fieldIdx, visual: "fury" });
            break;
        }
        case "guardiao": {
            const allies = [];
            state.players[casterIdx].field.forEach((c, i) => {
                if (i !== fieldIdx && c && !c.shielded)
                    allies.push(i);
            });
            for (let i = allies.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                [allies[i], allies[j]] = [allies[j], allies[i]];
            }
            const picks = allies.slice(0, Math.min(2, allies.length));
            const names = [];
            for (const idx of picks) {
                const t = state.players[casterIdx].field[idx];
                if (!t)
                    continue;
                t.shielded = true;
                t.shieldedTurns = 1;
                names.push(t.name);
            }
            if (!names.length)
                break;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "GUARDIAO", casterIdx, picks, names, visual: "guardian" });
            break;
        }
        case "auraAntiMagia": {
            caster.barrier = true;
            caster.barrierPermanent = true;
            caster.barrierTurns = 0;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "AURA_ANTI_MAGIA", casterIdx, fieldIdx, visual: "barrier_grant" });
            break;
        }
        case "auraDeFogo": {
            const allies = [];
            state.players[casterIdx].field.forEach((c, i) => {
                if (i === fieldIdx || !c)
                    return;
                if (c.fireAura && c.fireAuraTurns > 0)
                    return;
                allies.push(i);
            });
            for (let k = allies.length - 1; k > 0; k--) {
                const j = Math.floor(rng() * (k + 1));
                [allies[k], allies[j]] = [allies[j], allies[k]];
            }
            const picks = allies.slice(0, Math.min(2, allies.length));
            const names = [];
            const indices = [];
            for (const idx of picks) {
                const ch = state.players[casterIdx].field[idx];
                if (!ch || (ch.fireAura && ch.fireAuraTurns > 0))
                    continue;
                ch.fireAura = true;
                ch.fireAuraTurns = 3;
                indices.push(idx);
                names.push(ch.name);
            }
            if (!names.length)
                break;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "AURA_DE_FOGO", casterIdx, indices, names, visual: "fire_aura" });
            break;
        }
        case "fumacaToxica": {
            const picks = pickRandomEnemyChamps(state, casterIdx, 2, {
                avoidPower1: !!resolution.avoidPower1,
                rng,
            });
            if (!picks.length)
                break;
            const names = [];
            for (const { p, i } of picks) {
                const ch = state.players[p]?.field[i];
                if (!ch)
                    continue;
                ch.vulnerable = true;
                names.push(ch.name);
            }
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "FUMACA_TOXICA", casterIdx, fieldIdx, picks, names,
                visual: "fumaca_toxica",
            });
            break;
        }
        case "raioDuplo": {
            const picks = pickRandomEnemyChamps(state, casterIdx, 2, { rng });
            if (!picks.length)
                break;
            const sorted = picks.slice().sort((a, b) => (a.p !== b.p ? b.p - a.p : b.i - a.i));
            const names = [];
            const hits = [];
            for (const { p, i } of sorted) {
                const ch = state.players[p]?.field[i];
                if (!ch)
                    continue;
                const before = ch.currentPower ?? 0;
                reduceChampionPower(ch, 1);
                names.push(ch.name);
                hits.push({ p, i, before, after: ch.currentPower });
                if (ch.currentPower <= 0 && before > 0) {
                    destroyAtField(state, p, i, events, "raioDuplo");
                }
            }
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "RAIO_DUPLO", casterIdx, fieldIdx, hits, names, visual: "raio_duplo" });
            break;
        }
        default:
            events.push({ type: "ON_ENTER_DELEGATE", onEnter: key, casterIdx, fieldIdx });
    }
    const winner = R()?.findWinnerIndex(state);
    if (winner != null) {
        state.winner = winner;
        events.push({ type: "GAME_OVER", winner });
    }
    return { ok: true, state, events };
}
function applyReactiveUse(state, defOwner, talentEffect, use) {
    const events = [];
    if (!use)
        return { ok: true, state, events, blocked: false };
    const rules = R();
    const leg = DfEffectsRef?.canReactive(talentEffect, state, defOwner, null);
    if (!leg?.ok)
        return { ok: false, state, events, error: leg?.code || "NO_REACTIVE" };
    const handIdx = leg.handIdx;
    const card = state.players[defOwner].hand.splice(handIdx, 1)[0];
    state.players[defOwner].discard = state.players[defOwner].discard || [];
    state.players[defOwner].discard.push(card);
    events.push({
        type: "REACTIVE_USED",
        defOwner,
        talentEffect,
        cardName: card?.name,
        blocked: talentEffect === "bloquearAtaque",
        protected: talentEffect === "protecaoDivina",
        cancelled: talentEffect === "cancelarUltimate",
    });
    return {
        ok: true,
        state,
        events,
        blocked: talentEffect === "bloquearAtaque",
        protected: talentEffect === "protecaoDivina",
        cancelled: talentEffect === "cancelarUltimate",
    };
}
function applyTalentFromHand(state, pIdx, handIdx) {
    const p = state.players[pIdx];
    const card = p?.hand?.[handIdx];
    if (!card || card.category !== "talent") {
        return { ok: false, state, events: [], error: "NOT_TALENT" };
    }
    if ((p.actions ?? 0) < 1)
        return { ok: false, state, events: [], error: "INSUFFICIENT_ACTIONS" };
    p.actions -= 1;
    return {
        ok: true,
        state,
        events: [{ type: "TALENT_STARTED", playerId: pIdx, handIdx, talentEffect: card.talentEffect, card: card.name }],
        card,
    };
}
const ON_ENTER_RESOLVE_KEYS = [
    "rapidez", "pesadelo", "desacelerar", "roubar", "maldicaoSeteMares", "trocaInjusta",
    "fortalecer", "devorar", "bolaDeFogo", "assassinar", "necromancia", "imitar",
    "ursificacao", "transformarBichinho", "furia", "guardiao", "auraAntiMagia",
    "auraDeFogo", "fumacaToxica", "raioDuplo",
];
/** Registra plan + resolve por string no DfEffects (registry unificado). */
function bootstrapResolveRegistry(E) {
    if (!E?.registerOnEnter)
        return;
    ON_ENTER_RESOLVE_KEYS.forEach((key) => {
        const prev = E.getOnEnter(key) || {};
        E.registerOnEnter(key, {
            ...prev,
            plan: (state, casterIdx, fieldIdx) => planOnEnterImpl(state, casterIdx, fieldIdx),
            resolve: (state, casterIdx, fieldIdx, resolution) => applyOnEnterImpl(state, casterIdx, fieldIdx, resolution),
        });
    });
    ["bloquearAtaque", "protecaoDivina", "cancelarUltimate"].forEach((key) => {
        const prev = E.getReactive(key) || {};
        E.registerReactive(key, {
            ...prev,
            resolve: (state, defOwner, _effect, use) => applyReactiveUse(state, defOwner, key, use),
        });
    });
    ["invokeDragon", "invokeCubicDragon"].forEach((key) => {
        const prev = E.getOnEnter(key) || {};
        E.registerOnEnter(key, {
            ...prev,
            plan: (state, casterIdx, fieldIdx) => planOnEnterImpl(state, casterIdx, fieldIdx),
        });
    });
}
const DfEffectsResolve = {
    cloneState,
    planOnEnter: planOnEnterImpl,
    applyOnEnter: applyOnEnterImpl,
    applyReactiveUse,
    applyTalentFromHand,
    swapFieldChamps,
    bootstrapResolveRegistry,
};
export function wireEffectsResolveRegistry(effects) {
    bindEffectsRef(effects);
    bootstrapResolveRegistry(effects);
}
export { DfEffectsResolve };
