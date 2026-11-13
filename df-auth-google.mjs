/**
 * Dragonfall — validação de ID token do Google (login com Google, Fase 3).
 *
 * Sem dependências novas: RS256 com node:crypto + JWKS do Google.
 * O JWKS é buscado em GOOGLE_JWKS_URL (padrão: certs de produção do Google)
 * e guardado em cache por 1h. O `aud` tem que ser o GOOGLE_CLIENT_ID —
 * o Client ID do projeto OAuth criado no Google Cloud (passo feito com
 * a usuária, Fase 3). Sem GOOGLE_CLIENT_ID, a validação recusa tudo.
 */

import crypto from "node:crypto";

const GOOGLE_JWKS_URL =
  process.env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SEC = 60;

let jwksCache = { keys: null, fetchedAt: 0 };

function fail(code) {
  const e = new Error(code);
  e.code = code;
  throw e;
}

function b64urlDecode(input) {
  const s = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(s, "base64");
}

function parseJwt(token) {
  if (typeof token !== "string") fail("GOOGLE_TOKEN_MALFORMED");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    fail("GOOGLE_TOKEN_MALFORMED");
  }
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  } catch {
    fail("GOOGLE_TOKEN_MALFORMED");
  }
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

async function fetchJwks() {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) fail("GOOGLE_JWKS_UNAVAILABLE");
  const data = await res.json();
  if (!Array.isArray(data.keys)) fail("GOOGLE_JWKS_UNAVAILABLE");
  jwksCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

function findJwk(keys, kid) {
  return keys.find((k) => k && k.kid === kid && k.kty === "RSA" && k.n && k.e) || null;
}

/**
 * Valida um ID token do Google e devolve as claims.
 * Lança Error com .code em qualquer falha (nunca devolve parcial).
 */
export async function verifyGoogleIdToken(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) fail("GOOGLE_NOT_CONFIGURED");
  const { header, payload, signingInput, signature } = parseJwt(idToken);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    fail("GOOGLE_TOKEN_MALFORMED");
  }
  const keys = await fetchJwks();
  const jwk = findJwk(keys, header.kid);
  if (!jwk) fail("GOOGLE_TOKEN_NO_KEY");
  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    fail("GOOGLE_TOKEN_NO_KEY");
  }
  const ok = crypto.createVerify("RSA-SHA256").update(signingInput).verify(key, b64urlDecode(signature));
  if (!ok) fail("GOOGLE_TOKEN_BAD_SIGNATURE");
  if (!GOOGLE_ISSUERS.has(payload.iss)) fail("GOOGLE_TOKEN_BAD_ISSUER");
  if (payload.aud !== clientId) fail("GOOGLE_TOKEN_BAD_AUDIENCE");
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < nowSec - CLOCK_SKEW_SEC) {
    fail("GOOGLE_TOKEN_EXPIRED");
  }
  if (typeof payload.iat === "number" && payload.iat > nowSec + CLOCK_SKEW_SEC) {
    fail("GOOGLE_TOKEN_MALFORMED");
  }
  if (typeof payload.sub !== "string" || !payload.sub) fail("GOOGLE_TOKEN_MALFORMED");
  if (typeof payload.email !== "string" || !payload.email) fail("GOOGLE_TOKEN_NO_EMAIL");
  return payload;
}

/** Só para testes locais (limpa o cache do JWKS). */
export function __clearJwksCache() {
  jwksCache = { keys: null, fetchedAt: 0 };
}
