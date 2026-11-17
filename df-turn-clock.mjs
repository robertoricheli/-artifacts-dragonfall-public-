/**
 * Relógio de turno online — E-N4 (decisão dela 16/11): o relógio de 70 s
 * só começa depois do banner de início de turno, igual ao offline.
 *
 * Offline (battle_screen.gd _show_turn_pv_banner): 0,5 s até o banner
 * aparecer + 1,5 s visível + fade de 0,4 s = 2,4 s; turn_timer volta a
 * 70 s só ao fim do banner ("o jogador mantém 70 s úteis"). O banner só
 * existe a partir de turn_number 3 (online_battle.gd
 * _maybe_show_turn_pv_banner, mesma guarda) — nos turnos 1–2 não há
 * banner e o prazo segue 70 s exatos.
 *
 * C-A19/C-N11 seguem valendo: 70 s fixos por turno, sem renovar por ação.
 * Só a virada de turno redefine o deadline (resetTurnTimer).
 */
export const TURN_TIMEOUT_MS = 70000;
export const TURN_BANNER_MS = 2400;

export function turnDeadlineFor(turnNumber, nowMs, timeoutMs = TURN_TIMEOUT_MS) {
  const banner = (turnNumber ?? 0) >= 3 ? TURN_BANNER_MS : 0;
  return nowMs + timeoutMs + banner;
}
