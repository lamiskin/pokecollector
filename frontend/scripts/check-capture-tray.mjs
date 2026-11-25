// Checks for the capture-lab tray contract. These are the parts of the rotation
// and submission behaviour that are pure: no DOM, no React and no upload.
//
// The rail, the sheet and the camera loop consume exactly these helpers, so a
// failure here is a rotation or payload bug even when the UI looks plausible.
import {
  CAPTURE_GEOMETRY_SPACE,
  CAPTURE_GEOMETRY_VERSION,
  TRAY_CAPACITY,
  buildCaptureGeometry,
  buildTraySubmission,
  containedRotatedBox,
  cropQuadFromFrame,
  frameQuadFromCrop,
  geometryPayload,
  isQuarterTurn,
  isRailAtEnd,
  latestUnsentItem,
  nextRotationCW,
  normalizeRotation,
  railEdges,
  rotationPayload,
  sortTrayItems,
  rotationDegrees,
} from '../src/utils/captureTray.js'

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) {
    failures += 1
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const equal = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, `${a} !== ${e}`)
}

// ── Rotation cycling ───────────────────────────────────────────────────────
// Each tap is a clockwise quarter turn: 0 → 90 → 180 → 270 → 0. "No choice"
// starts at the photograph's own orientation, so its first tap is 90.
{
  let rotation = null
  const seen = []
  for (let tap = 0; tap < 5; tap += 1) {
    rotation = nextRotationCW(rotation)
    seen.push(rotation)
  }
  equal('a tap from no choice starts at 90 and cycles through 0', seen, [90, 180, 270, 0, 90])
  equal('explicit 0 advances to 90', nextRotationCW(0), 90)
  equal('270 wraps to explicit 0', nextRotationCW(270), 0)
  equal('invalid input behaves like no choice', nextRotationCW(45), 90)
  equal('normalize keeps explicit 0', normalizeRotation(0), 0)
  equal('normalize rejects a non-quarter turn', normalizeRotation(45), null)
  equal('normalize treats undefined as no choice', normalizeRotation(undefined), null)
  equal('a quarter turn is 90 or 270', [isQuarterTurn(90), isQuarterTurn(180), isQuarterTurn(270)], [true, false, true])
  equal('preview degrees never invent a rotation', [rotationDegrees(null), rotationDegrees(0)], [0, 0])
}

// ── Order is the staging sequence, nothing else ────────────────────────────
{
  const items = [
    { id: 'c', sequence: 3 },
    { id: 'a', sequence: 1 },
    { id: 'b', sequence: 2 },
  ]
  equal('items sort oldest first', sortTrayItems(items).map(item => item.id), ['a', 'b', 'c'])
  check('sorting does not mutate the caller', items[0].id === 'c')
  equal('capacity is fifty', TRAY_CAPACITY, 50)
}

// ── "Undo last" is by sequence, not by viewport ────────────────────────────
{
  const items = [
    { id: 'sent', sequence: 1, scanStatus: 'done' },
    { id: 'older', sequence: 2, scanStatus: 'idle' },
    { id: 'newest', sequence: 3, scanStatus: 'idle' },
    { id: 'uploading', sequence: 4, scanStatus: 'uploading' },
    { id: 'saving', sequence: 5, status: 'uploading' },
  ]
  equal('latest unsent skips sent and in-flight items', latestUnsentItem(items)?.id, 'newest')
  equal('latest unsent is null when everything is sent', latestUnsentItem([items[0]]), null)
}

// ── Submission snapshot ────────────────────────────────────────────────────
// Files and rotations come from one frozen array in sequence order; explicit 0
// survives, and a batch with no choices sends nothing extra.
{
  const allNull = buildTraySubmission([
    { id: 'b', sequence: 2, rotationCW: null, file: { name: 'b.jpg' } },
    { id: 'a', sequence: 1, rotationCW: null, file: { name: 'a.jpg' } },
  ])
  equal('files align with sequence order', allNull.files.map(file => file.name), ['a.jpg', 'b.jpg'])
  equal('no-choice rotations stay null', allNull.rotations, [null, null])
  check('no-choice batch has nothing to send', allNull.hasRotationChoice === false)
  check('snapshot is frozen', Object.isFrozen(allNull.items) && Object.isFrozen(allNull.items[0]))

  const mixed = buildTraySubmission([
    { id: 'c', sequence: 3, rotationCW: 270, file: { name: 'c.jpg' } },
    { id: 'a', sequence: 1, rotationCW: 0, file: { name: 'a.jpg' } },
    { id: 'b', sequence: 2, rotationCW: null, file: { name: 'b.jpg' } },
  ])
  equal('explicit 0 and null both survive', mixed.rotations, [0, null, 270])
  equal('ids come from the same snapshot', mixed.items.map(item => item.id), ['a', 'b', 'c'])
  check('explicit 0 counts as a choice', mixed.hasRotationChoice === true)
}

