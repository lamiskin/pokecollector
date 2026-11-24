import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, MapPin, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { getApiErrorMessage, getCardLocations, removeBinderCopy } from '../../api/client'
import { getPublicCardLocations } from '../../api/publicClient'
import { useConfirmDialog } from '../../contexts/ConfirmDialogContext'
import { useSettings } from '../../contexts/SettingsContext'
import { binderLocationHref, binderMessage } from '../../utils/binderLayout'

const locationKey = location => `${location.binder_id}-${location.placement_id || `tray-${location.binder_card_id}`}`

// The confirmation names the binder and, for a placed copy, the slot that frees
// up. The binder copy always leaves; the collection copy is never touched.
export function locationRemovalPrompt(t, location) {
  const message = location.placement_id
    ? binderMessage(t, 'removeLocationBodyPlaced', { page: location.page, slot: location.slot })
    : location.quantity > 1
      ? binderMessage(t, 'removeLocationBodyMany')
      : t('binderLayout.removeLocationBodyUnplaced')
  return {
    title: binderMessage(t, 'removeLocationTitle', { binder: location.binder_name }),
    message,
    confirmLabel: t('binderLayout.removeLocationConfirm'),
    destructive: true,
  }
}

export function CardLocationRow({ location, t, handle, pending = false, disabled = false, onRemove }) {
  const removeLabel = binderMessage(t, 'removeLocation', { binder: location.binder_name })
  return <li className="flex items-center gap-1">
    {/* The link keeps the whole row except the remove target, so a phone tap
        still opens the binder without landing on the destructive button. */}
    <Link className="group flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 rounded-lg p-2 text-sm text-text-primary hover:bg-bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-red" to={binderLocationHref(location, handle)}>
      <span className="min-w-0 truncate group-hover:underline underline-offset-4">{location.binder_name}</span>
      <span className="shrink-0 rounded-full bg-bg-elevated px-2 py-0.5 text-xs tabular-nums text-text-secondary group-hover:bg-bg-surface">{location.page ? binderMessage(t, 'location', location) : binderMessage(t, 'unplacedCopies', { count: location.quantity })}</span>
    </Link>
    {!handle && <button
      type="button"
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-brand-red hover:bg-brand-red/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-red disabled:opacity-50"
      aria-label={removeLabel}
      title={removeLabel}
      disabled={disabled}
      onClick={() => onRemove(location)}
    >
      {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}
    </button>}
  </li>
}

export default function CardLocations({ cardId, collectionItemId, handle }) {
  const { t } = useSettings()
  const confirm = useConfirmDialog()
  const client = useQueryClient()
  const [state, setState] = useState({ loading: true, locations: [] })
  const [retry, setRetry] = useState(0)
  const [pendingKey, setPendingKey] = useState(null)
  useEffect(() => {
    let cancelled = false
    setState({ loading: true, locations: [] })
    const request = handle ? getPublicCardLocations(handle, cardId) : getCardLocations(cardId, collectionItemId)
    request.then(data => { if (!cancelled) setState({ locations: data.locations || [] }) })
      .catch(() => { if (!cancelled) setState({ error: true, locations: [] }) })
    return () => { cancelled = true }
  }, [cardId, collectionItemId, handle, retry])

  const removeOne = async location => {
    if (!(await confirm(locationRemovalPrompt(t, location)))) return
    setPendingKey(locationKey(location))
    try {
      // One explicit copy-level removal: no revision, and the owned collection
      // copy stays. This panel only refetches its own list afterwards.
      await removeBinderCopy(location.binder_id, {
        binder_card_id: location.binder_card_id,
        placement_id: location.placement_id || null,
        remove_owned_copy: false,
      })
      toast.success(t('binderLayout.removedFromBinder'))
      for (const queryKey of [['card-locations'], ['binder-cards'], ['binders'], ['binder-layout']]) client.invalidateQueries({ queryKey })
      setRetry(n => n + 1)
    } catch (error) {
      // Keep the row until the server confirms, so a refused removal never
      // hides a location that still exists.
      toast.error(getApiErrorMessage(error, t('binderLayout.removeLocationFailed')))
    } finally {
      setPendingKey(null)
    }
  }

  return <section className="rounded-xl border border-border bg-bg-card p-3 space-y-2" aria-label={t('binderLayout.locations')}>
    <h3 className="flex items-center gap-2 text-sm font-semibold"><MapPin size={15} aria-hidden />{t('binderLayout.locations')}</h3>
    {state.loading ? <p className="text-xs text-text-secondary" role="status">{t('common.loading')}</p> : state.error ? <button className="btn-ghost text-xs" onClick={() => setRetry(n => n + 1)}>{t('binderLayout.retryLocations')}</button> : state.locations.length ? <ul className="max-h-48 overflow-y-auto space-y-1">
      {state.locations.map(location => <CardLocationRow
        key={locationKey(location)}
        location={location}
        t={t}
        handle={handle}
        pending={pendingKey === locationKey(location)}
        disabled={Boolean(pendingKey)}
        onRemove={removeOne}
      />)}
    </ul> : <p className="text-xs text-text-secondary">{t('binderLayout.noLocations')}</p>}
  </section>
}
