// Sanity checks for the annotation-only capture focus proxy.
// Run with: node scripts/check-focus-score.mjs

import assert from 'node:assert/strict'

import { edgeVariance, toGrayscale } from '../src/utils/focusScore.js'

function imageData(pixel) {
  const width = 32
  const height = 32
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = pixel(x, y)
      const index = (y * width + x) * 4
      data[index] = value
      data[index + 1] = value
      data[index + 2] = value
      data[index + 3] = 255
    }
  }
  return { data, width, height }
}

// Flat grey has no Laplacian response anywhere.
{
  const gray = toGrayscale(imageData(() => 128))
  assert.equal(edgeVariance(gray.data, gray.width, gray.height), 0)
}

// A step edge has strong response at the boundary, so variance is clearly > 0.
{
  const gray = toGrayscale(imageData(x => (x < 16 ? 0 : 255)))
  assert.ok(edgeVariance(gray.data, gray.width, gray.height) > 100)
}

console.log('focus score sanity check passed')
