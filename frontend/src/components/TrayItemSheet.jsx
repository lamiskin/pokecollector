import { useEffect, useRef, useState } from 'react'
import { RotateCw, Trash2, X } from 'lucide-react'
import {
  containedRotatedBox,
  normalizeRotation,
  rotationDegrees,
} from '../utils/captureTray'

// The capture's contained photo, previewed with CSS rotation. At 90°/270° the
// contained box is swapped before rotating so no corner is clipped; the layout
// box is sized to the rotated bounding box rather than relying on overflow.
export function RotatedCardPreview({ item, maxHeight = '46vh' }) {
  const frameRef = useRef(null)
  const [frame, setFrame] = useState({ width: 0, height: 0 })
  const degrees = rotationDegrees(item.rotationCW)

  useEffect(() => {
    const node = frameRef.current
    if (!node) return undefined
    if (typeof ResizeObserver === 'undefined') {
      setFrame({ width: node.clientWidth, height: node.clientHeight })
      return undefined
    }
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (box) setFrame({ width: box.width, height: box.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const geometry = item.width && item.height
    ? containedRotatedBox({
      width: item.width,
      height: item.height,
      rotationCW: item.rotationCW,
      maxWidth: frame.width,
      maxHeight: frame.height,
    })
    : null

  const imageStyle = geometry
    ? {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: `${geometry.imageWidth}px`,
      height: `${geometry.imageHeight}px`,
      transform: `translate(-50%, -50%) rotate(${degrees}deg)`,
    }
    : {
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      transform: degrees ? `rotate(${degrees}deg)` : undefined,
    }

  return (
    <div
      ref={frameRef}
      className="relative flex w-full items-center justify-center overflow-hidden rounded border border-border bg-black"
      style={{ height: maxHeight, maxHeight: '440px', minHeight: '200px' }}
    >
      {geometry ? (
        <div
          className="relative shrink-0"
          style={{ width: `${geometry.width}px`, height: `${geometry.height}px` }}
        >
          <img
            src={item.previewUrl}
            alt={`Capture ${item.sequence}`}
            draggable={false}
            className="max-w-none object-contain"
            style={imageStyle}
          />
        </div>
      ) : (
        // No natural dimensions yet: a square frame holds any quarter turn.
        <div
          className="relative shrink-0"
          style={{ width: 'min(100%, 46vh)', height: 'min(100%, 46vh)' }}
        >
          <img
            src={item.previewUrl}
            alt={`Capture ${item.sequence}`}
            draggable={false}
            className="block"
            style={imageStyle}
          />
        </div>
      )}
    </div>
  )
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export default function TrayItemSheet({
  item,
  sessionRotation = null,
  onClose,
  onRotate,
  onUseRotation,
  onRemove,
}) {
  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const restoreRef = useRef(null)
  const closeHandlerRef = useRef(onClose)
  closeHandlerRef.current = onClose

  useEffect(() => {
    const active = typeof document !== 'undefined' ? document.activeElement : null
    restoreRef.current = active instanceof HTMLElement ? active : null
    closeRef.current?.focus()

    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeHandlerRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Only return focus to the card that opened the sheet if it still exists.
      // A card removed from the sheet must not pull focus to a stale node.
      const target = restoreRef.current
      if (target?.isConnected) target.focus()
    }
  }, [])

  const rotation = normalizeRotation(item.rotationCW)
  const rotationLabel = rotation == null ? 'As photographed' : `${rotation}°`
  const newCardsRotation = normalizeRotation(sessionRotation)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-3 sm:items-center"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tray-item-sheet-title"
        className="w-full max-w-md rounded-lg border border-border bg-bg-card p-3 shadow-2xl max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center gap-2">
          <h2
            id="tray-item-sheet-title"
            className="mr-auto text-sm font-semibold text-text-primary"
          >
            Capture #{item.sequence}
          </h2>
          <span className="text-[11px] text-text-secondary">{rotationLabel}</span>
          <button
            ref={closeRef}
            type="button"
            className="btn-ghost-sm h-9 w-9 shrink-0 p-0"
            aria-label="Close capture"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="mt-2">
          <RotatedCardPreview item={item} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost-sm min-h-11 gap-1.5"
            onClick={onRotate}
            aria-label="Rotate 90 degrees clockwise"
          >
            <RotateCw size={16} aria-hidden />
            90°
          </button>
          <button
            type="button"
            className="btn-ghost-sm min-h-11 gap-1.5"
            onClick={onUseRotation}
          >
            Use this rotation for the next cards
          </button>
          <button
            type="button"
            className="btn-ghost-sm ml-auto min-h-11 gap-1.5 text-brand-red"
            onClick={onRemove}
          >
            <Trash2 size={16} aria-hidden />
            Remove
          </button>
        </div>

        <p className="mt-2 text-[11px] text-text-muted">
          {newCardsRotation == null
            ? 'New cards: as photographed'
            : `New cards: ${newCardsRotation}°`}
        </p>
      </div>
    </div>
  )
}
