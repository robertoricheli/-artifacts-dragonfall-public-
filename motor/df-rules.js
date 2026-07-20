// @ts-nocheck
/** Dragonfall — DfRules (motor TS, Fase 2). */
/** Dragonfall — DfRules (motor TS, Fase 2). */
const LIMITS = Object.freeze({
    MAX_ACTIONS: 3,
    MAX_FIELD: 6,
    MAX_HAND: 8,
    PASSIVE_VP_PER_TURN_CAP: 2,
    /** Manual §3: invocar dragão bloqueado com 4+ aliados em campo. */
    INVOKE_DRAGON_MAX_FIELD: 4,
});
/** Invocar dragão/filhote bloqueado com 4+ aliados (manual), independente do teto de campo. */
function invokeDragonBlocked(state, pIdx, card, limits = LIMITS) {
    const p = state.players[pIdx];
    const fcSelf = p?.field?.length ?? 0;
    const maxAllies = limits.INVOKE_DRAGON_MAX_FIELD ?? 4;
    return fcSelf >= maxAllies;
}
/** Exige campeão adversário no campo — NÃO inclui Pesadelo/Roubar/Desacelerar (alvo = jogador). */
const ON_ENTER_NEEDS_ENEMY = Object.freeze([
    "bolaDeFogo", "fumacaToxica", "raioDuplo", "transformarBichinho",
    "assassinar", "trocaInjusta", "rajadaCongelante", "mordidaVenenosa",
]);
const IMITATOR_NAMES = new Set(["WU-KONG", "ENIGMA"]);
function championPrintedPower(c) {
    if (!c)
        return 0;
    return c.basePower ?? c.power ?? 0;
}
function championSummonCost(c) {
    return c?.currentPower ?? c?.power ?? 0;
}
function isOverpower(c) {
    return !!(c && ((c.abilityName === "Sobrepujar" && !c.silenced) || c.guerraBuff));
}
function isResistente(c) {
    return !!(c && c.abilityName === "Resistente" && !c.silenced);
}
function isPesadoDemais(c) {
    return !!(c && c.abilityName === "Pesado Demais" && !c.silenced);
}
function isCrescimentoDragon(c) {
    return !!(c && !c.silenced &&
        (c.name === "FILHOTE DE DRAGÃO" || c.name === "DRAGÃO CÚBICO"));
}
function isImitatorChamp(c) {
    return !!(c && IMITATOR_NAMES.has(c.name));
}
function onEnterNeedsEnemy(onEnter) {
    return ON_ENTER_NEEDS_ENEMY.includes(onEnter);
}
function totalEnemyFieldCount(state, pIdx) {
    let n = 0;
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let ep = 0; ep < count; ep++) {
        if (ep === pIdx)
            continue;
        n += (state.players[ep]?.field?.length ?? 0);
    }
    return n;
}
function gatherEnemyTargets(state, casterIdx, filterFn) {
    const arr = [];
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let p = 0; p < count; p++) {
        if (p === casterIdx)
            continue;
        (state.players[p]?.field || []).forEach((c, i) => {
            if (!filterFn || filterFn(c))
                arr.push({ p, i });
        });
    }
    return arr;
}
function gatherAllyTargets(state, casterIdx, exclude, filter) {
    const arr = [];
    (state.players[casterIdx]?.field || []).forEach((c, i) => {
        if (i === exclude)
            return;
        if (filter && !filter(c))
            return;
        arr.push({ p: casterIdx, i });
    });
    return arr;
}
function normalizeAbilityName(value) {
    return String(value || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
/** Sem Honra nativo, copiado ou concedido por Corromper; Silêncio desativa todos. */
function hasNoHonor(champ) {
    if (!champ || champ.silenced)
        return false;
    if (champ.corruptedNoHonor || champ.onDestroy === "noHonor" || champ.mimicOnDestroy === "noHonor")
        return true;
    return normalizeAbilityName(champ.mimicAbilityName || champ.abilityName).includes("sem honra");
}
/** Habilidade passiva efetiva disparada após a destruição. */
function resolveOnDestroyAbility(champ) {
    if (!champ || champ.silenced)
        return null;
    if (champ.onDestroy)
        return champ.onDestroy;
    if (champ.mimicOnDestroy)
        return champ.mimicOnDestroy;
    const name = normalizeAbilityName(champ.mimicAbilityName || champ.abilityName);
    if (name === "legado")
        return "legado";
    if (name === "vinganca" || name.includes("furia vermelha"))
        return "vinganca";
    if (name === "explosao de gelo")
        return "explosaoGelo";
    if (name === "explosao venenosa")
        return "explosaoVenenosa";
    if (name === "retaliacao")
        return "furiaLegado";
    if (name.includes("sem honra"))
        return "noHonor";
    return null;
}
function getFuryStacks(champ) {
    if (!champ?.fury)
        return 0;
    const stacks = Number(champ.furyStacks);
    if (Number.isFinite(stacks) && stacks > 0)
        return Math.floor(stacks);
    return champ.furyBonusActive ? 1 : 0;
}
/** Concede cargas acumuláveis de Fúria com uma única duração renovada. */
function grantFuryStacks(champ, amount = 1) {
    if (!champ || amount <= 0)
        return 0;
    const add = Math.max(0, Math.floor(amount));
    champ.furyStacks = getFuryStacks(champ) + add;
    champ.fury = champ.furyStacks > 0;
    champ.furyTurns = champ.fury ? 1 : 0;
    champ.furyBonusActive = champ.fury;
    champ.currentPower = (champ.currentPower ?? champ.basePower ?? champ.power ?? 0) + add;
    return add;
}
/** Remove cargas porque houve redução real; o Poder já foi reduzido pelo chamador. */
function consumeFuryStacks(champ, amount) {
    const before = getFuryStacks(champ);
    const removed = Math.min(before, Math.max(0, Math.floor(amount || 0)));
    const remaining = before - removed;
    champ.furyStacks = remaining;
    champ.fury = remaining > 0;
    champ.furyTurns = champ.fury ? Math.max(1, champ.furyTurns || 1) : 0;
    champ.furyBonusActive = champ.fury;
    return removed;
}
/** Expira todas as cargas sem tratar a retirada do bônus como dano real. */
function expireFuryStacks(champ) {
    const stacks = getFuryStacks(champ);
    if (!champ || stacks <= 0)
        return 0;
    champ.currentPower = Math.max(0, (champ.currentPower ?? 0) - stacks);
    champ.furyStacks = 0;
    champ.fury = false;
    champ.furyTurns = 0;
    champ.furyBonusActive = false;
    return stacks;
}
const POWER_REDUCTION_DESTROY_REASONS = Object.freeze([
    "assassinar", "bolaDeFogo", "cometStarfall", "explosao", "fireAura",
    "fireAndIce", "missemagicos", "potion", "raioDuplo", "ultimate",
    "vampirism", "vinganca",
]);
function isCombatOrPowerReductionDestroy(reason) {
    return reason === "combat" || POWER_REDUCTION_DESTROY_REASONS.includes(reason);
}
/**
 * Resolve Explosão de Gelo/Venenosa e Retaliação após retirar o portador.
 * Retorna alvos escolhidos sem repetição; não concede PV imediato.
 */
function applyOnDestroyBurst(state, ownerIdx, champ, reason, rng = Math.random) {
    const ability = resolveOnDestroyAbility(champ);
    if (ability !== "explosaoGelo" && ability !== "explosaoVenenosa" && ability !== "furiaLegado")
        return { ability: null, targets: [], applied: [] };
    if (ability === "explosaoVenenosa" && !isCombatOrPowerReductionDestroy(reason))
        return { ability, targets: [], applied: [] };
    if (ability === "furiaLegado") {
        const targets = gatherAllyTargets(state, ownerIdx, -1, () => true);
        const applied = [];
        for (const target of targets) {
            const ally = state.players[target.p]?.field?.[target.i];
            if (!ally)
                continue;
            grantFuryStacks(ally, 1);
            applied.push({
                ...target,
                name: ally.name,
                furyStacks: getFuryStacks(ally),
            });
        }
        return { ability, targets, applied };
    }
    const pool = gatherEnemyTargets(state, ownerIdx, () => true);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const targets = pool.slice(0, Math.min(2, pool.length));
    const applied = [];
    for (const target of targets) {
        const victim = state.players[target.p]?.field?.[target.i];
        if (!victim)
            continue;
        if (ability === "explosaoGelo") {
            victim.frozen = true;
            victim.frozenTurns = 2;
            applied.push({ ...target, name: victim.name });
        }
        else if (!victim.poisoned) {
            victim.poisoned = true;
            victim.poisonTurns = 2;
            victim.poisonedByP = ownerIdx;
            applied.push({ ...target, name: victim.name });
        }
    }
    return { ability, targets, applied };
}
function hasNecromanciaTarget(state, pIdx) {
    return (state.players[pIdx]?.discard?.length ?? 0) > 0;
}
function hasTrocaInjustaTarget(state, pIdx) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let ep = 0; ep < count; ep++) {
        if (ep === pIdx)
            continue;
        if ((state.players[ep]?.field || []).some((c) => c && c.currentPower === 2))
            return true;
    }
    return false;
}
function hasPesadeloTarget(state, casterIdx) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let i = 0; i < count; i++) {
        if (i === casterIdx || state.players[i]?.skipDraw)
            continue;
        return true;
    }
    return false;
}
function hasRoubarTarget(state, casterIdx) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let i = 0; i < count; i++) {
        if (i === casterIdx)
            continue;
        if ((state.players[i]?.hand?.length ?? 0) > 0)
            return true;
    }
    return false;
}
function hasDesacelerarTarget(state, casterIdx) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let i = 0; i < count; i++) {
        if (i === casterIdx)
            continue;
        if (!state.players[i]?.skipNextAction)
            return true;
    }
    return false;
}
function hasAssassinarTarget(state, casterIdx) {
    return gatherEnemyTargets(state, casterIdx, (c) => c.currentPower === 1).length > 0;
}
function hasTransformarBichinhoTarget(state, casterIdx) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let ep = 0; ep < count; ep++) {
        if (ep === casterIdx)
            continue;
        if ((state.players[ep]?.field || []).some((c) => c.currentPower >= 2 && !c.barrier))
            return true;
    }
    return false;
}
function gatherImitableAllies(state, casterIdx, excludeFieldIdx) {
    const used = state.players[casterIdx]?.onEnterUsedThisTurn || [];
    const oncePerTurnOnEnter = new Set(["pesadelo", "desacelerar", "maldicaoSeteMares"]);
    return gatherAllyTargets(state, casterIdx, excludeFieldIdx, (c) => {
        if (!(c.onEnter || c.onDestroy || (c.abilityType === "constant" && c.abilityName)))
            return false;
        if (c.onEnter === "imitar" || isImitatorChamp(c) || c.mimico || c.silenced)
            return false;
        if (c.onEnter && oncePerTurnOnEnter.has(c.onEnter) && used.includes(c.onEnter))
            return false;
        if (c.onEnter === "pesadelo" && !hasPesadeloTarget(state, casterIdx))
            return false;
        if (c.onEnter === "desacelerar" && !hasDesacelerarTarget(state, casterIdx))
            return false;
        return true;
    });
}
function hasRitualSacrifice(state, pIdx, reqPow) {
    return (state.players[pIdx]?.field || []).some((c) => c.currentPower === reqPow);
}
function listRitualSacrificeIndices(state, pIdx, reqPow) {
    const out = [];
    (state.players[pIdx]?.field || []).forEach((c, i) => {
        if (c.currentPower === reqPow)
            out.push(i);
    });
    return out;
}
/**
 * Contexto padrão para decisões de invocação (IA / simulador).
 * @param {object} state
 * @param {number} pIdx
 */
