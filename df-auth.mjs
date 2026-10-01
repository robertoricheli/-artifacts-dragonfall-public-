/**
 * Dragonfall — contas de jogador (e-mail + senha + sessão + perfil).
 * Persistência via df-auth-store (Postgres quando DATABASE_URL; senão accounts.json).
 */
import crypto from "crypto";
import { sendPasswordResetEmail, sendPasswordChangedNoticeEmail } from "./df-auth-mail.mjs";
import {
  initAuthStore,
  getAuthStoreMode,
  findPlayerByEmail,
  getPlayerById,
  insertPlayer,
  persistPlayer,
  createSessionRecord,
  deleteSessionRecord,
  authPlayerFromToken,
  getDisplayNameOwner,
  updateDisplayName,
  prunePlayerSessions,
} from "./df-auth-store.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import {
  recordActivity,
  recordActivitySync,
  recordMatchXpEvent,
} from "./df-analytics.mjs";
import { bootDragonfallEngine } from "./lib/df-node-boot.mjs";
import {
  rollStarter,
  starterDecks,
  ensureMarket,
  buyCard,
  refreshMarket,
  rewardFor,
  playablePool,
  CARD_PRICE,
  REFRESH_COST,
  MARKET_ROTATION_MS,
} from "./df-market.mjs";
import {
  ensureJourneyState,
  claimLevel,
  isAvatarAllowed,
  JOURNEY_REWARDS,
  JOURNEY_MAX_LEVEL,
} from "./df-journey.mjs";
import { verifyCode, redeemForPlayer, ensureDevUnlocks, DEV_LEVEL } from "./df-redeem.mjs";

export { initAuthStore, getAuthStoreMode };

let cardDefsCache = null;
let heroDefsCache = null;
function getCardDefs() {
  if (!cardDefsCache) cardDefsCache = bootDragonfallEngine().DfData.cardDefs || [];
  return cardDefsCache;
}

function getHeroDefs() {
  if (!heroDefsCache) heroDefsCache = bootDragonfallEngine().DfData.heroDefs || [];
  return heroDefsCache;
}

/** Cartas jogáveis + todos os heróis (para contas com `devUnlockAll`). */
function unlockAllContext() {
  const heroIds = new Set(HERO_IDS);
  for (const r of JOURNEY_REWARDS) if (r.type === "hero") heroIds.add(r.heroId);
  for (const h of getHeroDefs()) if (h?.id) heroIds.add(h.id);
  return {
    playableCards: playablePool(getCardDefs()).map((c) => c.name),
    heroIds: [...heroIds],
  };
}

/**
 * Coleção por conta: toda conta (nova ou antiga) sem `ownedCards` recebe as 20 cartas
 * iniciais; baralhos antigos são substituídos pelo Baralho 1 com essas cartas.
 * Devolve true se o jogador foi alterado (precisa persistir).
 */
function ensureCollection(player) {
  let changed = ensureJourneyState(player);
  if (!Array.isArray(player.ownedCards) || !player.ownedCards.length) {
    const owned = rollStarter(getCardDefs());
    player.ownedCards = owned;
    player.customDecks = starterDecks(owned);
    player.coins = Math.max(0, player.coins | 0);
    player.market = null;
    player.collectionEpoch = (player.collectionEpoch | 0) + 1;
    changed = true;
  }
  if (player.devUnlockAll && ensureDevUnlocks(player, unlockAllContext())) changed = true;
  return changed;
}

async function withCollection(player) {
  if (!player || !ensureCollection(player)) return player;
  const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
  if (r.ok) return r.player;
  const fresh = await getPlayerById(player.id);
  if (fresh && ensureCollection(fresh)) {
    const r2 = await persistPlayer(fresh, { expectedRevision: Number(fresh.profileRevision ?? 0) });
    return r2.ok ? r2.player : fresh;
  }
  return fresh || player;
}

