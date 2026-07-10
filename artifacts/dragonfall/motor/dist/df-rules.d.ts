/** Dragonfall — DfRules (motor TS, Fase 2). */
/** Dragonfall — DfRules (motor TS, Fase 2). */
declare const LIMITS: Readonly<{
    MAX_ACTIONS: 3;
    MAX_FIELD: 6;
    MAX_HAND: 8;
    PASSIVE_VP_PER_TURN_CAP: 2;
    /** @deprecated Use MAX_FIELD — mantido só por compat de tipos. */
    INVOKE_DRAGON_MAX_FIELD: 4;
}>;
declare function championPrintedPower(c: any): any;
declare function championSummonCost(c: any): any;
declare function isOverpower(c: any): boolean;
declare function isResistente(c: any): boolean;
declare function isPesadoDemais(c: any): boolean;
declare function isCrescimentoDragon(c: any): boolean;
declare function onEnterNeedsEnemy(onEnter: any): boolean;
declare function totalEnemyFieldCount(state: any, pIdx: any): number;
declare function gatherEnemyTargets(state: any, casterIdx: any, filterFn: any): any[];
declare function gatherAllyTargets(state: any, casterIdx: any, exclude: any, filter: any): any[];
declare function hasNecromanciaTarget(state: any, pIdx: any): boolean;
declare function hasTrocaInjustaTarget(state: any, pIdx: any): boolean;
declare function hasPesadeloTarget(state: any, casterIdx: any): boolean;
declare function hasRoubarTarget(state: any, casterIdx: any): boolean;
declare function hasDesacelerarTarget(state: any, casterIdx: any): boolean;
declare function hasAssassinarTarget(state: any, casterIdx: any): boolean;
declare function hasTransformarBichinhoTarget(state: any, casterIdx: any): boolean;
declare function gatherImitableAllies(state: any, casterIdx: any, excludeFieldIdx: any): any[];
declare function hasRitualSacrifice(state: any, pIdx: any, reqPow: any): any;
declare function listRitualSacrificeIndices(state: any, pIdx: any, reqPow: any): any[];
/**
 * Contexto padrão para decisões de invocação (IA / simulador).
 * @param {object} state
 * @param {number} pIdx
 */
declare function summonContextForPlayer(state: any, pIdx: any, extra?: {}): {
    passiveBoardFill: boolean;
};
/**
 * Verifica se onEnter teria efeito útil ao invocar agora.
 * @returns {{ ok: boolean, code?: string }}
 */
declare function canOnEnterResolve(state: any, pIdx: any, card: any, ctx: any): {
    ok: boolean;
    code?: undefined;
} | {
    ok: boolean;
    code: string;
};
/** Índice padrão ao inserir no campo (fileira simétrica: centro → esq → dir…). */
declare function defaultSummonInsertIndex(fieldLen: any): number;
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
declare function canSummon(state: any, pIdx: any, handIdx: any, opts?: Record<string, unknown>): {
    ok: boolean;
    code: string;
    ritual: boolean;
    reason?: undefined;
} | {
    ok: boolean;
    code: any;
    reason: string;
    ritual?: undefined;
} | {
    ok: boolean;
    code: string;
    ritual?: undefined;
    reason?: undefined;
};
/** Índices na mão invocáveis agora. */
declare function listSummonableHandIndices(state: any, pIdx: any, opts?: Record<string, unknown>): any[];
/** PV passivo na manutenção (+1 por campeão, cap 2). */
declare function computePassiveVpGain(fieldCount: any, cap?: 2): number;
/** Índice do vencedor ou null. */
declare function findWinnerIndex(state: any): any;
declare function canDraw(state: any, pIdx: any, limits?: typeof LIMITS): {
    ok: boolean;
    code: string;
};
declare function getAttackActionCost(attacker: any, defender: any): number;
declare function canAttackerTargetDefender(attacker: any, defender: any, opts?: Record<string, unknown>): boolean;
/**
 * Pode este atacante atacar este defensor agora?
 */
