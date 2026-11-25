// Checks for the capture-lab tray contract. These are the parts of the rotation
// and submission behaviour that are pure: no DOM, no React and no upload.
//
// The rail, the sheet and the camera loop consume exactly these helpers, so a
// failure here is a rotation or payload bug even when the UI looks plausible.
import {
  TRAY_CAPACITY,
  buildTraySubmission,
  containedRotatedBox,
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

if (failures) {
  console.error(`${failures} capture tray check(s) failed`)
  process.exit(1)
}
console.log('capture tray sanity check passed')
