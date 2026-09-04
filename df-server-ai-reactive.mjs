/**
 * Dragonfall — respostas reativas da IA substituta (MULTIPLAYER apenas).
 *
 * Problema que isto resolve:
 * as cartas de Reação (Bloquear Ataque, Proteção Divina, Cancelar Ultimate) são
 * perguntadas pelo atacante ao cliente do defensor via REACTIVE_*_QUERY. Se o
 * defensor caiu e a IA assumiu o assento, NÃO existe navegador para responder:
 * o atacante fica preso no timeout (10–11s) e o jogo "congela" depois de
 * escolher o alvo. Todas as animações posteriores entram atrasadas.
 *
 * Aqui o servidor responde no lugar do assento sob IA, usando **exatamente** as
 * mesmas heurísticas do modo Jogador vs IA (`df-ai-controller.js`
 * `aiShouldReactiveBlock` / `aiShouldReactiveProtect`), para a IA substituta
 * agir como a IA offline.
 *
 * Escopo: só roda quando `room.aiControlled[seat]` está ativo. Nada aqui toca o
 * modo Jogador vs IA (que resolve tudo no cliente).
 */
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";

/** Tipos de pergunta reativa → tipo de resposta correspondente. */
export const REACTIVE_QUERY_TO_ANSWER = Object.freeze({
  REACTIVE_BLOCK_QUERY: "REACTIVE_BLOCK_ANSWER",
  REACTIVE_PROTECTION_QUERY: "REACTIVE_PROTECTION_ANSWER",
  REACTIVE_CANCEL_QUERY: "REACTIVE_CANCEL_ANSWER",
  REACTIVE_EXHAUSTION_QUERY: "REACTIVE_EXHAUSTION_ANSWER",
  REACTIVE_COUNTER_QUERY: "REACTIVE_COUNTER_ANSWER",
});

/** Efeito de talento exigido na mão para cada pergunta. */
const REQUIRED_TALENT = Object.freeze({
  REACTIVE_BLOCK_QUERY: "bloquearAtaque",
  REACTIVE_PROTECTION_QUERY: "protecaoDivina",
  REACTIVE_CANCEL_QUERY: "cancelarUltimate",
  REACTIVE_EXHAUSTION_QUERY: "exaustao",
  REACTIVE_COUNTER_QUERY: "contramagica",
});

const AI_EXAUSTAO_HIGH_VALUE = new Set([
  "assassinar", "roubar", "charme", "terremoto", "enfraquecer",
  "bolaDeFogo", "necromancia", "transformarBichinho", "roletaRussa",
  "pesadelo", "desacelerar", "devorar", "trocaInjusta", "imitar",
  "corromper", "raioDuplo", "fumacaToxica", "separar", "energizar",
  "maldicaoSeteMares", "prisaoPrismatica", "invokeDragon", "invokeCubicDragon",
]);
const AI_CONTRAMAGICA_HIGH_VALUE = new Set([
  "explosao", "medoTalento", "zeroAbsoluto", "podridaoTalento",
  "chuvaDeCometas", "bolaDeFogoTalento", "doppelganger", "missemagicos",
  "ressuscitarTalento", "tornadoDeFogo", "prisaoPrismaticaTalento",
  "maldicaoSeteMaresTalento", "trocaDeLugar", "arsenalDeGuerra",
  "tecnicasDeCombateTalento", "gritoDeGuerraTalento", "transformarBichinhoTalento",
]);

function handHasTalent(state, seat, effect) {
  const hand = state?.players?.[seat]?.hand;
  if (!Array.isArray(hand)) return false;
  return hand.some((c) => c && c.talentEffect === effect);
}

/**
 * Paridade com `aiShouldReactiveBlock` do cliente (df-ai-controller.js).
 * Só bloqueia quando o defensor morreria no combate e vale a pena.
 */
function aiShouldReactiveBlock(attacker, defender) {
  if (!attacker || !defender) return false;
  let out;
  try {
    const { DfRules } = bootDragonfallEngine();
    out = DfRules.combatOutcome(attacker, defender);
  } catch (e) {
    return false;
  }
  if (!out || !out.killD) return false;
  let valueDef = defender.currentPower ?? defender.power ?? 1;
  if (defender.grows) valueDef += 2;
  if (defender.over) valueDef += 2;
  const attPow = attacker.currentPower ?? attacker.power ?? 1;
  return valueDef >= 2 || attPow >= 3;
}

/** Paridade com `aiShouldReactiveProtect` do cliente. */
function aiShouldReactiveProtect(defender) {
  if (!defender) return false;
  const pow = defender.currentPower ?? defender.power ?? 1;
  if (pow <= 1) return true;
  if (defender.grows) return true;
  if (defender.over) return true;
  return pow >= 2;
}

function findDefender(state, seat, action) {
  const field = state?.players?.[seat]?.field;
  if (!Array.isArray(field)) return null;
  if (action?.defenderUid != null) {
    const byUid = field.find((c) => c && c.uid === action.defenderUid);
    if (byUid) return byUid;
  }
  if (action?.defenderIdx != null && field[action.defenderIdx]) {
    return field[action.defenderIdx];
  }
  if (action?.defenderName) {
    const byName = field.find((c) => c && c.name === action.defenderName);
    if (byName) return byName;
  }
  return null;
}

