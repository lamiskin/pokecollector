// Tiny sanity check for the local corner tracker's SSE search and validation.
// Run with: node scripts/check-corner-tracker.mjs

import assert from 'node:assert/strict'

import {
  CAPTURE_MODEL_MAX_AGE_MS,
  CAPTURE_QUAD_MAX_AGE_MS,
  cornerAgreement,
  createTracker,
  derivePhase,
  evaluateTentative,
  isCorroborated,
  isPatchMatchAcceptable,
  shouldAcceptCapture,
  shouldKeepTracking,
  TRACK_LOST_AFTER,
} from '../src/utils/cornerTracker.js'
import { autoHoldDecision, AUTO_DRIFT_WINDOW_MS } from '../src/utils/autoHold.js'

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

// Auto-capture hold: judge smoothness against the median of a rolling window so
// tracker jitter, one correction, and a couple of rogue samples survive while
// sustained displacement cancels. Model adoptions re-baseline the window.
{
  const quadAt = dx => [
    [0.2 + dx, 0.2], [0.8 + dx, 0.2], [0.8 + dx, 0.8], [0.2 + dx, 0.8],
  ]
  const base = quadAt(0)
  // Mirrors the caller: tracked observations fill history; a model observation
  // keeps the hold clock but discards the old coordinate frame.
  const simulate = (observations, stepMs = 33) => {
    let t = 0
    let anchor = base
    let last = base
    let lastSource = 'tracked'
    let history = [{ corners: base, t: 0, source: 'tracked' }]
    let decision = null
    let firstRestart = null
    for (const observation of observations) {
      t += stepMs
      const corners = quadAt(observation.dx)
      const source = observation.source || 'tracked'
      decision = autoHoldDecision({
        anchorCorners: anchor,
        lastCorners: last,
        corners,
        now: t,
        lastQualifyingTs: t - stepMs,
        history,
        source,
        lastSource,
      })
      if (decision.action === 'restart') {
        if (!firstRestart) firstRestart = decision
        anchor = corners
        history = [{ corners, t, source }]
      } else if (decision.action === 'keep') {
        if (decision.reanchor) history = []
        history.push({ corners, t, source })
        const cutoff = t - AUTO_DRIFT_WINDOW_MS
        while (history.length > 0 && history[0].t < cutoff) history.shift()
      }
      last = corners
      lastSource = source
    }
    return firstRestart || decision
  }

  // Ten observations of ±2 % jitter inside 500 ms: ordinary tremor keeps it.
  const jitter = Array.from({ length: 10 }, (_, i) => ({
    dx: i % 3 === 0 ? 0.02 : i % 2 === 0 ? 0.01 : 0,
  }))
  assert.equal(simulate(jitter, 50).action, 'keep')

  // A single 7 % model adoption step keeps the window: the correction is a
  // coordinate-frame change, not the card jumping, and the history restarts at
  // the adopted quad.
  const adoption = [
    ...Array.from({ length: 10 }, () => ({ dx: 0 })),
    { dx: 0.07, source: 'model' },
    ...Array.from({ length: 6 }, () => ({ dx: 0.07 })),
  ]
  assert.equal(simulate(adoption).action, 'keep')

  // 1 %/frame creep for 800 ms stays below the median drift threshold.
  const creep = Array.from({ length: 8 }, (_, i) => ({ dx: 0.01 * (i + 1) }))
  assert.equal(simulate(creep, 100).action, 'keep')

  // 4 % sustained movement within 200 ms: the median still sits at the old
  // position, so this cancels as drift.
  const sustained = [
    ...Array.from({ length: 10 }, () => ({ dx: 0 })),
    ...Array.from({ length: 6 }, () => ({ dx: 0.04 })),
  ]
  assert.equal(simulate(sustained).reason, 'drift')

  // 8 % in one tracked-to-tracked step is a discontinuity.
  const jump = [...Array.from({ length: 5 }, () => ({ dx: 0 })), { dx: 0.08 }]
  assert.equal(simulate(jump).reason, 'jump')

  // Two anomalous samples among fifteen cannot move the median, so the window
  // survives when the card itself has not moved.
  const outliers = [
    ...Array.from({ length: 13 }, (_, i) => ({ corners: base, t: i * 33, source: 'tracked' })),
    ...Array.from({ length: 2 }, (_, i) => ({ corners: quadAt(0.06), t: 430 + i * 33, source: 'tracked' })),
  ]
  assert.equal(
    autoHoldDecision({
      anchorCorners: base,
      lastCorners: quadAt(0.06),
      corners: base,
      now: 500,
      lastQualifyingTs: 480,
      history: outliers,
      source: 'tracked',
      lastSource: 'tracked',
    }).action,
    'keep',
  )

  // No window yet, and a stalled loop, both restart the clock.
  assert.equal(
    autoHoldDecision({
      anchorCorners: null,
      lastCorners: null,
      corners: base,
      now: 0,
      lastQualifyingTs: null,
    }).action,
    'start',
  )
  assert.equal(
    autoHoldDecision({
      anchorCorners: base,
      lastCorners: base,
      corners: base,
      now: 2000,
      lastQualifyingTs: 0,
      history: [{ corners: base, t: 0, source: 'tracked' }],
    }).reason,
    'gap',
  )
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
  assert.deepEqual(
    shouldAcceptCapture({ hasTracked: false, modelAgeMs: 10, modelUsable: false }),
    { ok: false, reason: 'model-unusable', source: 'model' },
  )
}

// Automatic capture requires recent detector corroboration of the geometry.
{
  assert.equal(
    isCorroborated({ lastConfirmTs: 1000, now: 1500, quadAgreement: 0.02 }),
    true,
  )
  assert.equal(
    isCorroborated({ lastConfirmTs: 1000, now: 2600, quadAgreement: 0.02 }),
    false,
  )
  assert.equal(
    isCorroborated({ lastConfirmTs: null, now: 1000, quadAgreement: 0 }),
    false,
  )
  assert.equal(
    isCorroborated({ lastConfirmTs: 1000, now: 1200, quadAgreement: 0.15 }),
    true,
  )
  assert.equal(
    isCorroborated({ lastConfirmTs: 1000, now: 1200, quadAgreement: 0.35 }),
    false,
  )
  assert.equal(
    isCorroborated({ lastConfirmTs: 1000, now: 1200, quadAgreement: null }),
    false,
  )
}

console.log('corner tracker sanity check passed')
