/**
 * Dragonfall — Jornada do Jogador (lógica pura).
 * Todo jogador começa só com a Eurávia; os outros heróis e as Moedas são
 * resgatados por nível (1–62). Autoridade: o servidor.
 */

export const JOURNEY_COINS = 6;
export const START_HERO_ID = "euravia";

/** Heróis por nível; os demais níveis (2–62) dão JOURNEY_COINS Moedas. */
const HERO_LEVELS = {
  1: "euravia",
  5: "ironGuard",
  8: "iceWitch",
  11: "thor",
  14: "vaughan",
  17: "linguarudo",
  20: "pirate",
  23: "princesaSlime",
  26: "quimera",
  29: "diablos",
  32: "hercules",
  35: "paladino",
  38: "tristana",
  41: "tecnomago",
  44: "sinistrela",
  47: "alquimista",
  50: "estrelar",
  53: "gancho",
  56: "valmont",
  59: "sangueDragao",
  62: "jekiro",
};

export const JOURNEY_MAX_LEVEL = 62;

export const JOURNEY_REWARDS = Object.freeze(
  Array.from({ length: JOURNEY_MAX_LEVEL }, (_, i) => {
    const level = i + 1;
    const heroId = HERO_LEVELS[level];
    return Object.freeze(heroId
      ? { level, type: "hero", heroId }
      : { level, type: "coins", coins: JOURNEY_COINS });
  }),
);

export function rewardForLevel(level) {
  const lv = Number(level) | 0;
  return JOURNEY_REWARDS[lv - 1] || null;
}

/** Avatar só entre heróis desbloqueados. */
export function isAvatarAllowed(player, heroId) {
  return Array.isArray(player?.ownedHeroes) && player.ownedHeroes.includes(heroId);
}

/**
 * Contas sem `ownedHeroes` (novas ou antigas) ficam só com a Eurávia e o nível 1 resgatado.
 * Avatar de herói ainda bloqueado volta para a Eurávia.
 * Devolve true se o jogador foi alterado.
 */
export function ensureJourneyState(player) {
  if (!player) return false;
  let changed = false;
  if (!Array.isArray(player.ownedHeroes) || !player.ownedHeroes.length) {
    player.ownedHeroes = [START_HERO_ID];
    changed = true;
  }
  if (!Array.isArray(player.claimedLevels) || !player.claimedLevels.length) {
    player.claimedLevels = [1];
    changed = true;
  }
  if (player.avatarHeroId && !isAvatarAllowed(player, player.avatarHeroId)) {
    player.avatarHeroId = START_HERO_ID;
    changed = true;
  }
  return changed;
}

/**
 * @param {{ ownedHeroes: string[], claimedLevels: number[], coins: number }} player
 * @param {number} level
 * @param {number} playerLevel nível atual (calculado do XP no servidor)
 */
export function claimLevel(player, level, playerLevel) {
  const lv = Number(level);
  if (!Number.isInteger(lv)) return { ok: false, error: "INVALID_LEVEL" };
  const reward = rewardForLevel(lv);
  if (!reward) return { ok: false, error: "INVALID_LEVEL" };
  const claimed = Array.isArray(player.claimedLevels) ? player.claimedLevels : [];
  if (claimed.includes(lv)) return { ok: false, error: "ALREADY_CLAIMED" };
  if (lv > (Number(playerLevel) | 0)) return { ok: false, error: "LEVEL_LOCKED" };

  const claimedLevels = [...claimed, lv].sort((a, b) => a - b);
  let coins = Math.max(0, player.coins | 0);
  let ownedHeroes = Array.isArray(player.ownedHeroes) ? player.ownedHeroes.slice() : [START_HERO_ID];
  if (reward.type === "coins") coins += reward.coins;
  else if (!ownedHeroes.includes(reward.heroId)) ownedHeroes.push(reward.heroId);
  return { ok: true, reward, claimedLevels, coins, ownedHeroes };
}
