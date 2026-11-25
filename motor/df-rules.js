// @ts-nocheck
/** Dragonfall — DfRules (motor TS, Fase 2). */
/** Dragonfall — DfRules (motor TS, Fase 2). */
const LIMITS = Object.freeze({
    MAX_ACTIONS: 3,
    MAX_FIELD: 6,
    MAX_HAND: 8,
    PASSIVE_VP_PER_TURN_CAP: 2,
    /** Manual §3: invocar dragão usa o mesmo teto de campo (6). */
    INVOKE_DRAGON_MAX_FIELD: 6,
});
/** Invocar dragão/filhote só é bloqueado quando o campo já está no teto (6). */
function invokeDragonBlocked(state, pIdx, card, limits = LIMITS) {
    const p = state.players[pIdx];
    const fcSelf = p?.field?.length ?? 0;
    return fcSelf >= effectiveMaxField(p, limits);
}
/** Exige campeão adversário no campo — NÃO inclui Pesadelo/Roubar/Desacelerar (alvo = jogador). */
const ON_ENTER_NEEDS_ENEMY = Object.freeze([
    "bolaDeFogo", "fumacaToxica", "raioDuplo", "transformarBichinho",
    "assassinar", "trocaInjusta", "rajadaCongelante", "mordidaVenenosa",
    "incendiar", "separar", "prisaoPrismatica", "charme",
]);
const IMITATOR_NAMES = new Set(["WU-KONG", "ENIGMA"]);
function championPrintedPower(c) {
    if (!c)
        return 0;
    return c.basePower ?? c.power ?? 0;
}
/** Iniciativa (Pistoleira Neon): invocação custa 1 ação. */
function hasIniciativa(c) {
    if (!c || c.silenced)
        return false;
    if (c.constantEffect === "iniciativa")
        return true;
    return normalizeAbilityName(c.abilityName) === "iniciativa"
        || normalizeAbilityName(c.mimicAbilityName) === "iniciativa";
}
function championSummonCost(c) {
    // C-M26 (offline 1.51.65): a APODRECIDA custa 1 ação para entrar em campo.
    if (c?.podridao)
        return 1;
    if (hasIniciativa(c))
        return 1;
    return c?.currentPower ?? c?.power ?? 0;
}
/**
 * Custo em ações de uma carta de Talento (manual §9.1): é o Poder impresso.
 * Vários talentos são Custo 0 (Fortalecer, Bola de Fogo, Zero Absoluto,
 * Amedrontar, Barreira, Baforada Venenosa, Aceleração) e portanto podem ser
 * jogados mesmo sem ações restantes.
 */
function talentPlayCost(c) {
    // C-M26: a APODRECIDA custa 1 (o caminho de talento é só fallback
    // defensivo — o cliente a invoca por SUMMON; ver C-M26 no SUMMON).
    if (c?.podridao || c?.name === "APODRECIDA" || c?.talentEffect === "apodrecidaDescarte")
        return 1;
    return c?.currentPower ?? c?.power ?? 0;
}
function isOverpower(c) {
    if (!c)
        return false;
    // C-M18 (offline _is_overpower, game_state.gd:963-970): o Sobrepujar
    // RECEBIDO (Técnicas de Combate) vence empates MESMO silenciado; só
    // o inato ("Sobrepujar") é bloqueado pelo silêncio.
    if (c.tecnicasSobrepujar && (c.tecnicasSobrepujarTurns ?? 0) > 0)
        return true;
    if (c.silenced)
        return false;
    if (c.abilityName === "Sobrepujar")
        return true;
    return false;
}
function isResistente(c) {
    return !!(c && c.abilityName === "Resistente" && !c.silenced);
}
function isPesadoDemais(c) {
    return !!(c && c.abilityName === "Pesado Demais" && !c.silenced);
}
/** C-B21 (offline attack_cost, game_state.gd:975): o FLAG urso_pesado —
 * setado pela ursificação — vale SEMPRE, mesmo silenciado. É o ramo
 * absoluto; isPesadoDemais continua sendo o ramo silêncio-sensível
 * (quem copiou a habilidade sem o flag, ex. IMITAR). */
function isUrsoPesado(c) {
    return !!(c && (c.urso_pesado || c.name === "URSO PESADO"));
}
function hasMuralhaNativa(c) {
    return !!(c && !c.silenced && (c.muralhaNativa || c.constantEffect === "muralha"));
}
function hasDesafiante(c) {
    return !!(c && !c.silenced && (c.constantEffect === "desafiante" || c.abilityName === "Desafiante"));
}
function hasInspirar(c) {
    return !!(c && !c.silenced && (c.constantEffect === "inspirar" || c.abilityName === "Inspirar"));
}
/** C-A02: INSPIRAR — +1 Poder a cada vizinho de uma fonte pronta (não silenciada).
 * Espelho do offline (_recalc_constants): o buff é por fonte adjacente (0–2);
 * APODRECIDA nunca ganha Poder; vizinho com o INSPIRAR quebrado só volta com
 * OUTRA fonte adjacente (ver clearInspirarBrokenForNeighbors). */
function recalcInspirar(state) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let p = 0; p < count; p++) {
        const field = state.players[p]?.field || [];
        field.forEach((c, i) => {
            if (!c)
                return;
            let target = 0;
            const apodrecida = !!(c.podridao || c.name === "APODRECIDA" || c.talentEffect === "apodrecidaDescarte");
            // (1.51.96 item 13a) SILENCIADO não recebe outros status — nem
            // o INSPIRAR do vizinho (espelho do offline _recalc_constants,
            // game_state.gd:2175). A fonte silenciada já não buffa
            // (hasInspirar); aqui é o VIZINHO que não recebe.
            if (!apodrecida && !c.inspirarBroken && !c.silenced) {
                for (const j of [i - 1, i + 1]) {
                    if (j >= 0 && j < field.length && hasInspirar(field[j]))
                        target += 1;
                }
            }
            const cur = c.inspirarBuff ?? 0;
            if (target !== cur) {
                c.currentPower = Math.max(0, (c.currentPower ?? 0) + (target - cur));
                c.inspirarBuff = target;
            }
            c.inspiracao = target > 0;
        });
    }
}
/** C-A02: uma NOVA fonte de INSPIRAR entrando limpa o bloqueio só dos vizinhos
 * DELA (offline _clear_inspirar_broken, na entrada da fonte). */
function clearInspirarBrokenForNeighbors(state, pIdx, fieldIdx) {
    const field = state.players[pIdx]?.field || [];
    for (const j of [fieldIdx - 1, fieldIdx + 1]) {
        const nb = field[j];
        if (nb)
            nb.inspirarBroken = false;
    }
}
function hasPrisaoPrismatica(c) {
    // C-M18 + C-M22 (offline attack_cost, game_state.gd:977-978, e
    // _apply_prisao :3480-3482): a PRISÃO é um status, não uma habilidade —
    // o silenciado NÃO isenta do custo 2 nem do bloqueio vs Resistente.
    return !!(c && c.prisaoPrismatica);
}
function syncWallActive(p) {
    if (!p)
        return;
    p.wallActive = (p.field || []).some((c) => c && c.wallBuff);
}
/** Desafiante: +2 só se o portador for o único Campeão do dono. */
function recalcDesafiante(state) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let p = 0; p < count; p++) {
        const field = state.players[p]?.field || [];
        field.forEach((c) => {
            if (!c)
                return;
            const alone = field.length === 1 && hasDesafiante(c);
            if (alone && !c.desafianteAtivo) {
                c.currentPower = (c.currentPower ?? 0) + 2;
                c.desafianteAtivo = true;
            }
            else if (!alone && c.desafianteAtivo) {
                c.currentPower = Math.max(0, (c.currentPower ?? 0) - 2);
                c.desafianteAtivo = false;
            }
        });
    }
}
function isCrescimentoDragon(c) {
    return !!(c && !c.silenced && c.abilityName === "Crescimento");
}
/** Teto de campo (buracos/Terremoto removidos do jogo). */
function effectiveMaxField(_p, limits = LIMITS) {
    return Math.max(0, limits.MAX_FIELD ?? 6);
}
/**
 * Devolve campeão do campo à mão do dono (paridade Amedrontar: mão cheia → exile).
 * @returns {{ name: string, exiled: boolean }|null}
 */
