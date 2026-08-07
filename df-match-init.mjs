/**
 * Estado inicial de partida 1v1 no servidor (mesma lógica que resetState + deckSeed).
 */
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(deck, rand) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function cloneCard(c) {
  return JSON.parse(JSON.stringify(c));
}

function buildDecks(state, cardDefs, deckSeed, deckCardNames) {
  const playable = cardDefs.filter((c) => !c.hidden);
  const byName = new Map();
  for (const c of playable) {
    if (!byName.has(c.name)) byName.set(c.name, c);
  }
  const uniqueByName = [...byName.values()];

  for (let p = 0; p < state.players.length; p++) {
    const names = Array.isArray(deckCardNames?.[p]) ? deckCardNames[p] : null;
    if (names && names.length >= 10) {
      const deck = [];
      const seen = new Set();
      for (const n of names) {
        const nm = String(n || "").trim();
        if (!nm || seen.has(nm)) continue;
        const card = byName.get(nm);
        if (!card) continue;
        seen.add(nm);
        deck.push(cloneCard(card));
      }
      if (deck.length >= 10) {
        state.players[p].deck = deck;
        state.players[p].discard = [];
        const seed = deckSeed != null ? (deckSeed + p * 9973) >>> 0 : null;
        if (seed != null) shuffleInPlace(state.players[p].deck, mulberry32(seed));
        else shuffleInPlace(state.players[p].deck, Math.random);
        continue;
      }
    }
    state.players[p].deck = uniqueByName.map(cloneCard);
    state.players[p].discard = [];
    const seed = deckSeed != null ? (deckSeed + p * 9973) >>> 0 : null;
    if (seed != null) shuffleInPlace(state.players[p].deck, mulberry32(seed));
    else shuffleInPlace(state.players[p].deck, Math.random);
  }
}

/**
 * @param {{ heroIds: string[], winPoints?: number, firstPlayer?: number, deckSeed?: number, deckCardNames?: (string[]|null)[] }} opts
 */
export function createInitialMatchState(opts) {
  const { DfData } = bootDragonfallEngine();
  const heroIds = opts.heroIds || [];
  const winPoints = opts.winPoints ?? 15;
  const firstPlayer = opts.firstPlayer ?? 0;

  const state = {
    started: true,
    winner: null,
    currentPlayer: firstPlayer,
    turnNumber: 1,
    playersCount: 2,
    winPoints,
    activeTalent: null,
    players: [],
  };

  for (let i = 0; i < 2; i++) {
    const hero = DfData.heroDefs.find((h) => h.id === heroIds[i]);
    state.players.push({
      name: hero?.name || `Jogador ${i + 1}`,
      isAI: false,
      heroId: heroIds[i] || null,
      heroDef: hero ? cloneCard(hero) : null,
      vp: 0,
      actions: 3,
      hand: [],
      field: [],
      deck: [],
      discard: [],
      skipDraw: false,
      skipNextAction: false,
      ultimateUses: 0,
      usedUltimateThisTurn: false,
      onEnterUsedThisTurn: [],
      lastDestroyedSummon: null,
      destroyedChampions: [],
    });
  }

  buildDecks(state, DfData.cardDefs, opts.deckSeed, opts.deckCardNames);

  for (let p = 0; p < 2; p++) {
    for (let d = 0; d < 4; d++) {
      const card = state.players[p].deck.pop();
      if (card) state.players[p].hand.push(card);
    }
  }

  // Saque livre do 1º turno do jogador que começa (manual: 4 → 5).
  // runTurnMaintenance NÃO compra carta — draw explícito aqui.
  const { DfRules } = bootDragonfallEngine();
  if (DfRules?.runTurnMaintenance) {
    DfRules.runTurnMaintenance(state, firstPlayer);
  }
  const opener = state.players[firstPlayer];
  if (opener?.deck?.length && (opener.hand?.length || 0) < 8) {
    const drawn = opener.deck.pop();
    if (drawn) opener.hand.push(cloneCard(drawn));
  }

  return state;
}