// ── Multipart field rules ──────────────────────────────────────────────────
{
  equal('all-no-choice omits the field', rotationPayload([null, null]), null)
  equal('undefined omits the field', rotationPayload([undefined]), null)
  equal('a non-array omits the field', rotationPayload('90'), null)
  equal('length mismatch omits the field', rotationPayload([90], 2), null)
  equal('an explicit 0 is still a choice', rotationPayload([0, null]), [0, null])
  equal('payload aligns with its files', rotationPayload([null, 90, 180], 3), [null, 90, 180])
  equal('invalid values become no choice', rotationPayload([45, null]), null)
  equal('JSON shape is a plain array', JSON.stringify(rotationPayload([null, 90], 2)), '[null,90]')
}

// ── Rail follow / edge state ───────────────────────────────────────────────
{
  check('a full strip is at the end', isRailAtEnd({ scrollLeft: 100, clientWidth: 300, scrollWidth: 400 }))
  check('a strip showing older cards is not at the end', !isRailAtEnd({ scrollLeft: 40, clientWidth: 300, scrollWidth: 400 }))
  equal('edges report both directions', railEdges({ scrollLeft: 40, clientWidth: 300, scrollWidth: 400 }), { left: true, right: true })
  equal('a strip with no overflow has no fades', railEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }), { left: false, right: false })
  equal('at the start only the right fade shows', railEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 400 }), { left: false, right: true })
}

// ── Rotated preview geometry ───────────────────────────────────────────────
// A portrait card at 90° must fit the frame with its contained dimensions
// swapped, so the preview does not clip the corners.
{
  const natural = { width: 630, height: 880 }
  const portrait = containedRotatedBox({
    ...natural, rotationCW: null, maxWidth: 360, maxHeight: 400,
  })
  check('portrait stays within the frame', portrait.width <= 360 && portrait.height <= 400)
  check('portrait keeps the image upright', portrait.imageWidth === portrait.width && portrait.imageHeight === portrait.height)

  const turned = containedRotatedBox({
    ...natural, rotationCW: 90, maxWidth: 360, maxHeight: 400,
  })
  check('the rotated box still fits', turned.width <= 360 && turned.height <= 400)
  check('the contained image dimensions swap at 90°',
    Math.abs((turned.imageWidth / turned.imageHeight) - (natural.width / natural.height)) < 1e-9)
  check('the rotated box keeps the card aspect',
    Math.abs((turned.width / turned.height) - (natural.height / natural.width)) < 1e-6)
  check('the rotated image fills the rotated box',
    Math.abs(turned.imageWidth - turned.height) < 1e-9
    && Math.abs(turned.imageHeight - turned.width) < 1e-9)
  equal('unknown dimensions have no geometry', containedRotatedBox({
    width: 0, height: 0, rotationCW: 90, maxWidth: 360, maxHeight: 400,
  }), null)
}

