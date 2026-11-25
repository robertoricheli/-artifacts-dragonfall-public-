/**
 * Dragonfall — contas de jogador (e-mail + senha + sessão + perfil).
 * Persistência via df-auth-store (Postgres quando DATABASE_URL; senão accounts.json).
 */
import crypto from "crypto";
import { sendPasswordResetLinkEmail, sendPasswordChangedNoticeEmail } from "./df-auth-mail.mjs";
import {
  initAuthStore,
  getAuthStoreMode,
  findPlayerByEmail,
  findPlayerByGoogleSub,
  getPlayerById,
  insertPlayer,
  persistPlayer,
  createSessionRecord,
  deleteSessionRecord,
  revokePlayerSessionsExcept,
  sessionExists,
  hashSessionToken,
  createPasswordResetRecord,
  consumePasswordResetRecord,
  authPlayerFromToken,
  getDisplayNameOwner,
  updateDisplayName,
} from "./df-auth-store.mjs";
import { verifyGoogleIdToken } from "./df-auth-google.mjs";
import { createRateLimiter } from "./rate-limit.mjs";
import {
  recordActivity,
  recordActivitySync,
  recordMatchXpEvent,
  countPlayerMatchHistory,
} from "./df-analytics.mjs";
import {
  ensureAchievementState,
  applyBackfill,
  applyMatchToStats,
  addCoinsSpent,
  claimAchievement,
  validateShowcase,
  achievementsPublic,
  normalizeStats,
  normalizeClaimed,
  progressFor,
} from "./df-achievements.mjs";
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
import {
  RANK_TIERS,
  MIN_MATCHES,
  TOP_SIZE,
  TOP_COINS,
  rankPublic,
  topPublic,
  seasonPublic,
  bestTierOf,
  touchRankDisplay,
  takePending,
  restorePending,
  setRankDisplayResolver,
} from "./df-rank.mjs";

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
 * iniciais. Os baralhos SÓ são criados quando não existem (`customDecks == null`) —
 * baralhos existentes nunca são sobrescritos (1.51.70, item 3).
 * Devolve true se o jogador foi alterado (precisa persistir).
 */
function ensureCollection(player) {
  let changed = ensureJourneyState(player);
  if (!Array.isArray(player.ownedCards) || !player.ownedCards.length) {
    const owned = rollStarter(getCardDefs());
    player.ownedCards = owned;
    if (player.customDecks == null) player.customDecks = starterDecks(owned);
    player.coins = Math.max(0, player.coins | 0);
    player.market = null;
    player.collectionEpoch = (player.collectionEpoch | 0) + 1;
    changed = true;
  }
  if (player.devUnlockAll && ensureDevUnlocks(player, unlockAllContext())) changed = true;
  return changed;
}

/** Campos de conquista + retroativo (uma vez por conta). Devolve true se mudou. */
async function ensureAchievements(player) {
  let changed = ensureAchievementState(player);
  // (Perfil do Jogador, 2026-11-25) o segundo termo cobre contas cujo
  // backfill antigo já rodou: sem ele, pvpMatches começaria em 0.
  if (!player.achStats.backfilled || !player.achStats.pvpMatchesBackfilled) {
    const counts = await countPlayerMatchHistory(player.id);
    if (counts) {
      player.achStats = applyBackfill(player.achStats, counts);
      changed = true;
    }
  }
  return changed;
}

async function ensurePlayerState(player) {
  const a = ensureCollection(player);
  const b = await ensureAchievements(player);
  return a || b;
}

async function withCollection(player) {
  if (!player || !(await ensurePlayerState(player))) return player;
  const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
  if (r.ok) return r.player;
  const fresh = await getPlayerById(player.id);
  if (fresh && (await ensurePlayerState(fresh))) {
    const r2 = await persistPlayer(fresh, { expectedRevision: Number(fresh.profileRevision ?? 0) });
    return r2.ok ? r2.player : fresh;
  }
  return fresh || player;
}

const SESSION_DAYS = 90;
const FORGOT_COOLDOWN_MS = 90_000;
const forgotLastSent = new Map();
/** Validade do link de recuperação de senha (1.51.68). */
const RESET_TOKEN_TTL_MS = 60 * 60_000;
/** Página pública de reset (1.51.71, item 14): servida pelo PRÓPRIO servidor
 * Render — NUNCA pelo site do jogo. O link do e-mail de recuperação apontava
 * para a página de reset no site, que não existe lá; o provedor do site
 * interceptava e caía na página "Netlify SSO Redirect Page". */
const RESET_PAGE_URL = "https://artifacts-dragonfall-public.onrender.com/reset";

/**
 * Página de reset servida pelo servidor (GET /reset?token=...).
 * HTML + CSS + JS puros, sem nenhuma dependência externa (sem Netlify, sem
 * Godot, sem CDN): abre em qualquer navegador e chama POST /auth/reset-password.
 */
