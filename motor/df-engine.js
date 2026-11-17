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
            // Trava de turno (Fase 6 T5): canAttack não checa de quem é o
            // turno — sem isto, um cliente podia atacar no turno do outro.
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
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
        case T.REACTIVE_EXHAUSTION_ANSWER:
            if (!a.use)
                return { ok: true, code: "OK" };
            return R.canOfferExaustao(state, pid, a.attOwner ?? 1 - pid);
        case T.REACTIVE_COUNTER_ANSWER:
            if (!a.use)
                return { ok: true, code: "OK" };
            return R.canOfferContramagica(state, pid, a.attOwner ?? 1 - pid);
        case T.ON_ENTER_RESOLVE:
            if (a.casterIdx == null || a.fieldIdx == null)
                return { ok: false, code: "BAD_ON_ENTER" };
            return R.canResolveOnEnter(state, a.casterIdx, a.fieldIdx, ctx);
        case T.RITUAL_EXHAUSTED: {
            // C-A09: o invocador avisa que o defensor respondeu SIM à
            // EXAUSTÃO pré-sacrifício. A carta fica na mão com BOLHAS.
            // A EXAUSTÃO do defensor já foi consumida pela ANSWER.
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const hand = state.players[pid]?.hand;
            const idx = resolveSummonHandIdx(hand || [], a.handIdx, a.cardName, a.uid);
            const card = hand?.[idx];
            if (!card)
                return { ok: false, code: "NO_CARD" };
            if (!card.summonRitual)
                return { ok: false, code: "NOT_RITUAL" };
            if ((card.ritual_bolhas ?? 0) > 0)
                return { ok: false, code: "ALREADY_BOLHAS" };
            return { ok: true, code: "OK" };
        }
        case T.TALENT_START: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            // C-M25 (offline: um talento por vez — o talento ativo ocupa
            // o 7º slot do campo): recusar antes de gastar qualquer ação.
            if (state.activeTalent)
                return { ok: false, code: "TALENT_ALREADY_ACTIVE" };
            const hand = state.players[pid]?.hand;
            const talentIdx = resolveSummonHandIdx(hand || [], a.handIdx, a.cardName, a.uid);
            const handCard = hand?.[talentIdx];
            if (!handCard || handCard.category !== "talent")
                return { ok: false, code: "NOT_TALENT" };
            // U-B12 (rodada 5): reações têm category "talent" + subcategory
            // "reaction" — nunca são talentos jogáveis (o cliente oficial já
            // bloqueia e a IA nunca envia; endurecimento do servidor).
            if (handCard.subcategory === "reaction")
                return { ok: false, code: "NOT_TALENT" };
            const pl = state.players[pid];
            // Custo por carta (manual §9.1): talento Custo 0 vale com 0 ações.
            const talentCost = R.talentPlayCost?.(handCard)
                ?? handCard.currentPower
                ?? handCard.power
                ?? 0;
            if ((pl.actions ?? 0) < talentCost)
                return { ok: false, code: "INSUFFICIENT_ACTIONS" };
            // C-A14 (offline 1.51.48): RESSUSCITAR sem P2 no descarte é
            // recusada ANTES de gastar — a pré-checagem espelha o pick
            // do caso (hasRessuscitarTarget) para não divergir dele.
            if (handCard.talentEffect === "ressuscitarTalento") {
                const ER = getEffects();
                if (ER?.hasRessuscitarTarget && !ER.hasRessuscitarTarget(state, pid))
                    return { ok: false, code: "NO_P2_DISCARD" };
            }
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
            // B-N04/B-N05: o alvo inválido é recusado SEM consumir o
            // talento (offline: o alvo nem é oferecido — o jogador/IA
            // escolhe outro). Sem isto, o talento era consumido sem
            // efeito (BOLA/EXPLOSÃO em Barreira, TORNADO em Barreira)
            // ou o motor devolvia INVALID_TARGET com o talento travado.
            const at = state.activeTalent;
            const te = at?.card?.talentEffect;
            const tp = a.targetPlayerId ?? a.targetP;
            const ti = a.targetFieldIdx ?? a.targetI;
            const target = (tp != null && ti != null) ? state.players[tp]?.field?.[ti] : null;
            if (!target)
                return { ok: false, code: "NO_TARGET" };
            const isOwnCharmed = !!(target.charme && target.charmeOriginalOwner === pid);
            const enemyTalents = ["bolaDeFogoTalento", "explosao", "transformarBichinhoTalento",
                "tornadoDeFogo", "baforadaVenenosa", "prisaoPrismaticaTalento"];
            if (isOwnCharmed && enemyTalents.includes(te))
                return { ok: false, code: "INVALID_TARGET" };
            const blockedByBarrier = ["bolaDeFogoTalento", "explosao",
                "transformarBichinhoTalento", "tornadoDeFogo"];
            if (blockedByBarrier.includes(te) && (target.barrier || target.barrierPermanent))
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true, code: "OK" };
        }
        case T.TALENT_AUTO: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            if (!state.activeTalent)
                return { ok: false, code: "NO_ACTIVE_TALENT" };
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
            // C-M09 (offline: o menu mostra só as últimas 4): recusar
            // qualquer escolha fora das últimas 4 cartas do descarte.
            if (di < discard.length - 4)
                return { ok: false, code: "NECRO_NOT_IN_LAST4" };
            return { ok: true, code: "OK" };
        }
        case T.ABILITY_TARGET: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const cIdx = (a.casterIdx ?? pid);
            const fIdx = a.fieldIdx;
            if (fIdx == null || fIdx < 0)
                return { ok: false, code: "BAD_ON_ENTER" };
            const leg = R.canResolveOnEnter(state, cIdx, fIdx, ctx);
            if (!leg.ok)
                return leg;
            // C-M16: rejeição precoce do alvo inválido (antes de gastar a
            // entrada) — o applyOnEnter também valida (defesa em profundidade).
            if (a.targetI != null) {
                const v = R.validateAbilityTarget?.(state, cIdx, fIdx, a.targetP, a.targetI);
                if (v && !v.ok)
                    return { ok: false, code: v.code || "INVALID_TARGET" };
            }
            return { ok: true, code: "OK" };
        }
        case T.ULTIMATE_TARGET:
            return validateUltimatePlay(state, { ...a, type: T.ULTIMATE_PLAY });
        case T.MENU_CHOICE: {
            if (state.currentPlayer !== pid)
                return { ok: false, code: "NOT_YOUR_TURN" };
            const kind = String(a.menuKind || a.menuType || a.abilityKey || "");
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
    // C-M26: expiração da APODRECIDA (~3 s em campo) — antes da validação,
    // para que um slot liberado pela expiração já conte no canSummon.
    // Numa ação rejeitada o clone (e a varredura) é descartado; a próxima
    // ação aceita varre de novo.
    const expiredEvents = typeof R.expireApodrecidas === "function"
        ? R.expireApodrecidas(next) : [];
    const pid = (a.playerId ?? next.currentPlayer);
    const check = validateAction(next, a, ctx);
    if (check.ok === false) {
        // C-N4 (offline use_ultimate, game_state.gd:1416): a REUTILIZAÇÃO
        // com instantânea inválida GASTA o uso (fizzle) — o fizzle mora
        // dentro de applyUltimatePlay, mas esta validação barraria antes
        // e ele nunca seria alcançado (a autoridade chama applyAction).
        // Delega o INVALID_TARGET de ULTIMATE_PLAY e ULTIMATE_TARGET
        // para lá (rodada 4, t_961: o cliente envia ULTIMATE_TARGET para
        // ultimates com mira — a delegação só com ULTIMATE_PLAY nunca
        // era alcançada no caminho real): só o reuseInstant com alvo
        // próprio existente vira fizzle (ok:true); os demais voltam a
        // falhar como antes.
        if ((a.type === "ULTIMATE_PLAY" || a.type === "ULTIMATE_TARGET")
            && (check.code === "INVALID_TARGET" || check.error === "INVALID_TARGET")) {
            const ult = applyUltimatePlay(next, a, ctx.rng || Math.random);
            if (ult.ok) {
                return { ok: true, state: ult.state, events: [...expiredEvents, ...(ult.events || [])] };
            }
        }
        const c = check;
        return { ok: false, state, events: [], error: c.code || c.error || "ILLEGAL" };
    }
    const events = [...expiredEvents];
    const T = getProtocol().ACTION_TYPES;
    const p = next.players[pid];
    // C-A07 (Lote F): um resolver interno pode suspender (RAIO/CHUVA) —
    // o `suspended` sobrevive ao switch e volta no retorno.
    let suspended = null;
    switch (a.type) {
        case T.DRAW_CARD: {
            if (!R.canBuyCard(next, pid).ok)
                return { ok: false, state, events: [], error: "DRAW_ILLEGAL" };
            const deck = p.deck;
            const card = deck.pop();
            if (!card)
                return { ok: false, state, events: [], error: "DECK_EMPTY" };
            if (p.bolhasActive && card?.category === "champion") {
                card.bolhas = true;
            }
            p.hand.push(card);
            p.actions = p.actions - 1;
            events.push({ type: "DRAW", playerId: pid, card });
            break;
        }
        case T.RITUAL_EXHAUSTED: {
            // C-A09 (offline 1.51.48 item 1): SIM cancela tudo — o
            // sacrifício NÃO acontece, a carta fica na mão com BOLHAS
            // por 2 rodadas. Nenhuma ação é cobrada (a invocação não
            // aconteceu). A EXAUSTÃO já foi consumida pela ANSWER.
            const hand = p.hand;
            const idx = resolveSummonHandIdx(hand, a.handIdx, a.cardName, a.uid);
            const card = hand?.[idx];
            if (!card || !card.summonRitual)
                return { ok: false, state, events: [], error: "NOT_RITUAL" };
            if ((card.ritual_bolhas ?? 0) > 0)
                return { ok: false, state, events: [], error: "ALREADY_BOLHAS" };
            card.ritual_bolhas = 2;
            events.push({
                type: "RITUAL_EXHAUSTED",
                playerId: pid,
                handIdx: idx,
                cardName: card.name,
                ritualBolhas: 2,
            });
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
                const sacDiscard = p.discard || [];
                sacDiscard.push(removed);
                p.discard = sacDiscard;
                events.push({
                    type: "DESTROY",
                    p: pid,
                    i: sacIdx,
                    reason: "ritualSacrifice",
                    card: removed,
                });
                // C-M20 (offline: o sacrifício do Ritual dispara VINGANÇA/
                // LEGADO como qualquer destruição — sem PV para o sacrifício).
                const sacBurst = R.applyOnDestroyBurst?.(next, pid, removed, "ritualSacrifice", ctx.rng);
                if (sacBurst?.ability) {
                    events.push({
                        type: "ON_DESTROY_BURST",
                        ownerIdx: pid,
                        source: removed.name,
                        uid: removed.uid,
                        reason: "ritualSacrifice",
                        ...sacBurst,
                    });
                }
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
            // BOLHAS (talento, P2): o primeiro campeão com BOLHAS
            // invocado entra SILENCIADO e consome o efeito (espelho
            // do offline: silenciado, apaga bolhas, bolhas_active =
            // false, apaga bolhas do resto da mão; NÃO anula o
            // onEnter — o silêncio o bloqueia via canResolveOnEnter).
            if (p.bolhasActive && card.bolhas) {
                champ.silenced = true;
                champ.bolhas = false;
                p.bolhasActive = false;
                for (const hc of p.hand || []) {
                    if (hc)
                        hc.bolhas = false;
                }
                events.push({
                    type: "BOLHAS_CONSUMED",
                    playerId: pid,
                    cardName: champ.name,
                    visual: "bolhas",
                });
            }
            // (1.51.6) INVESTIDA: ao entrar, o campeão RECEBE a habilidade na
            // hora — o ataque livre vale já neste turno, não só no próximo
            // (offline game_state.gd:904-906; o start_turn renova a cada turno).
            // Sem isto o motor recusava o ataque com INSUFFICIENT_ACTIONS
            // (Lote F, bug #1 — t_930).
            if ((champ.constantEffect === "investida" || champ.abilityName === "Investida") && !champ.silenced)
                champ.freeAttack = true;
            const field = p.field;
            if (R.ensureFieldSlots) {
                R.ensureFieldSlots(field);
                // Espaço pedido inválido/ocupado → padrão centro-para-fora (não rejeita a jogada).
                const wanted = a.slot;
                const slot = R.isValidFieldSlot?.(wanted) && R.freeFieldSlots?.(field).includes(wanted)
                    ? wanted
                    : (a.insertIdx != null ? null : R.pickDefaultFieldSlot?.(field));
                if (slot != null && slot >= 0) {
                    champ.slot = slot;
                    field.splice(R.insertIndexForSlot(field, slot), 0, champ);
                }
                else {
                    delete champ.slot;
                    field.splice(Math.min(a.insertIdx, field.length), 0, champ);
                    R.ensureFieldSlots(field);
                }
            }
            else {
                const insertIdx = a.insertIdx != null
                    ? a.insertIdx
                    : R.defaultSummonInsertIndex(field.length);
                field.splice(Math.min(insertIdx, field.length), 0, champ);
            }
            if (!a.freeAction)
                p.actions = p.actions - R.championSummonCost(card);
            const fIdx = field.indexOf(champ);
            // C-A02: uma NOVA fonte de INSPIRAR entrando limpa o bloqueio dos
            // vizinhos DELA (offline _clear_inspirar_broken); o recalc no fim
            // da ação devolve o +1 aos vizinhos.
            if (R.hasInspirar?.(champ)) R.clearInspirarBrokenForNeighbors?.(next, pid, fIdx);
            events.push({ type: "SUMMON", playerId: pid, fieldIdx: fIdx, card: champ, cardName: champ.name });
            // C-M26 (offline: a APODRECIDA invocada entra em campo e some
            // ~3 s depois): marca o prazo de expiração; a varredura no
            // início de cada ação (applyAction) a remove para o descarte.
            if (card.podridao) {
                champ.apodrecidaExpiresAt = Date.now() + 3000;
                events.push({
                    type: "APODRECIDA_ENTERED",
                    playerId: pid, fieldIdx: fIdx,
                    cardName: champ.name, visual: "apodrecida_play",
                });
            }
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
            // (1.51.6 / offline game_state.gd:1139 — attack()): o ataque
            // CONSOME o uso livre. Só o ramo bloqueado o zerava; o
            // combate normal deixava freeAttack=true (Lote F, bug #1b —
            // t_930: a GRISELDA seguia com freeAttack após atacar).
            att.freeAttack = false;
            events.push({
                type: "COMBAT",
                attacker: { p: pid, i: a.attackerIdx },
                defender: { p: a.defenderPlayerId, i: a.defenderIdx },
                outcome: out,
            });
            if (out.killD) {
                defField.splice(a.defenderIdx, 1);
                // Paridade com destroyChampion do cliente: mortos em combate vão ao descarte
                // (Paladino / Necromancia / etc. no servidor MP).
                const defDiscard = defP.discard || [];
                defDiscard.push(def);
                defP.discard = defDiscard;
                events.push({
                    type: "DESTROY",
                    p: a.defenderPlayerId,
                    i: a.defenderIdx,
                    reason: "combat",
                    card: def.name,
                    uid: def.uid,
                });
                const noHonor = R.hasNoHonor(def);
                if (out.pvTo === "attacker" && !noHonor) {
                    const amount = R.combatVictoryPointReward(att);
                    p.vp = (p.vp ?? 0) + amount;
                    events.push({ type: "VP_GAIN", playerId: pid, amount, reason: "combat" });
                }
                const burst = R.applyOnDestroyBurst(next, a.defenderPlayerId, def, "combat", ctx.rng, out.killA ? att.uid : null);
                if (burst?.ability) {
                    events.push({
                        type: "ON_DESTROY_BURST",
                        ownerIdx: a.defenderPlayerId,
                        source: def.name,
                        uid: def.uid,
                        reason: "combat",
                        ...burst,
                    });
                }
                // Laço de Sangue: atacante (ainda em campo) buffa aliado aleatório.
                if (!out.killA && (R.hasLacoDeSangue?.(att) || (att.constantEffect === "lacoDeSangue" && !att.silenced))) {
                    const laco = R.applyLacoDeSangue?.(next, pid, ctx.rng || Math.random, att.uid);
                    if (laco && laco.targetI != null) {
                        events.push({
                            type: "LACO_DE_SANGUE",
                            killerP: pid,
                            killerUid: att.uid,
                            targetP: pid,
                            targetI: laco.targetI,
                            targetName: laco.targetName,
                            visual: "laco_de_sangue",
                        });
                    }
                }
            }
            const attHadLaco = !!(out.killD && out.killA && (R.hasLacoDeSangue?.(att)
                || (att.constantEffect === "lacoDeSangue" && !att.silenced)));
            if (out.killA) {
                field.splice(a.attackerIdx, 1);
                const attDiscard = p.discard || [];
                attDiscard.push(att);
                p.discard = attDiscard;
                events.push({
                    type: "DESTROY",
                    p: pid,
                    i: a.attackerIdx,
                    reason: "combat",
                    card: att.name,
                    uid: att.uid,
                });
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
                        uid: att.uid,
                        reason: "combat",
                        ...burst,
                    });
                }
            }
            // Empate mútuo: Laço ainda tenta buffar aliados restantes.
            if (attHadLaco) {
                const laco = R.applyLacoDeSangue?.(next, pid, ctx.rng || Math.random, att.uid);
                if (laco && laco.targetI != null) {
                    events.push({
                        type: "LACO_DE_SANGUE",
                        killerP: pid,
                        killerUid: att.uid,
                        targetP: pid,
                        targetI: laco.targetI,
                        targetName: laco.targetName,
                        visual: "laco_de_sangue",
                    });
                }
            }
            break;
        }
        case T.END_TURN: {
            if (!R.canEndTurn(next, pid).ok)
                return { ok: false, state, events: [], error: "NOT_YOUR_TURN" };
            // D-N01 (rede de segurança): um talento ativo NUNCA sobrevive
            // à virada de turno — offline o talento resolve na mesma ação;
            // se o follow-up nunca chegou (IA travada, mira sem resposta),
            // a carta já está no descarte desde o TALENT_START e só a
            // trava é limpa, para o próximo turno aceitar talentos de novo.
            // Sem isto, TALENT_ALREADY_ACTIVE bloqueia todos os talentos
            // da partida para sempre.
            if (next.activeTalent && next.activeTalent.ownerP === pid) {
                const stale = next.activeTalent;
                next.activeTalent = null;
                events.push({ type: "TALENT_DISCARDED", playerId: pid,
                    talentEffect: stale.card?.talentEffect || null,
                    cardName: stale.card?.name || null, reason: "end_turn" });
            }
            // C-A18: o CONGELADO ticka no fim do turno do DONO (offline
            // end_turn → _tick_frozen(current)) — ANTES de trocar o turno.
            const unfrozen = R.applyTurnEndFrozenTicks?.(next, pid) || [];
            for (const u of unfrozen) {
                events.push({
                    type: "STATUS_SET",
                    targetP: u.targetP,
                    targetI: u.targetI,
                    flags: { frozen: false, frozenTurns: 0 },
                });
            }
            // Paridade com endTurn() do cliente: bônus de muralha no fim → avança →
            // manutenção/saque do PRÓXIMO jogador (não do que passou a vez).
            if (typeof R.applyWallBonusOnTurnEnd === "function") {
                R.applyWallBonusOnTurnEnd(next, pid);
            }
            const count = next.playersCount ?? next.players.length;
            next.currentPlayer = (pid + 1) % count;
            // t_852: turnNumber conta TURNOS, não rodadas — como o offline
            // (game_state.gd:703: turn_number += 1 a cada end_turn; setup
            // começa em 1). Antes só incrementava quando a vez voltava ao
            // jogador 0, então a sequência era (1,0)→(1,1)→(2,0) e o banner
            // de PV passivo (portão turn_number >= 3) disparava um round
            // atrasado. Agora: (1,0)→(2,1)→(3,0), igual ao offline.
            next.turnNumber = (next.turnNumber ?? 1) + 1;
            const nextPid = next.currentPlayer;
            const maint = R.runTurnMaintenance(next, nextPid, R.LIMITS);
            maint.poisonDestroyed.forEach((k) => {
                // C-A22: `by` é o ENVENENADOR (killerP), não a vítima.
                events.push({ type: "POISON_KILL", ...k, by: k.killerP ?? nextPid });
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
                // C-A22: o PV do veneno vai para o envenenador.
                events.push({ type: "VP_GAIN", playerId: maint.poisonKillerP ?? nextPid, amount: maint.poisonVpGain, reason: "poison" });
            }
            // C-A01: Em Chamas — ticks do turno do aplicador (+1 PV por destruição).
            if (Array.isArray(maint.burnTicks)) {
                for (const t of maint.burnTicks) {
                    events.push({ type: "BURN_TICK", ...t });
                }
            }
            if (Array.isArray(maint.burnDestroyed) && maint.burnDestroyed.length > 0) {
                for (const k of maint.burnDestroyed) {
                    events.push({ type: "BURN_KILL", ...k, by: nextPid });
                }
                if (maint.burnVpGain > 0) {
                    events.push({ type: "VP_GAIN", playerId: nextPid, amount: maint.burnVpGain, reason: "emChamas" });
                }
            }
            maint.returned.forEach((r) => {
                events.push({ type: "PULLED_RETURN", ...r, toPlayer: nextPid });
            });
            const np = next.players[nextPid];
            // SEM-QUEIMA (2026-11-15 — REVOGA C-M15): o saque grátis
            // com a mão cheia NÃO acontece — a carta permanece no
            // baralho (drawCardWithBurn retorna null) e nenhum evento
            // DRAW é emitido; PESADELO skipDraw = sem saque.
            if (!maint.skipDraw && np.deck.length > 0) {
                const res = R.drawCardWithBurn?.(next, nextPid);
                if (res?.card) {
                    if (np.bolhasActive && res.card?.category === "champion")
                        res.card.bolhas = true;
                    events.push({ type: "DRAW", playerId: nextPid, reason: "upkeep" });
                }
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
            // C-B10: descartar stolenHandIdx forjado antes de repassar —
            // nenhum efeito deve ler um índice escolhido pelo cliente.
            const resolution = { ...(a.resolution || {}) };
            delete resolution.stolenHandIdx;
            const res = ER.applyOnEnter(next, cIdx, fIdx, resolution);
            if (!res.ok)
                return { ok: false, state, events: res.events || [], error: res.error || "ON_ENTER_FAILED" };
            if (res.suspended)
                suspended = res.suspended;
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
        case T.REACTIVE_EXHAUSTION_ANSWER: {
            const ER = getEffects();
            if (!ER?.applyReactiveUse)
                return { ok: false, state, events: [], error: "NO_REACTIVE" };
            const res = ER.applyReactiveUse(next, pid, "exaustao", !!a.use);
            if (!res.ok)
                return { ok: false, state, events: [], error: res.error || "REACTIVE_FAILED" };
            events.push(...(res.events || []));
            break;
        }
        case T.REACTIVE_COUNTER_ANSWER: {
            const ER = getEffects();
            if (!ER?.applyReactiveUse)
                return { ok: false, state, events: [], error: "NO_REACTIVE" };
            const res = ER.applyReactiveUse(next, pid, "contramagica", !!a.use);
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
            const res = ER.applyTalentTarget(next, pid, a.targetPlayerId ?? a.targetP, a.targetFieldIdx ?? a.targetI, {
                enemyP: a.enemyP ?? a.enemyPlayerId,
                enemyI: a.enemyI ?? a.enemyFieldIdx,
                // C-A06/C-A08: PROTEÇÃO DIVINA (SIM) cancela a redução do
                // talento (BOLA/EXPLOSÃO da IA) — o talento resolve sem
                // o dano, mas é consumido (t_905).
                skipPower: a.skipPower === true,
            });
            if (!res.ok)
                return { ok: false, state, events: res.events || [], error: res.error || "TALENT_TARGET_FAILED" };
            if (res.state)
                Object.assign(next, res.state);
            if (res.suspended)
                suspended = res.suspended;
            events.push(...(res.events || []));
            break;
        }
        case T.TALENT_AUTO: {
            const ER = getEffects();
            if (typeof ER?.applyTalentAuto !== "function") {
                return { ok: false, state, events: [], error: "NO_TALENT_AUTO" };
            }
            const res = ER.applyTalentAuto(next, pid, ctx?.rng);
            if (!res.ok)
                return { ok: false, state, events: res.events || [], error: res.error || "TALENT_AUTO_FAILED" };
            if (res.state)
                Object.assign(next, res.state);
            if (res.suspended)
                suspended = res.suspended;
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
                    // Manual §9: mão cheia (8) → a carta NÃO volta, sai do jogo
                    // (nem mão, nem descarte).
                    const maxHand = R.LIMITS?.MAX_HAND ?? 8;
                    const exiled = hand.length >= maxHand;
                    if (!exiled)
                        hand.push(handCard);
                    owner.hand = hand;
                    events.push({
                        type: "SCARE_RETURN",
                        targetP: tp,
                        targetI: ti,
                        cardName: handCard.name,
                        exiled,
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
                    // C-A17: o central já resolve o Poder; o bloqueio precisa
                    // do branch de evento (sem POWER_REDUCED, sem destroyIfZero).
                    const commitRes = (typeof R.reduceChampionPower === "function")
                        ? R.reduceChampionPower(card, amount, { ownerP: tp, currentP: next.currentPlayer, preserveWallBuff: next.currentPlayer === tp })
                        : null;
                    if (commitRes?.blockedByBarrier) {
                        events.push({ type: "BARRIER_BLOCKED", targetP: tp, targetI: ti, visual: "barrier_block" });
                        continue;
                    }
                    if (!commitRes) {
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
                                uid: card.uid,
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
                            uid: card.uid,
                            reason: m.reason || "field_commit",
                            ...burst,
                        });
                    }
                }
                else if (op === "setStatus") {
                    const STATUS_BOOL = [
                        "frozen", "tapped", "freeAttack", "shielded", "shieldedPermanent",
                        "barrier", "barrierPermanent", "vulnerable", "silenced", "poisoned",
                        "fury", "inspiracao", "mimico", "wallBuff",
                        "tecnicasSobrepujar", "foreverGrowth", "burning",
                        "corruptedNoHonor", "furyBonusActive", "podridao", "silencedInHand",
                        "prisaoPrismatica", "desafianteAtivo", "separado", "muralhaNativa",
                        "charme",
                    ];
                    const STATUS_NUM = [
                        "frozenTurns", "shieldedTurns", "barrierTurns", "poisonTurns",
                        "furyTurns", "furyStacks", "tecnicasSobrepujarTurns",
                        "burningTurns", "currentPower", "poisonedByP", "burningByP",
                        "charmeTurns", "charmeOriginalOwner",
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
                    card.wallBuff = false;
                    card.wallBuffApplied = false;
                    card.wallBuffSnapshot = 0;
                    card.foreverGrowth = false;
                    card.barrier = false;
                    card.barrierTurns = 0;
                    card.barrierPermanent = false;
                    card.burning = false;
                    card.burningTurns = 0;
                    card.burningByP = undefined;
                    card.fury = false;
                    card.furyTurns = 0;
                    card.furyStacks = 0;
                    card.furyBonusActive = false;
                    // S2-B12: a criatura "renasce" sem os status — o
                    // SOBREPUJAR das TÉCNICAS ficava no morfo.
                    card.tecnicasSobrepujar = false;
                    card.tecnicasSobrepujarTurns = 0;
                    card.vulnerable = false;
                    card.corruptedNoHonor = false;
                    card.prisaoPrismatica = false;
                    card.desafianteAtivo = false;
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
            // C-M09: restaura o campeão ORIGINAL (o morfo volta como ele
            // mesmo, não como bichinho/urso); sem definição, sanitiza no
            // lugar. Usa o `raw` do descarte do servidor, não o cardObj
            // enviado pelo cliente.
            const ER = getEffects();
            const handCard = (typeof ER?.restoreChampionFromDef === "function"
                ? ER.restoreChampionFromDef(raw) : null) || { ...raw };
            // A carta volta como compra fresca: `onEnterConsumed` marca "já entrou em
            // campo" e bloquearia a Habilidade Instantânea na nova invocação.
            handCard.onEnterConsumed = false;
            handCard.hasUsedOnEnter = false;
            handCard._necromanciaFresh = true;
            delete handCard._summoning;
            const hand = owner.hand || [];
            hand.push(handCard);
            owner.hand = hand;
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
                // E-N7 (rodada 3): o cliente precisa do voo de retorno —
                // uid + nome + índice final na mão + toHand. `card` mantido
                // por compatibilidade (o cliente já o lê).
                uid: handCard.uid,
                cardName: handCard.name,
                handIdx: hand.length - 1,
                toHand: true,
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
            // U-B01 (rodada 3): PROTEÇÃO DIVINA (SIM) cancela a redução da
            // habilidade (BOLA/ASSASSINAR/TRANSFORMAR/INCENDIAR da IA) —
            // espelho do TALENT_TARGET (df-engine.js:926): a habilidade
            // resolve sem o efeito, mas é consumida.
            if (a.skipPower === true)
                resolution.skipPower = true;
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
            // Imitar → chain auto (Roubar / Pesadelo / Desacelerar) no mesmo ACK.
            const imitarEv = (res.events || []).find((e) => e && e.type === "IMITAR" && e.copiedOnEnter);
            if (imitarEv?.copiedOnEnter && imitarEv.copiedOnEnter !== "imitar") {
                const plan = ER.planOnEnter?.(next, cIdx, fIdx);
                if (plan?.ok && (plan.mode === "auto" || plan.mode === "none" || plan.mode === "visual_only"
                    || (plan.mode === "target" && ["roubar", "pesadelo", "desacelerar"].includes(String(imitarEv.copiedOnEnter))))) {
                    const chainRes = ER.applyOnEnter(next, cIdx, fIdx, autoOnEnterResolution(next, cIdx, fIdx, {
                        ok: true,
                        mode: "auto",
                        ability: imitarEv.copiedOnEnter,
                    }, ctx.rng || Math.random));
                    if (chainRes?.ok) {
                        events.push(...(chainRes.events || []));
                    }
                }
            }
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
                T.REACTIVE_EXHAUSTION_QUERY,
                T.REACTIVE_COUNTER_QUERY,
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
    try {
        R.recalcDesafiante?.(next);
        // C-A02: INSPIRAR — recalc do +1 aos vizinhos (mesmo ponto do Desafiante).
        R.recalcInspirar?.(next);
    }
    catch (eDes) { /* */ }
    // C-A07: devolver o `suspended` do resolver interno (RAIO/CHUVA).
    return suspended
        ? { ok: true, state: next, events, suspended }
        : { ok: true, state: next, events };
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
    // C-M17 (offline: o alvo automático segue a regra da habilidade —
    // nunca o 1º da lista): aliados = o mais FRACO para devorar/
    // corromper/fortalecer/ursificação (nunca apodrecida), o mais FORTE
    // nos demais; inimigos = o mais FORTE, exceto BOLA DE FOGO (o mais
    // fraco com Poder ≥ 1, nunca apodrecida). Enfeitiçados próprios
    // nunca entram no pool inimigo. O pool de cada habilidade é o mesmo
    // do validador C-M16 (só alvos válidos).
    const powerOf = (c) => c?.currentPower ?? c?.power ?? 0;
    const isApodrecida = (c) => !!(c?.podridao || c?.name === "APODRECIDA"
        || c?.talentEffect === "apodrecidaDescarte");
    const isOwnCharmed = (c) => !!(c?.charme && c?.charmeOriginalOwner === casterIdx);
    const weakestAllyKeys = new Set(["devorar", "corromper", "fortalecer", "ursificacao"]);
    // Troca Injusta: só Campeão adversário de Poder 2 (manual). Nunca o 1º inimigo.
    if (ability === "trocaInjusta") {
        const pool = [];
        const count = state.playersCount ?? state.players.length;
        for (let ep = 0; ep < count; ep++) {
            if (ep === casterIdx)
                continue;
            const field = (state.players[ep]?.field || []);
            field.forEach((c, i) => {
                if (c && Number(c.currentPower ?? c.power) === 2 && !isOwnCharmed(c))
                    pool.push({ p: ep, i });
            });
        }
        if (pool.length) {
            const pick = pool[Math.floor(rng() * pool.length)];
            resolution.targetP = pick.p;
            resolution.targetI = pick.i;
            resolution.enemyP = pick.p;
            resolution.enemyI = pick.i;
        }
        return resolution;
    }
    if (plan.targetKind === "enemy" || mode === "auto") {
        const validFor = (c) => {
            if (!c || isOwnCharmed(c))
                return false;
            const p = powerOf(c);
            const barrier = !!(c.barrier || c.barrierPermanent);
            switch (ability) {
                case "assassinar":
                    return p === 1 && !barrier;
                case "separar":
                    return p === 2 && !c.inspiracao && !c.wallBuff && !((c.furyStacks ?? 0) > 0);
                case "transformarBichinho":
                    return p >= 2 && !barrier;
                case "bolaDeFogo":
                case "rajadaCongelante":
                case "mordidaVenenosa":
                case "incendiar":
                    return !barrier;
                default:
                    return true;
            }
        };
        const pool = R.gatherEnemyTargets(state, casterIdx)
            .filter(({ p, i }) => validFor(state.players[p]?.field?.[i]));
        if (!pool.length)
            return resolution;
        let pick = null;
        if (ability === "bolaDeFogo") {
            const dmg = pool.filter(({ p, i }) => {
                const c = state.players[p].field[i];
                return powerOf(c) >= 1 && !isApodrecida(c);
            });
            if (dmg.length)
                pick = dmg.reduce((a, b) => (powerOf(state.players[b.p].field[b.i]) < powerOf(state.players[a.p].field[a.i]) ? b : a));
        }
        if (!pick)
            pick = pool.reduce((a, b) => (powerOf(state.players[b.p].field[b.i]) > powerOf(state.players[a.p].field[a.i]) ? b : a));
        resolution.targetP = pick.p;
        resolution.targetI = pick.i;
    }
    if (plan.targetKind === "ally") {
        let pool = R.gatherAllyTargets(state, casterIdx, fieldIdx)
            .filter(({ p, i }) => {
                const c = state.players[p]?.field?.[i];
                return c && !isApodrecida(c);
            });
        if (ability === "imitar") {
            const imitable = new Set(R.gatherImitableAllies(state, casterIdx, fieldIdx)
                .map(({ i }) => i));
            pool = pool.filter(({ i }) => imitable.has(i));
        }
        if (ability === "ursificacao") {
            pool = pool.filter(({ p, i }) => {
                const c = state.players[p]?.field?.[i];
                return c && c.name !== "URSO PESADO" && !c.urso_pesado;
            });
        }
        if (pool.length) {
            const pick = weakestAllyKeys.has(ability || "")
                ? pool.reduce((a, b) => (powerOf(state.players[b.p].field[b.i]) < powerOf(state.players[a.p].field[a.i]) ? b : a))
                : pool.reduce((a, b) => (powerOf(state.players[b.p].field[b.i]) > powerOf(state.players[a.p].field[a.i]) ? b : a));
            resolution.targetP = pick.p;
            resolution.targetI = pick.i;
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
    // C-A07: suspensão de um onEnter auto (ex.: RAIO) — o estado é
    // intermediário; o loop para e o `suspended` volta no retorno.
    // O pending do onEnter suspenso some (a resolução agora é
    // server-driven); os demais pendings continuam no ar.
    let suspended = result.suspended || null;
    let guard = 0;
    while (guard++ < 16 && !suspended) {
        const pending = result.events.filter((e) => e.type === "ON_ENTER_PENDING");
        if (!pending.length || !ER?.planOnEnter)
            break;
        let st = result.state;
        const extra = [];
        let resolvedAny = false;
        const resolvedKeys = new Set();
        let suspendedKey = null;
        for (const pe of pending) {
            const cIdx = (pe.playerId ?? pe.casterIdx);
            const fIdx = pe.fieldIdx;
            const plan = ER.planOnEnter(st, cIdx, fIdx);
            // t_670: NECROMANCIA com o descarte VAZIO não tem o que
            // escolher — resolve sozinha (no-op), sem pending e sem
            // menu. Com cartas no descarte, o humano escolhe (pending).
            // "blocked" (ex.: NECROMANCIA com descarte vazio,
            // FORTALECER sem aliado): o onEnter NÃO pode disparar —
            // o pending some (o campeão fica no campo, o onEnter vira
            // no-op), nunca fica pendurado. O resolve nem é chamado
            // (a validação canResolveOnEnter o rejeitaria).
            const necroEmpty = plan?.mode === "necromancia_pick"
                && ((st.players[cIdx]?.discard || []).length === 0);
            if (plan?.mode === "blocked") {
                resolvedAny = true;
                resolvedKeys.add(`${cIdx}:${fIdx}`);
                continue;
            }
            // A-NEW-1a (rodada 5): mode "none" = nada a fazer (sem onEnter,
            // já consumido, ou SILENCIADO) — o pending some sem chamar
            // ON_ENTER_RESOLVE, que o validate recusaria com SILENCED e
            // deixaria o pending pendurado (a mira abria e a EXAUSTÃO era
            // perguntada para uma habilidade morta). Espelha o offline
            // (game_state.gd:920 pula _resolve_on_enter quando silenciado).
            if (plan?.mode === "none") {
                resolvedAny = true;
                resolvedKeys.add(`${cIdx}:${fIdx}`);
                continue;
            }
            // target / necromancia: cliente humano escolhe — não auto-resolver no SUMMON.
            if (!plan?.ok || plan.mode === "target"
                || (plan.mode === "necromancia_pick" && !necroEmpty))
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
            if (follow.suspended) {
                suspended = follow.suspended;
                suspendedKey = `${cIdx}:${fIdx}`;
                break;
            }
            resolvedKeys.add(`${cIdx}:${fIdx}`);
        }
        if (!resolvedAny)
            break;
        const peKey = (e) => `${e.playerId ?? e.casterIdx}:${e.fieldIdx}`;
        result = {
            ok: true,
            state: st,
            events: [...result.events.filter((e) => {
                if (e.type !== "ON_ENTER_PENDING")
                    return true;
                // Sem suspensão: comportamento original (remove todos os
                // resolvidos). Com suspensão: remove só os resolvidos e o
                // suspenso; os demais pendings continuam no ar.
                if (suspendedKey)
                    return !resolvedKeys.has(peKey(e)) && peKey(e) !== suspendedKey;
                return false;
            }), ...extra],
        };
    }
    return suspended ? { ...result, suspended } : result;
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