// ── Capture geometry provenance ────────────────────────────────────────────
// The crop-relative quad must survive the frozen submission in file order, and
// the payload rule must stay exactly as conservative as rotations: null entries
// align, and an all-null batch sends no field at all.
{
  const trackedRect = { x: 150, y: 250, width: 600, height: 700 }
  const trackedQuad = [
    [200.4, 300.7],
    [700.2, 310.1],
    [690.9, 900.3],
    [210.6, 890.8],
  ]
  const trackedGeometry = buildCaptureGeometry({
    quad: trackedQuad,
    cropRect: trackedRect,
    encodedWidth: 600,
    encodedHeight: 700,
    source: 'same-frame-track',
    modelScore: 0.061,
    modelAgeMs: 12,
    agreement: 0.02,
    pendingReanchor: false,
    frameEdgeMargin: 0.18,
    quadAspect: 0.716,
    paddingClipped: false,
  })

  check('geometry records its version and space',
    trackedGeometry.v === CAPTURE_GEOMETRY_VERSION
    && trackedGeometry.space === CAPTURE_GEOMETRY_SPACE)
  check('geometry is immutable once captured',
    Object.isFrozen(trackedGeometry) && Object.isFrozen(trackedGeometry.quad))
  equal('geometry keeps the encoded dimensions', [trackedGeometry.width, trackedGeometry.height], [600, 700])
  equal('geometry keeps the capture decision evidence', {
    source: trackedGeometry.source,
    modelScore: trackedGeometry.modelScore,
    modelAgeMs: trackedGeometry.modelAgeMs,
    agreement: trackedGeometry.agreement,
    pendingReanchor: trackedGeometry.pendingReanchor,
    frameEdgeMargin: trackedGeometry.frameEdgeMargin,
    quadAspect: trackedGeometry.quadAspect,
    paddingClipped: trackedGeometry.paddingClipped,
  }, {
    source: 'same-frame-track',
    modelScore: 0.061,
    modelAgeMs: 12,
    agreement: 0.02,
    pendingReanchor: false,
    frameEdgeMargin: 0.18,
    quadAspect: 0.716,
    paddingClipped: false,
  })
  check('the crop quad stays in 0..1', trackedGeometry.quad.every(
    ([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1,
  ))

  // The crop rect is integer and clamped to the frame exactly as acquireVideoFrame
  // returns it, including an edge-clamped box.
  const clampedRect = { x: 0, y: 0, width: 502, height: 705 }
  const clampedQuad = [[2, 3], [500, 5], [498, 700], [4, 690]]
  const clampedCrop = cropQuadFromFrame(clampedQuad, clampedRect)
  check('a frame-clamped rect still yields crop coords in 0..1', clampedCrop.every(
    ([u, v]) => u >= 0 && u <= 1 && v >= 0 && v <= 1,
  ))

  // Mapping the crop quad back into frame pixels must reproduce the exact quad
  // the capture used (within 1e-6), for both an interior and an edge-clamped rect.
  const roundTrip = (quad, rect) => {
    const crop = cropQuadFromFrame(quad, rect)
    const back = frameQuadFromCrop(crop, rect)
    return back.every(([x, y], index) => (
      Math.abs(x - quad[index][0]) <= 1e-6 && Math.abs(y - quad[index][1]) <= 1e-6
    ))
  }
  check('crop-relative mapping round-trips an interior quad', roundTrip(trackedQuad, trackedRect))
  check('crop-relative mapping round-trips an edge-clamped quad', roundTrip(clampedQuad, clampedRect))

  const submission = buildTraySubmission([
    { id: 'c', sequence: 3, rotationCW: 90, geometry: null, file: { name: 'c.jpg' } },
    { id: 'a', sequence: 1, rotationCW: null, geometry: trackedGeometry, file: { name: 'a.jpg' } },
    { id: 'b', sequence: 2, rotationCW: 0, geometry: null, file: { name: 'b.jpg' } },
  ])
  equal('geometry survives in the frozen file order', submission.geometries, [trackedGeometry, null, null])
  equal('geometries align with files', submission.geometries.length, submission.files.length)
  check('a null-geometry item keeps its null slot', submission.geometries[2] === null)
  check('the submission flags geometry only when one exists', submission.hasGeometry === true)

  const noGeometry = buildTraySubmission([
    { id: 'b', sequence: 2, geometry: null, file: { name: 'b.jpg' } },
    { id: 'a', sequence: 1, file: { name: 'a.jpg' } },
  ])
  equal('an unset or null geometry stages as null', noGeometry.geometries, [null, null])
  check('a batch with no frozen crop reports no geometry', noGeometry.hasGeometry === false)
}

// ── Capture geometry multipart field rules ────────────────
{
  const entry = { v: 1, space: 'crop-normalized', width: 10, height: 10, quad: [[0, 0], [1, 0], [1, 1], [0, 1]] }
  equal('an all-null batch omits the field', geometryPayload([null, null]), null)
  equal('undefined omits the field', geometryPayload([undefined]), null)
  equal('a non-array omits the field', geometryPayload(entry), null)
  equal('length mismatch omits the field', geometryPayload([entry], 2), null)
  equal('a single entry still sends its array', geometryPayload([entry], 1), [entry])
  equal('null slots align with their files', geometryPayload([null, entry], 2), [null, entry])
  equal('JSON shape is a plain aligned array', JSON.stringify(geometryPayload([null, entry], 2)).startsWith('[null,{'), true)
}

if (failures) {
  console.error(`${failures} capture tray check(s) failed`)
  process.exit(1)
}
console.log('capture tray sanity check passed')
