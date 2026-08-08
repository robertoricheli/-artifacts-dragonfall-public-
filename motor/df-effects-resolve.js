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
/** Marca o campeão: instantânea só na 1ª entrada em qualquer campo. */
function markChampOnEnterConsumed(champ) {
    if (champ && typeof champ === "object")
        champ.onEnterConsumed = true;
}
function swapFieldChamps(state, casterIdx, casterFieldIdx, enemyP, enemyI) {
    const a = state.players[casterIdx].field[casterFieldIdx];
    const e = state.players[enemyP].field[enemyI];
    if (!a || !e)
        return false;
    for (const ch of [a, e]) {
        ch.freeAttack = false;
        if (!ch.shieldedPermanent) {
            ch.shielded = false;
            ch.shieldedTurns = 0;
        }
        ch.guerraBuff = false;
        ch.guerraBuffTurns = 0;
    }
    // Troca não é nova entrada — ambos já tiveram (ou terão) onEnter na 1ª invocação.
    markChampOnEnterConsumed(a);
    markChampOnEnterConsumed(e);
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
    events.push({ type: "DESTROY", p, i, reason, name: champ.name, uid: champ.uid });
    const burst = R()?.applyOnDestroyBurst?.(state, p, champ, reason);
    if (burst?.ability) {
        events.push({
            type: "ON_DESTROY_BURST",
            ownerIdx: p,
            source: champ.name,
            reason,
            ...burst,
        });
    }
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
    c.shieldedPermanent = false;
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
    c.burning = false;
    c.burningTurns = 0;
    c.burningByP = undefined;
    c.fury = false;
    c.furyTurns = 0;
    c.furyStacks = 0;
    c.furyBonusActive = false;
    c.vulnerable = false;
    c.corruptedNoHonor = false;
}
function inferConstantOnDestroy(card) {
    const rules = R();
    if (rules?.resolveOnDestroyAbility)
        return rules.resolveOnDestroyAbility(card);
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
    if (n === "explosao de gelo")
        return "explosaoGelo";
    if (n === "explosao venenosa")
        return "explosaoVenenosa";
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
    // Instantânea só na 1ª entrada em qualquer campo (Troca Injusta não reativa).
    if (caster.onEnterConsumed)
        return { ok: true, mode: "none" };
    const key = caster.onEnter;
    const ctx = R()?.summonContextForPlayer(state, casterIdx) || {};
    const leg = getEffectsApi()?.canOnEnter?.(state, casterIdx, caster, ctx);
    if (leg && !leg.ok)
        return { ok: false, code: leg.code, mode: "blocked" };
    const instantAuto = new Set([
        "fumacaToxica", "raioDuplo", "pesadelo", "roubar", "desacelerar",
        "defensor", "gritoDeGuerra",
    ]);
    const targetEnemy = new Set([
        "bolaDeFogo", "assassinar", "transformarBichinho", "rajadaCongelante",
        "mordidaVenenosa", "incendiar",
    ]);
    const targetAlly = new Set(["fortalecer", "devorar", "imitar", "ursificacao", "corromper"]);
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
    if (caster.onEnterConsumed)
        return { ok: true, state, events };
    if (caster.silenced)
        return { ok: true, state, events };
    const enteringChamp = caster;
    const key = caster.onEnter;
    const rng = resolution.rng || Math.random;
    switch (key) {
        case "rapidez": {
            state.players[casterIdx].actions = (state.players[casterIdx].actions ?? 0) + 1;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "RAPIDEZ", casterIdx, visual: "wings" });
            break;
        }
        case "defensor": {
            caster.shielded = true;
            caster.shieldedTurns = 0;
            caster.shieldedPermanent = true;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "DEFENSOR",
                casterIdx,
                fieldIdx,
                visual: "shield",
            });
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
            events.push({
                type: "DESACELERAR",
                casterIdx,
                fieldIdx,
                targetIdx: t,
                visual: "desacelerar",
            });
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
            const cardPow = stolen.currentPower ?? stolen.power ?? 0;
            events.push({
                type: "ROUBAR",
                casterIdx,
                targetIdx: t,
                card: stolen.name,
                cardSnap: {
                    name: stolen.name,
                    power: stolen.power ?? cardPow,
                    currentPower: cardPow,
                },
                visual: "roubar",
            });
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
        case "corromper": {
            const ti = resolution.targetI;
            if (ti === fieldIdx)
                break;
            const ally = state.players[casterIdx]?.field?.[ti];
            if (!ally)
                break;
            const abilityName = String(ally.mimicAbilityName || ally.abilityName || "");
            const nativeNoHonor = ally.onDestroy === "noHonor"
                || ally.mimicOnDestroy === "noHonor"
                || abilityName.toLowerCase().normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "").includes("sem honra");
            const alreadyNoHonor = nativeNoHonor || !!ally.corruptedNoHonor;
            if (!alreadyNoHonor)
                ally.corruptedNoHonor = true;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "CORROMPER",
                casterIdx,
                fieldIdx,
                targetP: casterIdx,
                targetI: ti,
                targetName: ally.name,
                alreadyNoHonor,
                visual: "corrupt",
            });
            break;
        }
        case "mordidaVenenosa": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const target = state.players[tp]?.field?.[ti];
            if (!target || tp === casterIdx)
                break;
            const alreadyPoisoned = !!target.poisoned;
            if (!alreadyPoisoned) {
                target.poisoned = true;
                target.poisonTurns = 2;
                target.poisonedByP = casterIdx;
            }
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "MORDIDA_VENENOSA",
                casterIdx,
                fieldIdx,
                targetP: tp,
                targetI: ti,
                targetName: target.name,
                applied: !alreadyPoisoned,
                visual: "mordida_venenosa",
            });
            break;
        }
        case "incendiar": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const target = state.players[tp]?.field?.[ti];
            if (!target || tp === casterIdx)
                break;
            target.burning = true;
            target.burningTurns = 4;
            target.burningByP = casterIdx;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "INCENDIAR",
                casterIdx,
                fieldIdx,
                targetP: tp,
                targetI: ti,
                targetName: target.name,
                turns: 4,
                visual: "em_chamas",
            });
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
            events.push({
                type: "DEVOUR",
                casterIdx,
                fieldIdx: newIdx,
                devouredI: ti,
                powerAfter: c2?.currentPower,
                visual: "devour",
            });
            break;
        }
        case "bolaDeFogo": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const t = state.players[tp]?.field?.[ti];
            if (!t)
                break;
            markOnEnterUsed(state, casterIdx, key);
            // Barreira bloqueia a 1ª redução — Fúria e Poder permanecem.
            if (t.barrier) {
                t.barrier = false;
                t.barrierTurns = 0;
                events.push({
                    type: "BARRIER_BLOCKED",
                    casterIdx,
                    targetP: tp,
                    targetI: ti,
                    source: "bolaDeFogo",
                    visual: "barrier_block",
                });
                break;
            }
            reduceChampionPower(t, 1);
            events.push({ type: "BOLA_DE_FOGO", casterIdx, targetP: tp, targetI: ti, visual: "bola_de_fogo" });
            if (t.currentPower <= 0)
                destroyAtField(state, tp, ti, events, "bolaDeFogo");
            break;
        }
        case "assassinar": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const t = state.players[tp]?.field?.[ti];
            if (!t || t.currentPower !== 1)
                break;
            destroyAtField(state, tp, ti, events, "assassinar");
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "ASSASSINAR", casterIdx, targetP: tp, targetI: ti, visual: "assassinar" });
            break;
        }
        case "rajadaCongelante": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const target = state.players[tp]?.field?.[ti];
            if (!target || tp === casterIdx)
                break;
            markOnEnterUsed(state, casterIdx, key);
            if (target.frozen) {
                const targetName = target.name;
                const noHonor = !!R()?.hasNoHonor?.(target);
                destroyAtField(state, tp, ti, events, "rajadaCongelante");
                if (!noHonor) {
                    state.players[casterIdx].vp = (state.players[casterIdx].vp ?? 0) + 1;
                }
                events.push({
                    type: "RAJADA_CONGELANTE_DESTROY",
                    casterIdx,
                    targetP: tp,
                    targetI: ti,
                    targetName,
                    vpGain: noHonor ? 0 : 1,
                    visual: "freeze_shatter",
                });
            }
            else {
                target.frozen = true;
                target.frozenTurns = 2;
                events.push({
                    type: "RAJADA_CONGELANTE_FREEZE",
                    casterIdx,
                    targetP: tp,
                    targetI: ti,
                    targetName: target.name,
                    visual: "freeze",
                });
            }
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
                visual: "imitar",
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
            const tokenDef = findCardDef(success ? "BICHINHO FOFINHO" : "O CHEFÃO");
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
            R()?.grantFuryStacks?.(caster, 1);
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "FURIA",
                casterIdx,
                fieldIdx,
                furyStacks: R()?.getFuryStacks?.(caster) || 1,
                visual: "fury",
            });
            break;
        }
        case "gritoDeGuerra": {
            const applied = [];
            state.players[casterIdx].field.forEach((ally, i) => {
                if (!ally || i === fieldIdx)
                    return;
                R()?.grantFuryStacks?.(ally, 1);
                applied.push({
                    p: casterIdx,
                    i,
                    name: ally.name,
                    furyStacks: R()?.getFuryStacks?.(ally) || 1,
                });
            });
            if (!applied.length)
                break;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "GRITO_DE_GUERRA",
                casterIdx,
                fieldIdx,
                applied,
                visual: "fury",
            });
            break;
        }
        case "guardiao": {
            const picks = [];
            state.players[casterIdx].field.forEach((c, i) => {
                if (i !== fieldIdx && c && !c.shielded)
                    picks.push(i);
            });
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
        case "invokeDragon":
        case "invokeCubicDragon": {
            const maxField = R()?.LIMITS?.MAX_FIELD ?? 8;
            const field = state.players[casterIdx]?.field;
            if (!field || field.length >= maxField) {
                events.push({ type: "FIELD_FULL_DRAGON", casterIdx, ability: key });
                break;
            }
            const data = D();
            const def = key === "invokeCubicDragon"
                ? (data?.cubicDragonDef || { name: "DRAGÃO AZUL", power: 2, category: "champion" })
                : (data?.babyDragonDef || { name: "FILHOTE DE DRAGÃO", power: 1, category: "champion" });
            const tok = {
                ...def,
                uid: `tok-${Date.now()}-${field.length}-${Math.floor(Math.random() * 1e6)}`,
                currentPower: def.power ?? 1,
                basePower: def.power ?? 1,
                tapped: false,
                isToken: true,
                frozen: false,
                frozenTurns: 0,
                freeAttack: false,
                shielded: false,
                shieldedTurns: 0,
                silenced: false,
            };
            field.push(tok);
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "DRAGON_TOKEN_SUMMON",
                casterIdx,
                insertIdx: field.length - 1,
                cardName: tok.name,
                uid: tok.uid,
                visual: "dragon_token_summon",
            });
            break;
        }
        default:
            events.push({ type: "ON_ENTER_DELEGATE", onEnter: key, casterIdx, fieldIdx });
    }
    // Imitar com cópia de onEnter: consumir só após a chain (Roubar etc.).
    const chainedImitar = events.some((e) => e?.type === "IMITAR" && e.copiedOnEnter && e.copiedOnEnter !== "imitar");
    if (events.length && !chainedImitar)
        markChampOnEnterConsumed(enteringChamp);
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
    // Custo por carta (manual §9.1): talento Custo 0 é jogável com 0 ações.
    const cost = R()?.talentPlayCost?.(card) ?? card.currentPower ?? card.power ?? 0;
    if ((p.actions ?? 0) < cost)
        return { ok: false, state, events: [], error: "INSUFFICIENT_ACTIONS" };
    p.actions = Math.max(0, (p.actions ?? 0) - cost);
    const [removed] = p.hand.splice(handIdx, 1);
    state.activeTalent = { ownerP: pIdx, card: removed, spentActions: cost > 0 ? cost : 0 };
    return {
        ok: true,
        state,
        events: [{ type: "TALENT_STARTED", playerId: pIdx, handIdx, talentEffect: removed.talentEffect, card: removed.name }],
        card: removed,
    };
}
/**
 * Pós-resolve MP: limpa activeTalent e garante carta no discard.
 * Idempotente se já estiver limpo. Não reaplica efeito.
 */
