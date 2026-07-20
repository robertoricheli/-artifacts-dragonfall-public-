function motor() {
    return globalThis;
}
function rules() {
    const R = motor().DfRules;
    if (!R)
        throw new Error("NO_RULES");
    return R;
}
function data() {
    const D = motor().DfData;
    if (!D)
        throw new Error("NO_DATA");
    return D;
}
export function getMaxUltimateUses(heroId) {
    const four = new Set([
        "vaughan", "linguarudo", "pirate", "euravia",
        "ironGuard", "thor",
    ]);
    const three = new Set([
        "iceWitch", "princesaSlime", "jekiro", "sangueDragao", "gancho",
        "paladino", "alquimista", "valmont", "tecnomago",
        "quimera", "hercules", "sinistrela", "estrelar",
    ]);
    if (four.has(heroId))
        return 4;
    if (three.has(heroId))
        return 3;
    return 4;
}
function clone(x) {
    return JSON.parse(JSON.stringify(x));
}
function heroDef(heroId) {
    return data().heroDefs.find((h) => h.id === heroId) || null;
}
function allyCanGainPower(c) {
    return !!c;
}
function cannotReceiveInvestida(c) {
    const R = rules();
    return c && (c.name === "BANJO" || (R.isPesadoDemais?.(c) ?? false));
}
function championBanishable(c) {
    const R = rules();
    return (R.championPrintedPower?.(c) ?? (c.basePower ?? c.power)) <= 2;
}
function newUid(prefix = "u") {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
function consumeBarrier(champ) {
    if (!champ?.barrier)
        return false;
    champ.barrier = false;
    champ.barrierTurns = 0;
    return true;
}
function reducePower(champ, amount) {
    const R = rules();
    if (R.reduceChampionPower)
        return R.reduceChampionPower(champ, amount);
    champ.currentPower = Math.max(0, (champ.currentPower ?? 0) - amount);
    return { dissolvedWall: false };
}
function inferConstantOnDestroy(champ) {
    if (!champ || champ.silenced)
        return null;
    if (champ.onDestroy)
        return String(champ.onDestroy);
    const norm = (s) => String(s || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const n = norm(String(champ.mimicAbilityName || champ.abilityName || ""));
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
function resolveOnDestroy(champ) {
    return inferConstantOnDestroy(champ);
}
function normalizeChampPower(champ) {
    if (typeof champ.currentPower !== "number") {
        champ.currentPower = (champ.basePower ?? champ.power ?? 0);
    }
}
function destroyChampion(state, ownerIdx, fieldIdx, killerIdx, opts = {}, events, rng) {
    const owner = state.players[ownerIdx];
    const field = owner.field;
    const target = field[fieldIdx];
    if (!target)
        return;
    field.splice(fieldIdx, 1);
    owner.discard.push(target);
    owner.lastDestroyedSummon = { name: target.name, discardRef: target };
    if (target.category === "champion") {
        if (!owner.destroyedChampions)
            owner.destroyedChampions = [];
        owner.destroyedChampions.push(target);
    }
    const noHonor = rules().hasNoHonor
        ? rules().hasNoHonor(target)
        : resolveOnDestroy(target) === "noHonor" && !target.silenced;
    if (killerIdx != null && !opts.noVpOnKill && !noHonor) {
        state.players[killerIdx].vp =
            (state.players[killerIdx].vp ?? 0) + 1;
        events.push({ type: "VP_GAIN", playerId: killerIdx, amount: 1, reason: opts.reason || "destroy" });
    }
    if (resolveOnDestroy(target) === "vinganca" && !target.silenced) {
        const enemies = [];
        for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
            if (p === ownerIdx)
                continue;
            (state.players[p]?.field || []).forEach((c, i) => {
                if (c)
                    enemies.push({ p, i });
            });
        }
        if (enemies.length) {
            const pick = enemies[Math.floor(rng() * enemies.length)];
            const victim = state.players[pick.p]?.field?.[pick.i];
            if (victim) {
                reducePower(victim, 1);
                if (victim.currentPower <= 0) {
                    destroyChampion(state, pick.p, pick.i, null, { noVpOnKill: true }, events, rng);
                }
            }
        }
    }
    if (resolveOnDestroy(target) === "legado" && !target.silenced) {
        const allies = rules().gatherAllyTargets(state, ownerIdx, -1);
        if (allies.length) {
            const pick = allies[Math.floor(rng() * allies.length)];
            const ben = state.players[pick.p]?.field?.[pick.i];
            if (ben && allyCanGainPower(ben))
                ben.currentPower = (ben.currentPower ?? 0) + 1;
        }
    }
    if (target.fireAura && target.fireAuraTurns > 0 && !target.silenced) {
        const enemies = [];
        for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
            if (p === ownerIdx)
                continue;
            (state.players[p]?.field || []).forEach((c, i) => {
                if (c)
                    enemies.push({ p, i });
            });
        }
        if (enemies.length) {
            const pick = enemies[Math.floor(rng() * enemies.length)];
            const victim = state.players[pick.p]?.field?.[pick.i];
            if (victim) {
                reducePower(victim, 1);
                if (victim.currentPower <= 0) {
                    destroyChampion(state, pick.p, pick.i, null, { noVpOnKill: true, reason: "fireAura" }, events, rng);
                }
            }
        }
    }
    const reason = opts.reason || "ultimate";
    const burst = rules().applyOnDestroyBurst?.(state, ownerIdx, target, reason, rng);
    if (burst?.ability) {
        events.push({
            type: "ON_DESTROY_BURST",
            ownerIdx,
            source: target.name,
            reason,
            ...burst,
        });
    }
    events.push({ type: "DESTROY", p: ownerIdx, i: fieldIdx, reason, killer: killerIdx });
}
function pickTrickerySwapTarget(state, casterIdx, rng) {
    const pow2 = [];
    const pow3plus = [];
    const pow1 = [];
    for (let ep = 0; ep < (state.playersCount ?? state.players.length); ep++) {
        if (ep === casterIdx)
            continue;
        (state.players[ep]?.field || []).forEach((c, i) => {
            const pw = c.currentPower;
            if (pw === 2)
                pow2.push({ p: ep, i });
            else if (pw >= 3)
                pow3plus.push({ p: ep, i });
            else if (pw === 1)
                pow1.push({ p: ep, i });
        });
    }
    const pool = pow2.length ? pow2 : (pow3plus.length ? pow3plus : pow1);
    if (!pool.length)
        return null;
    return pool[Math.floor(rng() * pool.length)];
}
function performTrickerySwap(state, casterIdx, allyI, enemyP, enemyI) {
    const a = state.players[casterIdx]?.field?.[allyI];
    const e = state.players[enemyP]?.field?.[enemyI];
    if (!a || !e)
        return;
    for (const ch of [a, e]) {
        ch.freeAttack = false;
        if (!ch.shieldedPermanent) {
            ch.shielded = false;
            ch.shieldedTurns = 0;
        }
        ch.guerraBuff = false;
        ch.guerraBuffTurns = 0;
    }
    state.players[casterIdx].field[allyI] = e;
    state.players[enemyP].field[enemyI] = a;
}
function pickHookTarget(state, casterIdx, rng) {
    const pow1 = [];
    const pow2 = [];
    for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
        if (p === casterIdx)
            continue;
        (state.players[p]?.field || []).forEach((c, i) => {
            if (c.currentPower === 1)
                pow1.push({ p, i });
            else if (c.currentPower === 2)
                pow2.push({ p, i });
        });
    }
    if (!pow1.length && !pow2.length)
        return null;
    const usePow1 = pow1.length > 0 && (pow2.length === 0 || rng() < 0.65);
    const pool = usePow1 ? pow1 : pow2;
    return pool[Math.floor(rng() * pool.length)];
}
function pickPaladinoPower2Discard(state, pIdx, rng) {
    const pl = state.players[pIdx];
    const pool = [];
    (pl.discard || []).forEach((ref) => {
        if (!ref || ref.category !== "champion")
            return;
        let baseDef = data().cardDefs.find((d) => d.name === ref.name);
        if (!baseDef)
            baseDef = data().dragonTokenDef(String(ref.name));
        if (!baseDef || baseDef.power !== 2)
            return;
        pool.push({ ref, baseDef });
    });
    if (!pool.length)
        return null;
    return pool[Math.floor(rng() * pool.length)];
}
function paladinoRevive(state, pIdx, pick, events) {
    const pl = state.players[pIdx];
    const R = rules();
    if (pl.field.length >= (R.LIMITS?.MAX_FIELD ?? 6))
        return false;
    const dIdx = pl.discard.indexOf(pick.ref);
    if (dIdx >= 0)
        pl.discard.splice(dIdx, 1);
    const isConstant = pick.baseDef.abilityType === "constant" || !!pick.baseDef.constantEffect;
    const revived = {
        ...pick.baseDef,
        uid: newUid(),
        currentPower: pick.baseDef.power,
        basePower: pick.baseDef.power,
        tapped: false,
        frozen: false,
        isToken: false,
        silenced: !isConstant,
    };
    pl.field.push(revived);
    events.push({ type: "SUMMON", playerId: pIdx, fieldIdx: pl.field.length - 1, card: revived, reason: "paladinoUlt" });
    return true;
}
function drawCardFree(state, pIdx, events) {
    const pl = state.players[pIdx];
    const R = rules();
    if (pl.hand.length >= (R.LIMITS.MAX_HAND ?? 8))
        return false;
    const deck = pl.deck;
    const card = deck.pop();
    if (!card)
        return false;
    pl.hand.push(card);
    events.push({ type: "DRAW", playerId: pIdx, card, reason: "ultimate" });
    return true;
}
function summonDragonToken(state, pIdx, events) {
    const pl = state.players[pIdx];
    const def = clone(data().cubicDragonDef);
    const champ = {
        ...def,
        uid: newUid(),
        currentPower: def.power,
        basePower: def.power,
        tapped: false,
        frozen: false,
        isToken: true,
    };
    pl.field.push(champ);
    events.push({ type: "SUMMON", playerId: pIdx, fieldIdx: pl.field.length - 1, card: champ, reason: "summonDragonUlt" });
    return true;
}
function scareReturn(state, pIdx, targetP, targetI, events) {
    const owner = state.players[targetP];
    const champ = owner.field[targetI];
    if (!champ)
        return;
    owner.field.splice(targetI, 1);
    const base = (champ.basePower ?? champ.power ?? champ.currentPower);
    champ.currentPower = base;
    champ.basePower = base;
    champ.power = base;
    champ.tapped = false;
    champ.frozen = false;
    champ.frozenTurns = 0;
    champ.freeAttack = false;
    champ.shielded = false;
    champ.shieldedTurns = 0;
    champ.silenced = false;
    champ.pulled = false;
    champ.pulledFromOwner = -1;
    champ.pulledTurns = 0;
    champ.poisoned = false;
    champ.poisonTurns = 0;
    champ.poisonedByP = -1;
    champ.vulnerable = false;
    champ.corruptedNoHonor = false;
    champ.barrier = false;
    champ.barrierTurns = 0;
    champ.barrierPermanent = false;
    champ.fireAura = false;
    champ.fireAuraTurns = 0;
    champ.fury = false;
    champ.furyTurns = 0;
    champ.furyStacks = 0;
    champ.furyBonusActive = false;
    champ.wallBuff = false;
    champ.foreverGrowth = false;
    champ.guerraBuff = false;
    champ.guerraBuffTurns = 0;
    owner.hand.push(champ);
    events.push({ type: "SCARE_RETURN", playerId: pIdx, targetP, targetI, card: champ.name });
}
export function validateUltimatePlay(state, action) {
    const pid = (action.playerId ?? state.currentPlayer);
    if (state.currentPlayer !== pid)
        return { ok: false, code: "NOT_YOUR_TURN" };
    const pl = state.players[pid];
    const heroId = action.heroId || pl.heroId;
    if (!heroId || heroId !== pl.heroId)
        return { ok: false, code: "WRONG_HERO" };
    const hero = heroDef(heroId);
    if (!hero)
        return { ok: false, code: "NO_HERO" };
    const ut = action.ultimateType || hero.ultimateType;
    if (ut !== hero.ultimateType)
        return { ok: false, code: "WRONG_ULTIMATE_TYPE" };
    if (pl.usedUltimateThisTurn)
        return { ok: false, code: "ULTIMATE_USED" };
    if ((pl.ultimateUses ?? 0) >= getMaxUltimateUses(heroId))
        return { ok: false, code: "ULTIMATE_EXHAUSTED" };
    const R = rules();
    const tp = action.targetP;
    const ti = action.targetI;
    const field = pl.field;
    switch (ut) {
        case "targetEnemy":
        case "targetEnemyFreeze":
        case "vampirism":
        case "banish":
        case "poison":
        case "scareReturn":
            if (tp == null || ti == null)
                return { ok: false, code: "TARGET_REQUIRED" };
            if (tp === pid)
                return { ok: false, code: "BAD_TARGET" };
            if (!state.players[tp]?.field?.[ti])
                return { ok: false, code: "INVALID_TARGET" };
            if (ut === "targetEnemyFreeze" && state.players[tp].field[ti].frozen)
                return { ok: false, code: "ALREADY_FROZEN" };
            if (ut === "vampirism" && state.players[tp].field[ti].currentPower < 2)
                return { ok: false, code: "INVALID_TARGET" };
            if (ut === "banish" && !championBanishable(state.players[tp].field[ti]))
                return { ok: false, code: "INVALID_TARGET" };
            if (ut === "poison" && state.players[tp].field[ti].poisoned)
                return { ok: false, code: "ALREADY_POISONED" };
            if (ut === "scareReturn") {
                const t = state.players[tp].field[ti];
                if (t.currentPower > 2)
                    return { ok: false, code: "INVALID_TARGET" };
            }
            if (ut === "vampirism" && !R.gatherAllyTargets(state, pid, -1, allyCanGainPower).length) {
                return { ok: false, code: "NO_ALLY_ABSORBER" };
            }
            break;
        case "targetAlly":
        case "targetAllyFreeAttack":
        case "targetAllyShield":
        case "potion":
            if (tp == null || ti == null)
                return { ok: false, code: "TARGET_REQUIRED" };
            if (tp !== pid)
                return { ok: false, code: "BAD_TARGET" };
            if (!field[ti])
                return { ok: false, code: "INVALID_TARGET" };
            if (ut === "targetAllyFreeAttack") {
                const t = field[ti];
                if (cannotReceiveInvestida(t) || t.tapped || t.frozen)
                    return { ok: false, code: "INVALID_TARGET" };
            }
            if (ut === "potion" && !allyCanGainPower(field[ti]))
                return { ok: false, code: "INVALID_TARGET" };
            break;
        case "trickerySwap":
            if (tp == null || ti == null)
                return { ok: false, code: "TARGET_REQUIRED" };
            if (tp !== pid || !field[ti] || field[ti].currentPower !== 1)
                return { ok: false, code: "INVALID_TARGET" };
            if (!pickTrickerySwapTarget(state, pid, () => 0))
                return { ok: false, code: "NO_SWAP_TARGET" };
            break;
        case "drawCard":
            if (pl.hand.length >= (R.LIMITS.MAX_HAND ?? 8))
                return { ok: false, code: "HAND_FULL" };
            break;
        case "fireAndIce":
            if (!R.gatherEnemyTargets(state, pid, () => true).length)
                return { ok: false, code: "NO_TARGETS" };
            break;
        case "summonDragon":
            if (field.length >= (R.LIMITS?.MAX_FIELD ?? 6))
                return { ok: false, code: "FIELD_FULL" };
            break;
        case "hook":
            if (!R.gatherEnemyTargets(state, pid, (c) => c.currentPower < 3).length) {
                return { ok: false, code: "NO_TARGETS" };
            }
            break;
        case "resurrect":
            if (field.length >= (R.LIMITS?.MAX_FIELD ?? 6))
                return { ok: false, code: "FIELD_FULL" };
            if (!pickPaladinoPower2Discard(state, pid, () => 0))
                return { ok: false, code: "NO_DISCARD_TARGET" };
            break;
        case "wallProtect":
            if (!field.length)
                return { ok: false, code: "NO_ALLIES" };
            if (!field.some((c) => c && !c.wallBuff))
                return { ok: false, code: "WALL_ALREADY" };
            break;
        case "infinitePower":
            if (!field.some((c) => allyCanGainPower(c) && !c.foreverGrowth))
                return { ok: false, code: "NO_VALID_ALLY" };
            break;
        case "warOverpower":
            if (!field.length)
                return { ok: false, code: "NO_ALLIES" };
            break;
        default:
            break;
    }
    return { ok: true, code: "OK" };
}
export function applyUltimatePlay(state, action, rng = Math.random) {
    const check = validateUltimatePlay(state, action);
    if (!check.ok)
        return { ok: false, state, events: [], error: check.code };
    const next = clone(state);
    const pid = (action.playerId ?? state.currentPlayer);
    const pl = next.players[pid];
    const heroId = action.heroId || pl.heroId;
    const hero = heroDef(heroId);
    const ut = hero.ultimateType;
    const tp = action.targetP;
    const ti = action.targetI;
    const events = [];
    pl.ultimateUses = (pl.ultimateUses ?? 0) + 1;
    pl.usedUltimateThisTurn = true;
    events.push({ type: "ULTIMATE_PLAY", playerId: pid, ultimateType: ut, heroId });
    const R = rules();
    switch (ut) {
        case "targetEnemy": {
            const t = next.players[tp].field[ti];
            if (consumeBarrier(t))
                break;
            reducePower(t, 1);
            if (t.currentPower <= 0)
                destroyChampion(next, tp, ti, pid, { reason: "ultimate" }, events, rng);
            break;
        }
        case "targetEnemyFreeze": {
            const t = next.players[tp].field[ti];
            t.frozen = true;
            t.frozenTurns = heroId === "iceWitch" ? 3 : 2;
            events.push({ type: "FREEZE", targetP: tp, targetI: ti, turns: t.frozenTurns });
            break;
        }
        case "targetAlly": {
            const t = next.players[tp].field[ti];
            t.currentPower = (t.currentPower ?? 0) + 1;
            events.push({ type: "POWER_BUFF", targetP: tp, targetI: ti, amount: 1 });
            break;
        }
        case "targetAllyFreeAttack": {
            const t = next.players[tp].field[ti];
            t.freeAttack = true;
            events.push({ type: "FREE_ATTACK", targetP: tp, targetI: ti });
            break;
        }
        case "targetAllyShield": {
            const t = next.players[tp].field[ti];
            t.shielded = true;
            t.shieldedTurns = 1;
            events.push({ type: "SHIELD", targetP: tp, targetI: ti });
            break;
        }
        case "drawCard":
            drawCardFree(next, pid, events);
            break;
        case "trickerySwap": {
            const swap = pickTrickerySwapTarget(next, pid, rng);
            if (!swap)
                return { ok: false, state, events: [], error: "NO_SWAP_TARGET" };
            performTrickerySwap(next, pid, ti, swap.p, swap.i);
            events.push({ type: "TRICKERY_SWAP", allyI: ti, enemyP: swap.p, enemyI: swap.i });
            break;
        }
        case "fireAndIce": {
            const enemies = [];
            for (let ep = 0; ep < (next.playersCount ?? next.players.length); ep++) {
                if (ep === pid)
                    continue;
                (next.players[ep]?.field || []).forEach((c, i) => {
                    if (c)
                        enemies.push({ p: ep, i, uid: String(c.uid) });
                });
            }
            const freezes = [];
            const burns = [];
            for (const e of enemies) {
                if (rng() < 0.5)
                    freezes.push(e);
                else
                    burns.push(e);
            }
            for (const f of freezes) {
                const a = next.players[f.p]?.field?.[f.i];
                if (!a || a.uid !== f.uid)
                    continue;
                a.frozen = true;
                a.frozenTurns = 2;
                events.push({ type: "FREEZE", targetP: f.p, targetI: f.i, turns: 2, source: "fireAndIce" });
            }
            for (const bSlot of burns) {
                const arr = next.players[bSlot.p]?.field || [];
                let bi = -1;
                for (let k = 0; k < arr.length; k++) {
                    if (arr[k]?.uid === bSlot.uid) {
                        bi = k;
                        break;
                    }
                }
                if (bi < 0)
                    continue;
                const b = arr[bi];
                if (!b)
                    continue;
                if (consumeBarrier(b))
                    continue;
                reducePower(b, 1);
                if (b.currentPower <= 0)
                    destroyChampion(next, bSlot.p, bi, pid, { reason: "fireAndIce" }, events, rng);
            }
            break;
        }
        case "summonDragon":
            summonDragonToken(next, pid, events);
            break;
        case "hook": {
            const stolen = pickHookTarget(next, pid, rng);
            if (!stolen)
                break;
            const srcField = next.players[stolen.p].field;
            const tgt = srcField[stolen.i];
            srcField.splice(stolen.i, 1);
            tgt.pulled = false;
            tgt.pulledFromOwner = -1;
            tgt.pulledTurns = 0;
            tgt.guerraBuff = false;
            tgt.guerraBuffTurns = 0;
            tgt.tapped = true;
            pl.field.push(tgt);
            events.push({ type: "HOOK_STEAL", fromP: stolen.p, fromI: stolen.i, toP: pid });
            break;
        }
        case "resurrect": {
            const pick = pickPaladinoPower2Discard(next, pid, rng);
            if (pick)
                paladinoRevive(next, pid, pick, events);
            break;
        }
        case "potion": {
            const t = next.players[tp].field[ti];
            const success = rng() < 0.6;
            if (success) {
                t.currentPower = (t.currentPower ?? 0) + 2;
                events.push({ type: "POTION_SUCCESS", targetP: tp, targetI: ti });
            }
            else {
                if (!consumeBarrier(t)) {
                    reducePower(t, 1);
                    if (t.currentPower <= 0)
                        destroyChampion(next, tp, ti, pid, { reason: "potion" }, events, rng);
                }
                events.push({ type: "POTION_FAIL", targetP: tp, targetI: ti });
            }
            break;
        }
        case "vampirism": {
            const enemy = next.players[tp].field[ti];
            const allies = [];
            pl.field.forEach((c, i) => { if (allyCanGainPower(c))
                allies.push(i); });
            const allyI = allies[Math.floor(rng() * allies.length)];
            reducePower(enemy, 1);
            const ally = pl.field[allyI];
            if (ally)
                ally.currentPower = (ally.currentPower ?? 0) + 1;
            if (enemy.currentPower <= 0)
                destroyChampion(next, tp, ti, pid, { reason: "vampirism" }, events, rng);
            events.push({ type: "VAMPIRISM", targetP: tp, targetI: ti, allyI });
            break;
        }
        case "banish": {
            const enemy = next.players[tp].field[ti];
            next.players[tp].field.splice(ti, 1);
            events.push({ type: "BANISH", targetP: tp, targetI: ti, card: enemy.name });
            break;
        }
        case "thunderDiscard": {
            for (let ep = 0; ep < (next.playersCount ?? next.players.length); ep++) {
                if (ep === pid)
                    continue;
                const opp = next.players[ep];
                const hand = opp.hand;
                if (!hand.length)
                    continue;
                const idx = Math.floor(rng() * hand.length);
                const removed = hand.splice(idx, 1)[0];
                opp.discard.push(removed);
                events.push({ type: "THUNDER_DISCARD", playerId: ep, card: removed.name });
            }
            break;
        }
        case "wallProtect": {
            pl.wallActive = pl.field.some((c) => c && c.wallBuff);
            pl.wallCasterIdx = pid;
            for (const c of pl.field) {
                if (!c || c.wallBuff)
                    continue;
                c.wallBuff = true;
                c.wallBuffApplied = false;
                c.wallBuffReveal = false;
                pl.wallActive = true;
            }
            events.push({ type: "WALL_PROTECT", playerId: pid });
            break;
        }
        case "poison": {
            const t = next.players[tp].field[ti];
            t.poisoned = true;
            t.poisonTurns = 2;
            t.poisonedByP = pid;
            events.push({ type: "POISON", targetP: tp, targetI: ti });
            break;
        }
        case "infinitePower": {
            pl.field.forEach((c, i) => {
                if (allyCanGainPower(c) && !c.foreverGrowth) {
                    c.foreverGrowth = true;
                    events.push({ type: "FOREVER_GROWTH", targetP: pid, targetI: i });
                }
            });
            break;
        }
        case "scareReturn":
            scareReturn(next, pid, tp, ti, events);
            break;
        case "cometStarfall": {
            for (let ep = 0; ep < (next.playersCount ?? next.players.length); ep++) {
                const fld = next.players[ep]?.field || [];
                for (let i = fld.length - 1; i >= 0; i--) {
                    const c = fld[i];
                    if (!c)
                        continue;
                    if (consumeBarrier(c))
                        continue;
                    normalizeChampPower(c);
                    reducePower(c, 1);
                    if (c.currentPower <= 0) {
                        const killer = ep !== pid ? pid : null;
                        destroyChampion(next, ep, i, killer, { reason: "cometStarfall" }, events, rng);
                    }
                }
            }
            events.push({ type: "COMET_STARFALL", playerId: pid });
            break;
        }
        case "warOverpower": {
            pl.field.forEach((c) => {
                c.guerraBuff = true;
                c.guerraBuffTurns = 1;
            });
            pl.guerraActive = true;
            events.push({ type: "WAR_OVERPOWER", playerId: pid });
            break;
        }
        default:
            return { ok: false, state, events: [], error: "UNKNOWN_ULTIMATE" };
    }
    const winner = R.findWinnerIndex(next);
    if (winner != null) {
        next.winner = winner;
        events.push({ type: "GAME_OVER", winner });
    }
    return { ok: true, state: next, events };
}
export const DfUltimateResolve = Object.freeze({
    getMaxUltimateUses,
    validateUltimatePlay,
    applyUltimatePlay,
});
