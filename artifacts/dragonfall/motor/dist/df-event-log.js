export function createEventLog() {
    return [];
}
export function appendEventLogEntry(log, seq, seat, action, events = []) {
    const entry = {
        seq,
        seat,
        action: { ...action, playerId: seat },
        events: events.map((e) => ({ ...e })),
        t: Date.now(),
    };
    log.push(entry);
    return entry;
}
/** Replay: lista de ações na ordem (para debug / reconstrução). */
export function actionsFromLog(log) {
    return log.map((e) => ({ ...e.action, playerId: e.seat }));
}
/** Export serializável para salvar partida / disputa. */
export function exportEventLog(log, meta = {}) {
    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: log.map((e) => ({
            seq: e.seq,
            seat: e.seat,
            action: e.action,
            events: e.events,
            t: e.t,
        })),
        ...meta,
    };
}
export function lastLogEntry(log) {
    return log.length ? log[log.length - 1] : null;
}
