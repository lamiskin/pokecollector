import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  TRAY_CAPACITY,
  containedRotatedBox,
  isQuarterTurn,
  isRailAtEnd,
  railEdges,
  rotationDegrees,
} from '../utils/captureTray'

// Slots keep the card's full frame: the padding and sleeve edge are part of what
// the collector is judging, so the thumbnail is contained, never cropped, and
// every card stays 54×60 however many are in the tray.
const SLOT_WIDTH = 54
const SLOT_HEIGHT = 60
const SLOT_OVERLAP = 27

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

function TraySlotThumb({ item }) {
  const rotated = isQuarterTurn(item.rotationCW)
  const degrees = rotationDegrees(item.rotationCW)
  return (
    <span className="flex h-full w-full items-center justify-center">
      <span
        className="block shrink-0"
        style={{
          // Swapping the contained box before rotating keeps the card's own
          // corners inside the slot at 90°/270°.
          width: rotated ? SLOT_HEIGHT : SLOT_WIDTH,
          height: rotated ? SLOT_WIDTH : SLOT_HEIGHT,
          transform: degrees ? `rotate(${degrees}deg)` : undefined,
        }}
      >
        <img
          src={item.previewUrl}
          alt=""
          draggable={false}
          className="h-full w-full object-contain"
        />
      </span>
    </span>
  )
}

