/**
 * Dragonfall — planejador da IA forte, portado para JS (Tarefa 9, porte JS).
 *
 * Porte de scripts/ai_planner.gd (GDScript, Tarefas 4–7) sobre o motor do
 * servidor (motor/df-engine.js + df-ai-hard-brain.mjs). Mesmo comportamento:
 * plan() com busca em feixe de até 3 jogadas (4 melhores estados por nível,
 * teto de 200 cópias), evaluate2(), tabela COMBOS, guardValue() e react().
 *
 * RE-PORTE 1.51.99 (2026-11-24): planejador final com o livro de
 * estratégia (52 regras), trava do Rei Bomba ABERTA e 1ª carta valendo
 * 2,5 — md5 da fonte c3e3d80fa3b9e7dc8308d22e2136fd95. O porte espelha o
 * planejador como ele é, defeitos incluídos (ver README-PORTE-PLANEJADOR).
 *
 * Vive na CÓPIA scratch_ai2_server — nunca no servidor ao vivo.
 * A substituta não vê a mão nem o baralho do humano: só campo, PV, mão e
 * baralho próprios entram na conta (o "next" de react() só existe nos testes).
 *
 * Diferenças inevitáveis do GDScript (registradas no plano, Tarefa 9):
 * - Candidatos a talento vêm de listTalentPlays (cérebro, com alvo) mais
 *   os talentos AUTO legais pelo motor; um talento COM MIRA que o cérebro
 *   não lista não entra no feixe (o GDScript usava o alvo automático do
 *   motor, que o servidor não tem).
 * - Candidato a Ultimate é a ação concreta de pickUltimate (com alvo);
 *   o GDScript usava use_ultimate com alvo automático.
 * - Pré-condições de instantânea (_onEnterUsable) seguem a tabela do
 *   GDScript (ai_brain.gd _oe_usable), traduzida para os nomes de campo JS.
 * - O feixe trata suspensão do motor (RAIO/CHUVA/VINGANÇA) aplicando as
 *   reduções sem pergunta de Proteção — igual ao simulador GDScript, que
 *   não intercepta Proteção contra reduções.
 * - O motor JS não guarda histórico de cartas jogadas (play_history):
 *   _usedReduction lê state.playHistory quando existe e vale falso sem ele.
 * - Pilhas de Podridão: JS chama de podridaoHits (GDScript podridao_stacks).
 */
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import {
  listTalentPlays,
  pickUltimate,
  championSummonCost,
} from "./df-ai-hard-brain.mjs";
import { getEffectiveMaxUltimateUses } from "./motor/df-ultimate-resolve.js";

const { DfEngine, DfRules, DfEffects } = bootDragonfallEngine();

export const MAX_CLONES = 200;
export const BEAM_WIDTH = 4;
export const BEAM_DEPTH = 3;
export const MAX_CANDIDATES = 16;
export const WIN_SCORE = 1000.0;
export const REACT_RESERVE = 5.0;

export const COMBOS = {
  rajadaCongelante: { follow: "zeroAbsoluto", bonus: 8.0 },
  zeroAbsoluto: { follow: "congelado", bonus: 8.0 },
  fortalecer: { follow: "abate", bonus: 5.0 },
  gritoDeGuerra: { follow: "abate", bonus: 5.0 },
  tecnicasDeCombate: { follow: "abate", bonus: 5.0 },
  forja: { follow: "cadeia", bonus: 4.0 },
  rapidez: { follow: "cadeia", bonus: 3.0 },
  aceleracao: { follow: "cadeia", bonus: 3.0 },
  arsenalDeGuerra: { follow: "cadeia", bonus: 4.0 },
  necromancia: { follow: "retorno", bonus: 3.0 },
  ressuscitarTalento: { follow: "retorno", bonus: 3.0 },
  // (Correção 1.51.97) preparar → abater: o Grito e a INVESTIDA
  // só valem com o abate depois (portão duro na geração de
  // candidatas); o bônus faz o feixe preferir o talento ao
  // ataque direto, que empataria no placar e gastaria o aliado.
  gritoDeGuerraTalento: { follow: "abate", bonus: 5.0 },
  investidaTalento: { follow: "abate", bonus: 5.0 },
  // (Escola Grupo 6) O bônus tem que alcançar os talentos
  // Fortalecer e Técnicas de Combate — as chaves eram só das
  // habilidades de campeão, e o talento não ganhava nada.
  fortalecerTalento: { follow: "abate", bonus: 5.0 },
  tecnicasDeCombateTalento: { follow: "abate", bonus: 5.0 },
};

// Talentos sem mira (resolvem com TALENT_AUTO) — espelho dos conjuntos
// TALENT_AUTO_EFFECTS de df-server-ai.mjs.
const TALENT_AUTO_EFFECTS = new Set([
  "arsenalDeGuerra", "gritoDeGuerraTalento", "tecnicasDeCombateTalento",
  "podridaoTalento", "barreira", "bolhasTalento", "aceleracao",
  "missemagicos", "desacelerarTalento", "chuvaDeCometas",
  "ressuscitarTalento", "enfraquecerTalento", "invocarDragaoTalento",
  "apodrecidaDescarte",
]);

const STATUS_EFFECTS = new Set([
  "mordidaVenenosa", "rajadaCongelante", "incendiar", "prisaoPrismatica",
  "baforadaVenenosa", "tornadoDeFogo", "prisaoPrismaticaTalento",
  "zeroAbsoluto", "targetEnemyFreeze", "incinerate",
]);

let _clonesUsed = 0;

// ------------------------------------------------------------------
// Leituras de campo (nomes JS do motor; mesmos valores do GDScript)
// ------------------------------------------------------------------
export function powerOf(c) {
  return c ? (c.currentPower ?? c.power ?? 0) : 0;
}
function hasBarrier(c) {
  return !!c && ((c.barrierTurns ?? 0) > 0 || !!c.barrierPermanent);
}
function isApodrecida(c) {
  return !!c && !!(c.podridao || c.name === "APODRECIDA");
}
function isOwnCharmed(c, pi) {
  return !!c && !!(c.charme && c.charmeOriginalOwner === pi);
}
function foesOf(state, pi) {
  return (state.players[1 - pi]?.field || []).filter((c) => c && !isOwnCharmed(c, pi));
}
function fieldPower(pl) {
  return (pl?.field || []).reduce((s, c) => s + powerOf(c), 0);
}
function isOverpower(c) {
  if (!c || c.silenced) return false;
  return c.abilityName === "Sobrepujar" || (c.tecnicasTurns ?? 0) > 0 || !!c.tecnicasSobrepujar;
}
function noVpOnDestroy(c) {
  if (!c) return false;
  if (c.corruptedNoHonor || c.corrupted) return true;
  if (c.silenced) return false;
  return c.onDestroy === "noHonor" || c.abilityName === "Sem Honra";
}
function statusedSet(state) {
  if (state.aiStatusedUids instanceof Set) return state.aiStatusedUids;
  return new Set(Array.isArray(state.aiStatusedUids) ? state.aiStatusedUids : []);
}
function bolhasSet(state) {
  if (state.aiBolhasPesadeloUsed instanceof Set) return state.aiBolhasPesadeloUsed;
  return new Set(Array.isArray(state.aiBolhasPesadeloUsed) ? state.aiBolhasPesadeloUsed : []);
}

// ------------------------------------------------------------------
// Leituras de campo da 1.51.99 (nomes JS para os campos do GDScript)
// ------------------------------------------------------------------
/** GDScript `constant` ("investida", "muralha", "desafiante", ...) — no
 * motor JS vive em constantEffect (com `constant` como reserva). */
function constOf(c) {
  return String(c?.constantEffect ?? c?.constant ?? "");
}
/** GDScript `shield_turns != 0` — no JS, o booleano shielded (ou os
 * turnos / permanente). */
function hasShield(c) {
  return !!c && (!!c.shielded || !!c.shieldedPermanent || (c.shieldedTurns ?? 0) !== 0);
}
/** GDScript `charm_turns > 0`. */
function hasCharm(c) {
  return !!c && (!!c.charme || (c.charmTurns ?? 0) > 0);
}
function frozenTurns(c) {
  return (c?.frozenTurns ?? (c?.frozen ? 1 : 0));
}
function poisonTurns(c) {
  return (c?.poisonTurns ?? (c?.poisoned ? 1 : 0));
}
function burnTurns(c) {
  return (c?.burningTurns ?? (c?.burning ? 1 : 0));
}
/** GDScript `state._is_resistente` — DfRules.isResistente, com reserva local. */
function isResistente(c) {
  try {
    if (typeof DfRules.isResistente === "function") return !!DfRules.isResistente(c);
  } catch { /* cai na reserva local */ }
  return !!c && c.abilityName === "Resistente" && !c.silenced;
}
/** GDScript `hero.ultimateType` — no JS, heroDef (com reservas). */
function heroUltType(pl) {
  return String(pl?.heroDef?.ultimateType || pl?.hero?.ultimateType || pl?.ultimateType || "");
}
/** GDScript `podridao_stacks` — no JS o contador chama-se podridaoHits. */
function podridaoStacksOf(pl) {
  return (pl?.podridaoHits ?? pl?.podridaoStacks ?? 0);
}
/** GDScript `turn_number`. */
function turnNumberOf(state) {
  return (state?.turnNumber ?? state?.turn_number ?? 1);
}
/** GDScript `play_history` — o motor JS não guarda histórico de cartas
 * jogadas; lê quando existe (testes futuros) e vale vazio sem ele. */
function playHistoryOf(state) {
  return state?.playHistory ?? state?.play_history ?? [];
}
function canAttackOk(state, pi, ai, di) {
  return !!DfRules.canAttack(state, pi, ai, 1 - pi, di)?.ok;
}
function combatKill(att, def) {
  return !!DfRules.combatOutcome(att, def)?.killD;
}
/** GDScript `state.can_use_ultimate(pi)` — cargas e uso no turno. */
function _canUseUltimate(state, pi) {
  const pl = state.players[pi] || {};
  const maxUlt = getEffectiveMaxUltimateUses(pl, pl.heroDef?.id || pl.heroId);
  return (pl.ultimateUses ?? 0) < maxUlt && !pl.usedUltimateThisTurn;
}

// Ações legais e talentos por estado (cache por objeto — o feixe chama
// os portões do livro várias vezes no MESMO nó; sem o cache, cada
// chamada re-listaria tudo e o torneio ficaria ordens mais lento).
const _legalCache = new WeakMap();
function _legalActionsCached(state, pi) {
  let per = _legalCache.get(state);
  if (!per) { per = new Map(); _legalCache.set(state, per); }
  if (!per.has(pi)) {
    const legal = DfEngine.listLegalActions(state, pi, {
      strictFumacaToxica: true,
      avoidEnemyOnEnterWaste: false,
      allowWastedOnEnter: true,
    }) || [];
    per.set(pi, legal);
  }
  return per.get(pi);
}
const _talentPlaysCache = new WeakMap();
function _talentPlaysCached(state, pi) {
  let per = _talentPlaysCache.get(state);
  if (!per) { per = new Map(); _talentPlaysCache.set(state, per); }
  if (!per.has(pi)) per.set(pi, listTalentPlays(state, pi) || []);
  return per.get(pi);
}
/** GDScript `state.can_play(pi, i)` para as cartas da mão: invocação
 * legal pelo motor OU talento listado pelo cérebro OU talento AUTO
 * validado pelo motor. */
const _playableCache = new WeakMap();
function _playableHandIdxs(state, pi) {
  let per = _playableCache.get(state);
  if (!per) { per = new Map(); _playableCache.set(state, per); }
  if (per.has(pi)) return per.get(pi);
  const set = new Set();
  for (const a of _legalActionsCached(state, pi)) {
    if (a?.type === "SUMMON") set.add(a.handIdx);
  }
  for (const tp of _talentPlaysCached(state, pi)) set.add(tp.handIdx);
  const hand = state.players[pi]?.hand || [];
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (!card || String(card.category || "") !== "talent") continue;
    if (set.has(i)) continue;
    if (!TALENT_AUTO_EFFECTS.has(String(card.talentEffect || ""))) continue;
    try {
      const chk = DfEngine.validateAction(state, { type: "TALENT_START", playerId: pi, handIdx: i });
      if (chk?.ok) set.add(i);
    } catch { /* talento inválido: fora do conjunto */ }
  }
  per.set(pi, set);
  return set;
}
/** GDScript `state.can_manual_draw(pi)`. */
function _canManualDraw(state, pi) {
  return _legalActionsCached(state, pi).some((a) => a?.type === "DRAW_CARD");
}

/** (1.51.55 item 2) Espelho de AIBrain._only_p1_targets: todos os alvos
 * VÁLIDOS são P1 — a carta é pulada de vez (nem como último recurso). */
function _onlyP1Targets(state, pi, oe) {
  const foes = foesOf(state, pi);
  if (!foes.length) return false;
  if (oe === "incendiar") {
    const valid = foes.filter((c) => !hasBarrier(c));
    return valid.length > 0 && valid.every((c) => powerOf(c) === 1);
  }
  if (["mordidaVenenosa", "rajadaCongelante", "fumacaToxica", "prisaoPrismatica"].includes(oe)) {
    return foes.every((c) => powerOf(c) === 1);
  }
  return false;
}

/** (1.51.96 item 8) Espelho de AIBrain._hook_ready: o Gancho está pronto
 * para usar neste turno? (herói Gancho, Ultimate disponível e espaço
 * no próprio campo). */
function _hookReady(state, pi) {
  const pl = state.players[pi] || {};
  if (heroUltType(pl) !== "hook") return false;
  if (!_canUseUltimate(state, pi)) return false;
  return (pl.field || []).length < 6;
}

// (Livro 03 §12a) A Desafiante invocada sozinha NESTE turno — a trava
// é o par (turno + uid); o ONDE ela vive é o ctx por sala de plan()
// (Frente 2, item 4) — aqui ficam só as variáveis de trabalho, nunca
// o estado de uma sala específica.
let _livroDesafianteTurn = -1;
let _livroDesafianteUid = null;
/** Clone do estado para o feixe: cloneState (JSON) + Sets restaurados. */
export function cloneBeamState(src) {
  const c = DfEngine.cloneState(src);
  c.aiStatusedUids = new Set(statusedSet(src));
  c.aiBolhasPesadeloUsed = new Set(bolhasSet(src));
  return c;
}
function attackCost(att, def) {
  try {
    const v = DfRules.getAttackActionCost?.(att, def);
    if (typeof v === "number") return v;
  } catch { /* cai no cálculo local */ }
  if (att && (att.urso_pesado || att.name === "URSO PESADO")) return 2;
  if (att && att.prisaoPrismatica) return 2;
  if (att && att.freeAttack && !(att.abilityName === "Pesado Demais" && !att.silenced) && !att.prisaoPrismatica) return 0;
  let cost = 1;
  if (def && def.abilityName === "Resistente" && !def.silenced) cost = 2;
  if (att && att.abilityName === "Pesado Demais" && !att.silenced) cost = Math.max(cost, 2);
  return cost;
}

// ------------------------------------------------------------------
// plan() / evaluate2()
// ------------------------------------------------------------------
// Frente 2 (item 4): a trava da Desafiante (_livroDesafianteTurn/Uid)
// vivia no módulo e vazava entre salas (mesmo turno + mesmo uid de
// carta). O ctx é por sala — o servidor passa room._aiPlannerCtx em
// plan() — e é carregado/salvo em volta de cada chamada (plan() é
// síncrono, então não há intercalação dentro da chamada). Sem ctx, o
// comportamento antigo (módulo) é mantido: os testes de paridade não
// passam ctx e não mudam.
export function plan(state, seat = state.currentPlayer, plannerCtx = null) {
  if (plannerCtx) {
    _livroDesafianteTurn = plannerCtx.desafianteTurn ?? -1;
    _livroDesafianteUid = plannerCtx.desafianteUid ?? null;
  }
  try {
    return _planInner(state, seat);
  } finally {
    if (plannerCtx) {
      plannerCtx.desafianteTurn = _livroDesafianteTurn;
      plannerCtx.desafianteUid = _livroDesafianteUid;
    }
  }
}

