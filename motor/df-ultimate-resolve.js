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
    // C-A21: Frosty (1.51.50), Bastion (1.51.53) e Hércules/Diablos (1.51.65)
    // têm 4 usos no offline; a tabela do servidor estava desatualizada (3).
    const four = new Set([
        "vaughan", "linguarudo", "pirate", "euravia",
        "thor", "iceWitch", "ironGuard", "hercules", "diablos",
    ]);
    const three = new Set([
        "princesaSlime", "jekiro", "sangueDragao", "gancho",
        "paladino", "alquimista", "valmont", "tecnomago",
        "quimera", "sinistrela", "estrelar",
        "tristana",
    ]);
    if (four.has(heroId))
        return 4;
    if (three.has(heroId))
        return 3;
    return 4;
}
export function getEffectiveMaxUltimateUses(pl, heroId) {
    return getMaxUltimateUses(heroId) + (pl?.bonusUltimateUses ?? 0);
}
function clone(x) {
    return JSON.parse(JSON.stringify(x));
}
function heroDef(heroId) {
    return data().heroDefs.find((h) => h.id === heroId) || null;
}
function allyCanGainPower(c) {
    // C-A20 (offline game_state.gd:1651,1655): APODRECIDA nunca ganha Poder.
    return !!c && !c.podridao && c.name !== "APODRECIDA" && c.talentEffect !== "apodrecidaDescarte";
}
function isPower1Champ(c) {
    return !!c && (c.currentPower ?? c.power) === 1;
}
/** Tristana (Reutilização): aliado com Instantânea que teria efeito válido se entrasse agora. */
export function canReuseInstant(state, pid, fieldIdx) {
    const c = state.players[pid]?.field?.[fieldIdx];
    if (!c || c.silenced || c.abilityType !== "instant" || !c.onEnter)
        return false;
    const sim = clone(state);
    const sc = sim.players[pid].field[fieldIdx];
    sc.onEnterConsumed = false;
    const used = sim.players[pid].onEnterUsedThisTurn;
    if (Array.isArray(used)) {
        sim.players[pid].onEnterUsedThisTurn = used.filter((k) => k !== sc.onEnter);
    }
    const E = globalThis.DfEffects;
    if (E?.planOnEnter) {
        const plan = E.planOnEnter(sim, pid, fieldIdx) || {};
        return !!plan.ok && plan.mode !== "none" && plan.mode !== "blocked";
    }
    const R = rules();
    const ctx = R.summonContextForPlayer?.(sim, pid) || {};
    return R.canOnEnterResolve ? !!R.canOnEnterResolve(sim, pid, sc, { ...ctx, fieldIdx }).ok : true;
}
// S2-M16 (MEMORY.md 1.51.47 item 6; offline game_state.gd:1401-1404): o próprio
// campeão ENFEITIÇADO no campo adversário nunca é alvo de Ultimate (nem de
// dano, nem de roubo, nem de troca, nem de área). O cliente já filtra na mira
// (ultimate_targets); aqui o servidor rejeita/filtra de verdade.
function isOwnCharmed(champ, pid) {
    return !!champ?.charme && champ.charmeOriginalOwner === pid;
}
function championBanishable(c) {
    // Offline (game_state.gd:1659, mira :2338): Poder ATUAL (com
    // buffs/debuffs), não o impresso.
    return (c?.currentPower ?? c?.power ?? 0) <= 2;
}
function newUid(prefix = "u") {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
function reducePower(champ, amount, opts) {
    const R = rules();
    if (R.reduceChampionPower)
        return R.reduceChampionPower(champ, amount, opts);
    if (!champ)
        return { dissolvedWall: false, blockedByBarrier: false };
    // C-A17 (fallback defensivo, sem o motor ligado): Barreira e apodrecida
    // bloqueiam como no reduceChampionPower central (df-rules.js).
    if (champ.podridao || champ.name === "APODRECIDA" || champ.talentEffect === "apodrecidaDescarte")
        return { dissolvedWall: false, blockedByBarrier: false };
    if (champ.barrier || champ.barrierPermanent || (champ.barrierTurns ?? 0) !== 0)
        return { dissolvedWall: false, blockedByBarrier: true };
    champ.currentPower = Math.max(0, (champ.currentPower ?? 0) - amount);
    return { dissolvedWall: false, blockedByBarrier: false };
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
    // Offline destroy_champion: PV só quando by_pi != owner_pi — a POÇÃO
    // que destrói o próprio aliado e o COMETA nos próprios não dão PV.
    if (killerIdx != null && killerIdx !== ownerIdx && !opts.noVpOnKill && !noHonor) {
        state.players[killerIdx].vp =
            (state.players[killerIdx].vp ?? 0) + 1;
        events.push({ type: "VP_GAIN", playerId: killerIdx, amount: 1, reason: opts.reason || "destroy" });
    }
    const reason = opts.reason || "ultimate";
    const skipLegadoVinganca = rules().suppressesLegadoVinganca?.(reason)
        || reason === "devorar" || reason === "ritualSacrifice";
    if (!skipLegadoVinganca && resolveOnDestroy(target) === "vinganca" && !target.silenced) {
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
                // C-A02: a VINGANÇA reduz fora do turno do dono da vítima.
                const vingBefore = victim.currentPower ?? 0;
                reducePower(victim, 1, { ownerP: pick.p, currentP: state.currentPlayer, preserveWallBuff: state.currentPlayer === pick.p });
                if (victim.currentPower <= 0 && vingBefore > 0) {
                    destroyChampion(state, pick.p, pick.i, null, { noVpOnKill: true }, events, rng);
                }
            }
        }
    }
    if (!skipLegadoVinganca && resolveOnDestroy(target) === "legado" && !target.silenced) {
        const allies = rules().gatherAllyTargets(state, ownerIdx, -1);
        if (allies.length) {
            const pick = allies[Math.floor(rng() * allies.length)];
            const ben = state.players[pick.p]?.field?.[pick.i];
            if (ben && allyCanGainPower(ben))
                ben.currentPower = (ben.currentPower ?? 0) + 1;
        }
    }
    const burst = rules().applyOnDestroyBurst?.(state, ownerIdx, target, reason, rng);
    if (burst?.ability) {
        events.push({
            type: "ON_DESTROY_BURST",
            ownerIdx,
            source: target.name,
            uid: target.uid,
            reason,
            ...burst,
        });
    }
    events.push({ type: "DESTROY", p: ownerIdx, i: fieldIdx, reason, killer: killerIdx });
}
function pickTrickerySwapTarget(state, casterIdx, rng) {
    const pow2 = [];
    for (let ep = 0; ep < (state.playersCount ?? state.players.length); ep++) {
        if (ep === casterIdx)
            continue;
        (state.players[ep]?.field || []).forEach((c, i) => {
            if (c.currentPower === 2)
                pow2.push({ p: ep, i });
        });
    }
    if (!pow2.length)
        return null;
    return pow2[Math.floor(rng() * pow2.length)];
}
function performTrickerySwap(state, casterIdx, allyI, enemyP, enemyI) {
    const a = state.players[casterIdx]?.field?.[allyI];
    const e = state.players[enemyP]?.field?.[enemyI];
    if (!a || !e)
        return;
    // Offline (_swap_champions, game_state.gd:4648-4673): os status
    // viajam no dicionário — nada é limpo. Só cansa e troca o dono.
    // (D2 verificado: TRICKERY_SWAP não emite ON_ENTER_PENDING, então
    // nenhum on-enter re-dispara — sem flag troca_born necessária.)
    a.tapped = true;
    e.tapped = true;
    a.owner = enemyP;
    e.owner = casterIdx;
    const aSlot = a.slot;
    a.slot = e.slot;
    e.slot = aSlot;
    state.players[casterIdx].field[allyI] = e;
    state.players[enemyP].field[enemyI] = a;
}
// C5-02 (decisão dela, 2026-11-17 ~06:04): o Gancho puxa QUALQUER
// campeão de Poder 1 ou 2, com qualquer habilidade/status, INCLUSIVE
// com proteção temporária (PROTEÇÃO do Bastion, shieldedTurns > 0) ou
// permanente (Defensor). Único critério: Poder 1 ou 2. SEM veto de
// escudo — o veto antigo (`shielded && shieldedTurns > 0`) foi
// removido. O sorteio é UNIFORME sobre o pool inteiro — sem
// ponderação por Poder.
function isHookEligible(c, casterIdx) {
    if (!c || isOwnCharmed(c, casterIdx))
        return false;
    if (c.currentPower !== 1 && c.currentPower !== 2)
        return false;
    if (c.podridao || c.name === "APODRECIDA" || c.talentEffect === "apodrecidaDescarte")
        return false;
    return true;
}
function pickHookTarget(state, casterIdx, rng) {
    const pool = [];
    for (let p = 0; p < (state.playersCount ?? state.players.length); p++) {
        if (p === casterIdx)
            continue;
        (state.players[p]?.field || []).forEach((c, i) => {
            if (isHookEligible(c, casterIdx))
                pool.push({ p, i });
        });
    }
    if (!pool.length)
        return null;
    return pool[Math.floor(rng() * pool.length)];
}
function pickPaladinoPower2Discard(state, pIdx, rng) {
    const pl = state.players[pIdx];
    const pool = [];
    (pl.discard || []).forEach((ref) => {
        if (!ref)
            return;
        // Descarte de combate MP às vezes chega sem category — resolve via defs.
        if (ref.category && ref.category !== "champion" && ref.category !== "hidden")
            return;
        let baseDef = data().cardDefs.find((d) => d.name === ref.name);
        if (!baseDef)
            baseDef = data().dragonTokenDef(String(ref.name));
        if (!baseDef || baseDef.category === "talent" || baseDef.category === "reaction")
            return;
        if (baseDef.power !== 2)
            return;
        pool.push({ ref, baseDef });
    });
    if (!pool.length)
        return null;
    // Offline (game_state.gd:1583): o ÚLTIMO P2 do descarte (o mais
    // recentemente descartado), não um sorteio.
    return pool[pool.length - 1];
}
function paladinoRevive(state, pIdx, pick, events) {
    const pl = state.players[pIdx];
    const R = rules();
    if (pl.field.length >= (R.LIMITS?.MAX_FIELD ?? 6))
        return false;
    const dIdx = pl.discard.indexOf(pick.ref);
    if (dIdx >= 0)
        pl.discard.splice(dIdx, 1);
    // Zerar TODOS os status: flag residual (ex.: barrier) vinda do cardDef fazia a
    // Barreira fantasma absorver a Ultimate do Rei Bomba no campeão revivido.
    // C-N5 (offline game_state.gd:1595-1599): o ANTI-MAGOS revivido volta
    // COM a Barreira permanente da Aura Anti-Magia.
    // C-N6 (offline _reset_champion): o revivido mantém o CRESCIMENTO da
    // Força Infinita (a carta vai ao descarte com ult_growth=true).
    const revived = {
        ...pick.baseDef,
        uid: newUid(),
        currentPower: pick.baseDef.power,
        basePower: pick.baseDef.power,
        tapped: false,
        isToken: false,
        frozen: false, frozenTurns: 0, freeAttack: false,
        shielded: false, shieldedTurns: 0, shieldedPermanent: false,
        barrier: pick.baseDef.onEnter === "auraAntiMagia",
        barrierTurns: 0,
        barrierPermanent: pick.baseDef.onEnter === "auraAntiMagia",
        poisoned: false, poisonTurns: 0, poisonedByP: -1,
        burning: false, burningTurns: 0, burningByP: undefined,
        vulnerable: false, wallBuff: false,
        fury: false, furyTurns: 0, furyStacks: 0, furyBonusActive: false,
        tiroDuploUsedThisTurn: false,
        foreverGrowth: !!pick.ref?.foreverGrowth,
        // Offline (_reset_champion, game_state.gd:5052): ressuscitar
        // limpa TODOS os status, incluindo SILÊNCIO. A instantânea
        // não re-dispara por ressuscitar_born (ver D1), não
        // por silêncio — e o revivido volta elegível a REUTILIZAÇÃO.
        // (D1 verificado: paladinoRevive emite SUMMON sem
        // ON_ENTER_PENDING — nenhum on-enter re-dispara.)
        silenced: false,
    };
    pl.field.push(revived);
    // C-A02: o revivido é uma NOVA entrada — se for fonte de INSPIRAR,
    // limpa o bloqueio dos vizinhos dele.
    if (R.hasInspirar?.(revived)) R.clearInspirarBrokenForNeighbors?.(state, pIdx, pl.field.length - 1);
    events.push({ type: "SUMMON", playerId: pIdx, fieldIdx: pl.field.length - 1, card: revived, reason: "paladinoUlt" });
    return true;
}
function drawCardFree(state, pIdx, events) {
    const pl = state.players[pIdx];
    const R = rules();
    const deck = pl.deck;
    // SEM-QUEIMA (2026-11-15 — REVOGA S2-B17): com a mão cheia o saque
    // não acontece — a carta permanece no baralho e nenhum evento DRAW
    // é emitido; a Ultimate continua gasta.
    if (pl.hand.length >= (R.LIMITS.MAX_HAND ?? 8))
        return true;
    const card = deck.pop();
    if (!card)
        return false;
    // C-N9 (offline draw_cards, game_state.gd:728-738): TODO saque marca
    // BOLHAS — inclusive o saque da CONJURAÇÃO.
    if (pl.bolhasActive && card?.category === "champion")
        card.bolhas = true;
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
    const insertIdx = pl.field.length - 1;
    // DRAGON_TOKEN_SUMMON: peer/caster deferem paint até animateDragonSummon (MP).
    events.push({
        type: "DRAGON_TOKEN_SUMMON",
        casterIdx: pIdx,
        playerId: pIdx,
        insertIdx,
        fieldIdx: insertIdx,
        cardName: champ.name,
        uid: champ.uid,
        card: champ,
        visual: "dragon_token_summon",
        reason: "summonDragonUlt",
    });
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
    champ.shieldedPermanent = false;
    champ.silenced = false;
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
    champ.burningByP = undefined;
    champ.fury = false;
    champ.furyTurns = 0;
    champ.furyStacks = 0;
    champ.furyBonusActive = false;
    champ.wallBuff = false;
    champ.foreverGrowth = false;
    // 5ª auditoria A5-03/A5-04/A5-05 (rodada 9): o reset da Ultimate
    // esquecia estes campos que o talento AMEDRONTAR limpa
    // (bounceChampionToHand, df-rules.js) — o re-invocado voltava com
    // INSPIRAR fantasma (poder base−1 ou sem receber de novo),
    // SOBREPUJAR ou a Proteção permanente do DEFENSOR. A `inspiracao`
    // é recalculada pelo recalcInspirar ao entrar em campo.
    champ.inspirarBuff = 0;
    champ.inspiracao = false;
    champ.inspirarBroken = false;
    champ.tecnicasSobrepujar = false;
    champ.tecnicasSobrepujarTurns = 0;
    champ.charme = false;
    champ.charmeTurns = 0;
    champ.charmeOriginalOwner = -1;
    champ.prisaoPrismatica = false;
    champ.desafianteAtivo = false;
    champ.onEnterConsumed = false;
    // Offline (_return_scare, game_state.gd:2933-2942): mão cheia (8)
    // → a carta vai ao DESCARTE do dono (o log diz "exilado", mas o
    // código descarta — de onde pode voltar via Necromancia/Retorno).
    const maxHand = rules().LIMITS?.MAX_HAND ?? 8;
    const exiled = (owner.hand.length ?? 0) >= maxHand;
    if (!exiled) {
        owner.hand.push(champ);
    } else {
        owner.discard = owner.discard || [];
        owner.discard.push(champ);
    }
    events.push({
        type: "SCARE_RETURN", playerId: pIdx, targetP, targetI,
        card: champ.name, exiled,
    });
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
    if ((pl.ultimateUses ?? 0) >= getEffectiveMaxUltimateUses(pl, heroId))
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
            if (isOwnCharmed(state.players[tp].field[ti], pid))
                return { ok: false, code: "OWN_CHARMED" };
            if (ut === "vampirism" && state.players[tp].field[ti].currentPower < 2)
                return { ok: false, code: "INVALID_TARGET" };
            if (ut === "banish" && !championBanishable(state.players[tp].field[ti]))
                return { ok: false, code: "INVALID_TARGET" };
            if (ut === "scareReturn") {
                const t = state.players[tp].field[ti];
                if (t.currentPower > 2)
                    return { ok: false, code: "INVALID_TARGET" };
            }
            // C-A20: o portão é "existe ALGUM aliado" (offline: mf não vazio);
            // se o único aliado for APODRECIDA, o uso é permitido e só o +1
            // fizzle (o apply já tolera allyI indefinido).
            if (ut === "vampirism" && !R.gatherAllyTargets(state, pid, -1, (c) => !!c).length) {
                return { ok: false, code: "NO_ALLY_ABSORBER" };
            }
            break;
        case "incinerate":
            if (tp == null || ti == null)
                return { ok: false, code: "TARGET_REQUIRED" };
            if (tp === pid)
                return { ok: false, code: "BAD_TARGET" };
            if (!state.players[tp]?.field?.[ti])
                return { ok: false, code: "INVALID_TARGET" };
            if (isOwnCharmed(state.players[tp].field[ti], pid))
                return { ok: false, code: "OWN_CHARMED" };
            break;
        case "targetAllyShield":
            if (!field.some((c) => isPower1Champ(c)))
                return { ok: false, code: "NO_POWER1_ALLY" };
            break;
        case "reuseInstant":
            if (tp == null || ti == null)
                return { ok: false, code: "TARGET_REQUIRED" };
            if (tp !== pid)
                return { ok: false, code: "BAD_TARGET" };
            if (!canReuseInstant(state, pid, ti))
                return { ok: false, code: "INVALID_TARGET" };
            break;
        case "targetAlly":
        case "targetAllyFreeAttack":
        case "potion":
            if (tp == null || ti == null)
                return { ok: false, code: "TARGET_REQUIRED" };
            if (tp !== pid)
                return { ok: false, code: "BAD_TARGET" };
            if (!field[ti])
                return { ok: false, code: "INVALID_TARGET" };
            // Offline (game_state.gd:1450, :1470): apodrecida nunca é
            // alvo válido de Ultimate de aliado. (A poção já passa
            // por allyCanGainPower em :546; o FORTALECER não tinha
            // checagem nenhuma. O predicado já exclui apodrecida
            // desde C-A20 — aqui só a checagem explícita do alvo.)
            if (ut === "targetAlly" && !allyCanGainPower(field[ti]))
                return { ok: false, code: "INVALID_TARGET" };
            if (ut === "targetAllyFreeAttack") {
                const t = field[ti];
                // Offline (game_state.gd:1470, mira :2313): a mira só
                // veta apodrecida e CANSADO (tapped, 1.51.47 item 4).
                // URSO PESADO / Pesado Demais / Prisão NÃO são vetos aqui
                // (C-M34); CONGELADO também não (S2-B18 — não
                // reintroduzir).
                if (t.podridao || t.name === "APODRECIDA" || t.talentEffect === "apodrecidaDescarte" || t.tapped)
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
            // SEM-QUEIMA (2026-11-15 — REVOGA S2-B17): sem portão de mão
            // cheia — com a mão cheia o saque não acontece e a Ultimate
            // continua gasta. O drawCardFree abaixo vira no-op.
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
            if (field.length >= (R.LIMITS?.MAX_FIELD ?? 6))
                return { ok: false, code: "FIELD_FULL" };
            if (!R.gatherEnemyTargets(state, pid, (c) => isHookEligible(c, pid)).length) {
                return { ok: false, code: "NO_TARGETS" };
            }
            break;
        case "resurrect":
            if (field.length >= (R.LIMITS?.MAX_FIELD ?? 6))
                return { ok: false, code: "FIELD_FULL" };
            if (!pickPaladinoPower2Discard(state, pid, () => 0))
                return { ok: false, code: "NO_DISCARD_TARGET" };
            break;
        case "infinitePower":
            // Offline (battle_screen.gd:11023-11025): só exige campo
            // não vazio. Com todos já com CRESCIMENTO, o uso é
            // consumido sem efeito (o apply não faz nada de novo).
            if (!field.length)
                return { ok: false, code: "NO_ALLIES" };
            break;
        case "thunderDiscard":
            // Offline (game_state.gd:1411-1414): sem cartas na mão do
            // adversário a Ultimate não pode ser usada (uso preservado).
            // Exige ao menos UM oponente com cartas (o apply descarta
            // de cada oponente com mão não vazia).
            if (!state.players.some((pl2, i) => i !== pid && (pl2.hand?.length ?? 0) > 0))
                return { ok: false, code: "NO_HAND_CARDS" };
            break;
        case "cometStarfall":
            // Offline (battle_screen.gd:11036-11040): sem campeões
            // nos DOIS campos, a Ultimate não pode ser usada (uso
            // preservado — mesma trava da TROVOADA, C-M31).
            if (!state.players.some((pl2) => (pl2.field?.length ?? 0) > 0))
                return { ok: false, code: "NO_TARGETS" };
            break;
        default:
            break;
    }
    return { ok: true, code: "OK" };
}
/**
 * C-A05 (Lote F): espelho de game_state.spend_ultimate_cancelled — gasta
 * o uso SEM aplicar o efeito. Só chamado quando o defensor respondeu SIM
 * à REACTIVE_CANCEL_QUERY (a Ultimate JÁ foi validada antes da suspensão;
 * revalidar aqui é só guarda). Sem stats no servidor (D-1): o evento
 * ULTIMATE_CANCELLED_SPENT é o registro.
 */
