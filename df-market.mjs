/**
 * Dragonfall — coleção de cartas, Moedas e Mercado (lógica pura, rng injetável).
 * Autoridade: o servidor. O cliente só exibe o que estas funções devolvem.
 */

export const MARKET_SIZE = 6;
export const CARD_PRICE = 8;
export const REFRESH_COST = 1;
export const MARKET_ROTATION_MS = 24 * 60 * 60 * 1000;
export const DECK_SLOTS = 24;
export const DECK_COUNT = 5;

/** Cartas iniciais: 7 Campeões Poder 1, 7 Campeões Poder 2, 5 Talentos, 1 Reação. */
export const STARTER_SHAPE = { champ1: 7, champ2: 7, talent: 5, reaction: 1 };

/** Recompensas por partida (XP + Moedas). */
export const MATCH_REWARDS = {
  ai: { win: { xp: 6, coins: 2 }, lose: { xp: 0, coins: 0 } },
  pvp: { win: { xp: 8, coins: 2 }, lose: { xp: 2, coins: 0 } },
};

export function rewardFor(matchType, outcome) {
  const key = matchType === "pvp" ? "pvp" : "ai";
  const row = MATCH_REWARDS[key][outcome === "win" ? "win" : "lose"];
  return { key, xp: row.xp, coins: row.coins };
}

export function cardKind(c) {
  if (!c) return null;
  if (c.category === "champion") {
    const p = Number(c.power) | 0;
    if (p === 1) return "champ1";
    if (p === 2) return "champ2";
    return "champOther";
  }
  if (c.subcategory === "reaction") return "reaction";
  if (c.category === "talent") return "talent";
  return null;
}

/** Cartas jogáveis únicas por nome (sem tokens `hidden`). */
export function playablePool(cardDefs) {
  const byName = new Map();
  for (const c of cardDefs || []) {
    if (!c || c.hidden || !c.name) continue;
    if (!byName.has(c.name)) byName.set(c.name, c);
  }
  return [...byName.values()];
}

function shuffled(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function rollStarter(cardDefs, rng = Math.random) {
  const pool = playablePool(cardDefs);
  const out = [];
  for (const kind of ["champ1", "champ2", "talent", "reaction"]) {
    const pick = shuffled(pool.filter((c) => cardKind(c) === kind), rng)
      .slice(0, STARTER_SHAPE[kind]);
    for (const c of pick) out.push(c.name);
  }
  return out;
}

/** Baralho 1 = cartas iniciais; baralhos 2..5 vazios. */
export function starterDecks(ownedCards) {
  return Array.from({ length: DECK_COUNT }, (_, i) => {
    const cards = Array(DECK_SLOTS).fill(null);
    if (i === 0) ownedCards.slice(0, DECK_SLOTS).forEach((n, s) => { cards[s] = n; });
    return { name: `Baralho ${i + 1}`, cards };
  });
}

/** Sorteia até `count` cartas NÃO possuídas, fora de `exclude`. */
export function rollCards(cardDefs, owned, exclude, count, rng = Math.random) {
  const ownedSet = new Set(owned || []);
  const ex = new Set((exclude || []).filter(Boolean));
  const candidates = playablePool(cardDefs).filter((c) => !ownedSet.has(c.name) && !ex.has(c.name));
  return shuffled(candidates, rng).slice(0, count).map((c) => c.name);
}

function padSlots(names) {
  const cards = names.slice(0, MARKET_SIZE);
  while (cards.length < MARKET_SIZE) cards.push(null);
  return cards;
}

/**
 * Garante mercado válido: rotação a cada 24h (grátis) e remove cartas já possuídas
 * ou inexistentes (repondo o slot). Devolve { market, changed }.
 */
export function ensureMarket(market, cardDefs, owned, now = Date.now(), rng = Math.random) {
  const valid = new Set(playablePool(cardDefs).map((c) => c.name));
  const ownedSet = new Set(owned || []);
  const fresh = !market || !Array.isArray(market.cards) || !Number.isFinite(market.dailyAt)
    || now - market.dailyAt >= MARKET_ROTATION_MS;
  if (fresh) {
    return {
      changed: true,
      market: { cards: padSlots(rollCards(cardDefs, owned, [], MARKET_SIZE, rng)), dailyAt: now },
    };
  }
  let changed = false;
  const cards = padSlots(market.cards.map((n) => (n && valid.has(n) && !ownedSet.has(n) ? n : null)));
  for (let i = 0; i < MARKET_SIZE; i++) {
    if (cards[i] !== (market.cards[i] ?? null)) changed = true;
    if (cards[i] == null) {
      const [n] = rollCards(cardDefs, owned, cards, 1, rng);
      if (n) { cards[i] = n; changed = true; }
    }
  }
  return { changed, market: { cards, dailyAt: market.dailyAt } };
}

/** Compra: exige carta no mercado e Moedas >= preço. Repõe o slot na hora. */
export function buyCard(state, name, cardDefs, rng = Math.random) {
  const market = state.market;
  const idx = market?.cards ? market.cards.indexOf(name) : -1;
  if (!name || idx < 0) return { ok: false, error: "NOT_IN_MARKET" };
  if ((state.ownedCards || []).includes(name)) return { ok: false, error: "ALREADY_OWNED" };
  if ((state.coins | 0) < CARD_PRICE) return { ok: false, error: "NOT_ENOUGH_COINS" };
  const ownedCards = [...(state.ownedCards || []), name];
  const cards = market.cards.slice();
  cards[idx] = null;
  const [replacement] = rollCards(cardDefs, ownedCards, cards, 1, rng);
  cards[idx] = replacement || null;
  return {
    ok: true,
    slot: idx,
    coins: (state.coins | 0) - CARD_PRICE,
    ownedCards,
    market: { cards, dailyAt: market.dailyAt },
  };
}

/** Atualizar mercado: custa 1 Moeda e troca as 6 cartas. */
export function refreshMarket(state, cardDefs, rng = Math.random) {
  if ((state.coins | 0) < REFRESH_COST) return { ok: false, error: "NOT_ENOUGH_COINS" };
  const current = state.market?.cards || [];
  let names = rollCards(cardDefs, state.ownedCards, current, MARKET_SIZE, rng);
  if (names.length < MARKET_SIZE) {
    const more = rollCards(cardDefs, state.ownedCards, names, MARKET_SIZE - names.length, rng);
    names = names.concat(more);
  }
  return {
    ok: true,
    coins: (state.coins | 0) - REFRESH_COST,
    market: { cards: padSlots(names), dailyAt: state.market?.dailyAt ?? Date.now() },
  };
}
