/**
 * DRAGONFALL — Presença + trava de convite (Frente 4, projeto 1.51.103,
 * item 4: CHAT entre jogadores + PRESENÇA + travar convite).
 *
 * NÃO edita index.mjs nem df-friends.mjs. A F9 registra as rotas e liga
 * as fontes de verdade; a F8 aplica a trava no fluxo de convite
 * chamando canReceiveInvite(); a F3 importa presenceFor() para as
 * listas de amigos.
 *
 * Estados (o que a jogadora vê):
 *   "available" — bolinha VERDE + "disponível"
 *   "busy"      — bolinha AMARELA + "ocupado" (em fila ou em partida)
 *   "offline"   — bolinha VERMELHA + "offline"
 * Regra: só jogador DISPONÍVEL recebe convite de partida. Offline ou
 * ocupado NÃO recebe convite — o servidor recusa e o cliente nem deixa
 * convidar (botão desabilitado com o motivo visível).
 *
 * Como a presença é decidida (ordem importa):
 *   1. em fila (casual ou ranked) OU em sala (lobby ou playing) -> busy
 *   2. socket autenticado conectado -> available
 *   3. resto -> offline
 * Um jogador em partida está, por definição, com socket conectado — por
 * isso o "busy" é checado ANTES do "available".
 *
 * Fontes de verdade: o módulo NÃO lê sockets, filas nem salas
 * diretamente (não conhece o index.mjs). Quem registra as rotas passa
 * as fontes — ver makePresenceSources() e a especificação de registro
 * no RELATORIO.md da F4. Sem fontes (uso isolado / testes), o serviço
 * responde a partir das fontes passadas; sem nenhuma fonte, todo mundo
 * é "offline" (fail-closed: ninguém recebe convite sem prova de que
 * está disponível).
 */

import { authPlayerFromToken } from "./df-auth-store.mjs";

export const PRESENCE = Object.freeze({
  AVAILABLE: "available",
  BUSY: "busy",
  OFFLINE: "offline",
});

/** Texto e cor que o cliente mostra (mesmos valores do PresenceBadge). */
export const PRESENCE_LABELS = Object.freeze({
  available: { text: "disponível", color: "#3ecf4a" },
  busy: { text: "ocupado", color: "#f2c531" },
  offline: { text: "offline", color: "#e5484d" },
});

export function presenceLabel(status) {
  return PRESENCE_LABELS[status] || PRESENCE_LABELS.offline;
}

function normId(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

function asSet(v) {
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v.map(String));
  return new Set();
}

/**
 * Fontes que a integração (F9) passa. Cada campo aceita um Set de
 * playerIds, um Array, ou uma função () => Set/Array (lida a cada
 * consulta, para refletir o estado atual):
 *   connected — playerIds com socket autenticado conectado
 *   queued    — playerIds em fila (casual e/ou ranked)
 *   inMatch   — playerIds em sala (lobby ou playing; "ended" NÃO conta)
 */
export function makePresenceSources({ connected, queued, inMatch } = {}) {
  const read = (v) => (typeof v === "function" ? asSet(v()) : asSet(v));
  return {
    isConnected: (pid) => read(connected).has(String(pid)),
    isQueued: (pid) => read(queued).has(String(pid)),
    isInMatch: (pid) => read(inMatch).has(String(pid)),
    // Só testes / depuração: fotografia das fontes neste instante.
    snapshot: () => ({
      connected: [...read(connected)],
      queued: [...read(queued)],
      inMatch: [...read(inMatch)],
    }),
  };
}

/**
 * presenceFor(playerId, sources) -> "available" | "busy" | "offline".
 * Pura e síncrona: a F3 usa direto nas listas; os testes passam fontes
 * de mentira. sources pode ser o retorno de makePresenceSources() ou
 * um objeto simples { connected:Set, queued:Set, inMatch:Set }.
 */
