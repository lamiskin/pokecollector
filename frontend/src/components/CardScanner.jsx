import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, FolderInput, Loader2, PackageCheck, Plus, X } from 'lucide-react'
import { addToCollection, uploadCollectionItemPhoto } from '../api/client'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { CARD_VARIANTS, getSelectableVariants, getDefaultVariant } from '../utils/cardVariants'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import MoneyInput from './MoneyInput'
import { parseMoneyInputValue } from '../utils/moneyInput'
import { CardDisplay } from './card-system'
import { normalizeTcgdexLanguage } from '../utils/tcgdexLanguages'
import { useScanCatalogue } from '../hooks/useScanCatalogue'
import { useDialogBehavior } from './ui/dialogBehavior'
import PrintingDetailSelector from './PrintingDetailSelector'

export async function attachScanFallbackPhoto({ created, getPhoto, uploadPhoto = uploadCollectionItemPhoto }) {
  const createdCard = created?.card
  if (!getPhoto || !createdCard || created?.has_scan_photo) return false
  try {
    const photo = await getPhoto()
    if (!photo) return false
    await uploadPhoto(created.id, photo)
    return true
  } catch {
    // Photo retention is best-effort and must never undo the collection add.
    return false
  }
}

// ─── Batch destination ─────────────────────────────────────────────────────
// Only physical lists can take a card this batch actually adds: a Binder or a
// Real Deck holds exact owned copies, so the backend can file the new card
// there. Planned binders/decks are things you collect *towards*, not places a
// scanned card can physically go, so they are deliberately not offered.
function physicalScanDestinations(binders = []) {
  const lists = Array.isArray(binders) ? binders : []
  return {
    binders: lists.filter(binder => binder.binder_type === 'collection'),
    realDecks: lists.filter(binder => binder.binder_type === 'physical_deck'),
  }
}

export function ScanDestinationField({ id, binders = [], value, onChange, disabled = false }) {
  const { t } = useSettings()
  const { binders: binderLists, realDecks } = physicalScanDestinations(binders)
  const hasLists = binderLists.length > 0 || realDecks.length > 0
  const hintId = `${id}-hint`

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label htmlFor={id} className="block text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
            {t('scanner.destinationLabel')}
          </label>
          <p id={hintId} className="mt-1 text-xs leading-relaxed text-text-muted">{t('scanner.destinationHint')}</p>
        </div>
        <FolderInput size={16} className="mt-0.5 flex-shrink-0 text-brand-red/70" aria-hidden />
      </div>
      <select
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled || !hasLists}
        aria-describedby={hintId}
        className="select mt-3 w-full"
      >
        <option value="">{t('scanner.destinationNone')}</option>
        {binderLists.length > 0 && (
          <optgroup label={t('scanner.destinationBinders')}>
            {binderLists.map(binder => (
              <option key={binder.id} value={String(binder.id)}>{binder.name}</option>
            ))}
          </optgroup>
        )}
        {realDecks.length > 0 && (
          <optgroup label={t('scanner.destinationRealDecks')}>
            {realDecks.map(deck => (
              <option key={deck.id} value={String(deck.id)}>{deck.name}</option>
            ))}
          </optgroup>
        )}
      </select>
      {!hasLists && (
        <p className="mt-2 text-xs text-text-muted">{t('scanner.destinationEmpty')}</p>
      )}
    </div>
  )
}

// The last thing above the start button: one quiet line that says where the
// staged photos are about to go, so the choice in the panel above cannot be
// forgotten at the moment the batch is submitted.
export function ScanDestinationSummary({ binder }) {
  const { t } = useSettings()

  if (!binder) {
    return (
      <p className="flex items-center justify-center gap-1.5 text-xs text-text-muted">
        <FolderInput size={13} className="flex-shrink-0 opacity-70" aria-hidden />
        {t('scanner.destinationSummaryNone')}
      </p>
    )
  }

  const Icon = binder.binder_type === 'physical_deck' ? PackageCheck : BookOpen
  return (
    <p className="flex min-w-0 items-center justify-center gap-1.5 text-xs text-text-secondary">
      <Icon size={13} className="flex-shrink-0 text-brand-red" aria-hidden />
      <span className="truncate">{t('scanner.destinationSummary').replace('{name}', binder.name)}</span>
    </p>
  )
}

// ─── Add-to-Collection Modal für Scan-Ergebnis ──────────────────────────────
// `getPhoto`, when given, resolves to the Blob/File the user actually scanned.
// Callers decide how to source it: UnifiedCardScanner has the raw File in hand,
// ScanQueue fetches it from the job's stored bytes. Called only after the
// collection item exists. Always saves the scan photo as this card's own
// photo, catalogue artwork or not — a scan is the physical card, and a
// catalogue's reference image is a different printing/copy. Skipped only
// when the card already has a saved own photo (never overwritten).
// A failed photo attach must never block adding the card itself.
export function ScanAddModal(props) {
  const initialLang = normalizeTcgdexLanguage(props.match.lang || props.match._lang || props.defaultLang)
  return <ScanAddForm key={`${props.match.id}:${initialLang}`} {...props} initialLang={initialLang} />
}

