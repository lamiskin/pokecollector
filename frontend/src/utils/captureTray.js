// Capture-lab tray contract.
//
// Everything here is pure so the tray rail, the inspection sheet and the scan
// submission can share one definition of order, rotation and capacity. None of
// it reads recognition, upload or decode state: an item's place in the tray is
// its immutable staging sequence.
//
// Pure enough to run without a DOM, and covered by scripts/check-capture-tray.mjs.

export const TRAY_CAPACITY = 50
export const ROTATION_STEP = 90
const ROTATIONS = [0, 90, 180, 270]

// null = no choice (correct as photographed, but deliberately untouched);
// 0 is an explicit "this orientation is right" and must survive to the server.
export function normalizeRotation(value) {
  return ROTATIONS.includes(value) ? value : null
}

// One tap is always a quarter turn clockwise. "No choice" starts from the
// photograph's own orientation, so the visible sequence is 90 → 180 → 270 → 0.
export function nextRotationCW(current) {
  const base = normalizeRotation(current)
  return ((base == null ? 0 : base) + ROTATION_STEP) % 360
}

export function rotationDegrees(rotationCW) {
  return normalizeRotation(rotationCW) ?? 0
}

export function isQuarterTurn(rotationCW) {
  const value = normalizeRotation(rotationCW)
  return value === 90 || value === 270
}

// First presented on the left, newest on the right. Sorting never mutates the
// caller's array and never looks at anything but `sequence`.
export function sortTrayItems(items) {
  return [...(items || [])].sort(
    (a, b) => (a?.sequence ?? 0) - (b?.sequence ?? 0),
  )
}

// "Undo last" removes the latest unsent item by identity, not the card nearest
// whatever the collector happens to be looking at. Sent items and items already
// on the wire are skipped.
export function latestUnsentItem(items) {
  let best = null
  for (const item of items || []) {
    if (!item) continue
    if (item.scanStatus === 'done' || item.scanStatus === 'uploading') continue
    if (item.status === 'uploading') continue
    if (!best || (item.sequence ?? 0) > (best.sequence ?? 0)) best = item
  }
  return best
}

// One frozen snapshot is the only source for files, rotations, geometry and
// item ids in a submission. Callers must not rebuild any of them from visible
// indices.
export function buildTraySubmission(items) {
  const snapshot = Object.freeze(
    sortTrayItems(items).map(item => Object.freeze({
      id: item.id,
      file: item.file,
      sequence: item.sequence,
      rotationCW: normalizeRotation(item.rotationCW),
      geometry: item.geometry ?? null,
    })),
  )
  const rotations = snapshot.map(item => item.rotationCW)
  const geometries = snapshot.map(item => item.geometry)
  return {
    items: snapshot,
    files: snapshot.map(item => item.file),
    rotations,
    geometries,
    hasRotationChoice: rotations.some(value => value !== null),
    hasGeometry: geometries.some(value => value != null),
  }
}

// ── Capture geometry provenance ─────────────────────────────────────────────
// A capture's crop is frozen when the frame is acquired: the padded, integer,
// frame-clamped source rect and the quad that produced it travel together. The
// quad is stored relative to that encoded crop, so a later overlay update, a
// different frame or the tray's visible order can never move it.
export const CAPTURE_GEOMETRY_VERSION = 1
export const CAPTURE_GEOMETRY_SPACE = 'crop-normalized'

const clampUnit = value => Math.min(1, Math.max(0, value))

// Frame-normalized quad -> crop-relative quad, using the same integer rect the
// capture encoded. Points are clamped to the crop so the contract's 0..1 range
// holds even for a corner the video frame itself cut off.
export function cropQuadFromFrame(quad, rect) {
  if (!Array.isArray(quad) || quad.length !== 4) return null
  if (!rect) return null
  const { x, y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (!(width > 0) || !(height > 0)) return null
  const points = []
  for (const point of quad) {
    if (!Array.isArray(point) || point.length !== 2) return null
    const [px, py] = point
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null
    points.push([
      clampUnit((px - x) / width),
      clampUnit((py - y) / height),
    ])
  }
  return points
}

// Inverse of cropQuadFromFrame, in the crop rect's own pixel space. Exported so
// the provenance check can prove the mapping round-trips.
export function frameQuadFromCrop(cropQuad, rect) {
  if (!Array.isArray(cropQuad) || cropQuad.length !== 4) return null
  if (!rect) return null
  const { x, y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite)) return null
  return cropQuad.map(([u, v]) => [x + u * width, y + v * height])
}

