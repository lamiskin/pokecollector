// Auto-capture hold stability.
//
// The user is holding a card still, not freezing a camera: their hand trembles
// and the tracker jitters between frames, while the card itself barely moves.
// A per-observation step threshold therefore measures tracker noise, and means
// completely different things at 7 fps and 38 fps. Instead, judge sustained
// displacement over a short rolling window: only motion that persists across
// ~500 ms counts. A hard single-step discontinuity check still catches a real
// jump, and a generous total cap stops a slow pan from passing as a hold.

// Window used for the smoothness test. Observations older than this are
// irrelevant: ordinary tremor cancels out within half a second.
export const AUTO_DRIFT_WINDOW_MS = 500
// Displacement from the oldest observation still inside the window that counts
// as real movement rather than jitter (frame fractions).
export const AUTO_DRIFT_WINDOW_MOVE = 0.035
// A single large jump is a different gesture (lifting, replacing, panning).
export const AUTO_JUMP_MOVE = 0.07
// Cumulative movement from the window anchor over the whole hold. Slow but
// sustained motion is still motion; this is the loose ceiling that keeps a pan
// from masquerading as a hold.
export const AUTO_TOTAL_MOVE = 0.15
// Qualifying observations further apart than this restart the window, so a
// stalled detection loop cannot accumulate credit across a pause.
export const AUTO_STABLE_GAP_MS = 1500

// Largest per-corner displacement between two quads, in frame fractions.
export function maxCornerMovement(a, b) {
  let movement = 0
  for (let i = 0; i < 4; i += 1) {
    movement = Math.max(movement, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]))
  }
  return movement
}

/**
 * Decide what one observation means for the current hold window.
 *
 * `anchorCorners` is the quad the window's clock started from, `lastCorners`
 * the previous observation, `history` recent `{corners, t}` observations still
 * inside the drift window, and `corners` this observation. Coordinates are
 * frame fractions. Returns:
 *   { action: 'start' }                                    no window open yet
 *   { action: 'restart', reason, step, total, drift }      motion cancelled it
 *   { action: 'keep', step, total, drift }                 the window survives
 *
 * Restart reasons: `gap` (stalled loop), `jump` (one large step), `total`
 * (whole-hold cap), `drift` (sustained movement inside the short window).
 */
export function autoHoldDecision({
  anchorCorners,
  lastCorners,
  corners,
  now,
  lastQualifyingTs,
  history = [],
}) {
  if (!anchorCorners) return { action: 'start' }
  const gap = lastQualifyingTs == null ? Infinity : now - lastQualifyingTs
  if (gap > AUTO_STABLE_GAP_MS) return { action: 'restart', reason: 'gap' }
  const step = lastCorners ? maxCornerMovement(lastCorners, corners) : 0
  const total = maxCornerMovement(anchorCorners, corners)
  if (step > AUTO_JUMP_MOVE) return { action: 'restart', reason: 'jump', step, total }
  // Order matters: a large excursion reports the total cap even when it was
  // built from individually plausible steps.
  if (total > AUTO_TOTAL_MOVE) return { action: 'restart', reason: 'total', step, total }
  const windowStart = now - AUTO_DRIFT_WINDOW_MS
  let oldest = null
  for (const observation of history) {
    if (observation && observation.corners && observation.t >= windowStart) {
      oldest = observation
      break
    }
  }
  const drift = oldest ? maxCornerMovement(oldest.corners, corners) : 0
  if (drift > AUTO_DRIFT_WINDOW_MOVE) {
    return { action: 'restart', reason: 'drift', step, total, drift }
  }
  return { action: 'keep', step, total, drift }
}