function _planInner(state, seat = state.currentPlayer) {
  const pi = seat;
  if (state.winner !== null && state.winner !== undefined && state.winner !== -1) {
    return { type: "end_turn" };
  }
  // (Correção 1.51.97) O ataque que vence a partida e o abate
  // decisivo passam na frente de tudo, como no cérebro antigo
  // (1.51.96 item 10): o feixe empatava invocar/atacar e a
  // compra vencia a jogada selada.
  const foes = state.players[1 - pi]?.field || [];
  const win = _winAttack(state, pi, foes);
  if (win) return win;
  const summon = _bestSummonForDecisive(state, pi);
  const dec = _decisiveAttack(state, pi, foes, summon);
  // (Livro 03) Contexto de remoção deste estado — o mesmo para o
  // decisivo, a sonda e o retorno do cérebro antigo (o estado não
  // muda dentro do plano, só as cópias).
  const atkCtx = _livroAttackCtx(state, pi);
  if (dec) {
    // (Livro 03) O abate decisivo passa na frente de tudo —
    // salvo quando ele desrespeita uma regra de remoção do
    // livro. O abate que VENCE a partida nunca chega aqui (o
    // _win_attack já o devolveu), então bloquear o decisivo é
    // seguro: o feixe escolhe a remoção certa.
    let decBlocked = false;
    if (String(dec.type || "") === "attack") {
      decBlocked = !_livroAttackAllowed(state, pi, dec.att_idx ?? -1, dec.def_idx ?? -1, atkCtx);
    }
    if (!decBlocked) {
      // (Escola Grupo 1) Nunca pagar um ataque que a Investida
      // faz de graça: se o mesmo atacante destrói o mesmo
      // defensor com o ataque livre da Ultimate da Tina, a
      // Ultimate sai primeiro — o ataque pago gastaria 1 ação
      // à toa e depois a Ultimate não teria mais alvo.
      if (_freeAttackSameKill(state, pi, dec)) {
        const ult = pickUltimate(state, pi, false) || pickUltimate(state, pi, true);
        return ult ? { type: "ultimate", ultAction: ult } : { type: "ultimate" };
      }
      return dec;
    }
  }
  // (Correção 1.51.97, ajuste 18:32 — v3, substitui o passo
  // "instantânea sempre primeiro" da v2) A invocação que mata ou
  // ABRE o abate sai primeiro (1.51.96 itens 7.2, 10.4, 11.5):
  // provado numa cópia, invocar mata um adversário (PV sobe ou
  // campo adversário encolhe) ou deixa um abate possível que antes
  // não existia (o Grito da VIOLÊNCIA, a Troca da CAVALEIRA). Sem
  // isso, o feixe troca a ordem selada pelo placar — a linha do
  // COMUM pontua mais (o reforço pega os dois), mas o teste sela
  // a instantânea primeiro. A regra vale só para a invocação que
  // o `_best_summon` já escolheu e só quando há abate imediato
  // em jogo; invocar primeiro "sempre" (v2) derrubou o torneio
  // (a IA gastava as cartas à toa e ficava sem carta na mão no
  // fim).
  if (summon) {
    const handIdx = summon.handIdx ?? summon.hand_idx ?? -1;
    const summonAct = { type: "summon", hand_idx: handIdx };
    const probe = cloneBeamState(state);
    _clonesUsed += 1;
    const vp0 = state.players[pi]?.vp ?? 0;
    const foes0 = (state.players[1 - pi]?.field || []).length;
    const killNow = _killPossible(state, pi);
    const summonedCard = state.players[pi]?.hand?.[handIdx];
    const summonedUid = summonedCard?.uid;
    // (Livro 02, grupo INSTANTÂNEAS, itens 1–2) a carta guardada
    // não sai pelo atalho selado: a guarda (Bola 2,0 e Assassinar
    // 6,0 num P1 inofensivo) vale mais que o abate sem PV — o
    // P1 perigoso pode entrar depois. Sem isto, o selo gastava
    // a carta que o feixe e o retorno guardavam.
    // (Livro 03) A sonda não devolve uma invocação que o livro
    // proíbe (Legado sem herdeiro, Crescimento depois do turno
    // 10, Inspirar sem vizinho, Laço sem alvo, Aura silenciada,
    // Desafiante com aliado ou depois dela no mesmo turno).
    let probeBlocked = _livroDesafianteLock(state, pi);
    if (!probeBlocked && summonedCard) probeBlocked = _livroSummonBlocked(state, pi, summonedCard);
    // (Junção Fase 2) A guarda só barra o atalho quando a carta é
    // o único abate (sem kill_now) ou a guarda é grande
    // (Assassinar 6,0): com abate de aliado à vista e guarda
    // pequena (Bola 2,0), o atalho vale — é a trava 10.4, que
    // o feixe decidia no sorteio do baralho (instável 2 em 7).
    const sg = summonedCard ? guardValue(state, pi, summonedCard) : 0.0;
    const res = applyPlannerAction(probe, pi, summonAct);
    if (!probeBlocked && res.ok && (sg <= 0.0 || (killNow && sg <= 2.0))
      && ((res.state.players[pi]?.vp ?? 0) > vp0
        || (res.state.players[1 - pi]?.field || []).length < foes0
        || (_killPossible(res.state, pi, summonedUid) && !killNow))) {
      _livroNoteSummon(state, pi, summonAct);
      return summonAct;
    }
  }
  // (Correção 1.51.97) Talentos com portão duro da 1.51.96
  // (Grito, INVESTIDA, Técnicas de Combate, Corromper): quando
  // não há invocação e o cérebro antigo os jogaria, o talento
  // sai na hora — o feixe não pode trocar a jogada selada por
  // outra linha (o sorteio do baralho virava o resultado).
  if (!summon) {
    const tal = _bestTalent(state, pi);
    if (tal) {
      const tc = state.players[pi]?.hand?.[tal.hand_idx];
      if (["gritoDeGuerraTalento", "investidaTalento", "tecnicasDeCombateTalento", "corromperTalento"]
        .includes(String(tc?.talentEffect || ""))) {
        return tal;
      }
    }
  }
  const first = _beamSearch(state, pi);
  if (!first || !first.type || first.type === "end_turn") {
    // (Correção 1.51.97) O feixe só passa a vez quando nada
    // melhora a partida — mas passar com carta jogável na mão
    // é a jogada burra da sonda. Sem jogada melhor, vale a
    // jogada do cérebro antigo (invocar, talento, Ultimate,
    // ataque ou compra — nunca vazia).
    const leg = _legacyFallback(state, pi);
    if (leg && leg.type) {
      // (Livro 03) O retorno do cérebro antigo também passa
      // pelas regras de remoção: um ataque proibido vira
      // compra (se der) ou fim de turno — nunca a jogada.
      if (String(leg.type || "") === "attack"
        && !_livroAttackAllowed(state, pi, leg.att_idx ?? -1, leg.def_idx ?? -1, atkCtx)) {
        if (_canManualDraw(state, pi)) return { type: "draw" };
        return { type: "end_turn" };
      }
      // (Escola Grupo 1) O cérebro antigo pode devolver um
      // talento sem efeito certo (ele não tem o portão para
      // todos) — o feixe já o recusou pelo placar, e aqui
      // ele é conferido contra a mesma tabela de uso. Sem
      // efeito, a carta fica guardada: comprar, se der;
      // senão, passar a vez.
      if (String(leg.type || "") === "talent") {
        const hi = leg.hand_idx ?? -1;
        const hand = state.players[pi]?.hand || [];
        if (hi >= 0 && hi < hand.length) {
          const tc = hand[hi];
          if (!_talentUsable(state, pi, String(tc?.talentEffect || ""), powerOf(tc))) {
            if (_canManualDraw(state, pi)) return { type: "draw" };
            return { type: "end_turn" };
          }
        }
      }
      // (Escola Grupo 5) O mesmo vale para invocar um Poder 1
      // parado ganhando com folga: o feixe já o recusou, e o
      // retorno do cérebro antigo é conferido aqui. O mesmo
      // vale para a Podridão sem efeito (4 pilhas ou baralho
      // vazio — Grupo 6).
      if (String(leg.type || "") === "summon") {
        const hi2 = leg.hand_idx ?? -1;
        const hand2 = state.players[pi]?.hand || [];
        if (hi2 >= 0 && hi2 < hand2.length) {
          const sc = hand2[hi2];
          let wasted = _p1SummonBlocked(state, pi, sc);
          if (!wasted && String(sc?.onEnter || "") === "podridao") {
            wasted = podridaoStacksOf(state.players[1 - pi]) >= 4
              || (state.players[1 - pi]?.deck || []).length === 0;
          }
          // (Livro 02, grupo INSTANTÂNEAS) os portões do
          // livro valem no retorno também — senão o feixe
          // recusa e o cérebro antigo gasta a carta assim
          // mesmo (mesma regra da tabela de talentos).
          // (Livro 03) O mesmo vale para as invocações que
          // o livro proíbe e para outro aliado depois da
          // Desafiante no mesmo turno.
          if (!wasted) {
            wasted = _instantExtraBlocked(state, pi, sc, hi2)
              || _livroSummonBlocked(state, pi, sc)
              || _livroDesafianteLock(state, pi);
          }
          if (wasted) {
            if (_canManualDraw(state, pi)) return { type: "draw" };
            return { type: "end_turn" };
          }
        }
      }
      // (Escola Grupo 6) Carta que vale mais guardada: o feixe
      // já recusou gastá-la agora (não bateu o placar de
      // passar a vez) e a guarda diz que ela vale mais depois
      // — não gastar: comprar, se der; senão, passar a vez.
      // (Junção 1.51.98) A BAFORADA VENENOSA não entra neste
      // veto: a guarda 3.0 dela vale para o placar do feixe,
      // mas num P2+ sem veneno o veneno cumpre o efeito
      // inteiro — e a trava selada da 1.51.96 (t_15196 8.2)
      // exige jogar a Baforada num P2 limpo. Sem esta
      // exceção, o veto guardava a carta e o 8.2 falhava.
      if (String(leg.type || "") === "summon" || String(leg.type || "") === "talent") {
        const hi3 = leg.hand_idx ?? -1;
        const hand3 = state.players[pi]?.hand || [];
        if (hi3 >= 0 && hi3 < hand3.length
          && guardValue(state, pi, hand3[hi3]) > 0.0
          && String(hand3[hi3]?.talentEffect || "") !== "baforadaVenenosa") {
          if (_canManualDraw(state, pi)) return { type: "draw" };
          return { type: "end_turn" };
        }
      }
      // (Livro §1/§4) O cérebro antigo pode devolver um ataque
      // que o filtro barraria — o empate contra Sobrepujar
      // (ninguém morre, só gasta a ação) ou o ataque ao forte
      // imbatível: comprar, se der; senão, passar a vez.
      if (String(leg.type || "") === "attack") {
        const ai4 = leg.att_idx ?? -1;
        const di4 = leg.def_idx ?? -1;
        const mine4 = state.players[pi]?.field || [];
        const foes4 = state.players[1 - pi]?.field || [];
        if (ai4 >= 0 && ai4 < mine4.length && di4 >= 0 && di4 < foes4.length) {
          const over4 = isOverpower(foes4[di4]) && powerOf(mine4[ai4]) <= powerOf(foes4[di4]);
          if (over4 || _foeUnbeatable(state, pi, di4)) {
            if (_canManualDraw(state, pi)) return { type: "draw" };
            return { type: "end_turn" };
          }
        }
      }
      _livroNoteSummon(state, pi, leg);
      return leg;
    }
    return { type: "end_turn" };
  }
  _livroNoteSummon(state, pi, first);
  return first;
}

// (Escola Grupo 1) O abate decisivo pode ser feito de graça?
// True quando a Ultimate da Tina daria o ataque livre ao MESMO
// atacante do abate e ele destruiria o MESMO defensor — o motor
// escolhe o aliado mais forte válido, então o atacante tem de ser
// essa escolha (e P2+, como o portão da Ultimate exige).
function _freeAttackSameKill(state, pi, dec) {
  const p = state.players[pi] || {};
  if (heroUltType(p) !== "targetAllyFreeAttack") return false;
  if (!_canUseUltimate(state, pi)) return false;
  const ai = dec.att_idx ?? -1;
  const di = dec.def_idx ?? -1;
  const mine = p.field || [];
  const foes = state.players[1 - pi]?.field || [];
  if (ai < 0 || ai >= mine.length || di < 0 || di >= foes.length) return false;
  const att = mine[ai];
  if (!att || att.tapped || isApodrecida(att) || att.silenced) return false;
  if (powerOf(att) < 2) return false;
  if (constOf(att) === "investida") return false;
  if (frozenTurns(att) > 0 || hasCharm(att)) return false;
  // O motor dá o ataque livre ao aliado mais forte válido.
  let pick = null;
  for (const c of mine) {
    if (!c || isApodrecida(c) || c.tapped || c.silenced) continue;
    if (!pick || powerOf(c) > powerOf(pick)) pick = c;
  }
  if (!pick || String(pick.uid) !== String(att.uid)) return false;
  const defc = foes[di];
  if (hasShield(defc) || hasCharm(defc)) return false;
  if (isResistente(defc)) return false;
  if (statusedSet(state).has(defc?.uid)) return false;
  return combatKill(att, defc);
}

// ------------------------------------------------------------------
// Retorno direto do plan() (espelho de _win_attack /
// _decisive_attack / _best_summon / _best_talent do GDScript).
// Usam DfRules.canAttack/combatOutcome (o mesmo can_attack do
// motor GDScript, com custo) em vez dos picks do cérebro — os
// picks não checam custo de ação nem enfeitiçado.
// ------------------------------------------------------------------
// Um abate é possível AGORA (sem supor reforço): algum aliado
// destapado pode atacar e destruir um adversário. A carta invocada
// entra destapada e conta (1.51.96 item 11) — mas o `excludeUid`
// tira a própria carta invocada da conta: o que vale é o abate
// que a INSTANTÂNEA abre (aliado buffado, carta roubada), não o
// abate que a carta faria sozinha com o Poder base (11.6: a
// VIOLÊNCIA sozinha não vale, porque ela não recebe a Fúria).
function _killPossible(state, pi, excludeUid = -1) {
  const mine = state.players[pi]?.field || [];
  const foes = state.players[1 - pi]?.field || [];
  for (let ai = 0; ai < mine.length; ai++) {
    const att = mine[ai];
    if (!att || att.uid === excludeUid) continue;
    for (let di = 0; di < foes.length; di++) {
      if (!DfRules.canAttack(state, pi, ai, 1 - pi, di)?.ok) continue;
      if (DfRules.combatOutcome(att, foes[di])?.killD) return true;
    }
  }
  return false;
}

function _winAttack(state, pi, foes) {
  const p = state.players[pi] || {};
  const winPoints = state.winPoints ?? 15;
  let mutual = null;
  const field = p.field || [];
  for (let ai = 0; ai < field.length; ai++) {
    const att = field[ai];
    for (let di = 0; di < foes.length; di++) {
      const defc = foes[di];
      if (!DfRules.canAttack(state, pi, ai, 1 - pi, di)?.ok) continue;
      const out = DfRules.combatOutcome(att, defc);
      if (!out?.killD) continue;
      // (1.51.55 item 5) não destruir o campeão statusado
      // pela própria IA neste turno.
      if (statusedSet(state).has(defc?.uid)) continue;
      const vpGain = noVpOnDestroy(defc) ? 0
        : ((!att?.silenced && (att?.constantEffect === "recompensaDupla" || att?.abilityName === "Recompensa Dupla")) ? 2 : 1);
      if ((p.vp ?? 0) + vpGain < winPoints) continue;
      const atk = { type: "attack", att_idx: ai, def_idx: di };
      if (!out.killA) return atk;
      if (!mutual) mutual = atk;
    }
  }
  return mutual;
}

function _decisiveAttack(state, pi, foes, summon) {
  const p = state.players[pi] || {};
  let best = null;
  let bestScore = 0;
  let bestVp = 0;
  let bestCost = 0;
  const field = p.field || [];
  for (let ai = 0; ai < field.length; ai++) {
    const att = field[ai];
    for (let di = 0; di < foes.length; di++) {
      const defc = foes[di];
      const chk = DfRules.canAttack(state, pi, ai, 1 - pi, di);
      if (!chk?.ok) continue;
      const out = DfRules.combatOutcome(att, defc);
      if (!out?.killD || out?.killA) continue;
      if (statusedSet(state).has(defc?.uid)) continue;
      const vpGain = noVpOnDestroy(defc) ? 0
        : ((!att?.silenced && (att?.constantEffect === "recompensaDupla" || att?.abilityName === "Recompensa Dupla")) ? 2 : 1);
      const pa = powerOf(att);
      const pd = powerOf(defc);
      // Mesma conta do _best_attack (abate limpo).
      let score = 100.0 + vpGain * 10.0 + pd * 2.0;
      if (pa === 1) score += 15.0;
      if (pd === 1 && out.killD) score += 15.0;
      score -= (chk.actionCost ?? 0) * 3.0;
      if (score > bestScore) {
        bestScore = score;
        bestVp = vpGain;
        bestCost = chk.actionCost ?? 0;
        best = { type: "attack", att_idx: ai, def_idx: di };
      }
    }
  }
  if (!best || bestVp <= 0) return null;
  if (aiMode(state, pi) === "mitigacao") return best;
  if (bestVp >= 2) return best;
  if (summon) {
    // `_best_summon` devolve só o índice — o custo sai da carta.
    const summonCard = state.players[pi]?.hand?.[summon.handIdx];
    if (summonCard && championSummonCost(summonCard) + bestCost > (p.actions ?? 0)) return best;
  }
  return null;
}

/** Melhor invocação só para a conta de ações do abate decisivo
 * (espelho do peek de `_best_summon` no plan() GDScript). Usa o
 * pick do cérebro; a regra nova do Grito (a invocada conta como
 * atacante) pode mudar QUAL invocação é a melhor em casos raros —
 * e com ela o custo usado aqui (ver decisão no plano). */
function _bestSummonForDecisive(state, pi) {
  const legal = DfEngine.listLegalActions(state, pi, {
    strictFumacaToxica: true,
    avoidEnemyOnEnterWaste: false,
    allowWastedOnEnter: true,
  }) || [];
  const s = pickBestSummon(state, pi, legal, { minScore: 0 });
  return (s && s.type === "SUMMON") ? s : null;
}