export function presenceFor(playerId, sources = {}) {
  const pid = normId(playerId);
  if (!pid) return PRESENCE.OFFLINE;
  const read = (v) => (typeof v === "function" ? asSet(v()) : asSet(v));
  // Aceita os dois formatos: funções (makePresenceSources) ou Sets.
  const isQueued =
    typeof sources.isQueued === "function"
      ? sources.isQueued(pid)
      : read(sources.queued).has(pid);
  const isInMatch =
    typeof sources.isInMatch === "function"
      ? sources.isInMatch(pid)
      : read(sources.inMatch).has(pid);
  if (isQueued || isInMatch) return PRESENCE.BUSY;
  const isConnected =
    typeof sources.isConnected === "function"
      ? sources.isConnected(pid)
      : read(sources.connected).has(pid);
  if (isConnected) return PRESENCE.AVAILABLE;
  return PRESENCE.OFFLINE;
}

/** Mapa playerId -> status para uma lista (a lista de amigos da F3). */
export function presenceMap(playerIds, sources = {}) {
  const out = {};
  for (const id of Array.isArray(playerIds) ? playerIds : []) {
    const pid = normId(id);
    if (pid) out[pid] = presenceFor(pid, sources);
  }
  return out;
}

/**
 * canReceiveInvite(playerId, sources) -> { ok, status, error? }.
 * É a TRAVA DE CONVITE do servidor. A F8 chama isto no handler
 * `invite_friend` (df-friends.mjs) ANTES de criar o convite:
 *   const gate = canReceiveInvite(toId, presenceSources);
 *   if (!gate.ok) return ack?.({ ok: false, error: gate.error });
 * Erros: "INVITE_OFFLINE" (offline) e "INVITE_BUSY" (em fila/partida).
 * O cliente usa o mesmo status para desabilitar o botão.
 */
export function canReceiveInvite(playerId, sources = {}) {
  const status = presenceFor(playerId, sources);
  if (status === PRESENCE.AVAILABLE) return { ok: true, status };
  if (status === PRESENCE.BUSY)
    return { ok: false, status, error: "INVITE_BUSY" };
  return { ok: false, status, error: "INVITE_OFFLINE" };
}

/** Serviço com as fontes fixas (o que a F9 instancia uma vez no boot). */
export function createPresenceService(sources = {}) {
  return {
    sources,
    presenceFor: (playerId) => presenceFor(playerId, sources),
    presenceMap: (playerIds) => presenceMap(playerIds, sources),
    canReceiveInvite: (playerId) => canReceiveInvite(playerId, sources),
  };
}

function bearerToken(req) {
  const h = req.headers?.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

/**
 * Rotas de presença (a F9 registra; NÃO mexer no index.mjs aqui).
 *
 *   GET /auth/presence?ids=<id1,id2,...> -> { ok, presence: {id: status} }
 *   GET /auth/presence/:id             -> { ok, playerId, status }
 *
 * `opts.auth` permite injetar a autenticação (só testes usam isto; a
 * produção usa authPlayerFromToken, o mesmo das rotas de amigos).
 * `opts.service` é o retorno de createPresenceService(); sem ele, as
 * rotas respondem com as fontes vazias (todo mundo offline).
 */
export function register_presence_routes(app, opts = {}) {
  const service = opts.service || createPresenceService({});
  const authFn =
    typeof opts.auth === "function" ? opts.auth : authPlayerFromToken;

  async function authed(req, res) {
    const player = await authFn(bearerToken(req));
    if (!player) {
      res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      return null;
    }
    return player;
  }

  app.get("/auth/presence", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const raw = typeof req.query?.ids === "string" ? req.query.ids : "";
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    res.status(200).json({ ok: true, presence: service.presenceMap(ids) });
  });

  app.get("/auth/presence/:id", async (req, res) => {
    const me = await authed(req, res);
    if (!me) return;
    const targetId = normId(req.params?.id);
    if (!targetId) return res.status(400).json({ ok: false, error: "MISSING_PLAYER" });
    res.status(200).json({
      ok: true,
      playerId: targetId,
      status: service.presenceFor(targetId),
      ...presenceLabel(service.presenceFor(targetId)),
    });
  });

  return service;
}
