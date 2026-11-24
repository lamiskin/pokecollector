// Auto-capture hold stability.
//
// The user is holding a card still, not freezing a camera: their hand trembles
// and the tracker jitters between frames, while the card itself barely moves.
// A per-observation step threshold therefore measures tracker noise, and means
// completely different things at 7 fps and 38 fps. Instead, judge sustained
// displacement against the median quad over a short rolling window: a single
// tracker correction or a rogue sample cannot move the median, while steady
// movement does. Model results are source-aware: an adoption legitimately
// re-anchors the coordinate frame, so it keeps the window and re-baselines the
// history rather than reading as the card jumping.

// Window used for the smoothness test. Observations older than this are
// irrelevant: ordinary tremor cancels out within half a second.
export const AUTO_DRIFT_WINDOW_MS = 500
// Displacement from the median quad that counts as real movement rather than
// jitter (frame fractions).
export const AUTO_DRIFT_WINDOW_MOVE = 0.035
// A single large tracked-to-tracked step is a different gesture (lifting,
// replacing, panning). A model adoption is not judged by this: it deliberately
// shifts the quad to the detector's frame.
export const AUTO_JUMP_MOVE = 0.07
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

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

// Per-coordinate median of the observations inside the window, including the
// current one. A median needs half the window to move, so one re-anchor or two
// rogue samples cannot shift it.
export function medianQuad(observations) {
  if (!observations || observations.length === 0) return null
  const xs = [[], [], [], []]
  const ys = [[], [], [], []]
  for (const observation of observations) {
    // Drift is a tracker measurement. A model quad is in a different frame and
    // must never enter the median.
    if (!observation || !observation.corners || observation.source === 'model') continue
    for (let i = 0; i < 4; i += 1) {
      xs[i].push(observation.corners[i][0])
      ys[i].push(observation.corners[i][1])
    }
  }
  if (xs[0].length === 0) return null
  const quad = []
  for (let i = 0; i < 4; i += 1) quad.push([median(xs[i]), median(ys[i])])
  return quad
}

/**
 * Decide what one observation means for the current hold window.
 *
 * `anchorCorners` is the quad the window's clock started from, `lastCorners`
 * the previous observation, `history` recent `{corners, t, source}` observations
 * still inside the drift window, and `corners` this observation. `source` is
 * `tracked` or `model`, as is `lastSource` for the previous observation.
 * Coordinates are frame fractions. Returns:
 *   { action: 'start' }                                    no window open yet
 *   { action: 'restart', reason, step, drift }             tracked motion
 *   { action: 'keep', reanchor?, step, drift }             the window survives
 *
 * Restart reasons: `gap` (stalled loop), `jump` (one large tracked-to-tracked
 * step), `drift` (sustained movement against the median).
 */
export function autoHoldDecision({
  anchorCorners,
  lastCorners,
  corners,
  now,
  lastQualifyingTs,
  history = [],
  source = 'tracked',
  lastSource = 'tracked',
}) {
  if (!anchorCorners) return { action: 'start' }
  const gap = lastQualifyingTs == null ? Infinity : now - lastQualifyingTs
  if (gap > AUTO_STABLE_GAP_MS) return { action: 'restart', reason: 'gap' }

  // A model adoption moves the quad to the detector's frame on purpose. Keep
  // the hold clock, but let the caller re-baseline the history at this quad so
  // the correction is not later mistaken for user movement.
  if (source === 'model') {
    return { action: 'keep', reanchor: true, step: 0, drift: null }
  }

  const step = lastCorners ? maxCornerMovement(lastCorners, corners) : 0
  // Only tracked-to-tracked steps are gestures; a step out of a model result is
  // the coordinate frame settling, not the card jumping.
  if (lastSource === 'tracked' && step > AUTO_JUMP_MOVE) {
    return { action: 'restart', reason: 'jump', step, drift: 0 }
  }

  const windowStart = now - AUTO_DRIFT_WINDOW_MS
  const inside = history.filter(observation => (
    observation && observation.corners && observation.t >= windowStart
    && observation.source !== 'model'
  ))
  // Tracked-only history: after a model re-anchor there may be none yet, and
  // comparing tracker geometry with model geometry is exactly the false drift
  // this avoids.
  if (inside.length === 0) return { action: 'keep', step, drift: null }
  inside.push({ corners, t: now, source })
  const drift = maxCornerMovement(medianQuad(inside), corners)
  if (drift > AUTO_DRIFT_WINDOW_MOVE) {
    return { action: 'restart', reason: 'drift', step, drift }
  }
  return { action: 'keep', step, drift }
}
