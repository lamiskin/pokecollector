import { useState } from 'react'
import Modal from '../ui/Modal'
import { binderMessage } from '../../utils/binderLayout'

export default function BinderLayoutSettings({ snapshot, onClose, onPreview, onSave, t }) {
  const [enabled, setEnabled] = useState(Boolean(snapshot.layout))
  const [pages, setPages] = useState(snapshot.layout?.page_count || 20)
  const [columns, setColumns] = useState(snapshot.layout?.columns || 3)
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = setter => event => { setter(event.target.type === 'checkbox' ? event.target.checked : event.target.value); setPreview(null); setError('') }
  const submit = async event => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (!preview) setPreview(await onPreview({ page_count: enabled ? Number(pages) : null, rows: 3, columns: Number(columns) }))
      else await onSave({ ...preview.layout, page_count: preview.layout?.page_count ?? null, rows: 3, columns: preview.layout?.columns || Number(columns), expected_revision: preview.revision, confirmed_unplace_ids: preview.affected.map(p => p.id) })
    } catch (e) { setError(e.message); setPreview(null) }
    finally { setBusy(false) }
  }
  return <Modal isOpen onClose={busy ? undefined : onClose} title={t('binderLayout.settings')} size="lg">
    <form className="space-y-4 p-5" onSubmit={submit}>
      <p className="text-sm text-text-secondary">{t('binderLayout.setupHelp')}</p>
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={enabled} onChange={change(setEnabled)} disabled={busy} />{t('binderLayout.enable')}</label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm space-y-1"><span>{t('binderLayout.pageCount')}</span><input className="input w-full" type="number" min="1" max="500" required={enabled} disabled={!enabled || busy} value={pages} onChange={change(setPages)} /></label>
        <label className="text-sm space-y-1"><span>{t('binderLayout.grid')}</span><select className="select w-full" value={columns} disabled={!enabled || busy} onChange={change(setColumns)}><option value="3">3 × 3</option><option value="4">4 × 3</option></select></label>
      </div>
      <p className="text-xs text-text-secondary">{t('binderLayout.sidesHelp')}</p>
      {preview && <section className="rounded-xl border border-yellow/40 bg-yellow/5 p-3 space-y-3" aria-live="polite">
        <h3 className="font-semibold text-sm">{preview.affected.length ? binderMessage(t, 'affected', { count: preview.affected.length }) : t('binderLayout.noAffected')}</h3>
        {preview.affected.length > 0 && <><p className="text-sm text-text-secondary">{t('binderLayout.affectedHelp')}</p><ul className="max-h-52 overflow-y-auto space-y-1 text-sm">{preview.affected.map(p => <li key={p.id}>{p.name || p.card_id} · {binderMessage(t, 'location', p)}</li>)}</ul></>}
      </section>}
      {error && <p role="alert" className="text-sm text-brand-red">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? t('binderLayout.saving') : !preview ? t('binderLayout.preview') : preview.affected.length ? binderMessage(t, 'confirmLayout', { count: preview.affected.length }) : t('binderLayout.saveLayout')}</button>
      </div>
    </form>
  </Modal>
}
