import { useEffect, useRef } from 'react'
import { AlertTriangle, ArchiveX, ChevronLeft, ChevronRight, Loader2, ShieldAlert, Trash2 } from 'lucide-react'
import Modal from '../ui/Modal'
import Artwork from './BinderArtwork'
import { binderMessage } from '../../utils/binderLayout'

// Snapshots from before the owned count existed, and unresolved entries, carry
// no number. Every consequence line then stays honest instead of guessing one.
export function ownedCopyCount(entry) {
  return Number.isFinite(entry?.owned_quantity) ? entry.owned_quantity : null
}

export function RemoveCopyPills({ t, entry, location }) {
  const owned = ownedCopyCount(entry)
  const copies = Number.isFinite(entry?.quantity) ? entry.quantity : null
  return <ul className="mt-1 flex flex-wrap gap-1">
    <li className="binder-remove-pill">{location}</li>
    {copies !== null && <li className="binder-remove-pill">{binderMessage(t, 'removeCopiesHere', { count: copies })}</li>}
    {owned !== null && <li className="binder-remove-pill">{binderMessage(t, 'removeCopiesOwned', { count: owned })}</li>}
  </ul>
}

function RemoveCopyCard({ t, entry, location }) {
  return <div className="flex items-start gap-3 rounded-xl border border-border bg-bg-surface p-2">
    <div className="w-9 shrink-0" aria-hidden="true"><Artwork entry={entry} /></div>
    <div className="min-w-0">
      <p className="text-sm font-semibold">{entry.name}</p>
      <RemoveCopyPills t={t} entry={entry} location={location} />
    </div>
  </div>
}

// A whole-row choice: the consequence lives inside the target, so the decision
// is made by reading one line instead of matching a label to a hint elsewhere.
function RemoveAction({ danger = false, icon: Icon, title, help, waiting, disabled, onClick }) {
  return <button type="button" className={`binder-remove-action ${danger ? 'binder-remove-action-danger' : ''}`} disabled={disabled} onClick={onClick}>
    <span className={`binder-remove-icon ${danger ? 'binder-remove-icon-danger' : ''}`} aria-hidden="true"><Icon size={18} /></span>
    <span className="min-w-0 flex-1">
      <span className={`block text-sm font-semibold ${danger ? 'text-brand-red' : ''}`}>{title}</span>
      <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">{help}</span>
    </span>
    {waiting
      ? <Loader2 size={16} className="mt-2 shrink-0 animate-spin" aria-hidden />
      : <ChevronRight size={16} className="mt-2 shrink-0 text-text-muted" aria-hidden />}
  </button>
}

/**
 * Step one: pick which copy to remove. Binder removal keeps the owned copy;
 * the collection action is only offered when this entry is linked to owned
 * inventory, and it never deletes on this tap.
 */
