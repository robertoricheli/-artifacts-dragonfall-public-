/**
 * C-N10 (Opção A — timer por sala, rodada 5): a CARTA APODRECIDA some
 * sozinha ~3 s após entrar em campo (igual ao offline), mesmo sem nenhuma
 * ação no meio. O motor só varre no início de cada ação (expireApodrecidas
 * no applyAction) — o servidor não tem tick periódico. Este módulo arma UM
 * timer por sala para o prazo mais próximo (`apodrecidaExpiresAt`); o
 * disparo roda sob o lock da sala (corrida com ação em voo) e só expira o
 * que ainda estiver no campo com o prazo vencido, difundindo
 * APODRECIDA_EXPIRED + estado cheio para os dois assentos.
 *
 * Deps (injetadas por index.mjs; fakes na sonda probe-r5-server.mjs):
 *   getRoom(code) — re-busca a sala (guarda contra sala removida)
 *   withRoomLock(code, fn) — serializa com game_action / tick da IA / resume
 *   emitEnvelope(room, envelope) — difunde para os dois assentos
 *   persist(room) — touchPersist + mirrorRoomNow
 *   expireApodrecidas(state, now) — DfRules.expireApodrecidas
 *   buildPresentationEnvelope(events, action) — visual apodrecida_discard
 */
export function clearApodrecidaTimer(room) {
  if (room?.apodrecidaTimer) {
    clearTimeout(room.apodrecidaTimer);
    room.apodrecidaTimer = null;
  }
}

export function nextApodrecidaExpiry(room) {
  const st = room?.gameState;
  if (!st?.players) return null;
  let earliest = Infinity;
  for (const p of st.players) {
    for (const c of (p?.field || [])) {
      if (c?.podridao && typeof c.apodrecidaExpiresAt === "number" && c.apodrecidaExpiresAt < earliest) {
        earliest = c.apodrecidaExpiresAt;
      }
    }
  }
  return Number.isFinite(earliest) ? earliest : null;
}

export function armApodrecidaTimer(room, deps) {
  clearApodrecidaTimer(room);
  if (!room || room.status !== "playing" || !room.gameState?.players) return;
  const earliest = nextApodrecidaExpiry(room);
  if (earliest == null) return;
  const delay = Math.max(0, earliest - Date.now());
  room.apodrecidaTimer = setTimeout(() => onApodrecidaTimerExpired(room, deps), delay);
  // O timer não segura o processo aberto sozinho (mesmo padrão do timer
  // da suspensão reativa).
  if (typeof room.apodrecidaTimer.unref === "function") room.apodrecidaTimer.unref();
}

export function onApodrecidaTimerExpired(room, deps) {
  if (room) room.apodrecidaTimer = null;
  if (!room || room.status !== "playing" || !room.gameState) return;
  const run = async () => {
    const r = deps?.getRoom ? deps.getRoom(room.code) : room;
    if (!r || r.status !== "playing" || !r.gameState) return;
    const expired = deps?.expireApodrecidas ? deps.expireApodrecidas(r.gameState) : [];
    if (expired?.length) {
      r.actionSeq = (r.actionSeq || 0) + 1;
      const presentationEnvelope = deps?.buildPresentationEnvelope
        ? deps.buildPresentationEnvelope(expired, { type: "APODRECIDA_EXPIRE" }) || undefined
        : undefined;
      const envelope = {
        seq: r.actionSeq,
        fromSeat: null,
        action: { type: "APODRECIDA_EXPIRE" },
        authoritativeState: r.gameState,
        events: expired,
        logEntry: null,
        presentation: presentationEnvelope?.visuals || undefined,
        presentationEnvelope,
        // Transição crítica (carta sai do campo): estado cheio síncrono,
        // mesmo padrão da retomada reativa (t_865).
        forceFullState: true,
      };
      if (deps?.emitEnvelope) deps.emitEnvelope(r, envelope);
      if (deps?.persist) await deps.persist(r);
    }
    // Re-armar para as próximas apodrecidas (ou limpar se não há mais).
    armApodrecidaTimer(r, deps);
  };
  const lock = deps?.withRoomLock;
  if (typeof lock === "function") {
    void lock(room.code, run).catch((e) => console.warn("[apodrecida-timer]", e?.message || e));
  } else {
    void run().catch((e) => console.warn("[apodrecida-timer]", e?.message || e));
  }
}
