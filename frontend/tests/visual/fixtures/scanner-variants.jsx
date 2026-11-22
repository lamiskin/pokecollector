import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../../src/contexts/AuthContext'
import { SettingsProvider } from '../../../src/contexts/SettingsContext'
import { ConfirmDialogProvider } from '../../../src/contexts/ConfirmDialogContext'
import CardScanner, { ScanAddModal } from '../../../src/components/CardScanner'
import { CardModal } from '../../../src/components/CardItem'
import { getCard } from '../../../src/api/client'
import '../../../src/components/card-system/tokens.css'
import '../../../src/components/card-system/styles.css'
import '../../../src/index.css'

function ExistingCardHarness({ onClose }) {
  const [card, setCard] = useState(null)
  useEffect(() => { getCard('synthetic-001_en').then(({ data }) => setCard(data)) }, [])
  return <>
    <button id="refresh-card-evidence" onClick={() => getCard('synthetic-001_en').then(({ data }) => setCard(data))}>Refresh test catalogue</button>
    {card && <CardModal card={card} initialTab="add" onClose={onClose} />}
  </>
}

function Harness() {
  const [open, setOpen] = useState(true)
  const [added, setAdded] = useState(0)
  const params = new URLSearchParams(location.search)
  // Deliberately misleading scanner finish metadata: none is catalogue evidence.
  const match = {
    id: 'synthetic-001', name: 'Scanner candidate', lang: params.get('lang') || 'en',
    variants_normal: true, variants_holo: true, price_tcg_normal_market: 99,
    variant: 'Normal', finish: 'Normal',
  }
  return <>
    <p data-testid="added-count">{added}</p>
    {params.has('card')
      ? open && <ExistingCardHarness onClose={() => setOpen(false)} />
      : params.has('single')
      ? <CardScanner isOpen={open} onClose={() => setOpen(false)} />
      : open && <ScanAddModal match={match} getPhoto={() => Promise.resolve(new Blob(['synthetic scan'], { type: 'image/png' }))}
          onClose={() => setOpen(false)} onAdded={() => setAdded(count => count + 1)} />}
  </>
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BrowserRouter><AuthProvider><SettingsProvider><ConfirmDialogProvider>
        <Harness />
      </ConfirmDialogProvider></SettingsProvider></AuthProvider></BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
