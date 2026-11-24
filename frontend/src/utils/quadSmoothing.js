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
// It is a *rendering* filter only. The raw quad keeps going to capture, hold
// decisions, corroboration and diagnostics; nothing here may feed a decision.
//
// Coordinates are the overlay's normalised video coordinates (0..1), so the
// constants below are in "frame widths per second" and behave the same on a
// 320 px phone preview and a 1280 px desktop one.

// Cutoff when the corner is not moving. 0.45 Hz leaves a still card almost
// motionless on screen while a slow hand drift still comes through.
export const QUAD_MIN_CUTOFF_HZ = 0.45
// Speed at which the cutoff rises: cutoff = minCutoff + beta * |speed|.
// 10 puts a genuinely moving card (0.5 frame/s) most of the way to raw.
export const QUAD_BETA = 10
// The speed estimate is itself low-passed so tracker noise does not masquerade
// as movement and open the filter on a still card.
export const QUAD_DERIVATIVE_CUTOFF_HZ = 1.2
// A corner that moves further than this share of the card's own diagonal in a
// single sample is not the same card moving: it re-anchored, was swapped, or
// the model re-locked somewhere else. Snap instead of dragging the old position.
export const QUAD_JUMP_FRACTION = 0.3
// Likewise for a sudden change of card size: a different card, or the same one
// at a different distance after a re-lock.
export const QUAD_AREA_JUMP_RATIO = 1.6

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
 * @param {object} [options] Overrides for the four constants above, for tuning
 *   without touching the defaults the overlay ships with.
 * @returns {{
 *   sample: (quad: number[][], dtMs?: number) => number[][],
 *   reset: () => void,
 *   corners: number[][],
 *   readonly ready: boolean,
 * }}
 */
export function createQuadSmoother({
  minCutoff = QUAD_MIN_CUTOFF_HZ,
  beta = QUAD_BETA,
  derivativeCutoff = QUAD_DERIVATIVE_CUTOFF_HZ,
  jumpFraction = QUAD_JUMP_FRACTION,
  areaJumpRatio = QUAD_AREA_JUMP_RATIO,
} = {}) {
  // [x0, y0, x1, y1, x2, y2, x3, y3]
  const last = new Float64Array(8) // newest raw sample
  const value = new Float64Array(8) // filtered position, what gets drawn
  const speed = new Float64Array(8) // filtered velocity, in units/second
  // Reused so a card sampled 30 times a second allocates nothing. Callers that
  // keep the corners must copy them.
  const corners = [[0, 0], [0, 0], [0, 0], [0, 0]]
  let ready = false

  const publish = () => {
    for (let i = 0; i < 4; i += 1) {
      corners[i][0] = value[i * 2]
      corners[i][1] = value[i * 2 + 1]
    }
    return corners
  }

  // First sample, or one that cannot be a continuation: start from it directly
  // so a discontinuity never animates across the screen.
  const seed = quad => {
    for (let i = 0; i < 8; i += 1) {
      const next = quad[i >> 1][i & 1]
      last[i] = next
      value[i] = next
      speed[i] = 0
    }
    ready = true
    return publish()
  }

  const reset = () => {
    ready = false
  }

  const sample = (quad, dtMs) => {
    if (!quad || quad.length !== 4) {
      ready = false
      return corners
    }
    if (!ready) return seed(quad)

    const raw = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : FALLBACK_DT_MS
    const dt = Math.min(DT_MAX_S, Math.max(DT_MIN_S, raw / 1000))

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
      return seed(quad)
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
    return publish()
  }

  return {
    sample,
    reset,
    corners,
    get ready() {
      return ready
    },
  }
}

export default createQuadSmoother
