import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Check, ChevronDown, GripVertical, LayoutGrid, MousePointerClick, Move, Trash2, Undo2, X } from 'lucide-react'
import Modal from '../ui/Modal'
import ConfirmDialog from '../ui/ConfirmDialog'
import Artwork from './BinderArtwork'
import BinderRemoveDialog from './BinderRemoveDialog'
import { binderLocationHref, binderMessage, resolveBinderTarget, visibleBinderPages } from '../../utils/binderLayout'
import './binder-layout.css'

// Keyboard movement inside the destination grid mirrors the pockets themselves,
// so a chooser opened from the keyboard never needs the mouse.
function gridKeyMove(event, slot, columns, count, container) {
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns, Home: 1 - slot, End: count - slot }
  if (!(event.key in offsets)) return
  event.preventDefault()
  container?.querySelector(`[data-slot-target="${Math.max(1, Math.min(count, slot + offsets[event.key]))}"]`)?.focus()
}

// The bar is the only surface that acts on a selection, so removal lives here
// rather than in a drop target: dropping onto Not placed already means "keep
// this copy in the binder, just unplaced". Removal is therefore always an
// explicit, named action, and the dialog behind it names the copy again.
export function BinderSelectionBar({ t, selected, readOnly = false, busy, sideTray, frame, onMove, onReturn, onRemove, onCancel }) {
  if (!selected || readOnly) return null
  return <div className="binder-selection flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-elevated p-3 shadow-xl sm:gap-3" role="region" aria-label={t('binderLayout.selection')} style={{ '--binder-bar-left': `${frame.left + 12}px`, '--binder-bar-right': `${frame.right + 12 + (sideTray ? 296 : 0)}px` }}>
    <div className="binder-selection-art hidden sm:block" aria-hidden="true"><Artwork entry={selected.entry} /></div>
    <p className="min-w-0 flex-1 text-sm font-semibold">{binderMessage(t, 'selected', { name: selected.entry.name })}</p>
    <button className="btn-ghost min-h-11 min-w-11 px-0 sm:px-4" disabled={busy} onClick={onCancel}><X size={16} aria-hidden /><span className="sr-only sm:not-sr-only">{t('common.cancel')}</span></button>
    {/* No order utilities anywhere in the bar: the phone layout wraps this
        group onto its own rows and the desktop layout keeps it inline, so the
        DOM sequence (Move → Return → Remove) is the rendered sequence at every
        width and Tab never jumps against the eye. */}
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
      <button data-move-selection className="btn-primary min-h-11 w-full sm:w-auto" disabled={busy} onClick={onMove}>{t('binderLayout.moveTo')}</button>
      {selected.placement_id && <button className="btn-secondary min-h-11 w-full sm:w-auto" disabled={busy} onClick={onReturn}>{t('binderLayout.returnToTray')}</button>}
      {onRemove && <button data-remove-selection className="btn-ghost col-span-2 min-h-11 w-full border-brand-red/30 text-brand-red hover:bg-brand-red/10 sm:col-auto sm:w-auto" disabled={busy} onClick={onRemove}><Trash2 size={16} aria-hidden />{t('binderLayout.remove')}</button>}
    </div>
  </div>
}

