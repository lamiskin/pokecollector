// Sanity checks for the display-only quad smoother: it must absorb tracker
// noise completely and still follow a card that actually moves.
import { createQuadSmoother, QUAD_STILL_FRACTION } from '../src/utils/quadSmoothing.js'

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

// A discontinuity (card swapped or re-locked elsewhere) snaps immediately.
{
  const smoother = createQuadSmoother()
  smoother.sample(base, 33)
  const far = shift(base, 0.35, 0.35)
  smoother.sample(far, 33)
  const error = maxMove(smoother.corners, far)
  check('a discontinuity snaps', error < 1e-6, `error ${error.toFixed(4)}`)
}

if (failures) {
  console.error(`${failures} smoother check(s) failed`)
  process.exit(1)
}
console.log('quad smoothing sanity check passed')
