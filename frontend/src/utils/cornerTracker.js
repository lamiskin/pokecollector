// Local patch tracker for card corners between model detections.
//
// The detector costs ~300 ms per frame on the target phone, so the model can
// only re-lock a card occasionally. This tracker follows the four corners with
// cheap SSD patch matching on a small grayscale frame, letting the overlay move
// at animation-frame speed while the model remains the only thing that can find
// a card or attest sharpness.

export const TRACK_MAX_EDGE = 480
export const PATCH_RADIUS = 5
// Normal per-frame reach: 16 px at 480 px is ~3.3 % of the frame width.
export const SEARCH_RADIUS = 16
// The first tracks after a model lock bridge the ~300 ms inference gap, when a
// hand can move much further than one animation frame's worth (~8 % here).
export const FIRST_TRACK_RADIUS = 40
export const TRACK_MAX_MISSES = 15
// One missed frame is noise, not a lost card: declare loss only after this many
// consecutive misses (~0.15 s at 50 fps), and report it once per episode.
export const TRACK_LOST_AFTER = 8
// A tracker that succeeded this recently is healthy; a new model result then
// only has to agree with it, not replace it.
export const TRACK_KEEP_MS = 700
// Corner agreement as a fraction of the frame (normalized coordinate distance).
export const TRACK_AGREE_MAX = 0.06
// Corroboration asks "is this the same object", not "is this the same quad".
// Model and tracker routinely disagree by ~7 % of frame while both are looking
// at one card, so the tight keep-threshold would refuse half of legitimate
// captures. This limit only needs to separate "same card, drifted a little"
// from "a different region entirely".
export const CAPTURE_CORROBORATE_MAX_AGREE = 0.2
// A tracked quad younger than this still owns the overlay phase.
export const TRACK_PHASE_MAX_AGE_MS = 1000
// A tentative re-anchor must produce two clean tracks before it replaces the
// live tracker; two failures discard it and leave the live tracker alone.
export const TENTATIVE_CONFIRM_TRACKS = 2
export const TENTATIVE_MAX_MISSES = 2
// Consecutive tracked frames that count as proof of a card. The tracker
// fallback has always used this count; the framing capture policy reuses it as
// its presence guard, so a stationary background cannot satisfy it.
export const TRACKER_FALLBACK_HITS = 12
// Capture geometry may not be older than the frame it is applied to. A tracked
// quad is cheap and fresh; a model quad is only a fallback and only when no
// tracked quad exists at all.
export const CAPTURE_QUAD_MAX_AGE_MS = 250
// A model quad is only geometry from a still card: with no tracked quad it is the
// only source there is, and results arrive about a second apart, so a 500 ms limit
// refused good captures a third of the time. 1.3 s covers one missed result.
export const CAPTURE_MODEL_MAX_AGE_MS = 1300
// An automatic capture needs the detector itself to have confirmed the geometry
// recently; a quad carried only by the tracker is not enough.
export const CAPTURE_CORROBORATE_MS = 2500
export const MAX_FRAME_MOVE = 0.12
// Relative score gate: accept a match only if it explains a useful share of the
// patch's own variance, with a small absolute floor for low-signal patches.
export const MAX_PATCH_MSE_FLOOR = 200
export const PATCH_VARIANCE_RATIO = 0.55
export const MIN_AREA_RATIO = 0.4
export const MAX_AREA_RATIO = 2.5

const PATCH_SIZE = PATCH_RADIUS * 2 + 1
const SAMPLE_STEP = PATCH_RADIUS
const SAMPLE_COUNT = 9
const COARSE_STRIDE = 2
const REFINE_RADIUS = 2

// A match is only trusted when it explains a useful share of the patch's own
// variance. The absolute floor keeps a nearly uniform patch from accepting
// noise; the variance term keeps a high-contrast patch tolerant of lighting
// changes that would exceed any fixed threshold.
export function isPatchMatchAcceptable(bestMse, patchVariance) {
  return bestMse <= Math.max(MAX_PATCH_MSE_FLOOR, PATCH_VARIANCE_RATIO * patchVariance)
}

// After a model result, decide whether the running tracker should survive.
// A healthy tracker that agrees with the model keeps its patches (a rebuild
// from a ~300 ms old frame is what used to break the first track); a healthy
// tracker that disagrees is re-anchored, because the model has final say.
export function shouldKeepTracking({ trackedCorners, modelCorners, ageMs }) {
  if (ageMs == null || ageMs > TRACK_KEEP_MS) return 'reset'
  const agreement = cornerAgreement({ trackedCorners, modelCorners })
  if (agreement == null) return 'reset'
  return agreement <= TRACK_AGREE_MAX ? 'keep' : 'reanchor'
}

