// Mapping between frame-normalised corners and a refine crop.
//
// A refine crop is described in frame pixels plus the frame size, so mapping
// does not depend on the cropped bitmap's own resolution. Keeping the mapping
// here makes the worker and page agree exactly.

export function paddedCropRect(corners, frame, padding = 0.12) {
  if (!corners || corners.length !== 4 || !frame?.width || !frame?.height) return null
  const xs = corners.map(([x]) => x * frame.width)
  const ys = corners.map(([, y]) => y * frame.height)
  const boxWidth = Math.max(1, Math.max(...xs) - Math.min(...xs))
  const boxHeight = Math.max(1, Math.max(...ys) - Math.min(...ys))
  const padX = boxWidth * padding
  const padY = boxHeight * padding
  const left = Math.max(0, Math.min(frame.width - 1, Math.min(...xs) - padX))
  const top = Math.max(0, Math.min(frame.height - 1, Math.min(...ys) - padY))
  const right = Math.max(left + 1, Math.min(frame.width, Math.max(...xs) + padX))
  const bottom = Math.max(top + 1, Math.min(frame.height, Math.max(...ys) + padY))
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    frameWidth: frame.width,
    frameHeight: frame.height,
  }
}

export function cropPointToFrame(point, cropRect) {
  if (!point || !cropRect) return null
  return [
    (cropRect.x + point[0] * cropRect.width) / cropRect.frameWidth,
    (cropRect.y + point[1] * cropRect.height) / cropRect.frameHeight,
  ]
}

export function framePointToCrop(point, cropRect) {
  if (!point || !cropRect) return null
  return [
    ((point[0] * cropRect.frameWidth) - cropRect.x) / cropRect.width,
    ((point[1] * cropRect.frameHeight) - cropRect.y) / cropRect.height,
  ]
}

export function cropQuadToFrame(quad, cropRect) {
  if (!quad || quad.length !== 4) return null
  return quad.map(point => cropPointToFrame(point, cropRect))
}

export function frameQuadToCrop(quad, cropRect) {
  if (!quad || quad.length !== 4) return null
  return quad.map(point => framePointToCrop(point, cropRect))
}