export default function CaptureDock({
  items = [],
  count = 0,
  full = false,
  canUndo = false,
  canReview = false,
  reviewBusy = false,
  onUndo,
  onReview,
  onInspect,
  flight = null,
  onFlightDone,
  videoRef,
  announcement = '',
  removedNotice = null,
  sessionRotation = null,
  onResetSessionRotation,
}) {
  const flyerRef = useRef(null)
  const animationRef = useRef(null)
  const doneRef = useRef(onFlightDone)
  doneRef.current = onFlightDone
  const [reduced, setReduced] = useState(false)

  const railRef = useRef(null)
  const slotNodesRef = useRef(new Map())
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  followingRef.current = following
  const [edges, setEdges] = useState({ left: false, right: false })

  const setSlotNode = useCallback((id, node) => {
    if (node) slotNodesRef.current.set(id, node)
    else slotNodesRef.current.delete(id)
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(media.matches)
    sync()
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  const updateEdges = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    const next = railEdges(rail)
    setEdges(prev => (prev.left === next.left && prev.right === next.right ? prev : next))
  }, [])

  const pinToLatest = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    rail.scrollLeft = rail.scrollWidth
    updateEdges()
  }, [updateEdges])

  // The new slot exists in this commit; pin the strip (while following) before
  // anything measures the destination, so the flight lands where the card is.
  const previousCountRef = useRef(0)
  useLayoutEffect(() => {
    if (following && items.length !== previousCountRef.current) pinToLatest()
    previousCountRef.current = items.length
    updateEdges()
  }, [items.length, following, pinToLatest, updateEdges])

  useEffect(() => {
    const rail = railRef.current
    if (!rail || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      if (followingRef.current) rail.scrollLeft = rail.scrollWidth
      updateEdges()
    })
    observer.observe(rail)
    return () => observer.disconnect()
  }, [updateEdges])

  const onRailScroll = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    updateEdges()
    const atEnd = isRailAtEnd(rail)
    setFollowing(prev => (prev === atEnd ? prev : atEnd))
  }, [updateEdges])

  const resumeLatest = useCallback(() => {
    // Jump rather than animate: a smooth scroll emits intermediate positions,
    // and each one would look like the collector swiping back and stop follow
    // again before it reached the newest card.
    setFollowing(true)
    pinToLatest()
  }, [pinToLatest])

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
      const rail = railRef.current
      const slot = flight.itemId ? slotNodesRef.current.get(flight.itemId) : null
      const video = videoRef?.current
      if (reduced || window.matchMedia('(prefers-reduced-motion: reduce)').matches
        || !rail || !slot || !video || !flight.sourceRect) {
        finish()
        return
      }

      // Insert + pin happened above; this is only a safety net for a flight
      // that arrives in a later commit than its slot.
      if (followingRef.current) {
        rail.scrollLeft = rail.scrollWidth
      }
      const railRect = rail.getBoundingClientRect()
      const slotRect = slot.getBoundingClientRect()
      // The collector has swiped back: the new card is off-screen inside the
      // rail, so there is nowhere honest for the flyer to land.
      const visible = slotRect.width > 0
        && slotRect.left >= railRect.left - 1
        && slotRect.right <= railRect.right + 1
        && slotRect.top >= railRect.top - 1
        && slotRect.bottom <= railRect.bottom + 1
      if (!visible) {
        finish()
        return
      }
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
      // Land at the slot's on-screen (rotated) box: at 90°/270° the flyer's own
      // dimensions swap, so the destination image is the swapped contained box.
      const destBox = containedRotatedBox({
        width,
        height,
        rotationCW: flight.rotationCW,
        maxWidth: Math.min(SLOT_WIDTH, slotRect.width),
        maxHeight: Math.min(SLOT_HEIGHT, slotRect.height),
      })
      if (!destBox || !(destBox.imageWidth > 0)) {
        finish()
        return
      }
      const endScale = destBox.imageWidth / startWidth
      const endRotation = rotationDegrees(flight.rotationCW)
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
      // Rotate and scale about the centre: translate then positions the centre,
      // so the frame maths stays correct as the card spins to its final angle.
      node.style.transformOrigin = '50% 50%'
      flyerRef.current = node
      document.body.appendChild(node)

      const frames = [0, 0.25, 0.5, 0.75, 1].map(p => {
        const one = 1 - p
        const cx = one * one * startCx + 2 * one * p * controlX + p * p * destCx
        const cy = one * one * startCy + 2 * one * p * controlY + p * p * destCy
        const scale = endScale ** p
        const opacity = p <= fadeStart ? 1 : (1 - p) / (1 - fadeStart)
        return {
          transform: `translate(${cx - startWidth / 2}px, ${cy - startHeight / 2}px) `
            + `rotate(${endRotation * p}deg) scale(${scale})`,
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

  return (
    <div className="relative mt-2 shrink-0 rounded-lg border border-border bg-bg-card px-2 pb-1 pt-1 mb-[env(safe-area-inset-bottom)]">
      {/* Session default for new captures. Reserved at all times so setting or
          clearing it never changes the camera's height. */}
      <div className="flex h-4 items-center text-[10px] leading-none text-text-muted">
        {sessionRotation != null ? (
          <>
            <span>New cards: {sessionRotation}°</span>
            <span className="mx-1">·</span>
            <button
              type="button"
              className="underline decoration-dotted underline-offset-2"
              onClick={onResetSessionRotation}
            >
              Reset
            </button>
          </>
        ) : null}
      </div>

      <div className="relative">
        <div
          ref={railRef}
          onScroll={onRailScroll}
          className="no-scrollbar relative flex h-16 items-center overflow-x-auto overflow-y-hidden capture-tray-rail"
          style={{
            scrollSnapType: 'none',
            scrollBehavior: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}
          aria-label="Capture tray"
        >
          {items.length === 0 ? (
            <p className="px-1 text-[11px] text-text-muted">Captured cards appear here.</p>
          ) : (
            items.map((item, index) => {
              const rotation = rotationDegrees(item.rotationCW)
              // An inset ring rather than a border: the slot's content box stays
              // exactly 54×60, so the swapped rotated image is never clipped by
              // the edge line.
              return (
                <button
                  key={item.id}
                  ref={node => setSlotNode(item.id, node)}
                  type="button"
                  onClick={() => onInspect?.(item.id)}
                  aria-label={`Capture ${item.sequence}${rotation ? `, rotated ${rotation} degrees` : ''}. Tap to inspect.`}
                  className="capture-tray-slot relative shrink-0 overflow-hidden rounded-[3px] bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.6)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-red"
                  style={{
                    width: SLOT_WIDTH,
                    height: SLOT_HEIGHT,
                    marginLeft: index === 0 ? 0 : -SLOT_OVERLAP,
                    zIndex: index + 1,
                    '--fan-offset': `${index - (items.length - 1) / 2}`,
                  }}
                >
                  <TraySlotThumb item={item} />
                </button>
              )
            })
          )}
        </div>

        {edges.left ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-4"
            style={{ background: 'linear-gradient(to right, var(--color-card), transparent)' }}
          />
        ) : null}
        {edges.right ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-4"
            style={{ background: 'linear-gradient(to left, var(--color-card), transparent)' }}
          />
        ) : null}

        {!following ? (
          <button
            type="button"
            onClick={resumeLatest}
            className="absolute right-1 top-1 z-20 rounded-full border border-border bg-bg-elevated/90 px-2 py-0.5 text-[10px] font-medium text-text-primary backdrop-blur-sm"
          >
            Latest →
          </button>
        ) : null}
      </div>

      <div className="flex h-11 items-center gap-2 text-[11px]">
        <span className="min-w-0 flex-1 truncate text-text-secondary">
          {removedNotice ? (
            <>
              Removed #{removedNotice.sequence}
              {' · '}
              <button
                type="button"
                className="underline decoration-dotted underline-offset-2 text-text-primary"
                onClick={removedNotice.onUndo}
              >
                Undo
              </button>
            </>
          ) : full ? (
            <span className="text-yellow">Tray full · Review &amp; send {TRAY_CAPACITY}</span>
          ) : (
            `${count}/${TRAY_CAPACITY} in tray`
          )}
        </span>
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className="btn-ghost-sm h-9 shrink-0 px-2 text-[11px]"
        >
          Undo last
        </button>
        <button
          type="button"
          onClick={onReview}
          disabled={!canReview || reviewBusy}
          className="btn-primary-sm h-9 shrink-0 px-2 text-[11px]"
        >
          {reviewBusy ? 'Sending…' : 'Review & send'}
        </button>
      </div>

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  )
}
