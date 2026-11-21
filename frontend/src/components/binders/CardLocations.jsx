import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { MapPin } from 'lucide-react'
import { getCardLocations } from '../../api/client'
import { getPublicCardLocations } from '../../api/publicClient'
import { useSettings } from '../../contexts/SettingsContext'
import { binderLocationHref, binderMessage } from '../../utils/binderLayout'

export default function CardLocations({ cardId, collectionItemId, handle }) {
  const { t } = useSettings()
  const [state, setState] = useState({ loading: true, locations: [] })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    setState({ loading: true, locations: [] })
    const request = handle ? getPublicCardLocations(handle, cardId) : getCardLocations(cardId, collectionItemId)
    request.then(data => { if (!cancelled) setState({ locations: data.locations || [] }) })
      .catch(() => { if (!cancelled) setState({ error: true, locations: [] }) })
    return () => { cancelled = true }
  }, [cardId, collectionItemId, handle, retry])
  return <section className="rounded-xl border border-border bg-bg-card p-3 space-y-2" aria-label={t('binderLayout.locations')}>
    <h3 className="flex items-center gap-2 text-sm font-semibold"><MapPin size={15} aria-hidden />{t('binderLayout.locations')}</h3>
    {state.loading ? <p className="text-xs text-text-secondary" role="status">{t('common.loading')}</p> : state.error ? <button className="btn-ghost text-xs" onClick={() => setRetry(n => n + 1)}>{t('binderLayout.retryLocations')}</button> : state.locations.length ? <ul className="max-h-48 overflow-y-auto space-y-1">
      {state.locations.map(location => <li key={`${location.binder_id}-${location.placement_id || `tray-${location.binder_card_id}`}`}>
        <Link className="group flex min-h-11 items-center justify-between gap-3 rounded-lg p-2 text-sm text-text-primary hover:bg-bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-red" to={binderLocationHref(location, handle)}>
          <span className="min-w-0 truncate group-hover:underline underline-offset-4">{location.binder_name}</span>
          <span className="shrink-0 rounded-full bg-bg-elevated px-2 py-0.5 text-xs tabular-nums text-text-secondary group-hover:bg-bg-surface">{location.page ? binderMessage(t, 'location', location) : binderMessage(t, 'unplacedCopies', { count: location.quantity })}</span>
        </Link>
      </li>)}
    </ul> : <p className="text-xs text-text-secondary">{t('binderLayout.noLocations')}</p>}
  </section>
}
