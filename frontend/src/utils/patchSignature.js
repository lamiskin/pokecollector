// Small appearance signature used to tell "same card nudged" from "a different
// card was placed". Geometry cannot answer that; a coarse luma thumbnail can.
//
// The signature is zero-mean, unit-mean-absolute-deviation luma, so it is
// insensitive to exposure and to the exact box size, but changes when the card
// artwork changes.

let canvas = null
let context = null

function targetCanvas(size) {
  if (!canvas) {
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(size, size)
    else if (typeof document !== 'undefined') canvas = document.createElement('canvas')
    else return null
  }
  if (canvas.width !== size) canvas.width = size
  if (canvas.height !== size) canvas.height = size
  if (!context) context = canvas.getContext('2d', { willReadFrequently: true })
  return context ? canvas : null
}

// Draw `source`'s rectangle into a size×size thumbnail and return its normalised
// luma. Returns null when the rectangle or the canvas is unusable.
export function signatureOf(source, sx, sy, sw, sh, size = 12) {
  if (!source || !(sw > 0) || !(sh > 0)) return null
  const target = targetCanvas(size)
  if (!target) return null
  context.clearRect(0, 0, size, size)
  context.drawImage(source, sx, sy, sw, sh, 0, 0, size, size)
  const { data } = context.getImageData(0, 0, size, size)
  const luma = new Float32Array(size * size)
  let sum = 0
  for (let pixel = 0, i = 0; pixel < luma.length; pixel += 1, i += 4) {
    const value = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    luma[pixel] = value
    sum += value
  }
  const mean = sum / luma.length
  let deviation = 0
  for (let i = 0; i < luma.length; i += 1) {
    luma[i] -= mean
    deviation += Math.abs(luma[i])
  }
  deviation /= luma.length
  const scale = deviation > 1e-6 ? 1 / deviation : 0
  for (let i = 0; i < luma.length; i += 1) luma[i] *= scale
  return luma
}

// Mean absolute difference between two signatures.
export function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return Infinity
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i])
  return total / a.length
}