function summonContextForPlayer(state, pIdx, extra = {}) {
    const fcSelf = state.players[pIdx]?.field?.length ?? 0;
    const enemyFc = totalEnemyFieldCount(state, pIdx);
    return {
        passiveBoardFill: enemyFc === 0 && fcSelf < LIMITS.MAX_FIELD,
        ...extra,
    };
}
/**
 * Verifica se onEnter teria efeito útil ao invocar agora.
 * @returns {{ ok: boolean, code?: string }}
 */
function canOnEnterResolve(state, pIdx, card, ctx) {
    const onEnter = card?.onEnter;
    if (!onEnter)
        return { ok: true };
    if (card?.silenced)
        return { ok: false, code: "SILENCED" };
    const p = state.players[pIdx];
    const fcSelf = p?.field?.length ?? 0;
    const cardOnField = (p?.field || []).includes(card);
    const otherAllies = Math.max(0, fcSelf - (cardOnField ? 1 : 0));
    const enemyFc = totalEnemyFieldCount(state, pIdx);
    const passiveBoardFill = !!ctx.passiveBoardFill;
    if (passiveBoardFill) {
        if (onEnter === "fortalecer" && fcSelf === 0)
            return { ok: false, code: "NO_ALLY_FORTALECER" };
        if (onEnter === "devorar") {
            const devourable = (p.field || []).filter((c) => !c.inspiracao).length;
            if (devourable === 0)
                return { ok: false, code: "NO_DEVOUR_TARGET" };
        }
        if (onEnter === "auraDeFogo" && fcSelf < 1)
            return { ok: false, code: "NO_ALLY_AURA_FOGO" };
        if (onEnter === "gritoDeGuerra" && otherAllies === 0)
            return { ok: false, code: "NO_ALLY_GRITO_GUERRA" };
        if (onEnter === "imitar") {
            const ex = (ctx && ctx.fieldIdx != null) ? (ctx.fieldIdx | 0) : -1;
            if (gatherImitableAllies(state, pIdx, ex).length === 0) {
                return { ok: false, code: "NO_IMITAR_TARGET" };
            }
        }
        if (onEnter === "necromancia" && !hasNecromanciaTarget(state, pIdx)) {
            return { ok: false, code: "EMPTY_DISCARD" };
        }
        if (onEnter === "trocaInjusta" && !hasTrocaInjustaTarget(state, pIdx)) {
            return { ok: false, code: "NO_TROCA_INJUSTA" };
        }
        if ((onEnter === "invokeDragon" || onEnter === "invokeCubicDragon") &&
            invokeDragonBlocked(state, pIdx, card, LIMITS)) {
            return { ok: false, code: "FIELD_FULL_DRAGON" };
        }
        if (onEnter === "ursificacao" && fcSelf === 0)
            return { ok: false, code: "NO_URSIFICACAO" };
        if (onEnter === "guardiao") {
            if ((p.field || []).filter((c) => c && !c.shielded).length === 0) {
                return { ok: false, code: "NO_GUARDIAO" };
            }
        }
        if (enemyFc === 0 && onEnterNeedsEnemy(onEnter)) {
            return { ok: false, code: "NO_ENEMY" };
        }
        return { ok: true };
    }
    if (onEnter === "fortalecer" && fcSelf === 0)
        return { ok: false, code: "NO_ALLY_FORTALECER" };
    if (onEnter === "devorar") {
        const devourable = (p.field || []).filter((c) => !c.inspiracao).length;
        if (devourable === 0)
            return { ok: false, code: "NO_DEVOUR_TARGET" };
    }
    if (onEnter === "bolaDeFogo" && enemyFc === 0)
        return { ok: false, code: "NO_ENEMY" };
    if (onEnter === "fumacaToxica") {
        if (enemyFc === 0)
            return { ok: false, code: "NO_ENEMY" };
        if (ctx.strictFumacaToxica) {
            const enemies = gatherEnemyTargets(state, pIdx, () => true);
            const nonP1 = enemies.filter((t) => championPrintedPower(state.players[t.p]?.field[t.i]) > 1);
            if (enemies.length && !nonP1.length)
                return { ok: false, code: "FUMACA_ONLY_P1" };
        }
    }
    if (onEnter === "raioDuplo" && enemyFc === 0)
        return { ok: false, code: "NO_ENEMY" };
    if (onEnter === "rajadaCongelante" && enemyFc === 0)
        return { ok: false, code: "NO_ENEMY" };
    if (onEnter === "mordidaVenenosa" && enemyFc === 0)
        return { ok: false, code: "NO_ENEMY" };
    if (onEnter === "auraDeFogo" && fcSelf < 1)
        return { ok: false, code: "NO_ALLY_AURA_FOGO" };
    if (onEnter === "gritoDeGuerra" && otherAllies === 0)
        return { ok: false, code: "NO_ALLY_GRITO_GUERRA" };
    if (onEnter === "transformarBichinho" && !hasTransformarBichinhoTarget(state, pIdx)) {
        return { ok: false, code: "NO_TRANSFORM_TARGET" };
    }
    if (onEnter === "imitar") {
        const ex = (ctx && ctx.fieldIdx != null) ? (ctx.fieldIdx | 0) : -1;
        if (gatherImitableAllies(state, pIdx, ex).length === 0) {
            return { ok: false, code: "NO_IMITAR_TARGET" };
        }
    }
    if (onEnter === "assassinar" && !hasAssassinarTarget(state, pIdx)) {
        return { ok: false, code: "NO_ASSASSINAR" };
    }
    if (onEnter === "necromancia" && !hasNecromanciaTarget(state, pIdx)) {
        return { ok: false, code: "EMPTY_DISCARD" };
    }
    if (onEnter === "pesadelo" && !hasPesadeloTarget(state, pIdx)) {
        return { ok: false, code: "NO_PESADELO" };
    }
    if (onEnter === "roubar" && !hasRoubarTarget(state, pIdx)) {
        return { ok: false, code: "NO_ROUBAR" };
    }
    if (onEnter === "desacelerar" && !hasDesacelerarTarget(state, pIdx)) {
        return { ok: false, code: "NO_DESACELERAR" };
    }
    if ((onEnter === "invokeDragon" || onEnter === "invokeCubicDragon") &&
        invokeDragonBlocked(state, pIdx, card, LIMITS)) {
        return { ok: false, code: "FIELD_FULL_DRAGON" };
    }
    if (onEnter === "trocaInjusta" && !hasTrocaInjustaTarget(state, pIdx)) {
        return { ok: false, code: "NO_TROCA_INJUSTA" };
    }
    if (onEnter === "ursificacao" && fcSelf === 0)
        return { ok: false, code: "NO_URSIFICACAO" };
    if (onEnter === "guardiao") {
        if ((p.field || []).filter((c) => c && !c.shielded).length === 0) {
            return { ok: false, code: "NO_GUARDIAO" };
        }
    }
    return { ok: true };
}
/** Índice padrão ao inserir no campo (fileira simétrica: centro → esq → dir…). */
function defaultSummonInsertIndex(fieldLen) {
    const n = Math.max(0, fieldLen | 0);
    if (n <= 0)
        return 0;
    return n % 2 === 1 ? 0 : n;
}
/**
 * Pode invocar campeão da mão?
 * @param {object} state
 * @param {number} pIdx
 * @param {number} handIdx
 * @param {object} [opts]
 * @param {boolean} [opts.freeAction] — ritual / ação livre
 * @param {boolean} [opts.passiveBoardFill]
 * @param {boolean} [opts.avoidEnemyOnEnterWaste] — não invocar onEnter inútil vs campo vazio
 * @param {boolean} [opts.strictFumacaToxica] — IA: exige alvo P>1
 * @param {boolean} [opts.allowRitualPending] — humano em fase ritual (só valida sacrifício)
 */