const SESSION_DAYS = 90;
const MAX_SESSIONS_PER_PLAYER = 8;
const FORGOT_COOLDOWN_MS = 90_000;
const forgotLastSent = new Map();
const authIpLimit = createRateLimiter({ maxPerWindow: 20, windowMs: 60_000 });
const authEmailLimit = createRateLimiter({ maxPerWindow: 8, windowMs: 60_000 });
/** Rotas autenticadas (perfil / XP / troca de senha). */
const authAuthedLimit = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
/** Resgatar código: anti força bruta por conta e por IP. */
const redeemAccountLimit = createRateLimiter({ maxPerWindow: 10, windowMs: 10 * 60_000 });
const redeemIpLimit = createRateLimiter({ maxPerWindow: 30, windowMs: 10 * 60_000 });

const HERO_IDS = new Set([
  "vaughan", "iceWitch", "linguarudo", "pirate", "euravia", "ironGuard",
  "princesaSlime", "thor", "jekiro", "sangueDragao", "gancho", "paladino",
  "alquimista", "valmont", "tecnomago", "quimera", "hercules",
  "sinistrela", "estrelar", "diablos", "tristana",
]);

/** Idiomas da interface (DfI18n.LANGS no cliente). */
const LANGUAGE_IDS = new Set(["en", "pt", "es", "de", "ja", "zh"]);

const HUB_BG_IDS = new Set([
  "reino-encantado",
  "frente-de-batalha",
  "cidade-steampunk",
  "abismo-ametista",
  "arcadia",
  "montanha-flamejante",
  "masmorra-sem-fim",
  "bosque-dos-elfos",
  // Legado (conta antiga) — cliente mapeia para reino-encantado
  "vila-dos-cristais",
]);

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}

function isValidPassword(pw) {
  return typeof pw === "string" && pw.length >= 6 && pw.length <= 128;
}

