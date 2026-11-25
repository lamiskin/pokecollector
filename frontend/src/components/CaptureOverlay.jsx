import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createQuadSmoother, QUAD_GLIDE_MS } from '../utils/quadSmoothing'

/**
 * Capture overlay for the live view: the corner ring, its hold progress and the
 * status pill that sits over the video.
 *
 * Timing contract (ported from the approved mockup):
 *  - the fill runs off `performance.now() - holdStartedAt`, so it is continuous;
 *  - a 200 ms ticker samples that clock and may only correct it *forward*, so a
 *    coarse sample never becomes a visible step and a jittery one never pulls
 *    the ring backwards;
 *  - capture is a 1100 ms beat inside the component; the caller just drops the
 *    phase afterwards.
 *
 * Geometry arrives through the imperative `setQuad` handle because the tracker
 * writes a new quad every animation frame: routing that through props would
 * re-render the whole page 30 times a second. `quad` is supported for callers
 * that prefer a declarative value.
 *
 * Draw-time adjustments live in here and nowhere else: the quad passes through
 * an adaptive low-pass (utils/quadSmoothing) so tracker noise does not shiver
 * on screen and a re-locked card glides instead of teleporting, and the rest of
 * the picture is blurred behind a mask that is the inverse of the quad once the
 * detector has settled on the card. Both are presentation only — the raw quad
 * is what the page captures, corroborates and records.
 *
 * The confirmation pulse from the page is a confidence signal, not a state: it
 * feeds one eased `lockStrength` that the ring's appearance follows, so the
 * outline settles onto the card and stays settled instead of alternating
 * between the solid and dashed styles at the detection rate.
 */

// Mirrors frontend/tailwind.config.js so the ring paints with the app palette.
const GOLD = '#f5c842'
const GREEN = '#22c55e'
const TRACK = '#a0a0b8'

const TICK_MS = 200
const CONFIRM_MS = 520
// The capture beat is a settle, not a flash: longer than the confirmation pulse.
const CAPTURE_BEAT_MS = 1100
const DRAIN_MS = 380
// How long the ring takes to settle onto a confirmed card, and to relax off it
// again. Rising is quicker than relaxing so a detection reads as a decision and
// a missed confirmation reads as a release, not a snap.
const LOCK_RISE_MS = 340
const LOCK_RELAX_MS = 700
// The ring is pushed this far outside the detected edge so it never paints over
// the card's own artwork or text, which the user is still judging.
const OUTSET = 3.4
const MIN_CARD_AREA = 0.12

// Once the detector has settled on the card the picture outside it is blurred
// instead of merely darkened, so the card is the only thing in focus; the blur
// means "I have your card" and holds for as long as that is true. The layer is
// a backdrop filter over the video, masked and clipped by the inverse of the quad.
const BLUR_PX = 7
// Long enough to read as a deliberate change of focus, short enough that it has
// landed by the time the ring has finished settling.
const BLUR_FADE_IN_MS = 430
const BLUR_FADE_OUT_MS = 520
// A lost/none phase must persist this long before the blur releases, so a
// one-frame blip cannot toggle it. captured/tooSmall release immediately.
const BLUR_RELEASE_HOLD_MS = 350
// Kept sharp outside the detected edge so the card's own border is not eaten by
// the blur boundary. The ring sits at OUTSET, inside this margin.
const BLUR_HOLE_MARGIN = 9
const BLUR_CLIP_ID = 'capture-overlay-blur-hole'
// The hole is a mask (alpha, the inverse of the quad). Chromium drops an
// element clip-path on a backdrop filter when an ancestor clips to a rounded
// box, which is exactly the video wrapper, so the mask is what actually paints;
// the clip-path is kept for engines that do honour it. Rebuilding the mask is
// only worth it once the hole has visibly moved.
const BLUR_MASK_STEP_PX = 0.35