declare function canAttack(state: any, attOwner: any, attIdx: any, defOwner: any, defIdx: any, opts?: Record<string, unknown>): {
    ok: boolean;
    code: string;
    actionCost?: undefined;
} | {
    ok: boolean;
    code: string;
    actionCost: number;
};
declare function combatOutcome(a: any, d: any): {
    killA: boolean;
    killD: boolean;
    pvTo: string;
    swords: string[];
    over?: undefined;
} | {
    killA: boolean;
    killD: boolean;
    pvTo: string;
    swords: string[];
    over: boolean;
};
/** Lista pares de ataque legais para um jogador. */
declare function listLegalAttacks(state: any, attOwner: any): any[];
declare function findReactiveTalentHandIndex(state: any, pIdx: any, talentEffect: any): any;
declare function canOfferReactiveBlock(state: any, defOwner: any, attOwner: any): {
    ok: boolean;
    code: string;
    handIdx?: undefined;
} | {
    ok: boolean;
    code: string;
    handIdx: any;
};
declare function canOfferReactiveProtection(state: any, defOwner: any, attOwner: any): {
    ok: boolean;
    code: string;
    handIdx?: undefined;
} | {
    ok: boolean;
    code: string;
    handIdx: any;
};
declare function canOfferCancelUltimate(state: any, defOwner: any, attOwner: any): {
    ok: boolean;
    code: string;
    handIdx?: undefined;
} | {
    ok: boolean;
    code: string;
    handIdx: any;
};
/** Legalidade de onEnter para campeão já em campo (ex.: imitar). */
declare function canResolveOnEnter(state: any, pIdx: any, fieldIdx: any, ctx?: Record<string, unknown>): any;
declare function canEndTurn(state: any, pIdx: any): {
    ok: boolean;
    code: string;
};
declare function canBuyCard(state: any, pIdx: any, limits?: typeof LIMITS): {
    ok: boolean;
    code: string;
};
/**
 * Plano puro de manutenção (sem DOM/destruição com efeitos colaterais).
 * @returns {{ passiveVpGain: number, poisonKills: Array<{p,i}>, growth: boolean, expireWallBonus: boolean, clearGuerra: boolean }}
 */
declare function computeMaintenancePlan(state: any, pIdx: any): {
    passiveVpGain: number;
    poisonKills: any[];
    growth: boolean;
    expireWallBonus: boolean;
    clearGuerra: boolean;
};
/**
 * Reduz Poder do campeão. Qualquer redução real dissolve Muralha (`wallBuff`).
 * @returns {{ dissolvedWall: boolean }}
 */
declare function reduceChampionPower(champ: any, amount: any, opts?: Record<string, unknown>): {
    dissolvedWall: boolean;
};
/** Início do turno do dono da Muralha: remove o +1 temporário (só quem tem wallBuff). */
declare function expireWallBonusOnTurnStart(state: any, pIdx: any): void;
/** Fim do turno do dono da Muralha: +1 Poder fora do turno (só aliados com wallBuff). */
declare function applyWallBonusOnTurnEnd(state: any, endingPIdx: any): void;
/**
 * Aplica contadores de manutenção mutáveis no estado (cópia ou ao vivo).
 * Não remove campeões envenenados — use poisonKills do plano.
 */
declare function applyMaintenanceCounters(state: any, pIdx: any): void;
/** Início de turno após manutenção (ações, untap, draw flags). */
declare function applyTurnRefresh(state: any, pIdx: any, limits?: typeof LIMITS): void;
/** Remove campeão do campo → descarte (sem efeitos colaterais de combate). */
declare function discardChampionAt(state: any, pIdx: any, fieldIdx: any): any;
/**
 * Ticks de status no início do turno (congelamento, escudo, fúria, barreira, aura).
 * @returns {{ unfroze: boolean, changed: boolean, logs: string[] }}
 */
declare function applyTurnStartStatusTicks(state: any, pIdx: any): {
    unfroze: boolean;
    changed: boolean;
    logs: any[];
};
/** Devolve campeões puxados ao dono quando o contador zera. */
declare function returnPulledChampions(state: any, pIdx: any): any[];
/**
 * Fase pura de manutenção no início do turno de pIdx.
 * Não compra carta — retorna flags para a view.
 * @returns {{ plan: object, poisonDestroyed: object[], returned: object[], statusLogs: string[], passiveVpGain: number, skipDraw: boolean }}
 */
declare function runTurnMaintenance(state: any, pIdx: any, limits?: typeof LIMITS): {
    plan: {
        passiveVpGain: number;
        poisonKills: any[];
        growth: boolean;
        expireWallBonus: boolean;
        clearGuerra: boolean;
    };
    poisonDestroyed: any[];
    returned: any[];
    statusLogs: any[];
    passiveVpGain: number;
    poisonVpGain: number;
    skipDraw: boolean;
};
/** Lista reativas oferecíveis para defOwner contra attOwner. */
declare function listOfferableReactives(state: any, defOwner: any, attOwner: any): any[];
/**
 * Lista ações legais de alto nível (IA / simulador).
 * @returns {Array<{ type: string, [key: string]: unknown }>}
 */
