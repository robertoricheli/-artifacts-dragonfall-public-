import { DfProtocol, validateActionShape } from "./df-protocol.js";
import { validateUltimatePlay, applyUltimatePlay } from "./df-ultimate-resolve.js";
let motorContext = globalThis;
function motorGlobal() {
    return motorContext;
}
/** Define o global usado por validate/apply (Node vm vs browser window). */
export function setMotorContext(g) {
    motorContext = g;
}
function getProtocol() {
    return motorGlobal().DfProtocol ?? DfProtocol;
}
function getRules() {
    return motorGlobal().DfRules ?? null;
}
function getEffects() {
    return motorGlobal().DfEffects ?? null;
}
/** Humano: sem trava de onEnter; IA: flags do dispatch. */
function summonCheckOpts(state, pid, ctx) {
    const pl = state.players[pid];
    const isAi = !!(pl?.isAI);
    if (!isAi) {
        return {
            strictFumacaToxica: false,
            avoidEnemyOnEnterWaste: false,
            allowWastedOnEnter: true,
        };
    }
    return {
        strictFumacaToxica: !!ctx.strictFumacaToxica,
        avoidEnemyOnEnterWaste: !!ctx.avoidEnemyOnEnterWaste,
        allowWastedOnEnter: ctx.allowWastedOnEnter ?? false,
    };
}
export function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
}
export function validateAction(state, action, ctx = {}) {
    const shaped = validateActionShape(action);
    if (!shaped.ok)
        return shaped;
    const a = shaped.action;
    const R = getRules();
    if (!R)
        return { ok: false, error: "NO_RULES" };
    const pid = (a.playerId ?? state.currentPlayer);
    const T = getProtocol().ACTION_TYPES;
    switch (a.type) {
        case T.END_TURN:
            return R.canEndTurn(state, pid);
        case T.DRAW_CARD:
            return R.canBuyCard(state, pid, ctx.limits);
        case T.SUMMON:
            return R.canSummon(state, pid, a.handIdx, {
                freeAction: !!a.freeAction,
                ...R.summonContextForPlayer(state, pid),
                ...summonCheckOpts(state, pid, ctx),
            });
        case T.ATTACK_RESOLVE:
            return R.canAttack(state, pid, a.attackerIdx, a.defenderPlayerId, a.defenderIdx, ctx);
        case T.REACTIVE_BLOCK_ANSWER:
            if (!a.use)
                return { ok: true, code: "OK" };
            return R.canOfferReactiveBlock(state, pid, a.attOwner ?? 1 - pid);
        case T.REACTIVE_PROTECTION_ANSWER:
            if (!a.use)
                return { ok: true, code: "OK" };
            return R.canOfferReactiveProtection(state, pid, a.attOwner ?? 1 - pid);
        case T.ON_ENTER_RESOLVE:
            if (a.casterIdx == null || a.fieldIdx == null)
                return { ok: false, code: "BAD_ON_ENTER" };
            return R.canResolveOnEnter(state, a.casterIdx, a.fieldIdx, ctx);
        case T.TALENT_START: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const card = state.players[pid]?.hand;
            const handCard = card?.[a.handIdx];
            if (!handCard || handCard.category !== "talent")
                return { ok: false, code: "NOT_TALENT" };
            const pl = state.players[pid];
            if ((pl.actions ?? 0) < 1)
                return { ok: false, code: "INSUFFICIENT_ACTIONS" };
            return { ok: true, code: "OK" };
        }
        case T.ULTIMATE_PLAY:
            return validateUltimatePlay(state, a);
        default:
            return { ok: true, code: "DELEGATE" };
    }
}
export function applyAction(state, action, ctx = {}) {
    const shaped = validateActionShape(action);
    if (!shaped.ok)
        return { ok: false, state, events: [], error: "error" in shaped ? shaped.error : "INVALID" };
    const a = shaped.action;
    const next = cloneState(state);
    const R = getRules();
    if (!R)
        return { ok: false, state, events: [], error: "NO_RULES" };
    const pid = (a.playerId ?? next.currentPlayer);
    const check = validateAction(next, a, ctx);
    if (check.ok === false) {
        const c = check;
        return { ok: false, state, events: [], error: c.code || c.error || "ILLEGAL" };
    }
    const events = [];
    const T = getProtocol().ACTION_TYPES;
    const p = next.players[pid];
    switch (a.type) {
        case T.DRAW_CARD: {
            if (!R.canBuyCard(next, pid).ok)
                return { ok: false, state, events: [], error: "DRAW_ILLEGAL" };
            const deck = p.deck;
            const card = deck.pop();
            if (!card)
                return { ok: false, state, events: [], error: "DECK_EMPTY" };
            p.hand.push(card);
            p.actions = p.actions - 1;
            events.push({ type: "DRAW", playerId: pid, card });
            break;
        }
        case T.SUMMON: {
            const leg = R.canSummon(next, pid, a.handIdx, {
                freeAction: !!a.freeAction,
                ...R.summonContextForPlayer(next, pid),
                ...summonCheckOpts(next, pid, ctx),
            });
            if (!leg.ok)
                return { ok: false, state, events: [], error: leg.code };
            const hand = p.hand;
            const card = hand.splice(a.handIdx, 1)[0];
            const champ = {
                ...card,
                uid: a.uid || `u-${Date.now()}`,
                currentPower: card.power,
                basePower: card.power,
                tapped: false,
                frozen: false,
                isToken: false,
            };
            const field = p.field;
            const insertIdx = a.insertIdx != null
                ? a.insertIdx
                : R.defaultSummonInsertIndex(field.length);
            field.splice(Math.min(insertIdx, field.length), 0, champ);
            if (!a.freeAction)
                p.actions = p.actions - R.championSummonCost(card);
            const fIdx = field.indexOf(champ);
            events.push({ type: "SUMMON", playerId: pid, fieldIdx: fIdx, card: champ });
            if (champ.onEnter) {
                events.push({ type: "ON_ENTER_PENDING", playerId: pid, fieldIdx: fIdx, onEnter: champ.onEnter });
            }
            break;
        }
        case T.ATTACK_RESOLVE: {
            const leg = R.canAttack(next, pid, a.attackerIdx, a.defenderPlayerId, a.defenderIdx);
            if (!leg.ok)
                return { ok: false, state, events: [], error: leg.code };
            const field = p.field;
            const att = field[a.attackerIdx];
            const defP = next.players[a.defenderPlayerId];
            const defField = defP.field;
            const def = defField[a.defenderIdx];
            const out = R.combatOutcome(att, def);
            const cost = leg.actionCost ?? R.getAttackActionCost(att, def);
            if (cost > 0)
                p.actions = p.actions - cost;
            att.tapped = true;
            events.push({
                type: "COMBAT",
                attacker: { p: pid, i: a.attackerIdx },
                defender: { p: a.defenderPlayerId, i: a.defenderIdx },
                outcome: out,
            });
            if (out.killD) {
                defField.splice(a.defenderIdx, 1);
                events.push({ type: "DESTROY", p: a.defenderPlayerId, i: a.defenderIdx, reason: "combat" });
                const noHonor = R.hasNoHonor(def);
                if (out.pvTo === "attacker" && !noHonor) {
                    const amount = R.combatVictoryPointReward(att);
                    p.vp = (p.vp ?? 0) + amount;
                    events.push({ type: "VP_GAIN", playerId: pid, amount, reason: "combat" });
                }
                const burst = R.applyOnDestroyBurst(next, a.defenderPlayerId, def, "combat", ctx.rng);
                if (burst?.ability) {
                    events.push({
                        type: "ON_DESTROY_BURST",
                        ownerIdx: a.defenderPlayerId,
                        source: def.name,
                        reason: "combat",
                        ...burst,
                    });
                }
            }
            if (out.killA) {
                field.splice(a.attackerIdx, 1);
                events.push({ type: "DESTROY", p: pid, i: a.attackerIdx, reason: "combat" });
                const noHonor = R.hasNoHonor(att);
                if (out.pvTo === "defender" && !noHonor) {
                    const amount = R.combatVictoryPointReward(def);
                    defP.vp = (defP.vp ?? 0) + amount;
                    events.push({
                        type: "VP_GAIN",
                        playerId: a.defenderPlayerId,
                        amount,
                        reason: "combat",
                    });
                }
                const burst = R.applyOnDestroyBurst(next, pid, att, "combat", ctx.rng);
                if (burst?.ability) {
                    events.push({
                        type: "ON_DESTROY_BURST",
                        ownerIdx: pid,
                        source: att.name,
                        reason: "combat",
                        ...burst,
                    });
                }
            }
            break;
        }
        case T.END_TURN: {
            if (!R.canEndTurn(next, pid).ok)
                return { ok: false, state, events: [], error: "NOT_YOUR_TURN" };
            const maint = R.runTurnMaintenance(next, pid, R.LIMITS);
            maint.poisonDestroyed.forEach((k) => {
                events.push({ type: "POISON_KILL", ...k, by: pid });
            });
            if (maint.passiveVpGain > 0) {
                events.push({ type: "VP_GAIN", playerId: pid, amount: maint.passiveVpGain, reason: "maintenance" });
            }
            if (maint.poisonVpGain > 0) {
                events.push({ type: "VP_GAIN", playerId: pid, amount: maint.poisonVpGain, reason: "poison" });
            }
            maint.returned.forEach((r) => {
                events.push({ type: "PULLED_RETURN", ...r, toPlayer: pid });
            });
            const count = next.playersCount ?? next.players.length;
            next.currentPlayer = (pid + 1) % count;
            next.turnNumber = (next.turnNumber ?? 1) + 1;
            const np = next.players[next.currentPlayer];
            const maxHand = R.LIMITS?.MAX_HAND ?? 8;
            if (!maint.skipDraw && np.hand.length < maxHand && np.deck.length > 0) {
                np.hand.push(np.deck.pop());
                events.push({ type: "DRAW", playerId: next.currentPlayer, reason: "upkeep" });
            }
            events.push({ type: "TURN_START", playerId: next.currentPlayer });
            break;
        }
        case T.ON_ENTER_RESOLVE: {
            const ER = getEffects();
            if (!ER?.applyOnEnter)
                return { ok: false, state, events: [], error: "NO_RESOLVE" };
            const cIdx = (a.casterIdx ?? pid);
            const fIdx = a.fieldIdx;
            const res = ER.applyOnEnter(next, cIdx, fIdx, a.resolution || {});
            if (!res.ok)
                return { ok: false, state, events: res.events || [], error: res.error || "ON_ENTER_FAILED" };
            events.push(...(res.events || []));
            break;
        }
        case T.REACTIVE_BLOCK_ANSWER: {
            const ER = getEffects();
            if (!ER?.applyReactiveUse)
                return { ok: false, state, events: [], error: "NO_REACTIVE" };
            const res = ER.applyReactiveUse(next, pid, "bloquearAtaque", !!a.use);
            if (!res.ok)
                return { ok: false, state, events: [], error: res.error || "REACTIVE_FAILED" };
            events.push(...(res.events || []));
            break;
        }
        case T.REACTIVE_PROTECTION_ANSWER: {
            const ER = getEffects();
            if (!ER?.applyReactiveUse)
                return { ok: false, state, events: [], error: "NO_REACTIVE" };
            const res = ER.applyReactiveUse(next, pid, "protecaoDivina", !!a.use);
            if (!res.ok)
                return { ok: false, state, events: [], error: res.error || "REACTIVE_FAILED" };
            events.push(...(res.events || []));
            break;
        }
        case T.SURRENDER: {
            const count = next.playersCount ?? next.players.length;
            const opp = ((pid + 1) % count);
            next.winner = opp;
            events.push({ type: "SURRENDER", playerId: pid });
            events.push({ type: "GAME_OVER", winner: opp });
            break;
        }
        case T.TALENT_START: {
            const ER = getEffects();
            if (!ER?.applyTalentFromHand)
                return { ok: false, state, events: [], error: "NO_TALENT" };
            const res = ER.applyTalentFromHand(next, pid, a.handIdx);
            if (!res.ok)
                return { ok: false, state, events: [], error: res.error || "TALENT_FAILED" };
            events.push(...(res.events || []));
            break;
        }
        case T.ULTIMATE_PLAY: {
            const ult = applyUltimatePlay(state, a, ctx.rng || Math.random);
            if (!ult.ok)
                return { ok: false, state, events: ult.events, error: ult.error || "ULTIMATE_FAILED" };
            return { ok: true, state: ult.state, events: ult.events };
        }
        default: {
            const uiOnly = new Set([
                T.PLAY_VISUAL,
                T.MENU_CHOICE,
                T.OPEN_DISCARD,
                T.ATTACK_START,
                T.ATTACK_PICK_ATTACKER,
                T.ATTACK_PICK_DEFENDER,
                T.REACTIVE_BLOCK_QUERY,
                T.REACTIVE_PROTECTION_QUERY,
                T.ABILITY_START,
                T.ABILITY_TARGET,
                T.TALENT_TARGET,
                T.ULTIMATE_START,
                T.ULTIMATE_TARGET,
                T.SYNC_STATE,
                T.LOBBY_CREATE,
                T.LOBBY_JOIN,
                T.SETUP_HERO,
                T.SETUP_WIN_POINTS,
                T.MATCH_START,
                T.RESTART_MATCH,
                T.UNFREEZE_CONFIRM,
            ]);
            if (uiOnly.has(a.type)) {
                return { ok: true, state: next, events: [{ type: "CLIENT_ONLY", actionType: a.type }] };
            }
            return { ok: false, state, events: [], error: "NOT_IMPLEMENTED" };
        }
    }
    const winner = R.findWinnerIndex(next);
    if (winner != null) {
        next.winner = winner;
        events.push({ type: "GAME_OVER", winner });
    }
    return { ok: true, state: next, events };
}
/** Resolução automática de onEnter para simulador / IA (modos auto). */
export function autoOnEnterResolution(state, casterIdx, fieldIdx, plan, rng = Math.random) {
    const R = getRules();
    const resolution = { rng };
    if (!R || !plan?.ok)
        return resolution;
    const mode = plan.mode;
    if (mode === "none" || mode === "visual_only")
        return resolution;
    if (mode === "necromancia_pick") {
        const disc = state.players[casterIdx]?.discard;
        if (disc?.length)
            resolution.necromanciaCard = disc[disc.length - 1];
        return resolution;
    }
    const INSTANT_PLAYER_AUTO = new Set(["pesadelo", "roubar", "desacelerar"]);
    const ability = plan.ability;
    if (INSTANT_PLAYER_AUTO.has(ability || "")) {
        for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
            if (p !== casterIdx) {
                resolution.targetPlayerIdx = p;
                break;
            }
        }
        return resolution;
    }
    if (plan.targetKind === "enemy" || mode === "auto") {
        const targets = R.gatherEnemyTargets(state, casterIdx);
        if (targets.length) {
            resolution.targetP = targets[0].p;
            resolution.targetI = targets[0].i;
        }
    }
    if (plan.targetKind === "ally") {
        const allies = ability === "corromper"
            ? R.gatherAllyTargets(state, casterIdx, -1)
            : R.gatherAllyTargets(state, casterIdx, fieldIdx);
        if (allies.length) {
            resolution.targetP = allies[0].p;
            resolution.targetI = allies[0].i;
        }
    }
    if (plan.targetKind === "player") {
        for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
            if (p !== casterIdx) {
                resolution.targetPlayerIdx = p;
                break;
            }
        }
    }
    return resolution;
}
/** Aplica ação e resolve onEnter pendentes (auto) em cadeia. */
export function applyActionWithOnEnter(state, action, ctx = {}) {
    let result = applyAction(state, action, ctx);
    if (!result.ok)
        return result;
    const ER = getEffects();
    const T = getProtocol().ACTION_TYPES;
    let guard = 0;
    while (guard++ < 16) {
        const pending = result.events.filter((e) => e.type === "ON_ENTER_PENDING");
        if (!pending.length || !ER?.planOnEnter)
            break;
        let st = result.state;
        const extra = [];
        let resolvedAny = false;
        for (const pe of pending) {
            const cIdx = (pe.playerId ?? pe.casterIdx);
            const fIdx = pe.fieldIdx;
            const plan = ER.planOnEnter(st, cIdx, fIdx);
            if (!plan?.ok || plan.mode === "target" || plan.mode === "blocked")
                continue;
            const follow = applyAction(st, {
                type: T.ON_ENTER_RESOLVE,
                playerId: cIdx,
                casterIdx: cIdx,
                fieldIdx: fIdx,
                resolution: autoOnEnterResolution(st, cIdx, fIdx, plan),
            }, ctx);
            if (!follow.ok)
                continue;
            st = follow.state;
            resolvedAny = true;
            extra.push(...follow.events.filter((e) => e.type !== "ON_ENTER_PENDING"));
        }
        if (!resolvedAny)
            break;
        result = {
            ok: true,
            state: st,
            events: [...result.events.filter((e) => e.type !== "ON_ENTER_PENDING"), ...extra],
        };
    }
    return result;
}
export function listLegalActions(state, pIdx, opts = {}) {
    const R = getRules();
    if (!R?.listLegalActions)
        return [];
    const T = getProtocol().ACTION_TYPES;
    return R.listLegalActions(state, pIdx, { ...opts, actionTypes: T });
}
export async function dispatch(action, adapter, ctx = {}) {
    const state = adapter.getState?.();
    if (!state)
        return { ok: false, error: "NO_STATE" };
    const v = validateAction(state, action, ctx);
    if (v.ok === false && v.code && v.code !== "DELEGATE") {
        const fail = v;
        return { ok: false, error: fail.code || fail.error };
    }
    if (typeof adapter.applyVisual === "function") {
        return adapter.applyVisual(action);
    }
    const result = applyAction(state, action, ctx);
    if (result.ok && adapter.setState)
        adapter.setState(result.state);
    return result;
}
export const DfEngine = Object.freeze({
    cloneState,
    validateAction,
    applyAction,
    applyActionWithOnEnter,
    autoOnEnterResolution,
    listLegalActions,
    dispatch,
});
/** Registra motor TS no global (browser / vm). */
export function registerEngineGlobals(g = motorGlobal()) {
    motorContext = g;
    g.DfProtocol = DfProtocol;
    g.DfEngine = DfEngine;
    g.__DF_ENGINE_CORE = DfEngine;
}
