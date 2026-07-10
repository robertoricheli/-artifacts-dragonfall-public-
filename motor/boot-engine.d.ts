import { DfProtocol } from "./df-protocol.js";
import type { DfRulesApi } from "./df-rules.js";
import type { DfDataApi } from "./df-data.js";
import type { DfEffectsApi } from "./df-effects.js";
export interface DragonfallEngine {
    DfProtocol: typeof DfProtocol;
    DfRules: DfRulesApi;
    DfData: DfDataApi;
    DfEffects: DfEffectsApi;
    DfEngine: Record<string, unknown>;
}
export declare function bootDragonfallEngine(): DragonfallEngine;
export declare function clearEngineCache(): void;