function isValidDisplayName(name) {
  const n = String(name || "").trim();
  return n.length >= 3 && n.length <= 10 && /^[\p{L}\p{N}_][\p{L}\p{N}_\s.-]*$/u.test(n);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function newPlayerId() {
  return crypto.randomUUID();
}

function sessionExpiry() {
  return Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
}

function xpRequiredForLevelUp(level) {
  const lv = Math.max(1, level | 0);
  return lv + 1;
}

function statsFromTotalXp(totalXp) {
  let level = 1;
  let remaining = Math.max(0, totalXp | 0);
  while (true) {
    const need = xpRequiredForLevelUp(level);
    if (remaining < need) {
      return {
        level,
        xpInLevel: remaining,
        xpToNext: need,
        totalXp: totalXp | 0,
      };
    }
    remaining -= need;
    level++;
  }
}

/** XP total no início exato do nível `level`. */
function totalXpForLevel(level) {
  let total = 0;
  for (let lv = 1; lv < (level | 0); lv++) total += xpRequiredForLevelUp(lv);
  return total;
}

function playerPublic(p) {
  if (!p) return null;
  const xp = statsFromTotalXp(p.xpTotal || 0);
  return {
    id: p.id,
    email: p.email,
    displayName: p.displayName || null,
    displayNameLocked: !!p.displayNameLocked,
    avatarHeroId: p.avatarHeroId || null,
    hubBackgroundId: p.hubBackgroundId || null,
    language: LANGUAGE_IDS.has(p.language) ? p.language : null,
    customDecks: Array.isArray(p.customDecks) ? p.customDecks : null,
    profileRevision: Number(p.profileRevision ?? 0),
    updatedAt: p.updatedAt || null,
    level: xp.level,
    xpInLevel: xp.xpInLevel,
    xpToNext: xp.xpToNext,
    totalXp: xp.totalXp,
    coins: Math.max(0, p.coins | 0),
    ownedCards: Array.isArray(p.ownedCards) ? p.ownedCards : null,
    collectionEpoch: p.collectionEpoch | 0,
    ownedHeroes: Array.isArray(p.ownedHeroes) ? p.ownedHeroes : null,
    claimedLevels: Array.isArray(p.claimedLevels) ? p.claimedLevels : null,
    devUnlockAll: !!p.devUnlockAll,
  };
}

function bearerToken(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

async function authFromHeader(req) {
  const tok = bearerToken(req);
  if (!tok) return null;
  return authPlayerFromToken(tok);
}

async function createSession(playerId) {
  await prunePlayerSessions(playerId, MAX_SESSIONS_PER_PLAYER - 1);
  const token = newToken();
  await createSessionRecord(token, playerId, sessionExpiry());
  return token;
}

function setPlayerPassword(player, password) {
  const { salt, hash } = hashPassword(password);
  player.passwordSalt = salt;
  player.passwordHash = hash;
  // Nunca armazenar senha reversível (passwordEnc legado).
  player.passwordEnc = null;
}

function allowAuthedAttempt(req) {
  const ip = clientIp(req);
  if (!authAuthedLimit(`authed:${ip}`)) {
    return { status: 429, data: { ok: false, error: "RATE_LIMIT", retryAfterSec: 60 } };
  }
  return null;
}

/** Senha temporária aleatória (não reutiliza passwordEnc reversível). */
function newTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function clientIp(req) {
  const xf = req?.headers?.["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return req?.socket?.remoteAddress || req?.ip || "unknown";
}

function allowAuthAttempt(req, email) {
  const ip = clientIp(req);
  if (!authIpLimit(`ip:${ip}`)) {
    return { status: 429, data: { ok: false, error: "RATE_LIMIT", retryAfterSec: 60 } };
  }
  if (email && !authEmailLimit(`email:${normEmail(email)}`)) {
    return { status: 429, data: { ok: false, error: "RATE_LIMIT", retryAfterSec: 60 } };
  }
  return null;
}

async function authRegister(req, body) {
  const limited = allowAuthAttempt(req, body?.email);
  if (limited) return limited;
  const email = normEmail(body?.email);
  const password = body?.password;
  if (!isValidEmail(email)) return { status: 400, data: { ok: false, error: "EMAIL_INVALID" } };
  if (!isValidPassword(password)) {
    return { status: 400, data: { ok: false, error: "PASSWORD_TOO_SHORT" } };
  }
  if (await findPlayerByEmail(email)) {
    return { status: 409, data: { ok: false, error: "EMAIL_IN_USE" } };
  }
  const id = newPlayerId();
  const now = new Date().toISOString();
  const player = {
    id,
    email,
    passwordSalt: "",
    passwordHash: "",
    passwordEnc: null,
    displayName: null,
    displayNameLocked: false,
    avatarHeroId: null,
    hubBackgroundId: null,
    language: null,
    customDecks: null,
    xpTotal: 0,
    coins: 0,
    ownedCards: null,
    market: null,
    collectionEpoch: 0,
    ownedHeroes: null,
    claimedLevels: null,
    redeemedCodes: null,
    devUnlockAll: false,
    profileRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  ensureCollection(player);
  setPlayerPassword(player, password);
  await insertPlayer(player);
  const token = await createSession(id);
  const saved = await getPlayerById(id);
  recordActivity(id, "register");
  return { status: 200, data: { ok: true, token, player: playerPublic(saved) } };
}

async function authLogin(req, body) {
  const limited = allowAuthAttempt(req, body?.email);
  if (limited) return limited;
  const email = normEmail(body?.email);
  const password = body?.password;
  const player = await findPlayerByEmail(email);
  if (!player || !verifyPassword(password, player.passwordSalt, player.passwordHash)) {
    return { status: 401, data: { ok: false, error: "INVALID_CREDENTIALS" } };
  }
  // Limpa passwordEnc legado se ainda existir na linha.
  if (player.passwordEnc) {
    player.passwordEnc = null;
    await persistPlayer(player).catch(() => {});
  }
  const token = await createSession(player.id);
  const fresh = await withCollection(await getPlayerById(player.id));
  recordActivity(player.id, "login");
  return { status: 200, data: { ok: true, token, player: playerPublic(fresh || player) } };
}

async function authForgotPassword(req, body) {
  const limited = allowAuthAttempt(req, body?.email);
  if (limited) return limited;
  const email = normEmail(body?.email);
  if (!isValidEmail(email)) {
    return { status: 400, data: { ok: false, error: "EMAIL_INVALID" } };
  }
  const player = await findPlayerByEmail(email);
  if (!player) {
    return { status: 200, data: { ok: true, sent: false } };
  }
  const lastAt = forgotLastSent.get(email) || 0;
  if (Date.now() - lastAt < FORGOT_COOLDOWN_MS) {
    const waitSec = Math.ceil((FORGOT_COOLDOWN_MS - (Date.now() - lastAt)) / 1000);
    return {
      status: 429,
      data: { ok: false, error: "FORGOT_COOLDOWN", retryAfterSec: waitSec },
    };
  }
  const tempPassword = newTemporaryPassword();
  // Envia e-mail ANTES de invalidar a senha — evita lockout se SMTP falhar.
  try {
    await sendPasswordResetEmail(email, tempPassword, player.language || null);
  } catch (e) {
    const code = String(e?.message || "").includes("MAIL_NOT_CONFIGURED")
      ? "MAIL_NOT_CONFIGURED"
      : String(e?.message || "").includes("MAIL_BAD_CREDENTIALS")
        ? "MAIL_BAD_CREDENTIALS"
        : "MAIL_FAILED";
    console.error("[auth] forgot-password:", e?.cause?.message || e?.message || e);
    return { status: 503, data: { ok: false, error: code } };
  }
  setPlayerPassword(player, tempPassword);
  const save = await persistPlayer(player);
  if (!save.ok) {
    console.error("[auth] forgot-password: e-mail enviado mas SAVE_FAILED —", save.error);
    return { status: 500, data: { ok: false, error: save.error || "SAVE_FAILED" } };
  }
  forgotLastSent.set(email, Date.now());
  console.log(`[auth] senha temporária enviada por e-mail → ${email}`);
  return { status: 200, data: { ok: true, sent: true } };
}

async function authChangePassword(req, body) {
  const limited = allowAuthedAttempt(req);
  if (limited) return limited;
  const player = await authFromHeader(req);
  if (!player) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };

  const current = body?.currentPassword;
  const next = body?.newPassword;
  if (!current || !next) {
    return { status: 400, data: { ok: false, error: "MISSING_FIELDS" } };
  }
  if (!isValidPassword(next)) {
    return { status: 400, data: { ok: false, error: "PASSWORD_TOO_SHORT" } };
  }
  if (!verifyPassword(current, player.passwordSalt, player.passwordHash)) {
    return { status: 401, data: { ok: false, error: "INVALID_CREDENTIALS" } };
  }
  if (current === next) {
    return { status: 400, data: { ok: false, error: "PASSWORD_UNCHANGED" } };
  }

  setPlayerPassword(player, next);
  const r = await persistPlayer(player);
  if (!r.ok) {
    return { status: 500, data: { ok: false, error: r.error || "SAVE_FAILED" } };
  }

  let mailSent = true;
  try {
    await sendPasswordChangedNoticeEmail(player.email, player.language || null);
  } catch (e) {
    mailSent = false;
    console.error("[auth] change-password mail:", e?.cause?.message || e?.message || e);
  }

  console.log(`[auth] senha alterada → ${player.email} (mailSent=${mailSent})`);
  return { status: 200, data: { ok: true, mailSent } };
}

async function authMe(req) {
  const authed = await authFromHeader(req);
  if (!authed) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  const player = await withCollection(authed);
  recordActivitySync(player.id);
  return { status: 200, data: { ok: true, player: playerPublic(player) } };
}

function normalizeCustomDecks(raw, ownedCards) {
  const owned = Array.isArray(ownedCards) && ownedCards.length ? new Set(ownedCards) : null;
  if (!Array.isArray(raw) || raw.length !== 5) {
    return { ok: false, error: "BAD_DECKS" };
  }
  const decks = raw.map((entry, i) => {
    let name = String(entry?.name || "").trim();
    if (!name) name = `Baralho ${i + 1}`;
    if (name.length > 32) name = name.slice(0, 32);
    const cardsIn = Array.isArray(entry?.cards) ? entry.cards.slice(0, 24) : [];
    const cards = [];
    for (let s = 0; s < 24; s++) {
      const c = cardsIn[s];
      if (c == null || c === "") cards.push(null);
      else {
        const nm = String(c).trim().slice(0, 80);
        cards.push(owned && !owned.has(nm) ? null : nm);
      }
    }
    return { name, cards };
  });
  return { ok: true, decks };
}

async function authProfile(req, body) {
  const limited = allowAuthedAttempt(req);
  if (limited) return limited;
  const authed = await authFromHeader(req);
  if (!authed) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  const player = await withCollection(authed);

  const expectedRev = body?.profileRevision != null ? Number(body.profileRevision) : null;
  const currentRev = Number(player.profileRevision ?? 0);
  if (expectedRev != null && expectedRev !== currentRev) {
    return {
      status: 409,
      data: { ok: false, error: "PROFILE_CONFLICT", player: playerPublic(player) },
    };
  }

  if (body.avatarHeroId != null) {
    const hid = String(body.avatarHeroId);
    if (!HERO_IDS.has(hid)) {
      return { status: 400, data: { ok: false, error: "BAD_AVATAR" } };
    }
    /* herói ainda bloqueado: ignora e mantém o avatar atual (já validado) */
    if (isAvatarAllowed(player, hid)) player.avatarHeroId = hid;
  }

  if (body.hubBackgroundId != null) {
    const bid = String(body.hubBackgroundId);
    if (!HUB_BG_IDS.has(bid)) {
      return { status: 400, data: { ok: false, error: "BAD_HUB_BG" } };
    }
    player.hubBackgroundId = bid;
  }

  if (body.language != null) {
    const lang = String(body.language);
    if (!LANGUAGE_IDS.has(lang)) {
      return { status: 400, data: { ok: false, error: "BAD_LANGUAGE" } };
    }
    player.language = lang;
  }

  if (body.displayName != null) {
    const name = String(body.displayName).trim();
    if (player.displayNameLocked) {
      if (name !== player.displayName) {
        return { status: 403, data: { ok: false, error: "NAME_LOCKED" } };
      }
      /* mesmo nome já bloqueado — ignora (permite sync de baralhos/XP no mesmo PATCH) */
    } else {
      if (!isValidDisplayName(name)) {
        return { status: 400, data: { ok: false, error: "BAD_NAME" } };
      }
      const key = name.toLowerCase();
      const existing = await getDisplayNameOwner(key);
      if (existing && existing !== player.id) {
        return { status: 409, data: { ok: false, error: "NAME_TAKEN" } };
      }
      try {
        await updateDisplayName(player.id, player.displayName, name);
      } catch (e) {
        if (String(e?.message || e) === "NAME_TAKEN") {
          return { status: 409, data: { ok: false, error: "NAME_TAKEN" } };
        }
        throw e;
      }
      const owner = await getDisplayNameOwner(key);
      if (!owner || owner !== player.id) {
        return { status: 409, data: { ok: false, error: "NAME_TAKEN" } };
      }
      player.displayName = name;
      player.displayNameLocked = true;
    }
  }

  if (body.xpTotal != null) {
    const incoming = Math.max(0, Number(body.xpTotal) | 0);
    if (Number.isFinite(incoming)) {
      player.xpTotal = Math.max(player.xpTotal || 0, incoming);
    }
  }

  if (body.customDecks != null) {
    const norm = normalizeCustomDecks(body.customDecks, player.ownedCards);
    if (!norm.ok) {
      return { status: 400, data: { ok: false, error: norm.error } };
    }
    player.customDecks = norm.decks;
  }

  const r = await persistPlayer(player, { expectedRevision: expectedRev ?? currentRev });
  if (!r.ok) {
    if (r.error === "PROFILE_CONFLICT") {
      return {
        status: 409,
        data: { ok: false, error: "PROFILE_CONFLICT", player: playerPublic(r.player) },
      };
    }
    return { status: 500, data: { ok: false, error: r.error || "SAVE_FAILED" } };
  }

  return { status: 200, data: { ok: true, player: playerPublic(r.player) } };
}

async function authAwardMatchXp(req, body) {
  const limited = allowAuthedAttempt(req);
  if (limited) return limited;
  const authed = await authFromHeader(req);
  if (!authed) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  const player = await withCollection(authed);

  const rawType = body?.matchType;
  const matchType = rawType === "pvp" || rawType === "ai" || rawType === "ai_hard" || rawType === "ai_normal"
    ? rawType
    : null;
  const outcome = body?.outcome === "win" ? "win" : body?.outcome === "lose" ? "lose" : null;
  if (!matchType || !outcome) {
    return { status: 400, data: { ok: false, error: "BAD_MATCH" } };
  }

  const reward = rewardFor(matchType === "pvp" ? "pvp" : "ai", outcome);
  const key = reward.key;
  const gain = reward.xp;
  const coinsGain = reward.coins;
  const before = statsFromTotalXp(player.xpTotal || 0);
  player.xpTotal = (player.xpTotal || 0) + gain;
  player.coins = Math.max(0, player.coins | 0) + coinsGain;
  const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
  if (!r.ok) {
    return { status: 409, data: { ok: false, error: r.error, player: playerPublic(r.player) } };
  }
  const after = statsFromTotalXp(r.player.xpTotal);

  try {
    recordMatchXpEvent(r.player, body);
  } catch (e) { /* analytics never blocks */ }

  return {
    status: 200,
    data: {
      ok: true,
      gain,
      coinsGain,
      matchKey: key,
      leveledUp: after.level > before.level,
      player: playerPublic(r.player),
    },
  };
}

function marketPayload(player, extra = {}) {
  const m = player.market || { cards: [], dailyAt: Date.now() };
  return {
    ok: true,
    market: {
      cards: Array.isArray(m.cards) ? m.cards : [],
      dailyAt: m.dailyAt,
      nextRotationAt: (m.dailyAt || Date.now()) + MARKET_ROTATION_MS,
    },
    price: CARD_PRICE,
    refreshCost: REFRESH_COST,
    coins: Math.max(0, player.coins | 0),
    player: playerPublic(player),
    ...extra,
  };
}

/** Carrega jogador autenticado com coleção e mercado válidos (rotação 24h). */
async function marketPlayer(req) {
  const limited = allowAuthedAttempt(req);
  if (limited) return { error: limited };
  const authed = await authFromHeader(req);
  if (!authed) return { error: { status: 401, data: { ok: false, error: "UNAUTHORIZED" } } };
  let player = await withCollection(authed);
  const em = ensureMarket(player.market, getCardDefs(), player.ownedCards);
  if (em.changed) {
    player.market = em.market;
    const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
    if (!r.ok) return { error: { status: 409, data: { ok: false, error: r.error || "SAVE_FAILED" } } };
    player = r.player;
  }
  return { player };
}

async function authMarket(req) {
  const { player, error } = await marketPlayer(req);
  if (error) return error;
  return { status: 200, data: marketPayload(player) };
}

async function saveMarketChange(player, res, extra) {
  player.coins = res.coins;
  player.market = res.market;
  if (res.ownedCards) player.ownedCards = res.ownedCards;
  const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
  if (!r.ok) return { status: 409, data: { ok: false, error: r.error || "SAVE_FAILED" } };
  return { status: 200, data: marketPayload(r.player, extra) };
}

async function authMarketRefresh(req) {
  const { player, error } = await marketPlayer(req);
  if (error) return error;
  const res = refreshMarket(player, getCardDefs());
  if (!res.ok) return { status: 400, data: { ...marketPayload(player), ok: false, error: res.error } };
  return saveMarketChange(player, res);
}

async function authMarketBuy(req, body) {
  const { player, error } = await marketPlayer(req);
  if (error) return error;
  const name = String(body?.card || "").trim();
  const res = buyCard(player, name, getCardDefs());
  if (!res.ok) return { status: 400, data: { ...marketPayload(player), ok: false, error: res.error } };
  return saveMarketChange(player, res, { bought: name, slot: res.slot });
}

/** Jornada do Jogador: resgata a recompensa de um nível já alcançado. */
async function authJourneyClaim(req, body) {
  const limited = allowAuthedAttempt(req);
  if (limited) return limited;
  const authed = await authFromHeader(req);
  if (!authed) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  const level = Number(body?.level);
  for (let attempt = 0; attempt < 2; attempt++) {
    const player = attempt === 0 ? await withCollection(authed) : await withCollection(await getPlayerById(authed.id));
    if (!player) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
    const playerLevel = statsFromTotalXp(player.xpTotal || 0).level;
    const res = claimLevel(player, level, playerLevel);
    if (!res.ok) {
      return { status: 400, data: { ok: false, error: res.error, player: playerPublic(player) } };
    }
    player.claimedLevels = res.claimedLevels;
    player.ownedHeroes = res.ownedHeroes;
    player.coins = res.coins;
    const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
    if (r.ok) {
      return { status: 200, data: { ok: true, reward: res.reward, player: playerPublic(r.player) } };
    }
    if (r.error !== "PROFILE_CONFLICT") {
      return { status: 500, data: { ok: false, error: r.error || "SAVE_FAILED" } };
    }
  }
  return { status: 409, data: { ok: false, error: "PROFILE_CONFLICT" } };
}

/** Resgatar código: uma vez por conta; recompensa decidida pelo servidor. */
async function authRedeem(req, body) {
  const limited = allowAuthedAttempt(req);
  if (limited) return limited;
  if (!redeemIpLimit(`redeem-ip:${clientIp(req)}`)) {
    return { status: 429, data: { ok: false, error: "RATE_LIMIT", retryAfterSec: 600 } };
  }
  const authed = await authFromHeader(req);
  if (!authed) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  if (!redeemAccountLimit(`redeem-acc:${authed.id}`)) {
    return { status: 429, data: { ok: false, error: "RATE_LIMIT", retryAfterSec: 600 } };
  }
  const codeId = typeof body?.code === "string" ? verifyCode(body.code) : null;
  if (!codeId) return { status: 400, data: { ok: false, error: "INVALID_CODE" } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const player = attempt === 0 ? await withCollection(authed) : await withCollection(await getPlayerById(authed.id));
    if (!player) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
    const res = redeemForPlayer(player, codeId, {
      ...unlockAllContext(),
      devXpTotal: totalXpForLevel(DEV_LEVEL),
      journeyMaxLevel: JOURNEY_MAX_LEVEL,
    });
    if (!res.ok) {
      return { status: 400, data: { ok: false, error: res.error, player: playerPublic(player) } };
    }
    player.redeemedCodes = res.redeemedCodes;
    player.coins = res.coins;
    if (res.devUnlockAll) {
      player.xpTotal = res.xpTotal;
      player.claimedLevels = res.claimedLevels;
      player.ownedHeroes = res.ownedHeroes;
      player.ownedCards = res.ownedCards;
      player.devUnlockAll = true;
    }
    const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
    if (r.ok) {
      return { status: 200, data: { ok: true, reward: res.reward, player: playerPublic(r.player) } };
    }
    if (r.error !== "PROFILE_CONFLICT") {
      return { status: 500, data: { ok: false, error: r.error || "SAVE_FAILED" } };
    }
  }
  return { status: 409, data: { ok: false, error: "PROFILE_CONFLICT" } };
}

async function authLogout(req) {
  const tok = bearerToken(req);
  if (tok) await deleteSessionRecord(tok);
  return { status: 200, data: { ok: true } };
}

function sendAuthJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on("data", (chunk) => {
      len += chunk.length;
      if (len > 65536) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Rotas /auth/* para o servidor estático local (porta 5173). */
export async function handleAuthHttp(req, res) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const pathname = (req.url || "").split("?")[0];
  let body = {};
  if (req.method === "POST" || req.method === "PATCH") {
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendAuthJson(res, 400, { ok: false, error: "BAD_JSON" });
      return;
    }
  }

  const fakeReq = { method: req.method, headers: req.headers, body, socket: req.socket, ip: req.socket?.remoteAddress };
  let result = null;
  if (req.method === "POST" && pathname === "/auth/register") result = await authRegister(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/login") result = await authLogin(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/forgot-password") result = await authForgotPassword(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/change-password") result = await authChangePassword(fakeReq, body);
  else if (req.method === "GET" && pathname === "/auth/me") result = await authMe(fakeReq);
  else if (req.method === "PATCH" && pathname === "/auth/profile") result = await authProfile(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/match-xp") result = await authAwardMatchXp(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/market") result = await authMarket(fakeReq);
  else if (req.method === "POST" && pathname === "/auth/market/refresh") result = await authMarketRefresh(fakeReq);
  else if (req.method === "POST" && pathname === "/auth/market/buy") result = await authMarketBuy(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/journey/claim") result = await authJourneyClaim(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/redeem") result = await authRedeem(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/logout") result = await authLogout(fakeReq);
  else {
    sendAuthJson(res, 404, { ok: false, error: "NOT_FOUND" });
    return;
  }
  sendAuthJson(res, result.status, result.data);
}

export function registerAuthRoutes(app) {
  app.post("/auth/register", async (req, res) => {
    const r = await authRegister(req, req.body);
    res.status(r.status).json(r.data);
  });

  app.post("/auth/login", async (req, res) => {
    const r = await authLogin(req, req.body);
    res.status(r.status).json(r.data);
  });

  app.post("/auth/forgot-password", async (req, res) => {
    const r = await authForgotPassword(req, req.body);
    res.status(r.status).json(r.data);
  });

  app.post("/auth/change-password", async (req, res) => {
    const r = await authChangePassword(req, req.body || {});
    res.status(r.status).json(r.data);
  });

  app.get("/auth/me", async (req, res) => {
    const r = await authMe(req);
    res.status(r.status).json(r.data);
  });

  app.patch("/auth/profile", async (req, res) => {
    const r = await authProfile(req, req.body || {});
    res.status(r.status).json(r.data);
  });

  app.post("/auth/match-xp", async (req, res) => {
    const r = await authAwardMatchXp(req, req.body || {});
    res.status(r.status).json(r.data);
  });

  app.post("/auth/market", async (req, res) => {
    const r = await authMarket(req);
    res.status(r.status).json(r.data);
  });

  app.post("/auth/market/refresh", async (req, res) => {
    const r = await authMarketRefresh(req);
    res.status(r.status).json(r.data);
  });

  app.post("/auth/market/buy", async (req, res) => {
    const r = await authMarketBuy(req, req.body || {});
    res.status(r.status).json(r.data);
  });

  app.post("/auth/journey/claim", async (req, res) => {
    const r = await authJourneyClaim(req, req.body || {});
    res.status(r.status).json(r.data);
  });

  app.post("/auth/redeem", async (req, res) => {
    const r = await authRedeem(req, req.body || {});
    res.status(r.status).json(r.data);
  });

  app.post("/auth/logout", async (req, res) => {
    const r = await authLogout(req);
    res.status(r.status).json(r.data);
  });
}
