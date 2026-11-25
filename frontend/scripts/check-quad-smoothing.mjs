// Sanity checks for the display-only quad smoother: it must absorb tracker
// noise without a staircase, follow a real move with deliberate smoothing, and
// report discontinuities as cuts rather than glides.
import { createQuadSmoother } from '../src/utils/quadSmoothing.js'

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

// A discontinuity is a cut, not a glide: the smoother snaps to the new quad
// and reports the jump so the overlay can animate the swap. Ordinary movement
// does not count as a discontinuity.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 16.7, 0)
  const far = shift(base, 0.35, 0.35)
  smoother.sample(far, 16.7, 16.7)
  check('a discontinuity increments jumpCount to one', smoother.jumpCount === 1)
  check('a discontinuity snaps to the new quad', maxMove(smoother.corners, far) < 1e-9,
    `error ${maxMove(smoother.corners, far).toFixed(6)}`)
  check('a discontinuity does not glide', smoother.gliding === false)

  const ordinary = shift(far, 0.002, 0.002)
  smoother.sample(ordinary, 16.7, 33.4)
  check('ordinary movement does not increment jumpCount', smoother.jumpCount === 1)

  const first = createQuadSmoother()
  const jumped = shift(base, 0.4, -0.3)
  first.sample(jumped, 33, 0)
  check('the first sample of a session is not a jump', first.jumpCount === 0)
  first.sample(null, 33, 33)
  const elsewhere = shift(base, -0.35, 0.1)
  first.sample(elsewhere, 33, 66)
  check('a quad that comes back is not a jump', first.jumpCount === 0)
}

if (failures) {
  console.error(`${failures} smoother check(s) failed`)
  process.exit(1)
}
console.log('quad smoothing sanity check passed')
