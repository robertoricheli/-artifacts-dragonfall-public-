/**
 * Papel do processo (Fase 6) — Gateway vs Game vs monolito.
 *
 * DF_PROCESS_ROLE=all (default) — comportamento atual (lobby + authority).
 * DF_PROCESS_ROLE=gateway — auth, lobby, filas; rejeita game_action.
 * DF_PROCESS_ROLE=game — authority / timers / AI; rejeita filas de matchmaking.
 */
const RAW = String(process.env.DF_PROCESS_ROLE || "all").toLowerCase().trim();

export const PROCESS_ROLE = RAW === "gateway" || RAW === "game" ? RAW : "all";

export function isGatewayRole() {
  return PROCESS_ROLE === "gateway" || PROCESS_ROLE === "all";
}

export function isGameRole() {
  return PROCESS_ROLE === "game" || PROCESS_ROLE === "all";
}

export function isMonolithRole() {
  return PROCESS_ROLE === "all";
}

export function processRoleHealth() {
  return {
    processRole: PROCESS_ROLE,
    handlesLobby: isGatewayRole(),
    handlesAuthority: isGameRole(),
  };
}