/** Melhor talento (espelho de `_best_talent`): os portões de cada
 * efeito vivem em listTalentPlays; a escolha por modo vive em
 * pickTalentByMode. Devolve {type:"talent", hand_idx, talentPlay}
 * (o talentPlay carrega o alvo para o follow-up). */
function _bestTalent(state, pi) {
  const p = state.players[pi] || {};
  // Com o campo cheio (6) o offline segura o talento — a 7ª carta
  // do campo só pode ser talento ou reação JOGADA PELO HUMANO.
  if ((p.field || []).length >= 6) return null;
  if (state.activeTalent && state.activeTalent.ownerP === pi) return null;
  const plays = listTalentPlays(state, pi);
  if (!plays.length) return null;
  const pick = pickTalentByMode(state, pi, plays);
  if (!pick) return null;
  return { type: "talent", hand_idx: pick.handIdx, talentPlay: pick };
}

export function evaluate2(state, pi) {
  const me = state.players[pi] || {};
  const foe = state.players[1 - pi] || {};
  const vpDiff = (me.vp ?? 0) - (foe.vp ?? 0);
  const myPw = fieldPower(me);
  const foePw = fieldPower(foe);
  const myHand = (me.hand || []).length;
  const foeHand = (foe.hand || []).length;
  const handTerm = _handValue(myHand) - foeHand * 0.5;
  if (state.winner === pi) return WIN_SCORE + vpDiff * 3.0 + (myPw - foePw);
  if (state.winner === 1 - pi) return -WIN_SCORE + vpDiff * 3.0 + (myPw - foePw);
  const raw = vpDiff * 3.0 + (myPw - foePw) + handTerm;
  const losing = raw <= -4.0;
  const winning = raw >= 4.0;
  const powerW = losing ? 1.5 : 1.0;
  let score = vpDiff * 3.0 + (myPw - foePw) * powerW + handTerm;
  score += -1.0 * _turnsToWin(state, pi) + 1.0 * _turnsToWin(state, 1 - pi);
  let threat = 0.0;
  for (const c of foe.field || []) threat += _threatOfState(state, pi, c);
  // (Livro §7c) Com ele a 14 pontos, cada campeão dele em campo é
  // letal no próximo turno: +2,0 de ameaça por campeão em campo.
  if ((foe.vp ?? 0) === 14) threat += 2.0 * (foe.field || []).length;
  score -= 0.5 * threat;
  if (winning) score += 1.0 * (me.field || []).length;
  return score;
}

// (Livro 03) Ameaça com contexto: os ajustes do livro que dependem
// do resto do campo. A base continua _threatOf — só estes bônus
// entram aqui, e só no placar (a guarda e a proteção continuam com
// _threatOf, sem contexto). A carta é sempre do adversário de pi.
function _threatOfState(state, pi, card) {
  const base = _threatOf(card);
  const ab = String(card?.abilityName || "");
  switch (ab) {
    case "Sobrepujar":
      // §3(c) Com um alvo de Poder igual em campo, vale 1,0.
      if (!card?.silenced) {
        for (const c of state.players[pi]?.field || []) {
          if (powerOf(c) === powerOf(card)) return Math.max(base, 1.0);
        }
      }
      break;
    case "Investida":
      // §7(c) Com um P1 ao alcance dela, vale 1,0.
      if (!card?.silenced) {
        for (const c of state.players[pi]?.field || []) {
          if (powerOf(c) !== 1) continue;
          if (hasShield(c) || hasCharm(c)) continue;
          if (isResistente(c)) continue;
          if (combatKill(card, c)) return Math.max(base, 1.0);
        }
      }
      break;
    case "Resistente":
      // §4(a) Variante "sempre" do livro: um campeão que rouba
      // 1 ação por ataque vale mais que 0,5.
      return Math.max(base, 1.0);
    case "Aura Anti-Magia":
      // §8(c) Quando o adversário já usou redução neste jogo.
      if (_usedReduction(state, 1 - pi)) return Math.max(base, 1.0);
      break;
    case "Laço de Sangue":
      // §13(b) Armado (aliado em campo e alvo abatível), vale 2,0.
      if (!card?.silenced && _lacoArmed(state, pi, card)) return 2.0;
      break;
    default:
      break;
  }
  return base;
}

// (Livro 03 §13) O Laço está armado? Tem outro aliado em campo
// (que não seja apodrecida — o +1 nunca vai para ela) e um alvo
// que ele consegue destruir em combate. A carta é do adversário
// de pi; o alvo é um campeão de pi.
function _lacoArmed(state, pi, card) {
  const allies = state.players[1 - pi]?.field || [];
  let hasReceiver = false;
  for (const a of allies) {
    if (String(a?.uid) !== String(card?.uid) && !isApodrecida(a)) {
      hasReceiver = true;
      break;
    }
  }
  if (!hasReceiver) return false;
  for (const c of state.players[pi]?.field || []) {
    if (hasShield(c) || hasCharm(c)) continue;
    if (combatKill(card, c)) return true;
  }
  return false;
}

// (Livro 03 §8c) Este jogador já usou redução de Poder neste jogo?
// Só o que o histórico registra (cartas jogadas): Bola de Fogo,
// Assassinar, Raio Duplo, Transformar, Incendiar, Explosão e
// Tornado de Fogo. Ultimates não entram no histórico e não contam.
function _usedReduction(state, ownerPi) {
  for (const e of playHistoryOf(state)) {
    const h = e || {};
    if ((h.pi ?? h.playerId ?? -1) !== ownerPi) continue;
    const c = h.card || {};
    const oe = String(c.onEnter ?? c.on_enter ?? "");
    if (["bolaDeFogo", "assassinar", "raioDuplo", "transformarBichinho", "incendiar"].includes(oe)) return true;
    const te = String(c.talentEffect ?? c.talent_effect ?? "");
    if (["bolaDeFogoTalento", "explosao", "transformarBichinhoTalento", "tornadoDeFogo"].includes(te)) return true;
  }
  return false;
}

function _handValue(n) {
  if (n <= 0) return 0.0;
  let v = 0.5 * n;
  v += 2.0 * Math.min(n, 1);
  v += 0.75 * Math.min(Math.max(n - 1, 0), 1);
  v += 0.25 * Math.min(Math.max(n - 2, 0), 1);
  return v;
}

function _isLosing(state, pi) {
  const me = state.players[pi] || {};
  const foe = state.players[1 - pi] || {};
  const vpDiff = (me.vp ?? 0) - (foe.vp ?? 0);
  const raw = vpDiff * 3.0 + (fieldPower(me) - fieldPower(foe))
    + _handValue((me.hand || []).length) - (foe.hand || []).length * 0.5;
  return raw <= -4.0;
}

// (Livro §4) Este adversário é o forte da inundação: Poder 3+ que
// nenhum aliado consegue destruir (nem em combate mútuo).
function _foeUnbeatable(state, pi, di) {
  const foes = state.players[1 - pi]?.field || [];
  if (di < 0 || di >= foes.length) return false;
  const f = foes[di];
  if (powerOf(f) < 3) return false;
  const mine = state.players[pi]?.field || [];
  for (let ai = 0; ai < mine.length; ai++) {
    if (!canAttackOk(state, pi, ai, di)) continue;
    if (combatKill(mine[ai], f)) return false;
  }
  return true;
}

// (Escola Grupo 5) Há um campeão adversário de Poder 3+ que nenhum
// aliado consegue destruir — a situação da inundação: sem abate
// possível no forte, o campo se vence com corpos.
function _unbeatableStrongFoe(state, pi) {
  const foes = state.players[1 - pi]?.field || [];
  for (let di = 0; di < foes.length; di++) {
    if (_foeUnbeatable(state, pi, di)) return true;
  }
  return false;
}

// (Escola Grupo 5) Invocar este Poder 1 é manter Poder 1 no campo
// fora da inundação? True só para o corpo parado (constante) quando
// a IA ganha com folga (4+ PV na frente) e não há um forte
// imbatível pedindo a inundação. A instantânea que faz efeito não
// é um corpo parado — ela vale pelo efeito, não pelo Poder.
function _p1SummonBlocked(state, pi, card) {
  if (powerOf(card) !== 1) return false;
  if (String(card?.abilityType || "") !== "constant") return false;
  if ((state.players[pi]?.vp ?? 0) - (state.players[1 - pi]?.vp ?? 0) < 4) return false;
  if (_unbeatableStrongFoe(state, pi)) return false;
  return true;
}

// (Livro 02, grupo INSTANTÂNEAS) Portões do livro que a tabela de
// pré-condição do cérebro antigo (`AIBrain._oe_usable`) não cobre —
// sem eles, a carta era invocada só pelo corpo e o efeito se perdia.
// Vale nos dois caminhos do planejador (candidatas do feixe e
// conferência do retorno do cérebro antigo), como a tabela de talentos.
function _instantExtraBlocked(state, pi, card, handIdx) {
  const oe = String(card?.onEnter || "");
  switch (oe) {
    case "charme":
      // (33) o enfeitiçado precisa de lugar: a fonte entra e o
      // roubado ocupa outro — com 5 aliados o roubo falha.
      return (state.players[pi]?.field || []).length >= 6 - 1;
    case "incendiar":
      // (07) nunca só em P1 (o P1 morre fácil de outro jeito).
      return _onlyP1Targets(state, pi, oe);
    case "mordidaVenenosa": {
      // (06) nunca envenenar o alvo do Gancho: com o Gancho
      // pronto, só vale num P3+ limpo (o roubo não o alcança).
      if (!_hookReady(state, pi)) return false;
      return !(state.players[1 - pi]?.field || []).some((c) =>
        powerOf(c) >= 3 && poisonTurns(c) === 0 && !isOwnCharmed(c, pi));
    }
    case "ursificacao":
      // (23) nunca sem outro aliado válido — o Urso Pesado
      // nunca é alvo (o motor recusa) e a fonte nunca é a si.
      return !(state.players[pi]?.field || []).some((c) =>
        !(c?.urso_pesado ?? c?.ursoPesado ?? false) && String(c?.name || "") !== "URSO PESADO");
    case "rapidez":
      // (25) nunca só pelo corpo: a ação extra morre sem uso.
      return !_rapidezChain(state, pi, card, handIdx);
    case "forja":
      // (26) sem cartas no baralho, o saque não existe.
      return (state.players[pi]?.deck || []).length === 0;
    case "energizar":
      // (32) o +1 uso só vale com a Ultimate usável AGORA
      // (cargas, alvo e condição — `can_use_ultimate` sozinho
      // não vê alvo nem condição).
      return !(_canUseUltimate(state, pi) && _ultimateAllowed(state, pi));
    default:
      return false;
  }
}

// (Livro 02, item 25) Há jogada esperando a ação extra da Rapidez?
// Outra carta jogável na mão, um ataque (de um aliado ou da própria
// carta recém-invocada, que entra destapada e recebe a ação de volta)
// ou a Ultimate usável agora. A compra não conta: ela é o último
// recurso, não a jogada que a Rapidez encadeia.
function _rapidezChain(state, pi, card, handIdx) {
  const hand = state.players[pi]?.hand || [];
  const playable = _playableHandIdxs(state, pi);
  for (let j = 0; j < hand.length; j++) {
    if (j === handIdx) continue;
    if (playable.has(j)) return true;
  }
  const mine = state.players[pi]?.field || [];
  const foes = state.players[1 - pi]?.field || [];
  for (let ai = 0; ai < mine.length; ai++) {
    for (let di = 0; di < foes.length; di++) {
      if (canAttackOk(state, pi, ai, di)) return true;
    }
  }
  const acts = (state.players[pi]?.actions ?? 0) - championSummonCost(card) + 1;
  if (acts >= 1) {
    for (let di = 0; di < foes.length; di++) {
      const f = foes[di];
      if (isOwnCharmed(f, pi)) continue;
      if (powerOf(f) > powerOf(card)) continue;
      if (hasShield(f)) continue;
      if (isResistente(f) && acts < 2) continue;
      return true;
    }
  }
  return _canUseUltimate(state, pi) && _ultimateAllowed(state, pi);
}

// (Livro 03) Filtros de invocação das habilidades constantes: o que
// nunca se invoca, por habilidade. Vale nas candidatas do feixe e
// na conferência do retorno do cérebro antigo. Só o que a REGRA DE
// CÉREBRO do livro pede — nada além dela.
function _livroSummonBlocked(state, pi, card) {
  const mine = state.players[pi]?.field || [];
  const ab = String(card?.abilityName || "");
  if (ab === "Legado") {
    // §6(a) Nunca invocar com o campo vazio ou só apodrecida.
    return !_hasHeir(mine);
  }
  if (ab === "Crescimento") {
    // §9(a) Nunca invocar depois do turno 10.
    return turnNumberOf(state) >= 11;
  }
  if (ab === "Inspirar") {
    // §10(a) Nunca invocar com menos de 1 vizinho em campo.
    return !_hasInspirarNeighbor(mine);
  }
  if (ab === "Laço de Sangue") {
    // §13(a) Nunca invocar com o campo vazio ou sem alvo
    // abatível ao alcance.
    if (!_hasHeir(mine)) return true;
    for (const f of state.players[1 - pi]?.field || []) {
      if (hasShield(f) || hasCharm(f)) continue;
      if (combatKill(card, f)) return false;
    }
    return true;
  }
  if (ab === "Aura Anti-Magia") {
    // §8(a) Nunca invocar silenciado (a Barreira não vem): com
    // bolhas na mão, ela entraria silenciada.
    if (card?.silenced) return true;
    if (card?.bolhas && state.players[pi]?.bolhasActive) return true;
    return false;
  }
  if (constOf(card) === "desafiante") {
    // §12(a) Nunca invocar Desafiante com outro aliado em campo.
    return mine.length > 0;
  }
  return false;
}

// Um aliado que pode herdar o +1 (Legado/Laço): qualquer aliado que
// não seja apodrecida — o +1 de Poder não é status e vale até com
// silenciado.
function _hasHeir(mine) {
  for (const c of mine || []) {
    if (!isApodrecida(c)) return true;
  }
  return false;
}

// Um vizinho que pode receber o +1 do Inspirar: não apodrecida (nunca
// ganha Poder), não silenciado (não recebe Inspirar) e sem o Inspirar
// quebrado (só uma nova fonte devolve).
function _hasInspirarNeighbor(mine) {
  for (const c of mine || []) {
    if (isApodrecida(c) || c?.silenced || c?.inspirarBroken) continue;
    return true;
  }
  return false;
}

// (Livro 03 §12a) A Desafiante invocada sozinha NESTE turno ainda
// está sozinha no campo — invocar outro aliado agora tiraria o +2
// dela na hora. O plano decide uma ação por vez, então a invocação
// dela é anotada (turno + uid, que o duplicate_state preserva) e a
// trava vale até o turno virar ou ela deixar de estar sozinha.
function _livroNoteSummon(state, pi, act) {
  if (String(act?.type || "") !== "summon") return;
  const hand = state.players[pi]?.hand || [];
  const hi = act.hand_idx ?? -1;
  if (hi < 0 || hi >= hand.length) return;
  const card = hand[hi];
  if (constOf(card) !== "desafiante") return;
  if ((state.players[pi]?.field || []).length > 0) return;
  _livroDesafianteTurn = turnNumberOf(state);
  _livroDesafianteUid = card?.uid ?? null;
}

function _livroDesafianteLock(state, pi) {
  if (_livroDesafianteTurn !== turnNumberOf(state)) return false;
  if (_livroDesafianteUid == null) return false;
  const mine = state.players[pi]?.field || [];
  if (mine.length !== 1) return false;
  const c = mine[0];
  if (constOf(c) !== "desafiante") return false;
  if (String(c?.uid) !== String(_livroDesafianteUid)) return false;
  return !c?.silenced;
}

function _turnsToWin(state, pi) {
  const p = state.players[pi] || {};
  const missing = (state.winPoints ?? 15) - (p.vp ?? 0);
  if (missing <= 0) return 0;
  const passive = Math.min((p.field || []).length, 2);
  let kills = 0;
  const seen = new Set();
  const foes = state.players[1 - pi]?.field || [];
  // Espelho do GameState.can_attack (GDScript): só quem está com o turno
  // pode atacar. Ao medir os turnos do ADVERSÁRIO (não é o turno dele),
  // os abates dele nunca contam — só o PV passivo. O motor JS (DfRules)
  // não tem essa trava (ela vive no validateAction), então ela é
  // replicada aqui; sem ela o A6 diverge (o planejador JS contava 8
  // turnos para o adversário onde o GDScript conta 12).
  const canAttackHere = (ai, di) => {
    if (pi !== state.currentPlayer) return false;
    return !!DfRules.canAttack(state, pi, ai, 1 - pi, di)?.ok;
  };
  for (let ai = 0; ai < (p.field || []).length; ai++) {
    for (let di = 0; di < foes.length; di++) {
      if (seen.has(di)) continue;
      if (!canAttackHere(ai, di)) continue;
      const out = DfRules.combatOutcome(p.field[ai], foes[di]);
      if (out?.killD) {
        seen.add(di);
        kills += 1;
      }
    }
  }
  const perTurn = Math.max(1, passive + kills);
  return Math.min(Math.ceil(missing / perTurn), 12);
}

