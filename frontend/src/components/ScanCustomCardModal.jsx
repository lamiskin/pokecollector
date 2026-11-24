import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, X } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  createCustomCardFromScanItem,
  fetchScanJobItemImageBlob,
  getApiErrorMessage,
  getSets,
} from '../api/client'
import { attachScanFallbackPhoto } from './CardScanner'
import { useSettings } from '../contexts/SettingsContext'
import { useDialogBehavior } from './ui/dialogBehavior'
import { useScanItemPhoto } from '../hooks/useScanItemPhoto'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'

const CUSTOM_SET = '__custom__'

// The manual way out of the scanner's no-match state.
//
// A card whose set is newer than our catalogue, or which the model simply
// could not read, used to dead-end: the only actions were retry, dismiss or
// leave the scanner and create the card on the Collection page. This dialog
// creates the custom card from what recognition did read and adds it to the
// collection with the photo the reviewer took — the physical card they are
// holding, not a correction report.
//
// The set picker follows CustomCardModal's data source and conventions: the
// same `['sets', language]` query, a native select of existing sets (here with
// a filter box above it, because the list is long), and the same freetext
// escape hatch for a set that does not exist yet.
export function ScanCustomCardModal({ jobId, item, onClose, onCreated }) {
  const { t, settings } = useSettings()
  const queryClient = useQueryClient()
  const recognized = item?.recognized || {}
  const photoUrl = useScanItemPhoto(jobId, item)

  const [name, setName] = useState(() => recognized.name_en || recognized.name || '')
  const [number, setNumber] = useState(() => recognized.number_local || recognized.number || '')
  const [setChoice, setSetChoice] = useState('')
  const [setFilter, setSetFilter] = useState('')
  const [customSetId, setCustomSetId] = useState('')
  const [customSetName, setCustomSetName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const setSearchId = useId()
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(true, () => {
    if (!submitting) onClose?.()
  })

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  const { data: sets = [], isLoading: setsLoading } = useQuery({
    queryKey: ['sets', settings.language || 'en'],
    queryFn: () => getSets().then(r => r.data),
    staleTime: 60000,
  })

  // The scanner reads a printed set code (MEW, SVI, ...), which is the only
  // set clue recognition gives us. Preselect it when it identifies exactly one
  // set; otherwise use it to narrow the picker so the reviewer can choose the
  // right printing themselves.
  const guessApplied = useRef(false)
  useEffect(() => {
    if (guessApplied.current || !sets.length) return
    guessApplied.current = true
    const code = String(recognized.set_code || '').trim()
    if (!code) return
    const lowered = code.toLowerCase()
    const matches = sets.filter(set => [set.tcg_set_id, set.id, set.abbreviation]
      .some(value => String(value || '').trim().toLowerCase() === lowered))
    if (matches.length === 1) {
      setSetChoice(current => current || matches[0].id)
      return
    }
    setSetFilter(current => current || code)
    // A code that matches no catalogue set is the most likely new set ID.
    if (!matches.length) setCustomSetId(current => current || lowered)
  }, [sets, recognized.set_code])

  const normalizedFilter = setFilter.trim().toLowerCase()
  const filteredSets = useMemo(() => {
    if (!normalizedFilter) return sets
    return sets.filter(set => [set.name, set.tcg_set_id, set.id, set.abbreviation]
      .some(value => String(value || '').toLowerCase().includes(normalizedFilter)))
  }, [sets, normalizedFilter])

  const selectedSet = setChoice && setChoice !== CUSTOM_SET
    ? sets.find(set => set.id === setChoice) || null
    : null
  // Keep the current choice in the list while a filter is typed, so narrowing
  // the search cannot silently blank the select.
  const setOptions = selectedSet && !filteredSets.includes(selectedSet)
    ? [selectedSet, ...filteredSets]
    : filteredSets

  const customSetMode = setChoice === CUSTOM_SET
  const effectiveSetId = customSetMode
    ? customSetId.trim()
    : (selectedSet?.tcg_set_id || selectedSet?.id || '')
  const formReady = Boolean(name.trim() && effectiveSetId)

  const handleSubmit = async event => {
    event.preventDefault()
    if (!formReady || submitting) return
    setSubmitting(true)
    try {
      // Handling a scan may remove its stored photo, so keep the bytes before
      // the request — the same retention the resolve-and-add flow performs.
      const photo = item?.has_image
        ? await fetchScanJobItemImageBlob(jobId, item.id).catch(() => null)
        : null
      const result = await createCustomCardFromScanItem(jobId, item.id, {
        name: name.trim(),
        number: number.trim() || null,
        set_id: effectiveSetId,
        set_name: customSetMode
          ? (customSetName.trim() || null)
          : (selectedSet?.name || null),
        rarity: recognized.rarity || null,
        image_url: null,
      })
      // Never allowed to undo the add, exactly as in the resolve flow.
      await attachScanFallbackPhoto({
        created: result?.collection_item,
        match: result?.card,
        getPhoto: photo ? () => Promise.resolve(photo) : undefined,
      })
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      toast.success(`${result?.card?.name || name.trim()} ${t('scanner.addedToCollection')}`)
      onCreated?.(result)
      onClose?.()
    } catch (error) {
      // 409 (already handled) and 422 (validation) both carry a readable
      // detail; fall back to the usual scanner failure line.
      toast.error(getApiErrorMessage(error, t('scanner.actionFailed')))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('scanner.addCardManuallyTitle')}
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 z-[500] flex items-end justify-center bg-black/80 p-2 backdrop-blur-xs sm:items-center sm:p-3"
      onClick={() => { if (!submitting) onClose?.() }}
    >
      <div
        className="relative max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-bg-surface shadow-2xl sm:max-h-[calc(100dvh-1.5rem)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/20 sm:hidden" aria-hidden />
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="absolute right-3 top-3 z-50 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/70 text-white shadow-lg hover:bg-black focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-red disabled:opacity-60"
          aria-label={t('common.close')}
        >
          <X size={18} />
        </button>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <div className="flex items-center gap-3 pr-10">
            {photoUrl && (
              <img
                src={photoUrl}
                alt={t('scanner.yourPhoto')}
                className="h-20 w-14 flex-shrink-0 rounded-lg border border-white/10 bg-bg-primary/50 object-contain"
              />
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-text-primary">{t('scanner.addCardManuallyTitle')}</h2>
              <p className="mt-1 text-xs leading-relaxed text-text-muted">{t('scanner.addCardManuallyDesc')}</p>
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-secondary">
              {t('common.name')} <span className="text-brand-red">*</span>
            </span>
            <input
              type="text"
              required
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder={t('cardSearch.customNamePlaceholder')}
              autoComplete="off"
              className="input"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-secondary">{t('cardSearch.cardNumber')}</span>
            <input
              type="text"
              value={number}
              onChange={event => setNumber(event.target.value)}
              placeholder={t('cardSearch.cardNumberPlaceholder')}
              autoComplete="off"
              className="input"
            />
          </label>

          <div>
            <label htmlFor={setSearchId} className="mb-1 block text-xs font-medium text-text-secondary">
              {t('common.set')} <span className="text-brand-red">*</span>
            </label>
            <input
              id={setSearchId}
              type="search"
              value={setFilter}
              onChange={event => setSetFilter(event.target.value)}
              placeholder={t('scanner.searchSetsPlaceholder')}
              aria-label={t('scanner.searchSets')}
              autoComplete="off"
              className="input"
            />
            <select
              value={setChoice}
              onChange={event => setSetChoice(event.target.value)}
              aria-label={t('cardSearch.selectOrTypeSet')}
              className="select mt-2"
            >
              <option value="">{setsLoading ? t('common.loading') : t('cardSearch.selectOrTypeSet')}</option>
              {setOptions.map(set => (
                <option key={set.id} value={set.id}>{set.name} ({set.id})</option>
              ))}
              <option value={CUSTOM_SET}>{t('cardSearch.customSetFreetext')}</option>
            </select>
            {!setsLoading && normalizedFilter && !filteredSets.length && !customSetMode && (
              <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{t('scanner.noSetMatch')}</p>
            )}
          </div>

          {customSetMode && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-text-secondary">
                  {t('common.set_id_hint')} <span className="text-brand-red">*</span>
                </span>
                <input
                  type="text"
                  value={customSetId}
                  onChange={event => setCustomSetId(event.target.value)}
                  placeholder={t('cardSearch.customSetIdPlaceholder')}
                  autoComplete="off"
                  className="input"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-text-secondary">{t('scanner.newSetName')}</span>
                <input
                  type="text"
                  value={customSetName}
                  onChange={event => setCustomSetName(event.target.value)}
                  autoComplete="off"
                  className="input"
                />
              </label>
            </div>
          )}

          {!effectiveSetId && (
            <p className="text-xs leading-relaxed text-text-muted">{t('scanner.setRequired')}</p>
          )}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row">
            <button type="button" onClick={onClose} disabled={submitting} className="btn-ghost sm:px-4">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={!formReady || submitting} className="btn-primary flex-1">
              {submitting
                ? <Loader2 size={16} className="animate-spin" aria-hidden />
                : <Plus size={16} aria-hidden />}
              {submitting ? t('common.saving') : t('cardSearch.createAndAdd')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

export default ScanCustomCardModal
