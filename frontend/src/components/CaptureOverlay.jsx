import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createQuadSmoother, QUAD_GLIDE_MS } from '../utils/quadSmoothing'

/**
 * Capture overlay: one ring, the soft-focus layer and the status pill.
 *
 * The ring is a single gold style. It fades up in 120 ms when a card is
 * credible, latches through 300 ms of lost observation, then relaxes over
 * 250 ms. A discontinuity is a cut, never an interpolation: the ring fades out,
 * the geometry swaps at the trough, and it fades back in.
 *
 * Capture confirmation is a short green settle on the captured quad; the dock
 * below the preview carries the receipt.
 *
 * Everything here is presentation only. Capture, hold, corroboration,
 * signatures and diagnostics read the raw quad held by the page.
 */

const GOLD = '#f5c842'
const GREEN = '#22c55e'

const CAPTURE_BEAT_MS = 230
const CAPTURE_RING_FADE_MS = 120
const LOCK_RISE_MS = 120
const LOCK_RELAX_MS = 250
const LOST_LATCH_MS = 300
const HINT_DELAY_MS = 900
const CUT_OUT_MS = 80
const CUT_IN_MS = 120

const OUTSET = 3.4
const MIN_CARD_AREA = 0.12

const BLUR_PX = 4
const BLUR_FADE_IN_MS = 150
const BLUR_FADE_OUT_MS = 250
const BLUR_HOLE_MARGIN = 9
const BLUR_CLIP_ID = 'capture-overlay-blur-hole'
const BLUR_MASK_STEP_PX = 0.35