function _threatOf(card) {
  const ab = String(card?.abilityName || "");
  switch (ab) {
    case "Crescimento": return 2.0;
    case "Inspirar": return 2.0;
    case "Muralha": return 1.5;
    case "Recompensa Dupla": return 1.5;
    case "Vingança": return 1.0;
    case "Legado": return 1.0;
    case "Desafiante": return 1.0;
    case "Laço de Sangue": return 1.0;
    case "Sobrepujar": return 0.5;
    case "Investida": return 0.5;
    case "Sem Honra": return 0.0;
    default: break;
  }
  const oe = String(card?.onEnter || "");
  switch (oe) {
    case "assassinar": return 2.0;
    case "bolaDeFogo": return 2.0;
    case "raioDuplo": return 1.5;
    case "transformarBichinho": return 1.5;
    case "charme": return 1.5;
    case "rajadaCongelante": case "mordidaVenenosa": case "incendiar":
    case "podridao": case "pesadelo": case "trocaInjusta": case "roletaRussa":
      return 1.0;
    default: break;
  }
  if (ab !== "") return 0.5;
  return 0.0;
}

// ------------------------------------------------------------------
// guard_value() / COMBOS
// ------------------------------------------------------------------
export function guardValue(state, pi, card) {
  const foes = foesOf(state, pi);
  const oe = String(card?.onEnter || "");
  if (oe === "assassinar") {
    let best = 0.0;
    let anyP1 = false;
    for (const c of foes) {
      if (powerOf(c) === 1 && !hasBarrier(c)) {
        anyP1 = true;
        best = Math.max(best, _threatOf(c));
      }
    }
    if (!anyP1) return 0.0;
    return best < 2.0 ? 6.0 : 0.0;
  }
  if (String(card?.talentEffect || "") === "zeroAbsoluto") {
    for (const c of foes) {
      if ((c.frozenTurns ?? 0) > 0) return 0.0;
    }
    return 4.0;
  }
  if (oe === "bolaDeFogo") {
    let best = 0.0;
    let anyP1 = false;
    for (const c of foes) {
      if (powerOf(c) === 1 && !hasBarrier(c) && !isApodrecida(c)) {
        anyP1 = true;
        best = Math.max(best, _threatOf(c));
      }
    }
    if (anyP1 && best < 2.0) return 2.0;
  }
  // (Escola Grupo 6) Valores de guarda dos talentos, a partir da
  // tabela: o talento vale mais guardado quando não há alvo que
  // valha a pena agora — o feixe desconta a guarda ao gastar.
  // (Como no GDScript, o campo adversário aqui é o campo inteiro,
  // sem excluir o enfeitiçado.)
  const allFoes = state.players[1 - pi]?.field || [];
  const te = String(card?.talentEffect || "");
  switch (te) {
    case "explosao":
      // Destruir P2 (ou P3 ferido): sem alvo que morra, guardar.
      for (const c of allFoes) {
        if (powerOf(c) <= 2 && !hasBarrier(c)) return 0.0;
      }
      return 3.0;
    case "medoTalento":
      // Tirar P2 perigoso: sem P2 perigoso, guardar.
      for (const c of allFoes) {
        if (powerOf(c) === 2 && _threatOf(c) >= 2.0) return 0.0;
      }
      return 3.0;
    case "baforadaVenenosa":
      // P2+ perigoso sem veneno: sem alvo perigoso, guardar.
      for (const c of allFoes) {
        if (powerOf(c) >= 2 && poisonTurns(c) === 0 && _threatOf(c) >= 2.0) return 0.0;
      }
      return 3.0;
    case "prisaoPrismaticaTalento":
      // Travar o atacante mais perigoso: sem alvo perigoso, guardar.
      for (const c of allFoes) {
        if (powerOf(c) >= 2 && !(c?.prisaoPrismatica ?? c?.prision ?? false) && _threatOf(c) >= 1.5) return 0.0;
      }
      return 3.0;
    case "doppelganger": {
      // Copiar o melhor P2 (Crescimento/Inspirar): sem motor
      // LIMPO, guardar — a cópia herda silêncio, veneno,
      // chamas e gelo e nasce condenada (livro, regra 6).
      for (const c of state.players[pi]?.field || []) {
        if (powerOf(c) === 2 && ["Crescimento", "Inspirar"].includes(String(c?.abilityName || ""))
          && !_duplicarAlvoRuim(c)) return 0.0;
      }
      return 3.0;
    }
    case "ressuscitarTalento": {
      // O último P2 do descarte: sem P2 perigoso lá, guardar.
      let bestR = 0.0;
      for (const c of state.players[pi]?.discard || []) {
        if (String(c?.category || "") === "champion" && (c?.power ?? 0) === 2) {
          bestR = Math.max(bestR, _threatOf(c));
        }
      }
      return bestR < 1.5 ? 3.0 : 0.0;
    }
    case "chuvaDeCometas":
      // Os P1 do adversário morrem: sem P1 para destruir, guardar.
      for (const c of allFoes) {
        if (powerOf(c) <= 1) return 0.0;
      }
      return 2.0;
    case "missemagicos": {
      // Vários adversários: com um só alvo, guardar.
      let n = 0;
      for (const c of allFoes) {
        if (!hasBarrier(c)) n += 1;
      }
      return n === 1 ? 2.0 : 0.0;
    }
    case "transformarBichinhoTalento":
      // P2+ forte sem Barreira: sem alvo forte, guardar.
      for (const c of allFoes) {
        if (powerOf(c) >= 2 && !hasBarrier(c) && _threatOf(c) >= 2.0) return 0.0;
      }
      return 2.0;
    case "tornadoDeFogo":
      // P2+ forte sem chamas e sem Barreira: sem alvo forte, guardar.
      for (const c of allFoes) {
        if (powerOf(c) >= 2 && !hasBarrier(c) && burnTurns(c) === 0 && _threatOf(c) >= 2.0) return 0.0;
      }
      return 2.0;
    case "bolaDeFogoTalento":
      // (Fase 2, livro regra 1) O -1 só vale quando mata agora
      // ou deixa o alvo ao alcance de um ataque neste turno —
      // sem abate à vista, guardar (2.0, como a habilidade
      // Bola de Fogo num P1 inofensivo).
      for (const c of allFoes) {
        if (powerOf(c) <= 1 && !hasBarrier(c) && !isApodrecida(c)) return 0.0;
      }
      if (_killAfterFireball(state, pi)) return 0.0;
      return 2.0;
    case "enfraquecerTalento": {
      // (Fase 2, livro regra 26) Guardar para a hora decisiva:
      // com ele longe de vencer (menos de 12 PV) e sem
      // vantagem, a carta vale mais guardada para quando o
      // ponto dele decidir a partida; com ele na frente no
      // meio do jogo, ou perto de vencer (12+), gastar agora.
      // ("Perto de vencer" = 12+, decisão da Fase 2.) O valor
      // é 4.0, não 3.0: gastar agora já ganha 1 PV (3.0) e até
      // 1.0 de atraso na vitória dele, então 3.0 não segura a
      // carta — 4.0 é o menor valor redondo que segura.
      const foeVp = state.players[1 - pi]?.vp ?? 0;
      const myVp = state.players[pi]?.vp ?? 0;
      if (foeVp < 12 && foeVp <= myVp) return 4.0;
      return 0.0;
    }
    default:
      break;
  }
  return 0.0;
}

function _guardSpent(state, pi, act) {
  const t = String(act?.type || "");
  if (t === "summon" || t === "talent") {
    const hi = act.hand_idx ?? -1;
    const hand = state.players[pi]?.hand || [];
    if (hi < 0 || hi >= hand.length) return 0.0;
    return guardValue(state, pi, hand[hi]);
  }
  return 0.0;
}

function _comboBonus(state, pi, act) {
  const t = String(act?.type || "");
  if (t === "summon" || t === "talent") {
    const hi = act.hand_idx ?? -1;
    const hand = state.players[pi]?.hand || [];
    if (hi < 0 || hi >= hand.length) return 0.0;
    const card = hand[hi];
    const oe = String(card?.onEnter || "");
    const te = String(card?.talentEffect || "");
    const eff = oe !== "" ? oe : te;
    if (eff === "" || !COMBOS[eff]) return 0.0;
    const entry = COMBOS[eff];
    const bonus = entry.bonus || 0.0;
    switch (String(entry.follow || "")) {
      case "zeroAbsoluto":
        if (_hasEffectInHand(state, pi, "zeroAbsoluto") && _foeFreezable(state, pi)) return bonus;
        break;
      case "congelado":
        for (const c of state.players[1 - pi]?.field || []) {
          if ((c.frozenTurns ?? 0) > 0) return bonus;
        }
        break;
      case "abate":
        if (_killAfterBuff(state, pi)) return bonus;
        break;
      case "cadeia":
        // (Livro 02, item 25) a Rapidez só vale com jogada
        // esperando — sem cadeia, o bônus é zero, não meio.
        if (eff === "rapidez" && !_rapidezChain(state, pi, card, hi)) return 0.0;
        if ((state.players[pi]?.hand || []).length <= 2) return bonus;
        return bonus * 0.5;
      case "retorno":
        if ((state.players[pi]?.discard || []).length > 0) return bonus;
        break;
      default:
        break;
    }
    return 0.0;
  }
  if (t === "ultimate") {
    const ut = heroUltType(state.players[pi] || {});
    if (ut === "thunderDiscard") {
      // (Livro 01) A Trovoada vale MAIS quando o adversário
      // tem poucas cartas: cada carta perdida dói mais — com
      // a mão curta, descartar 1 pode tirar a carta que
      // fecharia o jogo dele. O placar já dá 0,5 por carta
      // descartada (evaluate2); o bônus é o valor do momento.
      const fh = (state.players[1 - pi]?.hand || []).length;
      if (fh <= 2) return 3.0;
      if (fh <= 4) return 1.0;
    }
    return 0.0;
  }
  if (t === "attack") {
    const di = act.def_idx ?? -1;
    const foes = state.players[1 - pi]?.field || [];
    if (di < 0 || di >= foes.length) return 0.0;
    const defc = foes[di];
    if (statusedSet(state).has(defc?.uid)) {
      const ai = act.att_idx ?? -1;
      const mine = state.players[pi]?.field || [];
      if (ai >= 0 && ai < mine.length) {
        const out = DfRules.combatOutcome(mine[ai], defc);
        if (out?.killD) return -6.0;
      }
    }
  }
  return 0.0;
}

function _hasEffectInHand(state, pi, effect) {
  for (const c of state.players[pi]?.hand || []) {
    if (String(c?.onEnter || "") === effect || String(c?.talentEffect || "") === effect) return true;
  }
  return false;
}

function _foeFreezable(state, pi) {
  for (const c of foesOf(state, pi)) {
    if ((c.frozenTurns ?? 0) === 0 && !hasBarrier(c)) return true;
  }
  return false;
}

function _killAfterBuff(state, pi) {
  const mine = state.players[pi]?.field || [];
  const foes = state.players[1 - pi]?.field || [];
  for (let ai = 0; ai < mine.length; ai++) {
    const att = mine[ai];
    if (!att || att.tapped) continue;
    for (let di = 0; di < foes.length; di++) {
      if (!DfRules.canAttack(state, pi, ai, 1 - pi, di)?.ok) continue;
      if (powerOf(foes[di]) <= powerOf(att) + 1) return true;
    }
  }
  return false;
}

// (Fase 2, livro regra 1) Um abate é possível DEPOIS da Bola de
// Fogo (-1 no alvo): algum aliado destapado destrói um adversário
// sem Barreira cujo Poder, menos 1, cabe no Poder dele.
function _killAfterFireball(state, pi) {
  const mine = state.players[pi]?.field || [];
  const foes = state.players[1 - pi]?.field || [];
  for (let ai = 0; ai < mine.length; ai++) {
    const att = mine[ai];
    if (!att || att.tapped) continue;
    for (let di = 0; di < foes.length; di++) {
      const f = foes[di];
      if (isOwnCharmed(f, pi)) continue;
      if (hasBarrier(f)) continue;
      if (!canAttackOk(state, pi, ai, di)) continue;
      if (powerOf(f) - 1 <= powerOf(att)) return true;
    }
  }
  return false;
}

// (Fase 2, livro regra 6) Este aliado é um alvo condenado para o
// Duplicar: a cópia herda o status e nasce condenada.
function _duplicarAlvoRuim(c) {
  return !!c?.silenced || poisonTurns(c) > 0 || burnTurns(c) > 0 || frozenTurns(c) > 0;
}

// (Livro §7a/§7b) Bônus de situação: o valor de uma jogada que o
// placar não vê — remoção em área contra campo cheio, castigo de
// mão cheia, e o AMEDRONTAR que exila em vez de devolver (conta
// como abate). Soma ao bônus de combo no feixe; 0,0 fora do gatilho.
function _situationBonus(state, pi, act) {
  const foes = state.players[1 - pi]?.field || [];
  const foeHandN = (state.players[1 - pi]?.hand || []).length;
  const t = String(act?.type || "");
  if (t === "ultimate") {
    const ut = heroUltType(state.players[pi] || {});
    // §7a: COMETA ESTRELAR contra o campo cheio (5+).
    if (ut === "cometStarfall" && foes.length >= 5) return 1.0;
    // §7b: TROVOADA contra a mão cheia (7+).
    if (ut === "thunderDiscard" && foeHandN >= 7) return 1.0;
    return 0.0;
  }
  if (t !== "summon" && t !== "talent") return 0.0;
  const hi = act.hand_idx ?? -1;
  const hand = state.players[pi]?.hand || [];
  if (hi < 0 || hi >= hand.length) return 0.0;
  const card = hand[hi];
  const oe = String(card?.onEnter || "");
  const te = String(card?.talentEffect || "");
  const eff = oe !== "" ? oe : te;
  let bonus = 0.0;
  // §7a: campo dele com 5+ campeões — remoção em área e multi-alvo.
  if (foes.length >= 5 && ["chuvaDeCometas", "missemagicos", "explosao", "medoTalento"].includes(eff)) {
    bonus += 1.0;
  }
  // §7b: mão dele com 7+ cartas — BOLHAS e ROUBAR castigam a mão cheia.
  if (foeHandN >= 7 && ["bolhas", "bolhasTalento", "roubar"].includes(eff)) {
    bonus += 1.0;
  }
  // §7b: AMEDRONTAR num P2 com a mão dele CHEIA (8) manda o campeão
  // para o descarte em vez de devolver — conta como abate: o valor
  // do PV do abate (3,0). Com 7 cartas ele ainda volta para a mão.
  if (eff === "medoTalento" && foeHandN >= 8) {
    for (const c of foes) {
      if (powerOf(c) === 2) {
        bonus += 3.0;
        break;
      }
    }
  }
  return bonus;
}

// ------------------------------------------------------------------
// Pré-condições de instantânea — tabela do GDScript (ai_brain _oe_usable)
// traduzida para os campos JS. `cost` é o custo da invocação.
// ------------------------------------------------------------------
function _canAttackAfterGrito(state, pi, cost) {
  const p = state.players[pi] || {};
  const foes = foesOf(state, pi);
  if (!foes.length) return false;
  const attackers = [];
  for (const a of p.field || []) {
    if (a?.silenced || isApodrecida(a)) continue;
    attackers.push(a);
  }
  const statused = statusedSet(state);
  for (const a of attackers) {
    if (a?.tapped || (a?.frozenTurns ?? 0) > 0 || !!a?.charme) continue;
    const pa = powerOf(a) + 1;
    for (const f of foes) {
      if (f?.shielded || !!f?.charme) continue;
      const resistente = f?.abilityName === "Resistente" && !f?.silenced;
      const investida = a?.freeAttack || a?.constantEffect === "investida"
        || (a?.abilityType === "constant" && a?.abilityName === "Investida");
      if (resistente && (investida || !!a?.freeAttack || !!a?.prisaoPrismatica || !!a?.urso_pesado)) continue;
      if ((p.actions ?? 0) - cost < attackCost(a, f)) continue;
      const pd = powerOf(f);
      const oa = isOverpower(a);
      const od = isOverpower(f);
      let killD = false;
      if (pa > pd) killD = true;
      else if (pa === pd && ((oa && !od) || (!oa && !od))) killD = true;
      if (!killD) continue;
      if (statused.has(f?.uid)) continue;
      return true;
    }
  }
  return false;
}

function _gritoWorthIt(state, pi, cost) {
  const foes = foesOf(state, pi);
  if (!foes.length) {
    for (const a of state.players[pi]?.field || []) {
      if (!a?.silenced && !isApodrecida(a)) return true;
    }
    // (1.51.99) A carta invocada NÃO conta: o Grito dá Fúria aos
    // aliados MENOS a si mesma — sem nenhum outro aliado, não
    // vale nunca.
    return false;
  }
  return _canAttackAfterGrito(state, pi, cost);
}

