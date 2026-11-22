import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, BookOpen, Clock3, Loader2, PackageCheck, RefreshCw, ScanLine, Search, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  deleteScanJob,
  fetchScanJobItemImageBlob,
  getScanJob,
  getScanJobs,
  resolveAndAddScanJobItem,
  resolveScanJobItem,
  retryScanJobItem,
} from '../api/client'
import { ScanAddModal, attachScanFallbackPhoto } from '../components/CardScanner'
import { CardZoomModal, ScanItemPanel, useScanItemPhoto } from '../components/ScanReview'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import Modal from '../components/ui/Modal'
import { useSettings } from '../contexts/SettingsContext'
import {
  SCAN_JOBS_QUERY_KEY,
  hasActiveScanJobs,
  isScanJobActive,
  scanJobPollInterval,
} from '../utils/scanJobs'
import { formatRetryCountdown } from '../utils/retryCountdown'
import { searchGoogleByPhoto } from '../utils/cardLookup'
import { allocationNotice } from '../utils/scanAllocationNotice'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { useScanCatalogue } from '../hooks/useScanCatalogue'
import { getDefaultVariant } from '../utils/cardVariants'
import { normalizeTcgdexLanguage } from '../utils/tcgdexLanguages'

function useRetryClock(enabled) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return undefined
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [enabled])

  return now
}

function expiryLabel(job, t) {
  if (!job?.expires_at) return ''
  return `${t('scanner.expiresOn')} ${new Date(job.expires_at).toLocaleDateString()}`
}

function destinationIcon(binder) {
  return binder?.binder_type === 'physical_deck' ? PackageCheck : BookOpen
}

function DestinationChip({ binder, t }) {
  const Icon = destinationIcon(binder)
  return (
    <span className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-bg-card px-2 py-0.5 text-[11px] text-text-secondary">
      <Icon size={11} className="flex-shrink-0 text-brand-red" aria-hidden />
      <span className="truncate">{t('scanner.filingInto').replace('{name}', binder.name)}</span>
    </span>
  )
}

// Auto-filing is best effort: see utils/scanAllocationNotice.js for the
// message rules. The chosen destination is copied onto the selection so it
// stays known while the add form is open, even if a poll clears job.binder.
function JobRow({ job, onOpen, retryNow, t }) {
  const waitingOnly = Number(job.retrying || 0) > 0 && Number(job.active || 0) === Number(job.retrying || 0)
  const DestinationIcon = destinationIcon(job.binder)
  return (
    <button type="button" onClick={() => onOpen(job.id)}
      className="w-full rounded-2xl border border-border bg-bg-surface p-4 text-left transition-colors hover:border-brand-red/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-text-primary">
            {job.processed}/{job.total} {t('scanner.processed')}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {job.attention > 0 && `${job.attention} ${t('scanner.needReview')}`}
            {job.attention > 0 && job.failed_attention > 0 && ' · '}
            {job.failed_attention > 0 && `${job.failed_attention} ${t('scanner.failed')}`}
          </p>
          {job.binder && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-text-muted">
              <DestinationIcon size={11} className="flex-shrink-0" aria-hidden />
              <span className="truncate">{job.binder.name}</span>
            </p>
          )}
          <p className="mt-1 flex items-center gap-1 text-[11px] text-text-muted">
            <Clock3 size={11} /> {expiryLabel(job, t)}
          </p>
        </div>
        {waitingOnly ? (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-text-muted">
            <Clock3 size={13} /> {formatRetryCountdown(job.next_retry_at, t, retryNow, job.retry_reason)}
          </span>
        ) : isScanJobActive(job) ? (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-xs text-text-muted">
            <Loader2 size={13} className="animate-spin" /> {t('scanner.processing')}
          </span>
        ) : (
          <span className="rounded-full bg-brand-red/15 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-brand-red">
            {job.attention} {t('scanner.ready')}
          </span>
        )}
      </div>
    </button>
  )
}