function applyTalentDiscard(state, pIdx) {
    const events = [];
    const at = state.activeTalent;
    if (!at?.card) {
        return { ok: true, state, events: [{ type: "TALENT_DISCARDED", playerId: pIdx, alreadyClear: true }] };
    }
    if (at.ownerP !== pIdx) {
        return { ok: false, state, events, error: "NOT_TALENT_OWNER" };
    }
    const card = at.card;
    state.activeTalent = null;
    const disc = state.players[pIdx].discard || [];
    const uid = card.uid != null ? String(card.uid) : "";
    const already = uid
        ? disc.some((c) => c && String(c.uid || "") === uid)
        : disc.some((c) => c && c === card);
    if (!already) {
        disc.push(card);
        state.players[pIdx].discard = disc;
    }
    events.push({
        type: "TALENT_DISCARDED",
        playerId: pIdx,
        talentEffect: card.talentEffect,
        cardName: card.name,
    });
    return { ok: true, state, events };
}
/**
 * Resolve talento ativo com alvo (autoridade servidor / motor).
 * Talentos sem implementação completa retornam NOT_IMPLEMENTED (fallback snapshot).
 */
function applyTalentTarget(state, pIdx, targetP, targetI) {
    const events = [];
    const at = state.activeTalent;
    if (!at?.card || at.ownerP !== pIdx) {
        return { ok: false, state, events, error: "NO_ACTIVE_TALENT" };
    }
    const effect = at.card.talentEffect;
    const tp = targetP | 0;
    const ti = targetI | 0;
    const target = state.players[tp]?.field?.[ti];
    if (!target && effect !== "zeroAbsoluto") {
        return { ok: false, state, events, error: "NO_TARGET" };
    }
    const clearActive = () => {
        const card = at.card;
        state.activeTalent = null;
        const disc = state.players[pIdx].discard || [];
        disc.push(card);
        state.players[pIdx].discard = disc;
        events.push({
            type: "TALENT_RESOLVED",
            playerId: pIdx,
            talentEffect: effect,
            cardName: card.name,
            targetP: tp,
            targetI: ti,
        });
    };
    switch (effect) {
        case "bolaDeFogoTalento": {
            if (target.barrier) {
                target.barrier = false;
                target.barrierTurns = 0;
                events.push({ type: "BARRIER_BLOCKED", targetP: tp, targetI: ti, visual: "barrier_block" });
            }
            else {
                reduceChampionPower(target, 1);
                events.push({
                    type: "TALENT_BOLA_DE_FOGO", targetP: tp, targetI: ti,
                    powerAfter: target.currentPower, visual: "bola_de_fogo",
                });
                if ((target.currentPower ?? 0) <= 0)
                    destroyAtField(state, tp, ti, events, "bolaDeFogoTalento");
            }
            clearActive();
            break;
        }
        case "explosao": {
            reduceChampionPower(target, 2);
            events.push({
                type: "TALENT_EXPLOSAO", targetP: tp, targetI: ti,
                powerAfter: target.currentPower, visual: "explosao",
            });
            if ((target.currentPower ?? 0) <= 0)
                destroyAtField(state, tp, ti, events, "explosao");
            clearActive();
            break;
        }
        case "fortalecerTalento": {
            if (tp !== pIdx)
                return { ok: false, state, events, error: "ALLY_ONLY" };
            target.currentPower = (target.currentPower ?? target.power ?? 0) + 1;
            target.basePower = (target.basePower ?? target.power ?? 0) + 1;
            events.push({
                type: "TALENT_FORTALECER", targetP: tp, targetI: ti,
                powerAfter: target.currentPower, visual: "strong_arm",
            });
            clearActive();
            break;
        }
        case "baforadaVenenosa": {
            target.poisoned = true;
            target.poisonTurns = Math.max(target.poisonTurns || 0, 2);
            target.poisonedByP = pIdx;
            events.push({
                type: "TALENT_VENENO", targetP: tp, targetI: ti, visual: "baforada_venenosa",
            });
            clearActive();
            break;
        }
        case "zeroAbsoluto": {
            if (!target)
                return { ok: false, state, events, error: "NO_TARGET" };
            if (target.frozen) {
                destroyAtField(state, tp, ti, events, "zeroAbsoluto");
                events.push({ type: "TALENT_ZERO_SHATTER", targetP: tp, targetI: ti, visual: "zero_absoluto" });
            }
            else {
                target.frozen = true;
                target.frozenTurns = 2;
                events.push({ type: "TALENT_ZERO_FREEZE", targetP: tp, targetI: ti, visual: "zero_absoluto" });
            }
            clearActive();
            break;
        }
        default:
            return { ok: false, state, events, error: "NOT_IMPLEMENTED" };
    }
    const winner = R()?.findWinnerIndex(state);
    if (winner != null) {
        state.winner = winner;
        events.push({ type: "GAME_OVER", winner });
    }
    return { ok: true, state, events };
}
const ON_ENTER_RESOLVE_KEYS = [
    "rapidez", "pesadelo", "desacelerar", "roubar", "maldicaoSeteMares", "trocaInjusta",
    "fortalecer", "devorar", "bolaDeFogo", "assassinar", "necromancia", "imitar",
    "ursificacao", "transformarBichinho", "furia", "guardiao", "auraAntiMagia",
    "auraDeFogo", "fumacaToxica", "raioDuplo", "defensor",
    "rajadaCongelante", "corromper", "mordidaVenenosa", "incendiar", "gritoDeGuerra",
    "invokeDragon", "invokeCubicDragon",
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
}
const DfEffectsResolve = {
    cloneState,
    planOnEnter: planOnEnterImpl,
    applyOnEnter: applyOnEnterImpl,
    applyReactiveUse,
    applyTalentFromHand,
    applyTalentTarget,
    applyTalentDiscard,
    swapFieldChamps,
    inferConstantOnDestroy,
    bootstrapResolveRegistry,
};
export function wireEffectsResolveRegistry(effects) {
    bindEffectsRef(effects);
    bootstrapResolveRegistry(effects);
}
export { DfEffectsResolve };