export function RemoveCopyChooser({ t, entry, location, pending = null, stale = false, onRemoveBinder, onRemoveCollection }) {
  const owned = ownedCopyCount(entry)
  const copies = Number.isFinite(entry?.quantity) ? entry.quantity : 1
  const linked = Boolean(entry.collection_item_id)
  const busy = Boolean(pending)
  const binderHelp = entry.unresolved
    ? t('binderLayout.removeFromBinderHelpUnresolved')
    : copies > 1
      ? t('binderLayout.removeFromBinderHelpMany')
      : t('binderLayout.removeFromBinderHelpOnly')
  const collectionHelp = owned === null
    ? t('binderLayout.removeFromCollectionHelpUnknown')
    : owned <= 1
      ? t('binderLayout.removeFromCollectionHelpSingle')
      : binderMessage(t, 'removeFromCollectionHelp', { owned })
  return <div className="space-y-3">
    <RemoveCopyCard t={t} entry={entry} location={location} />
    <div className="space-y-2">
      <RemoveAction
        icon={ArchiveX}
        title={t('binderLayout.removeFromBinder')}
        help={binderHelp}
        waiting={pending === 'binder'}
        disabled={busy || stale}
        onClick={onRemoveBinder}
      />
      {linked && <RemoveAction
        danger
        icon={Trash2}
        title={t('binderLayout.removeFromCollection')}
        help={collectionHelp}
        waiting={pending === 'collection'}
        disabled={busy || stale}
        onClick={onRemoveCollection}
      />}
    </div>
    {linked && <p className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary"><ShieldAlert size={14} className="mt-px shrink-0" aria-hidden />{t('binderLayout.removeProductRule')}</p>}
  </div>
}

/**
 * Step two, only for deleting an owned copy. The delete itself is this button,
 * in danger styling, so a stray tap on the chooser above cannot delete a card.
 */
export function RemoveCopyConfirm({ t, entry, pending = null, onBack, onConfirm }) {
  const owned = ownedCopyCount(entry)
  const body = owned === null
    ? binderMessage(t, 'removeConfirmBodyUnknown', { name: entry.name })
    : owned <= 1
      ? binderMessage(t, 'removeConfirmBodySole', { name: entry.name })
      : binderMessage(t, 'removeConfirmBody', { name: entry.name, owned })
  const backRef = useRef(null)
  // The confirm step opens on the safe action: a second Enter must never delete
  // a card, so the destructive button is deliberately one Tab away.
  useEffect(() => {
    const frame = requestAnimationFrame(() => backRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  return <div className="space-y-4">
    <div className="flex items-start gap-3 rounded-xl border border-brand-red/40 bg-brand-red/10 p-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-red/15 text-brand-red" aria-hidden="true"><AlertTriangle size={16} /></span>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-semibold text-brand-red">{t('binderLayout.removeConfirmTitle')}</p>
        <p className="text-sm leading-relaxed text-text-secondary">{body}</p>
        <p className="text-xs leading-relaxed text-text-secondary">{t('binderLayout.removeProductRule')}</p>
      </div>
    </div>
    {/* One column on a phone, so Back stays first and the destructive button
        last, matching the DOM order a keyboard or screen reader follows. */}
    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
      <button ref={backRef} type="button" className="btn-ghost min-h-11" disabled={Boolean(pending)} onClick={onBack}><ChevronLeft size={16} aria-hidden />{t('binderLayout.removeBack')}</button>
      <button type="button" className="binder-remove-confirm" disabled={Boolean(pending)} onClick={onConfirm}>
        {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}
        {t('binderLayout.removeConfirmAction')}
      </button>
    </div>
  </div>
}

export default function BinderRemoveDialog({ isOpen, t, entry, location, step = 'choose', pending = null, stale = false, error = '', onClose, onRemoveBinder, onRemoveCollection, onBack, onConfirm }) {
  const chooserRef = useRef(null)
  const previousStep = useRef(step)
  // Coming back from the confirm step, focus returns to the first choice rather
  // than to the document, so a keyboard user is never dropped out of the dialog.
  useEffect(() => {
    if (previousStep.current === 'confirm' && step !== 'confirm') chooserRef.current?.querySelector('.binder-remove-action')?.focus()
    previousStep.current = step
  }, [step])
  if (!isOpen || !entry) return null
  const busy = Boolean(pending)
  return <Modal isOpen onClose={busy ? undefined : onClose} title={binderMessage(t, 'removeTitle', { name: entry.name })} size="sm">
    <div className="space-y-4 p-4 sm:p-5">
      {step === 'confirm'
        ? <RemoveCopyConfirm t={t} entry={entry} pending={pending} onBack={onBack} onConfirm={onConfirm} />
        : <div ref={chooserRef}><RemoveCopyChooser t={t} entry={entry} location={location} pending={pending} stale={stale} onRemoveBinder={onRemoveBinder} onRemoveCollection={onRemoveCollection} /></div>}
      {error && <div role="alert" className="space-y-1 rounded-xl border border-brand-red/30 bg-brand-red/5 p-3 text-sm text-brand-red">
        <p>{error}</p>
        {stale && <p className="text-xs opacity-90">{t('binderLayout.removeStaleHint')}</p>}
      </div>}
      {step === 'choose' && <div className="flex justify-end border-t border-border pt-3">
        <button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      </div>}
    </div>
  </Modal>
}
