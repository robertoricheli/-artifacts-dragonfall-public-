/**
 * Contexto reativo persistível (Frente 1, MÉDIA 3, 2026-11-24).
 *
 * Antes, a pergunta reativa aberta (mpPendingReactive) e a Proteção
 * Divina temporária (mpProtectedTarget) viviam SÓ na memória: um
 * reinício no meio da pergunta apagava tudo — a sala voltava sem
 * pendente e a ação suspensa era descartada (o defensor nunca mais
 * via o box). Agora os campos PUROS do pendente (só dados JSON — sem
 * timer, sem _state, que é o gameState) viajam na persistência da sala
 * (rooms.json + df_live_rooms.reactive_ctx + blob do Redis) e são
 * reativados no boot (restoreReactiveSuspension, df-reactive-suspend).
 *
 * Campos persistidos do pendente: qid, kind, queryType, answerType,
 * askerSeat, defenderSeat, deferredAction, reductions, finish,
 * appliedReductions, currentReduction, originAction, talentMeta,
 * exaustaoCtx, contramagicaCtx, presentationEnvelope, actionSeq,
 * createdAt, expiresAt, pendingEvents, chuvaProtectAsked,
 * chuvaProtectAll. O timer é rearmado com o tempo RESTANTE; se a
 * pergunta expirou durante a queda, resolve como NÃO no boot.
 * mpProtectedTarget é { targetP, targetI, uid, until } — volta só se
 * o prazo ainda não passou.
 */

// Campos puros do pendente (sem timer, sem _state).
const PENDING_FIELDS = [
  "qid", "kind", "queryType", "answerType", "askerSeat", "defenderSeat",
  "deferredAction", "reductions", "finish", "appliedReductions",
  "currentReduction", "originAction", "talentMeta", "exaustaoCtx",
  "contramagicaCtx", "presentationEnvelope", "actionSeq", "createdAt",
  "expiresAt", "pendingEvents", "chuvaProtectAsked", "chuvaProtectAll",
];

/** Extrai o contexto reativo persistível de uma sala (ou null). */
export function serializeReactiveContext(room) {
  const pendente = room?.mpPendingReactive;
  const prot = room?.mpProtectedTarget;
  if (!pendente && !prot) return null;
  let pending = null;
  if (pendente) {
    try {
      pending = {};
      for (const k of PENDING_FIELDS) {
        if (pendente[k] !== undefined) pending[k] = pendente[k];
      }
      // Valida que é JSON puro (sem função, sem ciclo).
      JSON.stringify(pending);
    } catch (e) {
      pending = null;
    }
  }
  const protectedTarget = prot && prot.targetP != null
    ? { targetP: prot.targetP, targetI: prot.targetI, uid: prot.uid, until: prot.until }
    : null;
  if (!pending && !protectedTarget) return null;
  return {
    pending,
    protectedTarget,
    reactiveSeq: room._reactiveSeq || 0,
  };
}

/** Valida/normaliza o contexto lido da persistência (ou null). */
export function parseReactiveContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pending = raw.pending && typeof raw.pending === "object" ? raw.pending : null;
  const protectedTarget = raw.protectedTarget && typeof raw.protectedTarget === "object"
    ? raw.protectedTarget
    : null;
  if (!pending && !protectedTarget) return null;
  return {
    pending,
    protectedTarget,
    reactiveSeq: Number(raw.reactiveSeq) || 0,
  };
}