function canSummon(state, pIdx, handIdx, opts = {}) {
    const limits = opts.limits || LIMITS;
    if (!state?.started || state.winner != null) {
        return { ok: false, code: "GAME_NOT_ACTIVE", reason: "Partida não ativa." };
    }
    if (state.currentPlayer !== pIdx && !opts.ignoreTurn) {
        return { ok: false, code: "NOT_YOUR_TURN", reason: "Não é o turno deste jogador." };
    }
    const p = state.players[pIdx];
    const card = p?.hand?.[handIdx];
    if (!p || !card)
        return { ok: false, code: "NO_CARD", reason: "Carta inválida." };
    if (card.category === "talent") {
        return { ok: false, code: "NOT_CHAMPION", reason: "Não é campeão." };
    }
    if ((p.field?.length ?? 0) >= limits.MAX_FIELD) {
        return { ok: false, code: "FIELD_FULL", reason: "Campo cheio." };
    }
    const freeAction = !!opts.freeAction;
    if (card.summonRitual && !freeAction) {
        if (!hasRitualSacrifice(state, pIdx, card.summonRitual)) {
            return {
                ok: false,
                code: "NO_RITUAL_SACRIFICE",
                reason: `Ritual exige aliado de Poder ${card.summonRitual}.`,
            };
        }
        return { ok: true, code: "RITUAL_OK", ritual: true };
    }
    if (!freeAction && (p.actions ?? 0) < championSummonCost(card)) {
        return { ok: false, code: "INSUFFICIENT_ACTIONS", reason: "Ações insuficientes." };
    }
    const ctx = {
        passiveBoardFill: opts.passiveBoardFill,
        strictFumacaToxica: !!opts.strictFumacaToxica,
    };
    if (ctx.passiveBoardFill === undefined) {
        Object.assign(ctx, summonContextForPlayer(state, pIdx));
    }
    const noEnemies = totalEnemyFieldCount(state, pIdx) === 0;
    if (opts.avoidEnemyOnEnterWaste && noEnemies && onEnterNeedsEnemy(card.onEnter)) {
        return { ok: false, code: "WASTED_ON_ENTER", reason: "Habilidade exige adversário." };
    }
    const allowWastedOnEnter = opts.allowWastedOnEnter ?? !opts.avoidEnemyOnEnterWaste;
    const onEnterCheck = (typeof globalThis !== "undefined" && globalThis.DfEffects?.canOnEnter)
        ? globalThis.DfEffects.canOnEnter(state, pIdx, card, ctx)
        : canOnEnterResolve(state, pIdx, card, ctx);
    if (!onEnterCheck.ok && !allowWastedOnEnter) {
        return {
            ok: false,
            code: onEnterCheck.code || "ON_ENTER_BLOCKED",
            reason: "Habilidade onEnter não teria efeito.",
        };
    }
    return { ok: true, code: "OK" };
}
/** Índices na mão invocáveis agora. */
function listSummonableHandIndices(state, pIdx, opts = {}) {
    const p = state.players[pIdx];
    if (!p?.hand?.length)
        return [];
    const out = [];
    for (let i = 0; i < p.hand.length; i++) {
        if (canSummon(state, pIdx, i, opts).ok)
            out.push(i);
    }
    return out;
}
/** PV passivo na manutenção (+1 por campeão, cap 2). */
function computePassiveVpGain(fieldCount, cap = LIMITS.PASSIVE_VP_PER_TURN_CAP) {
    const n = Math.max(0, fieldCount | 0);
    if (n <= 0)
        return 0;
    return Math.min(n, cap);
}
/** Índice do vencedor ou null. */
function findWinnerIndex(state) {
    if (state.winner != null)
        return state.winner;
    const wp = state.winPoints ?? 15;
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let i = 0; i < count; i++) {
        if ((state.players[i]?.vp ?? 0) >= wp)
            return i;
    }
    return null;
}
function canDraw(state, pIdx, limits = LIMITS) {
    const p = state.players[pIdx];
    if (!p)
        return { ok: false, code: "NO_PLAYER" };
    if ((p.deck?.length ?? 0) < 1)
        return { ok: false, code: "DECK_EMPTY" };
    if ((p.hand?.length ?? 0) >= limits.MAX_HAND)
        return { ok: false, code: "HAND_FULL" };
    return { ok: true, code: "OK" };
}
function attackIsFree(attacker) {
    return !!(attacker && attacker.freeAttack && !isPesadoDemais(attacker));
}
function cannotHitResistente(attacker) {
    return !!(attacker && attacker.freeAttack);
}
function getAttackActionCost(attacker, defender) {
    if (attackIsFree(attacker))
        return 0;
    let cost = 1;
    if (defender && isResistente(defender))
        cost = 2;
    if (isPesadoDemais(attacker))
        cost = Math.max(cost, 2);
    return cost;
}
function canAttackerTargetDefender(attacker, defender, opts = {}) {
    if (!defender || defender.shielded || defender.pulled)
        return false;
    if (isPesadoDemais(attacker) && isResistente(defender))
        return false;
    if (isResistente(defender) && cannotHitResistente(attacker))
        return false;
    if (opts.requireAttackerPowerGte) {
        const aPow = attacker?.currentPower ?? attacker?.power ?? 0;
        const dPow = defender?.currentPower ?? defender?.power ?? 0;
        if (aPow < dPow)
            return false;
    }
    return true;
}
/**
 * Pode este atacante atacar este defensor agora?
 */
