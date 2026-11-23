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
function isApodrecidaCard(c) {
    return !!(c && (c.name === "APODRECIDA" || c.talentEffect === "apodrecidaDescarte"));
}
function makeApodrecidaInstance() {
    const def = (D()?.cardDefs || []).find((c) => c.name === "APODRECIDA");
    const base = def
        ? { ...def }
        : {
            name: "APODRECIDA",
            power: 0,
            category: "talent",
            abilityType: "talent",
            abilityName: "Apodrecida",
            abilityDesc: "Carta Apodrecida. Descarte-a!",
            talentEffect: "apodrecidaDescarte",
            hidden: true,
            composedFace: true,
        };
    return {
        ...base,
        // C-M26: a instância EM JOGO é "especial" (como no offline,
        // card_db.gd:89) e carrega o flag podridao — é ele que o SUMMON,
        // os custos e os filtros leem. O template continua "talent".
        category: "especial",
        podridao: true,
        uid: `apd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        currentPower: 0,
        power: 0,
    };
}
/**
 * Contador único na vítima (podridaoHits). Máx. 4 aplicações (campeão ou talento).
 * Transforma até 2 cartas do baralho em APODRECIDA (offline _do_podridao /
 * _aplicar_podridao, 1.51.15: 2 cartas por aplicação, até 4 pilhas = 8 cartas).
 */
function applyPodridaoToEnemyDeck(state, enemyIdx, rng = Math.random) {
    const enemy = state.players?.[enemyIdx];
    if (!enemy) {
        return { count: 0, fizzled: true, reason: "no_enemy", names: [], podridaoHits: 0 };
    }
    const hits = enemy.podridaoHits | 0;
    if (hits >= 4) {
        return {
            count: 0,
            fizzled: true,
            reason: "podridao_cap",
            names: [],
            podridaoHits: hits,
        };
    }
    const deck = enemy.deck || [];
    enemy.deck = deck;
    // C-A10: com o baralho vazio, NADA acontece e a pilha NÃO é consumida
    // (offline _do_podridao retorna antes de _aplicar_podridao).
    if (!deck.length) {
        return {
            count: 0,
            fizzled: true,
            reason: "no_eligible",
            names: [],
            podridaoHits: hits,
        };
    }
    const eligibleIdx = [];
    deck.forEach((c, di) => {
        if (c && !isApodrecidaCard(c))
            eligibleIdx.push(di);
    });
    enemy.podridaoHits = hits + 1;
    if (!eligibleIdx.length) {
        return {
            count: 0,
            fizzled: true,
            reason: "no_eligible",
            names: [],
            podridaoHits: enemy.podridaoHits,
        };
    }
    for (let k = eligibleIdx.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [eligibleIdx[k], eligibleIdx[j]] = [eligibleIdx[j], eligibleIdx[k]];
    }
    const pickCount = Math.min(2, eligibleIdx.length);
    const names = [];
    for (const di of eligibleIdx.slice(0, pickCount)) {
        const prev = deck[di];
        names.push(prev?.name || "?");
        deck[di] = makeApodrecidaInstance();
    }
    return {
        count: names.length,
        fizzled: names.length === 0,
        reason: names.length ? null : "no_eligible",
        names,
        podridaoHits: enemy.podridaoHits,
    };
}
function swapFieldChamps(state, casterIdx, casterFieldIdx, enemyP, enemyI) {
    const a = state.players[casterIdx].field[casterFieldIdx];
    const e = state.players[enemyP].field[enemyI];
    if (!a || !e)
        return false;
    // C-M06 (offline _troca_de_lugar): as constantes/status VIAJAM com a
    // carta (nada de limpar shielded); ambos entram CANSADOS
    // (tapped) e marcados como trocados (trocaBorn — a instantânea não
    // re-dispara, como no offline).
    for (const ch of [a, e]) {
        ch.tapped = true;
        ch.trocaBorn = true;
    }
    // Troca não é nova entrada — ambos já tiveram (ou terão) onEnter na 1ª invocação.
    markChampOnEnterConsumed(a);
    markChampOnEnterConsumed(e);
    const aSlot = a.slot;
    a.slot = e.slot;
    e.slot = aSlot;
    state.players[casterIdx].field[casterFieldIdx] = e;
    state.players[enemyP].field[enemyI] = a;
    return true;
}
function reduceChampionPower(champ, amt, opts) {
    const rules = R();
    if (rules?.reduceChampionPower)
        return rules.reduceChampionPower(champ, amt, opts);
    if (!champ)
        return { dissolvedWall: false, blockedByBarrier: false };
    // C-A17 (fallback defensivo, sem o motor ligado): Barreira e apodrecida
    // bloqueiam como no reduceChampionPower central (df-rules.js).
    if (champ.podridao || champ.name === "APODRECIDA" || champ.talentEffect === "apodrecidaDescarte")
        return { dissolvedWall: false, blockedByBarrier: false };
    if (champ.barrier || champ.barrierPermanent || (champ.barrierTurns ?? 0) !== 0)
        return { dissolvedWall: false, blockedByBarrier: true };
    champ.currentPower = Math.max(0, (champ.currentPower ?? 0) - amt);
    return { dissolvedWall: false, blockedByBarrier: false };
}
function destroyAtField(state, p, i, events, reason, killerP = -1) {
    const champ = state.players[p]?.field?.[i];
    if (!champ)
        return;
    state.players[p].field.splice(i, 1);
    state.players[p].discard = state.players[p].discard || [];
    state.players[p].discard.push(champ);
    events.push({ type: "DESTROY", p, i, reason, name: champ.name, uid: champ.uid });
    // C-A03 (manual §5.4; offline destroy_champion grant_vp=true): destruir
    // um campeão INIMIGO dá +1 PV a quem destruiu (salvo SEM HONRA).
    // Aliado destruído pelo próprio efeito não dá PV (by_pi == owner_pi).
    // Quem já pagava à mão (ASSASSINAR, RAJADA, ROLETA) passa a usar este
    // caminho central — sem killerP, nada muda (DEVORAR, TRANSFORMAR).
    // S2-M11: RAIO DUPLO nunca dá PV (offline resolve_raio, grant_vp=false) —
    // exclusão CENTRAL por motivo, independente do killerP passado pelo
    // chamador (o call site já não passa killerP; a centralização garante).
    if (reason !== "raioDuplo" && killerP != null && killerP >= 0 && killerP !== p && !R()?.hasNoHonor?.(champ)) {
        state.players[killerP].vp = (state.players[killerP].vp ?? 0) + 1;
        events.push({ type: "VP_GAIN", playerId: killerP, amount: 1, reason });
    }
    const burst = R()?.applyOnDestroyBurst?.(state, p, champ, reason);
    if (burst?.ability) {
        events.push({
            type: "ON_DESTROY_BURST",
            ownerIdx: p,
            source: champ.name,
            // R-05: o uid da fonte (o vingador destruído) — o cliente
            // busca a animação por uid primeiro (online_presentation.gd);
            // sem ele, imitador não anima e FURIOSA viva + GRIZZLY morto
            // anima a carta errada. `source` é mantido como era.
            uid: champ.uid,
            reason,
            ...burst,
        });
    }
}
function findCardDef(name) {
    return D()?.cardDefs?.find((c) => c.name === name) || null;
}
/**
 * A-N2/A-N3 (offline _aplicar_morfose / _aplicar_urso, game_state.gd):
 * o morfo NÃO zera tudo. Transformar limpa só o conjunto da _aplicar_morfose
 * (silenciado, frozen/poison/burn, vulnerável, wall_buff, desafiante_buff,
 * fury, inspirar_buff); Ursificação limpa SÓ o silenciado. Nos DOIS modos
 * a constante some (offline zera `constant`) — por isso a Muralha nativa
 * nunca regenera (muralhaNativa=false) e os campos de IMITAR morrem com
 * o original (o imitador morfado não nega PV nem vinga mais). Os buffs
 * delta (inspirarBuff/desafianteAtivo/wallBuff) são zerados nos dois modos
 * porque o Poder é sobrescrito pelo token — se ficassem, o recalc do fim
 * da ação subtrairia o buff velho do Poder novo; o recalc re-adiciona o
 * que ainda vale (ex.: INSPIRAR de fonte adjacente). BARREIRA, Proteção,
 * PRISÃO, Charme, freeAttack, Crescimento, Sobrepujar e Corrompido
 * SOBREVIVEM ao morfo nos dois modos (o offline não os toca).
 */
function clearMorphStatuses(c, mode) {
    if (!c)
        return;
    // Comum aos dois modos (a constante some — ver acima).
    c.muralhaNativa = false;
    c.mimico = false;
    c.mimicAbilityName = null;
    c.mimicAbilityDesc = null;
    c.mimicSourceName = null;
    c.mimicName = null;
    c.mimicOnDestroy = null;
    c.mimicOnEnter = null;
    c.mimicConstantEffect = null;
    c.mimicChainPending = false;
    c.silenced = false;
    // U-A01 (rodada 3): no modo "urso" o Poder novo DERIVA do Poder atual
    // (replacedPower + 2 — os buffs já estão dentro dele). Subtrair os
    // buffs ANTES de zerar, senão o recalc re-adiciona o INSPIRAR e o
    // Poder conta 2× (P5 vs P4 do offline, que subtrai TODOS os buffs
    // em _recalc_constants antes de re-adicionar só os válidos).
    // Morfose NÃO subtrai: o Poder é sobrescrito (floor(P/2)/P+1) e o
    // offline também zera sem subtrair (comportamento certo, provado).
    if (mode === "urso") {
        const insp = c.inspirarBuff ?? 0;
        const wall = (c.wallBuff && c.wallBuffApplied) ? 1 : 0;
        const desaf = c.desafianteAtivo ? 2 : 0;
        if (insp || wall || desaf) {
            c.currentPower = Math.max(0, (c.currentPower ?? 0) - insp - wall - desaf);
        }
    }
    c.wallBuff = false;
    c.wallBuffApplied = false;
    c.wallBuffSnapshot = 0;
    c.inspirarBuff = 0;
    c.desafianteAtivo = false;
    if (mode === "urso")
        return;
    // Só Transformar (morfose) limpa o resto.
    c.frozen = false;
    c.frozenTurns = 0;
    c.poisoned = false;
    c.poisonTurns = 0;
    c.poisonedByP = -1;
    c.burning = false;
    c.burningTurns = 0;
    c.burningByP = undefined;
    c.vulnerable = false;
    c.fury = false;
    c.furyTurns = 0;
    c.furyStacks = 0;
    c.furyBonusActive = false;
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
function applyTokenTransform(target, tokenDef, newPower, mode = "morfose") {
    // C-M09 (offline _aplicar_morfose): guardar o nome PRÉ-morfo para a
    // Necromancia restaurar a carta original (sem isso, o bichinho/urso
    // voltaria como bichinho/urso).
    if (target.origName == null)
        target.origName = target.name;
    target.name = tokenDef.name;
    target.power = newPower;
    // C-A11 (offline _aplicar_morfose): a base É o novo Poder (era 0 — a
    // forma morfada voltava à mão como P0).
    target.basePower = newPower;
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
    // A-N2/A-N3: limpeza cirúrgica por modo (ver clearMorphStatuses).
    clearMorphStatuses(target, mode);
    // C-B21 (offline _apply_urso, game_state.gd:3281): a mecânica do URSO
    // PESADO vive no FLAG, não na habilidade — o flag sobrevive ao silêncio.
    // (Depois do clearMorphStatuses, que zeraria o flag.)
    target.urso_pesado = tokenDef.name === "URSO PESADO";
}
// C-M09 (offline _ressuscitar_selecao): reinstancia o campeão a partir da
// definição ORIGINAL (origName, guardado no morfo) — o bichinho/urso volta
// como o campeão original, com o uid preservado. Sem definição (token ou
// carta desconhecida), limpa os status no lugar e apaga as marcas de morfo.
function restoreChampionFromDef(card) {
    if (!card)
        return null;
    const def = findCardDef(card.origName ?? card.name)
        || D()?.dragonTokenDef?.(String(card.origName ?? card.name));
    if (!def || def.category === "talent" || def.category === "reaction") {
        card.frozen = false;
        card.frozenTurns = 0;
        card.tapped = false;
        card.shielded = false;
        card.shieldedTurns = 0;
        card.shieldedPermanent = false;
        card.freeAttack = false;
        card.silenced = false;
        card.poisoned = false;
        card.poisonTurns = 0;
        card.poisonedByP = -1;
        card.fury = false;
        card.furyStacks = 0;
        card.furyTurns = 0;
        card.barrier = false;
        card.barrierTurns = 0;
        card.barrierPermanent = false;
        card.burning = false;
        card.burningTurns = 0;
        card.vulnerable = false;
        card.corruptedNoHonor = false;
        card.urso_pesado = false;
        card.inspiracao = false;
        card.charme = false;
        card.charmeTurns = 0;
        card.prisaoPrismatica = false;
        card.wallBuff = false;
        card.tecnicasSobrepujar = false;
        card.tecnicasSobrepujarTurns = 0;
        card.crescimento = false;
        card.foreverGrowth = false;
        card.mimico = false;
        card.mimicSourceName = null;
        card.mimicAbilityName = null;
        card.mimicAbilityDesc = null;
        card.mimicOnDestroy = null;
        card.mimicOnEnter = null;
        card.mimicConstantEffect = null;
        card.mimicChainPending = false;
        card.origName = null;
        card.onEnterConsumed = false;
        card.hasUsedOnEnter = false;
        return card;
    }
    return {
        ...def,
        uid: card.uid,
        currentPower: def.power,
        basePower: def.power,
        tapped: false,
        isToken: false,
        frozen: false, frozenTurns: 0, freeAttack: false,
        shielded: false, shieldedTurns: 0, shieldedPermanent: false,
        barrier: false, barrierTurns: 0, barrierPermanent: false,
        poisoned: false, poisonTurns: 0, poisonedByP: -1,
        burning: false, burningTurns: 0,
        silenced: false,
        onEnterConsumed: false,
        origName: null,
    };
}
/** @returns {{ ok: boolean, mode: string, targetKind?: string, ability?: string, events?: object[], code?: string }} */
function planOnEnterImpl(state, casterIdx, fieldIdx) {
    const caster = state.players[casterIdx]?.field?.[fieldIdx];
    if (!caster?.onEnter)
        return { ok: true, mode: "none" };
    // A-NEW-1a (rodada 5): campeão silenciado não dispara a instantânea —
    // espelha df-effects.js:74 e o offline (game_state.gd:920 pula
    // _resolve_on_enter quando silenciado). Defesa em profundidade para
    // chamadores diretos; o loop do motor também trata mode "none".
    if (caster.silenced)
        return { ok: true, mode: "none" };
    // Instantânea só na 1ª entrada em qualquer campo (Troca Injusta não reativa).
    // Exceção one-shot: mimicChainPending após IMITAR (habilidade copiada ainda não resolveu).
    if (caster.onEnterConsumed && !caster.mimicChainPending)
        return { ok: true, mode: "none" };
    const key = caster.onEnter;
    const ctx = R()?.summonContextForPlayer(state, casterIdx) || {};
    const leg = getEffectsApi()?.canOnEnter?.(state, casterIdx, caster, ctx);
    if (leg && !leg.ok)
        return { ok: false, code: leg.code, mode: "blocked" };
    const instantAuto = new Set([
        "fumacaToxica", "raioDuplo", "pesadelo", "roubar", "desacelerar",
        "defensor", "gritoDeGuerra", "forja", "tecnicasDeCombate", "roletaRussa", "podridao",
        "enfraquecer", "energizar",
    ]);
    const targetEnemy = new Set([
        "bolaDeFogo", "assassinar", "transformarBichinho", "rajadaCongelante",
        "mordidaVenenosa", "incendiar", "separar", "prisaoPrismatica", "charme",
        "trocaInjusta",
    ]);
    const targetAlly = new Set(["fortalecer", "devorar", "imitar", "ursificacao", "corromper"]);
    /* pesadelo/roubar/desacelerar migraram pra instantAuto — set vazio
       evita ReferenceError se algum onEnter novo usar targetKind player. */
    const targetPlayer = new Set([]);
    if (instantAuto.has(key))
        return { ok: true, mode: "auto", ability: key };
    if (key === "invokeDragon") {
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
 * @param {object} resolution — { targetP, targetI, targetPlayerIdx, necromanciaCard, rng }
 */
function applyOnEnterImpl(state, casterIdx, fieldIdx, resolution = {}) {
    const events = [];
    const caster = state.players[casterIdx]?.field?.[fieldIdx];
    if (!caster?.onEnter)
        return { ok: true, state, events };
    if (caster.onEnterConsumed && !caster.mimicChainPending)
        return { ok: true, state, events };
    if (caster.mimicChainPending)
        caster.mimicChainPending = false;
    if (caster.silenced)
        return { ok: true, state, events };
    // C-M16: validador central — um alvo forjado (barreira, apodrecida,
    // enfeitiçado próprio, lado errado) é recusado aqui, antes da
    // resolução tocar no estado.
    if (resolution.targetI != null) {
        const v = R()?.validateAbilityTarget?.(state, casterIdx, fieldIdx, resolution.targetP, resolution.targetI);
        if (v && !v.ok)
            return { ok: false, state, events, error: v.code || "INVALID_TARGET" };
    }
    const enteringChamp = caster;
    const key = caster.onEnter;
    const rng = resolution.rng || Math.random;
    switch (key) {
        case "rapidez": {
            state.players[casterIdx].actions = (state.players[casterIdx].actions ?? 0) + 1;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "RAPIDEZ", casterIdx, fieldIdx, visual: "wings" });
            break;
        }
        case "forja": {
            const owner = state.players[casterIdx];
            if (!owner)
                break;
            markOnEnterUsed(state, casterIdx, key);
            const deck = owner.deck;
            if (!deck?.length) {
                events.push({
                    type: "FORJA", casterIdx, fieldIdx,
                    fizzled: true, reason: "deck_empty",
                });
                break;
            }
            // SEM-QUEIMA (2026-11-15 — REVOGA C-M13): com a mão cheia
            // o saque não acontece (drawCardWithBurn retorna null) —
            // fizzle com reason "hand_full"; sem deck, "deck_empty".
            const res = R()?.drawCardWithBurn?.(state, casterIdx);
            if (!res) {
                events.push({
                    type: "FORJA", casterIdx, fieldIdx,
                    fizzled: true,
                    reason: (state.players[casterIdx]?.deck?.length ? "hand_full" : "deck_empty"),
                });
                break;
            }
            events.push({
                type: "FORJA",
                casterIdx,
                fieldIdx,
                playerId: casterIdx,
                card: res.burned ? null : res.card,
                cardName: res.card?.name,
                burned: res.burned,
                fizzled: res.burned,
                drawn: true,
                visual: "card_draw",
            });
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
            if (t == null || t === casterIdx)
                break;
            // A-N9 (offline): o onEnter é consumido mesmo quando redundante
            // (o alvo já tem o flag) — sem isso, REUTILIZAÇÃO/IMITAR
            // re-disparariam o PESADELO/DESACELERAR no mesmo turno.
            markOnEnterUsed(state, casterIdx, key);
            if (state.players[t]?.skipDraw)
                break;
            state.players[t].skipDraw = true;
            events.push({ type: "PESADELO", casterIdx, fieldIdx, targetIdx: t, visual: "pesadelo" });
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
            if (t == null || t === casterIdx)
                break;
            // A-N9 (offline): idem PESADELO — o onEnter é consumido mesmo
            // quando redundante.
            markOnEnterUsed(state, casterIdx, key);
            if (state.players[t]?.skipNextAction)
                break;
            state.players[t].skipNextAction = true;
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
            // C-B10 (offline gs:4305): o roubo é ALEATÓRIO — o cliente
            // nunca escolhe o índice (ação forjada com stolenHandIdx
            // era aceita). Sorteio sempre, como o offline.
            const idx = Math.floor(rng() * targetP.hand.length);
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
                    cardName: stolen.name,
                    power: stolen.power ?? cardPow,
                    currentPower: cardPow,
                },
                visual: "roubar",
            });
            break;
        }
        case "bolhas": {
            // C-A15 (offline _apply_bolhas): Oceana / TUBARÃO BORRIFANTE
            // colocam BOLHAS na mão do adversário (o primeiro campeão
            // invocado entra SILENCIADO e consome o efeito — gancho no
            // SUMMON; os saques futuros também ganham BOLHAS enquanto
            // bolhasActive). A antiga "Maldição dos Sete Mares" era um
            // nome online-only para a mesma habilidade.
            for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
                if (p === casterIdx)
                    continue;
                const opp = state.players[p];
                opp.bolhasActive = true;
                (opp.hand || []).forEach((card) => {
                    if (card?.category === "champion")
                        card.bolhas = true;
                });
            }
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "BOLHAS", casterIdx, visual: "bolhas" });
            break;
        }
        case "trocaInjusta": {
            const ep = resolution.enemyP ?? resolution.targetP;
            const ei = resolution.enemyI ?? resolution.targetI;
            if (ep == null || ei == null)
                break;
            const enemy = state.players[ep]?.field?.[ei];
            if (!enemy || Number(enemy.currentPower ?? enemy.power) !== 2)
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
            // S2-M18 (1.51.43 item 2): FORTALECER nunca em si mesmo — sem
            // outro aliado, a habilidade falha. O canOnEnterResolve já exige
            // outro aliado (fcSelf>0), mas a resolução aceitava o próprio
            // índice como alvo (o CORROMPER ao lado já tem essa guarda).
            if (ti == null || ti === fieldIdx)
                break;
            const ally = state.players[casterIdx]?.field?.[ti];
            // C-M11: FORTALECER nunca numa APODRECIDA (não é campeão).
            if (ally && isApodrecidaCard(ally))
                break;
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
            // (1.51.96 item 13a) SILENCIADO não recebe outros status —
            // nem CORROMPER. A validação (validateAbilityTarget) já recusa
            // o alvo antes; isto é defesa em profundidade.
            if (ally.silenced)
                break;
            const abilityName = String(ally.mimicAbilityName || ally.abilityName || "");
            const nativeNoHonor = ally.onDestroy === "noHonor"
                || ally.mimicOnDestroy === "noHonor"
                || abilityName.toLowerCase().normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "").includes("sem honra");
            // Correção-motor 3 (t_928): o nativo Sem Honra NÃO conta quando
            // silenciado — o silêncio suprime a habilidade nativa (hasNoHonor:
            // corruptedNoHonor -> true, silenced -> false, nativo -> true).
            // O offline seta corrupted=true incondicionalmente
            // (resolve_corromper, game_state.gd:4068).
            const alreadyNoHonor = (nativeNoHonor && !ally.silenced) || !!ally.corruptedNoHonor;
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
            // S2-M17: o offline renova incondicionalmente (resolve_mordida:
            // poison_turns = 2, poison_by = applier) — morder um alvo já
            // envenenado REINICIA o contador (e o envenenador passa a ser
            // quem mordeu por último).
            target.poisoned = true;
            target.poisonTurns = 2;
            target.poisonedByP = casterIdx;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "MORDIDA_VENENOSA",
                casterIdx,
                fieldIdx,
                targetP: tp,
                targetI: ti,
                targetName: target.name,
                applied: true,
                renewed: alreadyPoisoned,
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
            // U-B01 (rodada 3): skipPower (PROTEÇÃO DIVINA, SIM) cancela
            // o EM CHAMAS — a habilidade é consumida, o status não adere.
            if (resolution.skipPower === true) {
                markOnEnterUsed(state, casterIdx, key);
                events.push({
                    type: "INCENDIAR",
                    casterIdx,
                    fieldIdx,
                    targetP: tp,
                    targetI: ti,
                    targetName: target.name,
                    applied: false,
                    powerCancelled: true,
                    visual: "em_chamas",
                });
                break;
            }
            // Manual §6: Barreira dá imunidade a Em Chamas. A habilidade é
            // consumida (o alvo foi escolhido), mas o status não adere.
            if (target.barrier || target.barrierPermanent) {
                markOnEnterUsed(state, casterIdx, key);
                events.push({
                    type: "INCENDIAR",
                    casterIdx,
                    fieldIdx,
                    targetP: tp,
                    targetI: ti,
                    targetName: target.name,
                    immune: true,
                    applied: false,
                    visual: "em_chamas",
                });
                break;
            }
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
                applied: true,
                visual: "em_chamas",
            });
            break;
        }
        case "devorar": {
            const ti = resolution.targetI;
            const ally = state.players[casterIdx]?.field?.[ti];
            // C-B18: offline o DEVORAR come QUALQUER aliado (inclusive inspirado).
            if (!ally)
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
            // C-A17: a Barreira bloqueia e PERMANECE (central, reduceChampionPower).
            // U-B01 (rodada 3): skipPower (PROTEÇÃO DIVINA, SIM) cancela a
            // redução — igual ao talento (bolaDeFogoTalento).
            const bolaBefore = t.currentPower ?? 0;
            const bolaRes = resolution.skipPower === true
                ? { blockedByBarrier: false }
                : reduceChampionPower(t, 1, { ownerP: tp, currentP: state.currentPlayer });
            if (bolaRes?.blockedByBarrier) {
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
            events.push({ type: "BOLA_DE_FOGO", casterIdx, targetP: tp, targetI: ti, visual: "bola_de_fogo", powerCancelled: resolution.skipPower === true });
            if (t.currentPower <= 0 && bolaBefore > 0)
                destroyAtField(state, tp, ti, events, "bolaDeFogo", casterIdx);
            break;
        }
        case "assassinar": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const t = state.players[tp]?.field?.[ti];
            // C-M10 (offline game_state.gd:2219): ASSASSINAR nunca mira
            // campeão com BARREIRA. Poder ATUAL já era checado aqui
            // (a faceta do Poder BASE é do cliente, outro agente).
            if (!t || t.currentPower !== 1 || t.barrier || t.barrierPermanent)
                break;
            // U-B01 (rodada 3): skipPower (PROTEÇÃO DIVINA, SIM) cancela
            // o abate — a habilidade é consumida, o alvo sobrevive, sem PV.
            if (resolution.skipPower === true) {
                markOnEnterUsed(state, casterIdx, key);
                events.push({ type: "ASSASSINAR", casterIdx, fieldIdx, targetP: tp, targetI: ti, vpGain: 0, powerCancelled: true, visual: "assassinar" });
                break;
            }
            // (Lote B) o offline dá +1 PV a quem destrói um campeão
            // por habilidade, salvo sem honra (destroy_champion,
            // grant_vp=true) — C-A03 centralizou o pagamento em
            // destroyAtField; aqui só fica o campo vpGain do evento.
            const noHonor = !!R()?.hasNoHonor?.(t);
            destroyAtField(state, tp, ti, events, "assassinar", casterIdx);
            markOnEnterUsed(state, casterIdx, key);
            const vpGain = !noHonor ? 1 : 0;
            events.push({ type: "ASSASSINAR", casterIdx, fieldIdx, targetP: tp, targetI: ti, vpGain, visual: "assassinar" });
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
                destroyAtField(state, tp, ti, events, "rajadaCongelante", casterIdx);
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
                target.frozenTurns = 1;
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
            if (!card) {
                // t_670: descarte vazio — sem carta para voltar; o
                // onEnter resolve como no-op, mas fica marcado como
                // usado (não re-dispara).
                markOnEnterUsed(state, casterIdx, key);
                break;
            }
            // C-M09: o find é SÓ por uid — o nome pode ser de um bichinho
            // (morfo) e removeria a carta errada do descarte.
            const di = discard.findIndex((c) => c.uid === card.uid);
            if (di >= 0)
                discard.splice(di, 1);
            // C-M09: o morfo volta como o campeão ORIGINAL (restore a
            // partir do origName); sem definição, sanitiza no lugar.
            // Volta como compra fresca: sem limpar `onEnterConsumed`, o
            // campeão ressuscitado entraria MUDO na próxima invocação.
            const restored = restoreChampionFromDef(card) || card;
            restored.onEnterConsumed = false;
            restored.hasUsedOnEnter = false;
            state.players[casterIdx].hand.push(restored);
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "NECROMANCIA",
                casterIdx,
                card: restored.name,
                // E-N7 (rodada 3): o cliente precisa do voo de retorno —
                // uid + nome + índice final na mão + toHand. `card` mantido
                // por compatibilidade. Mesmo formato do NECROMANCIA_PICK
                // (df-engine.js).
                uid: restored.uid,
                cardName: restored.name,
                handIdx: state.players[casterIdx].hand.length - 1,
                toHand: true,
                visual: "necromancia",
            });
            break;
        }
        case "imitar": {
            const ti = resolution.targetI;
            const ally = state.players[casterIdx]?.field?.[ti];
            if (!ally || ally.onEnter === "imitar")
                break;
            // C-M08 (defesa em profundidade): Ritual / Ritual Superior
            // nunca são copiados, mesmo que o gather os deixe passar.
            if (ally.summonRitual || ally.abilityName === "Ritual" || ally.abilityName === "Ritual Superior")
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
            // A-N5 (offline _imitar_copy, game_state.gd:2970-2995): copiar
            // INVESTIDA dá o ataque livre ao imitador (se não silenciado).
            if (copiedConstant === "investida" && !caster.silenced)
                caster.freeAttack = true;
            caster.talentEffect = ally.talentEffect || null;
            caster.mimico = true;
            caster.mimicAbilityName = ally.abilityName || "Habilidade";
            caster.mimicAbilityDesc = ally.abilityDesc || "";
            caster.mimicSourceName = ally.name;
            caster.mimicOnDestroy = caster.onDestroy;
            caster.mimicOnEnter = ally.onEnter;
            caster.mimicConstantEffect = copiedConstant;
            // One-shot: permite plan/apply da habilidade copiada após IMITAR.
            if (ally.onEnter && ally.onEnter !== "imitar")
                caster.mimicChainPending = true;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "IMITAR", casterIdx, fieldIdx, allyP: casterIdx, allyI: ti,
                copiedOnEnter: caster.onEnter, copiedConstantEffect: copiedConstant,
                casterUid: caster.uid,
                mimicName: ally.name, abilityName: ally.abilityName,
            });
            // S2-A06: a instantânea copiada resolve via ON_ENTER_PENDING — o
            // loop de cadeia de applyActionWithOnEnter só segue esse evento
            // (sem ele, o imitador virava cópia morta). Auto resolve no mesmo
            // ack; com mira, fica pendente para o cliente escolher o alvo,
            // como no SUMMON. (Complemento do cliente: _apply_ability_ack
            // precisa chamar _check_on_enter_pending — F10.)
            if (ally.onEnter && ally.onEnter !== "imitar")
                events.push({ type: "ON_ENTER_PENDING", playerId: casterIdx, fieldIdx, onEnter: caster.onEnter });
            break;
        }
        case "ursificacao": {
            const ti = resolution.targetI;
            const target = state.players[casterIdx]?.field?.[ti];
            const banjoDef = findCardDef("URSO PESADO");
            if (!target || !banjoDef)
                break;
            // C-M12 (offline _pode_ursificar): nunca em si mesmo.
            if (ti === fieldIdx)
                break;
            // S2-B20 (1.51.11, defesa em profundidade no offline): quem já
            // é URSO PESADO não pode ser ursificado de novo — sem
            // isso, o urso ganhava +2 a cada nova ursificação.
            if (target.name === "URSO PESADO" || target.urso_pesado)
                break;
            const replacedPower = typeof target.currentPower === "number"
                ? target.currentPower
                : (target.basePower || target.power || 0);
            const newPower = replacedPower + 2;
            const origName = target.name;
            applyTokenTransform(target, banjoDef, newPower, "urso");
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
            // U-B01 (rodada 3): skipPower (PROTEÇÃO DIVINA, SIM) cancela
            // o morfo — a habilidade é consumida, o alvo fica como está.
            if (resolution.skipPower === true) {
                markOnEnterUsed(state, casterIdx, key);
                events.push({
                    type: "TRANSFORMAR_BICHINHO", casterIdx, fieldIdx, targetP: tp, targetI: ti,
                    origName: target.name, origPower: target.currentPower,
                    powerCancelled: true, visual: "transformar_bichinho",
                });
                break;
            }
            const success = resolution.success != null ? !!resolution.success : rng() < 0.80;
            const origPower = target.currentPower;
            const origName = target.name;
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
            // C-M04 (offline resolve_furia, game_state.gd:3892): a Fúria
            // da URSA dura 2 rodadas; demais, 1.
            R()?.grantFuryStacks?.(caster, 1, caster.name === "URSA" ? 2 : 1);
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
                // (1.51.96 item 13a) SILENCIADO não recebe FÚRIA
                // (grantFuryStacks também barra; aqui o aliado nem
                // entra na lista `applied`).
                if (ally.silenced)
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
                // (1.51.96 item 13a) SILENCIADO não recebe PROTEÇÃO.
                if (i !== fieldIdx && c && !c.silenced)
                    picks.push(i);
            });
            const names = [];
            for (const idx of picks) {
                const t = state.players[casterIdx].field[idx];
                if (!t)
                    continue;
                // S2-B10: o pilar cai sobre CADA outro aliado, inclusive quem
                // já tem Proteção — e a duração é RENOVADA (offline
                // _add_shield: maxi(atual, 1); permanente (-1) não é tocada).
                if (t.shieldedTurns !== -1) {
                    t.shielded = true;
                    t.shieldedTurns = Math.max(t.shieldedTurns ?? 0, 1);
                }
                names.push(t.name);
            }
            if (!names.length)
                break;
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "GUARDIAO", casterIdx, picks, names, visual: "guardian" });
            break;
        }
        case "tecnicasDeCombate": {
            const applied = [];
            state.players[casterIdx].field.forEach((ally, i) => {
                if (!ally || i === fieldIdx)
                    return;
                // (1.51.96 item 13a) SILENCIADO não recebe SOBREPUJAR.
                if (ally.silenced)
                    return;
                ally.tecnicasSobrepujar = true;
                ally.tecnicasSobrepujarTurns = Math.max(ally.tecnicasSobrepujarTurns ?? 0, 2);
                applied.push({
                    p: casterIdx,
                    i,
                    name: ally.name,
                    uid: ally.uid,
                });
            });
            if (!applied.length)
                break;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "TECNICAS_DE_COMBATE",
                casterIdx,
                fieldIdx,
                applied,
                visual: "tecnicas_combate",
            });
            break;
        }
        case "roletaRussa": {
            const candidates = [];
            const count = state.playersCount ?? state.players?.length ?? 0;
            for (let ep = 0; ep < count; ep++) {
                (state.players[ep]?.field || []).forEach((ch, i) => {
                    if (ch)
                        candidates.push({ p: ep, i, name: ch.name, uid: ch.uid });
                });
            }
            if (!candidates.length)
                break;
            // R-01 (offline _pick_roleta_victim, game_state.gd:3703-3717;
            // 1.51.45 item 4): sorteio PONDERADO — a fonte (a própria
            // ROLETA, em casterIdx/fieldIdx) tem peso 0,5 vs 1,0 dos
            // demais; a vítima continua podendo ser qualquer campeão.
            const sourceUid = state.players[casterIdx]?.field?.[fieldIdx]?.uid;
            const weightOf = (c) => (c.uid === sourceUid ? 0.5 : 1.0);
            let totalWeight = 0;
            for (const c of candidates)
                totalWeight += weightOf(c);
            let r = rng() * totalWeight;
            let pickIndex = candidates.length - 1;
            for (let k = 0; k < candidates.length; k++) {
                r -= weightOf(candidates[k]);
                if (r <= 0) {
                    pickIndex = k;
                    break;
                }
            }
            const pick = candidates[pickIndex];
            const target = state.players[pick.p]?.field?.[pick.i];
            if (!target)
                break;
            const targetName = target.name;
            const targetUid = target.uid;
            const noHonor = !!R()?.hasNoHonor?.(target);
            markOnEnterUsed(state, casterIdx, key);
            destroyAtField(state, pick.p, pick.i, events, "roletaRussa", casterIdx);
            const vpGain = pick.p !== casterIdx && !noHonor ? 1 : 0;
            events.push({
                type: "ROLETA_RUSSA",
                casterIdx,
                fieldIdx,
                pickIndex,
                candidates,
                targetP: pick.p,
                targetI: pick.i,
                targetUid,
                targetName,
                vpGain,
                visual: "roleta_russa",
            });
            break;
        }
        case "podridao": {
            let enemyIdx = -1;
            const pCount = state.playersCount ?? state.players?.length ?? 0;
            for (let ep = 0; ep < pCount; ep++) {
                if (ep !== casterIdx) {
                    enemyIdx = ep;
                    break;
                }
            }
            if (enemyIdx < 0)
                break;
            markOnEnterUsed(state, casterIdx, key);
            const result = applyPodridaoToEnemyDeck(state, enemyIdx, rng);
            events.push({
                type: "PODRIDAO",
                casterIdx,
                fieldIdx,
                enemyIdx,
                count: result.count,
                names: result.names,
                fizzled: !!result.fizzled,
                reason: result.reason,
                podridaoHits: result.podridaoHits,
                visual: "podridao",
            });
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
        case "fumacaToxica": {
            const picks = pickRandomEnemyChamps(state, casterIdx, 2, {
                avoidPower1: !!resolution.avoidPower1,
                rng,
            });
            if (!picks.length)
                break;
            const names = [];
            // Manual §6: Barreira dá imunidade a Vulnerável. O alvo é
            // escolhido normalmente, mas o status não adere e o jogador
            // recebe o aviso de imunidade.
            const immune = [];
            for (const { p, i } of picks) {
                const ch = state.players[p]?.field[i];
                if (!ch)
                    continue;
                if (ch.barrier || ch.barrierPermanent) {
                    immune.push({ p, i, name: ch.name });
                    continue;
                }
                ch.vulnerable = true;
                names.push(ch.name);
            }
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "FUMACA_TOXICA", casterIdx, fieldIdx, picks, names, immune,
                visual: "fumaca_toxica",
            });
            break;
        }
        case "raioDuplo": {
            // C-A17 (offline game_state.gd:4480,4494): o RAIO nunca sorteia
            // campeão com Barreira — o filtro é por call site, não na função
            // compartilhada (a FUMAÇA sorteia o protegido e o deixa imune).
            const picks = pickRandomEnemyChamps(state, casterIdx, 2, { rng })
                .filter(({ p, i }) => {
                    const ch = state.players[p]?.field?.[i];
                    return !(ch?.barrier || ch?.barrierPermanent);
                });
            if (!picks.length)
                break;
            const sorted = picks.slice().sort((a, b) => (a.p !== b.p ? b.p - a.p : b.i - a.i));
            // C-A07: planeja as reduções e suspende quando ALGUM alvo tem
            // dono com PROTEÇÃO DIVINA na mão (a pergunta é por redução;
            // sem a carta em nenhum alvo, o caminho antigo, inline).
            const planned = sorted.map(({ p, i }) => {
                const ch = state.players[p]?.field?.[i];
                return ch ? {
                    targetP: p, targetI: i,
                    targetUid: ch.uid, targetName: ch.name,
                    amount: 1, source: "raioDuplo", sourceLabel: "RAIO DUPLO",
                    reason: "raioDuplo", killerP: -1,
                } : null;
            }).filter(Boolean);
            if (planned.length
                && planned.some((r) => R()?.canOfferReactiveProtection?.(state, r.targetP, casterIdx)?.ok)) {
                // U-B07 / E-N1 Opção 1 (rodada 5): o visual viaja COM a
                // suspensão (a autoridade difunde os eventos + envelope
                // para os dois assentos ANTES da pergunta — mesmo padrão
                // da VINGANÇA). Hits SEM before/after: o envelope não
                // gera patch de Poder (o dano só cai na retomada).
                events.push({
                    type: "RAIO_DUPLO", casterIdx, fieldIdx,
                    hits: planned.map((r) => ({ p: r.targetP, i: r.targetI })),
                    names: planned.map((r) => r.targetName),
                    visual: "raio_duplo",
                });
                return { ok: true, state, events,
                    suspended: { reductions: planned,
                        finish: { kind: "raioDuplo", casterIdx, fieldIdx } } };
            }
            const names = [];
            const hits = [];
            for (const { p, i } of sorted) {
                const ch = state.players[p]?.field[i];
                if (!ch)
                    continue;
                const before = ch.currentPower ?? 0;
                reduceChampionPower(ch, 1, { ownerP: p, currentP: state.currentPlayer });
                names.push(ch.name);
                hits.push({ p, i, before, after: ch.currentPower });
                if (ch.currentPower <= 0 && before > 0) {
                    // RAIO DUPLO não dá PV (carta: "Você Não ganha Pvs por
                    // isso"; offline resolve_raio: grant_vp=false) — sem killerP.
                    destroyAtField(state, p, i, events, "raioDuplo");
                }
            }
            markOnEnterUsed(state, casterIdx, key);
            events.push({ type: "RAIO_DUPLO", casterIdx, fieldIdx, hits, names, visual: "raio_duplo" });
            break;
        }
        case "invokeDragon": {
            const maxField = R()?.LIMITS?.MAX_FIELD ?? 6;
            const field = state.players[casterIdx]?.field;
            if (!field || field.length >= maxField) {
                events.push({ type: "FIELD_FULL_DRAGON", casterIdx, ability: key });
                break;
            }
            const data = D();
            const def = data?.babyDragonDef || { name: "FILHOTE DE DRAGÃO", power: 1, category: "champion" };
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
        case "prisaoPrismatica": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const target = state.players[tp]?.field?.[ti];
            if (!target || tp === casterIdx)
                break;
            const already = !!target.prisaoPrismatica;
            if (!already)
                target.prisaoPrismatica = true;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "PRISAO_PRISMATICA",
                casterIdx, fieldIdx,
                targetP: tp, targetI: ti,
                targetName: target.name,
                already,
                visual: "prisao_prismatica",
            });
            break;
        }
        case "separar": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const field = state.players[tp]?.field;
            const src = field?.[ti];
            const maxField = R()?.effectiveMaxField?.(state.players[tp])
                ?? R()?.LIMITS?.MAX_FIELD ?? 6;
            if (!src || tp === casterIdx)
                break;
            if ((src.currentPower ?? src.power) !== 2)
                break;
            // C-M07 (offline _pode_separar): sem INSPIRAR, sem MURALHA,
            // sem FÚRIA e nunca um enfeitiçado próprio.
            if (src.inspiracao || src.wallBuff || (src.furyStacks ?? 0) > 0)
                break;
            if (src.charme && src.charmeOriginalOwner === casterIdx)
                break;
            function splitClone(source) {
                const c = JSON.parse(JSON.stringify(source));
                c.uid = `sep-${Date.now()}-${field.length}-${Math.floor(Math.random() * 1e9)}`;
                c.currentPower = 1;
                c.basePower = 1;
                c.power = 1;
                c.separado = true;
                // A-N10 (offline _dividir, game_state.gd:3601-3625): o clone
                // é t.duplicate(true) — copia TUDO, inclusive o CANSADO.
                c.tapped = source.tapped ?? false;
                c.onEnterConsumed = true;
                return c;
            }
            // C-M07: o original vai para o DESCARTE do dono (não é
            // destruído — sem PV, sem gatilhos); as cópias mantêm a
            // Fúria do original (o zeramento anterior era um gap).
            // Campo cheio (6): só cabe 1 cópia (o original sai → 5).
            const owner = state.players[tp];
            const full = (field?.length ?? 0) >= maxField;
            const clones = [splitClone(src)];
            if (!full)
                clones.push(splitClone(src));
            field.splice(ti, 1, ...clones);
            owner.discard = owner.discard || [];
            owner.discard.push(src);
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "SEPARAR",
                casterIdx, fieldIdx,
                targetP: tp, targetI: ti,
                targetName: src.name,
                clones: clones.map((c) => c.uid),
                visual: "separar",
            });
            if (R()?.recalcDesafiante)
                R().recalcDesafiante(state);
            break;
        }
        case "enfraquecer": {
            let opp = null;
            for (let i = 0; i < (state.playersCount ?? state.players?.length ?? 0); i++) {
                if (i !== casterIdx) {
                    opp = i;
                    break;
                }
            }
            if (opp == null)
                break;
            const pl = state.players[opp];
            const before = pl.vp ?? 0;
            pl.vp = Math.max(0, before - 1);
            const lost = before - pl.vp;
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "ENFRAQUECER",
                casterIdx, fieldIdx,
                targetIdx: opp,
                lost,
                vpAfter: pl.vp,
                visual: "enfraquecer",
            });
            break;
        }
        case "energizar": {
            const pl = state.players[casterIdx];
            if (!pl)
                break;
            let mode = "bonus";
            if ((pl.ultimateUses ?? 0) > 0) {
                pl.ultimateUses = (pl.ultimateUses ?? 0) - 1;
                mode = "restore";
            }
            else {
                pl.bonusUltimateUses = (pl.bonusUltimateUses ?? 0) + 1;
                mode = "bonus";
            }
            markOnEnterUsed(state, casterIdx, key);
            events.push({
                type: "ENERGIZAR",
                casterIdx, fieldIdx,
                mode,
                ultimateUses: pl.ultimateUses ?? 0,
                bonusUltimateUses: pl.bonusUltimateUses ?? 0,
                visual: "energizar",
            });
            break;
        }
        case "charme": {
            const tp = resolution.targetP;
            const ti = resolution.targetI;
            const enemyField = state.players[tp]?.field;
            const target = enemyField?.[ti];
            const myField = state.players[casterIdx]?.field;
            if (!target || tp === casterIdx || !myField)
                break;
            if (target.charme)
                break;
            const max = R()?.effectiveMaxField?.(state.players[casterIdx])
                ?? R()?.LIMITS?.MAX_FIELD ?? 6;
            if (myField.length >= max) {
                markOnEnterUsed(state, casterIdx, key);
                events.push({
                    type: "CHARME",
                    casterIdx, fieldIdx,
                    fizzled: true, reason: "no_space",
                    visual: "charme",
                });
                break;
            }
            enemyField.splice(ti, 1);
            target.charme = true;
            target.charmeTurns = 2;
            target.charmeOriginalOwner = tp;
            // A-N4 (offline _recalc_constants): o enfeitiçado perde o +1 da
            // Muralha NA HORA — o bônus só volta quando o Charme acaba
            // (applyWallBonusOnTurnEnd não regenera enquanto charme).
            if (target.wallBuff) {
                if (target.wallBuffApplied)
                    target.currentPower = Math.max(0, (target.currentPower ?? 0) - 1);
                target.wallBuff = false;
                target.wallBuffApplied = false;
                target.wallBuffSnapshot = 0;
                if (R()?.syncWallActive)
                    R().syncWallActive(state.players[tp]);
            }
            // C-M05 (offline _transferir_charme): o roubado chega CANSADO.
            target.tapped = true;
            myField.push(target);
            markOnEnterUsed(state, casterIdx, key);
            if (R()?.recalcDesafiante)
                R().recalcDesafiante(state);
            events.push({
                type: "CHARME",
                casterIdx, fieldIdx,
                targetP: tp, targetI: ti,
                targetName: target.name,
                targetUid: target.uid,
                visual: "charme",
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
    const leg = getEffectsApi()?.canReactive?.(talentEffect, state, defOwner, null)
        || (() => {
            const handIdx = R()?.findReactiveTalentHandIndex?.(state, defOwner, talentEffect) ?? -1;
            return handIdx >= 0 ? { ok: true, handIdx } : { ok: false, code: "NO_CARD" };
        })();
    if (!leg?.ok)
        return { ok: false, state, events, error: leg?.code || "NO_REACTIVE" };
    const handIdx = leg.handIdx;
    const card = state.players[defOwner].hand.splice(handIdx, 1)[0];
    state.players[defOwner].discard = state.players[defOwner].discard || [];
    if (card?.podridao) {
        delete card.podridao;
        state.players[defOwner].discard.push(card);
        events.push({
            type: "PODRIDAO_FIZZLE",
            defOwner,
            category: "reaction",
            cardName: card?.name,
            visual: "podridao_fizzle",
        });
        return { ok: true, state, events, blocked: false, protected: false, cancelled: false };
    }
    state.players[defOwner].discard.push(card);
    events.push({
        type: "REACTIVE_USED",
        defOwner,
        talentEffect,
        cardName: card?.name,
        blocked: talentEffect === "bloquearAtaque",
        protected: talentEffect === "protecaoDivina",
        cancelled: talentEffect === "cancelarUltimate",
        exhausted: talentEffect === "exaustao",
        countered: talentEffect === "contramagica",
    });
    return {
        ok: true,
        state,
        events,
        blocked: talentEffect === "bloquearAtaque",
        protected: talentEffect === "protecaoDivina",
        cancelled: talentEffect === "cancelarUltimate",
        exhausted: talentEffect === "exaustao",
        countered: talentEffect === "contramagica",
    };
}
/**
 * C-A07 (Lote F): aplica UMA redução planejada (retomada da suspensão).
 * O alvo é re-resolvido por uid (índices mudam a cada destruição); se
 * saiu do campo, a redução é descartada (gone=true — REDUCTION_TARGET_GONE).
 * `skip=true` = PROTEÇÃO DIVINA cancelou (nada é reduzido). A destruição
 * usa destroyAtField (emite DESTROY e encadeia o burst da vítima, que
 * volta como newPendingReduction — VINGANÇA em cadeia, fim da fila).
 */
function applyPlannedReduction(state, reduction, opts = {}) {
    const events = [];
    const skip = opts.skip === true;
    const targetP = reduction.targetP | 0;
    const field = state.players[targetP]?.field || [];
    const idx = field.findIndex((c) => c && String(c.uid) === String(reduction.targetUid));
    if (idx < 0)
        return { ok: true, state, events, gone: true };
    const target = field[idx];
    const before = target.currentPower ?? 0;
    if (skip) {
        events.push({
            type: "REDUCTION_CANCELLED",
            source: reduction.source || "protecaoDivina",
            targetP, targetI: idx,
            targetUid: reduction.targetUid, targetName: reduction.targetName,
            amount: reduction.amount ?? 1,
        });
        return { ok: true, state, events, before, after: before, skipped: true };
    }
    const res = reduceChampionPower(target, reduction.amount ?? 1,
        { ownerP: targetP, currentP: state.currentPlayer, preserveWallBuff: state.currentPlayer === targetP });
    const after = target.currentPower ?? 0;
    events.push({
        type: "POWER_REDUCTION",
        source: reduction.source || "reducao",
        targetP, targetI: idx,
        targetUid: reduction.targetUid, targetName: reduction.targetName,
        amount: reduction.amount ?? 1, before, after,
        blockedByBarrier: res?.blockedByBarrier === true,
    });
    if (res?.blockedByBarrier) {
        events.push({ type: "BARRIER_BLOCKED", targetP, targetI: idx,
            source: reduction.source || "reducao", visual: "barrier_block" });
        return { ok: true, state, events, before, after, blockedByBarrier: true };
    }
    let newPendingReduction = null;
    if (after <= 0 && before > 0) {
        const evBefore = events.length;
        destroyAtField(state, targetP, idx, events,
            reduction.reason || "reducao", reduction.killerP ?? -1);
        for (let k = evBefore; k < events.length; k++) {
            const pr = events[k]?.pendingReduction
                || events[k]?.burst?.pendingReduction;
            if (pr) { newPendingReduction = pr; break; }
        }
    }
    return { ok: true, state, events, before, after, newPendingReduction };
}

/** C-A07: final do RAIO DUPLO suspenso — marca o uso e emite o agregado. */
function finishRaioDuplo(state, finish, applied) {
    const events = [];
    const casterIdx = finish.casterIdx;
    const fieldIdx = finish.fieldIdx;
    markOnEnterUsed(state, casterIdx, "raioDuplo");
    const champ = state.players[casterIdx]?.field?.[fieldIdx];
    if (champ)
        markChampOnEnterConsumed(champ);
    // U-B07 / E-N1 Opção 1 (rodada 5): o visual JÁ tocou na suspensão —
    // o finish NÃO re-emite o evento RAIO_DUPLO (exatamente 1 vez). O
    // dano viaja nos eventos POWER_REDUCTION + no estado cheio do resume.
    return { ok: true, state, events };
}

/** C-A07: final da CHUVA DE COMETAS suspensa — agregado + clearActive. */
function finishChuvaDeCometas(state, finish, applied) {
    const events = [];
    const pIdx = finish.playerId;
    const appliedHits = (applied || []).map((a) => ({ p: a.targetP, i: a.targetI, name: a.targetName, powerAfter: a.after }));
    const hits = [...(finish.barrierHits || []), ...appliedHits]
        .sort((a, b) => (a.p !== b.p ? a.p - b.p : b.i - a.i));
    // U-B07 / E-N1 Opção 1 (rodada 5): o visual JÁ tocou na suspensão —
    // o evento do finish NÃO carrega `visual` (exatamente 1 vez). Os hits
    // com powerAfter ficam para o registro (log); o dano viaja nos
    // eventos POWER_REDUCTION + no estado cheio do resume.
    events.push({ type: "TALENT_CHUVA_DE_COMETAS", playerId: pIdx, hits });
    const at = state.activeTalent;
    if (at?.card && at.ownerP === pIdx) {
        const card = at.card;
        state.activeTalent = null;
        const disc = state.players[pIdx].discard || [];
        // C-B16: a carta já está no descarte desde o TALENT_START.
        const uid = card.uid != null ? String(card.uid) : "";
        const already = uid
            ? disc.some((c) => c && String(c.uid || "") === uid)
            : disc.some((c) => c && c === card);
        if (!already) disc.push(card);
        state.players[pIdx].discard = disc;
        events.push({ type: "TALENT_RESOLVED", playerId: pIdx,
            talentEffect: card.talentEffect, cardName: card.name,
            targetP: finish.targetP ?? null, targetI: finish.targetI ?? null });
    }
    return { ok: true, state, events };
}

/**
 * C-A08 (Lote F): descarta um talento DA MÃO sem efeito e sem custo
 * (CONTRAMÁGICA no TALENT_START da IA — o talento nunca chegou a
 * iniciar; espelho do _do_talent_discard do cliente humano).
 */
function discardTalentFromHand(state, pIdx, handIdx) {
    const events = [];
    const p = state.players[pIdx];
    const card = p?.hand?.[handIdx];
    if (!card || card.category !== "talent")
        return { ok: false, state, events, error: "NOT_TALENT" };
    p.hand.splice(handIdx, 1);
    p.discard = p.discard || [];
    p.discard.push(card);
    events.push({ type: "TALENT_DISCARDED", playerId: pIdx,
        talentEffect: card.talentEffect, cardName: card.name });
    return { ok: true, state, events };
}

function applyTalentFromHand(state, pIdx, handIdx) {
    const p = state.players[pIdx];
    const card = p?.hand?.[handIdx];
    if (!card || card.category !== "talent") {
        return { ok: false, state, events: [], error: "NOT_TALENT" };
    }
    // C-M25 (defesa em profundidade): nunca sobrescrever um talento ativo.
    if (state.activeTalent)
        return { ok: false, state, events: [], error: "TALENT_ALREADY_ACTIVE" };
    const cost = R()?.talentPlayCost?.(card) ?? card.currentPower ?? card.power ?? 0;
    if ((p.actions ?? 0) < cost)
        return { ok: false, state, events: [], error: "INSUFFICIENT_ACTIONS" };
    if (cost > 0)
        p.actions = Math.max(0, (p.actions ?? 0) - cost);
    const [removed] = p.hand.splice(handIdx, 1);
    // APODRECIDA: vai para activeTalent (UI canto SE) e resolve sem efeito.
    if (removed?.name === "APODRECIDA" || removed?.talentEffect === "apodrecidaDescarte") {
        state.activeTalent = { ownerP: pIdx, card: removed, spentActions: 0 };
        return {
            ok: true,
            state,
            events: [{
                    type: "TALENT_STARTED",
                    playerId: pIdx,
                    handIdx,
                    talentEffect: "apodrecidaDescarte",
                    card: removed.name,
                    visual: "apodrecida_play",
                }],
            card: removed,
        };
    }
    if (removed.podridao) {
        delete removed.podridao;
        p.discard = p.discard || [];
        p.discard.push(removed);
        return {
            ok: true,
            state,
            events: [{
                    type: "PODRIDAO_FIZZLE",
                    playerId: pIdx,
                    category: "talent",
                    cardName: removed.name,
                    visual: "podridao_fizzle",
                }],
            card: removed,
        };
    }
    // C-B16 (offline gs:932): o talento vai ao descarte IMEDIATO ao ser
    // jogado; activeTalent é só a trava (a 7ª carta continua renderizada
    // a partir de activeTalent.card — o cliente lê de lá). A mesma
    // referência vai aos dois lugares; as saídas dedupeiam por uid.
    state.activeTalent = { ownerP: pIdx, card: removed, spentActions: cost > 0 ? cost : 0 };
    p.discard = p.discard || [];
    p.discard.push(removed);
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
// C-A14 (offline 1.51.48): pick do RESSUSCITAR — o último P2 destruído
// (lastDestroyedSummon), senão o P2 mais recente do descarte. O caso e a
// pré-checagem do TALENT_START usam a MESMA função para não divergirem.
function findRessuscitarPick(state, pIdx) {
    const pl = state.players[pIdx];
    const disc = pl?.discard || [];
    const last = pl?.lastDestroyedSummon;
    const tryRef = (ref) => {
        if (!ref)
            return null;
        if (ref.category && ref.category !== "champion" && ref.category !== "hidden")
            return null;
        const baseDef = findCardDef(ref.name) || D()?.dragonTokenDef?.(String(ref.name));
        if (!baseDef || baseDef.category === "talent" || baseDef.category === "reaction")
            return null;
        if ((baseDef.power ?? 0) !== 2)
            return null;
        const dIdx = disc.indexOf(ref);
        if (dIdx < 0)
            return null;
        return { ref, baseDef, dIdx };
    };
    let pick = null;
    if (last?.discardRef)
        pick = tryRef(last.discardRef);
    if (!pick) {
        for (let i = disc.length - 1; i >= 0; i--) {
            pick = tryRef(disc[i]);
            if (pick)
                break;
        }
    }
    return pick;
}
function hasRessuscitarTarget(state, pIdx) {
    return !!findRessuscitarPick(state, pIdx);
}
/**
 * Resolve talento ativo com alvo (autoridade servidor / motor).
 * Talentos sem implementação completa retornam NOT_IMPLEMENTED (fallback snapshot).
 */
function applyTalentTarget(state, pIdx, targetP, targetI, extra) {
    const events = [];
    const at = state.activeTalent;
    if (!at?.card || at.ownerP !== pIdx) {
        return { ok: false, state, events, error: "NO_ACTIVE_TALENT" };
    }
    const effect = at.card.talentEffect;
    const tp = targetP | 0;
    const ti = targetI | 0;
    const resolution = (extra && typeof extra === "object") ? extra : {};
    const target = state.players[tp]?.field?.[ti];
    if (!target && effect !== "zeroAbsoluto") {
        return { ok: false, state, events, error: "NO_TARGET" };
    }
    const clearActive = () => {
        const card = at.card;
        state.activeTalent = null;
        const disc = state.players[pIdx].discard || [];
        // C-B16: a carta já está no descarte desde o TALENT_START.
        const uid = card.uid != null ? String(card.uid) : "";
        const already = uid
            ? disc.some((c) => c && String(c.uid || "") === uid)
            : disc.some((c) => c && c === card);
        if (!already) disc.push(card);
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
            // C-A17: a Barreira bloqueia e PERMANECE (central, reduceChampionPower).
            // C-A06/C-A08: skipPower (PROTEÇÃO DIVINA, SIM) cancela a
            // redução — o talento resolve sem o dano, mas é consumido.
            const bolaTalBefore = target.currentPower ?? 0;
            const bolaTalRes = resolution.skipPower === true
                ? { blockedByBarrier: false }
                : reduceChampionPower(target, 1, { ownerP: tp, currentP: state.currentPlayer });
            if (bolaTalRes?.blockedByBarrier) {
                events.push({ type: "BARRIER_BLOCKED", targetP: tp, targetI: ti, visual: "barrier_block" });
                clearActive();
                break;
            }
            events.push({
                type: "TALENT_BOLA_DE_FOGO", targetP: tp, targetI: ti,
                powerAfter: target.currentPower, visual: "bola_de_fogo",
                powerCancelled: resolution.skipPower === true,
            });
            if ((target.currentPower ?? 0) <= 0 && bolaTalBefore > 0)
                destroyAtField(state, tp, ti, events, "bolaDeFogoTalento", pIdx);
            clearActive();
            break;
        }
        case "explosao": {
            // C-A17: a Barreira bloqueia e PERMANECE (central, reduceChampionPower).
            // C-A06/C-A08: skipPower (PROTEÇÃO DIVINA, SIM) — igual à BOLA.
            const explosaoBefore = target.currentPower ?? 0;
            const explosaoRes = resolution.skipPower === true
                ? { blockedByBarrier: false }
                : reduceChampionPower(target, 2, { ownerP: tp, currentP: state.currentPlayer });
            if (explosaoRes?.blockedByBarrier) {
                events.push({ type: "BARRIER_BLOCKED", targetP: tp, targetI: ti, source: "explosao", visual: "barrier_block" });
                clearActive();
                break;
            }
            events.push({
                type: "TALENT_EXPLOSAO", targetP: tp, targetI: ti,
                powerAfter: target.currentPower, visual: "explosao",
                powerCancelled: resolution.skipPower === true,
            });
            if ((target.currentPower ?? 0) <= 0 && explosaoBefore > 0)
                destroyAtField(state, tp, ti, events, "explosao", pIdx);
            clearActive();
            break;
        }
        case "fortalecerTalento": {
            if (tp !== pIdx)
                return { ok: false, state, events, error: "ALLY_ONLY" };
            // C-M11: FORTALECER nunca numa APODRECIDA (não é campeão);
            // e o talento NÃO sobe a base — só o Poder atual.
            if (isApodrecidaCard(target))
                return { ok: false, state, events, error: "INVALID_TARGET" };
            target.currentPower = (target.currentPower ?? target.power ?? 0) + 1;
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
                destroyAtField(state, tp, ti, events, "zeroAbsoluto", pIdx);
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
        case "investidaTalento": {
            if (tp !== pIdx)
                return { ok: false, state, events, error: "ALLY_ONLY" };
            // B-N06 (offline _apply_investida_talento, game_state.gd:2890-2901):
            // o Pesado (URSO PESADO) NÃO é vetado — só o CANSADO é. O
            // ataque continua custando 2 (attack_cost checa urso_pesado
            // antes do freeAttack). O veto BANJO_NO_INVESTIDA foi removido.
            // C-A12 (offline _apply_investida_talento): a mira exclui
            // CANSADOS — a rejeição deixa o talento ATIVO (o jogador
            // escolhe outro alvo; a carta não é perdida nem consumida).
            // (1.51.96 item 13a) SILENCIADO não recebe INVESTIDA — mesma
            // rejeição, sem consumir o talento.
            if (target.silenced)
                return { ok: false, state, events, error: "SILENCED_TARGET" };
            if (target.tapped)
                return { ok: false, state, events, error: "TIRED_TARGET" };
            target.constantEffect = "investida";
            target.freeAttack = true;
            target.tapped = false;
            events.push({
                type: "TALENT_INVESTIDA", targetP: tp, targetI: ti,
                targetName: target.name, visual: "investida",
            });
            clearActive();
            break;
        }
        case "prisaoPrismaticaTalento": {
            if (tp === pIdx)
                return { ok: false, state, events, error: "ENEMY_ONLY" };
            const already = !!target.prisaoPrismatica;
            if (!already)
                target.prisaoPrismatica = true;
            events.push({
                type: "TALENT_PRISAO_PRISMATICA", targetP: tp, targetI: ti,
                targetName: target.name, already, visual: "prisao_prismatica",
            });
            clearActive();
            break;
        }
        case "tornadoDeFogo": {
            if (tp === pIdx)
                return { ok: false, state, events, error: "ENEMY_ONLY" };
            if (target.barrier || target.barrierPermanent) {
                events.push({
                    type: "TALENT_TORNADO_DE_FOGO", targetP: tp, targetI: ti,
                    targetName: target.name, immune: true, applied: false, visual: "em_chamas",
                });
            }
            else {
                target.burning = true;
                target.burningTurns = 4;
                target.burningByP = pIdx;
                events.push({
                    type: "TALENT_TORNADO_DE_FOGO", targetP: tp, targetI: ti,
                    targetName: target.name, turns: 4, applied: true, visual: "em_chamas",
                });
            }
            clearActive();
            break;
        }
        case "trocaDeLugar": {
            // target = aliado P1; o P2 inimigo é SORTEADO no servidor
            // (C-M06, offline _troca_de_lugar) — o enemyP/enemyI do
            // cliente é ignorado (a fase 2 de mira do cliente ficou
            // obsoleta). Pool: P2 do campo adversário, excluindo os
            // enfeitiçados próprios (charmeOriginalOwner === pIdx).
            if (tp !== pIdx)
                return { ok: false, state, events, error: "ALLY_ONLY" };
            const allyPow = target.currentPower ?? target.power ?? 0;
            if (allyPow !== 1)
                return { ok: false, state, events, error: "ALLY_MUST_BE_P1" };
            const ep = 1 - pIdx;
            const pool = [];
            (state.players[ep]?.field || []).forEach((c, i) => {
                if (!c)
                    return;
                if ((c.currentPower ?? c.power ?? 0) !== 2)
                    return;
                if (c.charme && c.charmeOriginalOwner === pIdx)
                    return;
                pool.push(i);
            });
            if (!pool.length) {
                events.push({
                    type: "TALENT_TROCA_DE_LUGAR",
                    allyP: pIdx, allyI: ti,
                    fizzled: true, reason: "NO_P2", visual: "troca_de_lugar",
                });
                clearActive();
                break;
            }
            const pickRng = resolution.rng || Math.random;
            const ei = pool[Math.floor(pickRng() * pool.length)];
            if (!swapFieldChamps(state, pIdx, ti, ep, ei))
                return { ok: false, state, events, error: "NO_ENEMY" };
            events.push({
                type: "TALENT_TROCA_DE_LUGAR",
                allyP: pIdx, allyI: ti,
                enemyP: ep, enemyI: ei,
                visual: "troca_de_lugar",
            });
            clearActive();
            break;
        }
        case "corromperTalento": {
            if (tp !== pIdx)
                return { ok: false, state, events, error: "ALLY_ONLY" };
            // (1.51.96 item 13a) SILENCIADO não recebe CORROMPER — a
            // rejeição deixa o talento ATIVO (o jogador escolhe outro
            // alvo; a carta não é perdida nem consumida).
            if (target.silenced)
                return { ok: false, state, events, error: "SILENCED_TARGET" };
            const abilityName = String(target.mimicAbilityName || target.abilityName || "");
            const nativeNoHonor = target.onDestroy === "noHonor"
                || target.mimicOnDestroy === "noHonor"
                || abilityName.toLowerCase().normalize("NFD")
                    .replace(/[\u0300-\u036f]/g, "").includes("sem honra");
            // Correção-motor 3 (t_928): idem o site da habilidade — o nativo
            // Sem Honra NÃO conta quando silenciado (hasNoHonor: silenced ->
            // false; offline resolve_corromper seta corrupted=true sempre).
            const alreadyNoHonor = (nativeNoHonor && !target.silenced) || !!target.corruptedNoHonor;
            if (!alreadyNoHonor)
                target.corruptedNoHonor = true;
            events.push({
                type: "TALENT_CORROMPER",
                targetP: tp, targetI: ti,
                targetName: target.name, alreadyNoHonor, visual: "corrupt",
            });
            clearActive();
            break;
        }
        case "transformarBichinhoTalento": {
            if (tp === pIdx)
                return { ok: false, state, events, error: "ENEMY_ONLY" };
            const pow = target.currentPower ?? target.power ?? 0;
            if (pow < 2)
                return { ok: false, state, events, error: "NEED_POWER_GE_2" };
            if (target.barrier || target.barrierPermanent) {
                events.push({
                    type: "TALENT_TRANSFORMAR_BICHINHO",
                    targetP: tp, targetI: ti, targetName: target.name,
                    immune: true, visual: "transformar_bichinho",
                });
                clearActive();
                break;
            }
            // U-B02 (rodada 3): skipPower (PROTEÇÃO DIVINA, SIM) cancela
            // o morfo — o talento é consumido, o alvo fica como está.
            if (resolution.skipPower === true) {
                events.push({
                    type: "TALENT_TRANSFORMAR_BICHINHO",
                    targetP: tp, targetI: ti, targetName: target.name,
                    origName: target.name, origPower: pow,
                    powerCancelled: true, visual: "transformar_bichinho",
                });
                clearActive();
                break;
            }
            const origPower = pow;
            const origName = target.name;
            const tfRng = resolution.rng || Math.random;
            const tfSuccess = resolution.success != null ? !!resolution.success : tfRng() < 0.80;
            const newPower = tfSuccess ? Math.floor(origPower / 2) : (origPower + 1);
            const tokenDef = findCardDef(tfSuccess ? "BICHINHO FOFINHO" : "O CHEFÃO");
            if (!tokenDef)
                return { ok: false, state, events, error: "NO_TOKEN_DEF" };
            // C-A11: vulnerável morfa como qualquer alvo (o ramo
            // TRANSFORM_VULN_DESTROY foi removido — o status é limpo
            // por clearMorphStatuses no morfo).
            applyTokenTransform(target, tokenDef, newPower);
            events.push({
                type: "TALENT_TRANSFORMAR_BICHINHO",
                targetP: tp, targetI: ti, success: tfSuccess,
                origName, origPower, newPower, visual: "transformar_bichinho",
            });
            clearActive();
            break;
        }
        case "medoTalento": {
            // AMEDRONTAR (talento, P2): um adversário de Poder 2 ou
            // menos volta para a mão do dono. Espelho do offline
            // (_return_medo): usa bounceChampionToHand (reseta todos
            // os status e o Poder para a base; mão cheia → exílio).
            if (tp === pIdx)
                return { ok: false, state, events, error: "ENEMY_ONLY" };
            const pow = target.currentPower ?? target.power ?? 0;
            if (pow > 2)
                return { ok: false, state, events, error: "NEED_POWER_LE_2" };
            if (target.charme && target.charmeOriginalOwner === pIdx)
                return { ok: false, state, events, error: "INVALID_TARGET" };
            const bounced = R().bounceChampionToHand(state, tp, ti);
            if (!bounced)
                return { ok: false, state, events, error: "NO_TARGET" };
            events.push({
                type: "TALENT_MEDO",
                targetP: tp, targetI: ti,
                targetName: bounced.name, exiled: bounced.exiled,
                visual: "medo",
            });
            clearActive();
            break;
        }
        case "doppelganger": {
            // DUPLICAR (talento, P2): um aliado de Poder 2 é copiado
            // (cópia exata). Espelho do offline (_duplicar_now): a cópia
            // entra direto no campo (nunca via SUMMON), com
            // duplicarBorn=true, nascendo DESCANSADA e mantendo a
            // instantânea marcada como usada (se voltar à mão e for
            // re-invocada, dispara de novo).
            if (tp !== pIdx)
                return { ok: false, state, events, error: "ALLY_ONLY" };
            const pow = target.currentPower ?? target.power ?? 0;
            if (pow !== 2)
                return { ok: false, state, events, error: "NEED_POWER_2" };
            const field = state.players[pIdx].field || [];
            const maxField = R()?.LIMITS?.MAX_FIELD ?? 6;
            if (field.length >= maxField) {
                // C-M23: campo cheio não trava o talento ativo — fizzle
                // com evento e libera o slot (o talento vai ao descarte).
                events.push({
                    type: "TALENT_DOPPELGANGER",
                    targetP: tp, targetI: ti,
                    fizzled: true, reason: "FIELD_FULL", visual: "doppelganger",
                });
                clearActive();
                break;
            }
            const copy = JSON.parse(JSON.stringify(target));
            copy.uid = `u-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
            copy.duplicarBorn = true;
            copy.tapped = false;
            copy.onEnterConsumed = true;
            delete copy.slot;
            field.push(copy);
            R().ensureFieldSlots(field);
            // C-A02: a cópia é uma NOVA entrada — se for fonte de INSPIRAR,
            // limpa o bloqueio dos vizinhos dela.
            if (R()?.hasInspirar?.(copy)) R().clearInspirarBrokenForNeighbors?.(state, pIdx, field.indexOf(copy));
            events.push({
                type: "TALENT_DOPPELGANGER",
                targetP: tp, targetI: ti,
                copyUid: copy.uid, copyName: copy.name,
                visual: "doppelganger",
            });
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
/** Talentos auto (sem alvo) — Arsenal, Maldição, Grito, Técnicas. */
function applyTalentAuto(state, pIdx, rng = Math.random) {
    const events = [];
    const at = state.activeTalent;
    if (!at?.card || at.ownerP !== pIdx) {
        return { ok: false, state, events, error: "NO_ACTIVE_TALENT" };
    }
    const effect = at.card.talentEffect;
    const pl = state.players[pIdx];
    const maxHand = R()?.LIMITS?.MAX_HAND ?? 8;
    const clearActive = () => {
        const card = at.card;
        state.activeTalent = null;
        const disc = pl.discard || [];
        // C-B16: a carta já está no descarte desde o TALENT_START.
        const uid = card.uid != null ? String(card.uid) : "";
        const already = uid
            ? disc.some((c) => c && String(c.uid || "") === uid)
            : disc.some((c) => c && c === card);
        if (!already) disc.push(card);
        pl.discard = disc;
        events.push({
            type: "TALENT_RESOLVED",
            playerId: pIdx,
            talentEffect: effect,
            cardName: card.name,
        });
    };
    switch (effect) {
        case "arsenalDeGuerra": {
            const drawn = [];
            const burned = [];
            for (let n = 0; n < 2; n++) {
                const deck = pl.deck || [];
                if (!deck.length) {
                    events.push({
                        type: "TALENT_ARSENAL_DE_GUERRA",
                        playerId: pIdx, drawn: drawn.length, fizzled: true,
                        reason: "deck_empty", visual: "card_draw",
                    });
                    break;
                }
                // SEM-QUEIMA (2026-11-15 — REVOGA C-M14): com a mão
                // cheia o saque não acontece (drawCardWithBurn retorna
                // null) — o laço para sem queimar nada.
                const res = R()?.drawCardWithBurn?.(state, pIdx);
                if (!res)
                    break;
                if (res.burned) {
                    burned.push(res.card?.name || "?");
                }
                else {
                    if (pl.bolhasActive && res.card?.category === "champion")
                        res.card.bolhas = true;
                    drawn.push(res.card?.name || "?");
                }
            }
            events.push({
                type: "TALENT_ARSENAL_DE_GUERRA",
                playerId: pIdx, drawn: drawn.length, names: drawn,
                burned, visual: "card_draw",
            });
            clearActive();
            break;
        }
        case "gritoDeGuerraTalento": {
            const applied = [];
            (pl.field || []).forEach((ally, i) => {
                if (!ally)
                    return;
                // (1.51.96 item 13a) SILENCIADO não recebe FÚRIA.
                if (ally.silenced)
                    return;
                R()?.grantFuryStacks?.(ally, 1);
                applied.push({
                    p: pIdx, i, name: ally.name,
                    furyStacks: R()?.getFuryStacks?.(ally) || 1,
                });
            });
            events.push({
                type: "TALENT_GRITO_DE_GUERRA",
                playerId: pIdx, applied, visual: "fury",
            });
            clearActive();
            break;
        }
        case "tecnicasDeCombateTalento": {
            const applied = [];
            (pl.field || []).forEach((ally, i) => {
                if (!ally)
                    return;
                // (1.51.96 item 13a) SILENCIADO não recebe SOBREPUJAR.
                if (ally.silenced)
                    return;
                ally.tecnicasSobrepujar = true;
                ally.tecnicasSobrepujarTurns = Math.max(ally.tecnicasSobrepujarTurns ?? 0, 2);
                applied.push({ p: pIdx, i, name: ally.name, uid: ally.uid });
            });
            events.push({
                type: "TALENT_TECNICAS_DE_COMBATE",
                playerId: pIdx, applied, visual: "tecnicas_combate",
            });
            clearActive();
            break;
        }
        case "podridaoTalento": {
            let enemyIdx = -1;
            const pCount = state.playersCount ?? state.players?.length ?? 0;
            for (let ep = 0; ep < pCount; ep++) {
                if (ep !== pIdx) {
                    enemyIdx = ep;
                    break;
                }
            }
            if (enemyIdx < 0) {
                clearActive();
                break;
            }
            const result = applyPodridaoToEnemyDeck(state, enemyIdx, Math.random);
            events.push({
                type: "TALENT_PODRIDAO",
                playerId: pIdx,
                enemyIdx,
                count: result.count,
                names: result.names,
                fizzled: !!result.fizzled,
                reason: result.reason,
                podridaoHits: result.podridaoHits,
                visual: "podridao",
            });
            clearActive();
            break;
        }
        case "apodrecidaDescarte": {
            events.push({
                type: "APODRECIDA_DISCARD",
                playerId: pIdx,
                cardName: at.card?.name || "APODRECIDA",
                visual: "apodrecida_discard",
            });
            clearActive();
            break;
        }
        case "barreira": {
            // BARREIRA (talento, P2): TODOS os aliados ganham Barreira
            // por 2 rodadas. Espelho do offline (_add_barrier(c, 2)):
            // barrier_turns = max(barrier_turns, 2); a permanente
            // (barrierPermanent) nunca é tocada.
            const field = pl.field || [];
            for (const c of field) {
                // (1.51.96 item 13a) SILENCIADO não recebe BARREIRA.
                if (c && !c.barrierPermanent && !c.silenced) {
                    c.barrier = true;
                    c.barrierTurns = Math.max(c.barrierTurns || 0, 2);
                }
            }
            events.push({
                type: "TALENT_BARREIRA",
                playerId: pIdx,
                visual: "barreira",
            });
            clearActive();
            break;
        }
        case "bolhasTalento": {
            // BOLHAS (talento, P2): TODOS os campeões na mão do
            // adversário ganham BOLHAS (o primeiro invocado entra sem
            // habilidade). Espelho do offline (_apply_bolhas): marca
            // bolhas_active no adversário + bolhas em cada campeão da
            // mão dele; o consumo acontece na invocação (gancho no
            // SUMMON) e os saques futuros também ganham BOLHAS
            // enquanto o efeito estiver ativo (ganhos no DRAW_CARD,
            // no saque de início de turno e no arsenalDeGuerra).
            let enemyIdx = -1;
            const pCount = state.playersCount ?? state.players?.length ?? 0;
            for (let ep = 0; ep < pCount; ep++) {
                if (ep !== pIdx) {
                    enemyIdx = ep;
                    break;
                }
            }
            if (enemyIdx < 0) {
                clearActive();
                break;
            }
            const foe = state.players[enemyIdx];
            foe.bolhasActive = true;
            const hand = foe.hand || [];
            for (const c of hand) {
                if (c && c.category === "champion") {
                    c.bolhas = true;
                }
            }
            events.push({
                type: "TALENT_BOLHAS",
                playerId: pIdx,
                enemyIdx,
                visual: "bolhas",
            });
            clearActive();
            break;
        }
        case "aceleracao": {
            // ACELERAÇÃO (talento, P2): +1 ação neste turno. Espelho
            // do offline (players[pi]["actions"] += 1). Sem teto:
            // MAX_ACTIONS 3 é só a concessão de início de turno.
            pl.actions = (pl.actions || 0) + 1;
            events.push({
                type: "TALENT_ACELERACAO",
                playerId: pIdx,
                actions: pl.actions,
                visual: "aceleracao",
            });
            clearActive();
            break;
        }
        case "missemagicos": {
            // MÍSSEIS MÁGICOS (talento, P2): dispara em TODOS os
            // adversários, um por um. Espelho do offline
            // (_apply_missemagicos): com barreira é sempre "miss"
            // (sem dano, sem consumir a barreira); sem ela, 60% -1
            // de Poder, 40% "miss". B-N07: os mísseis voam na ORDEM
            // DO CAMPO (primeiro → último), com rolls do rng da sala
            // (não Math.random direto). A lista de alvos é fotografada
            // ANTES (uids) e cada alvo é re-localizado pelo uid — as
            // destruições deslocam os índices, então o índice do loop
            // não vale depois de um abate.
            // DESVIO DOCUMENTADO: é AUTO (o offline não tem mira
            // para ele — a mira escolheria um alvo arbitrário e
            // quebraria o efeito).
            let enemyIdx = -1;
            const pCount = state.playersCount ?? state.players?.length ?? 0;
            for (let ep = 0; ep < pCount; ep++) {
                if (ep !== pIdx) {
                    enemyIdx = ep;
                    break;
                }
            }
            if (enemyIdx < 0) {
                clearActive();
                break;
            }
            const foeField = state.players[enemyIdx].field || [];
            const targets = foeField
                .map((c, i) => ({ c, i }))
                .filter(({ c }) => c && !(c.charme && c.charmeOriginalOwner === pIdx));
            const hits = [];
            for (const { c } of targets) {
                const field = state.players[enemyIdx].field || [];
                const idx = field.findIndex((x) => x && x.uid === c.uid);
                if (idx < 0)
                    continue; // já destruído por uma vingança em cadeia
                const cur = field[idx];
                if (cur.barrier || cur.barrierPermanent) {
                    hits.push({ idx, uid: cur.uid, name: cur.name, result: "miss", reason: "barrier" });
                    continue;
                }
                if (rng() < 0.6) {
                    const missilBefore = cur.currentPower ?? 0;
                    reduceChampionPower(cur, 1, { ownerP: enemyIdx, currentP: state.currentPlayer });
                    hits.push({ idx, uid: cur.uid, name: cur.name, result: "hit", powerAfter: cur.currentPower });
                    if ((cur.currentPower ?? 0) <= 0 && missilBefore > 0)
                        destroyAtField(state, enemyIdx, idx, events, "missemagicos", pIdx);
                }
                else {
                    hits.push({ idx, uid: cur.uid, name: cur.name, result: "miss", reason: "rng" });
                }
            }
            events.push({
                type: "TALENT_MISSEIS_MAGICOS",
                playerId: pIdx,
                enemyIdx,
                hits,
                visual: "misseis_magicos",
            });
            clearActive();
            break;
        }
        case "desacelerarTalento": {
            let t = null;
            for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
                if (p !== pIdx) {
                    t = p;
                    break;
                }
            }
            if (t == null || state.players[t]?.skipNextAction) {
                events.push({
                    type: "TALENT_DESACELERAR",
                    playerId: pIdx, fizzled: true, visual: "desacelerar",
                });
            }
            else {
                state.players[t].skipNextAction = true;
                events.push({
                    type: "TALENT_DESACELERAR",
                    playerId: pIdx, targetIdx: t, visual: "desacelerar",
                });
            }
            clearActive();
            break;
        }
        case "chuvaDeCometas": {
            // C-A07: planeja as reduções (ordem do loop: ep asc, i desc)
            // e suspende quando ALGUM alvo tem dono com PROTEÇÃO DIVINA
            // na mão; sem a carta em nenhum alvo, o caminho antigo.
            // A Barreira pula sem consumir (C-A17) e NÃO vira redução —
            // vai para o `barrierHits` do finish, para o evento final
            // manter a mesma ordem de hits do caminho inline.
            const barrierHits = [];
            const planned = [];
            for (let ep = 0; ep < (state.playersCount ?? state.players.length); ep++) {
                const fld = state.players[ep]?.field || [];
                for (let i = fld.length - 1; i >= 0; i--) {
                    const c = fld[i];
                    if (!c)
                        continue;
                    if (c.barrier || c.barrierPermanent) {
                        barrierHits.push({ p: ep, i, name: c.name, barrier: true });
                        continue;
                    }
                    planned.push({
                        targetP: ep, targetI: i,
                        targetUid: c.uid, targetName: c.name,
                        amount: 1, source: "chuvaDeCometas",
                        sourceLabel: "CHUVA DE COMETAS",
                        reason: "chuvaDeCometas", killerP: pIdx,
                    });
                }
            }
            if (planned.length
                && planned.some((r) => R()?.canOfferReactiveProtection?.(state, r.targetP, pIdx)?.ok)) {
                // U-B07 / E-N1 Opção 1 (rodada 5): o visual viaja COM a
                // suspensão — meteoros caem uma vez para o campo todo,
                // antes das perguntas (1 PROTEÇÃO por campeão). Hits SEM
                // powerAfter: sem patch de Poder antes da retomada.
                events.push({
                    type: "TALENT_CHUVA_DE_COMETAS", playerId: pIdx,
                    hits: [...barrierHits, ...planned.map((r) => ({ p: r.targetP, i: r.targetI, name: r.targetName }))],
                    visual: "comet_starfall",
                });
                return { ok: true, state, events,
                    suspended: { reductions: planned,
                        finish: { kind: "chuvaDeCometas", playerId: pIdx, barrierHits } } };
            }
            const hits = [];
            for (let ep = 0; ep < (state.playersCount ?? state.players.length); ep++) {
                const fld = state.players[ep]?.field || [];
                for (let i = fld.length - 1; i >= 0; i--) {
                    const c = fld[i];
                    if (!c)
                        continue;
                    // C-A17 (offline game_state.gd:4226-4227): Barreira pula
                    // sem consumir — o reduce central nem é chamado aqui.
                    if (c.barrier || c.barrierPermanent) {
                        hits.push({ p: ep, i, name: c.name, barrier: true });
                        continue;
                    }
                    const chuvaBefore = c.currentPower ?? 0;
                    reduceChampionPower(c, 1, { ownerP: ep, currentP: state.currentPlayer, preserveWallBuff: state.currentPlayer === ep });
                    const powerAfter = c.currentPower ?? 0;
                    hits.push({ p: ep, i, name: c.name, powerAfter });
                    if (powerAfter <= 0 && chuvaBefore > 0) {
                        destroyAtField(state, ep, i, events, "chuvaDeCometas", pIdx);
                    }
                }
            }
            events.push({
                type: "TALENT_CHUVA_DE_COMETAS",
                playerId: pIdx, hits, visual: "comet_starfall",
            });
            clearActive();
            break;
        }
        case "ressuscitarTalento": {
            const maxField = R()?.LIMITS?.MAX_FIELD ?? 6;
            if ((pl.field?.length ?? 0) >= maxField) {
                events.push({
                    type: "TALENT_RESSUSCITAR",
                    playerId: pIdx, fizzled: true, reason: "field_full", visual: "resurrect",
                });
                clearActive();
                break;
            }
            const disc = pl.discard || [];
            const pick = findRessuscitarPick(state, pIdx);
            if (!pick) {
                events.push({
                    type: "TALENT_RESSUSCITAR",
                    playerId: pIdx, fizzled: true, reason: "no_p2", visual: "resurrect",
                });
                clearActive();
                break;
            }
            disc.splice(pick.dIdx, 1);
            pl.discard = disc;
            if (pl.destroyedChampions) {
                const hIdx = pl.destroyedChampions.indexOf(pick.ref);
                if (hIdx >= 0)
                    pl.destroyedChampions.splice(hIdx, 1);
            }
            const revived = {
                ...pick.baseDef,
                uid: `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                currentPower: pick.baseDef.power,
                basePower: pick.baseDef.power,
                tapped: false,
                isToken: false,
                frozen: false, frozenTurns: 0, freeAttack: false,
                shielded: false, shieldedTurns: 0, shieldedPermanent: false,
                // C-N5 (offline game_state.gd:4972-4976): o ANTI-MAGOS
                // revivido volta COM a Barreira permanente da Aura.
                barrier: pick.baseDef.onEnter === "auraAntiMagia",
                barrierTurns: 0,
                barrierPermanent: pick.baseDef.onEnter === "auraAntiMagia",
                poisoned: false, poisonTurns: 0, poisonedByP: -1,
                burning: false, burningTurns: 0,
                // C-N6 (offline _reset_champion): mantém o CRESCIMENTO da
                // Força Infinita da instância descartada.
                foreverGrowth: !!pick.ref?.foreverGrowth,
                // C-A14 (offline 1.51.48): o revivido NÃO nasce silenciado e
                // DISPARA a instantânea na (re)invocação — a marca é só para
                // o motor saber que a instantânea ainda não foi usada.
                silenced: false,
                onEnter: pick.baseDef.onEnter ?? null,
                onEnterConsumed: true,
                ressuscitarBorn: true,
            };
            pl.field = pl.field || [];
            pl.field.push(revived);
            // C-A02: o revivido é uma NOVA entrada — se for fonte de INSPIRAR,
            // limpa o bloqueio dos vizinhos dele.
            if (R()?.hasInspirar?.(revived)) R().clearInspirarBrokenForNeighbors?.(state, pIdx, pl.field.length - 1);
            pl.lastDestroyedSummon = null;
            events.push({
                type: "TALENT_RESSUSCITAR",
                playerId: pIdx,
                fieldIdx: pl.field.length - 1,
                cardName: revived.name,
                silenced: !!revived.silenced,
                visual: "resurrect",
            });
            clearActive();
            break;
        }
        case "enfraquecerTalento": {
            let opp = null;
            for (let i = 0; i < (state.playersCount ?? state.players?.length ?? 0); i++) {
                if (i !== pIdx) {
                    opp = i;
                    break;
                }
            }
            if (opp == null) {
                clearActive();
                break;
            }
            const plOpp = state.players[opp];
            const before = plOpp.vp ?? 0;
            plOpp.vp = Math.max(0, before - 1);
            const lost = before - plOpp.vp;
            events.push({
                type: "TALENT_ENFRAQUECER",
                playerId: pIdx,
                targetIdx: opp,
                lost,
                vpAfter: plOpp.vp,
                visual: "enfraquecer",
            });
            clearActive();
            break;
        }
        case "invocarDragaoTalento": {
            const maxField = R()?.LIMITS?.MAX_FIELD ?? 6;
            const field = pl.field || [];
            if (field.length >= maxField) {
                events.push({
                    type: "TALENT_INVOCAR_DRAGAO",
                    playerId: pIdx,
                    fizzled: true,
                    reason: "field_full",
                    visual: "dragon_token_summon",
                });
                clearActive();
                break;
            }
            const data = D();
            const def = data?.babyDragonDef || { name: "FILHOTE DE DRAGÃO", power: 1, category: "champion" };
            const tok = {
                ...def,
                uid: `tok-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
                currentPower: def.power ?? 1,
                basePower: def.power ?? 1,
                tapped: false,
                isToken: true,
                frozen: false, frozenTurns: 0, freeAttack: false,
                shielded: false, shieldedTurns: 0, shieldedPermanent: false,
                barrier: false, barrierTurns: 0, barrierPermanent: false,
                poisoned: false, poisonTurns: 0, poisonedByP: -1,
                burning: false, burningTurns: 0,
                silenced: false,
                onEnter: null,
            };
            field.push(tok);
            pl.field = field;
            events.push({
                type: "TALENT_INVOCAR_DRAGAO",
                playerId: pIdx,
                fieldIdx: field.length - 1,
                cardName: tok.name,
                uid: tok.uid,
                visual: "dragon_token_summon",
            });
            clearActive();
            break;
        }
        default:
            return { ok: false, state, events, error: "NOT_AUTO_TALENT" };
    }
    return { ok: true, state, events };
}
const ON_ENTER_RESOLVE_KEYS = [
    "rapidez", "pesadelo", "desacelerar", "roubar", "bolhas", "trocaInjusta",
    "fortalecer", "devorar", "bolaDeFogo", "assassinar", "necromancia", "imitar",
    "ursificacao", "transformarBichinho", "furia", "guardiao", "auraAntiMagia",
    "fumacaToxica", "raioDuplo", "defensor",
    "rajadaCongelante", "corromper", "mordidaVenenosa", "incendiar", "gritoDeGuerra",
    "invokeDragon", "forja",
    "tecnicasDeCombate", "roletaRussa", "podridao",
    "separar", "prisaoPrismatica",
    "enfraquecer", "energizar", "charme",
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
    ["bloquearAtaque", "protecaoDivina", "cancelarUltimate", "exaustao", "contramagica"].forEach((key) => {
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
    applyPlannedReduction,
    finishRaioDuplo,
    finishChuvaDeCometas,
    discardTalentFromHand,
    applyTalentFromHand,
    applyTalentTarget,
    applyTalentAuto,
    applyTalentDiscard,
    applyPodridaoToEnemyDeck,
    isApodrecidaCard,
    makeApodrecidaInstance,
    swapFieldChamps,
    inferConstantOnDestroy,
    hasRessuscitarTarget,
    restoreChampionFromDef,
    bootstrapResolveRegistry,
};
export function wireEffectsResolveRegistry(effects) {
    bindEffectsRef(effects);
    bootstrapResolveRegistry(effects);
}
export { DfEffectsResolve };
