import { useCallback, useEffect, useRef, useState } from 'react'

const SLOT_WIDTH = 46
const SLOT_HEIGHT = 58
const TRAY_CAPACITY = 50

function videoContentRect(video, resizeMode) {
  const rect = video.getBoundingClientRect()
  const videoWidth = video.videoWidth
  const videoHeight = video.videoHeight
  if (!rect.width || !rect.height || !videoWidth || !videoHeight) return null
  const cover = resizeMode === 'crop-and-scale'
  const scale = cover
    ? Math.max(rect.width / videoWidth, rect.height / videoHeight)
    : Math.min(rect.width / videoWidth, rect.height / videoHeight)
  const width = videoWidth * scale
  const height = videoHeight * scale
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
    scale,
  }
}

function containedSize(aspect, maxWidth, maxHeight) {
  if (!(aspect > 0)) return { width: 0, height: 0 }
  let width = maxWidth
  let height = width / aspect
  if (height > maxHeight) {
    height = maxHeight
    width = height * aspect
  }
  return { width, height }
}

export default function CaptureDock({
  count = 0,
  lastIndex = null,
  thumbnail = null,
  canUndo = false,
  onUndo,
  onOpen,
  flight = null,
  onFlightDone,
  videoRef,
  announcement = '',
}) {
  const slotRef = useRef(null)
  const flyerRef = useRef(null)
  const animationRef = useRef(null)
  const doneRef = useRef(onFlightDone)
  doneRef.current = onFlightDone
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(media.matches)
    sync()
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  const clearFlyer = useCallback(() => {
    animationRef.current?.cancel()
    animationRef.current = null
    flyerRef.current?.remove()
    flyerRef.current = null
  }, [])

  useEffect(() => {
    if (!flight) return undefined
    let cancelled = false
    const token = flight.token

    const finish = () => {
      if (cancelled) return
      cancelled = true
      clearFlyer()
      doneRef.current?.(token)
    }

    const onInterrupt = () => finish()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') finish()
    }
    window.addEventListener('resize', onInterrupt)
    document.addEventListener('visibilitychange', onVisibility)

    const run = async () => {
      const slot = slotRef.current
      const video = videoRef?.current
      if (reduced || window.matchMedia('(prefers-reduced-motion: reduce)').matches
        || !slot || !video || !flight.sourceRect) {
        finish()
        return
      }
      const slotRect = slot.getBoundingClientRect()
      if (slotRect.width <= 0 || slotRect.bottom < 0 || slotRect.top > window.innerHeight) {
        finish()
        return
      }
      const content = videoContentRect(video, flight.resizeMode)
      if (!content) {
        finish()
        return
      }

      const image = new Image()
      image.src = flight.url
      try {
        if (typeof image.decode === 'function') await image.decode()
        else {
          await new Promise((resolve, reject) => {
            image.onload = resolve
            image.onerror = reject
          })
        }
      } catch {
        finish()
        return
      }
      if (cancelled) return
      if (flight.committedAt && performance.now() - flight.committedAt > 120) {
        finish()
        return
      }

      const { x, y, width, height } = flight.sourceRect
      const startWidth = width * content.scale
      const startHeight = height * content.scale
      if (!(startWidth > 0) || !(startHeight > 0)) {
        finish()
        return
      }
      const startX = content.left + x * content.scale
      const startY = content.top + y * content.scale
      const startCx = startX + startWidth / 2
      const startCy = startY + startHeight / 2
      const destCx = slotRect.left + slotRect.width / 2
      const destCy = slotRect.top + slotRect.height / 2
      const dest = containedSize(
        width / height,
        Math.min(SLOT_WIDTH, slotRect.width),
        Math.min(SLOT_HEIGHT, slotRect.height),
      )
      if (!(dest.width > 0)) {
        finish()
        return
      }
      const endScale = dest.width / startWidth
      const duration = flight.index <= 3 ? 340 : flight.index <= 10 ? 270 : 210
      const fadeStart = 1 - 60 / duration
      const distance = Math.hypot(destCx - startCx, destCy - startCy)
      const controlX = (startCx + destCx) / 2
      const controlY = (startCy + destCy) / 2 - Math.min(24, 0.08 * distance)

      const node = document.createElement('img')
      node.src = flight.url
      node.alt = ''
      node.style.position = 'fixed'
      node.style.left = '0'
      node.style.top = '0'
      node.style.width = `${startWidth}px`
      node.style.height = `${startHeight}px`
      node.style.objectFit = 'fill'
      node.style.borderRadius = '3px'
      node.style.pointerEvents = 'none'
      node.style.zIndex = '60'
      node.style.willChange = 'transform, opacity'
      node.style.transformOrigin = '0 0'
      flyerRef.current = node
      document.body.appendChild(node)

      const frames = [0, 0.25, 0.5, 0.75, 1].map(p => {
        const one = 1 - p
        const cx = one * one * startCx + 2 * one * p * controlX + p * p * destCx
        const cy = one * one * startCy + 2 * one * p * controlY + p * p * destCy
        const scale = endScale ** p
        const opacity = p <= fadeStart ? 1 : (1 - p) / (1 - fadeStart)
        return {
          transform: `translate(${cx - (startWidth * scale) / 2}px, ${cy - (startHeight * scale) / 2}px) scale(${scale})`,
          opacity,
        }
      })

      const animation = node.animate(frames, {
        duration,
        easing: 'cubic-bezier(.22,.65,.28,1)',
        fill: 'forwards',
      })
      animationRef.current = animation
      animation.onfinish = finish
    }

    run()
    return () => {
      cancelled = true
      window.removeEventListener('resize', onInterrupt)
      document.removeEventListener('visibilitychange', onVisibility)
      clearFlyer()
    }
  }, [flight, videoRef, reduced, clearFlyer])

  const full = count >= TRAY_CAPACITY
  const primary = full
    ? `Tray full · Review ${TRAY_CAPACITY} photos`
    : lastIndex != null
      ? `Captured #${lastIndex} · Next card`
      : `Capture tray · ${count}/${TRAY_CAPACITY}`
  const secondary = !full && count > 0 ? `${count}/${TRAY_CAPACITY} in tray` : ''

  return (
    <div className="relative mt-2 flex h-[72px] shrink-0 items-center gap-3 rounded-lg border border-border bg-bg-card px-2 mb-[env(safe-area-inset-bottom)]">
      <button
        type="button"
        onClick={onOpen}
        className="relative h-[58px] w-[46px] min-h-11 min-w-11 shrink-0"
        aria-label="Open capture tray"
      >
        {count >= 2 ? (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-[3px] border border-border bg-bg-elevated"
            style={{ transform: 'translate(3px, -2px) rotate(-3deg)' }}
          />
        ) : null}
        {count >= 3 ? (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-[3px] border border-border bg-bg-elevated"
            style={{ transform: 'translate(6px, -4px) rotate(2deg)' }}
          />
        ) : null}
        <span className="absolute inset-0 overflow-hidden rounded-[3px] border border-border bg-black">
          {thumbnail ? (
            <img
              key={thumbnail}
              src={thumbnail}
              alt=""
              className="capture-dock-thumb h-full w-full object-contain"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-[10px] text-text-muted">
              0
            </span>
          )}
        </span>
        <span ref={slotRef} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      </button>

      <button type="button" onClick={onOpen} className="min-h-11 min-w-0 flex-1 text-left">
        <span className="block truncate text-xs font-medium text-text-primary">{primary}</span>
        {secondary ? (
          <span className="mt-0.5 block text-[11px] text-text-secondary">{secondary}</span>
        ) : null}
      </button>

      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        className="btn-ghost-sm min-h-11 min-w-11 shrink-0"
      >
        Undo
      </button>

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  )
}
