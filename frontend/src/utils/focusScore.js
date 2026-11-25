// Pixel-level focus proxy for capture diagnostics. Annotation only: this is not
// a gate, and its scale is not the backend's calibrated 500 threshold.

// Convert RGBA ImageData-like input to a flat grayscale array.
export function toGrayscale(imageData) {
  const { data, width, height } = imageData
  const gray = new Float32Array(width * height)
  for (let pixel = 0, i = 0; pixel < gray.length; pixel += 1, i += 4) {
    gray[pixel] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
  }
  return { data: gray, width, height }
}

// Variance of the 4-neighbour Laplacian over interior pixels. The outer ring is
// skipped because its neighbours do not exist.
export function edgeVariance(gray, width, height) {
  if (!gray || width < 3 || height < 3) return 0
  let sum = 0
  let sumSquares = 0
  let count = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      const laplacian = gray[index - width]
        + gray[index + width]
        + gray[index - 1]
        + gray[index + 1]
        - 4 * gray[index]
      sum += laplacian
      sumSquares += laplacian * laplacian
      count += 1
    }
  }
  if (count === 0) return 0
  const mean = sum / count
  return sumSquares / count - mean * mean
}