declare function listLegalActions(state: any, pIdx: any, opts?: Record<string, unknown>): any[];
declare const DfRules: {
    LIMITS: Readonly<{
        MAX_ACTIONS: 3;
        MAX_FIELD: 6;
        MAX_HAND: 8;
        PASSIVE_VP_PER_TURN_CAP: 2;
        /** @deprecated Use MAX_FIELD — mantido só por compat de tipos. */
        INVOKE_DRAGON_MAX_FIELD: 4;
    }>;
    ON_ENTER_NEEDS_ENEMY: readonly string[];
    championPrintedPower: typeof championPrintedPower;
    championSummonCost: typeof championSummonCost;
    isOverpower: typeof isOverpower;
    isResistente: typeof isResistente;
    isPesadoDemais: typeof isPesadoDemais;
    isCrescimentoDragon: typeof isCrescimentoDragon;
    onEnterNeedsEnemy: typeof onEnterNeedsEnemy;
    totalEnemyFieldCount: typeof totalEnemyFieldCount;
    gatherEnemyTargets: typeof gatherEnemyTargets;
    gatherAllyTargets: typeof gatherAllyTargets;
    gatherImitableAllies: typeof gatherImitableAllies;
    hasNecromanciaTarget: typeof hasNecromanciaTarget;
    hasTrocaInjustaTarget: typeof hasTrocaInjustaTarget;
    hasPesadeloTarget: typeof hasPesadeloTarget;
    hasRoubarTarget: typeof hasRoubarTarget;
    hasDesacelerarTarget: typeof hasDesacelerarTarget;
    hasAssassinarTarget: typeof hasAssassinarTarget;
    hasRitualSacrifice: typeof hasRitualSacrifice;
    listRitualSacrificeIndices: typeof listRitualSacrificeIndices;
    hasTransformarBichinhoTarget: typeof hasTransformarBichinhoTarget;
    summonContextForPlayer: typeof summonContextForPlayer;
    defaultSummonInsertIndex: typeof defaultSummonInsertIndex;
    canOnEnterResolve: typeof canOnEnterResolve;
    canSummon: typeof canSummon;
    listSummonableHandIndices: typeof listSummonableHandIndices;
    computePassiveVpGain: typeof computePassiveVpGain;
    findWinnerIndex: typeof findWinnerIndex;
    canDraw: typeof canDraw;
    getAttackActionCost: typeof getAttackActionCost;
    canAttackerTargetDefender: typeof canAttackerTargetDefender;
    canAttack: typeof canAttack;
    combatOutcome: typeof combatOutcome;
    listLegalAttacks: typeof listLegalAttacks;
    REACTIVE_TALENTS: Readonly<{
        BLOCK: "bloquearAtaque";
        PROTECTION: "protecaoDivina";
        CANCEL_ULT: "cancelarUltimate";
    }>;
    findReactiveTalentHandIndex: typeof findReactiveTalentHandIndex;
    canOfferReactiveBlock: typeof canOfferReactiveBlock;
    canOfferReactiveProtection: typeof canOfferReactiveProtection;
    canOfferCancelUltimate: typeof canOfferCancelUltimate;
    canResolveOnEnter: typeof canResolveOnEnter;
    canEndTurn: typeof canEndTurn;
    canBuyCard: typeof canBuyCard;
    computeMaintenancePlan: typeof computeMaintenancePlan;
    reduceChampionPower: typeof reduceChampionPower;
    expireWallBonusOnTurnStart: typeof expireWallBonusOnTurnStart;
    applyWallBonusOnTurnEnd: typeof applyWallBonusOnTurnEnd;
    applyMaintenanceCounters: typeof applyMaintenanceCounters;
    applyTurnRefresh: typeof applyTurnRefresh;
    discardChampionAt: typeof discardChampionAt;
    applyTurnStartStatusTicks: typeof applyTurnStartStatusTicks;
    returnPulledChampions: typeof returnPulledChampions;
    runTurnMaintenance: typeof runTurnMaintenance;
    listOfferableReactives: typeof listOfferableReactives;
    listLegalActions: typeof listLegalActions;
};
export { DfRules };
export type DfRulesApi = typeof DfRules;
