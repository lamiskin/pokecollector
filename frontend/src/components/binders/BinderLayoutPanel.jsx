import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import { getApiErrorMessage, getBinderLayout, moveBinderPlacement, previewBinderLayout, saveBinderLayout, undoBinderLayout } from '../../api/client'
import { useSettings } from '../../contexts/SettingsContext'
import BinderWorkspace from './BinderWorkspace'
import BinderLayoutSettings from './BinderLayoutSettings'
import { resolveBinderTarget } from '../../utils/binderLayout'

export default function BinderLayoutPanel({ binder, membershipSnapshot, onViewChange, onOpen }) {
  const { t } = useSettings()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const key = ['binder-layout', String(binder.id)]
  const { data, error, isLoading, refetch } = useQuery({ queryKey: key, queryFn: () => getBinderLayout(binder.id), staleTime: 0, refetchOnMount: 'always' })
  const view = params.get('view') === 'cards' ? 'cards' : data?.layout ? 'pages' : 'cards'
  const viewReady = Boolean(data)
  const target = data ? resolveBinderTarget(data, params) : null
  useEffect(() => onViewChange(view), [view, onViewChange])
  useEffect(() => { client.invalidateQueries({ queryKey: ['binder-layout', String(binder.id)] }) }, [membershipSnapshot, binder.id, client])
  const mutation = useMutation({
    mutationFn: async ({ operation, body }) => {
      try {
        if (operation === 'layout') return await saveBinderLayout(binder.id, body)
        if (operation === 'undo') return await undoBinderLayout(binder.id, data.revision)
        return await moveBinderPlacement(binder.id, { ...body, expected_revision: body.expected_revision || data.revision })
      } catch (e) {
        if (e.response?.status === 409) await refetch()
        throw new Error(getApiErrorMessage(e, t('binderLayout.failed')))
      }
    },
    onSuccess: snapshot => { client.setQueryData(key, snapshot); client.invalidateQueries({ queryKey: ['card-locations'] }) },
  })
  const changeView = value => { const next = new URLSearchParams(params); next.set('view', value); setParams(next, { preventScrollReset: true }) }
  return <section className="space-y-4" aria-label={t('binderLayout.workspace')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="inline-flex gap-1 rounded-xl border border-border bg-bg-card p-1" role="group" aria-label={t('binderLayout.view')}>
        <button type="button" className={`${viewReady && view === 'pages' ? 'btn-primary' : 'btn-ghost'} min-h-11`} aria-pressed={viewReady && view === 'pages'} disabled={!data?.layout || mutation.isPending} onClick={() => changeView('pages')}>{t('binderLayout.pages')}</button>
        <button type="button" className={`${viewReady && view === 'cards' ? 'btn-primary' : 'btn-ghost'} min-h-11`} aria-pressed={viewReady && view === 'cards'} disabled={mutation.isPending} onClick={() => changeView('cards')}>{t('binderLayout.cards')}</button>
      </div>
      <button type="button" className="btn-secondary min-h-11" onClick={() => setSettingsOpen(true)} disabled={!data || mutation.isPending}><Settings2 size={16} aria-hidden />{data?.layout ? t('binderLayout.settings') : t('binderLayout.setup')}</button>
    </div>
    {isLoading && <p role="status" className="text-sm text-text-secondary">{t('common.loading')}</p>}
    {error && <p role="alert" className="text-sm text-brand-red">{t('binderLayout.loadFailed')} <button className="btn-ghost" onClick={() => refetch()}>{t('binderLayout.retry')}</button></p>}
    {data && !data.layout && target && <div role="status" className="rounded-xl border border-yellow/30 bg-yellow/5 p-3 text-sm space-y-2"><p>{t(target.kind === 'missing' ? 'binderLayout.targetMissing' : 'binderLayout.layoutDisabled')}</p>{target.entry && <button className="btn-secondary" onClick={() => onOpen(target.entry)}>{t('binderLayout.openAssociatedCard')}</button>}</div>}
    {view === 'pages' && data?.layout && <BinderWorkspace key={binder.id} snapshot={data} binderId={binder.id} onOpen={onOpen} onMove={body => mutation.mutateAsync({ operation: 'move', body })} onUndo={() => mutation.mutateAsync({ operation: 'undo' })} t={t} accent={binder.color} />}
    {settingsOpen && data && <BinderLayoutSettings snapshot={data} t={t} onClose={() => setSettingsOpen(false)} onPreview={async body => { try { return await previewBinderLayout(binder.id, body) } catch (e) { throw new Error(getApiErrorMessage(e, t('binderLayout.failed'))) } }} onSave={async body => { await mutation.mutateAsync({ operation: 'layout', body }); setSettingsOpen(false) }} />}
  </section>
}
