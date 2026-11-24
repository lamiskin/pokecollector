// Auto-capture hold stability.
//
// Positional drift is not a problem for this capture path: the warp applies the
// same frame's geometry to that same frame's pixels, so a card that has crept a
// few percent is still the card, shifted, and the crop follows it. What does
// harm the image is motion blur, which is a function of speed, not cumulative
// distance. So judge a single tracked step: only genuinely fast movement (and
// a huge pan) resets the hold. A model result deliberately moves the quad to
// the detector's frame, so it keeps the clock and never counts as movement.

// Fast tracked movement between two observations, as a speed (frame widths per
// second). A per-observation threshold means nothing when observations arrive
// 122 ms apart instead of 33 ms, so normalise by the tracked interval.
export const AUTO_STEP_SPEED = 0.75
// Cap the interval used for that comparison so a stalled loop cannot turn one
// small correction into an instant restart.
export const AUTO_STEP_DT_MAX_MS = 250
// Loose cumulative guard: a real pan, not a wobble. Drift itself is free.
export const AUTO_TOTAL_MOVE = 0.25
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
 * the previous observation and `corners` this one. `source` is `tracked` or
 * `model`, as is `lastSource`. Coordinates are frame fractions. Returns:
 *   { action: 'start' }                            no window open yet
 *   { action: 'restart', reason, step, total }     fast motion or a large pan
 *   { action: 'keep', step, total }                the window survives
 *
 * Restart reasons: `gap` (stalled loop), `step` (fast tracked movement),
 * `total` (cumulative pan).
 */
export function autoHoldDecision({
  anchorCorners,
  lastCorners,
  corners,
  now,
  lastQualifyingTs,
  source = 'tracked',
  lastSource = 'tracked',
}) {
  if (!anchorCorners) return { action: 'start' }
  const gap = lastQualifyingTs == null ? Infinity : now - lastQualifyingTs
  if (gap > AUTO_STABLE_GAP_MS) return { action: 'restart', reason: 'gap' }

  // A model result re-anchors the coordinate frame on purpose. Keep the hold
  // clock and do not judge its step or distance as user movement.
  if (source === 'model') {
    return { action: 'keep', step: 0, total: 0 }
  }

  // The first tracked quad after a model re-anchor differs from that anchor by
  // the systematic detector-versus-tracker disagreement (~5-7 %), which is not
  // movement. Adopt it as the new baseline instead of charging it to the user.
  if (lastSource === 'model') {
    return { action: 'keep', step: 0, total: maxCornerMovement(anchorCorners, corners) }
  }

  const dtMs = Math.min(
    AUTO_STEP_DT_MAX_MS,
    Math.max(0, lastQualifyingTs == null ? 0 : now - lastQualifyingTs),
  )
  const step = lastCorners ? maxCornerMovement(lastCorners, corners) : 0
  if (lastSource === 'tracked' && dtMs > 0
    && step > AUTO_STEP_SPEED * (dtMs / 1000)) {
    return { action: 'restart', reason: 'step', step, total: 0 }
  }
  const total = maxCornerMovement(anchorCorners, corners)
  if (total > AUTO_TOTAL_MOVE) {
    return { action: 'restart', reason: 'total', step, total }
  }
  return { action: 'keep', step, total }
}