function canAttack(state, attOwner, attIdx, defOwner, defIdx, opts = {}) {
    const limits = opts.limits || LIMITS;
    if (!state?.started || state.winner != null) {
        return { ok: false, code: "GAME_NOT_ACTIVE" };
    }
    const p = state.players[attOwner];
    const att = p?.field?.[attIdx];
    const def = state.players[defOwner]?.field?.[defIdx];
    if (!att || !def)
        return { ok: false, code: "INVALID_UNITS" };
    if (att.tapped || att.frozen)
        return { ok: false, code: "ATTACKER_EXHAUSTED" };
    const requireAttackerPowerGte = opts.requireAttackerPowerGte
        ?? !!state.players[attOwner]?.isAI;
    if (!canAttackerTargetDefender(att, def, { requireAttackerPowerGte })) {
        return { ok: false, code: "INVALID_TARGET" };
    }
    const cost = getAttackActionCost(att, def);
    if (!attackIsFree(att) && (p.actions ?? 0) < cost) {
        return { ok: false, code: "INSUFFICIENT_ACTIONS" };
    }
    return { ok: true, code: "OK", actionCost: cost };
}
function combatOutcome(a, d) {
    const oa = isOverpower(a);
    const od = isOverpower(d);
    if (a.currentPower > d.currentPower) {
        return { killA: false, killD: true, pvTo: "attacker", swords: ["d"] };
    }
    if (a.currentPower < d.currentPower) {
        return { killA: true, killD: false, pvTo: "defender", swords: ["a"] };
    }
    if (oa && !od)
        return { killA: false, killD: true, pvTo: "attacker", swords: ["d"], over: true };
    if (!oa && od)
        return { killA: true, killD: false, pvTo: "defender", swords: ["a"], over: true };
    if (oa && od)
        return { killA: false, killD: false, pvTo: null, swords: ["a", "d"] };
    return { killA: true, killD: true, pvTo: null, swords: ["a", "d"] };
}
/** Recompensa de uma destruição válida em combate; Sem Honra é avaliado no alvo. */
function combatVictoryPointReward(winner) {
    return winner && !winner.silenced &&
        (winner.constantEffect === "recompensaDupla" || winner.abilityName === "Recompensa Dupla")
        ? 2
        : 1;
}
/** Lista pares de ataque legais para um jogador. */
function listLegalAttacks(state, attOwner) {
    const moves = [];
    const p = state.players[attOwner];
    if (!p)
        return moves;
    (p.field || []).forEach((att, attIdx) => {
        if (att.tapped || att.frozen)
            return;
        const count = state.playersCount ?? state.players?.length ?? 0;
        for (let ep = 0; ep < count; ep++) {
            if (ep === attOwner)
                continue;
            (state.players[ep]?.field || []).forEach((def, defIdx) => {
                if (canAttack(state, attOwner, attIdx, ep, defIdx).ok) {
                    moves.push({ attOwner, attIdx, defOwner: ep, defIdx });
                }
            });
        }
    });
    return moves;
}
const REACTIVE_TALENTS = Object.freeze({
    BLOCK: "bloquearAtaque",
    PROTECTION: "protecaoDivina",
    CANCEL_ULT: "cancelarUltimate",
});
function findReactiveTalentHandIndex(state, pIdx, talentEffect) {
    const hand = state.players[pIdx]?.hand;
    if (!hand?.length)
        return -1;
    return hand.findIndex((c) => c && c.talentEffect === talentEffect);
}
function canOfferReactiveBlock(state, defOwner, attOwner) {
    if (defOwner === attOwner)
        return { ok: false, code: "SAME_PLAYER" };
    if (!state?.started || state.winner != null)
        return { ok: false, code: "GAME_NOT_ACTIVE" };
    const idx = findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.BLOCK);
    if (idx < 0)
        return { ok: false, code: "NO_CARD" };
    return { ok: true, code: "OK", handIdx: idx };
}
function canOfferReactiveProtection(state, defOwner, attOwner) {
    if (defOwner === attOwner)
        return { ok: false, code: "SAME_PLAYER" };
    const idx = findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.PROTECTION);
    if (idx < 0)
        return { ok: false, code: "NO_CARD" };
    return { ok: true, code: "OK", handIdx: idx };
}
function canOfferCancelUltimate(state, defOwner, attOwner) {
    if (defOwner === attOwner)
        return { ok: false, code: "SAME_PLAYER" };
    const idx = findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.CANCEL_ULT);
    if (idx < 0)
        return { ok: false, code: "NO_CARD" };
    return { ok: true, code: "OK", handIdx: idx };
}
/** Legalidade de onEnter para campeão já em campo (ex.: imitar). */
function canResolveOnEnter(state, pIdx, fieldIdx, ctx = {}) {
    const champ = state.players[pIdx]?.field?.[fieldIdx];
    if (!champ?.onEnter)
        return { ok: true, code: "NO_ON_ENTER" };
    const merged = { ...summonContextForPlayer(state, pIdx), ...ctx };
    if (typeof globalThis !== "undefined" && globalThis.DfEffects?.canOnEnter) {
        return globalThis.DfEffects.canOnEnter(state, pIdx, champ, merged);
    }
    return canOnEnterResolve(state, pIdx, champ, merged);
}
function canEndTurn(state, pIdx) {
    if (!state?.started || state.winner != null)
        return { ok: false, code: "GAME_NOT_ACTIVE" };
    if (state.currentPlayer !== pIdx)
        return { ok: false, code: "NOT_YOUR_TURN" };
    return { ok: true, code: "OK" };
}
function canBuyCard(state, pIdx, limits = LIMITS) {
    if (!state?.started || state.winner != null)
        return { ok: false, code: "GAME_NOT_ACTIVE" };
    if (state.currentPlayer !== pIdx)
        return { ok: false, code: "NOT_YOUR_TURN" };
    const p = state.players[pIdx];
    if (!p)
        return { ok: false, code: "NO_PLAYER" };
    if ((p.actions ?? 0) < 1)
        return { ok: false, code: "INSUFFICIENT_ACTIONS" };
    if ((p.deck?.length ?? 0) < 1)
        return { ok: false, code: "DECK_EMPTY" };
    if ((p.hand?.length ?? 0) >= limits.MAX_HAND)
        return { ok: false, code: "HAND_FULL" };
    return { ok: true, code: "OK" };
}
/**
 * Plano puro de manutenção (sem DOM/destruição com efeitos colaterais).
 * @returns {{ passiveVpGain: number, poisonKills: Array<{p,i}>, growth: boolean, expireWallBonus: boolean, clearGuerra: boolean }}
 */