function bounceChampionToHand(state, ownerP, fieldIdx) {
    const owner = state.players[ownerP];
    const champ = owner?.field?.[fieldIdx];
    if (!champ)
        return null;
    owner.field.splice(fieldIdx, 1);
    delete champ.slot;
    const base = champ.basePower ?? champ.power ?? champ.currentPower ?? 0;
    champ.currentPower = base;
    champ.basePower = base;
    champ.power = base;
    champ.tapped = false;
    champ.frozen = false;
    champ.frozenTurns = 0;
    champ.freeAttack = false;
    champ.shielded = false;
    champ.shieldedTurns = 0;
    champ.shieldedPermanent = false;
    champ.silenced = false;
    champ.charme = false;
    champ.charmeTurns = 0;
    champ.charmeOriginalOwner = -1;
    champ.prisaoPrismatica = false;
    champ.urso_pesado = false;
    champ.desafianteAtivo = false;
    champ.inspirarBuff = 0;
    champ.inspiracao = false;
    champ.inspirarBroken = false;
    champ.poisoned = false;
    champ.poisonTurns = 0;
    champ.poisonedByP = -1;
    champ.vulnerable = false;
    champ.corruptedNoHonor = false;
    champ.barrier = false;
    champ.barrierTurns = 0;
    champ.barrierPermanent = false;
    champ.burning = false;
    champ.burningTurns = 0;
    // S2-B12: o retorno à mão limpa TODOS os status ativos (regra do
    // offline) — o SOBREPUJAR das TÉCNICAS DE COMBATE ficava na carta.
    champ.tecnicasSobrepujar = false;
    champ.tecnicasSobrepujarTurns = 0;
    champ.wallBuff = false;
    champ.wallBuffApplied = false;
    champ.foreverGrowth = false;
    champ.fury = false;
    champ.furyStacks = 0;
    champ.onEnterConsumed = false;
    const maxHand = LIMITS.MAX_HAND ?? 8;
    const exiled = (owner.hand?.length ?? 0) >= maxHand;
    if (!exiled) {
        owner.hand = owner.hand || [];
        owner.hand.push(champ);
    }
    return { name: champ.name, exiled, uid: champ.uid };
}
/** Laço de Sangue: constante de kill em combate (atacante). */
function hasLacoDeSangue(c) {
    return !!(c && !c.silenced && (c.constantEffect === "lacoDeSangue"
        || c.abilityName === "Laço de Sangue"));
}
/**
 * Aplica Laço de Sangue: +1 Poder em aliado aleatório (inclui o matador se ainda em campo).
 * @returns {{ targetI: number, targetName: string }|null}
 */