// Evidence comes from the same decision and the same acquisition that produced
// the capture; a caller must not fill these from the live overlay afterwards.
export function buildCaptureGeometry({
  quad,
  cropRect,
  encodedWidth,
  encodedHeight,
  source,
  modelScore = null,
  modelAgeMs = null,
  agreement = null,
  pendingReanchor = false,
  frameEdgeMargin = null,
  quadAspect = null,
  paddingClipped = false,
} = {}) {
  const cropQuad = cropQuadFromFrame(quad, cropRect)
  if (!cropQuad) return null
  const width = Math.round(Number(encodedWidth))
  const height = Math.round(Number(encodedHeight))
  if (!(width > 0) || !(height > 0)) return null
  return Object.freeze({
    v: CAPTURE_GEOMETRY_VERSION,
    space: CAPTURE_GEOMETRY_SPACE,
    width,
    height,
    quad: Object.freeze(cropQuad.map(point => Object.freeze(point))),
    source,
    modelScore,
    modelAgeMs,
    agreement,
    pendingReanchor: Boolean(pendingReanchor),
    frameEdgeMargin,
    quadAspect,
    paddingClipped: Boolean(paddingClipped),
  })
}

// The multipart field is omitted entirely when every item is "no choice", so a
// batch from today's path sends exactly the fields it always did.
export function rotationPayload(rotations, expectedLength = null) {
  if (!Array.isArray(rotations)) return null
  const normalized = rotations.map(normalizeRotation)
  if (expectedLength != null && normalized.length !== expectedLength) return null
  return normalized.some(value => value !== null) ? normalized : null
}

// Same rule for `capture_geometry`: aligned with the uploaded files, `null` for
// a photo without a frozen crop, and the whole field omitted when every entry
// is null (gallery/manual uploads).
export function geometryPayload(geometries, expectedLength = null) {
  if (!Array.isArray(geometries)) return null
  if (expectedLength != null && geometries.length !== expectedLength) return null
  if (!geometries.some(entry => entry != null)) return null
  return geometries.map(entry => entry ?? null)
}

export function isRailAtEnd({ scrollLeft, clientWidth, scrollWidth }, tolerance = 2) {
  if (!(clientWidth >= 0) || !(scrollWidth >= 0)) return true
  return scrollLeft + clientWidth >= scrollWidth - tolerance
}

export function railEdges({ scrollLeft, clientWidth, scrollWidth }, tolerance = 1) {
  return {
    left: scrollLeft > tolerance,
    right: scrollLeft + clientWidth < scrollWidth - tolerance,
  }
}

// Size of the rotated bounding box, and the unrotated image size that fills it.
// At 90°/270° the contained dimensions swap, so the preview is never clipped by
// the portrait aspect of a card.
export function containedRotatedBox({
  width,
  height,
  rotationCW,
  maxWidth,
  maxHeight,
}) {
  const naturalWidth = Number(width)
  const naturalHeight = Number(height)
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null
  if (!(maxWidth > 0) || !(maxHeight > 0)) return null

  const rotated = isQuarterTurn(rotationCW)
  const visualAspect = rotated
    ? naturalHeight / naturalWidth
    : naturalWidth / naturalHeight

  let boxWidth = maxWidth
  let boxHeight = boxWidth / visualAspect
  if (boxHeight > maxHeight) {
    boxHeight = maxHeight
    boxWidth = boxHeight * visualAspect
  }
  return {
    width: boxWidth,
    height: boxHeight,
    imageWidth: rotated ? boxHeight : boxWidth,
    imageHeight: rotated ? boxWidth : boxHeight,
    rotated,
  }
}