function computeMaintenancePlan(state, pIdx) {
    const p = state.players[pIdx];
    const n = p?.field?.length ?? 0;
    const poisonKills = [];
    for (let ep = 0; ep < (state.playersCount ?? state.players?.length ?? 0); ep++) {
        (state.players[ep]?.field || []).forEach((c, ci) => {
            if (c.poisoned && c.poisonedByP === pIdx && (c.poisonTurns ?? 0) <= 0) {
                poisonKills.push({ p: ep, i: ci });
            }
        });
    }
    return {
        passiveVpGain: computePassiveVpGain(n),
        poisonKills,
        growth: true,
        expireWallBonus: !!p?.wallActive,
        clearGuerra: !!p?.guerraActive,
    };
}
/**
 * Reduz Poder do campeão. Redução real dissolve Muralha e consome primeiro
 * a mesma quantidade de cargas de Fúria, preservando o Poder permanente.
 * @returns {{ dissolvedWall: boolean, clearedFury: boolean, furyStacksRemoved: number }}
 */
function reduceChampionPower(champ, amount, opts = {}) {
    if (!champ || amount <= 0)
        return { dissolvedWall: false, clearedFury: false, furyStacksRemoved: 0 };
    const prev = champ.currentPower ?? 0;
    if (champ.vulnerable) {
        champ.currentPower = 0;
    }
    else {
        champ.currentPower = Math.max(0, prev - amount);
    }
    const powerLost = champ.currentPower < prev;
    let dissolvedWall = false;
    if (!opts.preserveWallBuff && champ.wallBuff && powerLost) {
        champ.wallBuff = false;
        champ.wallBuffApplied = false;
        champ.wallBuffSnapshot = null;
        dissolvedWall = true;
    }
    const actualLoss = Math.max(0, prev - (champ.currentPower ?? 0));
    const furyStacksRemoved = powerLost
        ? consumeFuryStacks(champ, champ.vulnerable ? getFuryStacks(champ) : actualLoss)
        : 0;
    return {
        dissolvedWall,
        clearedFury: furyStacksRemoved > 0 && getFuryStacks(champ) === 0,
        furyStacksRemoved,
    };
}
/** Início do turno do dono da Muralha: remove o +1 temporário (só quem tem wallBuff). */
function expireWallBonusOnTurnStart(state, pIdx) {
    const p = state.players[pIdx];
    if (!p?.wallActive)
        return;
    (p.field || []).forEach((c) => {
        if (c.wallBuff && c.wallBuffApplied) {
            c.currentPower = Math.max(0, (c.currentPower ?? 0) - 1);
            c.wallBuffApplied = false;
            c.wallBuffSnapshot = null;
        }
    });
}
/** Fim do turno do dono da Muralha: +1 Poder fora do turno (só aliados com wallBuff). */
function applyWallBonusOnTurnEnd(state, endingPIdx) {
    const endingP = state.players[endingPIdx];
    if (!endingP?.wallActive)
        return;
    (endingP.field || []).forEach((c) => {
        if (c.wallBuff && !c.wallBuffApplied) {
            c.currentPower = (c.currentPower ?? 0) + 1;
            c.wallBuffApplied = true;
            c.wallBuffSnapshot = c.currentPower;
        }
    });
}
/**
 * Aplica contadores de manutenção mutáveis no estado (cópia ou ao vivo).
 * Não remove campeões envenenados — use poisonKills do plano.
 */