function _canAttackAfterTecnicas(state, pi, cost) {
  const p = state.players[pi] || {};
  const foes = foesOf(state, pi);
  if (!foes.length) return false;
  const field = p.field || [];
  for (let ai = 0; ai < field.length; ai++) {
    const a = field[ai];
    if (!a || a.silenced) continue;
    if (isOverpower(a)) continue;
    for (let fi = 0; fi < foes.length; fi++) {
      if (!DfRules.canAttack(state, pi, ai, 1 - pi, fi)?.ok) continue;
      if ((p.actions ?? 0) - cost < attackCost(a, foes[fi])) continue;
      return true;
    }
  }
  return false;
}

export function onEnterUsable(state, pi, oe, cost = 0, extra = null) {
  if (!oe) return true;
  const foes = foesOf(state, pi);
  const allies = state.players[pi]?.field || [];
  const pl = state.players[pi] || {};
  const used = bolhasSet(state);
  switch (oe) {
    case "assassinar":
      return foes.some((c) => powerOf(c) === 1 && !hasBarrier(c));
    case "transformarBichinho":
      return foes.some((c) => powerOf(c) >= 2 && !hasBarrier(c));
    case "separar":
      return foes.some((c) => powerOf(c) === 2 && !c.inspiracao && !c.wallBuff && (c.furyStacks ?? 0) === 0);
    case "mordidaVenenosa": case "fumacaToxica":
      return foes.some((c) => (c.poisonTurns ?? 0) === 0);
    case "rajadaCongelante":
      return foes.length > 0;
    case "prisaoPrismatica":
      return foes.some((c) => !c.prisaoPrismatica);
    case "bolaDeFogo":
      return foes.some((c) => !hasBarrier(c));
    case "incendiar":
      return foes.some((c) => !hasBarrier(c) && !c.burning);
    case "necromancia":
      return (pl.discard || []).length > 0;
    case "raioDuplo":
      return foes.some((c) => !hasBarrier(c));
    case "energizar": {
      const maxUlt = getEffectiveMaxUltimateUses(pl, pl.heroDef?.id || pl.heroId);
      return (pl.ultimateUses ?? 0) < maxUlt && !pl.usedUltimateThisTurn;
    }
    case "invokeDragon":
      return allies.length < 6 - 1;
    case "fortalecer":
      return allies.some((c) => c && !isApodrecida(c));
    case "ursificacao": case "devorar":
      return allies.length > 0;
    case "corromper":
      return allies.some((c) => c && !c.corrupted && !c.silenced);
    case "roubar":
      return (state.players[1 - pi]?.hand || []).length > 0;
    case "bolhas":
      return (state.players[1 - pi]?.hand || []).length > 0 && !used.has("bolhas");
    case "enfraquecer":
      return (state.players[1 - pi]?.vp ?? 0) > 0;
    case "podridao":
      return (state.players[1 - pi]?.deck || []).length > 0;
    case "gritoDeGuerra":
      return _gritoWorthIt(state, pi, cost);
    case "guardiao":
      return allies.some((c) => c && !c.silenced);
    case "charme":
      return foes.length > 0;
    case "trocaInjusta":
      return foes.some((c) => powerOf(c) === 2);
    case "tecnicasDeCombate":
      return _canAttackAfterTecnicas(state, pi, cost);
    case "roletaRussa":
      return allies.length < foes.length;
    case "imitar":
      for (const c of allies) {
        if (!c) continue;
        if (!String(c.abilityName || "") || ["Ritual", "Ritual Superior"].includes(String(c.abilityName || "")) || c.silenced) continue;
        const copied = String(c.onEnter || "");
        if (copied === "") return true;
        if (copied === "imitar") continue;
        if (onEnterUsable(state, pi, copied, cost)) return true;
      }
      return false;
    case "pesadelo":
      return !used.has("pesadelo");
    default:
      return true;
  }
}

// ------------------------------------------------------------------
// Portões da correção 1.51.97 (espelhos de _best_talent,
// _ultimate_allowed, _ult_damage_worth_it, _reuse_candidate_ok,
// _free_attack_kill_possible e _investida_talento_worth_it).
// Vivem no porte (não no cérebro): o cérebro é a substituta e
// não pode mudar fora do planejador; e os daqui seguem o GDScript
// à risca (ex.: o portão da Investida olha só a constante, sem
// o freeAttack — o cérebro olha os dois).
// ------------------------------------------------------------------
function _strongestIn(arr) {
  let best = null;
  for (const c of arr || []) {
    if (!c) continue;
    if (!best || powerOf(c) > powerOf(best)) best = c;
  }
  return best;
}

// (Escola Grupo 1) Tabela de uso de talentos: quando o talento
// VALE ser jogado. Filtro duro, não peso — vale nos dois caminhos
// do planejador (candidatas do feixe e conferência do retorno do
// cérebro antigo). Cada entrada espelha um portão já aprovado do
// cérebro antigo, salvo as duas marcadas como NOVO, cobertas por
// teste da escola. Prisão Prismática e Zero Absoluto NÃO são
// vetados pela Barreira, como manda a tabela. O Fortalecer (+1 de
// Poder) não é status e vale com qualquer aliado sem apodrecida,
// inclusive silenciado — só os status da lista (Crescimento,
// Investida, Sobrepujar, Fúria, Proteção, Barreira, Corromper,
// Inspirar) são vetados no silenciado.
// (O custo é o de can_play: Poder atual — talento tem Poder 0,
// custo 0; só o Grito o usa, via _gritoWorthIt.)
function _talentUsable(state, pi, eff, cost = 0) {
  const p = state.players[pi] || {};
  const foes = foesOf(state, pi);
  const allies = p.field || [];
  switch (String(eff || "")) {
    case "bolaDeFogoTalento":
      return foes.some((c) => !hasBarrier(c));
    case "explosao":
      return foes.some((c) => !hasBarrier(c) && powerOf(c) !== 1);
    case "transformarBichinhoTalento":
      return foes.some((c) => powerOf(c) >= 2 && !hasBarrier(c));
    case "tornadoDeFogo":
      return foes.some((c) => !hasBarrier(c) && powerOf(c) !== 1 && burnTurns(c) === 0);
    case "missemagicos":
      // NOVO: Mísseis sempre erram quem tem Barreira — sem
      // alvo sem Barreira, nenhum míssil acerta.
      return foes.some((c) => !hasBarrier(c));
    case "baforadaVenenosa":
      if (_hookReady(state, pi)) {
        return foes.some((c) => powerOf(c) >= 3 && poisonTurns(c) === 0);
      }
      return foes.some((c) => powerOf(c) !== 1 && poisonTurns(c) === 0);
    case "prisaoPrismaticaTalento":
      return foes.some((c) => powerOf(c) !== 1 && !(c?.prisaoPrismatica ?? c?.prision ?? false));
    case "zeroAbsoluto":
      return foes.some((c) => frozenTurns(c) > 0 || powerOf(c) >= 2);
    case "medoTalento":
      return foes.some((c) => powerOf(c) === 2);
    case "chuvaDeCometas":
      return foes.length > allies.length;
    case "fortalecerTalento":
      return allies.some((c) => c && !isApodrecida(c));
    case "corromperTalento":
      return allies.some((c) => c && !c.corrupted && !c.silenced);
    case "gritoDeGuerraTalento":
      return _gritoWorthIt(state, pi, cost);
    case "investidaTalento":
      return _investidaTalentWorthIt(state, pi);
    case "tecnicasDeCombateTalento":
      return _canAttackAfterTecnicas(state, pi, cost);
    case "barreira":
      // NOVO: silenciado não recebe Barreira (o motor nem
      // aplica) — sem aliado não silenciado, o talento não
      // protege ninguém.
      return allies.length > 0 && foes.length > 0
        && allies.some((c) => c && !c.silenced);
    case "doppelganger": {
      // (Fase 2, livro regra 6) A cópia precisa de lugar no
      // campo e herda tudo do original: nunca copiar
      // silenciado, envenenado, em chamas ou congelado.
      if (allies.length >= 6) return false;
      for (const c of allies) {
        if (powerOf(c) === 2 && !_duplicarAlvoRuim(c)) return true;
      }
      return false;
    }
    case "ressuscitarTalento":
      return (p.discard || []).some((c) => c && c.category === "champion" && (c.power ?? 0) === 2)
        && allies.length < 6;
    case "trocaDeLugar":
      return allies.some((c) => c && powerOf(c) === 1)
        && foes.some((c) => powerOf(c) === 2);
    case "podridaoTalento":
      // (Escola Grupo 6) Com 4 pilhas ou baralho vazio, a
      // Podridão não apodrece mais nada.
      return (state.players[1 - pi]?.deck || []).length > 0
        && podridaoStacksOf(state.players[1 - pi]) < 4;
    case "bolhasTalento":
      return (state.players[1 - pi]?.hand || []).length > 0
        && !bolhasSet(state).has("bolhas");
    case "enfraquecerTalento":
      return (state.players[1 - pi]?.vp ?? 0) > 0;
    case "desacelerarTalento":
      // (Fase 2, livro regra 25) A 2ª não tira outra ação
      // (o marcador é um só).
      return !state.players[1 - pi]?.skipNextAction;
    case "invocarDragaoTalento":
      return allies.length < 6;
    case "arsenalDeGuerra":
      // (Escola Grupo 6) Com a mão cheia, o Arsenal não compra
      // nada — os saques não acontecem.
      return (p.hand || []).length < 8;
    case "protecaoDivina": case "bloquearAtaque":
      return allies.length > 0 && foes.length > 0;
    case "contramagica": case "exaustao":
      return foes.length > 0 || (state.players[1 - pi]?.hand || []).length > 0;
    default:
      return true;
  }
}

function _ultDamageWorthIt(state, pi, ut) {
  const foes = foesOf(state, pi);
  if (!foes.length) return false;
  switch (ut) {
    case "targetEnemy": {
      const t = _strongestIn(foes);
      return !!t && powerOf(t) <= 1;
    }
    case "targetEnemyFreeze": {
      const t = _strongestIn(foes);
      return !!t && powerOf(t) >= 2 && (t.frozenTurns ?? 0) === 0;
    }
    case "fireAndIce":
      if (foes.length === 1 && powerOf(foes[0]) === 1) return false;
      return true;
    case "banish":
      return foes.some((c) => powerOf(c) === 2);
    case "scareReturn":
      return foes.some((c) => powerOf(c) === 2);
    case "vampirism":
      return foes.some((c) => powerOf(c) >= 2)
        && (state.players[pi]?.field || []).some((c) => c && !isApodrecida(c));
    case "incinerate": {
      // Mesmo pool efetivo do pick (sem Barreira, menos o
      // enfeitiçado — já fora de foes), com preferência DURA
      // por sem-queimadura: sem alvo limpo, não vale.
      const eff = foes.filter((c) => !hasBarrier(c));
      const effClean = eff.filter((c) => (c.burningTurns ?? 0) === 0 && !c.burning);
      if (!effClean.length) return false;
      const t = _strongestIn(effClean);
      return !!t && powerOf(t) >= 2;
    }
    case "poison":
      return foes.some((c) => powerOf(c) >= 2 && (c.poisonTurns ?? 0) === 0);
    case "hook":
      // (1.51.96 item 8) EXCETO envenenado: roubar um campeão
      // com veneno é ficar com um campeão que morre em 2
      // rodadas no próprio campo — só vale com um P1/P2 LIMPO.
      return (state.players[pi]?.field || []).length < 6
        && foes.some((c) => (powerOf(c) === 1 || powerOf(c) === 2) && !isApodrecida(c) && (c.poisonTurns ?? 0) === 0);
    case "cometStarfall": {
      let myP1 = 0;
      for (const c of state.players[pi]?.field || []) if (powerOf(c) <= 1) myP1 += 1;
      let foeP1 = 0;
      for (const c of foes) if (powerOf(c) <= 1) foeP1 += 1;
      return foeP1 > myP1 && foes.length > (state.players[pi]?.field || []).length;
    }
    default:
      return false;
  }
}

function _reuseCandidateOk(state, pi, c) {
  if (String(c?.abilityType || "") !== "instant" || String(c?.onEnter || "") === "" || c?.silenced) return false;
  const oe = String(c?.onEnter || "");
  if ((oe === "bolhas" || oe === "pesadelo") && bolhasSet(state).has(oe)) return false;
  if (oe === "trocaInjusta" && !onEnterUsable(state, pi, oe)) return false;
  return true;
}

function _freeAttackKillPossible(state, pi) {
  const p = state.players[pi] || {};
  const foes = foesOf(state, pi);
  if (!foes.length) return false;
  const valid = [];
  for (const a of p.field || []) {
    if (!a || a.tapped || isApodrecida(a) || a.silenced) continue;
    if (powerOf(a) < 2) continue;
    // (1.51.55 item 6) INVESTIDA nunca 2x no mesmo aliado.
    if (a.constantEffect === "investida" || (a.abilityType === "constant" && a.abilityName === "Investida")) continue;
    valid.push(a);
  }
  if (!valid.length) return false;
  const att = _strongestIn(valid);
  if (!att) return false;
  if ((att.frozenTurns ?? 0) > 0 || !!att.frozen || !!att.charme || (att.charmeTurns ?? 0) > 0) return false;
  const pa = powerOf(att);
  for (const f of foes) {
    if (f?.shielded || !!f?.charme || (f?.charmeTurns ?? 0) > 0) continue;
    if (f?.abilityName === "Resistente" && !f?.silenced) continue;
    const pd = powerOf(f);
    const oa = isOverpower(att);
    const od = isOverpower(f);
    let killD = false;
    if (pa > pd) killD = true;
    else if (pa === pd && ((oa && !od) || (!oa && !od))) killD = true;
    if (!killD) continue;
    if (statusedSet(state).has(f?.uid)) continue;
    return true;
  }
  return false;
}

function _investidaTalentWorthIt(state, pi) {
  const p = state.players[pi] || {};
  let hasAlly = false;
  for (const a of p.field || []) {
    if (!a || a.tapped || isApodrecida(a) || a.silenced) continue;
    if (powerOf(a) < 2) continue;
    if (a.constantEffect === "investida" || (a.abilityType === "constant" && a.abilityName === "Investida")) continue;
    hasAlly = true;
    break;
  }
  if (!hasAlly) return false;
  if (!foesOf(state, pi).length) return true;
  return _freeAttackKillPossible(state, pi);
}

// (Livro 01, ULTIMATES) Fim de jogo: turno 11 em diante (a fase
// manda o TURNO) ou alguém com 12+ pontos (maior ponto >= 12 é o
// "perto de alguém vencer"). Ultimates que precisam de rodadas pela
// frente perdem quase todo o valor aqui.
function _isLateGame(state) {
  if (turnNumberOf(state) >= 11) return true;
  const bestVp = Math.max(state.players[0]?.vp ?? 0, state.players[1]?.vp ?? 0);
  return bestVp >= 12;
}

/** A Ultimate só entra nas candidatas quando a pré-condição do
 * cérebro antigo (1.51.96) vale — as mesmas travas do
 * `_legacy_next_action`, sem inventar nenhuma. Peso não fura
 * regra dura.
 * (Livro 01, ULTIMATES) Por cima delas, as regras de momento do
 * livro — vetos de fim de jogo, Barreira no Vampirismo, mão cheia
 * na Conjuração e no Amedrontar — moram aqui, no planejador, porque
 * o cérebro antigo (ai_brain.gd) não pode mudar nesta frente. */
function _ultimateAllowed(state, pi) {
  const p = state.players[pi] || {};
  const foes = foesOf(state, pi);
  const ut = heroUltType(p);
  // (Livro 01) Ultimates de tempo — Veneno (2 rodadas para matar),
  // Incinerar (4 rodadas de fogo) e Força Infinita (crescimento por
  // rodada) — perdem quase todo o valor no fim do jogo: no fim,
  // prefira abate imediato.
  if (["poison", "incinerate", "infinitePower"].includes(ut) && _isLateGame(state)) {
    return false;
  }
  switch (ut) {
    case "targetEnemy": {
      // (Aprendizado) Portão da Bomba ABERTO: o Rei Bomba é o
      // único herói targetEnemy. Vale quando o mais forte tem
      // Poder 1 (abate) ou 2 (a Bomba o amolece para 1,
      // preparando o abate). O mais forte com Poder 3+
      // continua vetado. O motor sempre mira o mais forte:
      // um P1 só é alvo quando é o mais forte do campo (o
      // caso de abate, que não muda).
      if (!foes.length) return false;
      let strongest = 0;
      for (const c of foes) strongest = Math.max(strongest, powerOf(c));
      return strongest >= 1 && strongest <= 2;
    }
    case "targetEnemyFreeze": case "fireAndIce":
    case "banish": case "incinerate": case "poison": case "hook": case "cometStarfall":
      return _ultDamageWorthIt(state, pi, ut);
    case "vampirism":
      // (Livro 01) Barreira bloqueia redução de Poder — o
      // Vampirismo nunca mira quem tem Barreira (o -1 se
      // perderia no reduce_power e só o +1 aconteceria). O
      // portão do cérebro antigo não filtra Barreira; aqui
      // vale o mesmo critério dele (P2+ + aliado sem
      // apodrecida) sobre o pool sem Barreira.
      return foes.some((c) => powerOf(c) >= 2 && !hasBarrier(c))
        && (p.field || []).some((c) => c && !isApodrecida(c));
    case "scareReturn":
      // (Livro 01) Amedrontar só em P2 exato — e nunca com a
      // mão dele cheia: o campeão iria ao descarte em vez de
      // voltar à mão, e poderia voltar com Necromancia.
      return foes.some((c) => powerOf(c) === 2)
        && (state.players[1 - pi]?.hand || []).length < 8;
    case "targetAlly":
      return (p.field || []).length > 0;
    case "infinitePower":
      return (p.field || []).some((c) => c && !c.silenced);
    case "reuseInstant":
      return (p.field || []).some((c) => _reuseCandidateOk(state, pi, c));
    case "potion":
      return (p.field || []).some((c) => c && !isApodrecida(c) && powerOf(c) === 2);
    case "targetAllyShield":
      return (p.field || []).some((c) => c && powerOf(c) === 1 && !c.silenced);
    case "targetAllyFreeAttack":
      return _freeAttackKillPossible(state, pi);
    case "drawCard":
      // (Livro 01) Conjuração nunca com a mão cheia (8 cartas
      // — a carta não vem e o uso é gasto) nem com o baralho
      // vazio (também não vem carta).
      return (p.hand || []).length < 8 && (p.deck || []).length > 0;
    case "thunderDiscard":
      return (state.players[1 - pi]?.hand || []).length > 0;
    case "summonDragon":
      return (p.field || []).length < 6;
    case "trickerySwap":
      return (p.field || []).some((c) => c && powerOf(c) === 1)
        && foes.some((c) => powerOf(c) === 2);
    case "resurrect":
      return (p.discard || []).some((c) => c && c.category === "champion" && (c.power ?? 0) === 2)
        && (p.field || []).length < 6;
    default:
      return false;
  }
}