const RESET_PAGE_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DRAGONFALL — Criar nova senha</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: "Segoe UI", Arial, sans-serif; color: #f3edff;
    background: radial-gradient(1200px 700px at 50% -10%, #5b3a8a 0%, #241640 55%, #120a24 100%); }
  .card { width: min(92vw, 420px); background: rgba(20, 12, 40, .88); border: 1px solid #6b4fa8;
    border-radius: 16px; padding: 28px 26px; box-shadow: 0 12px 40px rgba(0, 0, 0, .55); text-align: center; }
  h1 { margin: 0 0 4px; font-size: 1.7rem; letter-spacing: .14em; color: #ffd977; }
  p.sub { margin: 0 0 20px; color: #cfc2ee; font-size: .95rem; }
  label { display: block; text-align: left; font-size: .85rem; color: #cfc2ee; margin: 12px 0 6px; }
  input { width: 100%; padding: 12px 14px; font-size: 1rem; border-radius: 10px;
    border: 1px solid #6b4fa8; background: #1d1236; color: #fff; outline: none; }
  input:focus { border-color: #ffd977; }
  button { width: 100%; margin-top: 20px; padding: 13px; font-size: 1rem; font-weight: 700;
    letter-spacing: .06em; color: #241640; background: #ffd977; border: 0; border-radius: 10px; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  .msg { display: none; margin-top: 16px; padding: 12px; border-radius: 10px; font-size: .95rem; line-height: 1.45; }
  .msg.err { display: block; background: #4a1620; border: 1px solid #a33; color: #ffd7d7; }
  .msg.ok { display: block; background: #123d22; border: 1px solid #3a7; color: #d2ffe2; }
  .hint { margin-top: 14px; font-size: .8rem; color: #9d8cc4; }
</style>
</head>
<body>
  <div class="card">
    <h1>DRAGONFALL</h1>
    <p class="sub">Criar nova senha</p>
    <form id="f">
      <label for="pw1">Nova senha</label>
      <input id="pw1" type="password" autocomplete="new-password" minlength="6" required>
      <label for="pw2">Confirmar nova senha</label>
      <input id="pw2" type="password" autocomplete="new-password" minlength="6" required>
      <button id="btn" type="submit">SALVAR NOVA SENHA</button>
    </form>
    <div id="msg" class="msg"></div>
    <p class="hint">O link vale por 1 hora e só pode ser usado uma vez.</p>
  </div>
<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  var token = params.get("token") || "";
  var msg = document.getElementById("msg");
  var form = document.getElementById("f");
  var btn = document.getElementById("btn");
  function show(text, ok) {
    msg.textContent = text;
    msg.className = "msg " + (ok ? "ok" : "err");
  }
  if (!token) {
    form.style.display = "none";
    show("Link inválido ou expirado. Peça um novo link no jogo, em \u201cEsqueci a senha\u201d.", false);
    return;
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var pw1 = document.getElementById("pw1").value;
    var pw2 = document.getElementById("pw2").value;
    if (pw1.length < 6) { show("A senha precisa de pelo menos 6 caracteres.", false); return; }
    if (pw1 !== pw2) { show("As senhas não coincidem. Digite a mesma senha nos dois campos.", false); return; }
    btn.disabled = true;
    btn.textContent = "SALVANDO...";
    fetch("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token, newPassword: pw1 })
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
    .then(function (out) {
      if (out.status === 200 && out.data && out.data.ok) {
        form.style.display = "none";
        show("Senha alterada! Volte ao jogo e entre com a nova senha.", true);
        return;
      }
      var err = (out.data && out.data.error) || "";
      if (err === "INVALID_TOKEN") show("Este link expirou ou já foi usado. Peça um novo link no jogo, em \u201cEsqueci a senha\u201d.", false);
      else if (err === "PASSWORD_TOO_SHORT") show("A senha precisa de pelo menos 6 caracteres.", false);
      else show("Não foi possível alterar a senha. Tente novamente.", false);
      btn.disabled = false;
      btn.textContent = "SALVAR NOVA SENHA";
    }).catch(function () {
      show("Não foi possível conectar ao servidor. Confira a internet e tente novamente.", false);
      btn.disabled = false;
      btn.textContent = "SALVAR NOVA SENHA";
    });
  });
})();
</script>
</body>
</html>`;
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
  // Contas sem senha (ex.: só Google) nunca validam por senha — 401, nunca 500.
  try {
    if (typeof password !== "string" || !salt || !hash) return false;
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    const a = Buffer.from(check, "hex");
    const b = Buffer.from(String(hash), "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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

/** XP por nível — igual ao cliente (Profile.XP_PER_LEVEL). */
const XP_PER_LEVEL = 10;

/**
 * Curva de nível ÚNICA do servidor: 10 XP por nível, teto 62 — a mesma do
 * cliente (Profile.level = 1 + xp/10, JOURNEY_MAX_LEVEL = 62) e da sala
 * (rooms.mjs levelFromXp). Antes era triangular (10, 20, 30…), e o
 * /auth/me devolvia nível 6 com 25 XP enquanto a sala mostrava 3 — e a
 * Jornada liberava recompensa adiantada.
 */
function statsFromTotalXp(totalXp) {
  const xp = Math.max(0, totalXp | 0);
  const level = Math.min(JOURNEY_MAX_LEVEL, 1 + Math.floor(xp / XP_PER_LEVEL));
  return {
    level,
    xpInLevel: xp - (level - 1) * XP_PER_LEVEL,
    xpToNext: level >= JOURNEY_MAX_LEVEL ? 0 : XP_PER_LEVEL,
    totalXp: xp,
  };
}

/** XP total no início exato do nível `level`. */
function totalXpForLevel(level) {
  return Math.max(0, ((Math.min(level, JOURNEY_MAX_LEVEL) | 0) - 1)) * XP_PER_LEVEL;
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
    avatarColor: p.avatarColor || null,
    avatarFrame: p.avatarFrame || null,
    battleBg: p.battleBg || null,
    diamonds: Math.max(0, p.diamonds | 0),
    profileBg: p.profileBg || null,
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
    ...achievementsPublic({ ...p, rankBestTier: bestTierOf(p.id) }),
    rankBestTier: bestTierOf(p.id),
    rank: rankPublic(p.id),
  };
}

/** Nome/avatar/nível exibidos no Top 200 do Rank. */
function rankDisplayInfo(p) {
  if (!p) return null;
  return {
    name: p.displayName || null,
    avatarHeroId: p.avatarHeroId || null,
    level: statsFromTotalXp(p.xpTotal || 0).level,
  };
}

setRankDisplayResolver(async (id) => rankDisplayInfo(await getPlayerById(id)));

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

/** Customização por conta (1.51.70): avatarColor, avatarFrame, battleBg.
 *  Strings curtas (1–32 caracteres após trim). Valor inválido é IGNORADO
 *  sem quebrar o PATCH inteiro (nunca 400 aqui); ausência não apaga o
 *  valor já salvo. Devolve null quando não deve aplicar. */
function normCustomField(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 32) return null;
  return s;
}

/** Login em 1 dispositivo só (1.51.70, item 7). Identificação do aparelho
 *  vinda do cliente; string ≤ 64 — qualquer outra coisa vira null. */
function normDeviceField(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, 64);
}

function deviceFromBody(body) {
  return {
    deviceId: normDeviceField(body?.deviceId),
    deviceLabel: normDeviceField(body?.deviceLabel),
  };
}

/** index.mjs registra aqui o aviso aos sockets antigos da conta. */
let sessionRevokedNotifier = null;
export function setSessionRevokedNotifier(fn) {
  sessionRevokedNotifier = typeof fn === "function" ? fn : null;
}

/**
 * Cria a sessão do login. PRIMEIRO revoga todas as outras sessões da conta
 * (login em 1 dispositivo só) e SÓ DEPOIS cria a nova; o aparelho antigo é
 * avisado pelo notifier. NÃO é usado por troca de senha, reset de senha ou
 * /auth/logout — esses nunca deslogam outros aparelhos.
 */
async function createSession(playerId, device = {}) {
  await revokePlayerSessionsExcept(playerId, null);
  const token = newToken();
  await createSessionRecord(token, playerId, sessionExpiry(), device);
  if (sessionRevokedNotifier) {
    try {
      sessionRevokedNotifier(playerId, { deviceLabel: device.deviceLabel || null });
    } catch (e) {
      console.warn("[auth] session_revoked notifier:", e?.message || e);
    }
  }
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
    avatarColor: null,
    avatarFrame: null,
    battleBg: null,
    diamonds: 0,
    profileBg: null,
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
    achStats: { backfilled: true },
    achClaimed: [],
    achShowcase: [],
    profileRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  ensureCollection(player);
  setPlayerPassword(player, password);
  try {
    await insertPlayer(player);
  } catch (err) {
    // Corrida: outro registro com o mesmo e-mail passou no pré-check e
    // inseriu primeiro — violação de unique (23505) vira 409 limpo, nunca
    // derruba o processo (fix registro duplicado, 2026-11-16).
    if (err && (err.code === "23505" || err.constraint === "df_players_email_key")) {
      return { status: 409, data: { ok: false, error: "EMAIL_IN_USE" } };
    }
    throw err;
  }
  const token = await createSession(id, deviceFromBody(body));
  const saved = await getPlayerById(id);
  recordActivity(id, "register");
  return { status: 200, data: { ok: true, token, player: playerPublic(saved) } };
}

async function authLogin(req, body) {
  // Frente 1 (ALTA 3, 2026-11-24): um soluço do banco durante o login
  // virava rejeição async sem try/catch e derrubava o processo
  // (Express 4 não captura). Agora devolve 503 AUTH_UNAVAILABLE e o
  // servidor segue vivo.
  try {
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
    const token = await createSession(player.id, deviceFromBody(body));
    const fresh = await withCollection(await getPlayerById(player.id));
    recordActivity(player.id, "login");
    return { status: 200, data: { ok: true, token, player: playerPublic(fresh || player) } };
  } catch (e) {
    console.error("[auth] login indisponível:", e?.message || e);
    return { status: 503, data: { ok: false, error: "AUTH_UNAVAILABLE" } };
  }
}

/**
 * Login com Google (Fase 3).
 * POST /auth/google { idToken, displayName? }
 * - Valida o ID token do Google (assinatura, emissor, audiência, expiração).
 * - google_sub já vinculado → entra na conta (login).
 * - e-mail existe sem google_sub → vincula o Google à conta (o login com
 *   senha continua funcionando; o nome não muda, salvo se a conta não tem
 *   nome e o cliente trouxe um nome válido).
 * - e-mail novo → cria a conta (provider='google', sem senha).
 * Nome em conflito ou inválido → 409 NAME_TAKEN / 400 NAME_INVALID: o
 * cliente (Godot) mostra a tela "escolha outro nome" e repete a chamada
 * com displayName.
 */
async function authGoogle(req, body) {
  const limited = allowAuthAttempt(req, null);
  if (limited) return limited;
  const idToken = body?.idToken;
  if (typeof idToken !== "string" || !idToken) {
    return { status: 400, data: { ok: false, error: "MISSING_ID_TOKEN" } };
  }
  let claims;
  try {
    claims = await verifyGoogleIdToken(idToken);
  } catch (e) {
    return { status: 401, data: { ok: false, error: e?.code || "INVALID_GOOGLE_TOKEN" } };
  }
  if (claims.email_verified !== true) {
    return { status: 403, data: { ok: false, error: "GOOGLE_EMAIL_UNVERIFIED" } };
  }
  const email = normEmail(claims.email);
  if (!isValidEmail(email)) {
    return { status: 400, data: { ok: false, error: "EMAIL_INVALID" } };
  }
  const wantedName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  // 1) Conta já vinculada a este Google → login.
  const bySub = await findPlayerByGoogleSub(claims.sub);
  if (bySub) {
    const token = await createSession(bySub.id, deviceFromBody(body));
    const fresh = await withCollection(await getPlayerById(bySub.id));
    recordActivity(bySub.id, "login");
    return { status: 200, data: { ok: true, token, player: playerPublic(fresh || bySub), created: false, linked: false } };
  }
  // 2) E-mail existe → vincular.
  const byEmail = await findPlayerByEmail(email);
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== claims.sub) {
      return { status: 409, data: { ok: false, error: "GOOGLE_LINK_CONFLICT" } };
    }
    // Nome novo só se a conta ainda não tem nome.
    let newName = null;
    if (!byEmail.displayName && wantedName) {
      if (!isValidDisplayName(wantedName)) {
        return { status: 400, data: { ok: false, error: "NAME_INVALID" } };
      }
      const owner = await getDisplayNameOwner(wantedName.toLowerCase());
      if (owner && owner !== byEmail.id) {
        return { status: 409, data: { ok: false, error: "NAME_TAKEN" } };
      }
      newName = wantedName;
    }
    byEmail.googleSub = claims.sub;
    if (newName) byEmail.displayName = newName;
    const saved = await persistPlayer(byEmail);
    if (!saved.ok) {
      return { status: 500, data: { ok: false, error: saved.error || "SAVE_FAILED" } };
    }
    if (newName) {
      try {
        await updateDisplayName(byEmail.id, null, newName);
      } catch (e) {
        if (String(e?.message || "") === "NAME_TAKEN") {
          return { status: 409, data: { ok: false, error: "NAME_TAKEN" } };
        }
        throw e;
      }
    }
    const token = await createSession(byEmail.id, deviceFromBody(body));
    const fresh = await withCollection(await getPlayerById(byEmail.id));
    recordActivity(byEmail.id, "login");
    return { status: 200, data: { ok: true, token, player: playerPublic(fresh || byEmail), created: false, linked: true } };
  }
  // 3) Conta nova.
  const googleName = typeof claims.name === "string" ? claims.name.trim() : "";
  const name = wantedName || googleName;
  if (!isValidDisplayName(name)) {
    return { status: 400, data: { ok: false, error: "NAME_INVALID" } };
  }
  const owner = await getDisplayNameOwner(name.toLowerCase());
  if (owner) {
    return { status: 409, data: { ok: false, error: "NAME_TAKEN" } };
  }
  const id = newPlayerId();
  const now = new Date().toISOString();
  const player = {
    id,
    email,
    passwordSalt: "",
    passwordHash: "",
    passwordEnc: null,
    googleSub: claims.sub,
    provider: "google",
    displayName: name,
    displayNameLocked: false,
    avatarHeroId: null,
    hubBackgroundId: null,
    avatarColor: null,
    avatarFrame: null,
    battleBg: null,
    diamonds: 0,
    profileBg: null,
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
    achStats: { backfilled: true },
    achClaimed: [],
    achShowcase: [],
    profileRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  ensureCollection(player);
  await insertPlayer(player);
  try {
    await updateDisplayName(id, null, name);
  } catch (e) {
    if (String(e?.message || "") === "NAME_TAKEN") {
      // Corrida rara: a conta foi criada sem o nome reservado. A próxima
      // chamada com outro nome cai no caminho de vínculo e resolve.
      return { status: 409, data: { ok: false, error: "NAME_TAKEN" } };
    }
    throw e;
  }
  const token = await createSession(id, deviceFromBody(body));
  const saved = await getPlayerById(id);
  recordActivity(id, "register");
  return { status: 200, data: { ok: true, token, player: playerPublic(saved), created: true, linked: false } };
}

/** Token cru de reset → SHA-256 para guardar / buscar (nunca persiste o token cru). */
function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

/**
 * Recuperação de senha por LINK (1.51.68): gera um token aleatório, guarda o
 * hash com expiração de 1 h e uso único, e envia o link por e-mail. A senha
 * atual NÃO é invalidada — continua valendo até o jogador criar a nova.
 */
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
  // 32 bytes aleatórios, URL-safe (43 caracteres) — sem senha temporária.
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + RESET_TOKEN_TTL_MS;
  try {
    await createPasswordResetRecord(player.id, hashResetToken(token), expiresAt);
  } catch (e) {
    console.error("[auth] forgot-password: RESET_STORE_FAILED —", e?.message || e);
    return { status: 500, data: { ok: false, error: "SAVE_FAILED" } };
  }
  const resetLink = `${RESET_PAGE_URL}?token=${encodeURIComponent(token)}`;
  try {
    await sendPasswordResetLinkEmail(email, resetLink, player.language || null);
  } catch (e) {
    const code = String(e?.message || "").includes("MAIL_NOT_CONFIGURED")
      ? "MAIL_NOT_CONFIGURED"
      : String(e?.message || "").includes("MAIL_BAD_CREDENTIALS")
        ? "MAIL_BAD_CREDENTIALS"
        : "MAIL_FAILED";
    console.error("[auth] forgot-password:", e?.cause?.message || e?.message || e);
    return { status: 503, data: { ok: false, error: code } };
  }
  forgotLastSent.set(email, Date.now());
  // Loga só a BASE do link (o token nunca vai para o log) — é a prova de
  // que o e-mail aponta para o próprio servidor, não para o Netlify.
  console.log(`[auth] link de recuperação enviado por e-mail → ${email} (base: ${RESET_PAGE_URL})`);
  return { status: 200, data: { ok: true, sent: true } };
}

/**
 * Redefine a senha a partir do link de recuperação (1.51.68).
 * Corpo: {"token": "...", "newPassword": "..."}.
 * Token válido só 1 vez e só dentro de 1 h; a senha atual é substituída
 * somente aqui, depois do jogador clicar no link e criar a nova.
 */
async function authResetPassword(req, body) {
  const limited = allowAuthAttempt(req, null);
  if (limited) return limited;
  const token = String(body?.token || "").trim();
  const next = body?.newPassword;
  if (!token || !next) {
    return { status: 400, data: { ok: false, error: "MISSING_FIELDS" } };
  }
  if (!isValidPassword(next)) {
    return { status: 400, data: { ok: false, error: "PASSWORD_TOO_SHORT" } };
  }
  let playerId = null;
  try {
    playerId = await consumePasswordResetRecord(hashResetToken(token));
  } catch (e) {
    console.error("[auth] reset-password: RESET_STORE_FAILED —", e?.message || e);
    return { status: 500, data: { ok: false, error: "SAVE_FAILED" } };
  }
  if (!playerId) {
    return { status: 400, data: { ok: false, error: "INVALID_TOKEN" } };
  }
  const player = await getPlayerById(playerId);
  if (!player) {
    return { status: 400, data: { ok: false, error: "INVALID_TOKEN" } };
  }
  setPlayerPassword(player, next);
  const r = await persistPlayer(player);
  if (!r.ok) {
    console.error("[auth] reset-password: SAVE_FAILED —", r.error);
    return { status: 500, data: { ok: false, error: r.error || "SAVE_FAILED" } };
  }
  console.log(`[auth] senha redefinida por link → ${player.email}`);
  return { status: 200, data: { ok: true } };
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
  const token = bearerToken(req);
  const authed = await authFromHeader(req);
  if (!authed) {
    // Login em 1 dispositivo só (1.51.70, item 7): há token mas a sessão
    // não existe mais → outra aparelho logou na conta. Sessão expirada
    // (linha ainda presente) continua 401 UNAUTHORIZED.
    if (token && !(await sessionExists(hashSessionToken(token)))) {
      return { status: 401, data: { ok: false, error: "SESSION_REVOKED" } };
    }
    return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  }
  const player = await withCollection(authed);
  recordActivitySync(player.id);
  touchRankDisplay(player.id, rankDisplayInfo(player));
  return { status: 200, data: { ok: true, player: playerPublic(player) } };
}

function normalizeCustomDecks(raw, ownedCards) {
  const owned = Array.isArray(ownedCards) && ownedCards.length ? new Set(ownedCards) : null;
  if (!Array.isArray(raw) || raw.length !== 5) {
    return { ok: false, error: "BAD_DECKS" };
  }
  // 1.51.70, item 3: carta fora da coleção NÃO é trocada por null em
  // silêncio — o PATCH inteiro é recusado com 400 UNOWNED_CARD + a lista.
  const unowned = [];
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
        if (owned && !owned.has(nm)) {
          if (!unowned.includes(nm)) unowned.push(nm);
          cards.push(nm);
        } else cards.push(nm);
      }
    }
    return { name, cards };
  });
  if (unowned.length) return { ok: false, error: "UNOWNED_CARD", unowned };
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

  // Customização por conta (1.51.70): cor/moldura do avatar e fundo de
  // batalha. Valores inválidos são ignorados (normCustomField → null).
  // Fundo do perfil (2026-11-25): mesmo padrão — string com o índice 0..5.
  for (const [bodyKey, playerKey] of [["avatarColor", "avatarColor"], ["avatarFrame", "avatarFrame"], ["battleBg", "battleBg"], ["profileBg", "profileBg"]]) {
    if (body[bodyKey] != null) {
      const v = normCustomField(body[bodyKey]);
      if (v != null) player[playerKey] = v;
    }
  }

  if (body.language != null) {
    const lang = String(body.language);
    if (!LANGUAGE_IDS.has(lang)) {
      return { status: 400, data: { ok: false, error: "BAD_LANGUAGE" } };
    }
    player.language = lang;
  }

  /* Validações puras antes da reserva do nome (abaixo): um PATCH com
   * baralho ou vitrine inválido era recusado DEPOIS de reservar o nome
   * no banco — o nome ficava queimado para sempre, sem dono. */
  if (body.customDecks != null) {
    const norm = normalizeCustomDecks(body.customDecks, player.ownedCards);
    if (!norm.ok) {
      return {
        status: 400,
        data: { ok: false, error: norm.error, ...(norm.unowned ? { unowned: norm.unowned } : {}) },
      };
    }
    player.customDecks = norm.decks;
  }

  if (body.achShowcase != null) {
    const sc = validateShowcase(body.achShowcase, player.achClaimed);
    if (!sc.ok) return { status: 400, data: { ok: false, error: sc.error } };
    player.achShowcase = sc.showcase;
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

  touchRankDisplay(r.player.id, rankDisplayInfo(r.player));
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

  // Abandono: conta como derrota nas conquistas, sem XP/moedas nem linha de analytics.
  const abandoned = outcome === "lose" && body?.abandoned === true;
  const reward = abandoned
    ? { key: "abandon", xp: 0, coins: 0 }
    : rewardFor(matchType === "pvp" ? "pvp" : "ai", outcome);
  const key = reward.key;
  const gain = reward.xp;
  const coinsGain = reward.coins;
  const before = statsFromTotalXp(player.xpTotal || 0);
  player.xpTotal = (player.xpTotal || 0) + gain;
  player.coins = Math.max(0, player.coins | 0) + coinsGain;
  player.achStats = applyMatchToStats(player.achStats, {
    matchType,
    outcome,
    myVp: body?.myVp,
    oppVp: body?.oppVp,
    champKills: body?.champKills,
  });
  const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
  if (!r.ok) {
    return { status: 409, data: { ok: false, error: r.error, player: playerPublic(r.player) } };
  }
  const after = statsFromTotalXp(r.player.xpTotal);
  touchRankDisplay(r.player.id, rankDisplayInfo(r.player));

  if (!abandoned) {
    try {
      recordMatchXpEvent(r.player, body);
    } catch (e) { /* analytics never blocks */ }
  }

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

/**
 * Primeira sincronização (Fase 4): importa o progresso offline de uma
 * conta NOVA (sem nenhum progresso real) para o servidor — uma única
 * vez. O PATCH /auth/profile não cobre moedas, jornada, conquistas
 * nem estatísticas, então sem esta rota o progresso offline de quem
 * cria a conta depois de jogar offline se perderia. Guarda: a conta
 * precisa estar vazia (xpTotal 0, coins 0, achClaimed vazio); se já
 * tiver progresso, 409 ALREADY_SYNCED. Tudo é validado antes de
 * aplicar: níveis da jornada em prefixo [1..N] até o nível do XP
 * importado; cada conquista resgatada precisa estar concluída pelos
 * números importados; baralhos passam pelo normalizeCustomDecks sem
 * filtro de coleção (o Godot não tem coleção) e as cartas dos baralhos
 * entram em ownedCards; o avatar e os heróis da jornada entram em
 * ownedHeroes.
 */
async function authProfileImport(req, body) {
  const limited = allowAuthedAttempt(req);
  if (limited) return limited;
  const authed = await authFromHeader(req);
  if (!authed) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  const player = await withCollection(authed);
  const hasProgress = (Number(player.xpTotal ?? 0) > 0) || (Math.max(0, player.coins | 0) > 0) || (Array.isArray(player.achClaimed) && player.achClaimed.length > 0);
  if (hasProgress) {
    return { status: 409, data: { ok: false, error: "ALREADY_SYNCED", player: playerPublic(player) } };
  }
  const xpRaw = Number(body?.xpTotal ?? 0);
  const coinsRaw = Number(body?.coins ?? 0);
  if (!Number.isFinite(xpRaw) || !Number.isFinite(coinsRaw) || xpRaw < 0 || coinsRaw < 0 || xpRaw > 1000000 || coinsRaw > 1000000) {
    return { status: 400, data: { ok: false, error: "BAD_IMPORT" } };
  }
  const xpTotal = xpRaw | 0;
  const coins = coinsRaw | 0;
  // Jornada: prefixo [1..N], N até o nível do XP importado.
  const rawLevels = Array.isArray(body?.claimedLevels) ? body.claimedLevels : [];
  const levels = [...new Set(rawLevels.map((v) => Number(v) | 0))].filter((v) => v >= 1 && v <= JOURNEY_MAX_LEVEL).sort((a, b) => a - b);
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] !== i + 1) return { status: 400, data: { ok: false, error: "BAD_CLAIMED_LEVELS" } };
  }
  const levelFromXp = statsFromTotalXp(xpTotal).level;
  if (levels.length > 0 && levels[levels.length - 1] > levelFromXp) {
    return { status: 400, data: { ok: false, error: "LEVEL_LOCKED" } };
  }
  // Estatísticas sanitizadas (mesmas chaves do servidor).
  const stats = normalizeStats(body?.achStats ?? null);
  // Baralhos sem filtro de coleção (o cliente Godot não tem coleção).
  let decks = null;
  if (body?.customDecks != null) {
    const norm = normalizeCustomDecks(body.customDecks, null);
    if (!norm.ok) return { status: 400, data: { ok: false, error: norm.error } };
    decks = norm.decks;
  }
  // Avatar (precisa ser um herói válido).
  let avatarHeroId = null;
  if (body?.avatarHeroId != null && String(body.avatarHeroId) !== "") {
    const hid = String(body.avatarHeroId);
    if (!HERO_IDS.has(hid)) return { status: 400, data: { ok: false, error: "BAD_AVATAR" } };
    avatarHeroId = hid;
  }
  // Cosméticos (1.51.70): cor/moldura do avatar e fundo de batalha —
  // mesma validação do PATCH (normCustomField): inválido ignorado,
  // ausente/null não apaga o que já existe. Fundo do perfil (2026-11-25)
  // segue o mesmo padrão.
  const customFields = {};
  for (const key of ["avatarColor", "avatarFrame", "battleBg", "profileBg"]) {
    const v = normCustomField(body?.[key]);
    if (v != null) customFields[key] = v;
  }
  // Coleção: união do starter com as cartas dos baralhos; heróis:
  // união com o avatar e os heróis da jornada resgatada.
  const ownedCards = new Set(Array.isArray(player.ownedCards) ? player.ownedCards.map(String) : []);
  if (decks) {
    for (const d of decks) for (const c of d.cards || []) if (c != null && String(c) !== "") ownedCards.add(String(c));
  }
  const ownedHeroes = new Set(Array.isArray(player.ownedHeroes) ? player.ownedHeroes.map(String) : []);
  if (avatarHeroId) ownedHeroes.add(avatarHeroId);
  for (const lv of levels) {
    const rw = JOURNEY_REWARDS[lv - 1];
    if (rw && rw.type === "hero") ownedHeroes.add(rw.heroId);
  }
  // Conquistas resgatadas: precisam estar concluídas pelos números importados.
  const claimed = normalizeClaimed(body?.achClaimed ?? []);
  const probe = { ...player, xpTotal, coins, claimedLevels: levels, achClaimed: claimed, achStats: stats, ownedCards: [...ownedCards], ownedHeroes: [...ownedHeroes] };
  const prog = progressFor(probe);
  for (const id of claimed) {
    const p = prog[id];
    if (!p || !p.done) return { status: 400, data: { ok: false, error: "NOT_REACHED", id } };
  }
  // Vitrine (opcional): só conquistas resgatadas.
  let showcase = player.achShowcase ?? [];
  if (body?.achShowcase != null) {
    const sc = validateShowcase(body.achShowcase, claimed);
    if (!sc.ok) return { status: 400, data: { ok: false, error: sc.error } };
    showcase = sc.showcase;
  }
  player.xpTotal = xpTotal;
  player.coins = coins;
  player.claimedLevels = levels;
  player.achClaimed = claimed;
  player.achStats = stats;
  player.achShowcase = showcase;
  player.ownedCards = [...ownedCards];
  player.ownedHeroes = [...ownedHeroes];
  if (decks) player.customDecks = decks;
  if (avatarHeroId) player.avatarHeroId = avatarHeroId;
  for (const [key, v] of Object.entries(customFields)) player[key] = v;
  const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
  if (!r.ok) {
    if (r.error === "PROFILE_CONFLICT") return { status: 409, data: { ok: false, error: "PROFILE_CONFLICT", player: playerPublic(r.player) } };
    return { status: 500, data: { ok: false, error: r.error || "SAVE_FAILED" } };
  }
  return { status: 200, data: { ok: true, player: playerPublic(r.player) } };
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
  const spent = Math.max(0, player.coins | 0) - Math.max(0, res.coins | 0);
  if (spent > 0) player.achStats = addCoinsSpent(player.achStats, spent);
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

/** Conquistas: resgata as Moedas de uma conquista concluída. */
async function authAchievementClaim(req, body) {
  const limited = allowAuthedAttempt(req);
  if (limited) return limited;
  const authed = await authFromHeader(req);
  if (!authed) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  const id = String(body?.id || "");
  for (let attempt = 0; attempt < 2; attempt++) {
    const player = attempt === 0 ? await withCollection(authed) : await withCollection(await getPlayerById(authed.id));
    if (!player) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
    const res = claimAchievement({ ...player, rankBestTier: bestTierOf(player.id) }, id);
    if (!res.ok) {
      return { status: 400, data: { ok: false, error: res.error, player: playerPublic(player) } };
    }
    player.achClaimed = res.achClaimed;
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

const rankIpLimit = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

/** Página RANK: faixas, temporada e Top 200 (público); com sessão, também a posição do jogador. */
async function authRank(req) {
  if (!rankIpLimit(`rank:${clientIp(req)}`)) {
    return { status: 429, data: { ok: false, error: "RATE_LIMIT", retryAfterSec: 60 } };
  }
  let me = null;
  const authed = await authFromHeader(req);
  if (authed) {
    touchRankDisplay(authed.id, rankDisplayInfo(authed));
    me = { ...rankPublic(authed.id), ...rankDisplayInfo(authed) };
  }
  return {
    status: 200,
    data: {
      ok: true,
      season: seasonPublic(),
      tiers: RANK_TIERS,
      minMatches: MIN_MATCHES,
      topSize: TOP_SIZE,
      topCoins: TOP_COINS,
      top: topPublic(),
      me,
    },
  };
}

/** Fim de temporada: resgata as Moedas de Rank + Top 200 pendentes. */
async function authRankClaim(req) {
  const limited = allowAuthedAttempt(req);
  if (limited) return limited;
  const authed = await authFromHeader(req);
  if (!authed) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const player = attempt === 0 ? await withCollection(authed) : await withCollection(await getPlayerById(authed.id));
    if (!player) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
    const taken = takePending(player.id);
    if (!taken.list.length) {
      return { status: 400, data: { ok: false, error: "NOTHING_TO_CLAIM", player: playerPublic(player) } };
    }
    player.coins = Math.max(0, player.coins | 0) + taken.coins;
    const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
    if (r.ok) {
      return {
        status: 200,
        data: { ok: true, reward: { coins: taken.coins, seasons: taken.list }, player: playerPublic(r.player) },
      };
    }
    restorePending(player.id, taken.list);
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
    // Diamantes (Perfil do Jogador, 2026-11-25): só quando a recompensa
    // traz diamantes (res.diamonds ausente = código sem eles, saldo intacto).
    if (res.diamonds != null) player.diamonds = res.diamonds;
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
  else if (req.method === "POST" && pathname === "/auth/google") result = await authGoogle(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/forgot-password") result = await authForgotPassword(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/reset-password") result = await authResetPassword(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/change-password") result = await authChangePassword(fakeReq, body);
  else if (req.method === "GET" && pathname === "/auth/me") result = await authMe(fakeReq);
  else if (req.method === "PATCH" && pathname === "/auth/profile") result = await authProfile(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/match-xp") result = await authAwardMatchXp(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/profile/import") result = await authProfileImport(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/market") result = await authMarket(fakeReq);
  else if (req.method === "POST" && pathname === "/auth/market/refresh") result = await authMarketRefresh(fakeReq);
  else if (req.method === "POST" && pathname === "/auth/market/buy") result = await authMarketBuy(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/journey/claim") result = await authJourneyClaim(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/redeem") result = await authRedeem(fakeReq, body);
  else if (req.method === "POST" && pathname === "/auth/achievements/claim") result = await authAchievementClaim(fakeReq, body);
  else if (req.method === "GET" && pathname === "/auth/rank") result = await authRank(fakeReq);
  else if (req.method === "POST" && pathname === "/auth/rank/claim") result = await authRankClaim(fakeReq);
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

  app.post("/auth/google", async (req, res) => {
    const r = await authGoogle(req, req.body);
    res.status(r.status).json(r.data);
  });

  app.post("/auth/forgot-password", async (req, res) => {
    const r = await authForgotPassword(req, req.body);
    res.status(r.status).json(r.data);
  });

  // Página pública de reset (1.51.71, item 14): servida pelo próprio
  // servidor, sem Netlify. O token vem em ?token= e a página chama
  // POST /auth/reset-password.
  app.get("/reset", (_req, res) => {
    res.status(200).type("html").send(RESET_PAGE_HTML);
  });

  app.post("/auth/reset-password", async (req, res) => {
    const r = await authResetPassword(req, req.body || {});
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

  app.post("/auth/profile/import", async (req, res) => {
    const r = await authProfileImport(req, req.body || {});
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

  app.post("/auth/achievements/claim", async (req, res) => {
    const r = await authAchievementClaim(req, req.body || {});
    res.status(r.status).json(r.data);
  });

  app.get("/auth/rank", async (req, res) => {
    const r = await authRank(req);
    res.status(r.status).json(r.data);
  });

  app.post("/auth/rank/claim", async (req, res) => {
    const r = await authRankClaim(req);
    res.status(r.status).json(r.data);
  });

  app.post("/auth/logout", async (req, res) => {
    const r = await authLogout(req);
    res.status(r.status).json(r.data);
  });
}