// Largest per-corner distance between two normalized quads, or null when
// either side is missing. Exported for the diagnostics decision log.
export function cornerAgreement({ trackedCorners, modelCorners }) {
  if (!trackedCorners || trackedCorners.length !== 4
    || !modelCorners || modelCorners.length !== 4) {
    return null
  }
  let distance = 0
  for (let i = 0; i < 4; i += 1) {
    distance = Math.max(
      distance,
      Math.hypot(
        trackedCorners[i][0] - modelCorners[i][0],
        trackedCorners[i][1] - modelCorners[i][1],
      ),
    )
  }
  return distance
}

// Tracks are attempted from a tentative reference while the live tracker keeps
// running; only a confirmed tentative replaces it.
export function evaluateTentative({ hits, misses }) {
  if (hits >= TENTATIVE_CONFIRM_TRACKS) return 'adopt'
  if (misses >= TENTATIVE_MAX_MISSES) return 'discard'
  return 'pending'
}

// Single source of truth for the overlay phase and the diagnostics reason.
// `trackedFresh` means the tracker has produced a quad recently; a fresh
// tracked quad always draws as tracking (dashed) even when the latest model
// result is unusable, and transient misses below TRACK_LOST_AFTER do not change
// the phase.
export function derivePhase({
  captureBeat = false,
  trackedFresh = false,
  trackedTooSmall = false,
  modelUsable = false,
  trackMisses = 0,
  autoDisarmed = false,
  holding = false,
  hasModel = false,
  modelUnusableReason = null,
  confirmedPulse = false,
} = {}) {
  if (captureBeat) return { phase: 'captured', reason: 'captured' }
  // A completed auto-capture intentionally goes quiet until the card moves.
  if (autoDisarmed) return { phase: 'none', reason: 'disarmed' }
  if (trackedTooSmall) return { phase: 'tooSmall', reason: 'too-small' }
  const lost = trackMisses >= TRACK_LOST_AFTER && (trackedFresh || hasModel)
  if (lost) return { phase: 'lost', reason: 'lost' }
  // An open hold window is model-driven and needs its own phase to animate;
  // the confirmation pulse must not restart that animation.
  if (modelUsable && holding) return { phase: 'holding', reason: 'tracking' }
  // A brief confirmation pulse from an accepted model result shows the solid
  // ring, then the usual dashed tracking resumes.
  if (confirmedPulse) return { phase: 'locked', reason: 'confirmed' }
  if (trackedFresh) return { phase: 'tracking', reason: 'tracking' }
  if (!modelUsable) {
    // Name the detector's failing gate instead of asking for steadiness blindly.
    const reason = hasModel && modelUnusableReason === 'soft'
      ? 'too-soft'
      : (hasModel && modelUnusableReason === 'no-quad' ? 'no-quad' : 'model-unusable')
    return {
      phase: 'none',
      reason: hasModel ? reason : 'no-quad',
    }
  }
  return { phase: 'locked', reason: 'tracking' }
}

// Pure decision for the capture path: which quad, if any, is tied closely
// enough to the frame about to be drawn. A stale tracked quad must not block a
// fresh, usable model result: fall through to the model before refusing.
export function shouldAcceptCapture({
  hasTracked = false,
  trackedAgeMs = null,
  modelAgeMs = null,
  modelUsable = true,
} = {}) {
  if (hasTracked && trackedAgeMs != null && trackedAgeMs <= CAPTURE_QUAD_MAX_AGE_MS) {
    return { ok: true, reason: 'ok', source: 'tracked' }
  }
  if (!modelUsable) {
    return {
      ok: false,
      reason: hasTracked ? 'stale-tracked' : 'model-unusable',
      source: 'model',
    }
  }
  if (modelAgeMs == null || modelAgeMs > CAPTURE_MODEL_MAX_AGE_MS) {
    return {
      ok: false,
      reason: hasTracked ? 'stale-tracked' : 'stale-model',
      source: 'model',
    }
  }
  return { ok: true, reason: 'ok', source: 'model' }
}