function supportsBlurHole() {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  const blur = CSS.supports('backdrop-filter', 'blur(4px)')
    || CSS.supports('-webkit-backdrop-filter', 'blur(4px)')
  // Without a hole the layer would blur the card as well, so the frame has to be
  // there before the blur is used at all.
  const hole = CSS.supports('mask-image', 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")')
    || CSS.supports('-webkit-mask-image', 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")')
    || CSS.supports('clip-path', `url(#${BLUR_CLIP_ID})`)
  return Boolean(blur && hole)
}

const COPY = {
  none: 'Point the camera at a card',
  tracking: 'Hold the card steady',
  holding: 'Hold steady',
  lost: 'Hold the card steady',
  tooSmall: 'Move closer',
  captured: 'Captured',
}

// Pill chrome per state; the numbers are the mockup's.
const TONE = {
  none: { color: '#a0a0b8', border: 'rgba(255,255,255,.10)', bg: 'rgba(9,9,16,.74)', opacity: 0.42 },
  tracking: { color: '#a0a0b8', border: 'rgba(255,255,255,.10)', bg: 'rgba(9,9,16,.74)', opacity: 1 },
  holding: { color: GOLD, border: 'rgba(245,200,66,.35)', bg: 'rgba(18,14,6,.82)', opacity: 1 },
  lost: { color: '#a0a0b8', border: 'rgba(255,255,255,.10)', bg: 'rgba(9,9,16,.74)', opacity: 1 },
  tooSmall: { color: GOLD, border: 'rgba(245,200,66,.22)', bg: 'rgba(9,9,16,.74)', opacity: 1 },
  captured: { color: GREEN, border: 'rgba(34,197,94,.45)', bg: 'rgba(5,20,10,.82)', opacity: 1 },
}

const SHOW_BAR = { holding: true, lost: true }

const ANNOUNCE = {
  locked: 'Card detected. Hold steady.',
  tooSmall: 'Card is too far away. Move closer.',
  captured: 'Card captured.',
}

const easeOutCubic = t => 1 - (1 - t) ** 3
const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value)

function toPath(points) {
  return `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`
}

// Outward offset from the centroid: a rectangle gets a bit more than `distance`
// at the corners, which is what reads as a constant-looking gap.
function outset(points, distance) {
  const cx = (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4
  const cy = (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4
  const ring = points.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    const length = Math.hypot(dx, dy) || 1
    return [x + (dx / length) * distance, y + (dy / length) * distance]
  })
  return { ring, cx, cy }
}

function segmentsOf(points) {
  const segments = []
  let total = 0
  for (let index = 0; index < 4; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % 4]
    const length = Math.hypot(end[0] - start[0], end[1] - start[1])
    segments.push({ start, end, length })
    total += length
  }
  return { segments, total }
}

function pointAt(segments, distance) {
  let remaining = distance
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (remaining <= segment.length) {
      const ratio = segment.length ? remaining / segment.length : 0
      return [
        segment.start[0] + (segment.end[0] - segment.start[0]) * ratio,
        segment.start[1] + (segment.end[1] - segment.start[1]) * ratio,
      ]
    }
    remaining -= segment.length
  }
  return segments[segments.length - 1].end
}

