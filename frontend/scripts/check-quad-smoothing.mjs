// Sanity checks for the display-only quad smoother: it must absorb tracker
// noise without a staircase, follow a real move with deliberate smoothing, and
// travel to a re-locked quad instead of teleporting.
import { createQuadSmoother, QUAD_GLIDE_MS } from '../src/utils/quadSmoothing.js'

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

// Continuity: a stationary quad with ±1 px (0.002 normalised) noise at 60 fps
// must never move the drawn outline in a visible step. This is the staircase
// check: the old stillness freeze repainted up to 12 px at once.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 16.7, 0)
  let previous = copy(smoother.corners)
  let largest = 0
  for (let i = 1; i <= 120; i += 1) {
    const jitter = (i % 2 ? 1 : -1) * 0.002
    smoother.sample(shift(base, jitter, -jitter), 16.7, i * 16.7)
    largest = Math.max(largest, maxMove(smoother.corners, previous))
    previous = copy(smoother.corners)
  }
  check('tracker noise never produces a visible step', largest < 0.0004,
    `largest ${largest.toFixed(6)}`)
}

// Step response: a real but non-discontinuous 0.05 move must be smoothed, not
// snapped. With the slower follower and low cutoff the 90 % point is about
// 885 ms on this 60 fps trace.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 16.7, 0)
  const target = shift(base, 0.05, 0)
  let reachedAt = null
  for (let i = 1; i <= 160; i += 1) {
    const t = i * 16.7
    smoother.sample(target, 16.7, t)
    if (reachedAt == null && maxMove(smoother.corners, target) <= 0.005) reachedAt = t
  }
  check('a 0.05 move is not snapped', reachedAt != null && reachedAt >= 500 && reachedAt <= 1000,
    `90 % at ${reachedAt}`)
  check('the smoothed move eventually arrives', maxMove(smoother.corners, target) < 0.002,
    `error ${maxMove(smoother.corners, target).toFixed(5)}`)
}

// Jump glide: a discontinuity travels over roughly QUAD_GLIDE_MS, leaves
// gently, never teleports, and finally lands.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 16.7, 0)
  const far = shift(base, 0.35, 0.35)
  smoother.sample(far, 16.7, 16.7)
  check('a discontinuity does not teleport', maxMove(smoother.corners, base) < 1e-9,
    `moved ${maxMove(smoother.corners, base).toFixed(4)}`)
  check('a discontinuity starts a glide', smoother.gliding === true)

  let previous = copy(smoother.corners)
  let largestStep = 0
  let reachedAt = null
  for (let t = 33.4; t <= 3000; t += 16.7) {
    smoother.tick(t)
    largestStep = Math.max(largestStep, maxMove(smoother.corners, previous))
    previous = copy(smoother.corners)
    if (reachedAt == null && maxMove(smoother.corners, far) <= 0.05) reachedAt = t
  }
  check('the glide reaches the new quad around its duration',
    reachedAt != null && reachedAt >= 600 && reachedAt <= QUAD_GLIDE_MS + 300,
    `90 % at ${reachedAt}, glide ${QUAD_GLIDE_MS}`)
  check('the glide never jumps', largestStep < 0.03, `largest step ${largestStep.toFixed(4)}`)
  check('the glide eventually lands exactly', maxMove(smoother.corners, far) < 1e-5,
    `error ${maxMove(smoother.corners, far).toFixed(6)}`)
}

// Monotonic, no overshoot.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 33, 0)
  const far = shift(base, 0.35, 0.35)
  smoother.sample(far, 33, 33)
  const targetX = far[0][0]
  let previousX = smoother.corners[0][0]
  let monotonic = true
  let overshoot = false
  for (let t = 49; t <= 1200; t += 16) {
    smoother.tick(t)
    const x = smoother.corners[0][0]
    if (x < previousX - 1e-12) monotonic = false
    if (x > targetX + 1e-12) overshoot = true
    previousX = x
  }
  check('the glide approaches monotonically', monotonic)
  check('the glide never overshoots the target', !overshoot)
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
  for (let t = 33 + 96; t <= 3000; t += 16) {
    smoother.tick(t)
    const x = smoother.corners[0][0]
    if (x > previousX + 1e-12) monotonic = false
    previousX = x
  }
  check('the restart approaches its new target monotonically', monotonic)
  check('the restart lands on the newest quad', maxMove(smoother.corners, elsewhere) < 1e-5,
    `error ${maxMove(smoother.corners, elsewhere).toFixed(6)}`)
}

// A non-discontinuous sample during a glide retargets the landing point without
// restarting the full duration.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 33, 0)
  const far = shift(base, 0.35, 0.35)
  smoother.sample(far, 33, 33)
  smoother.tick(33 + 200)
  const movedTarget = shift(far, 0.02, -0.02)
  smoother.sample(movedTarget, 33, 33 + 200)
  let previous = copy(smoother.corners)
  let largestStep = 0
  for (let t = 33 + 216; t <= 3000; t += 16) {
    smoother.tick(t)
    largestStep = Math.max(largestStep, maxMove(smoother.corners, previous))
    previous = copy(smoother.corners)
  }
  check('a mid-glide sample moves the landing point', maxMove(smoother.corners, movedTarget) < 1e-5,
    `error ${maxMove(smoother.corners, movedTarget).toFixed(6)}`)
  check('retargeting does not teleport', largestStep < 0.03, `largest step ${largestStep.toFixed(4)}`)
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
  for (let i = 1; i <= 30; i += 1) smoother.sample(crept, 33, 33 + QUAD_GLIDE_MS + i * 33)
  const error = maxMove(smoother.corners, crept)
  check('filtering resumes after a glide', error < 0.01, `error ${error.toFixed(4)}`)
}

if (failures) {
  console.error(`${failures} smoother check(s) failed`)
  process.exit(1)
}
console.log('quad smoothing sanity check passed')
