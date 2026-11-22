import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { BookOpen, Camera, Upload, ImagePlus, Trash2, X, Check, FolderInput, Loader2, PackageCheck, RefreshCw, Plus } from 'lucide-react'
import { recognizeCard, addToCollection, enqueueScanJob, getBinders, getScannerConfiguration, uploadCollectionItemPhoto } from '../api/client'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import toast from 'react-hot-toast'
import { CARD_VARIANTS, getSelectableVariants, getDefaultVariant } from '../utils/cardVariants'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import MoneyInput from './MoneyInput'
import { parseMoneyInputValue } from '../utils/moneyInput'
import { CardDisplay } from './card-system'
import { normalizeTcgdexLanguage, tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { useScanCatalogue } from '../hooks/useScanCatalogue'
import { isSupportedScannerImage, SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'
import { useDialogBehavior } from './ui/dialogBehavior'
import PrintingDetailSelector from './PrintingDetailSelector'

export async function attachScanFallbackPhoto({ created, match, getPhoto, uploadPhoto = uploadCollectionItemPhoto }) {
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
// Callers decide how to source it: CardScanner has the raw File in hand,
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

export default function CardScanner({ isOpen, onClose, onCardSelected }) {
  const [phase, setPhase] = useState('capture') // capture | staging | loading | results
  const [results, setResults] = useState(null)
  const [selectedMatch, setSelectedMatch] = useState(null)
  const [addModal, setAddModal] = useState(null) // match to show modal for
  const [scanPreviewUrl, setScanPreviewUrl] = useState(null)
  const [stagedFiles, setStagedFiles] = useState([])
  const [submittingBatch, setSubmittingBatch] = useState(false)
  const [destinationBinderId, setDestinationBinderId] = useState('')
  const cameraRef = useRef()
  const uploadRef = useRef()
  const batchCameraRef = useRef()
  const batchGalleryRef = useRef()
  const scanPreviewRef = useRef(null)
  const scannedFileRef = useRef(null)
  const stagedFilesRef = useRef([])
  const { t } = useSettings()
  const confirmDialog = useConfirmDialog()
  const navigate = useNavigate()
  const { data: scannerConfiguration } = useQuery({
    queryKey: ['scanner-configuration'],
    queryFn: getScannerConfiguration,
    enabled: isOpen,
  })
  // Shared with the Binders page, so a list created or renamed there is
  // already current when the scanner opens.
  const { data: binderData = [] } = useQuery({
    queryKey: ['binders'],
    queryFn: () => getBinders().then(r => r.data),
    enabled: isOpen,
  })
  const destinationBinder = (Array.isArray(binderData) ? binderData : [])
    .find(binder => String(binder.id) === destinationBinderId) || null

  useEffect(() => {
    stagedFilesRef.current = stagedFiles
  }, [stagedFiles])
  useEffect(() => () => {
    stagedFilesRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl))
    if (scanPreviewRef.current) URL.revokeObjectURL(scanPreviewRef.current)
  }, [])

  if (!isOpen) return null

  const handleFile = async (file) => {
    if (!file) return
    if (!isSupportedScannerImage(file)) {
      toast.error(t('scanner.recognitionFailed'))
      return
    }
    if (scanPreviewRef.current) URL.revokeObjectURL(scanPreviewRef.current)
    scanPreviewRef.current = URL.createObjectURL(file)
    setScanPreviewUrl(scanPreviewRef.current)
    scannedFileRef.current = file
    setPhase('loading')
    try {
      const data = await recognizeCard(
        file,
        scannerConfiguration?.request_timeout_seconds,
      )
      setResults(data)
      setSelectedMatch(data.matches?.[0] || null)
      setPhase('results')
    } catch (e) {
      const msg = e?.response?.data?.detail || t('scanner.recognitionFailed')
      toast.error(msg)
      setPhase('capture')
    }
  }

  const reset = () => {
    if (scanPreviewRef.current) URL.revokeObjectURL(scanPreviewRef.current)
    scanPreviewRef.current = null
    scannedFileRef.current = null
    setScanPreviewUrl(null)
    setPhase('capture')
    setResults(null)
    setSelectedMatch(null)
    setAddModal(null)
  }

  const releaseStagedFiles = (items = stagedFiles) => {
    items.forEach(item => URL.revokeObjectURL(item.previewUrl))
  }

  const appendBatchFiles = (fileList) => {
    const incoming = Array.from(fileList || []).filter(file => {
      if (isSupportedScannerImage(file)) return true
      toast.error(t('scanner.unsupportedImage'))
      return false
    })
    if (!incoming.length) return

    const remaining = Math.max(0, 50 - stagedFilesRef.current.length)
    const accepted = incoming.slice(0, remaining)
    if (accepted.length < incoming.length) toast.error(t('scanner.batchLimitReached'))
    const additions = accepted.map(file => ({
      id: `${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }))
    setStagedFiles(current => [...current, ...additions])
    setPhase('staging')
  }

  const removeStagedFile = (id) => {
    setStagedFiles(current => {
      const removed = current.find(item => item.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return current.filter(item => item.id !== id)
    })
  }

  const clearStagedFiles = () => {
    releaseStagedFiles()
    setStagedFiles([])
  }

  const closeScanner = async () => {
    if (stagedFiles.length) {
      const confirmed = await confirmDialog({
        title: t('common.close'),
        message: t('scanner.discardStagedConfirm'),
        confirmLabel: t('common.close'),
        destructive: true,
      })
      if (!confirmed) return
    }
    clearStagedFiles()
    reset()
    onClose?.()
  }

  const submitBatch = async () => {
    if (!stagedFiles.length || submittingBatch) return
    setSubmittingBatch(true)
    try {
      const job = await enqueueScanJob(
        stagedFiles.map(item => item.file),
        [],
        destinationBinder ? destinationBinder.id : null,
      )
      releaseStagedFiles()
      setStagedFiles([])
      setDestinationBinderId('')
      setPhase('capture')
      onClose?.()
      navigate(`/scans/${job.id}`)
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('scanner.batchSubmitFailed'))
    } finally {
      setSubmittingBatch(false)
    }
  }

  const detectedLang = results?.recognized?.language || 'en'

  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col"
      style={{ background: 'rgba(0,0,0,0.95)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-6 pb-4 flex-shrink-0">
        <div>
          <p className="text-[10px] text-text-muted uppercase tracking-[0.2em]">{t('scanner.title')}</p>
          <h2 className="text-lg font-black text-white">{t('scanner.subtitle')}</h2>
        </div>
        <button onClick={closeScanner}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.08)' }}>
          <X size={18} className="text-text-muted" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8">

        {/* CAPTURE */}
        {phase === 'capture' && (
          <div className="flex flex-col items-center gap-5 pt-4">
            <div className="w-full max-w-xs aspect-[2.5/3.5] rounded-2xl flex flex-col items-center justify-center relative"
              style={{ border: '2px dashed rgba(227,0,11,0.4)', background: 'rgba(227,0,11,0.04)' }}>
              <div className="absolute top-2 left-2 w-6 h-6 border-t-2 border-l-2 border-brand-red rounded-tl" />
              <div className="absolute top-2 right-2 w-6 h-6 border-t-2 border-r-2 border-brand-red rounded-tr" />
              <div className="absolute bottom-2 left-2 w-6 h-6 border-b-2 border-l-2 border-brand-red rounded-bl" />
              <div className="absolute bottom-2 right-2 w-6 h-6 border-b-2 border-r-2 border-brand-red rounded-br" />
              <Camera size={40} className="text-brand-red opacity-40 mb-2" />
              <p className="text-xs text-text-muted text-center px-6">{t('scanner.alignCard')}</p>
            </div>

            <input ref={cameraRef} type="file" accept={SCANNER_IMAGE_ACCEPT} capture="environment"
              className="hidden" onChange={e => { handleFile(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={uploadRef} type="file" accept={SCANNER_IMAGE_ACCEPT}
              className="hidden" onChange={e => { handleFile(e.target.files?.[0]); e.target.value = '' }} />

            <button onClick={() => cameraRef.current?.click()}
              className="w-full max-w-xs py-4 rounded-2xl font-black text-white text-base flex items-center justify-center gap-3"
              style={{ background: '#e3000b', boxShadow: '0 0 24px rgba(227,0,11,0.35)' }}>
              <Camera size={20} /> {t('scanner.takePhoto')}
            </button>

            <button
              onClick={() => uploadRef.current?.click()}
              className="text-sm text-text-muted hover:text-text-secondary flex items-center gap-2 transition-colors">
              <Upload size={14} /> {t('scanner.uploadImage')}
            </button>

            <button
              onClick={() => setPhase('staging')}
              className="text-sm text-text-muted hover:text-text-secondary flex items-center gap-2 transition-colors">
              <ImagePlus size={14} /> {t('scanner.batchScan')}
            </button>

            <p className="text-[11px] text-text-muted text-center max-w-xs">
              {t('scanner.aiHint')}
            </p>
          </div>
        )}

        {/* BATCH STAGING */}
        {phase === 'staging' && (
          <div className="mx-auto max-w-4xl space-y-4">
            <input ref={batchCameraRef} type="file" accept={SCANNER_IMAGE_ACCEPT} capture="environment"
              className="hidden" onChange={e => { appendBatchFiles(e.target.files); e.target.value = '' }} />
            <input ref={batchGalleryRef} type="file" accept={SCANNER_IMAGE_ACCEPT} multiple
              className="hidden" onChange={e => { appendBatchFiles(e.target.files); e.target.value = '' }} />

            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
                  {t('scanner.batchStaging')}
                </p>
                <p className="text-sm text-text-secondary">{stagedFiles.length}/50 {t('scanner.photos')}</p>
              </div>
              {stagedFiles.length > 0 && (
                <button type="button" onClick={clearStagedFiles}
                  className="flex items-center gap-1.5 text-xs text-text-muted hover:text-brand-red">
                  <Trash2 size={14} /> {t('scanner.clearBatch')}
                </button>
              )}
            </div>

            {stagedFiles.length > 0 ? (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 md:grid-cols-7">
                {stagedFiles.map((item, index) => (
                  <div key={item.id} className="relative aspect-[2.5/3.5] overflow-hidden rounded-xl border border-white/10 bg-bg-surface">
                    <img src={item.previewUrl} alt="" className="h-full w-full object-contain" />
                    <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {index + 1}
                    </span>
                    <button type="button" onClick={() => removeStagedFile(item.id)}
                      aria-label={t('common.remove')}
                      className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/75 text-white hover:bg-brand-red">
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border-2 border-dashed border-white/10 py-12 text-center text-sm text-text-muted">
                {t('scanner.noPhotosStaged')}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => batchCameraRef.current?.click()} disabled={stagedFiles.length >= 50}
                className="btn-secondary justify-center">
                <Camera size={16} /> {t('scanner.takePhoto')}
              </button>
              <button type="button" onClick={() => batchGalleryRef.current?.click()} disabled={stagedFiles.length >= 50}
                className="btn-secondary justify-center">
                <Upload size={16} /> {t('scanner.chooseFromGallery')}
              </button>
            </div>

            <ScanDestinationField
              id="card-scanner-destination"
              binders={binderData}
              value={destinationBinderId}
              onChange={setDestinationBinderId}
              disabled={submittingBatch}
            />

            <ScanDestinationSummary binder={destinationBinder} />

            <button type="button" onClick={submitBatch}
              disabled={!stagedFiles.length || submittingBatch}
              className="btn-primary w-full justify-center py-3">
              {submittingBatch ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
              {submittingBatch ? t('scanner.submittingBatch') : t('scanner.startScanning')}
            </button>
            <button type="button" onClick={closeScanner}
              className="btn-ghost w-full justify-center">
              {t('common.cancel')}
            </button>
          </div>
        )}

        {/* LOADING */}
        {phase === 'loading' && (
          <div className="flex flex-col items-center gap-6 pt-8">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={32} className="text-brand-red animate-spin" />
              <p className="text-sm text-text-secondary font-medium">{t('scanner.recognizing')}</p>
              <p className="text-xs text-text-muted text-center">{t('scanner.analyzing')}</p>
            </div>
          </div>
        )}

        {/* RESULTS */}
        {phase === 'results' && results && (
          <div className="mx-auto max-w-6xl space-y-4 pb-24 sm:pb-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
              <div className="hidden rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:block">
                <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
                  {t('scanner.yourScan')}
                </p>
                {scanPreviewUrl ? (
                  <img
                    src={scanPreviewUrl}
                    alt={t('scanner.yourScan')}
                    className="aspect-[2.5/3.5] w-full rounded-xl border border-white/10 bg-bg-primary/50 object-contain"
                  />
                ) : (
                  <div className="grid aspect-[2.5/3.5] place-items-center rounded-xl border border-dashed border-white/10 bg-bg-primary/50 text-center">
                    <div className="space-y-2 text-text-muted">
                      <Camera size={36} className="mx-auto opacity-50" aria-hidden />
                      <p className="text-xs">{t('scanner.yourScan')}</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="mb-2 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">{t('scanner.detected')}</p>
                  <p className="text-lg font-bold text-white">{results.recognized?.name || '—'}</p>
                  {results.recognized?.number && <p className="text-sm text-text-muted">Nr. {results.recognized.number}</p>}
                  {results.recognized?.language && (
                    <p className="mt-0.5 text-xs uppercase tracking-wider text-text-muted">
                      {t('scanner.detectedLanguage')} {results.recognized.language}
                    </p>
                  )}
                </div>

                {results.matches?.length > 0 ? (
                  <div>
                    <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-text-muted">
                      {t('scanner.bestMatches')} ({results.matches.length})
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {results.matches.map(match => {
                        const matchLang = match.lang || match._lang || 'en'
                        const selected = selectedMatch?.id === match.id
                          && (selectedMatch?.lang || selectedMatch?._lang || 'en') === matchLang
                        return (
                          <CardDisplay
                            key={`${match.id}-${matchLang}`}
                            variant="selectable"
                            card={match}
                            image={match.image}
                            languageLabel={tcgdexLanguageLabel(matchLang)}
                            selected={selected}
                            onClick={() => setSelectedMatch(match)}
                            onSelect={() => setSelectedMatch(match)}
                          />
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 py-6 text-center">
                    <p className="text-sm text-text-muted">{t('scanner.noMatches')}</p>
                    <p className="text-xs text-text-muted">{t('scanner.noMatchTip')}</p>
                  </div>
                )}
              </div>
            </div>

            <button onClick={reset}
              className="w-full py-3 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold text-text-muted hover:text-white transition-colors"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              <RefreshCw size={15} /> {t('scanner.scanAgain')}
            </button>

            {selectedMatch && (
              <div className="fixed bottom-3 left-3 right-3 z-20 rounded-2xl border border-white/15 bg-bg-surface/95 p-3 shadow-2xl backdrop-blur sm:sticky sm:bottom-3 sm:mx-auto sm:flex sm:max-w-xl sm:items-center sm:gap-3">
                <div className="mb-2 min-w-0 flex-1 sm:mb-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-muted">{t('scanner.selectedMatch')}</p>
                  <p className="truncate text-sm font-bold text-text-primary">{selectedMatch.name}</p>
                </div>
                <button
                  type="button"
                  className="btn-primary w-full justify-center sm:w-auto"
                  onClick={() => setAddModal(selectedMatch)}
                >
                  <Check size={16} />
                  {t('scanner.useSelectedMatch')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add-to-collection modal */}
      {addModal && (
        <ScanAddModal
          match={addModal}
          defaultLang={detectedLang}
          getPhoto={() => Promise.resolve(scannedFileRef.current)}
          onClose={() => setAddModal(null)}
          onAdded={() => setAddModal(null)}
        />
      )}
    </div>,
    document.body
  )
}