// True when a tracked quad may stand in for a detector confirmation: enough
// consecutive fresh exposures, no recent dispute, and a recent agreement/seed.
export function trackerFallbackEligible({
  source = 'tracked',
  hits = 0,
  failures = 0,
  quadAgeMs = null,
  sinceDisagreementMs = null,
  sinceAgreementMs = null,
  maxQuadAgeMs = CAPTURE_QUAD_MAX_AGE_MS,
  disagreementWindowMs = 1500,
  agreementWindowMs = 3000,
} = {}) {
  return source === 'tracked'
    && failures === 0
    && hits >= TRACKER_FALLBACK_HITS
    && quadAgeMs != null
    && quadAgeMs <= maxQuadAgeMs
    && (sinceDisagreementMs == null || sinceDisagreementMs > disagreementWindowMs)
    && sinceAgreementMs != null
    && sinceAgreementMs <= agreementWindowMs
}

// Presence guard for the framing capture policy. A card counts as present when
// the detector produced a usable quad recently, or the tracker has held a
// tracked quad for the same consecutive-frame count the quad policy's fallback
// already requires. It deliberately says nothing about aspect, edge containment
// or detector/tracker agreement: those are the gates framing drops. The tracker
// branch needs a live quad, and a stationary background has none, so it cannot
// satisfy presence without a detector seed and a sustained track.
export function framingPresence({
  hasTrackedQuad = false,
  modelAgeMs = null,
  trackerHits = 0,
  modelMaxAgeMs = CAPTURE_MODEL_MAX_AGE_MS,
  requiredTrackerHits = TRACKER_FALLBACK_HITS,
} = {}) {
  const detector = modelAgeMs != null && modelAgeMs <= modelMaxAgeMs
  const tracker = hasTrackedQuad && trackerHits >= requiredTrackerHits
  return {
    ok: detector || tracker,
    source: tracker ? 'tracked' : (detector ? 'model' : 'none'),
  }
}

// True when a detected geometry looks like a fully-in-frame card region.
export function minEdgeMargin(corners) {
  if (!corners || corners.length !== 4) return 0
  let margin = Infinity
  for (const [x, y] of corners) {
    margin = Math.min(margin, x, 1 - x, y, 1 - y)
  }
  return Number.isFinite(margin) ? margin : 0
}

// Width/height of the ordered quad (TL, TR, BR, BL). With a frame, distances
// are measured in pixels; without one, normalised coordinates are used.
export function quadAspect(corners, frame = null) {
  if (!corners || corners.length !== 4) return 0
  const fx = frame && frame.width > 0 ? frame.width : 1
  const fy = frame && frame.height > 0 ? frame.height : 1
  const px = corners.map(([x, y]) => [x * fx, y * fy])
  const width = (
    Math.hypot(px[1][0] - px[0][0], px[1][1] - px[0][1])
    + Math.hypot(px[2][0] - px[3][0], px[2][1] - px[3][1])
  ) / 2
  const height = (
    Math.hypot(px[3][0] - px[0][0], px[3][1] - px[0][1])
    + Math.hypot(px[2][0] - px[1][0], px[2][1] - px[1][1])
  ) / 2
  return height > 0 ? width / height : 0
}

// A card has no inherent up direction here: the collector may present it
// portrait or landscape. Collapsing r and 1/r makes 63:88 and 88:63 the same
// card, while a genuinely non-card region (2:1, 3:1) stays outside the band.
// This is the value the aspect gate compares; `quadAspect` stays the raw
// width/height so provenance still records what was measured.
export function orientationRatio(aspect) {
  if (!Number.isFinite(aspect) || !(aspect > 0)) return 0
  return aspect > 1 ? 1 / aspect : aspect
}

// True when the geometry looks like a fully-in-frame card region. `check` names
// the comparison that failed (null when it passed), computed from the same two
// booleans as `ok`, so a log cannot mislabel a refusal.
export function isContainableQuad(corners, {
  frame = null,
  minEdge = 0.015,
  minAspect = 0.55,
  maxAspect = 0.85,
} = {}) {
  const margin = minEdgeMargin(corners)
  const aspect = quadAspect(corners, frame)
  const ratio = orientationRatio(aspect)
  const edgeOk = margin >= minEdge
  const aspectOk = ratio >= minAspect && ratio <= maxAspect
  return {
    ok: edgeOk && aspectOk,
    edgeContainment: margin,
    quadAspect: aspect,
    orientationRatio: ratio,
    check: edgeOk ? (aspectOk ? null : 'aspect') : 'edge',
  }
}

// True when the detector confirmed a geometry recently and that confirmation
// still agrees with the quad about to be captured.
export function isCorroborated({
  lastConfirmTs,
  now,
  quadAgreement,
  maxAgeMs = CAPTURE_CORROBORATE_MS,
  maxAgreement = CAPTURE_CORROBORATE_MAX_AGREE,
} = {}) {
  if (lastConfirmTs == null) return false
  if (now - lastConfirmTs > maxAgeMs) return false
  return quadAgreement != null && quadAgreement <= maxAgreement
}

