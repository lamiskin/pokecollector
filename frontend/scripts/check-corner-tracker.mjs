// Tiny sanity check for the local corner tracker's SSE search and validation.
// Run with: node scripts/check-corner-tracker.mjs

import assert from 'node:assert/strict'

import {
  CAPTURE_MODEL_MAX_AGE_MS,
  CAPTURE_QUAD_MAX_AGE_MS,
  createTracker,
  derivePhase,
  evaluateTentative,
  isPatchMatchAcceptable,
  shouldAcceptCapture,
  shouldKeepTracking,
  TRACK_LOST_AFTER,
} from '../src/utils/cornerTracker.js'
import { autoHoldDecision } from '../src/utils/autoHold.js'

const width = 160
const height = 160
// Smooth, non-periodic over the search reach: unique patches without the
// nine-sample aliasing a random texture produces.
const pattern = (x, y) => (
  128
  + 55 * Math.sin(0.13 * x + 0.31 * y + 1)
  + 45 * Math.cos(0.27 * x - 0.04 * y + 2)
  + 35 * Math.sin(0.06 * (x + y))
)
const corners = [[32, 32], [128, 32], [128, 128], [32, 128]]
const normalized = corners.map(([x, y]) => [x / width, y / height])
const base = new Float32Array(width * height)
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    base[y * width + x] = pattern(x, y)
  }
}

function shiftedFrame(shiftX, shiftY) {
  const data = new Float32Array(width * height)
  for (let y = shiftY; y < height; y += 1) {
    for (let x = shiftX; x < width; x += 1) {
      data[y * width + x] = pattern(x - shiftX, y - shiftY)
    }
  }
  return data
}

function assertCorners(tracked, shiftX, shiftY) {
  assert.ok(tracked, 'tracker should follow the shift')
  for (let i = 0; i < 4; i += 1) {
    assert.ok(
      Math.abs(tracked[i][0] * width - (corners[i][0] + shiftX)) < 0.51,
      `corner ${i} x should move by ${shiftX}`,
    )
    assert.ok(
      Math.abs(tracked[i][1] * height - (corners[i][1] + shiftY)) < 0.51,
      `corner ${i} y should move by ${shiftY}`,
    )
  }
}

// Small per-frame drift, then standing still after the patch refresh.
{
  const tracker = createTracker()
  tracker.setReference(base, width, height, normalized)
  assertCorners(tracker.track(shiftedFrame(2, 1), width, height), 2, 1)
  assertCorners(tracker.track(shiftedFrame(2, 1), width, height), 2, 1)
  assert.equal(tracker.getLastReason(), 'ok')

  // A featureless frame must be rejected.
  assert.equal(tracker.track(new Float32Array(width * height), width, height), null)
}

// A 12 px jump between the reference frame and the first live frame: this is
// the stale-lock gap, and the wider first-track search must bridge it. The
// normal per-frame radius of 16 px could not reach past a stalled frame.
{
  const tracker = createTracker()
  tracker.setReference(base, width, height, normalized)
  assertCorners(tracker.track(shiftedFrame(12, 5), width, height), 12, 5)
  assert.equal(tracker.getLastReason(), 'ok')
}

// The full first-track reach: 40 px on a 250 px frame is ~8 % of the width,
// bridging a hand movement during one ~300 ms inference.
{
  const size = 250
  const bigCorners = [[60, 60], [190, 60], [190, 190], [60, 190]]
  const bigNormalized = bigCorners.map(([x, y]) => [x / size, y / size])
  const bigBase = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) bigBase[y * size + x] = pattern(x, y)
  }
  const shiftX = 40
  const shiftY = 4
  const bigShifted = new Float32Array(size * size)
  for (let y = shiftY; y < size; y += 1) {
    for (let x = shiftX; x < size; x += 1) {
      bigShifted[y * size + x] = pattern(x - shiftX, y - shiftY)
    }
  }
  const tracker = createTracker()
  tracker.setReference(bigBase, size, size, bigNormalized)
  const tracked = tracker.track(bigShifted, size, size)
  assert.ok(tracked, 'a 40 px first-track jump should be bridged')
  for (let i = 0; i < 4; i += 1) {
    assert.ok(Math.abs(tracked[i][0] * size - (bigCorners[i][0] + shiftX)) < 0.51)
    assert.ok(Math.abs(tracked[i][1] * size - (bigCorners[i][1] + shiftY)) < 0.51)
  }
}

