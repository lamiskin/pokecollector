// Sanity checks for the re-arm appearance signature.
// Run with: node scripts/check-patch-signature.mjs

import assert from 'node:assert/strict'

// Minimal canvas stub: tests run in plain node, with no DOM.
class FakeCanvas {
  constructor(width = 1, height = 1) {
    this.width = width
    this.height = height
    this.data = new Uint8ClampedArray(width * height * 4)
    this._context = null
  }

  getContext() {
    if (this._context) return this._context
    this._context = {
      clearRect: () => this.data.fill(0),
      drawImage: (source, sx, sy, sw, sh, dx, dy, dw, dh) => {
        this.data.fill(0)
        for (let y = 0; y < dh; y += 1) {
          const sourceY = sy + Math.floor((y / dh) * sh)
          for (let x = 0; x < dw; x += 1) {
            const sourceX = sx + Math.floor((x / dw) * sw)
            const from = (sourceY * source.width + sourceX) * 4
            const to = ((dy + y) * this.width + (dx + x)) * 4
            this.data[to] = source.pixels[from]
            this.data[to + 1] = source.pixels[from + 1]
            this.data[to + 2] = source.pixels[from + 2]
            this.data[to + 3] = 255
          }
        }
      },
      getImageData: () => ({
        data: this.data,
        width: this.width,
        height: this.height,
      }),
    }
    return this._context
  }
}

globalThis.OffscreenCanvas = FakeCanvas

const { signatureDistance, signatureOf } = await import('../src/utils/patchSignature.js')
const REARM_SIGNATURE_DIFF = 0.12

const WIDTH = 24
const HEIGHT = 24
const patch = valueAt => {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const value = valueAt(x, y)
      const i = (y * WIDTH + x) * 4
      pixels[i] = value
      pixels[i + 1] = value
      pixels[i + 2] = value
      pixels[i + 3] = 255
    }
  }
  return { width: WIDTH, height: HEIGHT, pixels }
}

const base = patch((x, y) => (x * 7 + y * 11) % 256)
const inverse = patch((x, y) => 255 - ((x * 7 + y * 11) % 256))
const noisy = patch((x, y) => {
  const value = ((x * 7 + y * 11) % 256) + ((x + y) % 2 ? 2 : -2)
  return Math.max(0, Math.min(255, value))
})

const baseSignature = signatureOf(base, 0, 0, WIDTH, HEIGHT)
assert.equal(
  signatureDistance(baseSignature, signatureOf(base, 0, 0, WIDTH, HEIGHT)),
  0,
)
assert.ok(
  signatureDistance(baseSignature, signatureOf(inverse, 0, 0, WIDTH, HEIGHT))
    > REARM_SIGNATURE_DIFF,
)
assert.ok(
  signatureDistance(baseSignature, signatureOf(noisy, 0, 0, WIDTH, HEIGHT))
    < REARM_SIGNATURE_DIFF,
)

console.log('patch signature sanity check passed')
