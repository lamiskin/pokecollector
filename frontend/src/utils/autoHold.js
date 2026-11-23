// Auto-capture hold stability.
//
// The user is holding a card still, not freezing a camera: slow drift — the
// card creeping, the hand settling — is normal and readable, while fast motion
// is not. So judge each observation against the previous one rather than
// against the anchor taken when the window opened: a fixed anchor test cancelled
// calm holds once ordinary drift accumulated past the threshold. A generous
// total cap still stops a slow pan from passing as a hold.

// Maximum movement between consecutive observations (frame fractions).
export const AUTO_STEP_MOVE = 0.015
// A single large jump is a different gesture (lifting, replacing, panning).
export const AUTO_JUMP_MOVE = 0.05
// Cumulative movement from the window anchor over the whole hold. Slow but
// sustained motion is still motion; this is the loose ceiling that keeps a pan
// from masquerading as a hold.
export const AUTO_TOTAL_MOVE = 0.10
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
 * the previous observation and `corners` this one. Coordinates are frame
 * fractions, so movement values are frame fractions too. Returns:
 *   { action: 'start' }                        no window open yet
 *   { action: 'restart', reason, step, total } motion or a gap cancelled it
 *   { action: 'keep', step, total }            the window survives
 */
export function autoHoldDecision({
  anchorCorners,
  lastCorners,
  corners,
  now,
  lastQualifyingTs,
}) {
  if (!anchorCorners) return { action: 'start' }
  const gap = lastQualifyingTs == null ? Infinity : now - lastQualifyingTs
  if (gap > AUTO_STABLE_GAP_MS) return { action: 'restart', reason: 'gap' }
  const step = lastCorners ? maxCornerMovement(lastCorners, corners) : 0
  const total = maxCornerMovement(anchorCorners, corners)
  if (step > AUTO_JUMP_MOVE) return { action: 'restart', reason: 'jump', step, total }
  if (step > AUTO_STEP_MOVE) return { action: 'restart', reason: 'step', step, total }
  if (total > AUTO_TOTAL_MOVE) return { action: 'restart', reason: 'total', step, total }
  return { action: 'keep', step, total }
}