export function BinderPage({ number, layout, placements, entries, selected, highlight, dragTarget, saved, dragging, arranging, busy, readOnly, filter, onActivate, onDragStart, onDragEnd, onPointerDragStart, onDragTarget, onDrop, t }) {
  const pageRef = useRef(null)
  const slots = Array.from({ length: layout.rows * layout.columns }, (_, i) => i + 1)
  const occupied = new Map(placements.filter(p => p.page === number).map(p => [p.slot, p]))
  const keyMove = (event, slot) => {
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -layout.columns, ArrowDown: layout.columns, Home: 1 - slot, End: slots.length - slot }
    if (!(event.key in offsets)) return
    event.preventDefault()
    pageRef.current?.querySelector(`[data-slot="${Math.max(1, Math.min(slots.length, slot + offsets[event.key]))}"]`)?.focus()
  }
  return <section className="binder-page min-w-0" aria-label={binderMessage(t, 'page', { page: number })}>
    <div className="binder-page-head">
      <h3 className="binder-page-title">{binderMessage(t, 'page', { page: number })}</h3>
      <span className="binder-page-count">{occupied.size} / {slots.length}</span>
    </div>
    <div className="binder-page-meter" aria-hidden="true"><span style={{ width: `${slots.length ? (occupied.size / slots.length) * 100 : 0}%` }} /></div>
    <ol ref={pageRef} className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0,1fr))` }}>
      {slots.map(slot => {
        const placement = occupied.get(slot)
        const entry = entries.find(e => e.binder_card_id === placement?.binder_card_id)
        const isSelected = placement && selected?.placement_id === placement.id
        const isHighlight = (highlight?.page === number && highlight?.slot === slot) || (dragTarget?.page === number && dragTarget?.slot === slot)
        const isSaved = saved?.page === number && saved?.slot === slot
        const matches = filter && entry?.name?.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
        const name = `${binderMessage(t, 'location', { page: number, slot })} · ${entry ? [entry.name, entry.variant, entry.condition].filter(Boolean).join(' · ') : t('binderLayout.emptySlot')}`
        // Empty pockets are not controls in browse mode (or on the public page):
        // a button that does nothing reads as a broken card. They still accept a
        // drop while arranging, where every pocket is a destination.
        const actionable = arranging || Boolean(entry)
        // In arrange mode the whole copy is the mouse drag source; the grip stays
        // as the visible affordance and as the touch handle (touch-action: none),
        // so a finger can still scroll the page over the card body.
        const grabbable = !readOnly && arranging && Boolean(placement)
        const isDragging = Boolean(grabbable && dragging?.placement_id === placement.id)
        return <li key={slot} className={`binder-pocket relative ${entry ? '' : 'binder-pocket-empty'} ${isSelected ? 'binder-pocket-selected' : ''} ${isDragging ? 'binder-pocket-dragging' : ''} ${isHighlight || matches ? 'binder-pocket-highlight' : ''} ${isSaved ? 'binder-pocket-saved' : ''}`}>
          <div className="pointer-events-none" aria-hidden="true">{entry ? <Artwork entry={entry} readOnly={readOnly} /> : <span className="binder-empty" />}</div>
          {actionable ? <button type="button" data-slot={slot} data-page={number} data-placement={placement?.id} className={`binder-pocket-action ${grabbable ? 'binder-pocket-grab' : ''}`} aria-label={name} aria-pressed={arranging ? Boolean(isSelected) : undefined} disabled={busy} draggable={(grabbable && !busy) || undefined} onClick={() => onActivate({ page: number, slot, placement, entry })} onKeyDown={event => keyMove(event, slot)} onDragStart={grabbable ? event => onDragStart(event, { placement_id: placement.id, binder_card_id: placement.binder_card_id, entry }) : undefined} onDragEnd={grabbable ? onDragEnd : undefined} onDragOver={event => { if (arranging && selected) { event.preventDefault(); onDragTarget?.({ page: number, slot }) } }} onDragLeave={() => onDragTarget?.(null)} onDrop={event => { event.preventDefault(); onDrop(number, slot) }} /> : <span className="sr-only">{name}</span>}
          <span className="binder-slot-number" aria-hidden="true">{slot}</span>
          {arranging && placement && <button type="button" draggable={!busy} className="binder-drag-handle" aria-label={`${t('binderLayout.drag')} ${entry?.name || ''}`} title={t('binderLayout.dragHint')} onDragStart={event => onDragStart(event, { placement_id: placement.id, binder_card_id: placement.binder_card_id, entry })} onDragEnd={onDragEnd} onPointerDown={event => onPointerDragStart(event, { placement_id: placement.id, binder_card_id: placement.binder_card_id, entry })}><GripVertical size={15} aria-hidden /></button>}
        </li>
      })}
    </ol>
  </section>
}

// The chooser answers "which pocket?" spatially instead of asking the owner to
// translate "slot 7" into a position on a page.
function DestinationGrid({ t, page, layout, placements, entries, selected, value, onChange, busy, readOnly }) {
  const gridRef = useRef(null)
  const slots = Array.from({ length: layout.rows * layout.columns }, (_, i) => i + 1)
  const occupied = new Map(placements.filter(p => p.page === page).map(p => [p.slot, p]))
  const options = slots.map(slot => {
    const placement = occupied.get(slot)
    const entry = entries.find(e => e.binder_card_id === placement?.binder_card_id)
    const current = Boolean(placement && selected?.placement_id && placement.id === selected.placement_id)
    return { slot, entry, current, label: `${binderMessage(t, 'location', { page, slot })} · ${entry ? entry.name : t('binderLayout.emptySlot')}${current ? ` · ${t('binderLayout.currentSlot')}` : ''}` }
  })
  const choose = option => { if (busy || option.current) return; onChange(option.slot) }
  return <div ref={gridRef} role="group" aria-label={t('binderLayout.slot')} className="binder-slot-grid grid gap-2" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0,1fr))` }}>
    {options.map(option => {
      const chosen = value === option.slot && !option.current
      return <button
        key={option.slot}
        type="button"
        data-slot-target={option.slot}
        aria-label={option.label}
        aria-pressed={chosen}
        aria-disabled={busy || option.current || undefined}
        className={`binder-slot-option ${option.entry ? '' : 'binder-slot-option-empty'} ${chosen ? 'binder-slot-option-chosen' : ''} ${option.current ? 'binder-slot-option-current' : ''}`}
        onClick={() => choose(option)}
        onKeyDown={event => gridKeyMove(event, option.slot, layout.columns, slots.length, gridRef.current)}
      >
        <span className="binder-slot-art" aria-hidden="true">{option.entry ? <Artwork entry={option.entry} readOnly={readOnly} /> : <span className="binder-empty" />}</span>
        <span className="binder-slot-number" aria-hidden="true">{option.slot}</span>
        {option.entry && <span className="binder-slot-name" aria-hidden="true">{option.entry.name}</span>}
        {chosen && <span className="binder-slot-check" aria-hidden="true"><Check size={13} /></span>}
        {option.current && <span className="binder-slot-tag">{t('binderLayout.currentSlot')}</span>}
      </button>
    })}
  </div>
}