function ScanAddForm({ match, initialLang, getPhoto, onClose, onAdded, addCard, binderName = null, preservePhotoBeforeAdd = false }) {
  const { t, exchangeRate, exchangeRateReady } = useSettings()
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variantChoice, setVariantChoice] = useState(null)
  const [printingDetails, setPrintingDetails] = useState([])
  const [lang, setLang] = useState(initialLang)
  const { id: catalogueId, loading: catalogueLoading, card: catalogueCard } = useScanCatalogue(match.id, lang)
  const [purchasePrice, setPurchasePrice] = useState('')
  const [adding, setAdding] = useState(false)
  const queryClient = useQueryClient()
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(true, onClose)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  // Scanner flags, prices and finish guesses are deliberately never consulted.
  const selectableVariants = getSelectableVariants(catalogueCard)
  const selectableVariantKey = selectableVariants.join('|')
  const validChoice = selectableVariants.includes(variantChoice)
  const variant = validChoice ? variantChoice : (catalogueLoading ? '' : getDefaultVariant(catalogueCard))

  // Reconcile late metadata/language changes without a disabled selected value
  // or a stale payload. A still-supported nondefault choice is left untouched.
  useEffect(() => {
    if (!catalogueLoading && variantChoice && !validChoice) setVariantChoice(null)
  }, [catalogueLoading, selectableVariantKey, variantChoice, validChoice])

  const handleAdd = async () => {
    if (adding || catalogueLoading || !exchangeRateReady) return
    setAdding(true)
    try {
      const payload = {
        card_id: catalogueId,
        quantity,
        condition,
        variant,
        printing_details: printingDetails,
        lang,
        purchase_price: parseMoneyInputValue(purchasePrice, exchangeRate),
      }
      // Resolving a queued scan deletes its private source photo. Retain the
      // Blob before an atomic add+resolve so missing catalogue artwork can
      // still receive the same best-effort fallback photo as direct scans.
      const retainedPhoto = preservePhotoBeforeAdd && getPhoto
        ? await getPhoto().catch(() => null)
        : null
      const created = addCard
        ? await addCard(payload)
        : (await addToCollection(payload)).data
      // Never overwrite a photo the item already has — grouping into an
      // existing row (same card/variant/condition/lang) is common, and a
      // second scan of the same card is not necessarily a better photo.
      await attachScanFallbackPhoto({
        created,
        match,
        getPhoto: retainedPhoto ? () => Promise.resolve(retainedPhoto) : getPhoto,
      })
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      toast.success(`${match.name} ${t('scanner.addedToCollection')}!`)
      onAdded && onAdded(created)
      onClose()
    } catch (err) {
      const msg = err?.response?.data?.detail || t('card.addFailed')
      toast.error(msg)
    } finally {
      setAdding(false)
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('scanner.addToCollection')}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 z-[300] flex items-end justify-center bg-black/80 p-2 backdrop-blur-xs sm:items-center sm:p-3"
      onClick={onClose}
    >
      <div
        className="relative max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-bg-surface shadow-2xl sm:max-h-[calc(100dvh-1.5rem)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/20 sm:hidden" aria-hidden />
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-50 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/70 text-white shadow-lg hover:bg-black focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-red"
          aria-label={t('common.close')}
        >
          <X size={18} />
        </button>
        <div className="p-5">
          {/* Card Info */}
          <div className="flex items-center gap-3 mb-4">
            <div className="w-16 flex-shrink-0">
              <CardDisplay variant="artwork" card={match} image={match.image} alt={match.name} showStateIndicators={false} loading="eager" />
            </div>
            <div className="flex-1 min-w-0 pr-9">
              <p className="font-bold text-white text-base truncate">{match.name}</p>
              <p className="text-xs font-mono text-brand-red/80 font-semibold">{`${(match.set_abbreviation || '').toUpperCase()} ${match.number || ''}`.trim()}</p>
              {match.rarity && <p className="text-[11px] text-text-muted">{match.rarity}</p>}
            </div>
          </div>

          {binderName && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
              <FolderInput size={14} className="mt-px flex-shrink-0 text-text-muted" aria-hidden />
              <p className="text-xs leading-relaxed text-text-secondary">
                {t('scanner.addModalFilingInto').replace('{name}', binderName)}
              </p>
            </div>
          )}

          <div className="space-y-3">
            {/* Language */}
            <label className="block">
              <span className="text-xs text-text-muted mb-1.5 block font-medium">🌐 {t('lang.filter')}</span>
              <TcgdexLanguageSelect value={lang} onChange={setLang} className="select w-full" />
            </label>

            {/* Quantity + Condition */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('common.quantity')}</label>
                <input
                  type="number" min="1" value={quantity}
                  onChange={e => setQuantity(parseInt(e.target.value) || 1)}
                  className="input"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                <select value={condition} onChange={e => setCondition(e.target.value)} className="select">
                  {['Mint', 'NM', 'LP', 'MP', 'HP'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            {/* Variant */}
            <label className="block">
              <span className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</span>
              <select value={variant} onChange={e => setVariantChoice(e.target.value)} className="select" disabled={adding}>
                {catalogueLoading && <option value="" disabled>{t('common.loading')}</option>}
                {CARD_VARIANTS.map(v => <option key={v} value={v} disabled={!selectableVariants.includes(v)} className="disabled:text-text-muted">{v}</option>)}
              </select>
            </label>

            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('printingDetails.label')}</label>
              <PrintingDetailSelector value={printingDetails} onChange={setPrintingDetails} />
            </div>


            {/* Purchase price */}
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('scanner.purchasePriceLabel')}</label>
              <MoneyInput
                placeholder={t('analytics.amountPlaceholder')}
                value={purchasePrice}
                onChange={e => setPurchasePrice(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-2 mt-5">
            <button
              onClick={handleAdd}
              disabled={adding || catalogueLoading || !exchangeRateReady}
              className="flex-1 py-3 rounded-xl font-black text-white flex items-center justify-center gap-2 transition-all"
              style={{ background: adding ? '#555' : '#e3000b', boxShadow: adding ? 'none' : '0 0 16px rgba(227,0,11,0.3)' }}
            >
              {adding || catalogueLoading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {adding ? t('scanner.adding') : catalogueLoading ? t('common.loading') : t('scanner.addToCollection')}
            </button>
            <button onClick={onClose} className="btn-ghost px-3">
              <X size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