function pixelQuadArea(flat) {
  let area = 0
  for (let i = 0; i < 4; i += 1) {
    const x1 = flat[i * 2]
    const y1 = flat[i * 2 + 1]
    const x2 = flat[((i + 1) % 4) * 2]
    const y2 = flat[((i + 1) % 4) * 2 + 1]
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area) * 0.5
}

function isConvex(flat) {
  let positive = 0
  let negative = 0
  for (let i = 0; i < 4; i += 1) {
    const prev = (i + 3) % 4
    const next = (i + 1) % 4
    const cross = (flat[i * 2] - flat[prev * 2]) * (flat[next * 2 + 1] - flat[i * 2 + 1])
      - (flat[i * 2 + 1] - flat[prev * 2 + 1]) * (flat[next * 2] - flat[i * 2])
    if (cross > 0) positive += 1
    else if (cross < 0) negative += 1
  }
  return !(positive > 0 && negative > 0)
}

function sampleVariance(patch) {
  let sum = 0
  let sumSquares = 0
  let count = 0
  for (let sy = -PATCH_RADIUS; sy <= PATCH_RADIUS; sy += SAMPLE_STEP) {
    const row = (sy + PATCH_RADIUS) * PATCH_SIZE + PATCH_RADIUS
    for (let sx = -PATCH_RADIUS; sx <= PATCH_RADIUS; sx += SAMPLE_STEP) {
      const value = patch[row + sx]
      sum += value
      sumSquares += value * value
      count += 1
    }
  }
  const mean = sum / count
  return sumSquares / count - mean * mean
}

