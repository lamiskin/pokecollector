// Display smoothing for the capture overlay's quad.
//
// The corner tracker re-matches four patches on a 480 px frame, so every corner
// lands on a whole pixel of that frame. A card held still therefore still
// produces a quad that hops by a pixel or two at every tracker step, which is
// what reads on screen as the outline shivering.
//
// This is a per-coordinate one-euro filter (Casiez, Roussel & Vogel, CHI 2012):
// an adaptive low-pass whose cutoff rises with the corner's own speed. When the
// card is nearly still the cutoff is low and the outline is smoothed hard; when
// the card genuinely moves the cutoff climbs and the outline follows almost
// unfiltered. That is the whole point of it over a fixed low-pass, which would
// have to choose between visible lag and visible jitter.
//
// The filter output is a target. The drawn position is a separate per-frame
// exponential follower, so discrete tracker samples become continuous motion
// instead of a hold-then-jump staircase at the tracker's frame rate.
//
// A discontinuity - the card re-anchored, was swapped, or the model re-locked
// somewhere else - is not filtered; the outline travels to the new quad over a
// short eased glide instead of teleporting. The first quad of a session (and
// the first after the tracker drops the card) still appears where it is, so
// nothing ever sweeps across the preview on acquisition.
//
// It is a *rendering* filter only. The raw quad keeps going to capture, hold
// decisions, corroboration and diagnostics; nothing here may feed a decision.
//
// Coordinates are the overlay's normalised video coordinates (0..1), so the
// constants below are in "frame widths per second" and behave the same on a
// 320 px phone preview and a 1280 px desktop one.

// Cutoff when the corner is not moving. A low cutoff leaves a still card almost
// motionless on screen while a slow hand drift still comes through.
export const QUAD_MIN_CUTOFF_HZ = 0.18
// Speed at which the cutoff rises: cutoff = minCutoff + beta * |speed|.
// A lower beta keeps more smoothing during ordinary movement; the per-frame
// follower supplies the rest of the responsiveness.
export const QUAD_BETA = 6
// The speed estimate is itself low-passed so tracker noise does not masquerade
// as movement and open the filter on a still card.
export const QUAD_DERIVATIVE_CUTOFF_HZ = 1.6
// A corner that moves further than this share of the card's own diagonal in a
// single sample is not the same card moving: it re-anchored, was swapped, or
// the model re-locked somewhere else.
export const QUAD_JUMP_FRACTION = 0.3
// Likewise for a sudden change of card size: a different card, or the same one
// at a different distance after a re-lock.
export const QUAD_AREA_JUMP_RATIO = 1.6
// How long the drawn outline takes to close most of the gap to the filtered
// target: the per-frame follower's time constant. 200 ms is deliberately slow:
// delay is acceptable, visible stepping is not.
export const QUAD_FOLLOW_TAU_MS = 200
// How long a discontinuity takes to travel to the new quad. 560 ms with an
// ease-in-out leaves and lands gently rather than snapping.
export const QUAD_GLIDE_MS = 560

// Sampling gaps outside this range are either a clock hiccup or an idle pause;
// clamping keeps alpha meaningful without a special case for either.
const DT_MIN_S = 1 / 240
const DT_MAX_S = 0.25
const FALLBACK_DT_MS = 1000 / 30

const TAU = 2 * Math.PI

// One-euro's alpha for a given cutoff and sample interval. No exp: this runs
// for eight coordinates on every tracker sample.
function alphaFor(cutoff, dt) {
  return 1 / (1 + 1 / (TAU * cutoff) / dt)
}

function distance(ax, ay, bx, by) {
  const dx = ax - bx
  const dy = ay - by
  return Math.sqrt(dx * dx + dy * dy)
}

// Gentle leave and gentle landing: neither end of the glide kicks.
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2
}

function areaOfFlat(flat) {
  let sum = 0
  for (let i = 0; i < 4; i += 1) {
    const x1 = flat[i * 2]
    const y1 = flat[i * 2 + 1]
    const j = ((i + 1) % 4) * 2
    sum += x1 * flat[j + 1] - flat[j] * y1
  }
  return Math.abs(sum) * 0.5
}