function applyLacoDeSangue(state, killerP, rng = Math.random, killerUid = null) {
    const field = state.players[killerP]?.field || [];
    // Paridade com _trigger_laco do offline (game_state.gd:3427):
    // a fonte NUNCA é sorteada e uma apodrecida nunca é escolhida.
    const allies = field.filter((c) => c && c.uid !== killerUid && c.name !== "APODRECIDA");
    if (!allies.length)
        return null;
    const pick = allies[Math.floor(rng() * allies.length)];
    const targetI = field.indexOf(pick);
    pick.currentPower = (pick.currentPower ?? 0) + 1;
    return { targetI, targetName: pick.name, targetUid: pick.uid };
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
/** Sem Honra nativo, copiado ou concedido por Corromper.
 * C-B20 (offline _no_vp_on_destroy, game_state.gd:1195-1200): CORROMPIDO
 * é checado PRIMEIRO — corrompido não dá PV mesmo silenciado. O silêncio
 * só desativa o Sem Honra NATIVO/copiado (onDestroy/mimic/nome), que é
 * checado DEPOIS dele. */
function hasNoHonor(champ) {
    if (!champ)
        return false;
    if (champ.corruptedNoHonor)
        return true;
    if (champ.silenced)
        return false;
    if (champ.onDestroy === "noHonor" || champ.mimicOnDestroy === "noHonor")
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
/** Concede cargas acumuláveis de Fúria com uma única duração renovada.
 * C-M04 (offline _apply_furia_now, game_state.gd:3882): fury_turns =
 * maxi(atual, rounds) — reaplicar NUNCA zera nem encurta a duração. */
function grantFuryStacks(champ, amount = 1, rounds = 1) {
    if (!champ || amount <= 0)
        return 0;
    // A-N1/B-N03 (offline _apply_furia_now, game_state.gd:3880-3887):
    // APODRECIDA nunca ganha Poder — o GRITO (habilidade e talento) não
    // dá Fúria a ela.
    if (champ.podridao || champ.name === "APODRECIDA" || champ.talentEffect === "apodrecidaDescarte")
        return 0;
    // (1.51.96 item 13a) SILENCIADO não recebe outros status — nem FÚRIA
    // (espelho do offline _apply_furia_now, game_state.gd:4000). Central:
    // cobre o GRITO (habilidade e talento), a FÚRIA em si e a do LEGADO.
    if (champ.silenced)
        return 0;
    const add = Math.max(0, Math.floor(amount));
    champ.furyStacks = getFuryStacks(champ) + add;
    champ.fury = champ.furyStacks > 0;
    champ.furyTurns = champ.fury ? Math.max(champ.furyTurns ?? 0, rounds) : 0;
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
    // S2-M03 (offline reduce_power, ramo frágil): perder Poder fora do próprio
    // turno zera fury_turns — o status está QUEBRADO (as pilhas restantes perdem
    // o bônus na expiração do próximo início de turno, via expireFuryStacks).
    champ.furyTurns = 0;
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
    "assassinar", "bolaDeFogo", "cometStarfall", "explosao",
    "fireAndIce", "missemagicos", "potion", "raioDuplo", "ultimate",
    "vampirism", "vinganca", "emChamas",
]);
function isCombatOrPowerReductionDestroy(reason) {
    return reason === "combat" || POWER_REDUCTION_DESTROY_REASONS.includes(reason);
}
/** LEGADO/VINGANÇA: nunca em Devorar, Ritual, Ritual Superior (mesmo reason). */
function suppressesLegadoVinganca(reason) {
    // C-M20 (offline: VINGANÇA/LEGADO disparam SEMPRE, inclusive quando
    // o campeão é devorado ou sacrificado no Ritual): nenhuma razão
    // suprime mais. A função fica como ponto de extensão.
    return false;
}
/**
 * Resolve Explosão de Gelo/Venenosa e Retaliação após retirar o portador.
 * Retorna alvos escolhidos sem repetição; não concede PV imediato.
 */
function applyOnDestroyBurst(state, ownerIdx, champ, reason, rng = Math.random, excludeUid = null) {
    if (reason === "podridaoFizzle")
        return { ability: null, targets: [], applied: [] };
    const ability = resolveOnDestroyAbility(champ);
    if (ability !== "explosaoGelo" && ability !== "explosaoVenenosa"
        && ability !== "furiaLegado" && ability !== "vinganca"
        && ability !== "legado")
        return { ability: null, targets: [], applied: [] };
    // LEGADO / VINGANÇA: disparam em qualquer destruição (C-M20 — o
    // ramo de supressão por Devorar/Ritual foi removido; a função
    // suppressesLegadoVinganca agora retorna false sempre).
    // Legado: aliado aleatório ganha +1 Poder permanente (manual §Legado).
    if (ability === "legado") {
        // C-M21: o Legado nunca buffa uma APODRECIDA (não é campeão).
        const allies = gatherAllyTargets(state, ownerIdx, -1, (c) => !(c?.podridao || c?.name === "APODRECIDA" || c?.talentEffect === "apodrecidaDescarte"));
        if (!allies.length)
            return { ability, targets: [], applied: [] };
        const pick = allies[Math.floor(rng() * allies.length)];
        const ben = state.players[pick.p]?.field?.[pick.i];
        if (!ben)
            return { ability, targets: [pick], applied: [] };
        ben.currentPower = (ben.currentPower ?? 0) + 1;
        return {
            ability,
            targets: [pick],
            applied: [{ ...pick, name: ben.name, currentPower: ben.currentPower }],
        };
    }
    if (ability === "explosaoVenenosa" && !isCombatOrPowerReductionDestroy(reason))
        return { ability, targets: [], applied: [] };
    if (ability === "furiaLegado") {
        // C-M21: a Fúria do Legado nunca vai para uma APODRECIDA.
        const targets = gatherAllyTargets(state, ownerIdx, -1, (c) => !(c?.podridao || c?.name === "APODRECIDA" || c?.talentEffect === "apodrecidaDescarte"));
        const applied = [];
        for (const target of targets) {
            const ally = state.players[target.p]?.field?.[target.i];
            if (!ally)
                continue;
            // (1.51.96 item 13a) SILENCIADO não recebe FÚRIA — a guarda
            // central (grantFuryStacks) já barra o ganho; aqui o aliado
            // nem entra na lista `applied` (o evento não pode mentir).
            if (ally.silenced)
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
    if (ability === "vinganca") {
        // D-4 (offline game_state.gd:3061-3065): a VINGANÇA nunca mira
        // apodrecida nem o próprio enfeitiçado (charme do dono).
        // excludeUid: no combate (ATTACK_RESOLVE) o burst da defensora
        // é calculado ANTES do splice do atacante — o atacante que
        // morre no mesmo combate (killA) NÃO pode ser alvo (o offline
        // resolve as duas mortes antes do burst; t_902).
        const pool = gatherEnemyTargets(state, ownerIdx, (c) => !(c?.podridao || c?.name === "APODRECIDA" || c?.talentEffect === "apodrecidaDescarte")
            && !(c?.charme && c.charmeOriginalOwner === ownerIdx)
            && c?.uid !== excludeUid);
        if (!pool.length)
            return { ability, targets: [], applied: [] };
        const pick = pool[Math.floor(rng() * pool.length)];
        const victim = state.players[pick.p]?.field?.[pick.i];
        if (!victim)
            return { ability, targets: [pick], applied: [] };
        // C-A07: NÃO reduz aqui — devolve a redução como pendente; quem
        // chamou (destroyAtField / combate) a enfileira e a autoridade
        // decide: pergunta (defensor com PROTEÇÃO DIVINA) ou aplica na
        // hora (sem a carta — loop do df-reactive-suspend). A remoção
        // do vingador JÁ aconteceu (destroyAtField o tirou do campo
        // antes de chamar o burst — igual ao offline, onde a remoção
        // acontece e só o -1 é cancelável por skip_power). A redução
        // adiada usa destroyAtField (killerP -1: offline grant_vp=false)
        // — diferente do discard direto do caminho antigo: emite
        // DESTROY e encadeia a VINGANÇA da própria vítima.
        return { ability, targets: [pick],
            applied: [],
            pendingReduction: { targetP: pick.p, targetI: pick.i,
                targetUid: victim.uid, targetName: victim.name,
                amount: 1, source: "vinganca",
                sourceLabel: "VINGANÇA",
                reason: "vinganca", killerP: -1 } };
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
    // C-M10 (offline game_state.gd:2219): P1 ATUAL, sem Barreira.
    return gatherEnemyTargets(state, casterIdx, (c) => c.currentPower === 1 && !hasBarrier(c)).length > 0;
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
    // Manual: Imitar pode repetir qualquer habilidade instantânea já usada neste turno
    // (inclui Bolhas, Pesadelo, Desacelerar, Bola de Fogo, etc.).
    return gatherAllyTargets(state, casterIdx, excludeFieldIdx, (c) => {
        if (!(c.onEnter || c.onDestroy || (c.abilityType === "constant" && c.abilityName)))
            return false;
        if (c.onEnter === "imitar" || isImitatorChamp(c) || c.mimico)
            return false;
        // A-N7 (decisão dela 16/11): o SILENCIADO ENTRA no pool — o
        // offline (_apply_imitar/_imitar_copy, game_state.gd:2947-2995)
        // copia o silenciado; só o próprio imitador e o Ritual ficam
        // fora. O juízo de VALOR da IA (imitarUsable, df-ai-hard-brain)
        // continua excluindo o silenciado, igual ao _oe_usable offline.
        // C-M08 (offline _pode_imitar): Ritual / Ritual Superior NÃO são
        // copiáveis (o sacrifício não pode ser imitado).
        if (c.summonRitual || c.abilityName === "Ritual" || c.abilityName === "Ritual Superior"
            || c.mimicAbilityName === "Ritual" || c.mimicAbilityName === "Ritual Superior")
            return false;
        if (c.onEnter === "pesadelo" && !hasPesadeloTarget(state, casterIdx))
            return false;
        if (c.onEnter === "desacelerar" && !hasDesacelerarTarget(state, casterIdx))
            return false;
        // Assassinar sem P1 no oponente: Imitar gastaria a entrada em vão.
        if (c.onEnter === "assassinar" && !hasAssassinarTarget(state, casterIdx))
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
/** Existe alvo P2 inimigo + espaço no campo adversário para Separar. */
function hasSepararTarget(state, pIdx) {
    // C-M07 (offline _pode_separar): o alvo não pode ter INSPIRAR,
    // MURALHA ou FÚRIA, nem ser um enfeitiçado próprio.
    const enemies = gatherEnemyTargets(state, pIdx, (c) => (c.currentPower ?? c.power) === 2
        && !c.inspiracao && !c.wallBuff && !((c.furyStacks ?? 0) > 0)
        && !(c.charme && c.charmeOriginalOwner === pIdx));
    if (!enemies.length)
        return false;
    // O original sai do campo, então sempre cabe ao menos 1 cópia no
    // lugar dele (campo cheio → 1 cópia; com espaço → 2).
    return true;
}
// C-M16 (offline: cada habilidade só mira alvos válidos — o servidor era
// o único guarda e aceitava qualquer índice): validador central de alvo
// de habilidade instantânea. Retorna { ok:true } ou { ok:false, code }.
// `targetP` ausente = campo do invocador (as habilidades de aliado chegam
// só com targetI — o apply do ABILITY_TARGET apaga o targetP delas).
function validateAbilityTarget(state, casterIdx, fieldIdx, targetP, targetI) {
    const caster = state.players[casterIdx]?.field?.[fieldIdx];
    const key = caster?.onEnter;
    if (!key)
        return { ok: true };
    const needsTarget = new Set([
        "bolaDeFogo", "rajadaCongelante", "mordidaVenenosa", "incendiar",
        "transformarBichinho", "assassinar", "prisaoPrismatica",
        "separar", "charme", "trocaInjusta",
        "fortalecer", "devorar", "ursificacao", "corromper", "imitar",
    ]);
    if (targetI == null)
        return needsTarget.has(key) ? { ok: false, code: "NO_TARGET" } : { ok: true };
    const tp = targetP ?? casterIdx;
    const target = state.players[tp]?.field?.[targetI];
    if (!target)
        return { ok: false, code: "NO_TARGET" };
    const isOwnCharmed = !!(target.charme && target.charmeOriginalOwner === casterIdx);
    const isApodrecida = !!(target.podridao || target.name === "APODRECIDA"
        || target.talentEffect === "apodrecidaDescarte");
    const pow = target.currentPower ?? target.power ?? 0;
    const hasBarrier = !!(target.barrier || target.barrierPermanent);
    const isAlly = tp === casterIdx;
    switch (key) {
        case "bolaDeFogo":
        case "incendiar":
        case "transformarBichinho":
            if (isAlly || hasBarrier || isOwnCharmed)
                return { ok: false, code: "INVALID_TARGET" };
            if (key === "transformarBichinho" && pow < 2)
                return { ok: false, code: "NEED_POWER_GE_2" };
            return { ok: true };
        case "rajadaCongelante":
        case "mordidaVenenosa":
            // U-A02 (rodada 3): o offline congela/envenena ATRAVÉS da
            // Barreira — a RAJADA e a MORDIDA são status, não dano direto
            // (Manual §6: a Barreira só dá imunidade a Em Chamas e ao
            // dano). Só aliado/próprio enfeitiçado vetam (espelho da
            // PRISÃO, que também não reduz Poder).
            if (isAlly || isOwnCharmed)
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true };
        case "assassinar":
            if (isAlly || hasBarrier || isOwnCharmed || pow !== 1)
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true };
        case "raioDuplo":
            // Automático: o caso sorteia 2 inimigos sozinho (já filtra
            // Barreira; o enfeitiçado próprio está no campo do invocador,
            // fora do pool inimigo) — não há alvo a validar aqui.
            return { ok: true };
        case "prisaoPrismatica":
            // A Barreira NÃO exclui (a prisão não reduz Poder).
            if (isAlly || isOwnCharmed)
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true };
        case "separar":
            if (isAlly || isOwnCharmed || pow !== 2
                || target.inspiracao || target.wallBuff || (target.furyStacks ?? 0) > 0)
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true };
        case "charme":
        case "trocaInjusta":
            if (isAlly || isOwnCharmed)
                return { ok: false, code: "INVALID_TARGET" };
            if (key === "trocaInjusta" && pow !== 2)
                return { ok: false, code: "ENEMY_MUST_BE_P2" };
            return { ok: true };
        case "fortalecer":
        case "devorar":
            if (!isAlly || isApodrecida)
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true };
        case "ursificacao":
            if (!isAlly || targetI === fieldIdx || target.name === "URSO PESADO" || target.urso_pesado)
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true };
        case "corromper":
            // (1.51.96 item 13a) SILENCIADO não recebe outros status —
            // nem CORROMPER (espelho do offline _status_target_ok e
            // _apply_corromper, game_state.gd:2222/4187).
            if (!isAlly || target.silenced)
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true };
        case "imitar":
            if (!isAlly)
                return { ok: false, code: "INVALID_TARGET" };
            if (!gatherImitableAllies(state, casterIdx, fieldIdx)
                .some(({ i }) => i === targetI))
                return { ok: false, code: "INVALID_TARGET" };
            return { ok: true };
        default:
            return { ok: true };
    }
}
/** Espaço para receber 1 charmed após o invocador estar no campo. */
function hasCharmeSpace(state, pIdx, cardOnField) {
    const p = state.players[pIdx];
    const max = effectiveMaxField(p);
    const len = p?.field?.length ?? 0;
    const afterCaster = cardOnField ? len : len + 1;
    return afterCaster < max;
}
function summonContextForPlayer(state, pIdx, extra = {}) {
    const p = state.players[pIdx];
    const fcSelf = p?.field?.length ?? 0;
    const enemyFc = totalEnemyFieldCount(state, pIdx);
    return {
        passiveBoardFill: enemyFc === 0 && fcSelf < effectiveMaxField(p),
        ...extra,
    };
}
/**
 * Verifica se onEnter teria efeito útil ao invocar agora.
 * @returns {{ ok: boolean, code?: string }}
 */
