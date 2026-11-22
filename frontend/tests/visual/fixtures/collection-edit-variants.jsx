import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../../src/contexts/AuthContext'
import { SettingsProvider } from '../../../src/contexts/SettingsContext'
import { ConfirmDialogProvider } from '../../../src/contexts/ConfirmDialogContext'
import { CollectionEditModal } from '../../../src/pages/Collection'
import '../../../src/components/card-system/tokens.css'
import '../../../src/components/card-system/styles.css'
import '../../../src/index.css'

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') || 'holo-only'
const knownFlags = flags => ({
  variants_normal: false, variants_holo: false, variants_reverse: false, variants_first_edition: false, ...flags,
})

// The catalogue advertises only Holo for this printing; 'unknown' keeps every
// flag null so the form must stay fully editable.
const flags = scenario === 'unknown' ? {} : knownFlags({ variants_holo: true })

const card = {
  id: 'synthetic-001_en',
  tcg_card_id: 'synthetic-001',
  lang: 'en',
  name: 'Synthetic Holo card',
  number: '001',
  rarity: 'Rare',
  set_name: 'Synthetic set',
  set_abbreviation: 'SYN',
  images_small: '/api/synthetic-art.png',
  images_large: '/api/synthetic-art.png',
  ...flags,
}

const item = {
  id: 41,
  card_id: 'synthetic-001_en',
  card,
  quantity: 2,
  condition: 'NM',
  // 'contradicted' stores a Normal row whose catalogue now advertises only Holo.
  variant: scenario === 'contradicted' ? 'Normal' : 'Holo',
  lang: 'en',
  printing_details: [],
  purchase_price: null,
  has_scan_photo: false,
}

function Harness() {
  return <CollectionEditModal item={item} onClose={() => {}} />
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