// (Livro 03) Contexto de remoção, calculado uma vez por geração de
// candidatas: quem é matável por quem, o maior Poder do meu campo,
// e quais prioridades de remoção estão na mesa neste estado.
function _livroAttackCtx(state, pi) {
  const foes = state.players[1 - pi]?.field || [];
  const mine = state.players[pi]?.field || [];
  const ctx = {
    killers: [], maxPw: 0,
    cresc: false, insp: false, laco: false, nonLast: false,
    freeKill: false,
  };
  for (const c of mine) ctx.maxPw = Math.max(ctx.maxPw, powerOf(c));
  for (let di = 0; di < foes.length; di++) {
    const ks = [];
    for (let ai = 0; ai < mine.length; ai++) {
      if (!canAttackOk(state, pi, ai, di)) continue;
      if (combatKill(mine[ai], foes[di])) {
        ks.push(ai);
        // §7(a) Há um abate livre na mesa: uma Investida com
        // o ataque livre pronto destrói este adversário.
        if (constOf(mine[ai]) === "investida" && mine[ai]?.freeAttack) {
          ctx.freeKill = true;
        }
      }
    }
    ctx.killers.push(ks);
    if (!ks.length) continue;
    const ab = String(foes[di]?.abilityName || "");
    switch (ab) {
      case "Crescimento":
        ctx.cresc = true;
        break;
      case "Inspirar":
        ctx.insp = true;
        break;
      case "Laço de Sangue":
        if (!foes[di]?.silenced && _lacoArmed(state, pi, foes[di])) ctx.laco = true;
        break;
      default:
        break;
    }
    if (ab !== "Vingança" && ab !== "Legado") ctx.nonLast = true;
  }
  return ctx;
}

// (Livro 03) Há redução jogável na mão que quebra ESTA Muralha?
// Bola de Fogo / Raio Duplo (instantânea ou talento) em qualquer
// Muralha sem Barreira; Assassinar só se ela está com Poder 1.
// Não vale contra Barreira — o livro já manda nunca mirar nela.
function _livroReductionFor(state, pi, defc) {
  if (hasBarrier(defc)) return false;
  const hand = state.players[pi]?.hand || [];
  const playable = _playableHandIdxs(state, pi);
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (!card || !playable.has(i)) continue;
    if (String(card.category || "") === "champion" && String(card.abilityType || "") === "instant") {
      const oe = String(card.onEnter || "");
      if (oe === "bolaDeFogo" || oe === "raioDuplo") {
        if (onEnterUsable(state, pi, oe, championSummonCost(card))) return true;
      } else if (oe === "assassinar") {
        if (powerOf(defc) === 1 && onEnterUsable(state, pi, oe, championSummonCost(card))) return true;
      }
    } else if (String(card.category || "") === "talent"
      && String(card.talentEffect || "") === "bolaDeFogoTalento") {
      if (_talentUsable(state, pi, "bolaDeFogoTalento", championSummonCost(card))) return true;
    }
  }
  return false;
}

// (Livro 03) Este ataque é permitido pelas regras de remoção? A
// ordem de composição dá a prioridade final: Crescimento > fonte
// de Inspirar > Laço armado > normal > Vingança/Legado por último.
// Regra isolada que não entra no filtro: a exceção do §7(b) (o alvo
// do ataque livre ficaria com 1 de Poder para outro aliado abater)
// é vazia neste motor — o combate nunca reduz Poder, só mata ou não
// mata — então o ataque livre só mira o que ele destrói.
function _livroAttackAllowed(state, pi, ai, di, ctx) {
  const mine = state.players[pi]?.field || [];
  const foes = state.players[1 - pi]?.field || [];
  if (ai < 0 || ai >= mine.length || di < 0 || di >= foes.length) return false;
  const att = mine[ai];
  const defc = foes[di];
  const defAb = String(defc?.abilityName || "");
  // §7(a) O ataque livre é sempre o PRIMEIRO ataque do turno:
  // enquanto houver um abate livre na mesa, nenhum ataque pago
  // entra nas candidatas — o livre não custa ação, então fazê-lo
  // primeiro nunca tira a chance do pago. (Invocar ou jogar
  // talento antes dele continua valendo: a regra é sobre a ordem
  // dos ataques, não sobre a primeira ação do turno.)
  if (ctx.freeKill && !(constOf(att) === "investida" && att?.freeAttack)) return false;
  // §9(b) O Crescimento é sempre o primeiro alvo de remoção.
  if (ctx.cresc && defAb !== "Crescimento") return false;
  // §10(b) A fonte de Inspirar é removida antes dos vizinhos
  // buffados — matar o vizinho não tira o buff dos outros.
  if (ctx.insp && (defc?.inspirarBuff ?? 0) > 0) return false;
  // §13(b) O Laço armado é removido antes dos outros alvos de
  // ameaça 1,0 (os de ameaça maior passam na frente dele).
  if (ctx.laco && defAb !== "Laço de Sangue" && _threatOf(defc) === 1.0) return false;
  // §5(b)/§6(b) A Vingança e o Legado são os últimos a ser
  // destruídos quando há outro alvo matável na mesa.
  if ((defAb === "Vingança" || defAb === "Legado") && ctx.nonLast) return false;
  // §5(a) Não destruir a Vingança com o melhor campeão em campo
  // quando outro aliado de menor Poder pode matá-la. (Ressalva: o
  // alvo da Vingança é aleatório, então o risco de perder 1 de
  // Poder não some — só diminui. O torneio mede o efeito.)
  if (defAb === "Vingança" && powerOf(att) === ctx.maxPw) {
    for (const otherAi of (ctx.killers[di] || [])) {
      if (otherAi !== ai && powerOf(mine[otherAi]) < powerOf(att)) return false;
    }
  }
  // §11(b) Contra a Muralha, a primeira ação é sempre a redução —
  // nunca o ataque direto, quando há redução na mão para ela.
  // (No JS, wallBuff é o bônus ativo: verdadeiro = muralha íntegra.)
  if (constOf(defc) === "muralha" && !!defc?.wallBuff) {
    if (_livroReductionFor(state, pi, defc)) return false;
  }
  // §2(a) Recompensa Dupla nunca ataca P2+ sem +1 de reforço
  // ativo ou Sobrepujar.
  if (constOf(att) === "recompensaDupla" && !att?.silenced) {
    if (powerOf(defc) > powerOf(att)) {
      const buffed = powerOf(att) > (att?.power ?? 0);
      if (!buffed && !isOverpower(att)) return false;
    }
  }
  // §3(a) Nunca atacar com Poder igual uma campeã com Sobrepujar
  // (neste motor: a que vence empates — habilidade ou Técnicas).
  if (isOverpower(defc) && powerOf(att) === powerOf(defc)) return false;
  // §3(b) Nunca atacar com Sobrepujar um Poder maior, só igual
  // ou menor.
  if (isOverpower(att) && powerOf(defc) > powerOf(att)) return false;
  // §7(a)/§7(b) O ataque livre da Investida é o primeiro ataque
  // do turno e mira o adversário mais fraco que ela destrói —
  // nunca um alvo que ela não destrói. A prioridade de remoção de
  // 1º nível (Crescimento, fonte de Inspirar, Laço armado) passa
  // na frente do mais fraco.
  if (constOf(att) === "investida" && att?.freeAttack) {
    if (!combatKill(att, defc)) return false;
    const defFirstTier = defAb === "Crescimento" || defAb === "Inspirar"
      || (defAb === "Laço de Sangue" && ctx.laco);
    if (!defFirstTier) {
      for (let ej = 0; ej < foes.length; ej++) {
        if (ej === di) continue;
        const e = foes[ej];
        if (powerOf(e) >= powerOf(defc)) continue;
        if (!canAttackOk(state, pi, ai, ej)) continue;
        if (combatKill(att, e)) return false;
      }
    }
  }
  return true;
}

// ------------------------------------------------------------------
// Candidatos + poda (espelho de _candidate_actions / _prune_candidates)
// ------------------------------------------------------------------
function _candidateActions(state, pi) {
  const out = [];
  const p = state.players[pi] || {};
  const hand = p.hand || [];
  const legal = _legalActionsCached(state, pi);
  const summonIdxs = new Set(legal.filter((a) => a?.type === "SUMMON").map((a) => a.handIdx));
  const talentPlays = new Map();
  for (const tp of _talentPlaysCached(state, pi)) talentPlays.set(tp.handIdx, tp);
  for (let i = 0; i < hand.length; i++) {
    const card = hand[i];
    if (!card) continue;
    if (card.category === "especial" || isApodrecida(card)) continue;
    if (String(card.subcategory || "") === "reaction") continue;
    if (card.category === "champion") {
      if (!summonIdxs.has(i)) continue;
      const oe = String(card.onEnter || "");
      if (String(card.abilityType || "") === "instant" && oe !== "") {
        const cost = championSummonCost(card);
        // A tabela _oe_usable NÃO recebe a carta (o Grito da
        // tabela não conta a invocada — só o _best_summon conta;
        // ver decisão no plano).
        if (!onEnterUsable(state, pi, oe, cost)) continue;
        // (Livro 02, grupo INSTANTÂNEAS) os portões do livro
        // além da tabela — sem eles o feixe gastava a carta
        // só pelo corpo (ver `_instantExtraBlocked`).
        if (_instantExtraBlocked(state, pi, card, i)) continue;
        if (oe === "roletaRussa" && !_isLosing(state, pi)) continue;
      }
      // (Escola Grupo 6) A Podridão não apodrece nada com 4
      // pilhas ou baralho vazio — o motor nem aplica o efeito.
      if (oe === "podridao" && (podridaoStacksOf(state.players[1 - pi]) >= 4
        || (state.players[1 - pi]?.deck || []).length === 0)) continue;
      // (Escola Grupo 5) Poder 1 no campo: fora da inundação
      // e ganhando com folga, o corpo parado só dá alvo fácil.
      if (_p1SummonBlocked(state, pi, card)) continue;
      // (Livro 03) O que nunca se invoca — Legado sem herdeiro,
      // Crescimento depois do turno 10, Inspirar sem vizinho,
      // Laço sem alvo, Aura silenciada, Desafiante com aliado
      // ou depois dela no mesmo turno.
      if (_livroSummonBlocked(state, pi, card) || _livroDesafianteLock(state, pi)) continue;
      out.push({ type: "summon", hand_idx: i });
    } else if (card.category === "talent") {
      // (Escola Grupo 1) Portão duro da tabela de uso: talento
      // sem efeito certo nem entra nas candidatas — o feixe
      // não pode "descobrir" que gastar à toa vale a pena.
      const eff = String(card.talentEffect || "");
      if (!_talentUsable(state, pi, eff, powerOf(card))) continue;
      const play = talentPlays.get(i);
      if (play) {
        out.push({ type: "talent", hand_idx: i, talentPlay: play });
        continue;
      }
      // Talento AUTO legal pelo motor, mesmo que o cérebro não o liste.
      if (TALENT_AUTO_EFFECTS.has(String(card.talentEffect || ""))) {
        const chk = DfEngine.validateAction(state, { type: "TALENT_START", playerId: pi, handIdx: i });
        if (chk?.ok) out.push({ type: "talent", hand_idx: i, talentPlay: { type: "TALENT_START", playerId: pi, handIdx: i, _talentEffect: card.talentEffect } });
      }
    }
  }
  const foes = state.players[1 - pi]?.field || [];
  const atkCtx = _livroAttackCtx(state, pi);
  for (const a of legal) {
    if (a?.type === "ATTACK_RESOLVE") {
      const ai = a.attackerIdx;
      const di = a.defenderIdx;
      if (!_livroAttackAllowed(state, pi, ai, di, atkCtx)) continue;
      const defc = foes[di];
      // (Livro §1) Sobrepujar: o empate conta como derrota —
      // só entra o ataque com Poder ESTRITAMENTE maior que
      // o do defensor (o buff da mesma sequência muda a
      // conta depois: no estado após o buff o ataque entra).
      if (isOverpower(defc) && powerOf((p.field || [])[ai]) <= powerOf(defc)) continue;
      // (Livro §4) Inundação: nenhum ataque contra o forte
      // imbatível entra na lista — castigam-se os outros.
      if (_foeUnbeatable(state, pi, di)) continue;
      out.push({ type: "attack", att_idx: ai, def_idx: di });
    }
  }
  void foes;
  const ult = _ultimateAllowed(state, pi)
    ? (pickUltimate(state, pi, false) || pickUltimate(state, pi, true))
    : null;
  if (ult) out.push({ type: "ultimate", ultAction: ult });
  // (Correção 1.51.97) Comprar é o último recurso, como no
  // cérebro antigo: enquanto houver jogada (invocar, talento,
  // ataque ou Ultimate), a compra nem entra nas candidatas — o
  // feixe a escolhia por empate com o baralho aleatório.
  if (out.length === 0 && legal.some((a) => a?.type === "DRAW_CARD")) out.push({ type: "draw" });
  // (Livro §8) Desespero: sem jogada E com a mão CHEIA, invocar
  // uma instantânea só pelo corpo — o corpo dá ponto passivo e
  // abre alvos para as outras cartas. Só vale no beco sem saída:
  // com qualquer jogada normal ou com compra possível, este ramo
  // nem existe. (Junção Fase 2) O gatilho é a mão cheia, como o
  // livro escreve — não "sem compra" em geral: com baralho vazio
  // e mão curta, o jogo anda no turno seguinte (as cartas de
  // custo 2 voltam a valer) e o corpo gastaria a carta que as
  // regras do livro mandam guardar (Forja sem baralho; redução
  // sem alvo sem Barreira). O corpo só vale quando abre alvo
  // para outra carta da mão: um Fortalecer (FAUNO/GAIA) precisa
  // de aliado em campo. Sem ele, o corpo gasta uma instantânea
  // guardada — a escola (t) manda passar a vez com ARSENAL e
  // mão cheia — e o beco se resolve esperando o adversário jogar.
  if (out.length === 0 && hand.length >= 8
    && hand.some((c) => String(c?.onEnter || "") === "fortalecer")) {
    for (let i = 0; i < hand.length; i++) {
      const card2 = hand[i];
      if (String(card2?.category || "") !== "champion") continue;
      if (String(card2?.abilityType || "") !== "instant" || String(card2?.onEnter || "") === "") continue;
      if (!summonIdxs.has(i)) continue;
      out.push({ type: "summon", hand_idx: i });
    }
  }
  if (out.length > MAX_CANDIDATES) return _pruneCandidates(state, pi, out);
  return out;
}

