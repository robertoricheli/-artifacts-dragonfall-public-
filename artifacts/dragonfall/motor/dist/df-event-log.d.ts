import type { EventLogEntry, GameAction, GameEvent, PlayerId } from "./df-types.js";
export declare function createEventLog(): EventLogEntry[];
export declare function appendEventLogEntry(log: EventLogEntry[], seq: number, seat: PlayerId, action: GameAction, events?: GameEvent[]): EventLogEntry;
/** Replay: lista de ações na ordem (para debug / reconstrução). */
export declare function actionsFromLog(log: EventLogEntry[]): GameAction[];
/** Export serializável para salvar partida / disputa. */
export declare function exportEventLog(log: EventLogEntry[], meta?: Record<string, unknown>): {
    version: number;
    exportedAt: string;
    entries: {
        seq: number;
        seat: PlayerId;
        action: GameAction;
        events: GameEvent[];
        t: number;
    }[];
};
export declare function lastLogEntry(log: EventLogEntry[]): EventLogEntry | null;