export function spendUltimateCancelled(state, action) {
    const check = validateUltimatePlay(state, action);
    if (!check.ok)
        return { ok: false, state, events: [], error: check.code };
    const next = clone(state);
    const pid = (action.playerId ?? state.currentPlayer);
    const pl = next.players[pid];
    pl.ultimateUses = (pl.ultimateUses ?? 0) + 1;
    pl.usedUltimateThisTurn = true;
    const events = [{
            type: "ULTIMATE_CANCELLED_SPENT",
            playerId: pid,
            heroId: action.heroId || pl.heroId,
            ultimateType: (heroDef(action.heroId || pl.heroId) || {}).ultimateType || null,
        }];
    return { ok: true, state: next, events };
}

export function applyUltimatePlay(state, action, rng = Math.random, opts = {}) {
    const check = validateUltimatePlay(state, action);
    if (!check.ok) {
        // C-N4 (offline use_ultimate, game_state.gd:1416): o uso é gasto
        // ANTES do match — com instantânea inválida (ex.: NECROMANCIA
        // com descarte vazio) a REUTILIZAÇÃO resolve sem efeito e o uso
        // é PERDIDO (o ramo offline só loga "descarte vazio"). As demais
        // Ultimates preservam o uso quando a validação falha (TROVOADA /
        // COMETA sem alvo, etc.) — só reuseInstant tem este caminho.
        if (check.code === "INVALID_TARGET") {
            const pid0 = (action.playerId ?? state.currentPlayer);
            const hero0 = heroDef(action.heroId || state.players[pid0]?.heroId);
            if (hero0?.ultimateType === "reuseInstant"
                && action.targetP === pid0
                && state.players[pid0]?.field?.[action.targetI]) {
                const next = clone(state);
                const pl = next.players[pid0];
                pl.ultimateUses = (pl.ultimateUses ?? 0) + 1;
                pl.usedUltimateThisTurn = true;
                const c = next.players[pid0].field[action.targetI];
                return { ok: true, state: next, events: [
                    { type: "ULTIMATE_PLAY", playerId: pid0, ultimateType: "reuseInstant", heroId: action.heroId || pl.heroId },
                    { type: "REUSE_INSTANT_FIZZLE", playerId: pid0, targetP: pid0, targetI: action.targetI,
                        onEnter: c?.onEnter || null, card: c?.name || null, reason: "invalid_instant" },
                ] };
            }
        }
        return { ok: false, state, events: [], error: check.code };
    }
    // C-A06: skipPower = PROTEÇÃO DIVINA cancelou a redução (a Ultimate
    // continua gasta — o gasto já aconteceu no início da função).
    const skipPower = opts.skipPower === true || action.skipPower === true;
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
            const ultBefore = t.currentPower ?? 0;
            // C-A06: com skipPower a redução nem é tentada (a Barreira não
            // é tocada e o alvo não morre — a condição abaixo fica falsa).
            // C-A17: sem skipPower, a Barreira bloqueia e PERMANECE (central).
            if (!skipPower) {
                const ultRes = reducePower(t, 1, { ownerP: tp, currentP: next.currentPlayer });
                if (ultRes?.blockedByBarrier) {
                    events.push({ type: "BARRIER_BLOCKED", targetP: tp, targetI: ti, source: "targetEnemy", visual: "barrier_block" });
                    break;
                }
            }
            if (t.currentPower <= 0 && ultBefore > 0)
                destroyChampion(next, tp, ti, pid, { reason: "ultimate" }, events, rng);
            break;
        }
        case "targetEnemyFreeze": {
            const t = next.players[tp].field[ti];
            t.frozen = true;
            // C-A18 (offline game_state.gd:1447): CONGELAR é sempre 3
            // rodadas — só a Frosty/iceWitch usa targetEnemyFreeze.
            const rounds = 3;
            t.frozenTurns = Math.max(t.frozenTurns ?? 0, rounds);
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
            pl.field.forEach((c, i) => {
                if (!isPower1Champ(c))
                    return;
                c.shielded = true;
                c.shieldedTurns = 1;
                events.push({ type: "SHIELD", targetP: pid, targetI: i });
            });
            break;
        }
        case "incinerate": {
            const t = next.players[tp].field[ti];
            // C-A17: EM CHAMAS não é redução de Poder — a Barreira NÃO impede
            // a aplicação (offline game_state.gd:1741-1742 aplica burn_turns=4
            // sem checar Barreira; ela só bloqueia o -1 de cada tick, via
            // reduceChampionPower central). A mira continua excluindo Barreira
            // no cliente (online_actions.gd:641-645).
            t.burning = true;
            t.burningTurns = 4;
            t.burningByP = pid;
            events.push({ type: "INCINERATE", targetP: tp, targetI: ti, card: t.name, turns: 4, applied: true });
            break;
        }
        case "reuseInstant": {
            const c = pl.field[ti];
            c.onEnterConsumed = false;
            const used = pl.onEnterUsedThisTurn;
            if (Array.isArray(used))
                pl.onEnterUsedThisTurn = used.filter((k) => k !== c.onEnter);
            events.push({ type: "REUSE_INSTANT", targetP: pid, targetI: ti, onEnter: c.onEnter, card: c.name });
            // C-A04 (offline ultReutilizar, 1.51.54 item 3): a instantânea
            // re-dispara como se o aliado tivesse acabado de entrar — o
            // mesmo ON_ENTER_PENDING da invocação. O motor auto-resolve
            // "auto" no mesmo ack (df-authority usa applyActionWithOnEnter
            // para ULTIMATE_*); "target"/"necromancia_pick" ficam
            // pendentes para o cliente escolher, igual ao SUMMON.
            events.push({ type: "ON_ENTER_PENDING", playerId: pid, fieldIdx: ti, onEnter: c.onEnter });
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
                    if (c && !isOwnCharmed(c, pid))
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
                // Offline (game_state.gd:1546): preserva o MAIOR
                // congelamento — um congelado por 3 continua com 3.
                a.frozenTurns = Math.max(a.frozenTurns ?? 0, 2);
                events.push({ type: "FREEZE", targetP: f.p, targetI: f.i, turns: a.frozenTurns, source: "fireAndIce" });
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
                // C-A17: a Barreira bloqueia o -1 e PERMANECE (central).
                const fogoBefore = b.currentPower ?? 0;
                const fogoRes = reducePower(b, 1, { ownerP: bSlot.p, currentP: next.currentPlayer });
                if (fogoRes?.blockedByBarrier) {
                    events.push({
                        type: "FIRE_AND_ICE_BURN",
                        targetP: bSlot.p,
                        targetI: bi,
                        uid: bSlot.uid,
                        blocked: true,
                        source: "fireAndIce",
                    });
                    continue;
                }
                const destroyed = (b.currentPower ?? 0) <= 0 && fogoBefore > 0;
                events.push({
                    type: "FIRE_AND_ICE_BURN",
                    targetP: bSlot.p,
                    targetI: bi,
                    uid: bSlot.uid,
                    destroyed,
                    source: "fireAndIce",
                });
                if (destroyed)
                    destroyChampion(next, bSlot.p, bi, pid, { reason: "fireAndIce" }, events, rng);
            }
            break;
        }
        case "summonDragon":
            summonDragonToken(next, pid, events);
            break;
        case "hook": {
            // Respeita a mira: se tp/ti apontam um alvo elegível, ele
            // vale (offline: o alvo rolado na tela é honrado); senão,
            // sorteio uniforme sobre o pool elegível.
            let stolen = null;
            const aimed = (tp != null && ti != null) ? next.players[tp]?.field?.[ti] : null;
            if (aimed && isHookEligible(aimed, pid) && tp !== pid)
                stolen = { p: tp, i: ti };
            else
                stolen = pickHookTarget(next, pid, rng);
            if (!stolen)
                break;
            if (pl.field.length >= (R.LIMITS?.MAX_FIELD ?? 6))
                break; // defesa em profundidade (a validação já trava)
            const srcField = next.players[stolen.p].field;
            const tgt = srcField[stolen.i];
            srcField.splice(stolen.i, 1);
            tgt.tapped = true;
            pl.field.push(tgt);
            events.push({ type: "HOOK_STEAL", fromP: stolen.p, fromI: stolen.i, toP: pid });
            // U-C04 (offline game_state.gd hook: champion_summoned sem
            // ressuscitar_born): o campeão roubado entra como se fosse
            // invocado — a instantânea re-dispara. Re-arme o consumo e
            // emita o pending (o loop de applyActionWithOnEnter resolve
            // auto no mesmo ack ou deixa pendente p/ o humano, como num
            // SUMMON normal). O RETORNO não faz isto (ressuscitar_born
            // bloqueia a entrada — intocado).
            if (tgt.onEnter) {
                tgt.onEnterConsumed = false;
                events.push({ type: "ON_ENTER_PENDING", playerId: pid, fieldIdx: pl.field.indexOf(tgt), onEnter: tgt.onEnter });
            }
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
            const success = rng() < 0.7;
            if (success) {
                t.currentPower = (t.currentPower ?? 0) + 2;
                events.push({ type: "POTION_SUCCESS", targetP: tp, targetI: ti });
            }
            else {
                // C-A17: a Barreira bloqueia o -1 e PERMANECE (central).
                const pocaoBefore = t.currentPower ?? 0;
                const pocaoRes = reducePower(t, 1, { ownerP: tp, currentP: next.currentPlayer, preserveWallBuff: tp === pid });
                if (pocaoRes?.blockedByBarrier)
                    events.push({ type: "BARRIER_BLOCKED", targetP: tp, targetI: ti, source: "potion", visual: "barrier_block" });
                else if (t.currentPower <= 0 && pocaoBefore > 0)
                    destroyChampion(next, tp, ti, pid, { reason: "potion" }, events, rng);
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
            const vampBefore = enemy.currentPower ?? 0;
            // C-A06: com skipPower, nem -1 no adversário nem +1 no aliado
            // (offline game_state.gd:1638-1643, use_ultimate skip_power).
            // C-A17: sem skipPower, o dreno é bloqueado pela Barreira
            // central (o +1 ao aliado acontece mesmo assim — offline).
            if (!skipPower) {
                const vampRes = reducePower(enemy, 1, { ownerP: tp, currentP: next.currentPlayer });
                // C-A20: o +1 ao aliado acontece MESMO com o dreno
                // bloqueado pela Barreira (offline: só o dreno é bloqueado).
                const ally = pl.field[allyI];
                if (ally)
                    ally.currentPower = (ally.currentPower ?? 0) + 1;
                if (vampRes?.blockedByBarrier)
                    events.push({ type: "BARRIER_BLOCKED", targetP: tp, targetI: ti, source: "vampirism", visual: "barrier_block" });
            }
            if (enemy.currentPower <= 0 && vampBefore > 0)
                destroyChampion(next, tp, ti, pid, { reason: "vampirism" }, events, rng);
            events.push({ type: "VAMPIRISM", targetP: tp, targetI: ti, allyI, powerCancelled: skipPower === true });
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
                    if (isOwnCharmed(c, pid))
                        continue;
                    normalizeChampPower(c);
                    const cometaBefore = c.currentPower ?? 0;
                    // C-A17: a Barreira bloqueia o -1 e PERMANECE (central).
                    const cometaRes = reducePower(c, 1, { ownerP: ep, currentP: next.currentPlayer, preserveWallBuff: ep === pid });
                    if (cometaRes?.blockedByBarrier) {
                        events.push({ type: "BARRIER_BLOCKED", targetP: ep, targetI: i, source: "cometStarfall", visual: "barrier_block" });
                        continue;
                    }
                    if (c.currentPower <= 0 && cometaBefore > 0) {
                        const killer = ep !== pid ? pid : null;
                        destroyChampion(next, ep, i, killer, { reason: "cometStarfall" }, events, rng);
                    }
                }
            }
            events.push({ type: "COMET_STARFALL", playerId: pid });
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
    getEffectiveMaxUltimateUses,
    canReuseInstant,
    validateUltimatePlay,
    applyUltimatePlay,
});
