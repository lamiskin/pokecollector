import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import api from '../api/client'
import './CaptureLabProposals.css'

const views = ['Original', 'Crop', 'Turned', 'CollectorVision']

async function fetchProposal(item) {
  const urls = {}
  let unavailable = false
  for (const key of ['original', 'crop', 'turned', ...(item.cvUrl ? ['cv'] : [])]) {
    const path = (key === 'cv' ? item.cvUrl : item[`${key}Url`])?.replace(/^\/api(?=\/)/, '')
    if (!path) continue
    try {
      const response = await api.get(path, { responseType: 'blob' })
      urls[key] = URL.createObjectURL(response.data)
    } catch (error) {
      if (error.response?.status === 409 && key !== 'original') unavailable = true
      else if (key === 'original') throw error
    }
  }
  return { urls, unavailable }
}

export default function CaptureLabProposals() {
  const [items, setItems] = useState([])
  const [index, setIndex] = useState(0)
  const [view, setView] = useState('Original')
  const [votes, setVotes] = useState({})
  const [assets, setAssets] = useState({})
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState(false)
  const touchStart = useRef(null)
  const stageRef = useRef(null)
  // The stage is a flex child with a definite height, but a percentage
  // max-height on the image resolves against an auto-height wrapper and does
  // nothing -- on a short phone viewport the image then overflowed the stage and
  // was clipped. Measure the stage and give the wrapper that height instead, so
  // the image fits and the boundary overlay stays glued to it.
  const [photoHeight, setPhotoHeight] = useState(null)
  const objectUrls = useRef(new Set())
  const current = items[index]

  useEffect(() => {
    const node = stageRef.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(entries => {
      const height = entries[0]?.contentRect?.height
      if (height) setPhotoHeight(Math.max(160, Math.floor(height - 8)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [loading, failure, current?.stem])

  const loadList = useCallback(async () => {
    setLoading(true); setFailure(false)
    try {
      const response = await api.get('/capture-lab/proposals')
      setItems(response.data.items || []); setIndex(0); setAssets({})
    } catch { setFailure(true) } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadList() }, [loadList])

  useEffect(() => {
    let active = true
    const load = async (item) => {
      if (!item || assets[item.stem]) return
      try {
        const result = await fetchProposal(item)
        Object.values(result.urls).forEach(url => objectUrls.current.add(url))
        if (active) setAssets(prev => ({ ...prev, [item.stem]: result }))
      } catch { if (active) setAssets(prev => ({ ...prev, [item.stem]: { urls: {}, failed: true } })) }
    }
    load(current)
    if (items.length > 1) load(items[(index + 1) % items.length])
    return () => { active = false }
    // Assets are deliberately scoped to the current and next proposal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.stem, index, items])

  useEffect(() => () => objectUrls.current.forEach(URL.revokeObjectURL), [])

  const go = (next) => { setIndex((next + items.length) % items.length); setView('Original') }
  const verdict = (choice) => setVotes(prev => ({ ...prev, [current.stem]: choice }))
  const tally = Object.values(votes).reduce((acc, value) => ({ ...acc, [value]: acc[value] + 1 }), { crop: 0, original: 0 })
  const asset = current && assets[current.stem]
  const src = asset?.urls?.[{ Original: 'original', Crop: 'crop', Turned: 'turned', CollectorVision: 'cv' }[view]]
  const noProposal = asset?.unavailable || !current?.cropUrl
  const onTouchStart = event => { touchStart.current = [event.touches[0].clientX, event.touches[0].clientY] }
  const onTouchEnd = event => {
    if (!touchStart.current) return
    const dx = event.changedTouches[0].clientX - touchStart.current[0]
    if (Math.abs(dx) > 55) go(index + (dx < 0 ? 1 : -1))
    touchStart.current = null
  }

  return <main className="proposal-review" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
    <header className="proposal-topbar"><a href="/capture-lab" aria-label="Back to capture lab"><ChevronLeft /></a><span>Capture lab</span><span className="proposal-count">{loading ? '…' : `${items.length ? index + 1 : 0} / ${items.length}`}</span></header>
    {loading ? <section className="proposal-stage"><div className="proposal-skeleton" /></section> : failure ? <section className="proposal-message"><p>Could not load proposals.</p><button onClick={loadList}>Try again</button></section> : !current ? <section className="proposal-message"><p>No proposals yet.</p></section> : <>
      <section className="proposal-stage" ref={stageRef}>
        {src ? <div className="proposal-photo" style={photoHeight ? { height: `${photoHeight}px` } : undefined}><img src={src} alt={view === 'Original' ? 'Original card photo' : view === 'CollectorVision' ? 'CollectorVision' : `${view} crop`} />{view === 'Original' && <svg className="proposal-boundary" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Proposed crop boundary"><polygon points={current.quad.map(point => point.join(',')).join(' ')} /></svg>}</div> : <div className="proposal-skeleton" />}
        {noProposal && <div className="proposal-notice">The proposal could not be produced.</div>}
      </section>
      <section className="proposal-details"><div><span className="proposal-label">Unverified crop</span><p>{current.outputWidth} × {current.outputHeight}</p></div><span className="proposal-tally">{tally.crop} crop · {tally.original} original</span></section>
      <div className="proposal-view-slot"><nav className="proposal-views" aria-label="Photo view">{views.map(name => <button key={name} className={view === name ? 'selected' : ''} aria-pressed={view === name} aria-label={name === 'CollectorVision' ? 'CollectorVision' : undefined} disabled={name === 'CollectorVision' && !current.cvUrl} onClick={() => setView(name)}>{name === 'CollectorVision' ? 'CV' : name}</button>)}</nav><div className="proposal-comparison" aria-live="polite">{view === 'CollectorVision' && current.cvUrl ? <>{current.cv?.top1?.name || current.cv?.top1?.id}<small>{Number(current.cv?.score).toFixed(2)} · {current.cv?.detection === 'direct' ? 'direct' : 'padded'}</small></> : !current.cvUrl ? 'No comparison for this capture.' : '\u00a0'}</div></div>
      <footer className="proposal-actions"><button className="proposal-original" onClick={() => verdict('original')} aria-pressed={votes[current.stem] === 'original'}><RotateCcw size={18} />Use original</button><button className="proposal-use" disabled={noProposal} onClick={() => verdict('crop')} aria-pressed={votes[current.stem] === 'crop'}>Use this crop</button><div className="proposal-stepper"><button aria-label="Previous proposal" onClick={() => go(index - 1)}><ChevronLeft /></button><button aria-label="Next proposal" onClick={() => go(index + 1)}><ChevronRight /></button></div></footer>
    </>}
  </main>
}
