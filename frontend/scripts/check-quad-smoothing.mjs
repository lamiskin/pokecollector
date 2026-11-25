// Sanity checks for the display-only quad smoother: it must absorb tracker
// noise completely, still follow a card that actually moves, and travel to a
// re-locked quad instead of teleporting.
import {
  createQuadSmoother,
  QUAD_GLIDE_MS,
  QUAD_STILL_FRACTION,
} from '../src/utils/quadSmoothing.js'

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) {
    failures += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const base = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]
const shift = (quad, dx, dy) => quad.map(([x, y]) => [x + dx, y + dy])
const maxMove = (a, b) => Math.max(...a.map(([x, y], i) => Math.hypot(x - b[i][0], y - b[i][1])))
const copy = quad => quad.map(([x, y]) => [x, y])

// Noise smaller than the still band must not move the published outline at all.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 33)
  const drawn = smoother.corners.map(([x, y]) => [x, y])
  let moved = 0
  for (let i = 0; i < 60; i += 1) {
    const jitter = (i % 2 ? 1 : -1) * QUAD_STILL_FRACTION * 0.6
    smoother.sample(shift(base, jitter, -jitter), 33)
    moved = Math.max(moved, maxMove(smoother.corners, drawn))
  }
  check('noise inside the still band never repaints', moved === 0, `moved ${moved.toFixed(4)}`)
}

// A real move must be followed promptly (not frozen by the still band).
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 33)
  const target = shift(base, 0.08, 0.08)
  for (let i = 0; i < 30; i += 1) smoother.sample(target, 33)
  const error = maxMove(smoother.corners, target)
  check('a real move is followed', error < 0.01, `error ${error.toFixed(4)}`)
}

// A discontinuity (card swapped or re-locked elsewhere) leaves the drawn quad
// where it was and glides from there: the first frame must not teleport.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 33, 0)
  const far = shift(base, 0.35, 0.35)
  smoother.sample(far, 33, 33)
  check('a discontinuity does not teleport', maxMove(smoother.corners, base) < 1e-9,
    `moved ${maxMove(smoother.corners, base).toFixed(4)}`)
  check('a discontinuity starts a glide', smoother.gliding === true)

  // Monotonic approach along the direction of travel, never past the target,
  // and landed on it within the glide window.
  const startX = smoother.corners[0][0]
  const targetX = far[0][0]
  let previous = startX
  let monotonic = true
  let overshoot = false
  let landedAt = null
  for (let t = 33 + 16; t <= 33 + QUAD_GLIDE_MS + 16; t += 16) {
    smoother.tick(t)
    const x = smoother.corners[0][0]
    if (x < previous - 1e-12) monotonic = false
    if (x > targetX + 1e-12) overshoot = true
    previous = x
    if (landedAt == null && !smoother.gliding) landedAt = t
  }
  check('the glide approaches monotonically', monotonic)
  check('the glide never overshoots the target', !overshoot)
  check('the glide lands within the glide window', landedAt != null && landedAt <= 33 + QUAD_GLIDE_MS + 16,
    `landed at ${landedAt}`)
  check('the glide ends exactly on the new quad', maxMove(smoother.corners, far) < 1e-9,
    `error ${maxMove(smoother.corners, far).toFixed(6)}`)
}

// A second discontinuity mid-glide restarts from wherever the outline is: no
// jump back to the first origin, and no queue.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 33, 0)
  const far = shift(base, 0.35, 0.35)
  smoother.sample(far, 33, 33)
  smoother.tick(33 + 80)
  const mid = copy(smoother.corners)
  const elsewhere = shift(base, -0.3, 0.2)
  smoother.sample(elsewhere, 33, 33 + 80)
  check('a mid-glide jump restarts from the drawn position', maxMove(smoother.corners, mid) < 1e-9,
    `moved ${maxMove(smoother.corners, mid).toFixed(4)}`)

  let previousX = smoother.corners[0][0]
  let monotonic = true
  for (let t = 33 + 96; t <= 33 + 80 + QUAD_GLIDE_MS + 16; t += 16) {
    smoother.tick(t)
    const x = smoother.corners[0][0]
    if (x > previousX + 1e-12) monotonic = false
    previousX = x
  }
  check('the restart approaches its new target monotonically', monotonic)
  check('the restart lands on the newest quad', maxMove(smoother.corners, elsewhere) < 1e-9,
    `error ${maxMove(smoother.corners, elsewhere).toFixed(6)}`)
}

// Reduced motion (glide off) and a fresh session both show the quad where it
// is instead of travelling to it.
{
  const snapping = createQuadSmoother({ glideMs: 0 })
  snapping.sample(base, 33, 0)
  const far = shift(base, 0.35, 0.35)
  snapping.sample(far, 33, 33)
  check('glideMs 0 snaps a discontinuity', maxMove(snapping.corners, far) < 1e-9,
    `error ${maxMove(snapping.corners, far).toFixed(4)}`)
  check('glideMs 0 never reports a glide', snapping.gliding === false)

  const first = createQuadSmoother()
  const jumped = shift(base, 0.4, -0.3)
  first.sample(jumped, 33, 0)
  check('the first sample of a session is not glided', maxMove(first.corners, jumped) < 1e-9)

  // The same after the quad disappears: reacquisition is a seed, not a sweep.
  first.sample(null, 33, 33)
  const elsewhere = shift(base, -0.35, 0.1)
  first.sample(elsewhere, 33, 66)
  check('a quad that comes back is not glided', maxMove(first.corners, elsewhere) < 1e-9)

  // Disabling the glide while one is running lands it immediately.
  const stopping = createQuadSmoother()
  stopping.sample(base, 33, 0)
  stopping.sample(far, 33, 33)
  stopping.setGlideMs(0)
  stopping.tick(33 + 16)
  check('turning the glide off mid-flight lands it', maxMove(stopping.corners, far) < 1e-9,
    `error ${maxMove(stopping.corners, far).toFixed(4)}`)
}

// Filtering resumes cleanly after a glide instead of stalling at the seed quad.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 33, 0)
  const far = shift(base, 0.35, 0.35)
  smoother.sample(far, 33, 33)
  const crept = shift(far, 0.02, 0.02)
  for (let i = 1; i <= 20; i += 1) smoother.sample(crept, 33, 33 + QUAD_GLIDE_MS + i * 33)
  const error = maxMove(smoother.corners, crept)
  check('filtering resumes after a glide', error < 0.01, `error ${error.toFixed(4)}`)
}

if (failures) {
  console.error(`${failures} smoother check(s) failed`)
  process.exit(1)
}
console.log('quad smoothing sanity check passed')