export function createTracker() {
  let width = 0
  let height = 0
  let patches = null
  let refCorners = null
  let prevCorners = null
  let anchorArea = 0
  let firstTrack = true
  let lastReason = 'frame'

  function reset() {
    width = 0
    height = 0
    patches = null
    refCorners = null
    prevCorners = null
    anchorArea = 0
    firstTrack = true
    lastReason = 'frame'
  }

  function patchFits(cx, cy) {
    const margin = PATCH_RADIUS + 1
    return cx >= margin && cx <= width - margin && cy >= margin && cy <= height - margin
  }

  function offsetFits(cx, cy, dx, dy) {
    return cx + dx - PATCH_RADIUS >= 0
      && cx + dx + PATCH_RADIUS < width
      && cy + dy - PATCH_RADIUS >= 0
      && cy + dy + PATCH_RADIUS < height
  }

  function capturePatch(gray, cx, cy, target) {
    const left = Math.round(cx) - PATCH_RADIUS
    const top = Math.round(cy) - PATCH_RADIUS
    let index = 0
    for (let row = 0; row < PATCH_SIZE; row += 1) {
      const offset = (top + row) * width + left
      for (let column = 0; column < PATCH_SIZE; column += 1) {
        target[index] = gray[offset + column]
        index += 1
      }
    }
  }

  function scoreOffset(patch, gray, cx, cy, dx, dy) {
    let score = 0
    for (let sy = -PATCH_RADIUS; sy <= PATCH_RADIUS; sy += SAMPLE_STEP) {
      const patchRow = (sy + PATCH_RADIUS) * PATCH_SIZE + PATCH_RADIUS
      const frameRow = (cy + sy + dy) * width + cx + dx
      for (let sx = -PATCH_RADIUS; sx <= PATCH_RADIUS; sx += SAMPLE_STEP) {
        const difference = patch[patchRow + sx] - gray[frameRow + sx]
        score += difference * difference
      }
    }
    return score
  }

  function setReference(gray, frameWidth, frameHeight, corners) {
    reset()
    if (!gray || !corners || corners.length !== 4
      || !(frameWidth > 0) || !(frameHeight > 0)) {
      return
    }
    if (gray.length !== frameWidth * frameHeight) return
    width = frameWidth
    height = frameHeight
    const points = new Float32Array(8)
    for (let i = 0; i < 4; i += 1) {
      points[i * 2] = corners[i][0] * width
      points[i * 2 + 1] = corners[i][1] * height
      if (!patchFits(points[i * 2], points[i * 2 + 1])) {
        reset()
        return
      }
    }
    const area = pixelQuadArea(points)
    if (!(area > 0)) {
      reset()
      return
    }
    anchorArea = area
    patches = Array.from({ length: 4 }, () => new Float32Array(PATCH_SIZE * PATCH_SIZE))
    for (let i = 0; i < 4; i += 1) {
      capturePatch(gray, points[i * 2], points[i * 2 + 1], patches[i])
    }
    refCorners = points
    prevCorners = points.slice()
  }

  function refreshAnchor(corners) {
    if (!patches || !corners || corners.length !== 4) return
    const points = new Float32Array(8)
    for (let i = 0; i < 4; i += 1) {
      points[i * 2] = corners[i][0] * width
      points[i * 2 + 1] = corners[i][1] * height
    }
    const area = pixelQuadArea(points)
    if (area > 0) anchorArea = area
  }

  function track(gray, frameWidth, frameHeight) {
    lastReason = 'frame'
    if (!patches || !refCorners || !gray) return null
    if (frameWidth !== width || frameHeight !== height) return null
    if (gray.length !== width * height) return null

    const radius = firstTrack ? FIRST_TRACK_RADIUS : SEARCH_RADIUS
    const candidates = new Float32Array(8)
    for (let i = 0; i < 4; i += 1) {
      const cx = Math.round(refCorners[i * 2])
      const cy = Math.round(refCorners[i * 2 + 1])
      let bestScore = Infinity
      let bestDx = 0
      let bestDy = 0

      // Coarse pass: wide reach at stride 2.
      for (let dy = -radius; dy <= radius; dy += COARSE_STRIDE) {
        for (let dx = -radius; dx <= radius; dx += COARSE_STRIDE) {
          if (!offsetFits(cx, cy, dx, dy)) continue
          const score = scoreOffset(patches[i], gray, cx, cy, dx, dy)
          if (score < bestScore) {
            bestScore = score
            bestDx = dx
            bestDy = dy
          }
        }
      }
      // Fine pass: ±2 px around the coarse winner at stride 1.
      const minDx = Math.max(-radius, bestDx - REFINE_RADIUS)
      const maxDx = Math.min(radius, bestDx + REFINE_RADIUS)
      const minDy = Math.max(-radius, bestDy - REFINE_RADIUS)
      const maxDy = Math.min(radius, bestDy + REFINE_RADIUS)
      for (let dy = minDy; dy <= maxDy; dy += 1) {
        for (let dx = minDx; dx <= maxDx; dx += 1) {
          if (!offsetFits(cx, cy, dx, dy)) continue
          const score = scoreOffset(patches[i], gray, cx, cy, dx, dy)
          if (score < bestScore) {
            bestScore = score
            bestDx = dx
            bestDy = dy
          }
        }
      }

      const variance = sampleVariance(patches[i])
      const bestMse = bestScore / SAMPLE_COUNT
      if (!isPatchMatchAcceptable(bestMse, variance)) {
        lastReason = 'score'
        return null
      }
      // A best match at the search edge may really be moving out of the window.
      // The first track is the exceptional case: the card is known to have moved
      // during inference, so an edge match is accepted when the score/gates pass.
      if (!firstTrack && (Math.abs(bestDx) === radius || Math.abs(bestDy) === radius)) {
        lastReason = 'edge'
        return null
      }
      candidates[i * 2] = refCorners[i * 2] + bestDx
      candidates[i * 2 + 1] = refCorners[i * 2 + 1] + bestDy
    }

    const area = pixelQuadArea(candidates)
    if (area < anchorArea * MIN_AREA_RATIO || area > anchorArea * MAX_AREA_RATIO) {
      lastReason = 'area'
      return null
    }
    if (!isConvex(candidates)) {
      lastReason = 'convex'
      return null
    }
    const maxStep = MAX_FRAME_MOVE * Math.hypot(width, height)
    for (let i = 0; i < 4; i += 1) {
      const dx = candidates[i * 2] - prevCorners[i * 2]
      const dy = candidates[i * 2 + 1] - prevCorners[i * 2 + 1]
      if (dx * dx + dy * dy > maxStep * maxStep) {
        lastReason = 'step'
        return null
      }
    }

    // Absorb slow drift: the next patches come from the current frame, while
    // anchorArea stays tied to the last model quad's shape.
    for (let i = 0; i < 4; i += 1) {
      capturePatch(gray, candidates[i * 2], candidates[i * 2 + 1], patches[i])
    }
    refCorners.set(candidates)
    prevCorners.set(candidates)
    firstTrack = false
    lastReason = 'ok'

    const result = []
    for (let i = 0; i < 4; i += 1) {
      result.push([candidates[i * 2] / width, candidates[i * 2 + 1] / height])
    }
    return result
  }

  return { setReference, track, reset, refreshAnchor, getLastReason: () => lastReason }
}
