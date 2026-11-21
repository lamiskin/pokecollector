import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, HelpCircle } from 'lucide-react'
import clsx from 'clsx'
import { getPublicBinder, getPublicBinderLayout, getPublicProfile } from '../api/publicClient'
import { groupCardsByPrint } from '../utils/groupCardsByPrint'
import { formatBinderCountSummary } from '../utils/binderCounts'
import { useSettings } from '../contexts/SettingsContext'
import { CardDialog, CardLegend, CardStack } from '../components/card-system'
import BinderWorkspace from '../components/binders/BinderWorkspace'
import CardLocations from '../components/binders/CardLocations'
import { resolveCardImageUrl } from '../utils/imageUrl'
import PrintingDetailBadges from '../components/PrintingDetailBadges'
import PublicProfileShell from '../components/public/PublicProfileShell'

export default function PublicBinderView() {
  const { handle, binderId } = useParams()
  const [binder, setBinder] = useState(null)
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState(null)
  const [badgeLegendOpen, setBadgeLegendOpen] = useState(false)
  const [layout, setLayout] = useState(null)
  const [layoutError, setLayoutError] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)
  const [layoutRetry, setLayoutRetry] = useState(0)
  const { t, formatPrice } = useSettings()

  useEffect(() => {
    let cancelled = false
    setBinder(null)
    setError(null)
    setSelectedCard(null)
    Promise.all([getPublicProfile(handle), getPublicBinder(handle, binderId)])
      .then(([profileData, binderData]) => { if (!cancelled) { setProfile(profileData); setBinder(binderData) } })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [handle, binderId])

  useEffect(() => {
    let cancelled = false
    setLayout(null)
    setLayoutError(false)
    getPublicBinderLayout(handle, binderId).then(data => { if (!cancelled) setLayout(data) })
      .catch(() => { if (!cancelled) setLayoutError(true) })
    return () => { cancelled = true }
  }, [handle, binderId, layoutRetry])

  if (error) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('publicProfiles.binderUnavailable')}</div>
  if (!binder || !profile) return <div className="min-h-screen flex items-center justify-center text-text-secondary">{t('common.loading')}</div>

  const tiles = groupCardsByPrint(binder.cards)

  return (
    <PublicProfileShell profile={profile} handle={handle} activeSection="binders" t={t}>
        <Link to={`/u/${handle}`} className="btn-ghost inline-flex py-1.5 text-sm">
          <ArrowLeft size={14} /> {t('publicProfiles.backToProfile')}
        </Link>
        <div className="my-4 flex flex-wrap items-baseline justify-between gap-2 rounded-2xl border border-border bg-bg-secondary p-4 shadow-xs">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-text-muted">{t('publicProfiles.sharedBinder')}</p>
            <h1 className="text-2xl font-bold">{binder.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {formatBinderCountSummary(binder.card_count, binder.unique_card_count, t)}
            </p>
          </div>
          {binder.total_value != null && (
            <span className="text-lg font-semibold">{formatPrice(binder.total_value)}</span>
          )}
        </div>

        {layoutError && <p role="alert" className="mb-4 text-sm text-text-secondary">{t('binderLayout.loadFailed')} <button className="btn-ghost" onClick={() => setLayoutRetry(n => n + 1)}>{t('binderLayout.retry')}</button></p>}
        {!layout && !layoutError ? <p role="status" className="text-sm text-text-secondary">{t('common.loading')}</p> : layout?.layout ? <BinderWorkspace snapshot={layout} binderId={binderId} handle={handle} readOnly t={t} accent={binder.color} onOpen={entry => setSelectedCard({ ...entry, id: entry.card_id })} /> : <>
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => setBadgeLegendOpen(open => !open)}
            className={clsx(
              'btn-ghost px-3 py-2 text-sm',
              badgeLegendOpen && 'border-brand-red/30 bg-brand-red/10 text-brand-red'
            )}
            aria-expanded={badgeLegendOpen}
            aria-controls="public-card-badge-legend"
          >
            <HelpCircle size={15} />
            <span>{t('setDetail.badgeLegend')}</span>
          </button>
        </div>
        {badgeLegendOpen && (
          <div id="public-card-badge-legend" className="card mb-4 p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('setDetail.badgeLegend')}
            </p>
            <CardLegend collapsible={false} showWishlist={false} />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {tiles.map(tile => {
          // Depth follows distinct prints: 1 layer behind for 2 variants, 2 for 3+.
          const backLayers = Math.min(tile.variantCount - 1, 2)
          const layerOffset = 8
          return (
            <article key={tile.id} className="rounded-xl border border-border bg-bg-secondary p-2 shadow-xs">
              <CardStack
                card={tile}
                image={tile.image}
                alt={tile.name}
                layers={backLayers}
                layerOffset={layerOffset}
                variantEffectSource={tile.prints}
                stateIndicatorProps={{
                  card: { ...tile, owned_variants: tile.prints },
                  showWishlist: false,
                  alwaysShowQuantity: true,
                }}
              />
              <div className="mt-1 text-sm font-medium truncate">{tile.name}</div>
              <div className="text-xs text-text-secondary">{tile.set_name} · #{tile.number}</div>
              <PrintingDetailBadges details={tile.prints.flatMap(print => print.printing_details || [])} limit={2} className="mt-1" />
              {tile.total_value != null && (
                <div className="text-xs font-semibold">{formatPrice(tile.total_value)}</div>
              )}
            </article>
          )
        })}
        </div>
        </>}
        {selectedCard && <CardDialog card={selectedCard} image={resolveCardImageUrl(selectedCard)} onClose={() => setSelectedCard(null)}><CardLocations cardId={selectedCard.card_id} handle={handle} /></CardDialog>}
    </PublicProfileShell>
  )
}
