import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Search } from 'lucide-react'
import { getPublicProfileCards } from '../api/publicClient'
import { useSettings } from '../contexts/SettingsContext'
import { CardStack } from '../components/card-system'
import { groupCardsByPrint } from '../utils/groupCardsByPrint'
import { filterPublicCards, hasPublicValue, sortPublicCardTiles, uniquePublicCardValues } from '../utils/publicCards'

export default function PublicCardsView() {
  const { handle } = useParams()
  const { t, formatPrice } = useSettings()
  const [result, setResult] = useState(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [rarity, setRarity] = useState('')
  const [variant, setVariant] = useState('')
  const [language, setLanguage] = useState('')
  const [sort, setSort] = useState('collector')
  const [direction, setDirection] = useState('asc')

  useEffect(() => {
    let cancelled = false
    setResult(null); setFailed(false)
    getPublicProfileCards(handle).then(data => { if (!cancelled) setResult(data) }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [handle])

  const cards = result?.cards || []
  const showValues = result?.show_values === true
  const allOwnedCards = result?.all_owned_cards === true
  const visible = useMemo(() => filterPublicCards(cards, { query, rarity, variant, language }), [cards, query, rarity, variant, language])
  const tiles = useMemo(() => sortPublicCardTiles(groupCardsByPrint(visible.map((card, index) => ({
    ...card,
    id: card.id ?? `public-card-${index}`,
    market_value: showValues ? card.market_value : null,
  }))), { sort, direction, showValues }), [visible, showValues, sort, direction])
  const rarities = uniquePublicCardValues(cards, 'rarity')
  const languages = uniquePublicCardValues(cards, 'lang')

  if (failed) return <main className="min-h-screen bg-bg-primary p-8 text-center text-text-secondary">{t('publicProfiles.cardsUnavailable')} <Link className="underline" to={`/u/${handle}`}>{t('publicProfiles.backToProfile')}</Link></main>
  if (!result) return <main className="min-h-screen bg-bg-primary p-8 text-center text-text-secondary" role="status">{t('common.loading')}</main>

  return <main className="min-h-screen bg-bg-primary px-3 py-6 text-text-primary sm:px-5">
    <div className="mx-auto max-w-6xl">
      <Link to={`/u/${handle}`} className="btn-ghost inline-flex py-1.5 text-sm"><ArrowLeft size={14} /> {t('publicProfiles.backToProfile')}</Link>
      <header className="my-4 flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-5">
        <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-text-muted">@{result.handle || handle}</p><h1 className="text-2xl font-bold">{result.trainer_name || result.handle || handle} · {t(allOwnedCards ? 'publicProfiles.allOwnedCards' : 'publicProfiles.allCards')}</h1><p className="mt-1 text-sm text-text-secondary">{t(allOwnedCards ? 'publicProfiles.allOwnedCardsDesc' : 'publicProfiles.allCardsDesc')}</p></div>
        <p className="text-sm text-text-secondary">{result.card_count ?? cards.reduce((n, c) => n + (Number(c?.quantity) || 0), 0)} {t('publicProfiles.cardsCount')} · {result.unique_card_count ?? cards.length} {t('publicProfiles.printsCount')}</p>
      </header>
      <section aria-label={t('publicProfiles.searchAndFilterCards')} className="mb-5 grid grid-cols-1 gap-3 rounded-2xl border border-border bg-bg-secondary p-4 sm:grid-cols-2 lg:grid-cols-6">
        <label className="relative sm:col-span-2"><span className="sr-only">{t('publicProfiles.searchCards')}</span><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"/><input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('publicProfiles.searchCards')} className="w-full rounded-xl border border-border bg-bg-primary py-2 pl-9 pr-3 text-sm" /></label>
        <label className="text-xs text-text-secondary">{t('publicProfiles.rarity')}<select aria-label={t('publicProfiles.rarity')} value={rarity} onChange={e => setRarity(e.target.value)} className="mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"><option value="">{t('publicProfiles.allRarities')}</option>{rarities.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="text-xs text-text-secondary">{t('publicProfiles.variant')}<select aria-label={t('publicProfiles.variant')} value={variant} onChange={e => setVariant(e.target.value)} className="mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"><option value="">{t('publicProfiles.allVariants')}</option>{uniquePublicCardValues(cards, 'variant').map(item => <option key={item} value={item}>{item}</option>)}{hasPublicValue(cards, 'variant') && <option value="__none__">{t('publicProfiles.noVariant')}</option>}</select></label>
        <label className="text-xs text-text-secondary">{t('publicProfiles.language')}<select aria-label={t('publicProfiles.language')} value={language} onChange={e => setLanguage(e.target.value)} className="mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"><option value="">{t('publicProfiles.allLanguages')}</option>{languages.map(item => <option key={item} value={item}>{item}</option>)}{hasPublicValue(cards, 'lang') && <option value="__none__">{t('publicProfiles.unknownLanguage')}</option>}</select></label>
        <label className="text-xs text-text-secondary">{t('publicProfiles.sortBy')}<select aria-label={t('publicProfiles.sortBy')} value={sort} onChange={e => setSort(e.target.value)} className="mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"><option value="collector">{t('publicProfiles.sortCollector')}</option><option value="name">{t('publicProfiles.sortName')}</option><option value="quantity">{t('publicProfiles.sortQuantity')}</option><option value="rarity">{t('publicProfiles.sortRarity')}</option>{showValues && <option value="value">{t('publicProfiles.sortValue')}</option>}</select></label>
        <button type="button" onClick={() => setDirection(d => d === 'asc' ? 'desc' : 'asc')} className="self-end rounded-xl border border-border px-3 py-2 text-sm hover:bg-bg-elevated" aria-label={t(direction === 'asc' ? 'publicProfiles.sortAscending' : 'publicProfiles.sortDescending')}>{direction === 'asc' ? `↑ ${t('publicProfiles.sortAscending')}` : `↓ ${t('publicProfiles.sortDescending')}`}</button>
      </section>
      {cards.length === 0 ? <div className="rounded-2xl border border-border bg-bg-secondary p-10 text-center text-text-secondary">{t('publicProfiles.noSharedCards')}</div> : visible.length === 0 ? <div className="rounded-2xl border border-border bg-bg-secondary p-10 text-center text-text-secondary" role="status">{t('publicProfiles.noCardsMatch')}</div> : <>
        <p className="mb-3 text-sm text-text-secondary" aria-live="polite">{tiles.length} {t('publicProfiles.cardsCount')}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {tiles.map(tile => <article key={tile.id} className="min-w-0 rounded-xl border border-border bg-bg-secondary p-2 shadow-sm">
            <CardStack card={tile} image={tile.image} alt={tile.name || t('publicProfiles.unknownCard')} layers={Math.min(tile.variantCount - 1, 2)} variantEffectSource={tile.prints} stateIndicatorProps={{ card: { ...tile, owned_variants: tile.prints }, showWishlist: false, alwaysShowQuantity: true }} />
            <div className="mt-1 truncate text-sm font-medium">{tile.name || t('publicProfiles.unknownCard')}</div><div className="truncate text-xs text-text-secondary">{tile.set_name || tile.set_id || t('publicProfiles.unknownSet')}{tile.number ? ` · #${tile.number}` : ''}</div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-xs text-text-secondary"><span>{tile.prints.length} {t('publicProfiles.variantsCount')} · {tile.prints.reduce((n, print) => n + (Number(print.quantity) || 0), 0)} {t('publicProfiles.sharedQuantity')}</span>{showValues && tile.total_value != null && <span className="font-semibold text-text-primary">{formatPrice(tile.total_value)}</span>}</div>
          </article>)}
        </div>
      </>}
    </div>
  </main>
}