function applyMaintenanceCounters(state, pIdx) {
    const p = state.players[pIdx];
    if (!p)
        return;
    (p.field || []).forEach((c) => {
        if (isCrescimentoDragon(c))
            c.currentPower = (c.currentPower ?? 0) + 1;
        if (c.foreverGrowth && !c.silenced)
            c.currentPower = (c.currentPower ?? 0) + 1;
        if (c.frozen && c.frozenTurns > 0) {
            c.frozenTurns -= 1;
            if (c.frozenTurns <= 0) {
                c.frozen = false;
                c.frozenTurns = 0;
            }
        }
        if (c.barrier && !c.barrierPermanent && c.barrierTurns > 0) {
            c.barrierTurns -= 1;
            if (c.barrierTurns <= 0) {
                c.barrier = false;
                c.barrierTurns = 0;
            }
        }
        if (c.fireAura && c.fireAuraTurns > 0) {
            c.fireAuraTurns -= 1;
            if (c.fireAuraTurns <= 0) {
                c.fireAura = false;
                c.fireAuraTurns = 0;
            }
        }
        if (c.shielded && c.shieldedTurns > 0) {
            c.shieldedTurns -= 1;
            if (c.shieldedTurns <= 0) {
                c.shielded = false;
                c.shieldedTurns = 0;
            }
        }
        c.tiroDuploUsedThisTurn = false;
        if (c.poisoned && c.poisonedByP === pIdx && c.poisonTurns > 0) {
            c.poisonTurns -= 1;
        }
    });
    expireWallBonusOnTurnStart(state, pIdx);
    if (p.guerraActive) {
        const count = state.playersCount ?? state.players?.length ?? 0;
        for (let ep = 0; ep < count; ep++) {
            (state.players[ep]?.field || []).forEach((c) => {
                if (c.guerraBuff) {
                    c.guerraBuff = false;
                    c.guerraBuffTurns = 0;
                }
            });
        }
        p.guerraActive = false;
    }
}
/** Início de turno após manutenção (ações, untap, draw flags). */
function applyTurnRefresh(state, pIdx, limits = LIMITS) {
    const p = state.players[pIdx];
    if (!p)
        return;
    if (p.skipNextAction) {
        p.actions = Math.max(0, limits.MAX_ACTIONS - 1);
        p.skipNextAction = false;
    }
    else {
        p.actions = limits.MAX_ACTIONS;
    }
    p.usedUltimateThisTurn = false;
    (p.field || []).forEach((c) => {
        c.tapped = false;
        c.freeAttack = false;
        if (c.abilityName === "Investida" && !c.silenced)
            c.freeAttack = true;
        if (c.constantEffect === "tiroDuplo" && !c.silenced)
            c.freeAttack = true;
    });
}
/** Remove campeão do campo → descarte (sem efeitos colaterais de combate). */
function discardChampionAt(state, pIdx, fieldIdx) {
    const champ = state.players[pIdx]?.field?.[fieldIdx];
    if (!champ)
        return null;
    state.players[pIdx].field.splice(fieldIdx, 1);
    state.players[pIdx].discard = state.players[pIdx].discard || [];
    state.players[pIdx].discard.push(champ);
    return champ;
}
/**
 * Ticks de status no início do turno (congelamento, escudo, fúria, barreira, aura).
 * @returns {{ unfroze: boolean, changed: boolean, logs: string[] }}
 */