function canOnEnterResolve(state, pIdx, card, ctx) {
    ctx = ctx || {};
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
    // S2-M14: aliados excluindo o invocador — por identidade (carta já em
    // campo) OU por índice (ctx.fieldIdx — planOnEnter / IMITAR recursivo).
    // Na mão (canSummon) ctx.fieldIdx não existe e o invocador ainda não
    // está no campo: nenhum dos dois filtros exclui nada (correto).
    const alliesExclCaster = (p?.field || []).filter((c, i) => c !== card && i !== (ctx.fieldIdx ?? -1));
    // S2-M14 (tabela offline _oe_usable): foes excluem o próprio enfeitiçado.
    const notOwnCharmed = (c) => !(c.charme && c.charmeOriginalOwner === pIdx);
    if (onEnter === "fortalecer" && fcSelf === 0)
        return { ok: false, code: "NO_ALLY_FORTALECER" };
    // S2-M14 (offline _oe_usable): FORTALECER exige aliado NÃO-APODRECIDO.
    if (onEnter === "fortalecer") {
        if (!alliesExclCaster.some((c) => !(c.podridao || c.name === "APODRECIDA")))
            return { ok: false, code: "NO_ALLY_FORTALECER" };
    }
    // S2-M14 (corrigido Lote F, Correção-motor 2 — t_822): os gates de
    // on-enter espelham o POOL de alvos do offline (_begin_or_resolve_target),
    // NÃO a preferência de escolha da IA (_status_target_ok, que só vale
    // para o auto-pick e volta ao pool inteiro quando todos já têm o status).
    // PROVA offline (probe Godot v2, 15/11, 6/6): MORDIDA abre a mira com
    // todos os inimigos envenenados (resolve renova poison_turns=2, game_state
    // :3996); PRISÃO abre com todos presos (resolve idempotente, :3477);
    // INCENDIAR abre com todos em chamas (resolve renova burn_turns=4, :3630);
    // BOLA fecha com todos com Barreira (pool filtra Barreira). BOLA/RAIO
    // continuam exigindo alvo sem Barreira (RAIO sorteia 2 alvos sem Barreira,
    // :4471). CHARME segue com NO_CHARME_SPACE (probe A/B: mira fecha com
    // campo cheio e abre com espaço — motor já correto, sem mudança).
    if (onEnter === "mordidaVenenosa" || onEnter === "fumacaToxica" || onEnter === "prisaoPrismatica") {
        if (!gatherEnemyTargets(state, pIdx, (c) => notOwnCharmed(c)).length)
            return { ok: false, code: "NO_ENEMY" };
    }
    if (onEnter === "bolaDeFogo" || onEnter === "raioDuplo") {
        if (!gatherEnemyTargets(state, pIdx, (c) => !hasBarrier(c) && notOwnCharmed(c)).length)
            return { ok: false, code: "NO_UNBARRIERED_ENEMY" };
    }
    if (onEnter === "incendiar") {
        if (!gatherEnemyTargets(state, pIdx, (c) => !hasBarrier(c) && notOwnCharmed(c)).length)
            return { ok: false, code: "NO_UNBARRIERED_ENEMY" };
    }
    // S2-M14: ramos que NÃO EXISTIAM no online.
    if (onEnter === "energizar") {
        if ((p?.ultimateUses ?? 0) >= (p?.maxUltimateUses ?? 1) || p?.usedUltimateThisTurn)
            return { ok: false, code: "NO_ULTIMATE" };
    }
    if (onEnter === "corromper") {
        if (!alliesExclCaster.some((c) => !c.corruptedNoHonor && !c.corrupted))
            return { ok: false, code: "NO_UNCORRUPTED_ALLY" };
    }
    // Correção t_931 (Lote F, C-A15): SEM portão para "bolhas" — o offline
    // (_apply_bolhas, game_state.gd:4044) arma incondicionalmente: marca
    // bolhas_active no adversário (vale até para mão vazia — as compras
    // futuras ganham BOLHAS, :736-738) e NÃO há 1× por partida. O portão
    // antigo exigia mão não vazia + "bolhas" fora de onEnterUsedThisTurn,
    // lista nunca resetada por turno → bolhas valia 1× por partida
    // (sondas probe-t931-bolhas*.mjs: 4/1 e 2/3 pré-fix).
    if (onEnter === "enfraquecer") {
        if (!((state.players[1 - pIdx]?.vp ?? 0) > 0))
            return { ok: false, code: "NO_FOE_VP" };
    }
    if (onEnter === "podridao") {
        const foe = state.players[1 - pIdx];
        if (!((foe?.deckCount ?? foe?.deck?.length ?? 0) > 0))
            return { ok: false, code: "EMPTY_FOE_DECK" };
    }
    if (onEnter === "ursificacao") {
        if (!alliesExclCaster.some((c) => c.name !== "URSO PESADO" && !c.urso_pesado))
            return { ok: false, code: "NO_URSIFICACAO" };
    }
    // C-B18: ver acima — DEVORAR come qualquer aliado, inclusive inspirado.
    if (onEnter === "devorar" && otherAllies === 0)
        return { ok: false, code: "NO_DEVOUR_TARGET" };
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
    if (onEnter === "gritoDeGuerra" && otherAllies === 0)
        return { ok: false, code: "NO_ALLY_GRITO_GUERRA" };
    if (onEnter === "tecnicasDeCombate" && otherAllies === 0)
        return { ok: false, code: "NO_ALLY_TECNICAS" };
    if (onEnter === "transformarBichinho" && !hasTransformarBichinhoTarget(state, pIdx)) {
        return { ok: false, code: "NO_TRANSFORM_TARGET" };
    }
    if (onEnter === "imitar") {
        const ex = (ctx && ctx.fieldIdx != null) ? (ctx.fieldIdx | 0) : -1;
        const imitable = gatherImitableAllies(state, pIdx, ex);
        if (imitable.length === 0) {
            return { ok: false, code: "NO_IMITAR_TARGET" };
        }
        // S2-M14 (offline _oe_usable "imitar"): vale quando há um aliado
        // copiável CUJO instant copiado também vale (recursivo), ou sem
        // instant (copiar uma constante vale). gatherImitableAllies já
        // exclui imitar/Ritual (A-N7: o silenciado ENTRA no pool).
        const depth = (ctx && ctx._imitarDepth) || 0;
        const usable = imitable.some(({ i }) => {
            const c = p.field[i];
            const copied = c?.onEnter || "";
            if (!copied) return true;
            if (copied === "imitar" || depth >= 1) return false;
            return canOnEnterResolve(state, pIdx, { onEnter: copied, silenced: false },
                { ...ctx, _imitarDepth: depth + 1 }).ok;
        });
        if (!usable) return { ok: false, code: "NO_IMITAR_TARGET" };
    }
    if (onEnter === "assassinar" && !hasAssassinarTarget(state, pIdx)) {
        return { ok: false, code: "NO_ASSASSINAR" };
    }
    if (onEnter === "necromancia" && !hasNecromanciaTarget(state, pIdx)) {
        return { ok: false, code: "EMPTY_DISCARD" };
    }
    if (onEnter === "roubar" && !hasRoubarTarget(state, pIdx)) {
        return { ok: false, code: "NO_ROUBAR" };
    }
    // A-N9 (offline): PESADELO/DESACELERAR redundante NÃO trava a
    // resolução — o onEnter é CONSUMIDO mesmo sem efeito (a marca vai
    // para onEnterUsedThisTurn e REUTILIZAÇÃO/IMITAR não re-disparam).
    // Os gates NO_PESADELO/NO_DESACELERAR foram removidos daqui: o
    // applyOnEnter marca antes do cheque de redundância e vira no-op.
    // (hasPesadeloTarget/hasDesacelerarTarget continuam como gates de
    // PLANEJAMENTO — gatherImitableAllies e o cérebro — não de resolução.)
    if (onEnter === "invokeDragon" &&
        invokeDragonBlocked(state, pIdx, card, LIMITS)) {
        return { ok: false, code: "FIELD_FULL_DRAGON" };
    }
    if (onEnter === "trocaInjusta" && !hasTrocaInjustaTarget(state, pIdx)) {
        return { ok: false, code: "NO_TROCA_INJUSTA" };
    }
    // C-M12: a URSIFICAÇÃO precisa de OUTRO aliado (ver o ramo acima).
    if (onEnter === "ursificacao" && otherAllies === 0)
        return { ok: false, code: "NO_URSIFICACAO" };
    if (onEnter === "guardiao") {
        if (otherAllies === 0) {
            return { ok: false, code: "NO_GUARDIAO" };
        }
    }
    if (onEnter === "separar" && !hasSepararTarget(state, pIdx)) {
        return { ok: false, code: "NO_SEPARAR_TARGET" };
    }
    if (onEnter === "charme") {
        if (enemyFc === 0)
            return { ok: false, code: "NO_ENEMY" };
        if (!hasCharmeSpace(state, pIdx, cardOnField)) {
            return { ok: false, code: "NO_CHARME_SPACE" };
        }
    }
    // S2-M14 (unificação do passiveBoardFill): o NO_ENEMY final do ramo
    // antigo — nenhum onEnter que exige adversário passa com campo vazio.
    if (enemyFc === 0 && onEnterNeedsEnemy(onEnter))
        return { ok: false, code: "NO_ENEMY" };
    return { ok: true };
}
/** Espaços fixos do campo (0 = esquerda … 5 = direita). */
const FIELD_SLOT_COUNT = 6;
/** Ordem padrão de ocupação: os dois espaços do centro primeiro. */
const SLOT_ORDER_CENTER_OUT = [2, 3, 1, 4, 0, 5];
function isValidFieldSlot(slot) {
    return Number.isInteger(slot) && slot >= 0 && slot < FIELD_SLOT_COUNT;
}
function usedFieldSlots(field) {
    const used = new Set();
    (field || []).forEach((c) => {
        if (c && isValidFieldSlot(c.slot))
            used.add(c.slot);
    });
    return used;
}
/** Espaços livres (ordem esquerda → direita). */
function freeFieldSlots(field) {
    const used = usedFieldSlots(field);
    const out = [];
    for (let s = 0; s < FIELD_SLOT_COUNT; s++) {
        if (!used.has(s))
            out.push(s);
    }
    return out;
}
/** Primeiro espaço livre do centro para fora; -1 se o campo estiver cheio. */
function pickDefaultFieldSlot(field) {
    const used = usedFieldSlots(field);
    for (const s of SLOT_ORDER_CENTER_OUT) {
        if (!used.has(s))
            return s;
    }
    return -1;
}
/**
 * Garante `slot` único e válido em cada campeão, sem reordenar o array.
 * Campeões sem slot (tokens, estado antigo) ocupam um espaço livre entre os
 * vizinhos do array; campo inteiro sem slots é centralizado.
 */
