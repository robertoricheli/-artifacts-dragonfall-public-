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
/** Resolve handIdx pelo nome/uid quando o índice do cliente divergiu do servidor. */
function resolveSummonHandIdx(hand, handIdx, cardName, uid) {
    if (!Array.isArray(hand))
        return handIdx | 0;
    let idx = handIdx | 0;
    const wantUid = uid != null ? String(uid) : "";
    if (wantUid) {
        const byUid = hand.findIndex((c) => c && String(c.uid || "") === wantUid);
        if (byUid >= 0)
            return byUid;
    }
    const want = cardName != null ? String(cardName) : "";
    const at = hand[idx];
    if (want && at && String(at.name || "") === want)
        return idx;
    if (want) {
        const byName = hand.findIndex((c) => c && String(c.name || "") === want);
        if (byName >= 0)
            return byName;
    }
    return idx;
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
        case T.SUMMON: {
            const hand = state.players[pid]?.hand;
            const idx = resolveSummonHandIdx(hand, a.handIdx, a.cardName, a.uid);
            const card = hand?.[idx];
            if (card?.summonRitual && a.freeAction) {
                const sacIdx = a.sacrificeIdx;
                const field = state.players[pid]?.field;
                const sac = field?.[sacIdx];
                const req = card.summonRitual;
                if (sacIdx == null || sacIdx < 0 || !sac) {
                    return { ok: false, code: "NO_RITUAL_SACRIFICE" };
                }
                const sacPow = sac.currentPower ?? sac.power ?? 0;
                if (sacPow !== req)
                    return { ok: false, code: "BAD_RITUAL_POWER" };
                if (a.sacrificeUid != null && String(sac.uid || "") !== String(a.sacrificeUid)) {
                    return { ok: false, code: "BAD_RITUAL_UID" };
                }
            }
            return R.canSummon(state, pid, idx, {
                freeAction: !!a.freeAction,
                ...R.summonContextForPlayer(state, pid),
                ...summonCheckOpts(state, pid, ctx),
            });
        }
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
        case T.REACTIVE_CANCEL_ANSWER:
            if (!a.use)
                return { ok: true, code: "OK" };
            return R.canOfferCancelUltimate(state, pid, a.attOwner ?? 1 - pid);
        case T.ON_ENTER_RESOLVE:
            if (a.casterIdx == null || a.fieldIdx == null)
                return { ok: false, code: "BAD_ON_ENTER" };
            return R.canResolveOnEnter(state, a.casterIdx, a.fieldIdx, ctx);
        case T.TALENT_START: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const hand = state.players[pid]?.hand;
            const talentIdx = resolveSummonHandIdx(hand || [], a.handIdx, a.cardName, a.uid);
            const handCard = hand?.[talentIdx];
            if (!handCard || handCard.category !== "talent")
                return { ok: false, code: "NOT_TALENT" };
            const pl = state.players[pid];
            // Custo por carta (manual §9.1): talento Custo 0 vale com 0 ações.
            const talentCost = R.talentPlayCost?.(handCard)
                ?? handCard.currentPower
                ?? handCard.power
                ?? 0;
            if ((pl.actions ?? 0) < talentCost)
                return { ok: false, code: "INSUFFICIENT_ACTIONS" };
            return { ok: true, code: "OK" };
        }
        case T.TALENT_DISCARD: {
            const at = state.activeTalent;
            if (!at?.ownerP && at !== null && at !== undefined) {
                /* activeTalent shape odd — still allow clear attempt */
            }
            if (at && at.ownerP != null && at.ownerP !== pid)
                return { ok: false, code: "NOT_TALENT_OWNER" };
            return { ok: true, code: "OK" };
        }
        case T.ULTIMATE_PLAY:
            return validateUltimatePlay(state, a);
        case T.FIELD_COMMIT: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const mutations = a.mutations;
            if (!Array.isArray(mutations) || !mutations.length)
                return { ok: false, code: "NO_MUTATIONS" };
            for (const m of mutations) {
                const op = String(m?.op || "");
                const tp = m.targetP;
                const ti = m.targetI;
                if (tp == null || tp < 0)
                    return { ok: false, code: "BAD_TARGET" };
                const champ = state.players[tp]?.field;
                if (!champ)
                    return { ok: false, code: "NO_TARGET" };
                if (op === "insertToken" || op === "insert") {
                    if (ti == null || ti < 0)
                        return { ok: false, code: "BAD_TARGET" };
                    if (!m.card || typeof m.card !== "object")
                        return { ok: false, code: "NO_CARD" };
                    continue;
                }
                if (op === "setActions") {
                    if (m.actions == null)
                        return { ok: false, code: "BAD_AMOUNT" };
                    continue;
                }
                if (op === "discardToHand") {
                    if (!m.card || typeof m.card !== "object")
                        return { ok: false, code: "NO_CARD" };
                    continue;
                }
                if (ti == null || ti < 0)
                    return { ok: false, code: "BAD_TARGET" };
                const card = champ?.[ti];
                if (!card)
                    return { ok: false, code: "NO_TARGET" };
                if (op === "reducePower") {
                    const amount = m.amount | 0;
                    if (amount < 1)
                        return { ok: false, code: "BAD_AMOUNT" };
                }
                else if (op === "destroy") {
                    if (m.requirePower != null) {
                        const pow = card.currentPower ?? card.power ?? 0;
                        if (pow !== m.requirePower)
                            return { ok: false, code: "BAD_POWER" };
                    }
                }
                else if (op === "setStatus") {
                    // flags opcionais — alvo já validado
                }
                else if (op === "transformToken") {
                    // Identidade in-place (Transformar / Ursificar) — card/flags já no mutation
                }
                else if (op === "returnToHand") {
                    // Medo / scare — remove do campo e devolve à mão
                }
                else {
                    return { ok: false, code: "BAD_MUTATION" };
                }
            }
            return { ok: true, code: "OK" };
        }
        case T.TALENT_TARGET: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            if (!state.activeTalent)
                return { ok: false, code: "NO_ACTIVE_TALENT" };
            return { ok: true, code: "OK" };
        }
        case T.UNFREEZE_CONFIRM: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const fIdx = a.fieldIdx;
            const field = state.players[pid]?.field;
            const card = field?.[fIdx];
            if (!card)
                return { ok: false, code: "NO_TARGET" };
            if (!card.frozen)
                return { ok: false, code: "NOT_FROZEN" };
            const yes = a.yes === true || a.confirmed === true
                || (a.choiceIndex === 0 && a.yes !== false);
            if (yes && (state.players[pid].actions | 0) < 1) {
                return { ok: false, code: "INSUFFICIENT_ACTIONS" };
            }
            return { ok: true, code: "OK" };
        }
        case T.NECROMANCIA_PICK: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const casterIdx = (a.casterIdx ?? pid);
            const discard = state.players[casterIdx]?.discard;
            if (!discard?.length)
                return { ok: false, code: "NO_DISCARD" };
            const cardName = a.cardName || a.card?.name;
            const uid = a.uid || a.card?.uid;
            let di = a.discardIndex;
            if (di == null)
                di = a.discardIdx;
            if ((di == null || di < 0) && uid) {
                di = discard.findIndex((c) => c && c.uid === uid);
            }
            if ((di == null || di < 0) && cardName) {
                di = discard.findIndex((c) => c && c.name === cardName);
            }
            if (di == null || di < 0 || di >= discard.length)
                return { ok: false, code: "NECRO_BAD_CARD" };
            return { ok: true, code: "OK" };
        }
        case T.ABILITY_TARGET: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const cIdx = (a.casterIdx ?? pid);
            const fIdx = a.fieldIdx;
            if (fIdx == null || fIdx < 0)
                return { ok: false, code: "BAD_ON_ENTER" };
            return R.canResolveOnEnter(state, cIdx, fIdx, ctx);
        }
        case T.ULTIMATE_TARGET:
            return validateUltimatePlay(state, { ...a, type: T.ULTIMATE_PLAY });
        case T.MENU_CHOICE: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const kind = String(a.menuKind || a.menuType || a.abilityKey || "");
            if (kind === "unfreeze" || kind === "UNFREEZE_CONFIRM") {
                return validateAction(state, {
                    ...a,
                    type: T.UNFREEZE_CONFIRM,
                    yes: a.choiceIndex === 0 || a.yes === true,
                }, ctx);
            }
            if (kind === "target-player" || a.targetPlayerIdx != null || a.abilityKey) {
                const cIdx = (a.casterIdx ?? pid);
                const fIdx = a.fieldIdx;
                if (fIdx == null || fIdx < 0)
                    return { ok: false, code: "BAD_MENU" };
                return R.canResolveOnEnter(state, cIdx, fIdx, ctx);
            }
            return { ok: false, code: "BAD_MENU" };
        }
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
            const hand = p.hand;
            const summonIdx = resolveSummonHandIdx(hand, a.handIdx, a.cardName, a.uid);
            a.handIdx = summonIdx;
            const leg = R.canSummon(next, pid, summonIdx, {
                freeAction: !!a.freeAction,
                ...R.summonContextForPlayer(next, pid),
                ...summonCheckOpts(next, pid, ctx),
            });
            if (!leg.ok)
                return { ok: false, state, events: [], error: leg.code };
            const wantName = a.cardName != null ? String(a.cardName) : "";
            const handCard = hand[summonIdx];
            if (wantName && (!handCard || String(handCard.name || "") !== wantName)) {
                return { ok: false, state, events: [], error: "CARD_MISMATCH" };
            }
            // Ritual: sacrifica o aliado no servidor ANTES de invocar (evita Gamer+Tiamat).
            if (handCard?.summonRitual && a.freeAction) {
                const sacIdx = a.sacrificeIdx;
                const fieldNow = p.field;
                const sac = fieldNow?.[sacIdx];
                const req = handCard.summonRitual;
                if (sacIdx == null || sacIdx < 0 || !sac) {
                    return { ok: false, state, events: [], error: "NO_RITUAL_SACRIFICE" };
                }
                const sacPow = sac.currentPower ?? sac.power ?? 0;
                if (sacPow !== req)
                    return { ok: false, state, events: [], error: "BAD_RITUAL_POWER" };
                if (a.sacrificeUid != null && String(sac.uid || "") !== String(a.sacrificeUid)) {
                    return { ok: false, state, events: [], error: "BAD_RITUAL_UID" };
                }
                const removed = fieldNow.splice(sacIdx, 1)[0];
                events.push({
                    type: "DESTROY",
                    p: pid,
                    i: sacIdx,
                    reason: "ritualSacrifice",
                    card: removed,
                });
            }
            const card = hand.splice(summonIdx, 1)[0];
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
            events.push({ type: "SUMMON", playerId: pid, fieldIdx: fIdx, card: champ, cardName: champ.name });
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
            if (a.blocked) {
                const cost = leg.actionCost ?? R.getAttackActionCost(att, def);
                if (cost > 0)
                    p.actions = p.actions - cost;
                att.tapped = true;
                att.freeAttack = false;
                events.push({
                    type: "COMBAT_BLOCKED",
                    attacker: { p: pid, i: a.attackerIdx },
                    defender: { p: a.defenderPlayerId, i: a.defenderIdx },
                });
                break;
            }
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
            // Paridade com endTurn() do cliente: bônus de muralha no fim → avança →
            // manutenção/saque do PRÓXIMO jogador (não do que passou a vez).
            if (typeof R.applyWallBonusOnTurnEnd === "function") {
                R.applyWallBonusOnTurnEnd(next, pid);
            }
            const count = next.playersCount ?? next.players.length;
            next.currentPlayer = (pid + 1) % count;
            if (next.currentPlayer === 0) {
                next.turnNumber = (next.turnNumber ?? 1) + 1;
            }
            const nextPid = next.currentPlayer;
            const maint = R.runTurnMaintenance(next, nextPid, R.LIMITS);
            maint.poisonDestroyed.forEach((k) => {
                events.push({ type: "POISON_KILL", ...k, by: nextPid });
            });
            if (Array.isArray(maint.powerChanges)) {
                for (const ch of maint.powerChanges) {
                    if (ch?.targetP == null || ch?.targetI == null)
                        continue;
                    events.push({
                        type: "POWER_CHANGED",
                        targetP: ch.targetP,
                        targetI: ch.targetI,
                        currentPower: ch.currentPower | 0,
                        reason: ch.reason || "crescimento",
                    });
                }
            }
            if (maint.passiveVpGain > 0) {
                events.push({ type: "VP_GAIN", playerId: nextPid, amount: maint.passiveVpGain, reason: "maintenance" });
            }
            if (maint.poisonVpGain > 0) {
                events.push({ type: "VP_GAIN", playerId: nextPid, amount: maint.poisonVpGain, reason: "poison" });
            }
            maint.returned.forEach((r) => {
                events.push({ type: "PULLED_RETURN", ...r, toPlayer: nextPid });
            });
            const np = next.players[nextPid];
            const maxHand = R.LIMITS?.MAX_HAND ?? 8;
            if (!maint.skipDraw && np.hand.length < maxHand && np.deck.length > 0) {
                np.hand.push(np.deck.pop());
                events.push({ type: "DRAW", playerId: nextPid, reason: "upkeep" });
            }
            events.push({ type: "TURN_START", playerId: nextPid });
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
        case T.REACTIVE_CANCEL_ANSWER: {
            const ER = getEffects();
            if (!ER?.applyReactiveUse)
                return { ok: false, state, events: [], error: "NO_REACTIVE" };
            const res = ER.applyReactiveUse(next, pid, "cancelarUltimate", !!a.use);
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
            const talentHand = p.hand;
            const talentIdx = resolveSummonHandIdx(talentHand, a.handIdx, a.cardName, a.uid);
            a.handIdx = talentIdx;
            const res = ER.applyTalentFromHand(next, pid, talentIdx);
            if (!res.ok)
                return { ok: false, state, events: [], error: res.error || "TALENT_FAILED" };
            events.push(...(res.events || []));
            break;
        }
        case T.TALENT_DISCARD: {
            const ER = getEffects();
            if (typeof ER?.applyTalentDiscard !== "function") {
                return { ok: false, state, events: [], error: "NO_TALENT_DISCARD" };
            }
            const res = ER.applyTalentDiscard(next, pid);
            if (!res.ok)
                return { ok: false, state, events: res.events || [], error: res.error || "TALENT_DISCARD_FAILED" };
            events.push(...(res.events || []));
            break;
        }
        case T.TALENT_TARGET: {
            const ER = getEffects();
            if (typeof ER?.applyTalentTarget !== "function") {
                return { ok: false, state, events: [], error: "NO_TALENT_TARGET" };
            }
            const res = ER.applyTalentTarget(next, pid, a.targetPlayerId ?? a.targetP, a.targetFieldIdx ?? a.targetI);
            if (!res.ok)
                return { ok: false, state, events: res.events || [], error: res.error || "TALENT_TARGET_FAILED" };
            if (res.state)
                Object.assign(next, res.state);
            events.push(...(res.events || []));
            break;
        }
        case T.FIELD_COMMIT: {
            const mutations = a.mutations || [];
            for (const m of mutations) {
                const op = String(m.op || "");
                const tp = m.targetP;
                const ti = m.targetI;
                const owner = next.players[tp];
                const field = owner?.field;
                if (!field) {
                    return { ok: false, state, events: [], error: "NO_TARGET" };
                }
                if (op === "insertToken" || op === "insert") {
                    const cardSnap = { ...m.card };
                    if (!cardSnap.uid)
                        cardSnap.uid = `tok-${Date.now()}-${field.length}`;
                    if (cardSnap.currentPower == null)
                        cardSnap.currentPower = cardSnap.power ?? 0;
                    const idx = ti != null
                        ? Math.max(0, Math.min(ti | 0, field.length))
                        : field.length;
                    field.splice(idx, 0, cardSnap);
                    events.push({
                        type: "TOKEN_INSERT",
                        targetP: tp,
                        targetI: idx,
                        cardName: cardSnap.name,
                        uid: cardSnap.uid,
                    });
                    continue;
                }
                if (op === "setActions") {
                    owner.actions = m.actions | 0;
                    events.push({
                        type: "ACTIONS_SET",
                        targetP: tp,
                        actions: owner.actions,
                    });
                    continue;
                }
                if (op === "discardToHand") {
                    const discard = owner.discard || [];
                    let di = m.discardIdx;
                    if (di == null || di < 0) {
                        const cardObj = m.card;
                        const wantUid = cardObj?.uid || m.uid;
                        const wantName = cardObj?.name || m.cardName;
                        if (wantUid) {
                            di = discard.findIndex((c) => c && c.uid === wantUid);
                        }
                        if ((di == null || di < 0) && wantName) {
                            di = discard.findIndex((c) => c && c.name === wantName);
                        }
                    }
                    if (di == null || di < 0 || di >= discard.length) {
                        return { ok: false, state, events: [], error: "NO_DISCARD_CARD" };
                    }
                    discard.splice(di, 1);
                    owner.discard = discard;
                    const handCard = m.card && typeof m.card === "object"
                        ? { ...m.card }
                        : {};
                    delete handCard._summoning;
                    const hand = owner.hand || [];
                    hand.push(handCard);
                    owner.hand = hand;
                    events.push({
                        type: "NECROMANCIA",
                        casterIdx: tp,
                        card: handCard.name,
                        visual: "necromancia",
                    });
                    continue;
                }
                if (op === "returnToHand") {
                    const card = field?.[ti];
                    if (!card) {
                        return { ok: false, state, events: [], error: "NO_TARGET" };
                    }
                    field.splice(ti, 1);
                    const handCard = m.handCard && typeof m.handCard === "object"
                        ? { ...m.handCard }
                        : { ...card, tapped: false, freeAttack: false };
                    delete handCard._summoning;
                    const hand = owner.hand || [];
                    hand.push(handCard);
                    owner.hand = hand;
                    events.push({
                        type: "SCARE_RETURN",
                        targetP: tp,
                        targetI: ti,
                        cardName: handCard.name,
                        visual: "scare_return",
                    });
                    continue;
                }
                const card = field?.[ti];
                if (!card) {
                    return { ok: false, state, events: [], error: "NO_TARGET" };
                }
                if (op === "reducePower") {
                    const amount = m.amount | 0;
                    if (typeof R.reduceChampionPower === "function") {
                        R.reduceChampionPower(card, amount);
                    }
                    else {
                        card.currentPower = Math.max(0, (card.currentPower ?? card.power ?? 0) - amount);
                    }
                    events.push({
                        type: "POWER_REDUCED",
                        targetP: tp,
                        targetI: ti,
                        amount,
                        powerAfter: card.currentPower,
                    });
                    const destroyIfZero = m.destroyIfZero !== false;
                    if (destroyIfZero && (card.currentPower ?? 0) <= 0) {
                        field.splice(ti, 1);
                        const discard = owner.discard || [];
                        discard.push(card);
                        owner.discard = discard;
                        events.push({
                            type: "DESTROY",
                            p: tp,
                            i: ti,
                            reason: m.reason || "field_commit",
                            card: card.name,
                        });
                        if (m.awardVpTo != null && !m.noVpOnKill) {
                            const killer = next.players[m.awardVpTo];
                            if (killer) {
                                const amountVp = 1;
                                killer.vp = (killer.vp ?? 0) + amountVp;
                                events.push({
                                    type: "VP_GAIN",
                                    playerId: m.awardVpTo,
                                    amount: amountVp,
                                    reason: m.reason || "field_commit",
                                });
                            }
                        }
                        const burst = R.applyOnDestroyBurst(next, tp, card, m.reason || "field_commit", ctx.rng);
                        if (burst?.ability) {
                            events.push({
                                type: "ON_DESTROY_BURST",
                                ownerIdx: tp,
                                source: card.name,
                                reason: m.reason || "field_commit",
                                ...burst,
                            });
                        }
                    }
                }
                else if (op === "destroy") {
                    field.splice(ti, 1);
                    const discard = owner.discard || [];
                    discard.push(card);
                    owner.discard = discard;
                    events.push({
                        type: "DESTROY",
                        p: tp,
                        i: ti,
                        reason: m.reason || "field_commit",
                        card: card.name,
                    });
                    const noHonor = !m.forceAward && R.hasNoHonor(card);
                    if (m.awardVpTo != null && !m.noVpOnKill && !noHonor) {
                        const killer = next.players[m.awardVpTo];
                        if (killer) {
                            killer.vp = (killer.vp ?? 0) + 1;
                            events.push({
                                type: "VP_GAIN",
                                playerId: m.awardVpTo,
                                amount: 1,
                                reason: m.reason || "field_commit",
                            });
                        }
                    }
                    const burst = R.applyOnDestroyBurst(next, tp, card, m.reason || "field_commit", ctx.rng);
                    if (burst?.ability) {
                        events.push({
                            type: "ON_DESTROY_BURST",
                            ownerIdx: tp,
                            source: card.name,
                            reason: m.reason || "field_commit",
                            ...burst,
                        });
                    }
                }
                else if (op === "setStatus") {
                    const STATUS_BOOL = [
                        "frozen", "tapped", "freeAttack", "shielded", "shieldedPermanent",
                        "barrier", "barrierPermanent", "vulnerable", "silenced", "poisoned",
                        "fury", "pulled", "inspiracao", "mimico", "wallBuff", "guerraBuff",
                        "foreverGrowth", "fireAura", "burning", "corruptedNoHonor", "furyBonusActive",
                    ];
                    const STATUS_NUM = [
                        "frozenTurns", "shieldedTurns", "barrierTurns", "poisonTurns",
                        "furyTurns", "furyStacks", "guerraBuffTurns", "burningTurns",
                        "fireAuraTurns", "currentPower", "poisonedByP", "burningByP",
                    ];
                    const STATUS_ANY = [
                        "abilityType", "abilityName", "abilityDesc", "onEnter", "onDestroy",
                        "talentEffect", "constantEffect", "summonRitual",
                        "mimicAbilityName", "mimicAbilityDesc", "mimicOnEnter", "mimicOnDestroy",
                        "mimicSourceName", "mimicConstantEffect",
                    ];
                    const flags = (m.flags || m);
                    for (const k of STATUS_BOOL) {
                        if (flags[k] != null)
                            card[k] = !!flags[k];
                    }
                    for (const k of STATUS_NUM) {
                        if (flags[k] != null)
                            card[k] = flags[k] | 0;
                    }
                    for (const k of STATUS_ANY) {
                        if (Object.prototype.hasOwnProperty.call(flags, k)) {
                            card[k] = flags[k];
                        }
                    }
                    events.push({
                        type: "STATUS_SET",
                        targetP: tp,
                        targetI: ti,
                        flags: { ...flags },
                    });
                }
                else if (op === "transformToken") {
                    const patch = (m.card || m.flags || m);
                    const IDENTITY = [
                        "name", "power", "basePower", "currentPower", "abilityType", "abilityName",
                        "abilityDesc", "onEnter", "onDestroy", "talentEffect", "summonRitual",
                        "constantEffect", "isToken", "hidden",
                    ];
                    for (const k of IDENTITY) {
                        if (Object.prototype.hasOwnProperty.call(patch, k)) {
                            card[k] = patch[k];
                        }
                    }
                    // Limpa status temporários — criatura “renasce” (Transformar / Ursificar).
                    card.frozen = false;
                    card.frozenTurns = 0;
                    card.shielded = false;
                    card.shieldedTurns = 0;
                    card.shieldedPermanent = false;
                    card.freeAttack = false;
                    card.silenced = false;
                    card.poisoned = false;
                    card.poisonTurns = 0;
                    card.poisonedByP = -1;
                    card.pulled = false;
                    card.pulledFromOwner = -1;
                    card.pulledTurns = 0;
                    card.wallBuff = false;
                    card.wallBuffApplied = false;
                    card.wallBuffSnapshot = 0;
                    card.foreverGrowth = false;
                    card.guerraBuff = false;
                    card.guerraBuffTurns = 0;
                    card.barrier = false;
                    card.barrierTurns = 0;
                    card.barrierPermanent = false;
                    card.fireAura = false;
                    card.fireAuraTurns = 0;
                    card.burning = false;
                    card.burningTurns = 0;
                    card.burningByP = undefined;
                    card.fury = false;
                    card.furyTurns = 0;
                    card.furyStacks = 0;
                    card.furyBonusActive = false;
                    card.vulnerable = false;
                    card.corruptedNoHonor = false;
                    events.push({
                        type: "STATUS_SET",
                        targetP: tp,
                        targetI: ti,
                        flags: { ...patch, transformToken: true },
                    });
                }
            }
            break;
        }
        case T.ULTIMATE_PLAY: {
            const ult = applyUltimatePlay(state, a, ctx.rng || Math.random);
            if (!ult.ok)
                return { ok: false, state, events: ult.events, error: ult.error || "ULTIMATE_FAILED" };
            return { ok: true, state: ult.state, events: ult.events };
        }
        case T.UNFREEZE_CONFIRM: {
            const fIdx = a.fieldIdx;
            const pl = next.players[pid];
            const field = pl.field;
            const card = field?.[fIdx];
            if (!card?.frozen)
                return { ok: false, state, events: [], error: "NOT_FROZEN" };
            const yes = a.yes === true || a.confirmed === true
                || (a.choiceIndex === 0 && a.yes !== false && a.confirmed !== false);
            if (yes) {
                if ((pl.actions | 0) < 1) {
                    return { ok: false, state, events: [], error: "INSUFFICIENT_ACTIONS" };
                }
                pl.actions = (pl.actions | 0) - 1;
                card.frozen = false;
                card.frozenTurns = 0;
                events.push({
                    type: "STATUS_SET",
                    targetP: pid,
                    targetI: fIdx,
                    flags: { frozen: false, frozenTurns: 0 },
                });
                events.push({
                    type: "UNFREEZE",
                    playerId: pid,
                    fieldIdx: fIdx,
                    visual: "unfreeze",
                });
            }
            break;
        }
        case T.NECROMANCIA_PICK: {
            const casterIdx = (a.casterIdx ?? pid);
            const owner = next.players[casterIdx];
            const discard = owner.discard || [];
            let di = a.discardIndex;
            if (di == null)
                di = a.discardIdx;
            const cardObj = a.card;
            const wantUid = a.uid || cardObj?.uid;
            const wantName = a.cardName || cardObj?.name;
            if ((di == null || di < 0) && wantUid) {
                di = discard.findIndex((c) => c && c.uid === wantUid);
            }
            if ((di == null || di < 0) && wantName) {
                di = discard.findIndex((c) => c && c.name === wantName);
            }
            if (di == null || di < 0 || di >= discard.length) {
                return { ok: false, state, events: [], error: "NECRO_BAD_CARD" };
            }
            const raw = discard.splice(di, 1)[0];
            owner.discard = discard;
            const handCard = { ...(cardObj && typeof cardObj === "object" ? cardObj : raw) };
            // Sanitiza statuses (paridade com resolveNecromanciaChoice no cliente).
            handCard.frozen = false;
            handCard.frozenTurns = 0;
            handCard.tapped = false;
            handCard.shielded = false;
            handCard.shieldedTurns = 0;
            handCard.freeAttack = false;
            handCard.silenced = false;
            handCard.poisoned = false;
            handCard.poisonTurns = 0;
            handCard.pulled = false;
            handCard.fury = false;
            handCard.furyStacks = 0;
            handCard.barrier = false;
            handCard.fireAura = false;
            handCard.burning = false;
            handCard.vulnerable = false;
            handCard.corruptedNoHonor = false;
            delete handCard._summoning;
            const hand = owner.hand || [];
            hand.push(handCard);
            owner.hand = hand;
            const ER = getEffects();
            if (typeof ER?.markOnEnterUsed === "function" && a.fieldIdx != null) {
                try {
                    ER.markOnEnterUsed(next, casterIdx, "necromancia");
                }
                catch (e) { /* */ }
            }
            events.push({
                type: "NECROMANCIA",
                casterIdx,
                card: handCard.name,
                visual: "necromancia",
            });
            break;
        }
        case T.ABILITY_TARGET: {
            const ER = getEffects();
            if (!ER?.applyOnEnter)
                return { ok: false, state, events: [], error: "NO_RESOLVE" };
            const cIdx = (a.casterIdx ?? pid);
            const fIdx = a.fieldIdx;
            const resolution = {
                ...(a.resolution && typeof a.resolution === "object"
                    ? a.resolution
                    : {}),
                rng: ctx.rng || Math.random,
            };
            if (a.targetP != null)
                resolution.targetP = a.targetP;
            if (a.targetI != null)
                resolution.targetI = a.targetI;
            if (a.targetPlayerIdx != null)
                resolution.targetPlayerIdx = a.targetPlayerIdx;
            if (a.success != null)
                resolution.success = a.success;
            if (a.necromanciaCard)
                resolution.necromanciaCard = a.necromanciaCard;
            const abilityKey = String(a.abilityKey || "");
            if (["fortalecer", "devorar", "imitar", "ursificacao", "corromper"].includes(abilityKey)
                && resolution.targetI != null) {
                delete resolution.targetP;
            }
            const res = ER.applyOnEnter(next, cIdx, fIdx, resolution);
            if (!res.ok) {
                return { ok: false, state, events: res.events || [], error: res.error || "ABILITY_TARGET_FAILED" };
            }
            events.push(...(res.events || []));
            break;
        }
        case T.ULTIMATE_TARGET: {
            const ult = applyUltimatePlay(next, { ...a, type: T.ULTIMATE_PLAY, playerId: pid }, ctx.rng || Math.random);
            if (!ult.ok)
                return { ok: false, state, events: ult.events, error: ult.error || "ULTIMATE_FAILED" };
            return { ok: true, state: ult.state, events: ult.events };
        }
        case T.MENU_CHOICE: {
            const kind = String(a.menuKind || a.menuType || a.abilityKey || "");
            if (kind === "unfreeze" || kind === "UNFREEZE_CONFIRM") {
                const yes = a.choiceIndex === 0 || a.yes === true || a.confirmed === true;
                const inner = applyAction(state, {
                    ...a,
                    type: T.UNFREEZE_CONFIRM,
                    yes,
                    fieldIdx: a.fieldIdx,
                    playerId: pid,
                }, ctx);
                return inner;
            }
            if (kind === "target-player" || a.targetPlayerIdx != null || a.abilityKey) {
                const ER = getEffects();
                if (!ER?.applyOnEnter)
                    return { ok: false, state, events: [], error: "NO_RESOLVE" };
                const cIdx = (a.casterIdx ?? pid);
                const fIdx = a.fieldIdx;
                const targets = a.targets;
                let targetPlayerIdx = a.targetPlayerIdx;
                if (targetPlayerIdx == null && Array.isArray(targets) && a.choiceIndex != null) {
                    targetPlayerIdx = targets[a.choiceIndex]?.p;
                }
                if (targetPlayerIdx == null && a.choiceIndex != null) {
                    // Fallback: oponente do caster.
                    targetPlayerIdx = 1 - cIdx;
                }
                const res = ER.applyOnEnter(next, cIdx, fIdx, {
                    targetPlayerIdx,
                    rng: ctx.rng || Math.random,
                });
                if (!res.ok) {
                    return { ok: false, state, events: res.events || [], error: res.error || "MENU_CHOICE_FAILED" };
                }
                events.push(...(res.events || []));
                break;
            }
            return { ok: false, state, events: [], error: "BAD_MENU" };
        }
        default: {
            const uiOnly = new Set([
                T.PLAY_VISUAL,
                T.PRESENT,
                T.OPEN_DISCARD,
                T.ATTACK_START,
                T.ATTACK_PICK_ATTACKER,
                T.ATTACK_PICK_DEFENDER,
                T.REACTIVE_BLOCK_QUERY,
                T.REACTIVE_PROTECTION_QUERY,
                T.REACTIVE_CANCEL_QUERY,
                T.ABILITY_START,
                T.ULTIMATE_START,
                T.SYNC_STATE,
                T.LOBBY_CREATE,
                T.LOBBY_JOIN,
                T.SETUP_HERO,
                T.SETUP_WIN_POINTS,
                T.MATCH_START,
                T.RESTART_MATCH,
            ]);
            if (uiOnly.has(a.type)) {
                return { ok: true, state: next, events: [{ type: "CLIENT_ONLY", actionType: a.type }] };
            }
            return { ok: false, state, events: [], error: "NOT_IMPLEMENTED" };
        }
    }
    // Evita winner === undefined (checkWin legado tratava !== null como vitória).
    if (next.winner === undefined)
        next.winner = null;
    const winner = R.findWinnerIndex(next);
    if (winner != null) {
        next.winner = winner;
        events.push({ type: "GAME_OVER", winner });
    }
    else if (next.winner == null) {
        next.winner = null;
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
    if (mode === "none")
        return resolution;
    if (mode === "visual_only")
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
        const allies = R.gatherAllyTargets(state, casterIdx, fieldIdx);
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
            // target / necromancia: cliente humano escolhe — não auto-resolver no SUMMON.
            if (!plan?.ok || plan.mode === "target" || plan.mode === "blocked"
                || plan.mode === "necromancia_pick")
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