const CaptureOverlay = forwardRef(function CaptureOverlay({
  quad = null,
  phase,
  tracked = false,
  confirmed = false,
  holdStartedAt,
  holdDurationMs = 1200,
  tooSmall = false,
  cardArea,
  pendingCount = 0,
  softFocus = true,
  reason = null,
}, ref) {
  const quadRef = useRef(quad)
  const [hasQuad, setHasQuad] = useState(Boolean(quad))
  const hasQuadRef = useRef(Boolean(quad))

  const svgRef = useRef(null)
  const blurRef = useRef(null)
  const blurClipRef = useRef(null)
  const dimRef = useRef(null)
  const ghostRef = useRef(null)
  const underRef = useRef(null)
  const baseRef = useRef(null)
  const trackRef = useRef(null)
  const ringRef = useRef(null)
  const glowRef = useRef(null)
  const progRef = useRef(null)
  const tipRef = useRef(null)
  const tipHaloRef = useRef(null)
  const bloomRef = useRef(null)
  const hintWrapRef = useRef(null)
  const hintRefs = useRef([])
  const barFillRef = useRef(null)
  const segRefs = useRef([])

  const [announcement, setAnnouncement] = useState('')
  const announceTimerRef = useRef(null)

  const sizeRef = useRef({ width: 0, height: 0 })
  // Preallocated so the paint loop does not build four fresh pairs per frame.
  const pixelRef = useRef([[0, 0], [0, 0], [0, 0], [0, 0]])
  const smootherRef = useRef(null)
  const blurMaskRef = useRef({ corners: null, width: 0, height: 0 })
  // The tracker writes a fresh quad every frame; a stamp is cheaper than
  // comparing eight coordinates and tells the paint loop when to filter.
  const quadStampRef = useRef(0)
  const quadArrivalRef = useRef(0)
  const paintedStampRef = useRef(-1)
  const lastArrivalRef = useRef(0)
  const [blurSupported] = useState(supportsBlurHole)
  const blankRef = useRef(false)
  const reducedRef = useRef(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  const animRef = useRef({
    phase: 'none',
    progress: 0,
    draining: false,
    holdStart: 0,
    beatStart: 0,
    drainFrom: 0,
    drainStart: 0,
    // 0 = dashed and following, 1 = settled on the card, in between = moving
    // between the two. This is the only thing that decides the ring's style.
    lock: 0,
    lockFrom: 0,
    lockTo: 0,
    lockStart: 0,
    // The blur latches on a confirmation and stays while the card is followed.
    blurWanted: false,
    blur: 0,
    blurFrom: 0,
    blurTo: 0,
    blurStart: 0,
    blurReleaseAt: 0,
    blurShown: -1,
  })

  const ticks = Math.max(1, Math.round(holdDurationMs / TICK_MS))

  // ── reduced motion ──────────────────────────────────────────────────────
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = event => {
      reducedRef.current = event.matches
      setReducedMotion(event.matches)
      // The quad still smooths, it just stops gliding: a re-lock lands where
      // the new geometry is.
      smootherRef.current?.setGlideMs(event.matches ? 0 : QUAD_GLIDE_MS)
    }
    reducedRef.current = media.matches
    setReducedMotion(media.matches)
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  // ── geometry input ──────────────────────────────────────────────────────
  // The raw quad is stored untouched: smoothing happens in the paint loop, so
  // the page keeps handing this same geometry to capture, the hold rule and
  // diagnostics. The stamp lets the paint loop filter each sample exactly once.
  const writeQuad = useCallback(corners => {
    const next = Array.isArray(corners) && corners.length === 4 ? corners : null
    quadRef.current = next
    quadStampRef.current += 1
    if (next) quadArrivalRef.current = performance.now()
    const present = Boolean(next)
    if (present !== hasQuadRef.current) {
      hasQuadRef.current = present
      setHasQuad(present)
    }
  }, [])

  const setQuad = writeQuad

  useImperativeHandle(ref, () => ({ setQuad }), [setQuad])

  useEffect(() => {
    writeQuad(quad)
  }, [quad, writeQuad])

  // ── which state is on screen ────────────────────────────────────────────
  const isTooSmall = tooSmall
    || phase === 'tooSmall'
    || (Number.isFinite(cardArea) && cardArea > 0 && cardArea < MIN_CARD_AREA)

  let visual = 'none'
  if (phase === 'captured') visual = 'captured'
  else if (phase === 'lost') visual = 'lost'
  else if (phase === 'tooSmall') visual = 'tooSmall'
  else if (phase === 'holding') visual = 'holding'
  else if (phase === 'locked' || phase === 'tracking') visual = phase
  else if (phase === 'none') visual = 'none'
  else if (hasQuad) {
    if (isTooSmall) visual = 'tooSmall'
    else if (tracked) visual = 'tracking'
    else if (confirmed) visual = 'locked'
    else visual = 'tracking'
  }

  // ── phase handoff into the animation ────────────────────────────────────
  useEffect(() => {
    const anim = animRef.current
    if (visual === 'holding') {
      anim.progress = 0
      anim.draining = false
      anim.holdStart = Number.isFinite(holdStartedAt) ? holdStartedAt : performance.now()
    } else if (visual === 'captured') {
      anim.progress = 1
      anim.draining = false
      anim.beatStart = performance.now()
    } else if (visual === 'lost' || (anim.phase === 'holding' && anim.progress > 0.02)) {
      // The card moved, or the tracker dropped it mid-hold: collapse the fill
      // over DRAIN_MS instead of snapping back to zero.
      anim.drainFrom = anim.progress
      anim.drainStart = performance.now()
      anim.draining = true
    } else {
      anim.progress = 0
      anim.draining = false
    }
    anim.phase = visual
  }, [visual, holdStartedAt])

  // ── the 200 ms sampler ──────────────────────────────────────────────────
  // It reports progress and corrects a lagging clock; it never drives the fill.
  useEffect(() => {
    if (visual !== 'holding') return undefined
    const timer = window.setInterval(() => {
      const anim = animRef.current
      if (anim.phase !== 'holding') return
      const elapsed = performance.now() - anim.holdStart
      const sample = Math.round(clamp01(elapsed / holdDurationMs) * ticks) / ticks
      if (sample > anim.progress + 1 / ticks / 2) {
        // Only a lagging clock is corrected: a fill that jumps backwards reads
        // as a glitch, a fill that lags for 60 ms does not.
        anim.holdStart -= (sample - anim.progress) * holdDurationMs
      }
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [visual, holdDurationMs, ticks])

  // ── announcements ───────────────────────────────────────────────────────
  const lastAnnouncedRef = useRef('')
  // -Infinity so the first lock of the session is always spoken; afterwards the
  // banner is throttled because the ring flips solid/dashed at every result.
  const lastLockAtRef = useRef(Number.NEGATIVE_INFINITY)
  useEffect(() => {
    const text = ANNOUNCE[visual]
    if (!text) return
    if (visual !== 'captured' && visual === lastAnnouncedRef.current) return
    // The ring flips solid/dashed at every model result; announcing each one
    // would be a metronome, so a re-lock is only worth saying once in a while.
    if (visual === 'locked') {
      const now = performance.now()
      if (now - lastLockAtRef.current < 3000) return
      lastLockAtRef.current = now
    }
    lastAnnouncedRef.current = visual
    window.clearTimeout(announceTimerRef.current)
    setAnnouncement('')
    announceTimerRef.current = window.setTimeout(() => setAnnouncement(text), 40)
  }, [visual])

  useEffect(() => () => window.clearTimeout(announceTimerRef.current), [])

  // ── paint ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let frame = 0
    let lastUiStep = -1
    // The blur layer is a fresh node whenever soft focus is switched back on,
    // and its mask is an inline style: a cached "hole has not moved" answer
    // would leave the new node unmasked and blur the card too.
    blurMaskRef.current = { corners: null, width: 0, height: 0 }

    // The sharp island is the quad plus a margin, punched out of everything
    // else. One inverse path serves both the mask and the clip path.
    const paintBlurHole = (px, width, height) => {
      const hole = outset(px, BLUR_HOLE_MARGIN).ring
      blurClipRef.current?.setAttribute('d', `M0 0 H${width} V${height} H0 Z ${toPath(hole)}`)

      const mask = blurMaskRef.current
      let moved = mask.corners ? 0 : Infinity
      if (mask.corners) {
        for (let index = 0; index < 4; index += 1) {
          const dx = hole[index][0] - mask.corners[index][0]
          const dy = hole[index][1] - mask.corners[index][1]
          const stepPx = Math.sqrt(dx * dx + dy * dy)
          if (stepPx > moved) moved = stepPx
        }
      }
      if (moved < BLUR_MASK_STEP_PX && mask.width === width && mask.height === height) return

      if (!mask.corners) mask.corners = [[0, 0], [0, 0], [0, 0], [0, 0]]
      for (let index = 0; index < 4; index += 1) {
        mask.corners[index][0] = hole[index][0]
        mask.corners[index][1] = hole[index][1]
      }
      mask.width = width
      mask.height = height

      const node = blurRef.current
      if (!node) return
      const source = '<svg xmlns="http://www.w3.org/2000/svg" '
        + `viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`
        + `<path d="M0 0 H${width} V${height} H0 Z ${toPath(hole)}" fill="#fff" fill-rule="evenodd"/></svg>`
      const url = `url("data:image/svg+xml,${encodeURIComponent(source)}")`
      node.style.webkitMaskImage = url
      node.style.maskImage = url
    }

    const paint = now => {
      frame = window.requestAnimationFrame(paint)
      const svg = svgRef.current
      const { width, height } = sizeRef.current
      if (!svg || !width || !height) return

      const anim = animRef.current
      const reduced = reducedRef.current
      const current = anim.phase
      const raw = quadRef.current

      if (!raw) {
        // Nothing to draw: blank the paint once, then leave the DOM alone so an
        // idle camera does not write to it 60 times a second. The smoother is
        // dropped so the next card is drawn where it actually is.
        smootherRef.current?.reset()
        paintedStampRef.current = -1
        lastArrivalRef.current = 0
        // A card that comes back must not come back already settled.
        anim.lock = 0
        anim.lockFrom = 0
        anim.lockTo = 0
        anim.blurWanted = false
        anim.blurReleaseAt = 0
        anim.blurFrom = 0
        anim.blurTo = 0
        anim.blurStart = 0
        anim.blurShown = -1
        if (anim.blur !== 0) {
          anim.blur = 0
          if (blurRef.current) {
            blurRef.current.style.opacity = '0'
            blurRef.current.style.display = 'none'
          }
        }
        if (blankRef.current) return
        blankRef.current = true
        dimRef.current?.setAttribute('opacity', '0')
        for (const node of [underRef.current, baseRef.current, trackRef.current, progRef.current]) {
          node?.setAttribute('opacity', '0')
        }
        glowRef.current?.setAttribute('opacity', '0')
        tipRef.current?.setAttribute('opacity', '0')
        tipHaloRef.current?.setAttribute('opacity', '0')
        hintWrapRef.current?.setAttribute('opacity', '0')
        ghostRef.current?.setAttribute('opacity', '0')
        bloomRef.current?.setAttribute('opacity', '0')
        return
      }

      blankRef.current = false

      // Displayed geometry only: the raw quad in quadRef is never rewritten, so
      // capture, the hold rule and diagnostics keep reading it. Every frame
      // advances the display interpolator toward the filtered target; a new
      // tracker sample re-seeds that target once. The blur hole, dim inverse and
      // ring all read this same interpolated outline, so they move together.
      const smoother = smootherRef.current || (smootherRef.current = createQuadSmoother({
        glideMs: reduced ? 0 : QUAD_GLIDE_MS,
      }))
      let points
      if (paintedStampRef.current !== quadStampRef.current) {
        const gap = lastArrivalRef.current ? quadArrivalRef.current - lastArrivalRef.current : 0
        lastArrivalRef.current = quadArrivalRef.current
        paintedStampRef.current = quadStampRef.current
        points = smoother.sample(raw, gap, now)
      } else {
        points = smoother.tick(now)
      }

      // progress clock
      if (anim.draining) {
        const ratio = Math.min(1, (now - anim.drainStart) / DRAIN_MS)
        anim.progress = anim.drainFrom * (1 - (reduced ? 1 : easeOutCubic(ratio)))
        if (ratio >= 1) {
          anim.progress = 0
          anim.draining = false
        }
      } else if (current === 'holding') {
        anim.progress = clamp01((now - anim.holdStart) / holdDurationMs)
      } else if (current === 'captured') {
        anim.progress = 1
      } else {
        anim.progress = 0
      }

      // reduced motion: six sampled steps instead of a travelling line
      const step = Math.round(anim.progress * ticks)
      const shown = reduced ? step / ticks : anim.progress

      const px = pixelRef.current
      for (let i = 0; i < 4; i += 1) {
        px[i][0] = points[i][0] * width
        px[i][1] = points[i][1] * height
      }
      const { ring, cx, cy } = outset(px, OUTSET)
      const { segments, total } = segmentsOf(ring)
      const path = toPath(ring)

      const cardPath = toPath(px)
      const inverse = `M0 0 H${width} V${height} H0 Z ${cardPath}`
      dimRef.current?.setAttribute('d', inverse)

      // ── blur outside the card: "I have your card" ───────────────────────
      // A confirmation latches the blur on and it stays for as long as the card
      // is still being followed - not just for the 800 ms hold, which is far
      // too short to read. A lost/none phase releases after a short grace so a
      // one-frame blip cannot toggle it; captured and too-small release at once.
      if (current === 'locked' || current === 'holding') {
        anim.blurWanted = true
        anim.blurReleaseAt = 0
      } else if (current === 'captured' || current === 'tooSmall') {
        // A real state change releases at once; only ambiguous blips wait.
        anim.blurWanted = false
        anim.blurReleaseAt = 0
      } else if (anim.blurWanted) {
        if (!anim.blurReleaseAt) anim.blurReleaseAt = now + BLUR_RELEASE_HOLD_MS
        if (now >= anim.blurReleaseAt) {
          anim.blurWanted = false
          anim.blurReleaseAt = 0
        }
      } else {
        anim.blurReleaseAt = 0
      }
      if (!blurRef.current) {
        // Soft focus is off, so nothing is composited: restart the fade from
        // zero if it is switched back on.
        anim.blur = 0
        anim.blurFrom = 0
        anim.blurTo = 0
        anim.blurStart = 0
        anim.blurShown = -1
      } else {
        const target = softFocus && anim.blurWanted ? 1 : 0
        if (reduced) {
          anim.blur = target
          anim.blurFrom = target
          anim.blurTo = target
        } else {
          if (anim.blurTo !== target) {
            anim.blurFrom = anim.blur
            anim.blurTo = target
            anim.blurStart = now
          }
          if (anim.blur !== target) {
            const span = target === 1 ? BLUR_FADE_IN_MS : BLUR_FADE_OUT_MS
            const ratio = clamp01((now - anim.blurStart) / span)
            anim.blur = ratio >= 1
              ? target
              : anim.blurFrom + (target - anim.blurFrom) * easeOutCubic(ratio)
          }
        }
        if (softFocus && anim.blur > 0) paintBlurHole(px, width, height)
        const shownBlur = Math.round(anim.blur * 100) / 100
        if (shownBlur !== anim.blurShown) {
          anim.blurShown = shownBlur
          blurRef.current.style.opacity = String(shownBlur)
          blurRef.current.style.display = shownBlur > 0 ? 'block' : 'none'
        }
      }
      for (const node of [underRef.current, baseRef.current, trackRef.current, progRef.current, glowRef.current]) {
        node?.setAttribute('d', path)
      }
      progRef.current?.setAttribute('stroke-dasharray', `${total} ${total}`)
      progRef.current?.setAttribute('stroke-dashoffset', String(total * (1 - shown)))
      glowRef.current?.setAttribute('stroke-dasharray', `${total} ${total}`)
      glowRef.current?.setAttribute('stroke-dashoffset', String(total * (1 - shown)))

      // ── lock strength: the ring settling, never a style swap ────────────
      // The confirmation pulse lasts 300 ms and repeats at the detection rate,
      // so following it with a solid/dashed swap reads as the outline flickering
      // back and forth. One eased 0..1 value carries it instead: the solid ring
      // fades up and the dashed one fades out as it rises, and back as it
      // relaxes. A reversal restarts from the current value, so there is never a
      // jump, a queue or an overshoot.
      const settledRing = current === 'locked' || current === 'holding' || current === 'captured'
      const lockTarget = settledRing ? 1 : 0
      if (reduced) {
        anim.lock = lockTarget
        anim.lockTo = lockTarget
      } else {
        if (anim.lockTo !== lockTarget) {
          anim.lockFrom = anim.lock
          anim.lockTo = lockTarget
          anim.lockStart = now
        }
        if (anim.lock !== anim.lockTo) {
          const span = anim.lockTo > anim.lockFrom ? LOCK_RISE_MS : LOCK_RELAX_MS
          const ratio = clamp01((now - anim.lockStart) / span)
          // Land exactly on the target so the tween actually finishes.
          anim.lock = ratio >= 1
            ? anim.lockTo
            : anim.lockFrom + (anim.lockTo - anim.lockFrom) * easeOutCubic(ratio)
        }
      }
      const lock = anim.lock

      // the resting ring starts confident and yields to the bright trace
      const baseOpacity = (current === 'captured' ? 0.22 : 0.6 - 0.3 * shown) * lock
      baseRef.current?.setAttribute('opacity', baseOpacity.toFixed(2))
      // the dark backing only exists to separate a coloured ring from a light card
      underRef.current?.setAttribute('opacity', (0.9 * lock).toFixed(2))

      // The dashed outline is the resting state: it is there while a card is
      // followed and yields to the solid ring as `lock` rises, so `locked` is a
      // blend of the two rather than a third style.
      let dashedBase = 0
      let dashedStroke = TRACK
      if (current === 'tracking' || settledRing) {
        dashedBase = 0.78
      } else if (current === 'lost') {
        dashedBase = 0.5
        dashedStroke = GOLD
      } else if (current === 'tooSmall') {
        dashedBase = 0.55
        dashedStroke = GOLD
      }
      trackRef.current?.setAttribute('opacity', (dashedBase * (1 - lock)).toFixed(2))
      trackRef.current?.setAttribute('stroke', dashedStroke)

      const traceOn = current === 'locked' || current === 'holding' || current === 'lost' || current === 'captured'
      progRef.current?.setAttribute('opacity', traceOn ? '1' : '0')

      const tipOn = (current === 'locked' || current === 'holding' || current === 'lost') && shown > 0.02
      if (tipOn) {
        const [tx, ty] = pointAt(segments, total * shown)
        tipRef.current?.setAttribute('cx', tx.toFixed(2))
        tipRef.current?.setAttribute('cy', ty.toFixed(2))
        tipHaloRef.current?.setAttribute('cx', tx.toFixed(2))
        tipHaloRef.current?.setAttribute('cy', ty.toFixed(2))
      }
      tipRef.current?.setAttribute('opacity', tipOn ? '1' : '0')
      tipHaloRef.current?.setAttribute('opacity', tipOn ? (0.18 + 0.3 * shown).toFixed(2) : '0')

      // too small: an outline that wants to grow
      const pulse = reduced ? 0.45 : 0.5 + 0.5 * Math.sin(now / 620)
      if (current === 'tooSmall') {
        const scale = 1 + 0.055 * pulse
        ghostRef.current?.setAttribute('points', px.map(([x, y]) => (
          `${(cx + (x - cx) * scale).toFixed(2)},${(cy + (y - cy) * scale).toFixed(2)}`
        )).join(' '))
        ghostRef.current?.setAttribute('opacity', '1')
        hintWrapRef.current?.setAttribute('opacity', '1')
        hintRefs.current.forEach((node, index) => {
          if (!node) return
          const start = ring[index]
          const end = ring[(index + 1) % 4]
          const mx = (start[0] + end[0]) / 2
          const my = (start[1] + end[1]) / 2
          let nx = mx - cx
          let ny = my - cy
          const length = Math.hypot(nx, ny) || 1
          nx /= length
          ny /= length
          const push = 7 + 3 * pulse
          node.setAttribute(
            'transform',
            `translate(${(mx + nx * push).toFixed(2)} ${(my + ny * push).toFixed(2)}) `
              + `rotate(${(Math.atan2(ny, nx) * 180 / Math.PI).toFixed(1)})`,
          )
          node.setAttribute('opacity', (0.34 + 0.5 * pulse).toFixed(2))
        })
      } else {
        ghostRef.current?.setAttribute('opacity', '0')
        hintWrapRef.current?.setAttribute('opacity', '0')
      }

      // glow
      if (reduced) {
        glowRef.current?.setAttribute('opacity', '0.45')
        glowRef.current?.setAttribute('stroke-width', '8')
      } else {
        glowRef.current?.setAttribute('opacity', (0.16 + 0.6 * shown).toFixed(2))
        glowRef.current?.setAttribute('stroke-width', (6 + 4 * shown).toFixed(2))
      }

      // the moment of capture
      if (current === 'captured') {
        const beat = clamp01((now - anim.beatStart) / CAPTURE_BEAT_MS)
        for (const node of [progRef.current, glowRef.current, baseRef.current]) {
          node?.setAttribute('stroke', GREEN)
        }
        tipRef.current?.setAttribute('opacity', '0')
        tipHaloRef.current?.setAttribute('opacity', '0')
        dimRef.current?.setAttribute('opacity', (0.5 * (1 - beat)).toFixed(3))
        bloomRef.current?.setAttribute('opacity', reduced ? '0' : String(
          Math.max(0, 0.13 * (1 - beat * 2.2)).toFixed(3),
        ))
        if (reduced) {
          ringRef.current?.setAttribute('transform', '')
          ringRef.current?.setAttribute('opacity', '1')
        } else {
          const scale = 1 + 0.05 * easeOutCubic(beat)
          ringRef.current?.setAttribute(
            'transform',
            `translate(${cx.toFixed(2)} ${cy.toFixed(2)}) scale(${scale.toFixed(3)}) `
              + `translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})`,
          )
          ringRef.current?.setAttribute('opacity', (1 - beat).toFixed(3))
        }
      } else {
        for (const node of [progRef.current, glowRef.current, baseRef.current]) {
          node?.setAttribute('stroke', GOLD)
        }
        ringRef.current?.setAttribute('transform', '')
        ringRef.current?.setAttribute('opacity', '1')
        // Darkening and blur share the job: as the blur comes up the dim backs
        // off, so the picture softens rather than turning into a blackout.
        dimRef.current?.setAttribute('opacity', (0.5 * shown * (1 - 0.75 * (softFocus ? anim.blur : 0))).toFixed(3))
        bloomRef.current?.setAttribute('opacity', '0')
      }

      // bar + its reduced-motion segments
      if (barFillRef.current) {
        barFillRef.current.style.width = `${(shown * 100).toFixed(1)}%`
      }
      if (step !== lastUiStep) {
        lastUiStep = step
        segRefs.current.forEach((node, index) => {
          if (node) node.style.opacity = index < step ? '1' : '0.15'
        })
      }
    }

    frame = window.requestAnimationFrame(paint)
    return () => window.cancelAnimationFrame(frame)
  }, [holdDurationMs, ticks, softFocus])

  // ── measure ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (!box || !box.width || !box.height) return
      sizeRef.current = { width: box.width, height: box.height }
      svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])

  // The confirmation pulse is confidence, not a state: the pill keeps the
  // resting "card followed" presentation instead of changing its wording and
  // its progress track at the detection rate. The ring is what shows the
  // confirmation, continuously.
  const chromeVisual = visual === 'locked' ? 'tracking' : visual
  const tone = TONE[chromeVisual] || TONE.tracking
  const showBar = Boolean(SHOW_BAR[chromeVisual])

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Blurs everything behind the overlay's own chrome but inside the clip,
          which is the inverse of the card quad: the card stays sharp. It is
          composited only once a card has been confirmed, and it stays while
          that card is still followed. Soft focus off means it never mounts. */}
      {blurSupported && softFocus ? (
        <div
          ref={blurRef}
          className="pointer-events-none absolute inset-0"
          style={{
            backdropFilter: `blur(${BLUR_PX}px)`,
            WebkitBackdropFilter: `blur(${BLUR_PX}px)`,
            clipPath: `url(#${BLUR_CLIP_ID})`,
            WebkitClipPath: `url(#${BLUR_CLIP_ID})`,
            maskSize: '100% 100%',
            WebkitMaskSize: '100% 100%',
            maskRepeat: 'no-repeat',
            WebkitMaskRepeat: 'no-repeat',
            opacity: 0,
            display: 'none',
          }}
          aria-hidden="true"
        />
      ) : null}

      <svg
        ref={svgRef}
        className="absolute inset-0 block h-full w-full"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <filter id="capture-overlay-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.6" />
          </filter>
          {/* Inverse of the card quad for the blur layer. userSpaceOnUse makes
              the coordinates the same pixels the SVG paints in, which are the
              video box's own, so the ring and the blur boundary agree. */}
          <clipPath id={BLUR_CLIP_ID} clipPathUnits="userSpaceOnUse">
            <path ref={blurClipRef} d="" clipRule="evenodd" />
          </clipPath>
        </defs>

        <path ref={dimRef} d="" fill="#04040a" fillRule="evenodd" opacity="0" />
        <polygon
          ref={ghostRef}
          points=""
          fill="none"
          stroke={GOLD}
          strokeWidth="1"
          strokeOpacity="0.22"
          strokeDasharray="3 7"
          strokeLinejoin="round"
          opacity="0"
        />
        <path
          ref={underRef}
          d=""
          fill="none"
          stroke="#000"
          strokeOpacity="0.45"
          strokeWidth="4.6"
          strokeLinejoin="round"
          opacity="0"
        />
        <path ref={baseRef} d="" fill="none" stroke={GOLD} strokeWidth="2.2" strokeLinejoin="round" opacity="0" />
        <path
          ref={trackRef}
          d=""
          fill="none"
          stroke={TRACK}
          strokeWidth="1.5"
          strokeDasharray="7 6"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity="0"
        />

        <g ref={ringRef}>
          <path
            ref={glowRef}
            d=""
            fill="none"
            stroke={GOLD}
            strokeWidth="7"
            strokeLinecap="round"
            filter="url(#capture-overlay-glow)"
            opacity="0"
          />
          <path
            ref={progRef}
            d=""
            fill="none"
            stroke={GOLD}
            strokeWidth="2.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0"
          />
          <circle ref={tipHaloRef} cx="0" cy="0" r="6.5" fill="none" stroke={GOLD} strokeWidth="1.2" opacity="0" />
          <circle ref={tipRef} cx="0" cy="0" r="2.9" fill="#fff" opacity="0" />
        </g>

        <g ref={hintWrapRef} opacity="0">
          {[0, 1, 2, 3].map(index => (
            <g
              key={index}
              ref={node => { hintRefs.current[index] = node }}
            >
              <path
                d="M-2.6 -4 L3 0 L-2.6 4"
                fill="none"
                stroke={GOLD}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}
        </g>

        <rect ref={bloomRef} x="0" y="0" width="100%" height="100%" fill="#fff" opacity="0" />
      </svg>

      {pendingCount > 0 ? (
        <p className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-1 text-[10px] font-medium text-text-secondary backdrop-blur-sm">
          {pendingCount} taken
        </p>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/70 to-transparent px-3 pb-3 pt-8">
        <div
          className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-[11.5px] font-medium leading-none shadow-[0_5px_20px_rgba(0,0,0,.55)] backdrop-blur-[10px] transition-colors duration-200"
          style={{
            color: tone.color,
            borderColor: tone.border,
            backgroundColor: tone.bg,
            opacity: tone.opacity,
          }}
        >
          {chromeVisual === 'captured' ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M2 6.4 4.6 9 10 3.2"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : chromeVisual === 'tooSmall' ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M6 1.6v8.8M1.6 6h8.8M4.3 3.3 6 1.6l1.7 1.7M4.3 8.7 6 10.4l1.7-1.7M3.3 4.3 1.6 6l1.7 1.7M8.7 4.3 10.4 6 8.7 7.7"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : chromeVisual === 'none' ? null : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-90" />
          )}

          <span>{chromeVisual === 'none' && reason === 'too-soft'
            ? "Can't confirm the card yet — steady the phone"
            : COPY[chromeVisual]}</span>

          <span
            className="relative h-[3px] shrink-0 overflow-hidden rounded-[2px] bg-white/15"
            style={{
              width: showBar ? 74 : 0,
              opacity: showBar ? (chromeVisual === 'lost' ? 0.7 : 1) : 0,
              transition: reducedMotion ? 'none' : 'width .2s ease, opacity .16s ease',
            }}
          >
            <i
              ref={barFillRef}
              className="absolute inset-y-0 left-0 rounded-[2px] bg-current"
              style={{ width: 0, display: reducedMotion ? 'none' : 'block', boxShadow: '0 0 8px currentColor' }}
            />
            {Array.from({ length: Math.max(1, ticks) }).map((_, index) => (
              <span
                key={index}
                ref={node => { segRefs.current[index] = node }}
                className="absolute top-0 h-[3px] w-[12.4%] rounded-[1px] bg-current"
                style={{
                  left: `${(index * 100) / Math.max(1, ticks)}%`,
                  display: reducedMotion ? 'block' : 'none',
                  opacity: 0.15,
                }}
              />
            ))}
          </span>
        </div>
      </div>

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  )
})

export default CaptureOverlay