function applyTurnStartStatusTicks(state, pIdx) {
    const p = state.players[pIdx];
    const logs = [];
    if (!p?.field)
        return { unfroze: false, changed: false, logs };
    let unfroze = false;
    let changed = false;
    p.field.forEach((c) => {
        if (c.frozen && c.frozenTurns > 0) {
            c.frozenTurns -= 1;
            if (c.frozenTurns <= 0) {
                c.frozen = false;
                c.frozenTurns = 0;
                unfroze = true;
            }
        }
        if (c.barrier && !c.barrierPermanent && c.barrierTurns > 0) {
            c.barrierTurns -= 1;
            if (c.barrierTurns <= 0) {
                c.barrier = false;
                c.barrierTurns = 0;
                changed = true;
                logs.push(`${c.name}: Barreira expirou.`);
            }
        }
        if (c.fireAura && c.fireAuraTurns > 0) {
            c.fireAuraTurns -= 1;
            if (c.fireAuraTurns <= 0) {
                c.fireAura = false;
                c.fireAuraTurns = 0;
                changed = true;
                logs.push(`${c.name}: Aura de Fogo expirou.`);
            }
        }
        c.tiroDuploUsedThisTurn = false;
        if (c.shielded && c.shieldedTurns > 0) {
            c.shieldedTurns -= 1;
            if (c.shieldedTurns <= 0) {
                c.shielded = false;
                c.shieldedTurns = 0;
                changed = true;
            }
        }
        if (c.fury && c.furyTurns > 0) {
            c.furyTurns -= 1;
            if (c.furyTurns <= 0) {
                const expired = expireFuryStacks(c);
                if (expired > 0)
                    logs.push(`${c.name}: Fúria expirou (-${expired} Poder).`);
                changed = true;
            }
        }
    });
    if (unfroze)
        logs.push(`${p.name} teve campeões descongelados automaticamente.`);
    return { unfroze, changed, logs };
}
/** Devolve campeões puxados ao dono quando o contador zera. */
function returnPulledChampions(state, pIdx) {
    const p = state.players[pIdx];
    const returned = [];
    if (!p?.field)
        return returned;
    const stillHere = [];
    for (const c of p.field) {
        if (c.pulled) {
            c.pulledTurns -= 1;
            if (c.pulledTurns <= 0) {
                const ownerIdx = c.pulledFromOwner;
                c.pulled = false;
                c.tapped = true;
                c.pulledFromOwner = -1;
                c.pulledTurns = 0;
                if (ownerIdx >= 0 && state.players[ownerIdx]) {
                    state.players[ownerIdx].field.push(c);
                    returned.push({ name: c.name, ownerIdx });
                }
                else {
                    stillHere.push(c);
                }
                continue;
            }
        }
        stillHere.push(c);
    }
    p.field = stillHere;
    return returned;
}
/**
 * Fase pura de manutenção no início do turno de pIdx.
 * Não compra carta — retorna flags para a view.
 * @returns {{ plan: object, poisonDestroyed: object[], returned: object[], statusLogs: string[], passiveVpGain: number, skipDraw: boolean }}
 */
