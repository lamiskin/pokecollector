// Perspective correction for card crops. Pure functions, no React or DOM
// dependencies beyond ImageData, so this can be exercised in tests and reused
// by the live overlay / scan flow.
//
// computeHomography maps target-rectangle points to their source-quad points;
// warpQuad uses it to sample the full-resolution frame bilinearly.

const EPSILON = 1e-10

function solveLinearSystem(matrix, vector) {
  const size = vector.length
  const work = matrix.map((row, index) => [...row, vector[index]])
  for (let col = 0; col < size; col += 1) {
    let pivot = col
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(work[row][col]) > Math.abs(work[pivot][col])) pivot = row
    }
    if (Math.abs(work[pivot][col]) < EPSILON) {
      throw new Error('Degenerate quad: the homography has no solution')
    }
    if (pivot !== col) [work[pivot], work[col]] = [work[col], work[pivot]]
    const divisor = work[col][col]
    for (let k = col; k <= size; k += 1) work[col][k] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === col) continue
      const factor = work[row][col]
      if (!factor) continue
      for (let k = col; k <= size; k += 1) work[row][k] -= factor * work[col][k]
    }
  }
  return work.map(row => row[size])
}

function applyHomography(homography, x, y) {
  const w = homography[2][0] * x + homography[2][1] * y + homography[2][2]
  if (!w) return null
  return [
    (homography[0][0] * x + homography[0][1] * y + homography[0][2]) / w,
    (homography[1][0] * x + homography[1][1] * y + homography[1][2]) / w,
  ]
}

export function computeHomography(target, source) {
  if (!Array.isArray(target) || !Array.isArray(source)
    || target.length !== 4 || source.length !== 4) {
    throw new Error('computeHomography needs four target and four source points')
  }
  const matrix = []
  const vector = []
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = target[i]
    const [u, v] = source[i]
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    vector.push(u)
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    vector.push(v)
  }
  const h = solveLinearSystem(matrix, vector)
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ]
}

// Quad area as a fraction of the normalised frame, for the size gate.
export function quadAreaFraction(corners) {
  if (!corners || corners.length !== 4) return 0
  let area = 0
  for (let i = 0; i < corners.length; i += 1) {
    const [x1, y1] = corners[i]
    const [x2, y2] = corners[(i + 1) % corners.length]
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area) * 0.5
}

// Push each normalised corner away from the quad centroid so a quad that sits a
// little inside the card still samples the card's edge. The cost is a sliver of
// background, which is preferable to clipping the card; coordinates are clamped
// to the frame so the homography never samples outside it.
export function outsetCorners(corners, fraction = 0.015) {
  if (!corners || corners.length !== 4) return corners
  const cx = corners.reduce((sum, [x]) => sum + x, 0) / 4
  const cy = corners.reduce((sum, [, y]) => sum + y, 0) / 4
  const diagonal = Math.max(
    Math.hypot(corners[0][0] - corners[2][0], corners[0][1] - corners[2][1]),
    Math.hypot(corners[1][0] - corners[3][0], corners[1][1] - corners[3][1]),
  )
  const distance = fraction * diagonal
  return corners.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    const length = Math.hypot(dx, dy) || 1
    return [
      Math.min(1, Math.max(0, x + (dx / length) * distance)),
      Math.min(1, Math.max(0, y + (dy / length) * distance)),
    ]
  })
}

function insetQuad(corners, inset) {
  const cx = corners.reduce((sum, [x]) => sum + x, 0) / corners.length
  const cy = corners.reduce((sum, [, y]) => sum + y, 0) / corners.length
  return corners.map(([x, y]) => [x + (cx - x) * inset, y + (cy - y) * inset])
}

/**
 * Rectify `quad` (source pixel coordinates, 4 points) into a target-size
 * ImageData. `inset` is the fraction each corner moves toward the quad centre
 * (1.5% per side by default) so a slightly loose quad does not sample a sliver
 * of sleeve or background.
 */
export function warpQuad(sourceImageData, quad, targetWidth, targetHeight, inset = 0.015) {
  const sourceWidth = sourceImageData?.width
  const sourceHeight = sourceImageData?.height
  const source = sourceImageData?.data
  if (!source || !sourceWidth || !sourceHeight) {
    throw new Error('warpQuad needs source ImageData')
  }
  if (!(targetWidth > 0) || !(targetHeight > 0)) {
    throw new Error('warpQuad needs positive target dimensions')
  }
  if (!quad || quad.length !== 4) {
    throw new Error('warpQuad needs four source points')
  }

  const shrunk = insetQuad(quad, inset)
  const target = [[0, 0], [targetWidth, 0], [targetWidth, targetHeight], [0, targetHeight]]
  const homography = computeHomography(target, shrunk)
  const output = new Uint8ClampedArray(targetWidth * targetHeight * 4)
  const maxX = sourceWidth - 1
  const maxY = sourceHeight - 1

  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      // Sample at the target pixel centre so pixels are not half-shifted.
      const point = applyHomography(homography, x + 0.5, y + 0.5)
      if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        throw new Error('Homography produced a non-finite sample')
      }
      const u = Math.min(Math.max(point[0], 0), maxX)
      const v = Math.min(Math.max(point[1], 0), maxY)
      const x0 = Math.floor(u)
      const y0 = Math.floor(v)
      const x1 = Math.min(x0 + 1, maxX)
      const y1 = Math.min(y0 + 1, maxY)
      const fx = u - x0
      const fy = v - y0
      const topLeft = (y0 * sourceWidth + x0) * 4
      const topRight = (y0 * sourceWidth + x1) * 4
      const bottomLeft = (y1 * sourceWidth + x0) * 4
      const bottomRight = (y1 * sourceWidth + x1) * 4
      const out = (y * targetWidth + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const top = source[topLeft + channel] * (1 - fx) + source[topRight + channel] * fx
        const bottom = source[bottomLeft + channel] * (1 - fx) + source[bottomRight + channel] * fx
        output[out + channel] = top * (1 - fy) + bottom * fy
      }
    }
  }
  return new ImageData(output, targetWidth, targetHeight)
}
