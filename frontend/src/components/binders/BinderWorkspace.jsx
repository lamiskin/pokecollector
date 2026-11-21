import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BookOpen, Check, GripVertical, LayoutGrid, Move, Undo2, X } from 'lucide-react'
import { CardDisplay } from '../card-system'
import { CollectionCardDisplay } from '../CollectionCardImage'
import Modal from '../ui/Modal'
import ConfirmDialog from '../ui/ConfirmDialog'
import { binderLocationHref, binderMessage, resolveBinderTarget, visibleBinderPages } from '../../utils/binderLayout'
import { resolveCardImageUrl } from '../../utils/imageUrl'
import './binder-layout.css'

function Artwork({ entry, readOnly }) {
  const card = { ...entry, id: entry.card_id }
  const props = { variant: 'artwork', card, image: resolveCardImageUrl(card), alt: entry.name, showStateIndicators: false, interactive: false, variantEffectSource: entry.variant }
  return readOnly ? <CardDisplay {...props} /> : <CollectionCardDisplay {...props} item={{ id: entry.collection_item_id, card, has_scan_photo: entry.has_scan_photo }} />
}

export function BinderPage({ number, layout, placements, entries, selected, highlight, dragTarget, arranging, busy, readOnly, filter, onActivate, onDragStart, onDragEnd, onPointerDragStart, onDrop, t }) {
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
    <div className="mb-3 flex items-center justify-between text-xs text-text-secondary"><h3 className="font-semibold">{binderMessage(t, 'page', { page: number })}</h3><span>{occupied.size} / {slots.length}</span></div>
    <ol ref={pageRef} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0,1fr))` }}>
      {slots.map(slot => {
        const placement = occupied.get(slot)
        const entry = entries.find(e => e.binder_card_id === placement?.binder_card_id)
        const isSelected = placement && selected?.placement_id === placement.id
        const isHighlight = (highlight?.page === number && highlight?.slot === slot) || (dragTarget?.page === number && dragTarget?.slot === slot)
        const matches = filter && entry?.name?.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
        const name = `${binderMessage(t, 'location', { page: number, slot })} · ${entry ? [entry.name, entry.variant, entry.condition].filter(Boolean).join(' · ') : t('binderLayout.emptySlot')}`
        return <li key={slot} className={`binder-pocket relative ${isSelected ? 'binder-pocket-selected' : ''} ${isHighlight || matches ? 'binder-pocket-highlight' : ''}`}>
          <div className="pointer-events-none" aria-hidden="true">{entry ? <Artwork entry={entry} readOnly={readOnly} /> : <div className="binder-empty"><span>{slot}</span></div>}</div>
          <button type="button" data-slot={slot} data-page={number} data-placement={placement?.id} className="binder-pocket-action" aria-label={name} aria-pressed={arranging ? Boolean(isSelected) : undefined} disabled={busy || (readOnly && !entry)} onClick={() => onActivate({ page: number, slot, placement, entry })} onKeyDown={event => keyMove(event, slot)} onDragOver={event => { if (arranging && selected) event.preventDefault() }} onDrop={event => { event.preventDefault(); onDrop(number, slot) }} />
          <span className="binder-slot-number" aria-hidden="true">{slot}</span>
          {arranging && placement && <button type="button" draggable={!busy} className="binder-drag-handle" aria-label={`${t('binderLayout.drag')} ${entry?.name || ''}`} onDragStart={event => onDragStart(event, { placement_id: placement.id, binder_card_id: placement.binder_card_id, entry })} onDragEnd={onDragEnd} onPointerDown={event => onPointerDragStart(event, { placement_id: placement.id, binder_card_id: placement.binder_card_id, entry })}><GripVertical size={15} aria-hidden /></button>}
        </li>
      })}
    </ol>
  </section>
}

export default function BinderWorkspace({ snapshot, readOnly = false, binderId, handle, onOpen, onMove, onUndo, t, accent }) {
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
  const [destinationSlot, setDestinationSlot] = useState(1)
  const [confirmation, setConfirmation] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [width, setWidth] = useState(0)
  const [dwell, setDwell] = useState(null)
  const [pointerTarget, setPointerTarget] = useState(null)
  const [direction, setDirection] = useState(1)
  const root = useRef(null)
  const dragSource = useRef(null)
  const pointerDrag = useRef(null)
  const handlers = useRef({})
  const dwellTimer = useRef(null)
  const dwellLatched = useRef(false)
  const query = params.toString()
  const target = useMemo(() => resolveBinderTarget(snapshot, new URLSearchParams(query)), [snapshot, query])
  const { layout, placements = [], entries = [] } = snapshot
  const sideTray = width >= (layout.columns === 4 ? 1320 : 1120)
  const spread = width - (sideTray ? 296 : 0) >= (layout.columns === 4 ? 1000 : 800)
  const requestedPage = target?.kind === 'slot' ? target.placement.page : page
  const pages = visibleBinderPages(requestedPage, layout.page_count, spread)
  const currentPage = visibleBinderPages(requestedPage, layout.page_count, false)[0]
  const pageOptions = Array.from({ length: layout.page_count }, (_, index) => index + 1)
  const trayEntries = entries.filter(e => e.unplaced_quantity > 0)
  const highlighted = target?.kind === 'slot' ? target.placement : null
  const matchingPlacements = filter ? placements.filter(p => entries.find(e => e.binder_card_id === p.binder_card_id)?.name?.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) : []

  useEffect(() => {
    if (!root.current) return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(root.current)
    return () => observer.disconnect()
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
    const cancel = event => { if (event.key === 'Escape' && !chooser && !confirmation && !busy) { setSelected(null); endDrag() } }
    document.addEventListener('keydown', cancel)
    return () => document.removeEventListener('keydown', cancel)
  }, [selected, chooser, confirmation, busy])
  useEffect(() => () => clearTimeout(dwellTimer.current), [])
  useEffect(() => { handlers.current = { place, endDrag } })
  useEffect(() => {
    const destinationAt = (x, y) => {
      const slot = document.elementFromPoint(x, y)?.closest?.('[data-slot]')
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
    }
    const finish = event => {
      const drag = pointerDrag.current
      if (!drag || event.pointerId !== drag.pointerId) return
      pointerDrag.current = null
      setPointerTarget(null)
      if (!drag.moved) return
      const destination = destinationAt(event.clientX, event.clientY)
      if (destination) handlers.current.place(destination, drag.source)
      handlers.current.endDrag()
    }
    const cancel = () => { pointerDrag.current = null; setPointerTarget(null) }
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
  const select = source => { if (busy) return; setSelected({ ...source, revision: source.revision || snapshot.revision }); setTrayOpen(false); setError(''); setMessage(binderMessage(t, 'selected', { name: source.entry.name })) }
  const focusSlot = (destination, source) => requestAnimationFrame(() => {
    const element = destination.page ? root.current?.querySelector(`[data-page="${destination.page}"][data-slot="${destination.slot}"]`) : root.current?.querySelector(`[data-tray-member="${source.binder_card_id}"]`)
    element?.focus()
  })
  const focusSelection = () => requestAnimationFrame(() => {
    const source = selected?.placement_id ? root.current?.querySelector(`[data-placement="${selected.placement_id}"]`) : root.current?.querySelector(`[data-tray-member="${selected?.binder_card_id}"]`)
    ;(source || root.current?.querySelector('[data-move-selection]'))?.focus()
  })
  const commit = async (destination, source = selected, occupied = false) => {
    if (!source || busy) return
    setBusy(true); setError(''); setMessage(t('binderLayout.saving'))
    try {
      await onMove({ binder_card_id: source.binder_card_id, placement_id: source.placement_id || null, page: destination.page, slot: destination.slot, confirm_occupied: occupied, expected_revision: source.revision })
      setSelected(null); setConfirmation(null); setChooser(false)
      if (destination.page) navigatePage(destination.page)
      else setTrayOpen(true)
      setMessage(t('binderLayout.saved'))
      focusSlot(destination, source)
    } catch (e) { setError(e.message); setMessage(''); setConfirmation(null) }
    finally { setBusy(false) }
  }
  const place = (destination, source = dragSource.current || selected) => {
    if (!source || busy) return
    const occupant = placements.find(p => p.page === destination.page && p.slot === destination.slot)
    // A tray source has no placement id; comparing it to an empty slot would
    // match undefined === undefined and silently swallow the placement.
    if (source.placement_id && occupant?.id === source.placement_id) return
    if (occupant) { setChooser(false); setConfirmation({ source, destination, occupant: entries.find(e => e.binder_card_id === occupant.binder_card_id) }) }
    else commit(destination, source)
  }
  const cancelDwell = () => { clearTimeout(dwellTimer.current); dwellTimer.current = null; setDwell(null); dwellLatched.current = false }
  const endDrag = () => { dragSource.current = null; cancelDwell() }
  const startDrag = (event, source) => { const selection = { ...source, revision: snapshot.revision }; dragSource.current = selection; select(selection); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', source.placement_id || String(source.binder_card_id)) }
  // Touch has no HTML5 drag, so the same grip drives a pointer drag instead.
  // touch-action:none on the grip keeps page scrolling on the card body.
  const startPointerDrag = (event, source) => {
    if (busy || event.pointerType === 'mouse') return
    const selection = { ...source, revision: snapshot.revision }
    select(selection)
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
  const targetText = target?.kind === 'missing' ? t('binderLayout.targetMissing') : target?.kind === 'choices' ? t('binderLayout.targetChoices') : target?.moved ? t('binderLayout.targetMoved') : ''

  return <div ref={root} className="binder-workspace space-y-3" style={{ '--binder-accent': accent || 'var(--color-brand-red)', '--binder-direction': direction }} aria-busy={busy}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-text-secondary">{binderMessage(t, 'summary', { placed: snapshot.placed_count, unplaced: snapshot.unplaced_count, total: layout.page_count * layout.rows * layout.columns })}</p>
      {!readOnly && <div className="flex flex-wrap gap-2">
        <button className={arranging ? 'btn-primary' : 'btn-secondary'} aria-pressed={arranging} disabled={busy} onClick={() => { setArranging(!arranging); setSelected(null); setConfirmation(null) }}>{arranging ? <Check size={16} aria-hidden /> : <Move size={16} aria-hidden />}{arranging ? t('binderLayout.done') : t('binderLayout.arrange')}</button>
        <button className="btn-ghost" disabled={!snapshot.can_undo || busy} onClick={async () => { setBusy(true); setError(''); try { await onUndo(); setMessage(t('binderLayout.undone')); setSelected(null) } catch (e) { setError(e.message) } finally { setBusy(false) } }}><Undo2 size={16} aria-hidden />{t('binderLayout.undo')}</button>
      </div>}
    </div>
    {targetText && <p data-target-notice tabIndex={-1} role="status" className="rounded-xl border border-yellow/30 bg-yellow/5 p-3 text-sm">{targetText}</p>}
    {target?.kind === 'choices' && <ul className="flex flex-wrap gap-2">{target.placements.map(p => <li key={p.id}><Link className="btn-secondary text-xs" to={binderLocationHref({ ...p, placement_id: p.id, binder_id: binderId }, handle)}>{binderMessage(t, 'location', p)}</Link></li>)}</ul>}
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1 text-xs text-text-secondary"><span className="mb-1 block">{t('binderLayout.find')}</span><input className="input w-full" value={filter} onChange={e => setFilter(e.target.value)} /></label>
      {filter && <><span className="py-3 text-xs text-text-secondary">{binderMessage(t, 'matches', { count: matchingPlacements.length })}</span><button className="btn-secondary" disabled={!matchingPlacements.length} onClick={() => { const next = matchingPlacements.find(p => p.page > currentPage) || matchingPlacements[0]; navigatePage(next.page); requestAnimationFrame(() => root.current?.querySelector(`[data-placement="${next.id}"]`)?.focus()) }}>{t('binderLayout.nextMatch')}</button></>}
    </div>
    {arranging && <p className="text-sm text-text-secondary">{t('binderLayout.arrangeHelp')}</p>}
    <nav aria-label={t('binderLayout.navigation')} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-card p-2">
      <button type="button" className={`btn-secondary min-h-11 ${dwell === 'previous' ? 'binder-dwell' : ''}`} disabled={pages[0] <= 1 || busy} onClick={() => navigatePage(pages[0] - (spread ? 2 : 1))} onDragOver={e => dwellOver(e, 'previous', Math.max(1, pages[0] - (spread ? 2 : 1)))} onDragLeave={stopDwell} onDrop={e => { e.preventDefault(); stopDwell() }}><ArrowLeft size={16} aria-hidden /><span className="sr-only sm:not-sr-only">{t('binderLayout.previous')}</span></button>
      <label className="flex items-center gap-2 text-sm"><span className="sr-only">{t('binderLayout.goToPage')}</span><select aria-label={t('binderLayout.goToPage')} className="select min-h-11" value={currentPage} disabled={busy} onChange={e => navigatePage(Number(e.target.value))}>{pageOptions.map(n => <option key={n} value={n}>{binderMessage(t, 'pageOf', { page: n, count: layout.page_count })}</option>)}</select></label>
      <button className="btn-ghost min-h-11" onClick={() => setOverview(true)}><LayoutGrid size={16} aria-hidden /><span className="sr-only sm:not-sr-only">{t('binderLayout.overview')}</span></button>
      <button type="button" className={`btn-secondary min-h-11 ${dwell === 'next' ? 'binder-dwell' : ''}`} disabled={pages.at(-1) >= layout.page_count || busy} onClick={() => navigatePage(pages.at(-1) + 1)} onDragOver={e => dwellOver(e, 'next', Math.min(layout.page_count, pages.at(-1) + 1))} onDragLeave={stopDwell} onDrop={e => { e.preventDefault(); stopDwell() }}><span className="sr-only sm:not-sr-only">{t('binderLayout.next')}</span><ArrowRight size={16} aria-hidden /></button>
    </nav>
    <div className="grid items-start gap-4" style={{ gridTemplateColumns: sideTray ? 'minmax(0,1fr) 280px' : 'minmax(0,1fr)' }}>
      <div className={`binder-spread grid gap-3 ${spread ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {pages.map(number => <div key={number} className="binder-page-reveal"><BinderPage number={number} layout={layout} placements={placements} entries={entries} selected={selected} highlight={highlighted} dragTarget={pointerTarget} arranging={arranging} busy={busy} readOnly={readOnly} filter={filter} onActivate={activate} onDragStart={startDrag} onDragEnd={endDrag} onPointerDragStart={startPointerDrag} onDrop={(page, slot) => { place({ page, slot }); endDrag() }} t={t} /></div>)}
        {spread && pages.length === 1 && <div className="binder-page opacity-30" aria-hidden="true"><BookOpen className="mx-auto mt-12 text-text-muted" size={40} /></div>}
      </div>
      <section className="rounded-2xl border border-border bg-bg-card p-3 space-y-3" aria-label={t('binderLayout.notPlaced')}>
        {sideTray ? <h3 className="flex min-h-11 items-center justify-between gap-2 text-sm font-semibold">{t('binderLayout.notPlaced')}<span className="rounded-full bg-bg-elevated px-2 py-1 tabular-nums">{snapshot.unplaced_count}</span></h3> : <button className="flex min-h-11 w-full items-center justify-between gap-2 text-sm font-semibold" aria-expanded={trayOpen} aria-controls="binder-tray" onClick={() => setTrayOpen(!trayOpen)}>{t('binderLayout.notPlaced')}<span className="rounded-full bg-bg-elevated px-2 py-1 tabular-nums">{snapshot.unplaced_count}</span></button>}
        {(sideTray || trayOpen) && <div id="binder-tray" className="space-y-3">
          <p className="text-xs text-text-secondary">{t('binderLayout.trayHelp')}</p>
          {snapshot.placed_count >= layout.page_count * layout.rows * layout.columns && snapshot.unplaced_count > 0 && <p className="text-xs text-yellow">{t('binderLayout.full')}</p>}
          <label className="block text-xs text-text-secondary">{t('binderLayout.filterTray')}<input className="input mt-1 w-full" value={trayFilter} onChange={e => setTrayFilter(e.target.value)} /></label>
          <ul className="max-h-[32rem] overflow-y-auto space-y-2">
            {trayEntries.filter(e => e.name?.toLocaleLowerCase().includes(trayFilter.toLocaleLowerCase())).map(entry => <li key={entry.binder_card_id} className="rounded-xl border border-border bg-bg-surface p-2">
              <div className="flex items-center gap-3"><div className="w-12 shrink-0" aria-hidden="true"><Artwork entry={entry} readOnly={readOnly} /></div><div className="min-w-0 flex-1"><button data-tray-member={entry.binder_card_id} className="min-h-11 text-left text-sm font-medium underline-offset-4 hover:underline" disabled={busy || (arranging && entry.unresolved)} onClick={() => arranging ? select({ binder_card_id: entry.binder_card_id, entry }) : onOpen?.(entry)}>{entry.name} <span className="text-text-secondary">×{entry.unplaced_quantity}</span></button><p className="text-xs text-text-secondary">{[entry.variant, entry.lang].filter(Boolean).join(' · ')}</p></div>
                {arranging && !entry.unresolved && <button type="button" draggable={!busy} className="binder-tray-drag" aria-label={`${t('binderLayout.drag')} ${entry.name}`} onDragStart={event => startDrag(event, { binder_card_id: entry.binder_card_id, entry })} onDragEnd={endDrag} onPointerDown={event => startPointerDrag(event, { binder_card_id: entry.binder_card_id, entry })}><GripVertical size={16} aria-hidden /></button>}
              </div>
              {entry.unresolved && !readOnly && <p className="mt-2 text-xs text-yellow">{t('binderLayout.unresolved')}</p>}
            </li>)}
          </ul>
          {!trayEntries.length && <p className="text-xs text-text-secondary">{t('binderLayout.trayEmpty')}</p>}
        </div>}
      </section>
    </div>
    {selected && <div className="binder-selection sticky bottom-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg-elevated p-3 shadow-xl" role="region" aria-label={t('binderLayout.selection')}>
      <p className="min-w-32 flex-1 text-sm font-semibold">{binderMessage(t, 'selected', { name: selected.entry.name })}</p>
      <button data-move-selection className="btn-primary" disabled={busy} onClick={() => { setDestinationPage(currentPage); setDestinationSlot(1); setChooser(true) }}>{t('binderLayout.moveTo')}</button>
      {selected.placement_id && <button className="btn-secondary" disabled={busy} onClick={() => commit({ page: null, slot: null })}>{t('binderLayout.returnToTray')}</button>}
      <button className="btn-ghost" disabled={busy} onClick={() => { setSelected(null); endDrag() }}><X size={16} aria-hidden />{t('common.cancel')}</button>
    </div>}
    <div className="text-sm text-text-secondary" role="status" aria-live="polite">{busy ? t('binderLayout.saving') : message}</div>
    {error && <p role="alert" className="rounded-xl border border-brand-red/30 bg-brand-red/5 p-3 text-sm text-brand-red">{error}</p>}
    <Modal isOpen={overview} onClose={() => setOverview(false)} title={t('binderLayout.overview')} size="xl">
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 p-4">{pageOptions.map(number => {
        const count = placements.filter(p => p.page === number).length
        return <button key={number} className={`rounded-xl border p-3 text-left min-h-20 ${pages.includes(number) ? 'border-brand-red bg-brand-red/10' : 'border-border bg-bg-surface'}`} onClick={() => { navigatePage(number); setOverview(false) }}><span className="block text-sm font-semibold">{binderMessage(t, 'page', { page: number })}</span><span className="text-xs text-text-secondary">{count} / {layout.rows * layout.columns}</span></button>
      })}</div>
    </Modal>
    <Modal isOpen={chooser} onClose={busy ? undefined : () => setChooser(false)} title={t('binderLayout.moveTo')}>
      <form className="space-y-4 p-5" onSubmit={event => { event.preventDefault(); place({ page: Number(destinationPage), slot: Number(destinationSlot) }, selected) }}>
        <label className="block space-y-1 text-sm"><span>{t('binderLayout.goToPage')}</span><select className="select w-full" value={destinationPage} onChange={e => setDestinationPage(Number(e.target.value))}>{pageOptions.map(n => <option key={n} value={n}>{binderMessage(t, 'page', { page: n })}</option>)}</select></label>
        <label className="block space-y-1 text-sm"><span>{t('binderLayout.slot')}</span><select className="select w-full" value={destinationSlot} onChange={e => setDestinationSlot(Number(e.target.value))}>{Array.from({ length: layout.rows * layout.columns }, (_, i) => i + 1).map(slot => { const occupant = placements.find(p => p.page === destinationPage && p.slot === slot); const entry = entries.find(e => e.binder_card_id === occupant?.binder_card_id); return <option key={slot} value={slot}>{slot} · {entry?.name || t('binderLayout.emptySlot')}</option> })}</select></label>
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" disabled={busy} onClick={() => setChooser(false)}>{t('common.cancel')}</button><button type="submit" className="btn-primary" disabled={busy}>{t('binderLayout.move')}</button></div>
      </form>
    </Modal>
    <ConfirmDialog isOpen={Boolean(confirmation)} onClose={() => { setConfirmation(null); focusSelection() }} onConfirm={() => commit(confirmation.destination, confirmation.source, true)} title={selected?.placement_id ? t('binderLayout.swapTitle') : t('binderLayout.replaceTitle')} message={confirmation ? binderMessage(t, confirmation.source.placement_id ? 'swapHelp' : 'replaceHelp', { name: confirmation.source.entry.name, other: confirmation.occupant?.name, page: confirmation.destination.page, slot: confirmation.destination.slot }) : ''} confirmLabel={confirmation?.source.placement_id ? t('binderLayout.swap') : t('binderLayout.replace')} cancelLabel={t('common.cancel')} isPending={busy} />
  </div>
}