function runTurnMaintenance(state, pIdx, limits = LIMITS) {
    const status = applyTurnStartStatusTicks(state, pIdx);
    applyMaintenanceCounters(state, pIdx);
    const plan = computeMaintenancePlan(state, pIdx);
    const poisonDestroyed = [];
    let poisonVpGain = 0;
    const kills = [...plan.poisonKills].sort((a, b) => (a.p !== b.p ? a.p - b.p : b.i - a.i));
    for (const k of kills) {
        const ch = discardChampionAt(state, k.p, k.i);
        if (ch) {
            const burst = applyOnDestroyBurst(state, k.p, ch, "poison");
            poisonDestroyed.push({ ...k, name: ch.name, burst });
            poisonVpGain += 1;
        }
    }
    const p = state.players[pIdx];
    if (plan.passiveVpGain > 0)
        p.vp += plan.passiveVpGain;
    if (poisonVpGain > 0)
        p.vp += poisonVpGain;
    const returned = returnPulledChampions(state, pIdx);
    const skipDraw = !!p.skipDraw;
    if (p.skipDraw)
        p.skipDraw = false;
    applyTurnRefresh(state, pIdx, limits);
    return {
        plan,
        poisonDestroyed,
        returned,
        statusLogs: status.logs,
        passiveVpGain: plan.passiveVpGain,
        poisonVpGain,
        skipDraw,
    };
}
/** Lista reativas oferecíveis para defOwner contra attOwner. */
function listOfferableReactives(state, defOwner, attOwner) {
    const out = [];
    if (canOfferReactiveBlock(state, defOwner, attOwner).ok) {
        out.push({ effect: REACTIVE_TALENTS.BLOCK, handIdx: findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.BLOCK) });
    }
    if (canOfferReactiveProtection(state, defOwner, attOwner).ok) {
        out.push({ effect: REACTIVE_TALENTS.PROTECTION, handIdx: findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.PROTECTION) });
    }
    if (canOfferCancelUltimate(state, defOwner, attOwner).ok) {
        out.push({ effect: REACTIVE_TALENTS.CANCEL_ULT, handIdx: findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.CANCEL_ULT) });
    }
    return out;
}
/**
 * Lista ações legais de alto nível (IA / simulador).
 * @returns {Array<{ type: string, [key: string]: unknown }>}
 */
function listLegalActions(state, pIdx, opts = {}) {
    const actions = [];
    const T = opts.actionTypes || {};
    const summonOpts = {
        ...summonContextForPlayer(state, pIdx),
        strictFumacaToxica: !!opts.strictFumacaToxica,
        avoidEnemyOnEnterWaste: !!opts.avoidEnemyOnEnterWaste,
        allowWastedOnEnter: opts.allowWastedOnEnter ?? !opts.avoidEnemyOnEnterWaste,
    };
    if (canEndTurn(state, pIdx).ok) {
        actions.push({ type: T.END_TURN || "END_TURN", playerId: pIdx });
    }
    listSummonableHandIndices(state, pIdx, summonOpts).forEach((handIdx) => {
        actions.push({ type: T.SUMMON || "SUMMON", playerId: pIdx, handIdx });
    });
    listLegalAttacks(state, pIdx).forEach((m) => {
        actions.push({
            type: T.ATTACK_RESOLVE || "ATTACK_RESOLVE",
            playerId: pIdx,
            attackerIdx: m.attIdx,
            defenderPlayerId: m.defOwner,
            defenderIdx: m.defIdx,
        });
    });
    if (canBuyCard(state, pIdx).ok) {
        actions.push({ type: T.DRAW_CARD || "DRAW_CARD", playerId: pIdx });
    }
    return actions;
}
const DfRules = {
    LIMITS,
    ON_ENTER_NEEDS_ENEMY,
    invokeDragonBlocked,
    championPrintedPower,
    championSummonCost,
    isOverpower,
    isResistente,
    isPesadoDemais,
    isCrescimentoDragon,
    onEnterNeedsEnemy,
    totalEnemyFieldCount,
    gatherEnemyTargets,
    gatherAllyTargets,
    hasNoHonor,
    resolveOnDestroyAbility,
    getFuryStacks,
    grantFuryStacks,
    consumeFuryStacks,
    expireFuryStacks,
    POWER_REDUCTION_DESTROY_REASONS,
    isCombatOrPowerReductionDestroy,
    applyOnDestroyBurst,
    gatherImitableAllies,
    hasNecromanciaTarget,
    hasTrocaInjustaTarget,
    hasPesadeloTarget,
    hasRoubarTarget,
    hasDesacelerarTarget,
    hasAssassinarTarget,
    hasRitualSacrifice,
    listRitualSacrificeIndices,
    hasTransformarBichinhoTarget,
    summonContextForPlayer,
    defaultSummonInsertIndex,
    canOnEnterResolve,
    canSummon,
    listSummonableHandIndices,
    computePassiveVpGain,
    findWinnerIndex,
    canDraw,
    getAttackActionCost,
    canAttackerTargetDefender,
    canAttack,
    combatOutcome,
    combatVictoryPointReward,
    listLegalAttacks,
    REACTIVE_TALENTS,
    findReactiveTalentHandIndex,
    canOfferReactiveBlock,
    canOfferReactiveProtection,
    canOfferCancelUltimate,
    canResolveOnEnter,
    canEndTurn,
    canBuyCard,
    computeMaintenancePlan,
    reduceChampionPower,
    expireWallBonusOnTurnStart,
    applyWallBonusOnTurnEnd,
    applyMaintenanceCounters,
    applyTurnRefresh,
    discardChampionAt,
    applyTurnStartStatusTicks,
    returnPulledChampions,
    runTurnMaintenance,
    listOfferableReactives,
    listLegalActions,
};
export { DfRules };
