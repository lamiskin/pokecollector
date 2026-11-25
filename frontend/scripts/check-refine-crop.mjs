// Sanity checks for frame <-> refine-crop mapping.
import assert from 'node:assert/strict'
import {
  cropQuadToFrame,
  frameQuadToCrop,
  paddedCropRect,
} from '../src/utils/refineCrop.js'

const frame = { width: 1920, height: 2160 }
const quad = [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]]
const crop = paddedCropRect(quad, frame, 0.12)
assert.ok(crop)
const local = frameQuadToCrop(quad, crop)
const roundTrip = cropQuadToFrame(local, crop)
for (let i = 0; i < 4; i += 1) {
  assert.ok(Math.abs(roundTrip[i][0] - quad[i][0]) < 1e-6)
  assert.ok(Math.abs(roundTrip[i][1] - quad[i][1]) < 1e-6)
}
assert.ok(crop.x > 0 && crop.y > 0)

const edgeQuad = [[0.0, 0.1], [0.3, 0.1], [0.3, 0.4], [0.0, 0.4]]
const edgeCrop = paddedCropRect(edgeQuad, frame, 0.12)
assert.equal(edgeCrop.x, 0)
const edgeRoundTrip = cropQuadToFrame(frameQuadToCrop(edgeQuad, edgeCrop), edgeCrop)
for (let i = 0; i < 4; i += 1) {
  assert.ok(Math.abs(edgeRoundTrip[i][0] - edgeQuad[i][0]) < 1e-6)
  assert.ok(Math.abs(edgeRoundTrip[i][1] - edgeQuad[i][1]) < 1e-6)
}

console.log('refine crop sanity check passed')