function ensureFieldSlots(field) {
    if (!Array.isArray(field))
        return field;
    const cards = field.filter(Boolean);
    if (!cards.length)
        return field;
    if (cards.every((c) => !isValidFieldSlot(c.slot))) {
        const n = Math.min(cards.length, FIELD_SLOT_COUNT);
        const start = Math.floor((FIELD_SLOT_COUNT - n) / 2);
        cards.forEach((c, k) => {
            c.slot = k < FIELD_SLOT_COUNT ? start + k : -1;
        });
        return field;
    }
    const used = new Set();
    const pending = new Set();
    field.forEach((c, i) => {
        if (!c)
            return;
        if (isValidFieldSlot(c.slot) && !used.has(c.slot))
            used.add(c.slot);
        else
            pending.add(i);
    });
    if (!pending.size)
        return field;
    for (let i = 0; i < field.length; i++) {
        if (!pending.has(i))
            continue;
        const c = field[i];
        let lo = -1;
        for (let j = i - 1; j >= 0; j--) {
            if (field[j] && !pending.has(j) && isValidFieldSlot(field[j].slot)) {
                lo = field[j].slot;
                break;
            }
        }
        let hi = FIELD_SLOT_COUNT;
        for (let j = i + 1; j < field.length; j++) {
            if (field[j] && !pending.has(j) && isValidFieldSlot(field[j].slot)) {
                hi = field[j].slot;
                break;
            }
        }
        let pick = SLOT_ORDER_CENTER_OUT.find((s) => !used.has(s) && s > lo && s < hi);
        if (pick == null)
            pick = SLOT_ORDER_CENTER_OUT.find((s) => !used.has(s));
        c.slot = pick == null ? -1 : pick;
        if (pick != null)
            used.add(pick);
        pending.delete(i);
    }
    return field;
}
/** Índice do array para inserir um campeão no `slot` (array ordenado por slot). */
function insertIndexForSlot(field, slot) {
    const arr = field || [];
    for (let i = 0; i < arr.length; i++) {
        const s = arr[i]?.slot;
        if (isValidFieldSlot(s) && s > slot)
            return i;
    }
    return arr.length;
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
    // C-A09 (offline 1.51.48 item 1): carta com BOLHAS do ritual não pode
    // ser jogada enquanto ritual_bolhas > 0 (decai no início do turno).
    if ((card.ritual_bolhas ?? 0) > 0) {
        return { ok: false, code: "RITUAL_BOLHAS", reason: "Carta com Bolhas do ritual cancelado." };
    }
    // C-M26: a APODRECIDA entra em campo (a instância é "especial", mas o
    // template é "talent" — aceitar pelo flag/nome/efeito).
    if (card.category === "talent"
        && !(card.podridao || card.name === "APODRECIDA" || card.talentEffect === "apodrecidaDescarte")) {
        return { ok: false, code: "NOT_CHAMPION", reason: "Não é campeão." };
    }
    if ((p.field?.length ?? 0) >= effectiveMaxField(p, limits)) {
        return { ok: false, code: "FIELD_FULL", reason: "Campo cheio." };
    }
    const freeAction = !!opts.freeAction;
    // C-B22: Ritual SÓ existe com freeAction (sacrifício). Sem o flag,
    // o apply invocaria sem sacrificar e cobraria o Poder cheio
    // (engine:406,506). O cliente oficial sempre envia freeAction:true.
    if (card.summonRitual && !freeAction) {
        return {
            ok: false,
            code: "RITUAL_REQUIRES_FREE_ACTION",
            reason: "Ritual exige freeAction (sacrifício).",
        };
    }
    if (card.summonRitual && freeAction) {
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
    return !!(attacker && attacker.freeAttack && !isPesadoDemais(attacker) && !hasPrisaoPrismatica(attacker));
}
/** C-M18 (offline can_attack, game_state.gd:1017): a CONSTANTE Investida
 * bloqueia o ataque a Resistente sempre — independente de o ataque livre
 * já ter sido usado. O teste é pela constante, sem portão de silêncio,
 * como no offline (o freeAttack em si é dado só se não silenciado, em
 * applyTurnRefresh). */
function hasInvestida(c) {
    return !!(c && (c.constantEffect === "investida" || c.abilityName === "Investida"));
}
function cannotHitResistente(attacker) {
    return !!(attacker && (attacker.freeAttack || hasInvestida(attacker)));
}
/** Atacante com custo fixo ≥2 (Pesado Demais OU Prisão Prismática). */
function isFixedCostTwo(attacker) {
    return isUrsoPesado(attacker) || isPesadoDemais(attacker) || hasPrisaoPrismatica(attacker);
}
function getAttackActionCost(attacker, defender) {
    // C-B21: o flag vem ANTES do freeAttack (offline :975-976) — um urso
    // silenciado não pode sair de graça pelo attackIsFree abaixo.
    if (isUrsoPesado(attacker))
        return 2;
    // Prisão Prismática: piso fixo 2 — anula Investida/freeAttack.
    if (hasPrisaoPrismatica(attacker))
        return 2;
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
    if (!defender || defender.shielded)
        return false;
    // C-M05 (offline can_attack, game_state.gd:1025-1028): o campeão
    // enfeitiçado não pode ser atacado pelo dono original — ele voltará
    // ao campo dele em breve. (Só o dono pode ser o atacante aqui: o
    // enfeitiçado está no campo adversário.)
    if (defender.charme || (defender.charmeTurns ?? 0) > 0)
        return false;
    if (isFixedCostTwo(attacker) && isResistente(defender))
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
    // C-B24 (offline gs:1009-1011): o contador é a fonte da verdade.
    if (att.tapped || (att.frozenTurns ?? 0) > 0)
        return { ok: false, code: "ATTACKER_EXHAUSTED" };
    if (att.charme)
        return { ok: false, code: "CHARMED" };
    // C-B19 (offline gs:989-1031): can_attack não exige Poder do
    // atacante — a restrição vive no cérebro da IA, não no motor.
    // O default `?? !!isAI` estreitava a lista legal só da IA.
    const requireAttackerPowerGte = opts.requireAttackerPowerGte ?? false;
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
    // Empate mútuo: só o atacante pontua pela destruição do defensor (manual §5.2).
    return { killA: true, killD: true, pvTo: "attacker", swords: ["a", "d"] };
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
        if (att.tapped || (att.frozenTurns ?? 0) > 0 || att.charme)
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
    EXHAUSTION: "exaustao",
    COUNTER: "contramagica",
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
function canOfferExaustao(state, defOwner, attOwner) {
    if (defOwner === attOwner)
        return { ok: false, code: "SAME_PLAYER" };
    const idx = findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.EXHAUSTION);
    if (idx < 0)
        return { ok: false, code: "NO_CARD" };
    return { ok: true, code: "OK", handIdx: idx };
}
function canOfferContramagica(state, defOwner, attOwner) {
    if (defOwner === attOwner)
        return { ok: false, code: "SAME_PLAYER" };
    const idx = findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.COUNTER);
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
    // t_941 (Lote F, C-B17): o invokeDragon com o campo cheio PODE
    // resolver — o caso no applyOnEnter emite FIELD_FULL_DRAGON
    // (espelho do offline: "Campo cheio: não há espaço para
    // FILHOTE DE DRAGÃO"). O guarda canOnEnterResolve continua
    // respondendo FIELD_FULL_DRAGON (smoke-lote-f-06 o exige);
    // só a RESOLUÇÃO é permitida, para o evento existir.
    const leg = (typeof globalThis !== "undefined" && globalThis.DfEffects?.canOnEnter)
        ? globalThis.DfEffects.canOnEnter(state, pIdx, champ, merged)
        : canOnEnterResolve(state, pIdx, champ, merged);
    if (champ?.onEnter === "invokeDragon" && leg && !leg.ok && leg.code === "FIELD_FULL_DRAGON")
        return { ok: true, code: "OK" };
    return leg;
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
 * @returns {{ passiveVpGain: number, poisonKills: Array<{p,i}>, growth: boolean, expireWallBonus: boolean }}
 */
function computeMaintenancePlan(state, pIdx) {
    const p = state.players[pIdx];
    const n = p?.field?.length ?? 0;
    const poisonKills = [];
    for (let ep = 0; ep < (state.playersCount ?? state.players?.length ?? 0); ep++) {
        (state.players[ep]?.field || []).forEach((c, ci) => {
            // C-A22: o veneno ticka no início do turno da VÍTIMA (offline
            // _tick_statuses: poison_turns decai no turno do dono; a 0,
            // destroy_champion com by_pi = poison_by). Antes, a âncora era
            // o turno do envenenador (morte ~1 rodada atrasada).
            if (c.poisoned && ep === pIdx && (c.poisonTurns ?? 0) <= 0) {
                poisonKills.push({ p: ep, i: ci });
            }
        });
    }
    return {
        passiveVpGain: computePassiveVpGain(n),
        poisonKills,
        growth: true,
        expireWallBonus: !!p?.wallActive,
    };
}
/**
 * Reduz Poder do campeão. Redução real dissolve Muralha e consome primeiro
 * a mesma quantidade de cargas de Fúria, preservando o Poder permanente.
 * @returns {{ dissolvedWall: boolean, clearedFury: boolean, furyStacksRemoved: number }}
 */
/** C-A17 — Barreira ativa: temporária (barrierTurns > 0) ou permanente da Aura
 *  Anti-Magia (barrierPermanent; barrierTurns fica 0). Espelho do offline
 *  `barrier_turns != 0` (game_state.gd:1286; -1 = permanente). */
function hasBarrier(champ) {
    return !!champ && (!!champ.barrier || !!champ.barrierPermanent
        || (champ.barrierTurns ?? 0) !== 0);
}

function reduceChampionPower(champ, amount, opts = {}) {
    if (!champ || amount <= 0)
        return { dissolvedWall: false, clearedFury: false, furyStacksRemoved: 0, inspirarAbsorbed: 0, blockedByBarrier: false };
    // C-A17 (offline game_state.gd:1280-1288): apodrecida nunca perde Poder;
    // Barreira BLOQUEIA a redução e PERMANECE (não consome barrierTurns).
    // Ordem igual à do offline: apodrecida -> Barreira -> vulnerável.
    if (champ.podridao || champ.name === "APODRECIDA" || champ.talentEffect === "apodrecidaDescarte")
        return { dissolvedWall: false, clearedFury: false, furyStacksRemoved: 0, inspirarAbsorbed: 0, blockedByBarrier: false };
    if (hasBarrier(champ))
        return { dissolvedWall: false, clearedFury: false, furyStacksRemoved: 0, inspirarAbsorbed: 0, blockedByBarrier: true };
    const prev = champ.currentPower ?? 0;
    let inspirarAbsorbed = 0;
    if (champ.vulnerable) {
        champ.currentPower = 0;
    }
    else {
        // C-A02 (1.51.45 item 3) INSPIRAR frágil: perder Poder FORA do próprio
        // turno tira o status — o buff ABSORVE a perda primeiro (offline
        // reduce_power). Sem ownerP/currentP, não há como saber o turno:
        // o absorb só acontece com o contexto passado (ver call sites).
        if ((champ.inspirarBuff ?? 0) > 0 && opts.ownerP != null && opts.currentP != null && opts.currentP !== opts.ownerP) {
            inspirarAbsorbed = Math.min(amount, champ.inspirarBuff);
            champ.currentPower = Math.max(0, prev - inspirarAbsorbed);
            champ.inspirarBuff -= inspirarAbsorbed;
            champ.inspirarBroken = true;
            champ.inspiracao = false;
            amount -= inspirarAbsorbed;
        }
        champ.currentPower = Math.max(0, (champ.currentPower ?? 0) - amount);
    }
    const powerLost = champ.currentPower < prev;
    // C-M02 (offline reduce_power, game_state.gd:1324-1326): a Muralha só
    // quebra com perda FORA do turno do dono (current != owner_pi). Com
    // ownerP/currentP conhecidos, a condição é central — nenhum call site
    // precisa lembrar dela; preserveWallBuff continua como override
    // explícito (ex.: reduções do próprio turno listadas abaixo).
    // 1.51.102 item 5b: "turno do dono" é o turno de quem INVOCUOU —
    // enfeitiçado, o invocador é o dono original (charmeOriginalOwner);
    // sem Enfeitiço, é o dono do campo — igual a antes.
    const wallOwnerP = (champ.charme && Number.isInteger(champ.charmeOriginalOwner) && champ.charmeOriginalOwner >= 0)
        ? champ.charmeOriginalOwner : opts.ownerP;
    const outsideWallOwnerTurn = wallOwnerP != null && opts.currentP != null && opts.currentP !== wallOwnerP;
    // (FÚRIA frágil abaixo continua no turno do dono do CAMPO — sem mudança.)
    const outsideOwnTurn = opts.ownerP != null && opts.currentP != null
        && opts.currentP !== opts.ownerP;
    const knownTurn = opts.ownerP != null && opts.currentP != null;
    let dissolvedWall = false;
    if (!opts.preserveWallBuff && champ.wallBuff && powerLost && (!knownTurn || outsideWallOwnerTurn)) {
        champ.wallBuff = false;
        champ.wallBuffApplied = false;
        champ.wallBuffSnapshot = null;
        dissolvedWall = true;
    }
    // A Fúria absorve o RESTANTE da perda (offline: depois do INSPIRAR) —
    // `amount` aqui já é o resto pós-absorb; antes usava a perda total.
    // S2-M03 (1.51.56 item 6) FÚRIA frágil: igual ao INSPIRAR — só consome
    // as pilhas (e quebra o status) quando a perda é FORA do próprio turno;
    // no próprio turno, a perda é só Poder (a Fúria fica). Sem ownerP /
    // currentP, não há como saber o turno: sem contexto, NÃO consome
    // (o INSPIRAR faz o mesmo — ver call sites).
    const furyStacksRemoved = powerLost && outsideOwnTurn
        ? consumeFuryStacks(champ, champ.vulnerable ? getFuryStacks(champ) : amount)
        : 0;
    return {
        dissolvedWall,
        clearedFury: furyStacksRemoved > 0 && getFuryStacks(champ) === 0,
        furyStacksRemoved,
        inspirarAbsorbed,
        blockedByBarrier: false,
    };
}
/** 1.51.102 item 5b: a Muralha segue o turno de quem INVOCUOU o campeão —
 * enfeitiçado, o invocador é o dono original (charmeOriginalOwner); sem
 * Enfeitiço, é o dono do campo. Espelho do offline (_recalc_constants). */
function wallSummonerP(c, fieldOwnerP) {
    if (c?.charme && Number.isInteger(c.charmeOriginalOwner) && c.charmeOriginalOwner >= 0)
        return c.charmeOriginalOwner;
    return fieldOwnerP;
}
/** Início do turno de quem invocou a Muralha: remove o +1 temporário (só quem tem wallBuff). */
function expireWallBonusOnTurnStart(state, pIdx) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let ep = 0; ep < count; ep++) {
        const p = state.players[ep];
        (p?.field || []).forEach((c) => {
            // 1.51.102 item 5b: o enfeitiçado expira no turno do INVOCADOR,
            // não no do campo onde está (o campo dele pode ser o outro).
            if (c && c.wallBuff && c.wallBuffApplied && wallSummonerP(c, ep) === pIdx) {
                c.currentPower = Math.max(0, (c.currentPower ?? 0) - 1);
                c.wallBuffApplied = false;
                c.wallBuffSnapshot = null;
            }
        });
        syncWallActive(p);
    }
}
/** Fim do turno de quem invocou a Muralha: +1 Poder fora do turno (aliados com wallBuff + muralhaNativa que regeneram). */
function applyWallBonusOnTurnEnd(state, endingPIdx) {
    const count = state.playersCount ?? state.players?.length ?? 0;
    // Muralha nativa: regenera wallBuff para campeões com constante muralha
    // 1.51.102 item 5b: o "dono" da Muralha é quem INVOCUOU o campeão —
    // enfeitiçado, o invocador é o dono original (charmeOriginalOwner):
    // fora do turno do invocador, o enfeitiçado fica com a Muralha ativa.
    // Sem Enfeitiço, o invocador é o dono do campo — igual a antes.
    for (let ep = 0; ep < count; ep++) {
        (state.players[ep]?.field || []).forEach((c) => {
            if (!c)
                return;
            if (hasMuralhaNativa(c) && !c.wallBuff && wallSummonerP(c, ep) === endingPIdx) {
                c.wallBuff = true;
                c.wallBuffApplied = false;
                c.wallBuffSnapshot = null;
            }
        });
        syncWallActive(state.players[ep]);
    }
    for (let ep = 0; ep < count; ep++) {
        (state.players[ep]?.field || []).forEach((c) => {
            if (c && c.wallBuff && !c.wallBuffApplied && wallSummonerP(c, ep) === endingPIdx) {
                c.currentPower = (c.currentPower ?? 0) + 1;
                c.wallBuffApplied = true;
                c.wallBuffSnapshot = c.currentPower;
            }
        });
    }
}
/**
 * Aplica contadores de manutenção mutáveis no estado (cópia ou ao vivo).
 * Não remove campeões envenenados — use poisonKills do plano.
 */
