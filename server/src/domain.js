// Pure domain rules. No I/O here, so they are trivial to unit test.

const STATUS = Object.freeze({
  CUTTING_IN_PROGRESS: 'CUTTING_IN_PROGRESS',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  REJECTED: 'REJECTED',
  VERIFIED: 'VERIFIED',
  SEWING_STARTED: 'SEWING_STARTED',
});

const ROLES = Object.freeze({
  SUPERVISOR: 'cutting_supervisor',
  VERIFIER: 'cutting_verifier',
  SEWING: 'sewing_supervisor',
});

// Allowed transitions. Anything not listed here is illegal and rejected by the API.
const TRANSITIONS = Object.freeze({
  CUTTING_IN_PROGRESS: ['PENDING_VERIFICATION'],
  PENDING_VERIFICATION: ['VERIFIED', 'REJECTED'],
  REJECTED: ['PENDING_VERIFICATION'], // re-cut and resubmit
  VERIFIED: ['SEWING_STARTED'],
  SEWING_STARTED: [],
});

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Traffic light for one component. actual must be a non-negative integer. */
function trafficLight(actual, expected) {
  if (actual === null || actual === undefined) return null;
  if (actual === expected) return 'GREEN';
  if (actual > expected) return 'YELLOW';
  return 'RED';
}

function expectedQty(targetQty, piecesPerGarment) {
  return targetQty * piecesPerGarment;
}

function expectedFabric(targetQty, stdYardsPerPiece) {
  return targetQty * stdYardsPerPiece;
}

/** Fabric Wastage % = ((actual - expected) / expected) * 100, rounded to 2dp. */
function wastagePct(actualYds, expectedYds) {
  if (!(expectedYds > 0)) throw new Error('expected fabric must be positive');
  return Math.round(((actualYds - expectedYds) / expectedYds) * 10000) / 100;
}

/**
 * Hard-stop evaluation used by the approve endpoint. Takes rows straight from
 * the database and recomputes everything; stored status flags are never trusted.
 */
function evaluateGate(items) {
  const uncounted = items.filter((i) => i.actual_qty === null || i.actual_qty === undefined);
  const red = items.filter(
    (i) => i.actual_qty !== null && i.actual_qty !== undefined && trafficLight(i.actual_qty, i.expected_qty) === 'RED'
  );
  return {
    canApprove: items.length > 0 && uncounted.length === 0 && red.length === 0,
    uncounted,
    red,
  };
}

// ---- Input validation helpers (strict: no coercion) ----

function isNonNegativeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** Positive number with at most 2 decimal places (fabric is measured in yards). */
function isPositiveYards(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1_000_000) return false;
  return Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
}

module.exports = {
  STATUS, ROLES, TRANSITIONS, canTransition, trafficLight, expectedQty, expectedFabric,
  wastagePct, evaluateGate, isNonNegativeInt, isPositiveInt, isPositiveYards,
};