function areaOf(quad) {
  let sum = 0
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]
    const b = quad[(i + 1) % 4]
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(sum) * 0.5
}

/**
 * @param {object} [options] Overrides for the constants above, for tuning
 *   without touching the defaults the overlay ships with. `glideMs: 0` turns
 *   the discontinuity glide off, so a re-lock snaps; the overlay uses that for
 *   `prefers-reduced-motion`.
 * @returns {{
 *   sample: (quad: number[][], dtMs?: number, nowMs?: number) => number[][],
 *   tick: (nowMs?: number) => number[][],
 *   reset: () => void,
 *   setGlideMs: (ms: number) => void,
 *   corners: number[][],
 *   readonly ready: boolean,
 *   readonly gliding: boolean,
 * }}
 */
export function createQuadSmoother(options = {}) {
  const {
    minCutoff = QUAD_MIN_CUTOFF_HZ,
    beta = QUAD_BETA,
    derivativeCutoff = QUAD_DERIVATIVE_CUTOFF_HZ,
    jumpFraction = QUAD_JUMP_FRACTION,
    areaJumpRatio = QUAD_AREA_JUMP_RATIO,
  } = options
  let glideMs = Number.isFinite(options.glideMs) ? Math.max(0, options.glideMs) : QUAD_GLIDE_MS

  // [x0, y0, x1, y1, x2, y2, x3, y3]
  const last = new Float64Array(8) // newest raw sample
  const value = new Float64Array(8) // filtered target
  const shown = new Float64Array(8) // interpolated position actually drawn
  const speed = new Float64Array(8) // filtered velocity, in units/second
  // Reused so a card sampled 30 times a second allocates nothing. Callers that
  // keep the corners must copy them.
  const corners = [[0, 0], [0, 0], [0, 0], [0, 0]]
  let ready = false
  let lastShownAt = null

  // The glide: `from` is whatever the outline was drawing when the jump was
  // seen, `to` is the new raw quad. It owns `value` until it lands.
  const glideFrom = new Float64Array(8)
  const glideTo = new Float64Array(8)
  let glideStart = 0
  let gliding = false
  // A caller that passes no timestamp still needs a monotonic clock for the
  // glide, so the sample intervals stand in for one.
  let clock = 0

  const publish = () => {
    for (let i = 0; i < 4; i += 1) {
      corners[i][0] = shown[i * 2]
      corners[i][1] = shown[i * 2 + 1]
    }
    return corners
  }

  // Frame-rate-correct exponential approach to the filtered target. This is
  // what turns 8-27 Hz tracker samples into 60 Hz motion.
  const advanceShown = (dt, now) => {
    const tau = QUAD_FOLLOW_TAU_MS / 1000
    const alpha = tau > 0 ? 1 - Math.exp(-dt / tau) : 1
    for (let i = 0; i < 8; i += 1) {
      shown[i] += alpha * (value[i] - shown[i])
    }
    lastShownAt = now
  }

  // Land exactly on the destination rather than one eased step short of it.
  // `snap` is for reduced-motion / glide-off, where the outline must not ease.
  const land = snap => {
    for (let i = 0; i < 8; i += 1) {
      value[i] = glideTo[i]
      if (snap) shown[i] = glideTo[i]
    }
    gliding = false
  }

  const advanceGlide = now => {
    if (!gliding) return
    // Reduced motion switched on mid-flight: stop where the card is.
    if (!(glideMs > 0)) {
      land(true)
      return
    }
    const ratio = (now - glideStart) / glideMs
    if (!(ratio < 1)) {
      land(false)
      return
    }
    const eased = easeInOutCubic(ratio < 0 ? 0 : ratio)
    for (let i = 0; i < 8; i += 1) {
      value[i] = glideFrom[i] + (glideTo[i] - glideFrom[i]) * eased
    }
  }

  // Start a glide from the outline's current position. Any glide already in
  // flight is simply abandoned there: no queue, and no overshoot past either
  // end.
  const startGlide = (quad, now) => {
    for (let i = 0; i < 8; i += 1) {
      glideFrom[i] = shown[i]
      value[i] = shown[i]
      const next = quad[i >> 1][i & 1]
      glideTo[i] = next
      last[i] = next
      speed[i] = 0
    }
    glideStart = now
    gliding = true
    ready = true
    advanceGlide(now)
  }

  // No previous position to travel from (first sample, or the first one after
  // the card was dropped): show it where it is.
  const seed = (quad, now) => {
    gliding = false
    for (let i = 0; i < 8; i += 1) {
      const next = quad[i >> 1][i & 1]
      last[i] = next
      value[i] = next
      shown[i] = next
      speed[i] = 0
    }
    ready = true
    lastShownAt = now
    return publish()
  }

  const reset = () => {
    ready = false
    gliding = false
    lastShownAt = null
  }

  const sample = (quad, dtMs, nowMs) => {
    if (!quad || quad.length !== 4) {
      reset()
      return corners
    }
    const rawDt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : FALLBACK_DT_MS
    let now
    if (Number.isFinite(nowMs)) now = nowMs
    else {
      clock += rawDt
      now = clock
    }
    if (!ready) return seed(quad, now)

    // Move any glide that is already running to this instant first, so an
    // interrupted glide restarts from what is actually on screen.
    advanceGlide(now)

    const dt = Math.min(DT_MAX_S, Math.max(DT_MIN_S, rawDt / 1000))

    // Discontinuity guards, before any filtering happens.
    let jump = 0
    for (let i = 0; i < 4; i += 1) {
      const moved = distance(quad[i][0], quad[i][1], last[i * 2], last[i * 2 + 1])
      if (moved > jump) jump = moved
    }
    const diagonal = 0.5 * (
      distance(quad[0][0], quad[0][1], quad[2][0], quad[2][1])
      + distance(quad[1][0], quad[1][1], quad[3][0], quad[3][1])
    )
    const previousArea = areaOfFlat(last)
    const nextArea = areaOf(quad)
    const areaRatio = previousArea > 0 && nextArea > 0 ? nextArea / previousArea : 1
    if (jump > diagonal * jumpFraction || areaRatio > areaJumpRatio || areaRatio < 1 / areaJumpRatio) {
      if (glideMs > 0) startGlide(quad, now)
      else seed(quad, now)
      advanceShown(dt, now)
      return publish()
    }

    // A glide owns the filtered target until it lands. Samples in the meantime
    // only prime the filter (newest raw sample and its speed) so that filtering
    // resumes from the right velocity the moment it does.
    if (gliding) {
      const alphaSpeed = alphaFor(derivativeCutoff, dt)
      for (let i = 0; i < 8; i += 1) {
        const next = quad[i >> 1][i & 1]
        const observed = (next - last[i]) / dt
        last[i] = next
        speed[i] += alphaSpeed * (observed - speed[i])
      }
      advanceShown(dt, now)
      return publish()
    }

    const alphaSpeed = alphaFor(derivativeCutoff, dt)
    for (let i = 0; i < 8; i += 1) {
      const next = quad[i >> 1][i & 1]
      const observed = (next - last[i]) / dt
      last[i] = next
      speed[i] += alphaSpeed * (observed - speed[i])
      const cutoff = minCutoff + beta * Math.abs(speed[i])
      value[i] += alphaFor(cutoff, dt) * (next - value[i])
    }
    advanceShown(dt, now)
    return publish()
  }

  // Advance the display on frames where the tracker produced nothing new. This
  // always publishes the current interpolated position; that is the point.
  const tick = nowMs => {
    if (!ready) return corners
    let now
    if (Number.isFinite(nowMs)) now = nowMs
    else {
      clock += FALLBACK_DT_MS
      now = clock
    }
    const rawDtMs = lastShownAt == null ? FALLBACK_DT_MS : now - lastShownAt
    const dt = Math.min(DT_MAX_S, Math.max(DT_MIN_S, rawDtMs / 1000))
    advanceGlide(now)
    advanceShown(dt, now)
    return publish()
  }

  const setGlideMs = ms => {
    glideMs = Number.isFinite(ms) ? Math.max(0, ms) : 0
  }

  return {
    sample,
    tick,
    reset,
    setGlideMs,
    corners,
    get ready() {
      return ready
    },
    get gliding() {
      return gliding
    },
  }
}

export default createQuadSmoother