function applyMaintenanceCounters(state, pIdx) {
    const p = state.players[pIdx];
    const powerChanges = [];
    if (!p)
        return powerChanges;
    (p.field || []).forEach((c, i) => {
        let gained = 0;
        if (isCrescimentoDragon(c)) {
            c.currentPower = (c.currentPower ?? 0) + 1;
            gained += 1;
        }
        if (c.foreverGrowth) {
            c.currentPower = (c.currentPower ?? 0) + 1;
            gained += 1;
        }
        if (gained > 0) {
            powerChanges.push({
                targetP: pIdx,
                targetI: i,
                currentPower: c.currentPower | 0,
                reason: isCrescimentoDragon(c) ? "crescimento" : "foreverGrowth",
            });
        }
        // Congelado / Barreira / Aura / Proteção / tiroDuplo: só em
        // applyTurnStartStatusTicks — evita tick duplo na manutenção.
    });
    // Veneno: decai no início do turno da VÍTIMA (C-A22; offline
    // _tick_statuses roda no turno do dono do campeão).
    {
        (state.players[pIdx]?.field || []).forEach((c) => {
            if (c.poisoned && c.poisonTurns > 0) {
                c.poisonTurns -= 1;
            }
        });
    }
    expireWallBonusOnTurnStart(state, pIdx);
    return powerChanges;
}
/**
 * Em Chamas (Incendiar): no início do turno de QUEM APLICOU a queimadura
 * (burningByP === pIdx), cada campeão em chamas por ele — em QUALQUER campo —
 * perde 1 Poder e o burn_turns decai (offline _tick_burns/_burn_one, 1.51.11;
 * C-A01). São 4 ticks, um por turno do aplicador. Retorna ticks para VFX /
 * destruições (cada entrada carrega o campo dono `p`).
 */