function _pruneCandidates(state, pi, acts) {
  const scored = [];
  for (const act of acts) {
    let s = 0.0;
    if (act.type === "attack") {
      const mine = state.players[pi]?.field || [];
      const foes = state.players[1 - pi]?.field || [];
      const ai = act.att_idx ?? -1;
      const di = act.def_idx ?? -1;
      if (ai >= 0 && ai < mine.length && di >= 0 && di < foes.length) {
        const outc = DfRules.combatOutcome(mine[ai], foes[di]);
        s = outc?.killD ? 100.0 : 10.0;
      }
    } else if (act.type === "summon" || act.type === "talent") {
      const hand = state.players[pi]?.hand || [];
      const hi = act.hand_idx ?? -1;
      if (hi >= 0 && hi < hand.length) s = 50.0 + powerOf(hand[hi]);
    } else if (act.type === "ultimate") {
      s = 40.0;
    } else if (act.type === "draw") {
      s = 10.0;
    }
    scored.push({ act, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, MAX_CANDIDATES).map((e) => e.act);
}

// ------------------------------------------------------------------
// Assinatura do tabuleiro (detectar a ação que não mudou nada)
// ------------------------------------------------------------------
function _boardSig(state, pi) {
  const parts = [];
  parts.push(`w${state.winner ?? -1}`);
  for (let k = 0; k < 2; k++) {
    const p = state.players[k] || {};
    parts.push(`vp${p.vp ?? 0}`);
    const fs = [];
    for (const c of p.field || []) {
      // (Correção 1.51.97) a assinatura inclui os status que
      // os reforços mudam: sem eles, a Ultimate da Tina e o
      // talento INVESTIDA (só ataque livre + constante)
      // pareciam "sem efeito" e a jogada era descartada.
      fs.push([
        c?.uid ?? -1, powerOf(c), c?.tapped ? 1 : 0, c?.frozenTurns ?? 0,
        c?.poisonTurns ?? 0, c?.burningTurns ?? 0, c?.barrierTurns ?? 0,
        c?.shielded ? 1 : 0, c?.silenced ? 1 : 0,
        c?.freeAttack ? 1 : 0,
        String(c?.constantEffect || c?.constant || ""),
        c?.furyStacks ?? 0, c?.furyTurns ?? 0,
        c?.tecnicasSobrepujarTurns ?? 0,
        c?.crescimento ? 1 : 0,
        c?.ultGrowth ? 1 : 0,
        c?.charmeTurns ?? 0,
        c?.inspirado ? 1 : 0,
        c?.corrupted ? 1 : 0,
        c?.morphed ? 1 : 0,
        c?.prisaoPrismatica ? 1 : 0,
        c?.urso_pesado ? 1 : 0,
        c?.wallBuff ?? 0, c?.inspirarBuff ?? 0,
        c?.desafianteBuff ?? 0,
      ].join(":"));
    }
    parts.push(`f[${fs.join(",")}]`);
    parts.push(`h[${(p.hand || []).map((c) => c?.name || "?").join(",")}]`);
    parts.push(`d${(p.deck || []).length}`);
    parts.push(`x${(p.discard || []).length}`);
  }
  return parts.join("|");
}

// ------------------------------------------------------------------
// Reduções suspensas (RAIO/CHUVA/VINGANÇA): aplicar sem pergunta de
// Proteção quando não há quem decida (decideProtect null) — igual ao
// simulador GDScript. Com decideProtect, pergunta antes de cada redução.
// ------------------------------------------------------------------
function _collectPendingReductions(events, seat) {
  const out = [];
  for (const e of events || []) {
    if (!e || typeof e !== "object") continue;
    const pr = e.pendingReduction || e.burst?.pendingReduction;
    if (pr) out.push({ ...pr, askerSeat: e.ownerIdx ?? seat });
  }
  return out;
}

export function settleResult(state, result, seat, decideProtect = null) {
  let cur = result.state;
  let events = [...(result.events || [])];
  const queue = [
    ..._collectPendingReductions(events, seat),
    ...(Array.isArray(result.suspended?.reductions) ? result.suspended.reductions : []),
  ];
  const applied = [];
  while (queue.length) {
    const r = queue[0];
    let skip = false;
    if (decideProtect) {
      try {
        const offer = DfRules.canOfferReactiveProtection?.(cur, r.targetP, r.askerSeat ?? seat);
        if (offer?.ok) skip = !!decideProtect(r, cur);
      } catch { skip = false; }
    }
    const res = DfEffects.applyPlannedReduction(cur, r, { skip });
    if (!res?.ok) return { ok: false, state: cur, events };
    cur = res.state || cur;
    applied.push({ targetP: r.targetP, targetI: r.targetI, targetName: r.targetName, after: res.after });
    events.push(...(res.events || []));
    queue.shift();
    if (res.newPendingReduction) queue.push({ ...res.newPendingReduction, askerSeat: r.targetP });
  }
  if (result.suspended?.finish) {
    const fin = result.suspended.finish;
    try {
      if (fin.kind === "raioDuplo" && DfEffects.finishRaioDuplo) {
        const f = DfEffects.finishRaioDuplo(cur, fin, applied);
        cur = f.state || cur;
        events.push(...(f.events || []));
      } else if (fin.kind === "chuvaDeCometas" && DfEffects.finishChuvaDeCometas) {
        const f = DfEffects.finishChuvaDeCometas(cur, fin, applied);
        cur = f.state || cur;
        events.push(...(f.events || []));
      }
    } catch { /* finish é só marcação; segue sem ele */ }
  }
  return { ok: true, state: cur, events };
}

// Resolve os onEnter que o applyActionWithOnEnter deixou pendentes
// (mira manual / necromancia): mira automática, como o auto_target do
// GDScript. Devolve null quando não dá para resolver.
function _resolvePendings(state, events, seat) {
  let cur = state;
  let evs = [...events];
  for (let guard = 0; guard < 16; guard++) {
    const pending = evs.filter((e) => e?.type === "ON_ENTER_PENDING");
    if (!pending.length) return { state: cur, events: evs };
    const pe = pending[0];
    const cIdx = pe.playerId ?? pe.casterIdx;
    const fIdx = pe.fieldIdx;
    const drop = () => {
      evs = evs.filter((e) => e !== pe);
      return true;
    };
    let plan = null;
    try {
      plan = DfEffects.planOnEnter(cur, cIdx, fIdx);
    } catch { plan = null; }
    if (!plan?.ok || plan.mode === "blocked" || plan.mode === "none" || plan.mode === "visual_only") {
      drop();
      continue;
    }
    if (plan.mode === "necromancia_pick" && ((cur.players[cIdx]?.discard || []).length === 0)) {
      drop();
      continue;
    }
    if (plan.mode !== "target" && plan.mode !== "necromancia_pick" && plan.mode !== "auto") {
      drop();
      continue;
    }
    let resolution = {};
    try {
      resolution = DfEngine.autoOnEnterResolution(cur, cIdx, fIdx, plan) || {};
    } catch { resolution = {}; }
    const hasTarget = resolution.targetP != null || resolution.targetI != null
      || resolution.targetPlayerIdx != null || resolution.necromanciaCard != null;
    if (!hasTarget) {
      drop();
      continue;
    }
    const res = DfEngine.applyAction(cur, {
      type: "ON_ENTER_RESOLVE",
      playerId: cIdx,
      casterIdx: cIdx,
      fieldIdx: fIdx,
      resolution,
    });
    if (!res?.ok) return null;
    cur = res.state;
    evs = evs.filter((e) => e !== pe);
    evs.push(...(res.events || []).filter((e) => e?.type !== "ON_ENTER_PENDING"));
    if (res.suspended) {
      const settled = settleResult(cur, { state: cur, events: evs, suspended: res.suspended }, seat, null);
      if (!settled.ok) return null;
      cur = settled.state;
      evs = settled.events;
    }
  }
  return null;
}

const TALENT_TARGET_EFFECTS = new Set([
  "bolaDeFogoTalento", "explosao", "zeroAbsoluto", "medoTalento",
  "baforadaVenenosa", "fortalecerTalento", "investidaTalento",
  "prisaoPrismaticaTalento", "tornadoDeFogo", "trocaDeLugar",
  "corromperTalento", "transformarBichinhoTalento", "doppelganger",
]);

function _talentFollowUp(play, seat) {
  const te = play?._talentEffect;
  if (!te) return null;
  if (TALENT_TARGET_EFFECTS.has(te)) {
    if (!play._target) return { type: "TALENT_DISCARD", playerId: seat, talentEffect: te, handIdx: play.handIdx };
    return {
      type: "TALENT_TARGET", playerId: seat, talentEffect: te,
      targetP: play._target.targetP, targetI: play._target.targetI, handIdx: play.handIdx,
    };
  }
  if (TALENT_AUTO_EFFECTS.has(te)) {
    return { type: "TALENT_AUTO", playerId: seat, talentEffect: te, handIdx: play.handIdx };
  }
  return { type: "TALENT_DISCARD", playerId: seat, talentEffect: te, handIdx: play.handIdx };
}

function _markStatused(before, after, seat, act) {
  // GDScript game_state._mark_ai_statused: só marca quando pi == 1
  // (a IA offline é sempre o jogador 1). No caso A6 o planejador roda
  // com pi = 0, então a marca nunca dispara lá — e o -6 do combo
  // (atacar campeão que a própria IA statusou) não existe no feixe.
  if (seat !== 1) return;
  const set = statusedSet(after);
  const beforeByUid = new Map();
  for (const c of before.players[1 - seat]?.field || []) {
    if (c?.uid) beforeByUid.set(c.uid, c);
  }
  for (const c of after.players[1 - seat]?.field || []) {
    const b = c?.uid ? beforeByUid.get(c.uid) : null;
    if (!c || !b) continue;
    const gained = (!b.poisoned && c.poisoned) || (!b.frozen && c.frozen)
      || (!b.burning && c.burning) || (!b.prisaoPrismatica && c.prisaoPrismatica);
    if (gained) set.add(c.uid);
  }
  let statusKey = null;
  let target = null;
  if (act.type === "summon") {
    statusKey = String(before.players[seat]?.hand?.[act.hand_idx]?.onEnter || "");
  } else if (act.type === "talent") {
    statusKey = String(act.talentPlay?._talentEffect || "");
    target = act.talentPlay?._target || null;
  } else if (act.type === "ultimate") {
    statusKey = String(act.ultAction?.ultimateType || "");
    if (act.ultAction?.targetP != null) target = { targetP: act.ultAction.targetP, targetI: act.ultAction.targetI };
  }
  if (statusKey && STATUS_EFFECTS.has(statusKey) && target) {
    const t = before.players[target.targetP]?.field?.[target.targetI];
    if (t?.uid) set.add(t.uid);
  }
  after.aiStatusedUids = set;
}

function _markBolhas(after, events, act, seat) {
  // Idem: o motor GDScript marca BOLHAS/PESADELO só quando pi == 1
  // (game_state._apply_bolhas / ramo pesadelo). Sem a trava, o feixe
  // JS marcaria para pi = 0 e divergiria do oráculo.
  if (seat !== 1) return;
  const set = bolhasSet(after);
  for (const e of events || []) {
    if (e?.type === "BOLHAS") set.add("bolhas");
    if (e?.type === "PESADELO") set.add("pesadelo");
  }
  if (act.type === "talent" && act.talentPlay?._talentEffect === "bolhasTalento") set.add("bolhas");
  after.aiBolhasPesadeloUsed = set;
}

/**
 * Aplica UMA ação do planejador no estado (sem mexer no original).
 * decideProtect: (reduction, state) => bool — pergunta de Proteção Divina
 * contra reduções suspensas; null = aplicar sem perguntar (feixe).
 * skipOnEnter: invocar SEM a instantânea (EXAUSTÃO aceita) — o campeão
 * entra e o on-enter não resolve, como a autoridade (noOnEnterAuto).
 * allowNoBoardChange: jogada REAL (não simulação do feixe) — não
 * rejeita a ação que gastou um uso sem mudar o tabuleiro na hora
 * (ex.: Ultimate protegida, Força Infinita, Investida). O teste de
 * "nada mudou" é do feixe (o _board_sig GDScript exclui usos de
 * Ultimate de propósito); a arena aplica a jogada real sem ele.
 */
export function applyPlannerAction(state, seat, act, opts = {}) {
  const decideProtect = opts.decideProtect || null;
  const allowNoBoardChange = opts.allowNoBoardChange === true;
  const beforeSig = _boardSig(state, seat);
  let cur = cloneBeamState(state);
  let events = [];
  const fail = () => ({ ok: false, state, events: [] });
  let res = null;
  if (act.type === "summon") {
    const card = cur.players[seat]?.hand?.[act.hand_idx];
    if (!card) return fail();
    const motorAct = { type: "SUMMON", playerId: seat, handIdx: act.hand_idx };
    if (card.summonRitual) {
      const sacs = DfRules.listRitualSacrificeIndices?.(cur, seat, card.summonRitual) || [];
      if (!sacs.length) return fail();
      motorAct.freeAction = true;
      motorAct.sacrificeIdx = sacs[0];
      motorAct.sacrificeUid = cur.players[seat].field[sacs[0]]?.uid ?? null;
    }
    if (opts.skipOnEnter) {
      // EXAUSTÃO (C-A08, autoridade opts.noOnEnterAuto): o campeão entra
      // SEM a instantânea — SUMMON pelo applyAction puro, sem resolver
      // o on-enter. A marca de statusado também não dispara (a habilidade
      // cancelada não statusou ninguém).
      res = DfEngine.applyAction(cur, motorAct);
      if (!res?.ok) return fail();
      cur = res.state;
      events = [...(res.events || [])];
    } else {
      res = DfEngine.applyActionWithOnEnter(cur, motorAct, { serverAi: true });
      if (!res?.ok) return fail();
      cur = res.state;
      events = [...(res.events || [])];
      const resolved = _resolvePendings(cur, events, seat);
      if (!resolved) return fail();
      cur = resolved.state;
      events = resolved.events;
    }
    const settled = settleResult(cur, { state: cur, events, suspended: res.suspended }, seat, decideProtect);
    if (!settled.ok) return fail();
    cur = settled.state;
    events = settled.events;
  } else if (act.type === "talent") {
    res = DfEngine.applyAction(cur, { type: "TALENT_START", playerId: seat, handIdx: act.hand_idx });
    if (!res?.ok) return fail();
    cur = res.state;
    events = [...(res.events || [])];
    let settled = settleResult(cur, { state: cur, events, suspended: res.suspended }, seat, decideProtect);
    if (!settled.ok) return fail();
    cur = settled.state;
    events = settled.events;
    const follow = _talentFollowUp(act.talentPlay, seat);
    if (follow) {
      const fres = DfEngine.applyAction(cur, follow);
      if (!fres?.ok) {
        const disc = DfEngine.applyAction(cur, { type: "TALENT_DISCARD", playerId: seat });
        if (!disc?.ok || cur.activeTalent) return fail();
        cur = disc.state;
        events.push(...(disc.events || []));
      } else {
        cur = fres.state;
        events.push(...(fres.events || []));
        const settled2 = settleResult(cur, { state: cur, events, suspended: fres.suspended }, seat, decideProtect);
        if (!settled2.ok) return fail();
        cur = settled2.state;
        events = settled2.events;
      }
    }
    if (cur.activeTalent) {
      const disc = DfEngine.applyAction(cur, { type: "TALENT_DISCARD", playerId: seat });
      if (!disc?.ok) return fail();
      cur = disc.state;
      events.push(...(disc.events || []));
    }
  } else if (act.type === "ultimate") {
    // A Ultimate pode vir sem ultAction (o plan() devolve a
    // Ultimate da Tina sem alvo concreto): resolver na hora com
    // o pick do cérebro, como as candidatas do feixe.
    const ultAction = act.ultAction
      || pickUltimate(state, seat, false)
      || pickUltimate(state, seat, true);
    if (!ultAction) return fail();
    res = DfEngine.applyAction(cur, ultAction);
    if (!res?.ok) return fail();
    cur = res.state;
    events = [...(res.events || [])];
    // Reutilização (Tristana) re-dispara a instantânea do aliado como um
    // ON_ENTER_PENDING — o GDScript resolve na hora dentro de
    // use_ultimate; sem isto o efeito ficava pendente e nunca aplicava,
    // no feixe e no jogo real.
    const resolved = _resolvePendings(cur, events, seat);
    if (!resolved) return fail();
    cur = resolved.state;
    events = resolved.events;
    const settled = settleResult(cur, { state: cur, events, suspended: res.suspended }, seat, decideProtect);
    if (!settled.ok) return fail();
    cur = settled.state;
    events = settled.events;
  } else if (act.type === "attack") {
    res = DfEngine.applyAction(cur, {
      type: "ATTACK_RESOLVE", playerId: seat,
      attackerIdx: act.att_idx, defenderPlayerId: 1 - seat, defenderIdx: act.def_idx,
      ...(act.blocked ? { blocked: true } : {}),
    });
    if (!res?.ok) return fail();
    cur = res.state;
    events = [...(res.events || [])];
    const settled = settleResult(cur, { state: cur, events, suspended: res.suspended }, seat, decideProtect);
    if (!settled.ok) return fail();
    cur = settled.state;
    events = settled.events;
  } else if (act.type === "draw") {
    res = DfEngine.applyAction(cur, { type: "DRAW_CARD", playerId: seat });
    if (!res?.ok) return fail();
    cur = res.state;
    events = [...(res.events || [])];
  } else if (act.type === "end_turn") {
    res = DfEngine.applyAction(cur, { type: "END_TURN", playerId: seat });
    if (!res?.ok) return fail();
    cur = res.state;
    events = [...(res.events || [])];
    const settled = settleResult(cur, { state: cur, events, suspended: res.suspended }, seat, decideProtect);
    if (!settled.ok) return fail();
    cur = settled.state;
    events = settled.events;
    // O clone JSON do motor transforma os Sets da guarda em {} — sem
    // restaurar, as marcas do turno se perdiam entre uma jogada e a
    // próxima (e o estado voltava com {} no assento 0). O motor não
    // mexe nesses Sets; só a representação some, então restaura do
    // estado de entrada antes de marcar o que esta jogada acrescentou.
    cur.aiStatusedUids = new Set(statusedSet(state));
    cur.aiBolhasPesadeloUsed = new Set(bolhasSet(state));
    _markBolhas(cur, events, act, seat);
    return { ok: true, state: cur, events };
  } else {
    return fail();
  }
  if (!allowNoBoardChange
    && (cur.winner === null || cur.winner === undefined || cur.winner === -1)
    && _boardSig(cur, seat) === beforeSig) return fail();
  // Idem: restaurar os Sets antes de marcar (o clone JSON do motor os
  // transforma em {} e as marcas do turno se perderiam).
  cur.aiStatusedUids = new Set(statusedSet(state));
  cur.aiBolhasPesadeloUsed = new Set(bolhasSet(state));
  _markStatused(state, cur, seat, act);
  _markBolhas(cur, events, act, seat);
  return { ok: true, state: cur, events };
}

// ------------------------------------------------------------------
// Busca em feixe (espelho de _beam_search)
// ------------------------------------------------------------------
function _beamSearch(state, pi) {
  _clonesUsed = 0;
  const passScore = evaluate2(state, pi);
  let bestTotal = passScore;
  let bestFirst = null;
  const start = cloneBeamState(state);
  _clonesUsed += 1;
  let frontier = [{ sim: start, first: null, total: passScore, adj: 0.0 }];
  for (let level = 0; level < BEAM_DEPTH; level++) {
    const nxt = [];
    let stop = false;
    for (const node of frontier) {
      const sim = node.sim;
      if (sim.winner !== null && sim.winner !== undefined && sim.winner !== -1) continue;
      for (const act of _candidateActions(sim, pi)) {
        if (_clonesUsed >= MAX_CLONES) {
          stop = true;
          break;
        }
        _clonesUsed += 1;
        const res = applyPlannerAction(sim, pi, act);
        if (!res.ok) continue;
        const bonus = _comboBonus(sim, pi, act);
        const guard = _guardSpent(sim, pi, act);
        // O bônus do combo e o valor de guarda ACUMULAM ao longo
        // da sequência: gastar a carta boa no 1º passo continua
        // pesando no fim da sequência, não some no passo seguinte.
        // (Livro §7a/§7b) O bônus de situação soma junto.
        const adj = node.adj + bonus - guard + _situationBonus(sim, pi, act);
        const first = node.first || act;
        // (Livro 03 §7a) O ataque livre da Investida é
        // sempre o PRIMEIRO ataque do turno: a sequência que
        // abre com ele ganha o desempate (acima do 0,004 de
        // invocar). "Primeiro ataque" não é "primeira ação" —
        // invocar antes dele continua valendo, só a ordem dos
        // ataques muda. A marca viaja no nó do feixe.
        let freeFirst = !!node.freeFirst;
        if (!node.first && String(act?.type || "") === "attack") {
          const ai0 = act.att_idx ?? -1;
          const di0 = act.def_idx ?? -1;
          const mf0 = sim.players[pi]?.field || [];
          const ff0 = sim.players[1 - pi]?.field || [];
          if (ai0 >= 0 && ai0 < mf0.length && di0 >= 0 && di0 < ff0.length) {
            const att0 = mf0[ai0];
            if (constOf(att0) === "investida" && att0?.freeAttack) {
              if (combatKill(att0, ff0[di0])) freeFirst = true;
            }
          }
        }
        // (Correção 1.51.97) Desempate pela ordem do cérebro
        // antigo (invocar > talento > Ultimate > ataque >
        // compra): linhas empatadas no placar não dependem
        // da ordem do feixe nem do sorteio do baralho.
        let prio = 0.0;
        if (freeFirst) {
          prio = 0.01;
        } else if (first.type === "summon") prio = 0.004;
        else if (first.type === "talent") prio = 0.003;
        else if (first.type === "ultimate") prio = 0.002;
        else if (first.type === "attack") prio = 0.001;
        const total = evaluate2(res.state, pi) + adj + prio;
        nxt.push({ sim: res.state, first, total, adj, freeFirst });
        // (Correção 1.51.97, ajuste 18:21) Sem faixa de empate:
        // só o desempate pela ordem do cérebro antigo (prio) e
        // a comparação estrita — a faixa de 0,5 ponto da versão
        // anterior foi retirada no ajuste do T15196.
        if (total > bestTotal) {
          bestTotal = total;
          bestFirst = first;
        }
      }
      if (stop) break;
    }
    if (!nxt.length) break;
    nxt.sort((a, b) => b.total - a.total);
    frontier = nxt.slice(0, BEAM_WIDTH);
  }
  if (!bestFirst) return { type: "end_turn" };
  return bestFirst;
}

// ------------------------------------------------------------------
// Fallback: o cérebro antigo, na ordem do motorista (só quando o
// feixe não devolve ação — espelho do `AIBrain._legacy_next_action`
// do plan() GDScript).
// ------------------------------------------------------------------
import {
  pickWinAttack, pickDecisiveAttack, pickBestSummon, pickBestAttack,
  pickDraw, pickNextAction, aiMode, pickTalentByMode,
  championSummonCost as _championSummonCost,
} from "./df-ai-hard-brain.mjs";

export function legacyFallback(state, seat) {
  return _legacyFallback(state, seat);
}

function _legacyFallback(state, seat) {
  const toPlanner = (a) => {
    if (!a) return null;
    switch (a.type) {
      case "SUMMON": return { type: "summon", hand_idx: a.handIdx };
      case "TALENT_START": return { type: "talent", hand_idx: a.handIdx, talentPlay: a };
      case "ATTACK_RESOLVE": return { type: "attack", att_idx: a.attackerIdx, def_idx: a.defenderIdx };
      case "ULTIMATE_PLAY": return { type: "ultimate", ultAction: a };
      case "DRAW_CARD": return { type: "draw" };
      case "END_TURN": return { type: "end_turn" };
      default: return null;
    }
  };
  const winAtk = pickWinAttack(state, seat);
  if (winAtk) return toPlanner(winAtk);
  const legal0 = DfEngine.listLegalActions(state, seat, {
    strictFumacaToxica: true, avoidEnemyOnEnterWaste: false, allowWastedOnEnter: true,
  }) || [];
  const summonPeek = pickBestSummon(state, seat, legal0, { minScore: 0 });
  const summonPeekCost = summonPeek?.type === "SUMMON"
    ? _championSummonCost(state.players[seat]?.hand?.[summonPeek.handIdx]) : 0;
  const decAtk = pickDecisiveAttack(state, seat, summonPeekCost);
  if (decAtk) return toPlanner(decAtk);
  let phase = "summon";
  let floor = 5;
  const tried = new Set();
  const key = (a) => [a?.type, a?.handIdx, a?.attackerIdx, a?.defenderIdx].join(":");
  for (let attempt = 0; attempt < 12; attempt++) {
    const legal = DfEngine.listLegalActions(state, seat, {
      strictFumacaToxica: true, avoidEnemyOnEnterWaste: false, allowWastedOnEnter: true,
    }) || [];
    if (phase === "summon" && !legal.some((a) => a?.type === "SUMMON")) phase = "talent";
    if (phase === "talent" && !listTalentPlays(state, seat).length) phase = "ult_early";
    if (phase === "ult_early" && !pickNextAction(state, seat, { phase: "ult_early" })) phase = "ult_end";
    if (phase === "ult_end" && !pickNextAction(state, seat, { phase: "ult_end" })) phase = "attack";
    if (phase === "attack" && !legal.some((a) => a?.type === "ATTACK_RESOLVE")) phase = "draw";
    if (phase === "draw" && !legal.some((a) => a?.type === "DRAW_CARD")) phase = "end";
    let action = null;
    if (phase === "talent") {
      action = pickNextAction(state, seat, { phase: "talent" });
      if (!action) { phase = "ult_early"; continue; }
    } else if (phase === "ult_early") {
      action = pickNextAction(state, seat, { phase: "ult_early" });
      if (!action) { phase = "ult_end"; continue; }
    } else if (phase === "ult_end") {
      action = pickNextAction(state, seat, { phase: "ult_end" });
      if (!action) { phase = "attack"; continue; }
    } else if (phase === "end") {
      action = { type: "END_TURN", playerId: seat };
    } else if (phase === "summon") {
      action = pickBestSummon(state, seat, legal, { minScore: floor });
      if ((!action || action.type === "END_TURN") && floor > 0) {
        floor = 0;
        action = pickBestSummon(state, seat, legal, { minScore: 0 });
      }
      if (!action || action.type === "END_TURN") { phase = "talent"; continue; }
    } else if (phase === "attack") {
      action = pickBestAttack(state, seat, legal, { minScore: floor });
      if ((!action || action.type === "END_TURN") && floor > 0) {
        floor = 0;
        action = pickBestAttack(state, seat, legal, { minScore: 0 });
      }
      if (!action || action.type === "END_TURN") { phase = "draw"; continue; }
    } else if (phase === "draw") {
      action = pickDraw(state, seat, legal);
      if (!action || action.type === "END_TURN") { phase = "end"; continue; }
    } else {
      action = { type: "END_TURN", playerId: seat };
    }
    if (!action) action = { type: "END_TURN", playerId: seat };
    if (tried.has(key(action))) {
      if (action.type === "END_TURN") break;
      tried.add(key(action));
      if (phase === "summon") phase = "talent";
      else if (phase === "talent") phase = "ult_early";
      else if (phase === "ult_early") phase = "ult_end";
      else if (phase === "ult_end") phase = "attack";
      else if (phase === "attack") { floor = Math.min(floor, 0); phase = "draw"; }
      else if (phase === "draw") phase = "end";
      continue;
    }
    tried.add(key(action));
    if (action.type === "SUMMON") {
      const card = state.players[seat]?.hand?.[action.handIdx];
      const acts = state.players[seat]?.actions ?? 0;
      if (!card || (!card.summonRitual && acts < _championSummonCost(card))) continue;
    }
    return toPlanner({ ...action, playerId: seat }) || { type: "end_turn" };
  }
  return { type: "end_turn" };
}

// ------------------------------------------------------------------
// react() — (Tarefa 7) Reações dentro do cérebro.
// ------------------------------------------------------------------
export function react(state, pi, threat) {
  const cancelValue = _threatValue(state, pi, threat);
  let holdValue = REACT_RESERVE;
  if (threat?.next) {
    holdValue = Math.max(holdValue, _threatValue(state, pi, threat.next));
  }
  return cancelValue >= holdValue;
}

function _threatValue(state, pi, threat) {
  switch (String(threat?.kind || "")) {
    case "attack":
      return _attackValue(state, threat.att || {}, threat.def || {});
    case "protect":
      return _protectValue(state, pi, threat.target_uid ?? -1, threat.amount ?? 1);
    case "contramagica":
      return _talentValue(state, pi, threat.card || {});
    case "exaustao":
      return _instantValue(state, pi, threat.card || {});
    case "cancel_ult":
      return _ultValue(state, pi, threat.user_pi ?? (1 - pi));
    default:
      return 0.0;
  }
}

function _attackValue(state, att, defc) {
  if (!att || !defc || Object.keys(att).length === 0 || Object.keys(defc).length === 0) return 0.0;
  const out = DfRules.combatOutcome(att, defc);
  if (!out?.killD) return 0.0;
  let v = 2.0 * powerOf(defc);
  if (!noVpOnDestroy(defc)) v += 3.0;
  v += 2.0 * _threatOf(defc);
  if (out.killA) v -= powerOf(att);
  return v;
}

function _protectValue(state, pi, targetUid, amount) {
  let best = 0.0;
  for (const c of state.players[pi]?.field || []) {
    if (targetUid !== -1 && targetUid !== null && String(c?.uid) !== String(targetUid)) continue;
    // (Livro 05, Guia 2) Barreira bloqueia TODA redução de Poder
    // (reduce_power retorna sem aplicar) — proteger um alvo com
    // Barreira não faz nada: ele nem entra na conta, nem como
    // alvo certo nem no sorteio (target_uid -1, Vingança).
    if (hasBarrier(c)) continue;
    const pw = powerOf(c);
    const lost = Math.min(amount, pw);
    let v = 2.0 * lost;
    if (pw <= amount) {
      if (!noVpOnDestroy(c)) v += 3.0;
      v += 2.0 * _threatOf(c);
    } else if (_threatOf(c) >= 1.5) {
      v += 2.0;
    }
    best = Math.max(best, v);
  }
  return best;
}

function _instantValue(state, pi, card) {
  const oe = String(card?.onEnter || "");
  switch (oe) {
    case "assassinar": {
      let best = 3.0;
      for (const c of state.players[pi]?.field || []) {
        if (powerOf(c) === 1 && !hasBarrier(c)) {
          let v = 2.0;
          if (!noVpOnDestroy(c)) v += 3.0;
          v += 2.0 * _threatOf(c);
          best = Math.max(best, v);
        }
      }
      return best;
    }
    case "bolaDeFogo": return 6.0;
    case "charme": return 6.0;
    case "raioDuplo": case "transformarBichinho": case "separar":
    case "prisaoPrismatica": case "roletaRussa": return 5.0;
    case "mordidaVenenosa": case "rajadaCongelante": case "incendiar":
    case "fumacaToxica": case "podridao": case "pesadelo": case "necromancia":
    case "imitar": case "tecnicasDeCombate": case "trocaInjusta": return 4.0;
    case "roubar": case "bolhas": case "corromper": case "devorar":
    case "ursificacao": case "fortalecer": case "gritoDeGuerra": case "energizar":
    case "guardiao": case "defensor": case "furia": case "invokeDragon":
    case "enfraquecer": return 3.0;
    case "forja": case "rapidez": case "desacelerar": case "auraAntiMagia": return 2.0;
    default: return 3.0;
  }
}

function _ultValue(state, pi, userPi) {
  const hero = state.players[userPi]?.heroDef || {};
  const ut = String(hero.ultimateType || state.players[userPi]?.ultimateType || "");
  switch (ut) {
    case "incinerate":
      for (const c of state.players[pi]?.field || []) {
        if (powerOf(c) >= 2 && !c.burning && !hasBarrier(c)) return 8.0;
      }
      return 3.0;
    case "fireAndIce": return 7.0;
    case "cometStarfall":
      for (const c of state.players[pi]?.field || []) {
        if (powerOf(c) <= 1) return 7.0;
      }
      return 2.0;
    case "targetEnemy": case "targetEnemyFreeze": case "vampirism": return 6.0;
    case "poison": case "banish": case "hook": return 5.0;
    case "scareReturn": case "trickerySwap": return 4.0;
    case "thunderDiscard": return 3.0;
    case "reuseInstant": {
      // (Livro 01) A Reutilização vale o que vale a instantânea
      // reutilizada — avaliar a instantânea, não a Ultimate:
      // cancelar vale quando a repetição for de uma instantânea
      // forte (Assassinar, Roubar, Necromancia). Sem candidato
      // válido, vale o piso de 2,0 como antes.
      let best = 0.0;
      for (const c of state.players[userPi]?.field || []) {
        if (_reuseCandidateOk(state, userPi, c)) {
          best = Math.max(best, _instantValue(state, pi, c));
        }
      }
      if (best > 0.0) return best;
      break;
    }
    default: return 2.0;
  }
  return 2.0;
}

function _talentValue(state, pi, card) {
  const eff = String(card?.talentEffect || "");
  switch (eff) {
    case "explosao":
      for (const c of state.players[pi]?.field || []) {
        if (powerOf(c) <= 2 && !hasBarrier(c)) return 8.0;
      }
      return 6.0;
    case "zeroAbsoluto":
      // (Livro 05, Guia 5.2) o Zero destrói um congelado do
      // DEFENSOR: ele mira INIMIGOS de quem joga (o campo de
      // pi, não o de quem jogou o talento). Sem congelado seu,
      // só congela por 2 rodadas e vale 4.0.
      for (const c of state.players[pi]?.field || []) {
        if (frozenTurns(c) > 0) return 8.0;
      }
      return 4.0;
    case "chuvaDeCometas": return 7.0;
    case "prisaoPrismaticaTalento": case "medoTalento": case "missemagicos": return 6.0;
    case "transformarBichinhoTalento": case "tornadoDeFogo": return 5.0;
    case "baforadaVenenosa": case "corromperTalento": case "doppelganger":
    case "tecnicasDeCombateTalento": return 4.0;
    case "gritoDeGuerraTalento": case "fortalecerTalento": case "barreira":
    case "arsenalDeGuerra": case "aceleracao": case "invocarDragaoTalento":
    case "ressuscitarTalento": case "trocaDeLugar": case "investidaTalento":
    case "podridaoTalento": return 3.0;
    case "desacelerarTalento": case "bolhasTalento": case "enfraquecerTalento": return 2.0;
    case "apodrecidaDescarte": return 1.0;
    default: return 3.0;
  }
}

export const DfAiPlanner = {
  plan,
  evaluate2,
  guardValue,
  react,
  COMBOS,
  REACT_RESERVE,
  applyPlannerAction,
  settleResult,
  cloneBeamState,
  legacyFallback,
  onEnterUsable,
  powerOf,
};

export default DfAiPlanner;