export default function BinderWorkspace({ snapshot, readOnly = false, binderId, handle, onOpen, onMove, onUndo, onRemove, t, accent }) {
  const [params, setParams] = useSearchParams()
  const [page, setPage] = useState(() => Number(params.get('page')) || 1)
  const [arranging, setArranging] = useState(false)
  const [selected, setSelected] = useState(null)
  const [trayOpen, setTrayOpen] = useState(Boolean(params.get('tray')))
  const [trayFilter, setTrayFilter] = useState('')
  const [filter, setFilter] = useState('')
  const [overview, setOverview] = useState(false)
  const [chooser, setChooser] = useState(false)
  const [destinationPage, setDestinationPage] = useState(1)
  const [destinationSlot, setDestinationSlot] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [removing, setRemoving] = useState(false)
  const [removeStep, setRemoveStep] = useState('choose')
  const [removePending, setRemovePending] = useState(null)
  const [removeError, setRemoveError] = useState('')
  const [removeStale, setRemoveStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [width, setWidth] = useState(0)
  const [frame, setFrame] = useState({ left: 0, right: 0 })
  const [dwell, setDwell] = useState(null)
  const [pointerTarget, setPointerTarget] = useState(null)
  const [savedPocket, setSavedPocket] = useState(null)
  const [dragging, setDragging] = useState(null)
  const [dragGhost, setDragGhost] = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [trayDrag, setTrayDrag] = useState(false)
  const [direction, setDirection] = useState(1)
  const root = useRef(null)
  const statusRef = useRef(null)
  const dragSource = useRef(null)
  const dragOrigin = useRef(null)
  const pointerDrag = useRef(null)
  const handlers = useRef({})
  const dwellTimer = useRef(null)
  const dwellLatched = useRef(false)
  const savedTimer = useRef(null)
  const query = params.toString()
  const target = useMemo(() => resolveBinderTarget(snapshot, new URLSearchParams(query)), [snapshot, query])
  const { layout, placements = [], entries = [] } = snapshot
  const sideTray = width >= (layout.columns === 4 ? 1320 : 1120)
  const spread = width - (sideTray ? 296 : 0) >= (layout.columns === 4 ? 1000 : 800)
  const requestedPage = target?.kind === 'slot' ? target.placement.page : page
  const pages = visibleBinderPages(requestedPage, layout.page_count, spread, layout.first_page_single)
  const currentPage = visibleBinderPages(requestedPage, layout.page_count, false)[0]
  const pageOptions = Array.from({ length: layout.page_count }, (_, index) => index + 1)
  const pageSlotCount = layout.rows * layout.columns
  const trayEntries = entries.filter(e => e.unplaced_quantity > 0)
  const highlighted = target?.kind === 'slot' ? target.placement : null
  const matchingPlacements = filter ? placements.filter(p => entries.find(e => e.binder_card_id === p.binder_card_id)?.name?.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) : []
  const destinationOccupancy = placements.filter(p => p.page === destinationPage).length
  // The selection stores copy identity, not coordinates, so the dialog resolves
  // the pocket from the current snapshot to show where this copy sits now.
  const selectedPlacement = selected?.placement_id ? placements.find(p => p.id === selected.placement_id) : null
  const selectedLocation = selectedPlacement ? binderMessage(t, 'location', { page: selectedPlacement.page, slot: selectedPlacement.slot }) : t('binderLayout.notPlaced')

  useEffect(() => {
    if (!root.current) return undefined
    // The selection bar is fixed because an ancestor's overflow makes sticky
    // inert, so it also needs the workspace's own insets: the shell padding and
    // the side tray change the space the bar may occupy.
    const measure = () => {
      const rect = root.current?.getBoundingClientRect()
      if (!rect) return
      setWidth(rect.width)
      setFrame({ left: rect.left, right: window.innerWidth - rect.right })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(root.current)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  useEffect(() => {
    if (target?.kind === 'tray') setTrayOpen(true)
  }, [target])

  useEffect(() => {
    if (!target) return undefined
    if (target.kind === 'tray' && !trayOpen && !sideTray) return undefined
    const timer = requestAnimationFrame(() => {
      const selector = target.kind === 'slot' ? `[data-placement="${target.placement.id}"]` : target.kind === 'tray' ? `[data-tray-member="${target.entry.binder_card_id}"]` : '[data-target-notice]'
      root.current?.querySelector(selector)?.focus()
    })
    return () => cancelAnimationFrame(timer)
  }, [target, spread, trayOpen, sideTray])

  useEffect(() => {
    if (!selected) return undefined
    const cancel = event => { if (event.key === 'Escape' && !chooser && !confirmation && !removing && !busy) { setSelected(null); endDrag() } }
    document.addEventListener('keydown', cancel)
    return () => document.removeEventListener('keydown', cancel)
  }, [selected, chooser, confirmation, removing, busy])
  useEffect(() => () => clearTimeout(dwellTimer.current), [])
  useEffect(() => () => clearTimeout(savedTimer.current), [])
  useEffect(() => { handlers.current = { place, endDrag } })
  useEffect(() => {
    const destinationAt = (x, y) => {
      const element = document.elementFromPoint(x, y)
      if (element?.closest?.('[data-tray-drop]')) return { tray: true }
      const slot = element?.closest?.('[data-slot]')
      return slot ? { page: Number(slot.dataset.page), slot: Number(slot.dataset.slot) } : null
    }
    const move = event => {
      const drag = pointerDrag.current
      if (!drag || event.pointerId !== drag.pointerId) return
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return
        drag.moved = true
      }
      setPointerTarget(destinationAt(event.clientX, event.clientY))
      updateGhostAt(event.clientX, event.clientY)
    }
    const finish = event => {
      const drag = pointerDrag.current
      if (!drag || event.pointerId !== drag.pointerId) return
      pointerDrag.current = null
      setPointerTarget(null)
      if (drag.moved) {
        const destination = destinationAt(event.clientX, event.clientY)
        if (destination) handlers.current.place(destination, drag.source)
      }
      handlers.current.endDrag()
    }
    // Chromium also cancels the pointer when a native HTML5 drag takes over,
    // so only a pointer drag of our own may end here.
    const cancel = () => {
      if (!pointerDrag.current) return
      pointerDrag.current = null
      setPointerTarget(null)
      handlers.current.endDrag()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [])

  const navigatePage = next => {
    const value = Math.max(1, Math.min(layout.page_count, next))
    setDirection(value < currentPage ? -1 : 1)
    setPage(value)
    const nextParams = new URLSearchParams(params)
    ;['placement', 'member', 'card', 'slot', 'tray'].forEach(key => nextParams.delete(key))
    nextParams.set('page', String(value))
    nextParams.set('view', 'pages')
    setParams(nextParams, { replace: true, preventScrollReset: true })
  }
  // A refresh must not silently authorize an old selection against newer data.
  // The selection bar is the feedback for selecting; the status line stays
  // reserved for outcomes so the two never say the same thing twice.
  const select = (source, { keepTray = false } = {}) => { if (busy) return; setSelected({ ...source, revision: source.revision || snapshot.revision }); if (!keepTray) setTrayOpen(false); setError(''); setMessage('') }
  const focusSlot = (destination, source) => requestAnimationFrame(() => {
    const element = destination.page ? root.current?.querySelector(`[data-page="${destination.page}"][data-slot="${destination.slot}"]`) : root.current?.querySelector(`[data-tray-member="${source.binder_card_id}"]`)
    element?.focus()
  })
  const focusSelection = () => requestAnimationFrame(() => {
    const source = selected?.placement_id ? root.current?.querySelector(`[data-placement="${selected.placement_id}"]`) : root.current?.querySelector(`[data-tray-member="${selected?.binder_card_id}"]`)
    ;(source || root.current?.querySelector('[data-move-selection]'))?.focus()
  })
  const flashSaved = (destination, source) => {
    clearTimeout(savedTimer.current)
    setSavedPocket(destination?.page
      ? { page: destination.page, slot: destination.slot }
      : source?.binder_card_id ? { tray: source.binder_card_id } : null)
    savedTimer.current = setTimeout(() => setSavedPocket(null), 1400)
  }
  const commit = async (destination, source = selected, occupied = false) => {
    if (!source || busy) return
    setBusy(true); setError(''); setMessage(t('binderLayout.saving'))
    try {
      await onMove({ binder_card_id: source.binder_card_id, placement_id: source.placement_id || null, page: destination.page, slot: destination.slot, confirm_occupied: occupied, expected_revision: source.revision })
      setSelected(null); setConfirmation(null); setChooser(false)
      if (destination.page) navigatePage(destination.page)
      else setTrayOpen(true)
      setMessage(t('binderLayout.saved'))
      flashSaved(destination, source)
      focusSlot(destination, source)
    } catch (e) { setError(e.message); setMessage(''); setConfirmation(null) }
    finally { setBusy(false) }
  }
  const place = (destination, source = dragSource.current || selected) => {
    if (!source || busy) return
    if (destination?.tray) { returnToTray(source); return }
    const occupant = placements.find(p => p.page === destination.page && p.slot === destination.slot)
    // A tray source has no placement id; comparing it to an empty slot would
    // match undefined === undefined and silently swallow the placement.
    if (source.placement_id && occupant?.id === source.placement_id) return
    if (occupant) { setChooser(false); setConfirmation({ source, destination, occupant: entries.find(e => e.binder_card_id === occupant.binder_card_id) }) }
    else commit(destination, source)
  }
  // The same operation as the "Return to Not placed" button, used by both the
  // tray drop zone and the selection bar. A tray-origin copy has nothing to
  // return, so dropping it back on the tray is deliberately a no-op.
  const returnToTray = (source = dragSource.current || selected) => {
    if (!source || busy || !source.placement_id) return
    commit({ page: null, slot: null }, source)
  }
  const cancelDwell = () => { clearTimeout(dwellTimer.current); dwellTimer.current = null; setDwell(null); dwellLatched.current = false }
  const endDrag = () => {
    dragSource.current = null
    dragOrigin.current = null
    setDragGhost(null)
    setDragging(null)
    setDragOver(null)
    setTrayDrag(false)
    cancelDwell()
  }
  // The held copy follows the pointer and leans with the direction of travel.
  // The ghost is fixed and pointer-events: none, so it can never intercept a drop.
  const updateGhostAt = (x, y) => {
    if (!dragSource.current) return
    if (!x && !y) return
    const origin = dragOrigin.current
    const tilt = origin == null ? 0 : Math.max(-12, Math.min(12, Math.round((x - origin) / 12)))
    // Dragover fires continuously; skip sub-pixel work so the workspace is not
    // re-rendered for every event of a long drag.
    setDragGhost(previous => (previous && Math.hypot(x - previous.x, y - previous.y) < 3 && previous.tilt === tilt ? previous : { x, y, tilt }))
  }
  // Repeating a highlight over the same pocket must not re-render the workspace.
  const markDragTarget = target => {
    setDragOver(previous => (previous && target && previous.page === target.page && previous.slot === target.slot ? previous : target))
  }
  const startDrag = (event, source) => {
    const selection = { ...source, revision: snapshot.revision }
    const rect = event.currentTarget?.getBoundingClientRect?.()
    dragSource.current = selection
    dragOrigin.current = rect ? rect.left + rect.width / 2 : null
    select(selection, { keepTray: true })
    setDragging({ placement_id: source.placement_id, binder_card_id: source.binder_card_id })
    setDragGhost({ x: rect ? rect.left + rect.width / 2 : event.clientX, y: rect ? rect.top + rect.height / 2 : event.clientY, tilt: 0 })
    // Hide the browser's own drag image; the card ghost is the feedback.
    const blank = new Image()
    blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    try { event.dataTransfer?.setDragImage?.(blank, 0, 0) } catch { /* not supported everywhere */ }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', source.placement_id || String(source.binder_card_id))
  }
  // Touch has no HTML5 drag, so the grip drives a pointer drag instead.
  // touch-action:none on the grip keeps page scrolling on the card body.
  const startPointerDrag = (event, source) => {
    if (busy || event.pointerType === 'mouse') return
    const selection = { ...source, revision: snapshot.revision }
    const rect = event.currentTarget?.getBoundingClientRect?.()
    select(selection, { keepTray: true })
    setDragging({ placement_id: source.placement_id, binder_card_id: source.binder_card_id })
    setDragGhost({ x: event.clientX, y: event.clientY, tilt: 0 })
    dragOrigin.current = rect ? rect.left + rect.width / 2 : event.clientX
    pointerDrag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, source: selection }
  }
  const dwellOver = (event, direction, next) => {
    if (!dragSource.current || busy) return
    event.preventDefault()
    if (dwellLatched.current || dwellTimer.current) return
    setDwell(direction)
    dwellTimer.current = setTimeout(() => {
      dwellTimer.current = null; dwellLatched.current = true; setDwell(null)
      navigatePage(next); setMessage(binderMessage(t, 'page', { page: next }))
    }, 650)
  }
  const stopDwell = () => { cancelDwell(); dwellTimer.current = null }
  const activate = ({ page: number, slot, placement, entry }) => {
    if (!arranging) { if (entry) onOpen?.(entry); return }
    if (selected) place({ page: number, slot }, selected)
    else if (placement) select({ placement_id: placement.id, binder_card_id: placement.binder_card_id, entry })
  }
  const openChooser = () => { setDestinationPage(currentPage); setDestinationSlot(null); setError(''); setChooser(true) }
  const openRemove = () => { setRemoveStep('choose'); setRemovePending(null); setRemoveError(''); setRemoveStale(false); setRemoving(true) }
  const closeRemove = () => {
    if (busy) return
    setRemoving(false); setRemoveStep('choose'); setRemoveError(''); setRemoveStale(false)
  }
  // Nothing is removed locally: the server answers with the next snapshot, so a
  // refused, stale or product-protected request leaves the binder as it was and
  // its message stays inside the dialog next to the action that raised it.
  const removeCopy = async removeOwned => {
    if (!selected || busy || !onRemove) return
    const source = selected
    setBusy(true); setRemovePending(removeOwned ? 'collection' : 'binder'); setRemoveError(''); setRemoveStale(false); setMessage('')
    try {
      await onRemove({ binder_card_id: source.binder_card_id, placement_id: source.placement_id || null, remove_owned_copy: removeOwned, expected_revision: source.revision })
      setRemoving(false); setRemoveStep('choose'); setSelected(null); endDrag()
      setMessage(removeOwned ? t('binderLayout.removedFromCollection') : t('binderLayout.removedFromBinder'))
      requestAnimationFrame(() => statusRef.current?.focus())
    } catch (e) {
      setRemoveError(e.message)
      setRemoveStale(e.status === 409)
    } finally { setBusy(false); setRemovePending(null) }
  }
  const trayTargeted = trayDrag || Boolean(pointerTarget?.tray)
  const spreadSingle = spread && pages.length === 1
  const targetText = target?.kind === 'missing' ? t('binderLayout.targetMissing') : target?.kind === 'choices' ? t('binderLayout.targetChoices') : target?.moved ? t('binderLayout.targetMoved') : ''

  return <div ref={root} className={`binder-workspace space-y-3 ${selected ? 'binder-has-selection' : ''}`} style={{ '--binder-accent': accent || 'var(--color-brand-red)', '--binder-direction': direction }} aria-busy={busy} onDragOver={event => updateGhostAt(event.clientX, event.clientY)}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-text-secondary">{binderMessage(t, 'summary', { placed: snapshot.placed_count, unplaced: snapshot.unplaced_count, total: layout.page_count * layout.rows * layout.columns })}</p>
      {!readOnly && <div className="flex flex-wrap gap-2">
        <button className={`${arranging ? 'btn-primary' : 'btn-secondary'} min-h-11`} aria-pressed={arranging} disabled={busy} onClick={() => { setArranging(!arranging); setSelected(null); setConfirmation(null); setError('') }}>{arranging ? <Check size={16} aria-hidden /> : <Move size={16} aria-hidden />}{arranging ? t('binderLayout.done') : t('binderLayout.arrange')}</button>
        <button className="btn-ghost min-h-11" disabled={!snapshot.can_undo || busy} onClick={async () => { setBusy(true); setError(''); try { await onUndo(); setMessage(t('binderLayout.undone')); setSelected(null) } catch (e) { setError(e.message) } finally { setBusy(false) } }}><Undo2 size={16} aria-hidden />{t('binderLayout.undo')}</button>
      </div>}
    </div>
    {targetText && <p data-target-notice tabIndex={-1} role="status" className="rounded-xl border border-yellow/30 bg-yellow/5 p-3 text-sm">{targetText}</p>}
    {target?.kind === 'choices' && <ul className="flex flex-wrap gap-2">{target.placements.map(p => <li key={p.id}><Link className="btn-secondary text-xs" to={binderLocationHref({ ...p, placement_id: p.id, binder_id: binderId }, handle)}>{binderMessage(t, 'location', p)}</Link></li>)}</ul>}
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1 text-xs text-text-secondary"><span className="mb-1 block">{t('binderLayout.find')}</span><input className="input w-full" value={filter} onChange={e => setFilter(e.target.value)} /></label>
      {filter && <><span className="py-3 text-xs text-text-secondary">{binderMessage(t, 'matches', { count: matchingPlacements.length })}</span><button className="btn-secondary min-h-11" disabled={!matchingPlacements.length} onClick={() => { const next = matchingPlacements.find(p => p.page > currentPage) || matchingPlacements[0]; navigatePage(next.page); requestAnimationFrame(() => root.current?.querySelector(`[data-placement="${next.id}"]`)?.focus()) }}>{t('binderLayout.nextMatch')}</button></>}
    </div>
    {arranging && <>
      {/* The full instructions stay available to screen readers; the visible
          version is three scannable hints instead of one dense paragraph. */}
      <p className="sr-only">{t('binderLayout.arrangeHelp')}</p>
      <ul className="binder-hints" aria-hidden="true">
        <li className="binder-hint"><MousePointerClick size={14} />{t('binderLayout.arrangeHintSelect')}</li>
        <li className="binder-hint"><GripVertical size={14} />{t('binderLayout.arrangeHintDrag')}</li>
        <li className="binder-hint"><ArrowRight size={14} />{t('binderLayout.arrangeHintTurn')}</li>
      </ul>
    </>}
    {!readOnly && !arranging && snapshot.placed_count === 0 && snapshot.unplaced_count > 0 && <p className="binder-empty-state">{t('binderLayout.emptyBinder')}</p>}
    <nav aria-label={t('binderLayout.navigation')} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-card p-2">
      <button type="button" className={`btn-secondary order-1 min-h-11 ${dwell === 'previous' ? 'binder-dwell' : ''}`} disabled={pages[0] <= 1 || busy} onClick={() => navigatePage(pages[0] - (spread ? 2 : 1))} onDragOver={e => dwellOver(e, 'previous', Math.max(1, pages[0] - (spread ? 2 : 1)))} onDragLeave={stopDwell} onDrop={e => { e.preventDefault(); stopDwell() }}><ArrowLeft size={16} aria-hidden /><span className="sr-only sm:not-sr-only">{t('binderLayout.previous')}</span></button>
      <label className="order-2 flex min-w-0 flex-1 items-center gap-2 text-sm sm:flex-none"><span className="sr-only">{t('binderLayout.goToPage')}</span><select aria-label={t('binderLayout.goToPage')} className="select min-h-11 w-full sm:w-auto" value={currentPage} disabled={busy} onChange={e => navigatePage(Number(e.target.value))}>{pageOptions.map(n => <option key={n} value={n}>{binderMessage(t, 'pageOf', { page: n, count: layout.page_count })}</option>)}</select></label>
      <button className="btn-ghost order-4 min-h-11 basis-full justify-center sm:order-3 sm:basis-auto" onClick={() => setOverview(true)}><LayoutGrid size={16} aria-hidden />{t('binderLayout.overview')}</button>
      <button type="button" className={`btn-secondary order-3 min-h-11 sm:order-4 ${dwell === 'next' ? 'binder-dwell' : ''}`} disabled={pages.at(-1) >= layout.page_count || busy} onClick={() => navigatePage(pages.at(-1) + 1)} onDragOver={e => dwellOver(e, 'next', Math.min(layout.page_count, pages.at(-1) + 1))} onDragLeave={stopDwell} onDrop={e => { e.preventDefault(); stopDwell() }}><span className="sr-only sm:not-sr-only">{t('binderLayout.next')}</span><ArrowRight size={16} aria-hidden /></button>
    </nav>
    <div className="grid items-start gap-4" style={{ gridTemplateColumns: sideTray ? 'minmax(0,1fr) 280px' : 'minmax(0,1fr)' }}>
      <div className={`binder-spread gap-3 ${spreadSingle ? 'binder-spread-single' : spread ? 'grid grid-cols-2' : 'grid grid-cols-1'}`}>
        {pages.map(number => <div key={number} className="binder-page-reveal"><BinderPage number={number} layout={layout} placements={placements} entries={entries} selected={selected} highlight={highlighted} dragTarget={pointerTarget || dragOver} saved={savedPocket} dragging={dragging} arranging={arranging} busy={busy} readOnly={readOnly} filter={filter} onActivate={activate} onDragStart={startDrag} onDragEnd={endDrag} onPointerDragStart={startPointerDrag} onDragTarget={markDragTarget} onDrop={(page, slot) => { place({ page, slot }); endDrag() }} t={t} /></div>)}
      </div>
      <section
        className={`binder-tray rounded-2xl border border-border bg-bg-card p-3 space-y-3 ${trayTargeted ? 'binder-tray-drop' : ''}`}
        aria-label={t('binderLayout.notPlaced')}
        data-tray-drop=""
        onDragEnter={event => { if (!dragSource.current) return; event.preventDefault(); setTrayDrag(true) }}
        onDragOver={event => { if (!dragSource.current) return; event.preventDefault(); if (!trayDrag) setTrayDrag(true) }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setTrayDrag(false) }}
        onDrop={event => { if (!dragSource.current) return; event.preventDefault(); setTrayDrag(false); returnToTray(); endDrag() }}
      >
        {sideTray ? <h3 className="flex min-h-11 items-center justify-between gap-2 text-sm font-semibold">{t('binderLayout.notPlaced')}<span className="binder-tray-count">{snapshot.unplaced_count}</span></h3> : <button type="button" className="binder-tray-toggle flex min-h-11 w-full items-center justify-between gap-2 text-sm font-semibold" aria-expanded={trayOpen} aria-controls="binder-tray" onClick={() => setTrayOpen(!trayOpen)}><span className="flex items-center gap-2"><ChevronDown size={16} className={trayOpen ? 'binder-tray-chevron-open' : ''} aria-hidden />{t('binderLayout.notPlaced')}</span><span className="binder-tray-count">{snapshot.unplaced_count}</span></button>}
        {trayTargeted && <p className="binder-tray-drop-hint">{t('binderLayout.dropToTray')}</p>}
        {(sideTray || trayOpen) && <div id="binder-tray" className="space-y-3">
          <p className="text-xs text-text-secondary">{readOnly ? t('binderLayout.trayHelpPublic') : t('binderLayout.trayHelp')}</p>
          {snapshot.placed_count >= pageSlotCount && snapshot.unplaced_count > 0 && <p className="text-xs text-yellow">{t('binderLayout.full')}</p>}
          <label className="block text-xs text-text-secondary">{t('binderLayout.filterTray')}<input className="input mt-1 w-full" value={trayFilter} onChange={e => setTrayFilter(e.target.value)} /></label>
          <ul className="max-h-[32rem] overflow-y-auto space-y-2">
            {trayEntries.filter(e => e.name?.toLocaleLowerCase().includes(trayFilter.toLocaleLowerCase())).map(entry => <li
              key={entry.binder_card_id}
              data-tray-row={entry.binder_card_id}
              className={`rounded-xl border border-border bg-bg-surface p-2 ${arranging && !entry.unresolved && !busy ? 'binder-tray-grab' : ''} ${dragging?.binder_card_id === entry.binder_card_id ? 'binder-tray-row-dragging' : ''} ${savedPocket?.tray === entry.binder_card_id ? 'binder-tray-saved' : ''}`}
              draggable={(!readOnly && arranging && !entry.unresolved && !busy) || undefined}
              onDragStart={arranging && !entry.unresolved && !busy ? event => startDrag(event, { binder_card_id: entry.binder_card_id, entry }) : undefined}
              onDragEnd={arranging && !entry.unresolved ? endDrag : undefined}
            >
              <div className="flex items-center gap-3"><div className="w-12 shrink-0" aria-hidden="true"><Artwork entry={entry} readOnly={readOnly} /></div><div className="min-w-0 flex-1"><button data-tray-member={entry.binder_card_id} className="min-h-11 text-left text-sm font-medium underline-offset-4 hover:underline" disabled={busy || (arranging && entry.unresolved)} onClick={() => arranging ? select({ binder_card_id: entry.binder_card_id, entry }) : onOpen?.(entry)}>{entry.name} <span className="text-text-secondary">×{entry.unplaced_quantity}</span></button><p className="text-xs text-text-secondary">{[entry.variant, entry.lang].filter(Boolean).join(' · ')}</p></div>
                {arranging && !entry.unresolved && <button type="button" draggable={!busy} className="binder-tray-drag" aria-label={`${t('binderLayout.drag')} ${entry.name}`} title={t('binderLayout.dragHint')} onDragStart={event => startDrag(event, { binder_card_id: entry.binder_card_id, entry })} onDragEnd={endDrag} onPointerDown={event => startPointerDrag(event, { binder_card_id: entry.binder_card_id, entry })}><GripVertical size={16} aria-hidden /></button>}
              </div>
              {entry.unresolved && !readOnly && <p className="mt-2 text-xs text-yellow">{t('binderLayout.unresolved')}</p>}
            </li>)}
          </ul>
          {!trayEntries.length && <p className="text-xs text-text-secondary">{t('binderLayout.trayEmpty')}</p>}
        </div>}
      </section>
    </div>
    {dragGhost && dragSource.current?.entry && <div className="binder-drag-ghost" aria-hidden="true" style={{ left: `${dragGhost.x}px`, top: `${dragGhost.y}px`, '--binder-ghost-tilt': `${dragGhost.tilt}deg` }}><Artwork entry={dragSource.current.entry} readOnly={readOnly} /></div>}
    {selected && !dragging && <BinderSelectionBar t={t} selected={selected} readOnly={readOnly} busy={busy} sideTray={sideTray} frame={frame} onMove={openChooser} onReturn={() => returnToTray(selected)} onRemove={onRemove ? openRemove : undefined} onCancel={() => { setSelected(null); endDrag() }} />}
    <div ref={statusRef} tabIndex={-1} className="text-sm text-text-secondary" role="status" aria-live="polite">{busy ? t('binderLayout.saving') : message}</div>
    {error && !chooser && <p role="alert" className="rounded-xl border border-brand-red/30 bg-brand-red/5 p-3 text-sm text-brand-red">{error}</p>}
    <Modal isOpen={overview} onClose={() => setOverview(false)} title={t('binderLayout.overview')} size="xl">
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 p-4">{pageOptions.map(number => {
        const count = placements.filter(p => p.page === number).length
        return <button key={number} className={`binder-overview-page min-h-20 ${pages.includes(number) ? 'binder-overview-page-active' : ''}`} aria-pressed={pages.includes(number)} onClick={() => { navigatePage(number); setOverview(false) }}>
          <span className="flex items-baseline justify-between gap-2"><span className="text-sm font-semibold">{binderMessage(t, 'page', { page: number })}</span><span className="text-xs tabular-nums text-text-secondary">{count} / {pageSlotCount}</span></span>
          <span className="binder-page-meter mt-2"><span style={{ width: `${pageSlotCount ? (count / pageSlotCount) * 100 : 0}%` }} /></span>
        </button>
      })}</div>
    </Modal>
    {selected && <Modal isOpen={chooser} onClose={busy ? undefined : () => setChooser(false)} title={t('binderLayout.moveTo')}>
      <form className="space-y-4 p-4 sm:p-5" onSubmit={event => { event.preventDefault(); if (destinationSlot) place({ page: destinationPage, slot: destinationSlot }, selected) }}>
        <div className="mx-auto w-full max-w-[22rem] space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-surface p-2">
            <div className="w-9 shrink-0" aria-hidden="true"><Artwork entry={selected.entry} readOnly={readOnly} /></div>
            <p className="text-sm font-semibold">{binderMessage(t, 'selected', { name: selected.entry.name })}</p>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <label className="block space-y-1 text-sm"><span>{t('binderLayout.goToPage')}</span><select className="select min-h-11 w-full" value={destinationPage} disabled={busy} onChange={e => { setDestinationPage(Number(e.target.value)); setDestinationSlot(null) }}>{pageOptions.map(n => <option key={n} value={n}>{binderMessage(t, 'page', { page: n })}</option>)}</select></label>
            <p className="pb-3 text-xs text-text-secondary">{binderMessage(t, 'pageFree', { free: pageSlotCount - destinationOccupancy, total: pageSlotCount })}</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('binderLayout.slot')}</p>
            <DestinationGrid t={t} page={destinationPage} layout={layout} placements={placements} entries={entries} selected={selected} value={destinationSlot} onChange={setDestinationSlot} busy={busy} readOnly={readOnly} />
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-brand-red">{error}</p>}
        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-bg-card px-4 py-3 sm:-mx-5 sm:px-5">
          <p className="text-xs text-text-secondary" aria-live="polite">{destinationSlot ? binderMessage(t, 'location', { page: destinationPage, slot: destinationSlot }) : t('binderLayout.chooseSlot')}</p>
          <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={() => setChooser(false)}>{t('common.cancel')}</button><button type="submit" className="btn-primary min-h-11" disabled={busy || !destinationSlot}>{t('binderLayout.move')}</button></div>
        </div>
      </form>
    </Modal>}
    {selected && onRemove && <BinderRemoveDialog
      isOpen={removing}
      t={t}
      entry={selected.entry}
      location={selectedLocation}
      step={removeStep}
      pending={removePending}
      stale={removeStale}
      error={removeError}
      onClose={closeRemove}
      onRemoveBinder={() => removeCopy(false)}
      onRemoveCollection={() => { setRemoveError(''); setRemoveStale(false); setRemoveStep('confirm') }}
      onBack={() => { setRemoveError(''); setRemoveStale(false); setRemoveStep('choose') }}
      onConfirm={() => removeCopy(true)}
    />}
    <ConfirmDialog isOpen={Boolean(confirmation)} onClose={() => { setConfirmation(null); focusSelection() }} onConfirm={() => commit(confirmation.destination, confirmation.source, true)} title={selected?.placement_id ? t('binderLayout.swapTitle') : t('binderLayout.replaceTitle')} message={confirmation ? binderMessage(t, confirmation.source.placement_id ? 'swapHelp' : 'replaceHelp', { name: confirmation.source.entry.name, other: confirmation.occupant?.name, page: confirmation.destination.page, slot: confirmation.destination.slot }) : ''} confirmLabel={confirmation?.source.placement_id ? t('binderLayout.swap') : t('binderLayout.replace')} cancelLabel={t('common.cancel')} isPending={busy} />
  </div>
}