function applyEmChamasTicks(state, pIdx) {
    const ticks = [];
    const destroyed = [];
    const toDestroy = [];
    const count = state.playersCount ?? state.players?.length ?? 0;
    for (let fp = 0; fp < count; fp++) {
        const field = state.players[fp]?.field || [];
        field.forEach((c, i) => {
            if (!c?.burning || (c.burningTurns ?? 0) <= 0)
                return;
            if (c.burningByP !== pIdx)
                return;
            const before = c.currentPower ?? 0;
            const killerP = c.burningByP;
            // Offline (_burn_one): o burn_turns decai ANTES da redução.
            c.burningTurns = Math.max(0, (c.burningTurns ?? 0) - 1);
            if (c.burningTurns <= 0) {
                c.burning = false;
                c.burningTurns = 0;
                c.burningByP = undefined;
            }
            // C-A02: o tick é fora do turno do dono do campeão (o turno é do
            // aplicador) — a perda pode quebrar o INSPIRAR do alvo.
            reduceChampionPower(c, 1, { ownerP: fp, currentP: pIdx, preserveWallBuff: pIdx === fp });
            const after = c.currentPower ?? 0;
            ticks.push({
                p: fp, i, name: c.name, before, after,
                expired: !c.burning,
                killerP,
            });
            if (after <= 0 && before > 0)
                toDestroy.push({ p: fp, i, name: c.name, killerP });
        });
    }
    // Maior índice primeiro dentro de cada campo (a remoção não invalida os demais).
    toDestroy.sort((a, b) => (a.p !== b.p ? a.p - b.p : b.i - a.i));
    for (const k of toDestroy) {
        const ch = discardChampionAt(state, k.p, k.i);
        if (!ch)
            continue;
        const burst = applyOnDestroyBurst(state, k.p, ch, "emChamas");
        let vpGain = 0;
        const killer = (k.killerP != null && k.killerP >= 0) ? state.players[k.killerP] : null;
        // Offline destroy_champion: PV só quando by_pi != owner_pi (a vítima
        // pode ter mudado de lado por CHARME depois de incendiada).
        if (killer && k.killerP !== k.p && !hasNoHonor(ch)) {
            killer.vp = (killer.vp ?? 0) + 1;
            vpGain = 1;
        }
        destroyed.push({ p: k.p, i: k.i, name: k.name, burst, vpGain, killerP: k.killerP });
        ticks.forEach((t) => {
            if (t.p === k.p && t.i > k.i)
                t.i -= 1;
        });
    }
    return { ticks, destroyed };
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
        if ((c.abilityName === "Investida" || c.constantEffect === "investida") && !c.silenced)
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
/** C-A18: CONGELADO ticka no FIM DO TURNO DO DONO (offline _tick_frozen,
 * game_state.gd:1856-1868, chamado por end_turn :701). O contador passa a
 * significar "turnos de ataque negados restantes" — 1 rodada nega 1 turno
 * inteiro. Chamado pelo END_TURN do engine ANTES de trocar o turno. */
function applyTurnEndFrozenTicks(state, pIdx) {
    const p = state.players[pIdx];
    if (!p?.field)
        return [];
    const unfrozen = [];
    p.field.forEach((c, i) => {
        if (c && c.frozenTurns > 0) {
            c.frozenTurns -= 1;
            if (c.frozenTurns <= 0) {
                c.frozen = false;
                c.frozenTurns = 0;
                unfrozen.push({ targetP: pIdx, targetI: i, name: c.name });
            }
        } else if (c && c.frozen && (c.frozenTurns ?? 0) <= 0) {
            // C-B24: flag órfã (sem contador) — limpar p/ não divergir
            // do critério do canAttack.
            c.frozen = false;
            c.frozenTurns = 0;
        }
    });
    return unfrozen;
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
        if (c.barrier && !c.barrierPermanent && c.barrierTurns > 0) {
            c.barrierTurns -= 1;
            if (c.barrierTurns <= 0) {
                c.barrier = false;
                c.barrierTurns = 0;
                changed = true;
                logs.push(`${c.name}: Barreira expirou.`);
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
        if (c.tecnicasSobrepujar && (c.tecnicasSobrepujarTurns ?? 0) > 0) {
            c.tecnicasSobrepujarTurns -= 1;
            if (c.tecnicasSobrepujarTurns <= 0) {
                c.tecnicasSobrepujar = false;
                c.tecnicasSobrepujarTurns = 0;
                changed = true;
                logs.push(`${c.name}: Sobrepujar (Técnicas de Combate) expirou.`);
            }
        }
    });
    if (unfroze)
        logs.push(`${p.name} teve campeões descongelados automaticamente.`);
    return { unfroze, changed, logs };
}
/** Tick Charme: devolve ao dono original após 2 manutenções do controlador. */
function returnCharmedChampions(state, pIdx) {
    const p = state.players[pIdx];
    const returned = [];
    if (!p?.field)
        return returned;
    const stillHere = [];
    for (const c of p.field) {
        if (c?.charme) {
            c.charmeTurns = (c.charmeTurns ?? 0) - 1;
            if (c.charmeTurns <= 0) {
                const ownerIdx = c.charmeOriginalOwner;
                c.charme = false;
                c.charmeTurns = 0;
                c.charmeOriginalOwner = -1;
                if (ownerIdx >= 0 && state.players[ownerIdx]) {
                    const owner = state.players[ownerIdx];
                    const max = effectiveMaxField(owner);
                    if ((owner.field?.length ?? 0) < max) {
                        // C-M05 (offline _return_charmed): volta CANSADO.
                        c.tapped = true;
                        owner.field.push(c);
                        returned.push({ name: c.name, ownerIdx, mode: "field" });
                    }
                    else {
                        // C-M05 (offline _return_charmed): sem espaço no
                        // campo original, o enfeitiçado é DESCARTADO (não
                        // volta à mão — e portanto não re-dispara a
                        // instantânea). Pilha do charmer, como no offline.
                        c.tapped = true;
                        (state.players[pIdx].discard = state.players[pIdx].discard || []).push(c);
                        returned.push({ name: c.name, ownerIdx, mode: "discard" });
                    }
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
// SEM-QUEIMA (2026-11-15 — REVOGA C-M13/C-M14/C-M15): a carta comprada
// com a mão cheia NÃO queima mais — o saque simplesmente não acontece:
// a carta permanece no baralho e nada vai para o descarte. Retorna
// { card, burned: false } na compra normal, ou null sem deck / com a
// mão cheia (≥ MAX_HAND). O saque PAGO (DRAW_CARD) continua bloqueado
// com a mão cheia (offline can_manual_draw).
function drawCardWithBurn(state, pIdx) {
    const p = state.players[pIdx];
    if (!p)
        return null;
    const deck = p.deck || [];
    if (!deck.length)
        return null;
    const maxHand = LIMITS?.MAX_HAND ?? 8;
    p.hand = p.hand || [];
    if (p.hand.length >= maxHand)
        return null;
    const card = deck.pop();
    p.hand.push(card);
    return { card, burned: false };
}
// C-M26 (offline: a APODRECIDA comprada/invocada some ~3 s após entrar em
// campo): varredura de expiração — o servidor não tem tick periódico, então
// roda no início de cada ação (applyAction). Remove as expiradas para o
// descarte (sem PV, sem gatilhos) e emite APODRECIDA_EXPIRED.
function expireApodrecidas(state, now = Date.now()) {
    const events = [];
    (state.players || []).forEach((p, pIdx) => {
        const field = p?.field || [];
        for (let i = field.length - 1; i >= 0; i--) {
            const c = field[i];
            if (!c || !c.podridao)
                continue;
            if (!c.apodrecidaExpiresAt || c.apodrecidaExpiresAt > now)
                continue;
            field.splice(i, 1);
            p.discard = p.discard || [];
            p.discard.push(c);
            events.push({
                type: "APODRECIDA_EXPIRED",
                playerId: pIdx, fieldIdx: i,
                cardName: c.name, visual: "apodrecida_discard",
            });
        }
    });
    return events;
}
function runTurnMaintenance(state, pIdx, limits = LIMITS) {
    const status = applyTurnStartStatusTicks(state, pIdx);
    const powerChanges = applyMaintenanceCounters(state, pIdx) || [];
    const plan = computeMaintenancePlan(state, pIdx);
    // C-A09 (offline start_turn, 1.51.48 item 1): BOLHAS do ritual decai no
    // início do turno do dono (1 por turno; zerando, a carta volta a poder
    // ser jogada). O estado do END_TURN é FORCE-FULL — o cliente recebe a
    // mão atualizada sem evento próprio.
    let ritualBolhasDecayed = 0;
    for (const c of (state.players[pIdx]?.hand || [])) {
        if (c && (c.ritual_bolhas ?? 0) > 0) {
            c.ritual_bolhas = (c.ritual_bolhas ?? 0) - 1;
            ritualBolhasDecayed += 1;
        }
    }
    const poisonDestroyed = [];
    let poisonVpGain = 0;
    let poisonKillerP = -1;
    const kills = [...plan.poisonKills].sort((a, b) => (a.p !== b.p ? a.p - b.p : b.i - a.i));
    for (const k of kills) {
        const ch = discardChampionAt(state, k.p, k.i);
        if (ch) {
            const burst = applyOnDestroyBurst(state, k.p, ch, "poison");
            // C-A22: o PV vai para o ENVENENADOR (poisonedByP), não para o
            // jogador do turno (a vítima); SEM HONRA nunca dá PV (offline
            // destroy_champion, by_pi = poison_by, grant_vp=true).
            const killerP = ch.poisonedByP ?? -1;
            poisonDestroyed.push({ ...k, name: ch.name, burst, killerP });
            if (killerP >= 0 && killerP !== k.p && !hasNoHonor(ch)) {
                state.players[killerP].vp = (state.players[killerP].vp ?? 0) + 1;
                poisonVpGain += 1;
                poisonKillerP = killerP;
            }
        }
    }
    const p = state.players[pIdx];
    if (plan.passiveVpGain > 0)
        p.vp += plan.passiveVpGain;
    const returned = []; // C-B23: `pulled` removido (nunca setado) — retorno sempre vazio.
    const charmedReturned = returnCharmedChampions(state, pIdx);
    const skipDraw = !!p.skipDraw;
    if (p.skipDraw)
        p.skipDraw = false;
    // C-A01: Em Chamas ticka no início do turno do APLICADOR, depois do veneno
    // e dos retornos (offline: _tick_statuses → _tick_charms → _tick_burns).
    // Os índices dos ticks já são os finais do campo.
    const burn = applyEmChamasTicks(state, pIdx);
    const burnVpGain = burn.destroyed.reduce((s, d) => s + (d.vpGain || 0), 0);
    applyTurnRefresh(state, pIdx, limits);
    return {
        plan,
        poisonDestroyed,
        returned,
        charmedReturned,
        holesExpired: 0,
        statusLogs: status.logs,
        passiveVpGain: plan.passiveVpGain,
        poisonVpGain,
        poisonKillerP,
        burnTicks: burn.ticks,
        burnDestroyed: burn.destroyed,
        burnVpGain,
        ritualBolhasDecayed,
        skipDraw,
        powerChanges,
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
    if (canOfferExaustao(state, defOwner, attOwner).ok) {
        out.push({ effect: REACTIVE_TALENTS.EXHAUSTION, handIdx: findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.EXHAUSTION) });
    }
    if (canOfferContramagica(state, defOwner, attOwner).ok) {
        out.push({ effect: REACTIVE_TALENTS.COUNTER, handIdx: findReactiveTalentHandIndex(state, defOwner, REACTIVE_TALENTS.COUNTER) });
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
    // Correção t_942 (Lote F): ritual com sacrifício válido É ação legal.
    // canSummon recusa ritual sem freeAction (C-B22, :1052), então o
    // ritual nunca entrava na lista acima e o attach de freeAction +
    // sacrifício em df-server-ai.mjs:478 era dead code (a IA nunca
    // invocava o ÔMEGA — probe-t942-ritual-ai.mjs: 3/1 pré-fix). O humano
    // invoca ritual como ação livre + sacrifício; a lista legal da IA
    // deve incluir o mesmo. O executor (C-B22) anexa freeAction +
    // sacrificeIdx antes do apply; aqui só listamos o handIdx.
    (state.players[pIdx]?.hand || []).forEach((card, handIdx) => {
        if (!card?.summonRitual)
            return;
        // canSummon com freeAction cobre os demais portões (partida ativa,
        // turno, campo cheio, ritual_bolhas); o sacrifício é o portão que
        // ele NÃO checa — exigido aqui.
        if (!hasRitualSacrifice(state, pIdx, card.summonRitual))
            return;
        if (canSummon(state, pIdx, handIdx, { ...summonOpts, freeAction: true }).ok)
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
    talentPlayCost,
    hasIniciativa,
    isOverpower,
    hasInvestida,
    isResistente,
    isPesadoDemais,
    isUrsoPesado,
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
    suppressesLegadoVinganca,
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
    FIELD_SLOT_COUNT,
    SLOT_ORDER_CENTER_OUT,
    isValidFieldSlot,
    freeFieldSlots,
    pickDefaultFieldSlot,
    ensureFieldSlots,
    insertIndexForSlot,
    canOnEnterResolve,
    validateAbilityTarget,
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
    canOfferExaustao,
    canOfferContramagica,
    canResolveOnEnter,
    canEndTurn,
    canBuyCard,
    computeMaintenancePlan,
    reduceChampionPower,
    hasBarrier,
    expireWallBonusOnTurnStart,
    applyWallBonusOnTurnEnd,
    applyMaintenanceCounters,
    applyEmChamasTicks,
    applyTurnRefresh,
    discardChampionAt,
    applyTurnStartStatusTicks,
    applyTurnEndFrozenTicks,
    returnCharmedChampions,
    runTurnMaintenance,
    drawCardWithBurn,
    expireApodrecidas,
    listOfferableReactives,
    listLegalActions,
    hasMuralhaNativa,
    hasPrisaoPrismatica,
    hasDesafiante,
    hasInspirar,
    recalcInspirar,
    clearInspirarBrokenForNeighbors,
    cannotHitResistente,
    isFixedCostTwo,
    syncWallActive,
    hasSepararTarget,
    hasCharmeSpace,
    recalcDesafiante,
    effectiveMaxField,
    bounceChampionToHand,
    hasLacoDeSangue,
    applyLacoDeSangue,
};
export { DfRules };