function JobDetail({ jobId, onObscuredChange }) {
  const { t } = useSettings()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [addSelection, setAddSelection] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [itemModalOpen, setItemModalOpen] = useState(false)
  // The quick add (no add form) in flight. Held here rather than in the modal
  // so the row it came from can stay disabled while the request is pending —
  // a second tap must not add the card twice.
  const [quickAddItemId, setQuickAddItemId] = useState(null)
  // The full-screen review session: which photo is open and which of its
  // candidates. Owned here rather than by a single ScanItemPanel because
  // accepting a match from the zoom view walks on to the *next* unresolved
  // photo in the job (see openNextReview below) — a per-item panel cannot
  // see past its own item, so the page has to be the thing that remembers
  // where the reviewer is in the batch.
  const [review, setReview] = useState(null) // { itemId, matchIndex }
  // The add modal only needs to know the add succeeded. The full response also
  // carries the best-effort filing result, kept here so this page can explain
  // a shortfall without making the modal aware of allocation at all.
  const allocationRef = useRef(null)

  useEffect(() => {
    onObscuredChange(Boolean(addSelection || confirmation || itemModalOpen || review))
    return () => onObscuredChange(false)
  }, [addSelection, confirmation, itemModalOpen, review, onObscuredChange])

  const { data: job, isLoading, isError } = useQuery({
    queryKey: ['scan-job', jobId],
    queryFn: () => getScanJob(jobId),
    refetchInterval: query => scanJobPollInterval(query.state.data),
  })
  const retryNow = useRetryClock(Number(job?.retrying || 0) > 0)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['scan-job', jobId] })
    queryClient.invalidateQueries({ queryKey: SCAN_JOBS_QUERY_KEY })
  }

  const resolveMutation = useMutation({
    mutationFn: ({ item, cardId = null }) => resolveScanJobItem(jobId, item.id, cardId),
    onSuccess: (_data, { item, fromReview }) => {
      // Resolved items stay in job.items (collapsed, not removed — see
      // get_scan_job in backend/api/scan_jobs.py), so "nothing left to do"
      // means no *unresolved* item remains, not an empty list.
      const remaining = (job?.items || []).filter(
        candidate => candidate.id !== item.id && !candidate.resolved
      )
      setConfirmation(null)
      invalidate()
      if (remaining.length === 0) navigate('/scans', { replace: true })
      // A dismiss made from the full-screen walk advances to the next photo,
      // matching how accepting a match does — otherwise dismissing a no-match
      // photo strands the reviewer back at the list.
      else if (fromReview) openNextReview(item.id)
    },
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const retryMutation = useMutation({
    mutationFn: item => retryScanJobItem(jobId, item.id),
    onSuccess: invalidate,
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteScanJob(jobId),
    onSuccess: () => {
      setConfirmation(null)
      invalidate()
      navigate('/scans', { replace: true })
    },
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const dismiss = (item, fromReview = false) => setConfirmation({ type: 'dismiss', item, fromReview })

  const discardJob = () => setConfirmation({ type: 'discard' })

  const confirmDestructiveAction = () => {
    if (confirmation?.type === 'dismiss') resolveMutation.mutate({ item: confirmation.item, fromReview: confirmation.fromReview })
    else if (confirmation?.type === 'discard') deleteMutation.mutate()
  }

  const items = job?.items || []
  const reviewItem = review ? items.find(candidate => candidate.id === review.itemId) : null
  const reviewMatches = reviewItem?.matches || []
  const reviewMatch = reviewMatches[review?.matchIndex] || null
  // Called unconditionally and above the early returns below: hooks cannot
  // sit behind a loading branch. It no-ops until a review is actually open.
  const reviewPhoto = useScanItemPhoto(jobId, reviewItem)
  const reviewLang = normalizeTcgdexLanguage(reviewMatch?.lang || reviewMatch?._lang || reviewItem?.recognized?.language)
  const reviewCatalogue = useScanCatalogue(reviewItem?.resolved ? null : reviewMatch?.id, reviewLang)
  const quickAddVariant = reviewCatalogue.loading ? null : getDefaultVariant(reviewCatalogue.card)

  // Walk to the next photo still worth looking at, so a batch can be cleared
  // without going back to the list between cards. Anything already resolved or
  // not yet finished is skipped; a `done` item with no matches is *not* skipped
  // — the reviewer needs to reach those too, to retry or dismiss them.
  const openNextReview = fromItemId => {
    const start = items.findIndex(candidate => candidate.id === fromItemId)
    const ordered = [...items.slice(start + 1), ...items.slice(0, Math.max(0, start))]
    const next = ordered.find(candidate =>
      !candidate.resolved && candidate.status === 'done')
    setReview(next ? { itemId: next.id, matchIndex: 0 } : null)
  }

  // Retry triggered from the full-screen no-match surface. Advancing on success
  // (rather than immediately) matches how accepting a match walks on: the item
  // only leaves the walk once the retry has actually been accepted by the server.
  const retryFromReview = item => {
    retryMutation.mutateAsync(item)
      .then(() => openNextReview(item.id))
      .catch(() => {})
  }

  // Reverse image search on the photo behind the full-screen no-match surface.
  const searchReviewPhoto = item => {
    if (!reviewPhoto) return
    searchGoogleByPhoto(reviewPhoto, `photo-${item.position + 1}`)
    toast(t('scanner.searchByPhotoSaved'), { duration: 6000 })
  }

  // The displayed finish and submitted finish share the same catalogue result.
  // NM and quantity one remain express defaults, not scanner predictions.
  const quickAdd = async (item, card) => {
    if (quickAddItemId != null || reviewCatalogue.loading || !quickAddVariant || card.id !== reviewMatch?.id) return
    setQuickAddItemId(item.id)
    try {
      // Resolving a queued scan deletes its stored source photo, so the bytes
      // are retained before the atomic add and attached afterwards — the same
      // best-effort photo retention the add form does.
      const photo = item.has_image
        ? await fetchScanJobItemImageBlob(jobId, item.id).catch(() => null)
        : null
      const result = await resolveAndAddScanJobItem(jobId, item.id, {
        card_id: reviewCatalogue.id,
        confirmed_card_id: card.tcg_card_id,
        quantity: 1,
        condition: 'NM',
        variant: quickAddVariant,
        printing_details: [],
        lang: reviewLang,
      })
      // Never allowed to undo the add.
      await attachScanFallbackPhoto({
        created: result.collection_item,
        match: card,
        getPhoto: photo ? () => Promise.resolve(photo) : undefined,
      })
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      toast.success(`${card.name} ${t('scanner.addedToCollection')}!`)
      const notice = allocationNotice(result.binder_allocation, t, job.binder?.name || null)
      if (notice) toast(notice, { duration: 6000 })
      invalidate()
      // Same walk-on as accepting a match from the form: the server has
      // already added the card and resolved the item, so advancing here cannot
      // duplicate anything.
      const remaining = items.filter(candidate => candidate.id !== item.id && !candidate.resolved)
      if (remaining.length === 0) navigate('/scans', { replace: true })
      else openNextReview(item.id)
    } catch (error) {
      // Stay on this comparison: nothing was added, so advancing would skip a
      // card the reviewer still has to deal with.
      toast.error(error?.response?.data?.detail || t('scanner.actionFailed'))
    } finally {
      setQuickAddItemId(null)
    }
  }

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-brand-red" /></div>
  }
  if (isError || !job) {
    return (
      <div role="alert" className="rounded-xl border border-brand-red/20 bg-brand-red/10 p-4 text-center text-sm text-brand-red">
        {t('scanner.jobLoadFailed')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => navigate('/scans')}
          className="btn-ghost px-3 py-1.5 text-sm">
          <ArrowLeft size={16} /> {t('scanner.backToScans')}
        </button>
        <button type="button" onClick={discardJob} disabled={deleteMutation.isPending}
          className="btn-ghost h-9 w-9 border-brand-red/30 p-0 text-brand-red hover:bg-brand-red/10"
          aria-label={t('scanner.discardJob')} title={t('scanner.discardJob')}>
          <Trash2 size={17} />
        </button>
      </div>

      <div className="rounded-2xl border border-border bg-bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-bold text-text-primary">{job.processed}/{job.total} {t('scanner.processed')}</p>
            {job.binder && <DestinationChip binder={job.binder} t={t} />}
            <p className="mt-1 text-xs text-text-muted">{expiryLabel(job, t)}</p>
          </div>
          {Number(job.retrying || 0) > 0 && Number(job.active || 0) === Number(job.retrying || 0) ? (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <Clock3 size={13} /> {formatRetryCountdown(job.next_retry_at, t, retryNow, job.retry_reason)}
            </span>
          ) : isScanJobActive(job) && (
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <Loader2 size={13} className="animate-spin" /> {t('scanner.processing')}
            </span>
          )}
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/5">
          <div className="h-full rounded-full bg-brand-red transition-all"
            style={{ width: `${job.total ? Math.round((job.processed / job.total) * 100) : 0}%` }} />
        </div>
        <p className="mt-2 text-xs text-text-muted">
          {job.pending + job.processing + job.retrying} {t('scanner.remaining')}
          {job.failed > 0 && ` · ${job.failed} ${t('scanner.failed')}`}
        </p>
      </div>

      <div className="space-y-3">
        {items.map(item => (
          <ScanItemPanel
            key={item.id}
            jobId={job.id}
            item={item}
            onAdd={(scanItem, match) => setAddSelection({
              item: scanItem,
              match,
              binderName: job.binder?.name || null,
            })}
            onRetry={itemToRetry => retryMutation.mutate(itemToRetry)}
            onDismiss={dismiss}
            onReview={(scanItem, matchIndex) => setReview({ itemId: scanItem.id, matchIndex })}
            onModalChange={setItemModalOpen}
            retryNow={retryNow}
            t={t}
          />
        ))}
      </div>

      {reviewItem && reviewMatch && !addSelection && (
        <CardZoomModal
          card={reviewMatch}
          photoUrl={reviewPhoto}
          jobId={jobId}
          itemId={reviewItem.id}
          nameEn={reviewItem.recognized?.name_en}
          matches={reviewMatches}
          index={review.matchIndex}
          onIndex={matchIndex => setReview(current => ({ ...current, matchIndex }))}
          onAccept={reviewItem.resolved
            ? undefined
            : card => setAddSelection({
              item: reviewItem,
              match: card,
              fromReview: true,
              binderName: job.binder?.name || null,
            })}
          onQuickAdd={reviewItem.resolved
            ? undefined
            : card => quickAdd(reviewItem, card)}
          quickAddPending={quickAddItemId === reviewItem.id}
          quickAddVariant={quickAddVariant}
          quickAddLoading={reviewCatalogue.loading}
          // Dismissing mid-add would let the finished request walk the batch on
          // under a closed viewer, so the comparison stays put until it settles.
          onClose={() => { if (quickAddItemId == null) setReview(null) }}
          t={t}
        />
      )}

      {/* Full-screen surface for a `done` item that came back with no matches.
          The walk now lands here too (see openNextReview), so the reviewer gets
          a clear, actionable message instead of being silently skipped. The
          photo is the content — same frame and zoom as a matched item so the
          walk feels continuous — with Retry / Dismiss / search-by-photo beneath. */}
      {reviewItem && !reviewMatch && reviewItem.status === 'done' && !reviewItem.resolved && !addSelection && (
        <CardZoomModal
          card={null}
          photoUrl={reviewPhoto}
          onClose={() => setReview(null)}
          t={t}
          footer={(
            <div className="space-y-3">
              <p role="alert" className="rounded-xl border border-border bg-bg-card px-3 py-2 text-center text-sm text-text-muted">
                {reviewItem.recovery_hint === 'recapture_sharper'
                  ? t('scanner.tooBlurryRetake')
                  : reviewItem.error || t('scanner.noMatches')}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button type="button" onClick={() => retryFromReview(reviewItem)} disabled={!reviewItem.has_image}
                  className="btn-primary justify-center">
                  <RefreshCw size={14} /> {reviewItem.batch_mode ? t('scanner.retryIndividually') : t('common.retry')}
                </button>
                <button type="button" onClick={() => dismiss(reviewItem, true)}
                  className="btn-ghost border-brand-red/30 text-brand-red hover:bg-brand-red/10">
                  <Trash2 size={14} /> {t('scanner.dismissScan')}
                </button>
                {reviewPhoto && (
                  <button type="button" onClick={() => searchReviewPhoto(reviewItem)}
                    className="btn-ghost">
                    <Search size={14} /> {t('scanner.searchByPhoto')}
                  </button>
                )}
              </div>
            </div>
          )}
        />
      )}

      {addSelection && (
        <ScanAddModal
          match={addSelection.match}
          defaultLang={addSelection.item.recognized?.language || addSelection.match.lang || 'en'}
          getPhoto={() => addSelection.item.has_image
            ? fetchScanJobItemImageBlob(job.id, addSelection.item.id)
            : Promise.resolve(null)}
          preservePhotoBeforeAdd
          addCard={async payload => {
            const result = await resolveAndAddScanJobItem(
              job.id,
              addSelection.item.id,
              {
                ...payload,
                confirmed_card_id: addSelection.match.tcg_card_id,
              },
            )
            allocationRef.current = result.binder_allocation || null
            return result.collection_item
          }}
          binderName={addSelection.binderName || job.binder?.name || null}
          // Cancelling returns to the comparison for the same photo rather
          // than skipping it: backing out of the add form is not a decision
          // about the card, and silently advancing would strand the user.
          onClose={() => setAddSelection(null)}
          onAdded={() => {
            // The server has atomically added the card and resolved this item
            // before this callback runs, so a failed or duplicated request
            // can never advance the batch or increment quantity twice.
            const cameFromReview = addSelection.fromReview
            const finishedItemId = addSelection.item?.id
            const remaining = items.filter(
              candidate => candidate.id !== finishedItemId && !candidate.resolved
            )
            // The success toast has already fired in the modal; this one only
            // adds the filing outcome, and only when it fell short.
            const notice = allocationNotice(
              allocationRef.current,
              t,
              addSelection.binderName || job.binder?.name || null,
            )
            allocationRef.current = null
            if (notice) toast(notice, { duration: 6000 })
            setAddSelection(null)
            invalidate()
            if (remaining.length === 0) navigate('/scans', { replace: true })
            else if (cameFromReview) openNextReview(finishedItemId)
          }}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmation)}
        onClose={() => setConfirmation(null)}
        onConfirm={confirmDestructiveAction}
        title={confirmation?.type === 'discard' ? t('scanner.discardJob') : t('scanner.dismissScan')}
        message={confirmation?.type === 'discard' ? t('scanner.discardJobConfirm') : t('scanner.dismissScanConfirm')}
        confirmLabel={confirmation?.type === 'discard' ? t('scanner.discardJob') : t('scanner.dismissScan')}
        cancelLabel={t('common.cancel')}
        isPending={deleteMutation.isPending || resolveMutation.isPending}
        destructive
      />
    </div>
  )
}

export default function ScanQueue() {
  const { t } = useSettings()
  const navigate = useNavigate()
  const { jobId } = useParams()
  const [isNestedOpen, setIsNestedOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })

  const closeScans = () => navigate('/search')
  const jobs = data?.jobs || []
  const retryNow = useRetryClock(jobs.some(job => Number(job.retrying || 0) > 0))
  return (
    <Modal isOpen onClose={closeScans} title={t('scanner.queueTitle')} size="xl" isObscured={isNestedOpen}>
      <div className="space-y-4 p-4 sm:p-5">
        {jobId ? (
          <JobDetail jobId={Number(jobId)} onObscuredChange={setIsNestedOpen} />
        ) : (
          <>
            <p className="text-sm text-text-secondary">{t('scanner.queueSubtitle')}</p>

            {isLoading ? (
              <div className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-brand-red" /></div>
            ) : jobs.length === 0 ? (
              <div className="card space-y-3 py-12 text-center">
                <ScanLine size={28} className="mx-auto text-text-muted opacity-50" />
                <p className="text-sm text-text-muted">{t('scanner.noScans')}</p>
                <button type="button" onClick={closeScans} className="btn-primary mx-auto justify-center">
                  {t('scanner.goScan')}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {jobs.map(job => <JobRow key={job.id} job={job} onOpen={id => navigate(`/scans/${id}`)} retryNow={retryNow} t={t} />)}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