// The model-result decision: an agreeing tracker is kept (no setReference),
// disagreement re-anchors, and a stale or absent tracker resets.
{
  const trackedCorners = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
  const agreeing = trackedCorners.map(([x, y]) => [x + 0.02, y + 0.01])
  const disagreeing = trackedCorners.map(([x, y]) => [x + 0.09, y])
  assert.equal(
    shouldKeepTracking({ trackedCorners, modelCorners: agreeing, ageMs: 200 }),
    'keep',
  )
  assert.equal(
    shouldKeepTracking({ trackedCorners, modelCorners: disagreeing, ageMs: 200 }),
    'reanchor',
  )
  assert.equal(
    shouldKeepTracking({ trackedCorners, modelCorners: agreeing, ageMs: 900 }),
    'reset',
  )
  assert.equal(
    shouldKeepTracking({ trackedCorners: null, modelCorners: agreeing, ageMs: 100 }),
    'reset',
  )
}

// Score gating is relative to the patch's own variance. A mean squared error of
// 676 (e.g. a +26 exposure shift on an exact geometric match) exceeds the old
// absolute 625 gate, so that gate rejected it everywhere. It is accepted when
// the patch carries real signal, and still rejected on a nearly flat patch.
assert.equal(isPatchMatchAcceptable(676, 5000), true)
assert.equal(isPatchMatchAcceptable(676, 300), false)

// A tentative re-anchor that keeps failing must be dropped, leaving the live
// tracker exactly as it was.
{
  const live = createTracker()
  live.setReference(base, width, height, normalized)
  assert.ok(live.track(shiftedFrame(2, 1), width, height))

  const disagreeing = corners.map(([x, y]) => [x / width + 0.09, y / height])
  assert.equal(
    shouldKeepTracking({
      trackedCorners: live.track(shiftedFrame(2, 1), width, height),
      modelCorners: disagreeing,
      ageMs: 120,
    }),
    'reanchor',
  )

  const tentative = createTracker()
  tentative.setReference(base, width, height, normalized)
  const blank = new Float32Array(width * height)
  assert.equal(tentative.track(blank, width, height), null)
  assert.equal(tentative.track(blank, width, height), null)
  assert.equal(evaluateTentative({ hits: 0, misses: 2 }), 'discard')

  // The live tracker was never touched, so it still follows the card.
  assert.ok(live.track(shiftedFrame(2, 1), width, height))
}

// A tentative re-anchor that proves itself with two clean tracks is adopted.
{
  const tentative = createTracker()
  tentative.setReference(base, width, height, normalized)
  assert.ok(tentative.track(shiftedFrame(2, 1), width, height))
  assert.ok(tentative.track(shiftedFrame(2, 1), width, height))
  assert.equal(evaluateTentative({ hits: 2, misses: 0 }), 'adopt')
  assert.equal(evaluateTentative({ hits: 1, misses: 0 }), 'pending')
}

// Phase and reason come from one function. A fresh tracked quad must draw as
// tracking even when the model result is unusable, and a single miss must not
// flip the phase to lost.
{
  assert.deepEqual(
    derivePhase({ trackedFresh: true, modelUsable: false }),
    { phase: 'tracking', reason: 'tracking' },
  )
  assert.deepEqual(
    derivePhase({ trackedFresh: true, trackMisses: 1 }),
    { phase: 'tracking', reason: 'tracking' },
  )
  assert.deepEqual(
    derivePhase({ trackedFresh: true, trackMisses: TRACK_LOST_AFTER }),
    { phase: 'lost', reason: 'lost' },
  )
  assert.deepEqual(
    derivePhase({ trackedFresh: true, trackMisses: TRACK_LOST_AFTER, trackedTooSmall: true }),
    { phase: 'tooSmall', reason: 'too-small' },
  )
  // Confirmation pulse: solid while active, then back to dashed tracking.
  assert.deepEqual(
    derivePhase({ trackedFresh: true, confirmedPulse: true }),
    { phase: 'locked', reason: 'confirmed' },
  )
  assert.deepEqual(
    derivePhase({ trackedFresh: true, confirmedPulse: false }),
    { phase: 'tracking', reason: 'tracking' },
  )
  assert.deepEqual(
    derivePhase({ trackedFresh: true, confirmedPulse: true, trackedTooSmall: true }),
    { phase: 'tooSmall', reason: 'too-small' },
  )
  assert.deepEqual(
    derivePhase({ trackedFresh: true, confirmedPulse: true, trackMisses: TRACK_LOST_AFTER }),
    { phase: 'lost', reason: 'lost' },
  )
  assert.deepEqual(derivePhase({ modelUsable: true }), { phase: 'locked', reason: 'tracking' })
  assert.deepEqual(derivePhase({ hasModel: false }), { phase: 'none', reason: 'no-quad' })
}