function supportsBlurHole() {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  const blur = CSS.supports('backdrop-filter', 'blur(4px)')
    || CSS.supports('-webkit-backdrop-filter', 'blur(4px)')
  const hole = CSS.supports('mask-image', 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")')
    || CSS.supports('-webkit-mask-image', 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")')
    || CSS.supports('clip-path', `url(#${BLUR_CLIP_ID})`)
  return Boolean(blur && hole)
}

const HINTS = {
  size: 'Move closer',
  soft: "Can't confirm yet",
  nothing: 'Point the camera at a card',
}

const easeOutCubic = t => 1 - (1 - t) ** 3
const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value)

function toPath(points) {
  return `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`
}

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

const CaptureOverlay = forwardRef(function CaptureOverlay({
  quad = null,
  phase,
  tracked = false,
  confirmed = false,
  tooSmall = false,
  cardArea,
  pendingCount = 0,
  softFocus = true,
  reason = null,
  receiptCorners = null,
}, ref) {
  const quadRef = useRef(quad)
  const [hasQuad, setHasQuad] = useState(Boolean(quad))
  const hasQuadRef = useRef(Boolean(quad))

  const svgRef = useRef(null)
  const blurRef = useRef(null)
  const blurClipRef = useRef(null)
  const dimRef = useRef(null)
  const underRef = useRef(null)
  const baseRef = useRef(null)
  const glowRef = useRef(null)
  const ringRef = useRef(null)
  const bloomRef = useRef(null)

  const sizeRef = useRef({ width: 0, height: 0 })
  const pixelRef = useRef([[0, 0], [0, 0], [0, 0], [0, 0]])
  const smootherRef = useRef(null)
  const blurMaskRef = useRef({ corners: null, width: 0, height: 0 })
  const quadStampRef = useRef(0)
  const quadArrivalRef = useRef(0)
  const paintedStampRef = useRef(-1)
  const lastArrivalRef = useRef(0)
  const [blurSupported] = useState(supportsBlurHole)
  const blankRef = useRef(false)
  const reducedRef = useRef(false)
  const lastJumpCountRef = useRef(0)
  const lastDrawnRef = useRef(null)
  const cutRef = useRef(null)
  const lostSinceRef = useRef(null)

  const animRef = useRef({
    phase: 'none',
    beatStart: 0,
    lock: 0,
    lockFrom: 0,
    lockTo: 0,
    lockStart: 0,
    blurWanted: false,
    blur: 0,
    blurFrom: 0,
    blurTo: 0,
    blurStart: 0,
    blurShown: -1,
  })

  const [hint, setHint] = useState('')

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = event => {
      reducedRef.current = event.matches
      smootherRef.current?.setGlideMs(event.matches ? 0 : QUAD_GLIDE_MS)
    }
    reducedRef.current = media.matches
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

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
    else visual = confirmed ? 'locked' : 'tracking'
  }

  useEffect(() => {
    animRef.current.phase = visual
    if (visual === 'captured') animRef.current.beatStart = performance.now()
  }, [visual])

  // Hint copy appears only after the same problem has persisted 900 ms.
  useEffect(() => {
    let key = null
    if (visual === 'tooSmall') key = 'size'
    else if (visual === 'none') key = reason === 'too-soft' ? 'soft' : 'nothing'
    else if (visual === 'lost') key = 'nothing'
    if (!key) {
      setHint('')
      return undefined
    }
    setHint('')
    const timer = window.setTimeout(() => setHint(HINTS[key]), HINT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [visual, reason])

  // ── paint ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let frame = 0
    blurMaskRef.current = { corners: null, width: 0, height: 0 }

    const paintBlurHole = (px, width, height) => {
      const hole = outset(px, BLUR_HOLE_MARGIN).ring
      blurClipRef.current?.setAttribute('d', `M0 0 H${width} V${height} H0 Z ${toPath(hole)}`)

      const mask = blurMaskRef.current
      let moved = mask.corners ? 0 : Infinity
      if (mask.corners) {
        for (let index = 0; index < 4; index += 1) {
          const dx = hole[index][0] - mask.corners[index][0]
          const dy = hole[index][1] - mask.corners[index][1]
          moved = Math.max(moved, Math.hypot(dx, dy))
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

      const updateBlur = target => {
        if (!blurRef.current) {
          anim.blur = 0
          return
        }
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
        const shown = Math.round(anim.blur * 100) / 100
        if (shown !== anim.blurShown) {
          anim.blurShown = shown
          blurRef.current.style.opacity = String(shown)
          blurRef.current.style.display = shown > 0 ? 'block' : 'none'
        }
      }

      if (!raw) {
        smootherRef.current?.reset()
        paintedStampRef.current = -1
        lastArrivalRef.current = 0
        lastJumpCountRef.current = 0
        lastDrawnRef.current = null
        cutRef.current = null
        lostSinceRef.current = null
        anim.lock = 0
        anim.lockFrom = 0
        anim.lockTo = 0
        anim.blurWanted = false
        updateBlur(0)
        if (blankRef.current) return
        blankRef.current = true
        dimRef.current?.setAttribute('opacity', '0')
        underRef.current?.setAttribute('opacity', '0')
        baseRef.current?.setAttribute('opacity', '0')
        glowRef.current?.setAttribute('opacity', '0')
        bloomRef.current?.setAttribute('opacity', '0')
        return
      }

      blankRef.current = false

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

      // A discontinuity is a cut: hold the old quad, fade the ring out, swap at
      // the trough, fade back in. Never interpolate across the frame.
      if (current !== 'captured'
        && smoother.jumpCount !== lastJumpCountRef.current
        && lastDrawnRef.current) {
        cutRef.current = {
          from: lastDrawnRef.current.map(([x, y]) => [x, y]),
          to: points.map(([x, y]) => [x, y]),
          start: now,
          swapped: false,
        }
      }
      lastJumpCountRef.current = smoother.jumpCount

      let display = points
      let cutOpacity = 1
      const cut = cutRef.current
      if (cut && !reduced) {
        const elapsed = now - cut.start
        if (elapsed < CUT_OUT_MS) {
          display = cut.from
          cutOpacity = 1 - elapsed / CUT_OUT_MS
        } else if (elapsed < CUT_OUT_MS + CUT_IN_MS) {
          display = cut.to
          cutOpacity = (elapsed - CUT_OUT_MS) / CUT_IN_MS
        } else {
          cutRef.current = null
        }
      } else if (cut) {
        cutRef.current = null
      }

      if (current === 'captured' && receiptCorners?.length === 4) {
        display = receiptCorners
      }
      lastDrawnRef.current = display.map(([x, y]) => [x, y])

      const px = pixelRef.current
      for (let i = 0; i < 4; i += 1) {
        px[i][0] = display[i][0] * width
        px[i][1] = display[i][1] * height
      }
      const { ring, cx, cy } = outset(px, OUTSET)
      const path = toPath(ring)
      dimRef.current?.setAttribute('d', `M0 0 H${width} V${height} H0 Z ${toPath(px)}`)

      // One ring strength, shared with the blur latch. Lost observations hold
      // for 300 ms before the relax begins.
      const credible = current === 'tracking' || current === 'locked' || current === 'holding'
      let target = credible || current === 'captured' ? 1 : 0
      if (current === 'lost') {
        if (lostSinceRef.current == null) lostSinceRef.current = now
        if (now - lostSinceRef.current < LOST_LATCH_MS) target = 1
      } else {
        lostSinceRef.current = null
      }
      if (reduced) {
        anim.lock = target
        anim.lockTo = target
      } else {
        if (anim.lockTo !== target) {
          anim.lockFrom = anim.lock
          anim.lockTo = target
          anim.lockStart = now
        }
        if (anim.lock !== anim.lockTo) {
          const span = anim.lockTo > anim.lockFrom ? LOCK_RISE_MS : LOCK_RELAX_MS
          const ratio = clamp01((now - anim.lockStart) / span)
          anim.lock = ratio >= 1
            ? anim.lockTo
            : anim.lockFrom + (anim.lockTo - anim.lockFrom) * easeOutCubic(ratio)
        }
      }
      const lock = anim.lock

      const blurTarget = softFocus && !reduced
        && (credible || (current === 'lost' && target > 0)) ? 1 : 0
      updateBlur(blurTarget)
      if (softFocus && anim.blur > 0) paintBlurHole(px, width, height)

      baseRef.current?.setAttribute('d', path)
      glowRef.current?.setAttribute('d', path)
      underRef.current?.setAttribute('d', path)
      baseRef.current?.setAttribute('stroke', current === 'captured' ? GREEN : GOLD)
      glowRef.current?.setAttribute('stroke', current === 'captured' ? GREEN : GOLD)

      if (current === 'captured') {
        const beat = clamp01((now - anim.beatStart) / CAPTURE_BEAT_MS)
        const ringBeat = clamp01((now - anim.beatStart) / CAPTURE_RING_FADE_MS)
        const opacity = (1 - ringBeat) * cutOpacity
        baseRef.current?.setAttribute('opacity', opacity.toFixed(3))
        glowRef.current?.setAttribute('opacity', (0.5 * opacity).toFixed(3))
        underRef.current?.setAttribute('opacity', (0.9 * opacity).toFixed(3))
        dimRef.current?.setAttribute('opacity', (0.5 * (1 - beat)).toFixed(3))
        bloomRef.current?.setAttribute('opacity', reduced ? '0' : String(
          Math.max(0, 0.13 * (1 - beat * 2.2)).toFixed(3),
        ))
        if (reduced) {
          ringRef.current?.setAttribute('transform', '')
        } else {
          const scale = 1 + 0.05 * easeOutCubic(beat)
          ringRef.current?.setAttribute(
            'transform',
            `translate(${cx.toFixed(2)} ${cy.toFixed(2)}) scale(${scale.toFixed(3)}) `
              + `translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})`,
          )
        }
      } else {
        const opacity = lock * cutOpacity
        baseRef.current?.setAttribute('opacity', opacity.toFixed(3))
        underRef.current?.setAttribute('opacity', (0.9 * opacity).toFixed(3))
        glowRef.current?.setAttribute('opacity', (0.5 * opacity).toFixed(3))
        ringRef.current?.setAttribute('transform', '')
        dimRef.current?.setAttribute('opacity', (0.5 * lock * (1 - 0.75 * (softFocus ? anim.blur : 0))).toFixed(3))
        bloomRef.current?.setAttribute('opacity', '0')
      }
    }

    frame = window.requestAnimationFrame(paint)
    return () => window.cancelAnimationFrame(frame)
  }, [softFocus, receiptCorners])

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

  const visible = visual !== 'none' || hasQuad
  const captured = visual === 'captured'
  const problem = !captured && hint
  const tone = captured
    ? { color: GREEN, border: 'rgba(34,197,94,.45)', bg: 'rgba(5,20,10,.82)' }
    : { color: GOLD, border: 'rgba(245,200,66,.35)', bg: 'rgba(18,14,6,.82)' }
  const pillText = captured
    ? 'Captured'
    : problem || (visible && !hint ? 'Card detected' : '')

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
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
          <clipPath id={BLUR_CLIP_ID} clipPathUnits="userSpaceOnUse">
            <path ref={blurClipRef} d="" clipRule="evenodd" />
          </clipPath>
        </defs>

        <path ref={dimRef} d="" fill="#04040a" fillRule="evenodd" opacity="0" />
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
            ref={baseRef}
            d=""
            fill="none"
            stroke={GOLD}
            strokeWidth="2.2"
            strokeLinejoin="round"
            opacity="0"
          />
        </g>
        <rect ref={bloomRef} x="0" y="0" width="100%" height="100%" fill="#fff" opacity="0" />
      </svg>

      {pendingCount > 0 ? (
        <p className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-1 text-[10px] font-medium text-text-secondary backdrop-blur-sm">
          {pendingCount} taken
        </p>
      ) : null}

      {pillText ? (
        <div className="absolute inset-x-0 bottom-0 flex justify-center px-3 pb-3 pt-8">
          <div
            className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-[11.5px] font-medium leading-none shadow-[0_5px_20px_rgba(0,0,0,.55)] backdrop-blur-[10px]"
            style={{ color: tone.color, borderColor: tone.border, backgroundColor: tone.bg }}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-90" />
            <span>{pillText}</span>
          </div>
        </div>
      ) : null}

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {captured ? 'Card captured.' : hint}
      </span>
    </div>
  )
})

export default CaptureOverlay
