/**
 * Dragonfall — contas de jogador (e-mail + senha + sessão + perfil).
 * Persistência via df-auth-store (Postgres quando DATABASE_URL; senão accounts.json).
 */
import crypto from "crypto";
import { sendPasswordResetEmail, sendPasswordChangedEmail } from "./df-auth-mail.mjs";
import { encryptPassword } from "./df-auth-secret.mjs";
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

export { initAuthStore, getAuthStoreMode };

const SESSION_DAYS = 90;
const MAX_SESSIONS_PER_PLAYER = 8;
const FORGOT_COOLDOWN_MS = 90_000;
const forgotLastSent = new Map();
const authIpLimit = createRateLimiter({ maxPerWindow: 20, windowMs: 60_000 });
const authEmailLimit = createRateLimiter({ maxPerWindow: 8, windowMs: 60_000 });

const HERO_IDS = new Set([
  "vaughan", "iceWitch", "linguarudo", "pirate", "euravia", "ironGuard",
  "princesaSlime", "thor", "jekiro", "sangueDragao", "gancho", "paladino",
  "alquimista", "valmont", "tecnomago", "quimera", "hercules",
  "sinistrela", "estrelar",
]);

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
    customDecks: Array.isArray(p.customDecks) ? p.customDecks : null,
    profileRevision: Number(p.profileRevision ?? 0),
    updatedAt: p.updatedAt || null,
    level: xp.level,
    xpInLevel: xp.xpInLevel,
    xpToNext: xp.xpToNext,
    totalXp: xp.totalXp,
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
  player.passwordEnc = encryptPassword(password);
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
    customDecks: null,
    xpTotal: 0,
    profileRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  setPlayerPassword(player, password);
  await insertPlayer(player);
  const token = await createSession(id);
  const saved = await getPlayerById(id);
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
  if (!player.passwordEnc) {
    player.passwordEnc = encryptPassword(password);
    await persistPlayer(player);
    const refreshed = await getPlayerById(player.id);
    const token = await createSession(player.id);
    return { status: 200, data: { ok: true, token, player: playerPublic(refreshed) } };
  }
  const token = await createSession(player.id);
  return { status: 200, data: { ok: true, token, player: playerPublic(player) } };
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
  setPlayerPassword(player, tempPassword);
  const save = await persistPlayer(player);
  if (!save.ok) {
    return { status: 500, data: { ok: false, error: save.error || "SAVE_FAILED" } };
  }
  try {
    await sendPasswordResetEmail(email, tempPassword);
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
  console.log(`[auth] senha temporária enviada por e-mail → ${email}`);
  return { status: 200, data: { ok: true, sent: true } };
}

async function authChangePassword(req, body) {
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
    await sendPasswordChangedEmail(player.email, next);
  } catch (e) {
    mailSent = false;
    console.error("[auth] change-password mail:", e?.cause?.message || e?.message || e);
  }

  console.log(`[auth] senha alterada → ${player.email} (mailSent=${mailSent})`);
  return { status: 200, data: { ok: true, mailSent } };
}

async function authMe(req) {
  const player = await authFromHeader(req);
  if (!player) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };
  return { status: 200, data: { ok: true, player: playerPublic(player) } };
}

function normalizeCustomDecks(raw) {
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
      else cards.push(String(c).trim().slice(0, 80));
    }
    return { name, cards };
  });
  return { ok: true, decks };
}

async function authProfile(req, body) {
  const player = await authFromHeader(req);
  if (!player) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };

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
    player.avatarHeroId = hid;
  }

  if (body.hubBackgroundId != null) {
    const bid = String(body.hubBackgroundId);
    if (!HUB_BG_IDS.has(bid)) {
      return { status: 400, data: { ok: false, error: "BAD_HUB_BG" } };
    }
    player.hubBackgroundId = bid;
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
    const norm = normalizeCustomDecks(body.customDecks);
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

const MATCH_XP = {
  ai: { win: 2, lose: 1 },
  ai_normal: { win: 2, lose: 1 },
  ai_hard: { win: 3, lose: 1 },
  pvp: { win: 5, lose: 2 },
};

function resolveMatchXpKey(matchType, aiDifficulty) {
  if (matchType === "pvp") return "pvp";
  if (matchType !== "ai") return null;
  if (aiDifficulty === "hard" || matchType === "ai_hard") return "ai_hard";
  return "ai_normal";
}

async function authAwardMatchXp(req, body) {
  const player = await authFromHeader(req);
  if (!player) return { status: 401, data: { ok: false, error: "UNAUTHORIZED" } };

  const rawType = body?.matchType;
  const matchType = rawType === "pvp" || rawType === "ai" || rawType === "ai_hard" || rawType === "ai_normal"
    ? rawType
    : null;
  const outcome = body?.outcome === "win" ? "win" : body?.outcome === "lose" ? "lose" : null;
  if (!matchType || !outcome) {
    return { status: 400, data: { ok: false, error: "BAD_MATCH" } };
  }

  const key = resolveMatchXpKey(matchType, body?.aiDifficulty)
    || (matchType === "pvp" ? "pvp" : "ai_normal");
  const gain = MATCH_XP[key]?.[outcome] ?? MATCH_XP.ai[outcome];
  const before = statsFromTotalXp(player.xpTotal || 0);
  player.xpTotal = (player.xpTotal || 0) + gain;
  const r = await persistPlayer(player, { expectedRevision: Number(player.profileRevision ?? 0) });
  if (!r.ok) {
    return { status: 409, data: { ok: false, error: r.error, player: playerPublic(r.player) } };
  }
  const after = statsFromTotalXp(r.player.xpTotal);

  return {
    status: 200,
    data: {
      ok: true,
      gain,
      matchKey: key,
      leveledUp: after.level > before.level,
      player: playerPublic(r.player),
    },
  };
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

  app.post("/auth/logout", async (req, res) => {
    const r = await authLogout(req);
    res.status(r.status).json(r.data);
  });
}