// Auto-capture hold rule: the user holds a card still, they do not freeze a
// camera. Slow per-step drift must keep the window open; a single fast step, a
// large jump, or a slow pan that adds up past the total cap must cancel it.
{
  const quadAt = dx => [
    [0.2 + dx, 0.2],
    [0.8 + dx, 0.2],
    [0.8 + dx, 0.8],
    [0.2 + dx, 0.8],
  ]
  const anchor = quadAt(0)
  const decide = (lastCorners, corners, now, lastQualifyingTs = now - 100) => (
    autoHoldDecision({
      anchorCorners: anchor,
      lastCorners,
      corners,
      now,
      lastQualifyingTs,
    })
  )

  // 0.5 % of the frame per observation, once per 100 ms, for 1.2 s: 6 % total.
  for (let i = 1; i <= 12; i += 1) {
    assert.equal(
      decide(quadAt(0.005 * (i - 1)), quadAt(0.005 * i), i * 100).action,
      'keep',
      `0.5% step ${i} must keep the window`,
    )
  }

  // A 6 % single step is a deliberate move, not drift.
  assert.equal(decide(anchor, quadAt(0.06), 100).reason, 'jump')
  // 2 % is still above the per-step allowance even though it is no jump.
  assert.equal(decide(anchor, quadAt(0.02), 100).reason, 'step')

  // A slow pan: 1 % per step never trips the step rule but adds up to 11 % of
  // the frame by the eleventh observation, so the total cap must close it.
  let lastPan = anchor
  let panDecision = null
  for (let i = 1; i <= 12; i += 1) {
    panDecision = decide(lastPan, quadAt(0.01 * i), i * 100)
    lastPan = quadAt(0.01 * i)
    if (panDecision.action === 'restart') break
  }
  assert.equal(panDecision.reason, 'total')

  // No window yet, and a stalled detection loop (gap) both restart the clock.
  assert.equal(
    autoHoldDecision({
      anchorCorners: null,
      lastCorners: null,
      corners: anchor,
      now: 0,
      lastQualifyingTs: null,
    }).action,
    'start',
  )
  assert.equal(decide(anchor, anchor, 2000, 0).reason, 'gap')
}

// Capture geometry may not outlive the frame it is applied to. A stale tracked
// quad is a rejection, not a fallback to the model; the model is only usable
// when no tracked quad exists at all.
{
  assert.deepEqual(
    shouldAcceptCapture({ hasTracked: true, trackedAgeMs: 50, modelAgeMs: 900 }),
    { ok: true, reason: 'ok', source: 'tracked' },
  )
  assert.deepEqual(
    shouldAcceptCapture({
      hasTracked: true,
      trackedAgeMs: CAPTURE_QUAD_MAX_AGE_MS + 1,
      modelAgeMs: 50,
    }),
    { ok: false, reason: 'stale-tracked', source: 'tracked' },
  )
  assert.deepEqual(
    shouldAcceptCapture({ hasTracked: true, trackedAgeMs: null, modelAgeMs: 50 }),
    { ok: false, reason: 'stale-tracked', source: 'tracked' },
  )
  assert.deepEqual(
    shouldAcceptCapture({
      hasTracked: false,
      modelAgeMs: CAPTURE_MODEL_MAX_AGE_MS - 1,
    }),
    { ok: true, reason: 'ok', source: 'model' },
  )
  assert.deepEqual(
    shouldAcceptCapture({
      hasTracked: false,
      modelAgeMs: CAPTURE_MODEL_MAX_AGE_MS + 1,
    }),
    { ok: false, reason: 'stale-model', source: 'model' },
  )
  assert.deepEqual(
    shouldAcceptCapture({ hasTracked: false, modelAgeMs: null }),
    { ok: false, reason: 'stale-model', source: 'model' },
  )
}

console.log('corner tracker sanity check passed')
