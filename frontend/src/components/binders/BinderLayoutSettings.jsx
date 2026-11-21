import { useState } from 'react'
import Modal from '../ui/Modal'
import { binderMessage } from '../../utils/binderLayout'

export default function BinderLayoutSettings({ snapshot, onClose, onPreview, onSave, t }) {
  const [enabled, setEnabled] = useState(Boolean(snapshot.layout))
  const [pages, setPages] = useState(snapshot.layout?.page_count || 20)
  const [columns, setColumns] = useState(snapshot.layout?.columns || 3)
  const [firstPageSingle, setFirstPageSingle] = useState(Boolean(snapshot.layout?.first_page_single))
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = setter => event => { setter(event.target.type === 'checkbox' ? event.target.checked : event.target.value); setPreview(null); setError('') }
  const layoutBody = () => ({ page_count: enabled ? Number(pages) : null, rows: 3, columns: Number(columns), first_page_single: enabled ? firstPageSingle : false })
  const review = async () => {
    setBusy(true)
    setError('')
    try { setPreview(await onPreview(layoutBody())) }
    catch (e) { setError(e.message); setPreview(null) }
    finally { setBusy(false) }
  }
  const save = async event => {
    event.preventDefault()
    if (!preview) { review(); return }
    setBusy(true)
    setError('')
    try {
      await onSave({ ...preview.layout, ...layoutBody(), expected_revision: preview.revision, confirmed_unplace_ids: preview.affected.map(p => p.id) })
    } catch (e) { setError(e.message); setPreview(null) }
    finally { setBusy(false) }
  }
  // Preview is a review step, not a hidden second submit: the footer keeps the
  // destructive save as its own labelled button once a preview exists.
  const saveLabel = !preview ? '' : preview.affected.length ? binderMessage(t, 'confirmLayout', { count: preview.affected.length }) : t('binderLayout.saveLayout')
  return <Modal isOpen onClose={busy ? undefined : onClose} title={t('binderLayout.settings')} size="lg">
    <form className="space-y-4 p-5" onSubmit={save}>
      <p className="text-sm text-text-secondary">{t('binderLayout.setupHelp')}</p>
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={enabled} onChange={change(setEnabled)} disabled={busy} />{t('binderLayout.enable')}</label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm space-y-1"><span>{t('binderLayout.pageCount')}</span><input className="input w-full" type="number" min="1" max="500" required={enabled} disabled={!enabled || busy} value={pages} onChange={change(setPages)} /></label>
        <label className="text-sm space-y-1"><span>{t('binderLayout.grid')}</span><select className="select w-full" value={columns} disabled={!enabled || busy} onChange={change(setColumns)}><option value="3">3 × 3</option><option value="4">4 × 3</option></select></label>
      </div>
      <p className="text-xs text-text-secondary">{t('binderLayout.sidesHelp')}</p>
      <div className="space-y-1">
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={firstPageSingle} onChange={change(setFirstPageSingle)} disabled={!enabled || busy} />{t('binderLayout.firstPageSingle')}</label>
        <p className="pl-7 text-xs text-text-secondary">{t('binderLayout.firstPageSingleHelp')}</p>
      </div>
      {preview && <section className={`space-y-3 rounded-xl border p-3 ${preview.affected.length ? 'border-yellow/40 bg-yellow/5' : 'border-border bg-bg-surface'}`} aria-live="polite">
        <h3 className="text-sm font-semibold">{preview.affected.length ? binderMessage(t, 'affected', { count: preview.affected.length }) : t('binderLayout.noAffected')}</h3>
        <p className="text-sm text-text-secondary">{preview.layout ? binderMessage(t, 'previewLayout', { pages: preview.layout.page_count, slots: preview.layout.rows * preview.layout.columns }) : t('binderLayout.pagesOff')}</p>
        {preview.affected.length > 0 && <><p className="text-sm text-text-secondary">{t('binderLayout.affectedHelp')}</p><ul className="max-h-52 space-y-1 overflow-y-auto text-sm">{preview.affected.map(p => <li key={p.id}>{p.name || p.card_id} · {binderMessage(t, 'location', p)}</li>)}</ul></>}
        <p className="text-xs text-text-muted">{t('binderLayout.previewBadge')}</p>
      </section>}
      {error && <p role="alert" className="text-sm text-brand-red">{error}</p>}
      <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg-card px-5 py-4">
        <button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        {preview && <button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={review}>{t('binderLayout.previewAgain')}</button>}
        <button type="submit" className="btn-primary min-h-11" disabled={busy}>{busy ? t('binderLayout.saving') : preview ? saveLabel : t('binderLayout.preview')}</button>
      </div>
    </form>
  </Modal>
}
