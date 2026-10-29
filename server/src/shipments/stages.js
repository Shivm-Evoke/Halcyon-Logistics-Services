// A shipment's life after the gateway accepts it. Staff move it one stage at a time on the Dispatch board.
export const STAGES = ['received', 'picked', 'collected', 'in_transit', 'delivered'];
export const RISK_THRESHOLD = 0.4; // the watchtower's threshold

/** The first stage from the gateway's verdict on the order. */
export function initialStage(orderStatus) {
  if (orderStatus === 'held') return 'on_hold';
  if (orderStatus === 'rejected' || orderStatus === 'duplicate') return 'cancelled';
  return 'received';
}

/** The next stage, or null where it cannot move on (delivered, cancelled, or held until it is fixed). */
export function nextStage(current) {
  const i = STAGES.indexOf(current);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

/** The current stage: the latest event (by time, then id). */
export function stageOf(events) {
  const last = [...events].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id - b.id).at(-1);
  return last?.stage ?? null;
}

export const atRisk = (risk) => risk != null && Number(risk) >= RISK_THRESHOLD;
