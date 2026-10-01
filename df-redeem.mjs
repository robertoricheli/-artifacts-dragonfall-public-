/**
 * Dragonfall — Resgatar código (lógica pura).
 * O servidor guarda só a impressão digital (scrypt + sal por código); o código em texto
 * nunca fica no repositório nem no cliente. Autoridade: o servidor.
 */
import crypto from "crypto";

export const REDEEM_CODE_MAX_LEN = 64;
const KEY_LEN = 32;

/** Tabela de produção: { id, salt, hash } — hash = scrypt(normalizeCode(código), salt, 32). */
const PRODUCTION_TABLE = Object.freeze([
  Object.freeze({
    id: "dev-all",
    salt: "239fe3c33c9bcfef2083852cd1f0c343",
    hash: "2f2d22e58f14fcaec2fbee84be70b9ce6351f6b9b1316dd8c462775046584997",
  }),
  Object.freeze({
    id: "promo-2026",
    salt: "e72105540aa9907ebf51af10f19a3be9",
    hash: "3738ede988859a9b0b9e1c01ba953e452e0d3a5828c153256b06b3409382fd48",
  }),
]);

export const PROMO_COINS = 16;
export const DEV_COINS = 10000;
export const DEV_LEVEL = 62;

export const REDEEM_REWARDS = Object.freeze({
  "promo-2026": Object.freeze({ type: "coins", coins: PROMO_COINS }),
  "dev-all": Object.freeze({ type: "dev", coins: DEV_COINS, level: DEV_LEVEL }),
});

export function normalizeCode(raw) {
  return String(raw ?? "").normalize("NFC").trim().toLowerCase();
}

export function fingerprintCode(normalized, salt) {
  return crypto.scryptSync(normalized, salt, KEY_LEN).toString("hex");
}

/** Tabela ativa: `DF_REDEEM_TEST_TABLE` (JSON de entradas com hash) só para testes. */
export function activeRedeemTable(env = process.env) {
  const raw = env?.DF_REDEEM_TEST_TABLE;
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list.filter((e) => e && typeof e.id === "string" && typeof e.salt === "string" && typeof e.hash === "string");
      }
    } catch (_) { /* tabela de teste inválida → nenhuma entrada */ }
    return [];
  }
  return PRODUCTION_TABLE;
}

/** Devolve o id do código (ex. "promo-2026") ou null. Compara todas as entradas em tempo constante. */
export function verifyCode(code, table = activeRedeemTable()) {
  const norm = normalizeCode(code);
  if (!norm || norm.length > REDEEM_CODE_MAX_LEN) return null;
  let found = null;
  for (const entry of table || []) {
    const expected = Buffer.from(String(entry.hash), "hex");
    if (expected.length !== KEY_LEN) continue;
    const actual = Buffer.from(fingerprintCode(norm, entry.salt), "hex");
    if (crypto.timingSafeEqual(actual, expected) && !found) found = entry.id;
  }
  return found;
}

function union(base, extra) {
  const out = Array.isArray(base) ? base.slice() : [];
  const seen = new Set(out);
  for (const v of extra || []) {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

export function rewardDescription(codeId) {
  const r = REDEEM_REWARDS[codeId];
  if (!r) return null;
  if (r.type === "dev") {
    return { type: "dev", coins: r.coins, level: r.level, allCards: true, allHeroes: true };
  }
  return { type: "coins", coins: r.coins };
}

/**
 * Aplica a recompensa sem mutar o jogador.
 * @param {object} player
 * @param {string} codeId
 * @param {{ playableCards: string[], heroIds: string[], devXpTotal: number, journeyMaxLevel: number }} ctx
 */
export function redeemForPlayer(player, codeId, ctx) {
  const reward = REDEEM_REWARDS[codeId];
  if (!reward) return { ok: false, error: "INVALID_CODE" };
  const redeemed = Array.isArray(player?.redeemedCodes) ? player.redeemedCodes : [];
  if (redeemed.includes(codeId)) return { ok: false, error: "ALREADY_REDEEMED" };

  const next = {
    redeemedCodes: [...redeemed, codeId],
    coins: Math.max(0, player.coins | 0) + reward.coins,
  };
  if (reward.type === "dev") {
    next.xpTotal = Math.max(player.xpTotal | 0, ctx.devXpTotal | 0);
    next.claimedLevels = Array.from({ length: ctx.journeyMaxLevel | 0 }, (_, i) => i + 1);
    next.ownedHeroes = union(player.ownedHeroes, ctx.heroIds);
    next.ownedCards = union(player.ownedCards, ctx.playableCards);
    next.devUnlockAll = true;
  }
  return { ok: true, codeId, reward: rewardDescription(codeId), ...next };
}

/** Conta com `devUnlockAll`: recebe heróis e cartas jogáveis novos. Devolve true se mudou. */
export function ensureDevUnlocks(player, { playableCards, heroIds }) {
  if (!player?.devUnlockAll) return false;
  const heroes = union(player.ownedHeroes, heroIds);
  const cards = union(player.ownedCards, playableCards);
  const changed = heroes.length !== (player.ownedHeroes?.length || 0)
    || cards.length !== (player.ownedCards?.length || 0);
  if (changed) {
    player.ownedHeroes = heroes;
    player.ownedCards = cards;
  }
  return changed;
}