/**
 * Decide a resposta da IA a uma pergunta reativa.
 * @returns {null | { type: string, payload: object }} `null` quando não se
 * aplica (assento não é IA, tipo desconhecido ou pergunta para outro assento).
 */
export function buildAiReactiveAnswer(room, action, askerSeat, opts = {}) {
  const type = action?.type;
  const answerType = REACTIVE_QUERY_TO_ANSWER[type];
  if (!answerType) return null;

  const defSeat = action?.defenderPlayerId;
  if (defSeat !== 0 && defSeat !== 1) return null;
  // Responde por assento sob IA e também por assento sem socket — na carência
  // de 8s antes da IA assumir também não há ninguém para responder, e o
  // atacante congelaria igual. Humano conectado responde no próprio cliente.
  const aiSeat = !!room?.aiControlled?.[defSeat];
  if (!aiSeat && !opts.seatOffline) return null;

  const state = room.gameState;
  if (!state?.players?.[defSeat]) return null;

  const talent = REQUIRED_TALENT[type];
  let use = false;
  // Sem a carta na mão a resposta é sempre "não" — mas precisa ser enviada,
  // senão o atacante espera o timeout inteiro. Assento apenas offline (sem IA
  // ainda) nunca usa carta: não há decisor.
  if (aiSeat && talent && handHasTalent(state, defSeat, talent)) {
    if (type === "REACTIVE_BLOCK_QUERY") {
      const attacker = state.players?.[askerSeat]?.field?.[action.attackerIdx];
      const defender = state.players?.[defSeat]?.field?.[action.defenderIdx];
      use = aiShouldReactiveBlock(attacker, defender);
    } else if (type === "REACTIVE_PROTECTION_QUERY") {
      use = aiShouldReactiveProtect(findDefender(state, defSeat, action));
    } else if (type === "REACTIVE_CANCEL_QUERY") {
      // A IA offline valoriza muito Cancelar Ultimate (peso 14 no score):
      // tendo a carta, cancela.
      use = true;
    } else if (type === "REACTIVE_EXHAUSTION_QUERY") {
      const onEnter = action?.onEnter || action?.ability || null;
      use = !!(onEnter && AI_EXAUSTAO_HIGH_VALUE.has(onEnter));
    } else if (type === "REACTIVE_COUNTER_QUERY") {
      const te = action?.talentEffect || null;
      use = !!(te && AI_CONTRAMAGICA_HIGH_VALUE.has(te));
    }
  }

  const payload = {
    type: answerType,
    queryFrom: askerSeat,
    use,
    defenderPlayerId: defSeat,
    attOwner: askerSeat,
    serverAiReactive: true,
  };

  if (type === "REACTIVE_BLOCK_QUERY") {
    payload.blocked = use;
    payload.attackerIdx = action.attackerIdx ?? null;
    payload.defenderIdx = action.defenderIdx ?? null;
  } else if (type === "REACTIVE_PROTECTION_QUERY") {
    payload.protected = use;
    const defender = findDefender(state, defSeat, action);
    const idx = defender
      ? state.players[defSeat].field.findIndex((c) => c && c.uid === defender.uid)
      : -1;
    payload.defenderIdx = idx >= 0 ? idx : (action.defenderIdx ?? null);
    payload.defenderName = action.defenderName ?? defender?.name ?? null;
    payload.defenderUid = action.defenderUid ?? defender?.uid ?? null;
  } else if (type === "REACTIVE_CANCEL_QUERY") {
    payload.cancelled = use;
    payload.ultimateName = action.ultimateName ?? null;
  } else if (type === "REACTIVE_EXHAUSTION_QUERY") {
    payload.exhausted = use;
    payload.cancelled = use;
    payload.onEnter = action.onEnter ?? null;
    payload.championName = action.championName ?? null;
    payload.abilityName = action.abilityName ?? null;
  } else if (type === "REACTIVE_COUNTER_QUERY") {
    payload.countered = use;
    payload.cancelled = use;
    payload.talentEffect = action.talentEffect ?? null;
    payload.talentName = action.talentName ?? null;
  }

  return { type: answerType, payload };
}

/**
 * Consome a carta de Reação da mão da IA quando ela responde "sim".
 * Mantém o estado do servidor coerente (a carta não pode ser reusada).
 * @returns {boolean} true se descartou.
 */
export function consumeAiReactiveCard(room, defSeat, queryType) {
  const effect = REQUIRED_TALENT[queryType];
  if (!effect) return false;
  const pl = room?.gameState?.players?.[defSeat];
  if (!pl || !Array.isArray(pl.hand)) return false;
  const idx = pl.hand.findIndex((c) => c && c.talentEffect === effect);
  if (idx < 0) return false;
  const [card] = pl.hand.splice(idx, 1);
  if (!Array.isArray(pl.discard)) pl.discard = [];
  if (card) pl.discard.push(card);
  return true;
}
