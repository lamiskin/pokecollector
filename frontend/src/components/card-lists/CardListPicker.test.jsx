import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import CardListPicker from './CardListPicker'

vi.mock('../../api/client', () => ({
  searchCards: vi.fn(),
}))

vi.mock('../card-system', () => ({
  CardDisplay: ({ card, unavailableReason }) => createElement('div', { 'data-card': card.id }, card.name, unavailableReason ? ` | ${unavailableReason}` : ''),
  withCollectionItemState: card => card,
}))

vi.mock('../card-system/CardSelectionQuantityModal', () => ({
  default: () => null,
}))

vi.mock('../CollectionCardImage', () => ({
  CollectionCardDisplay: ({ card, unavailableReason }) => createElement('div', { 'data-card': card.id }, card.name, unavailableReason ? ` | ${unavailableReason}` : ''),
}))

const collection = [
  { id: 1, quantity: 1, card: { id: 'pika', name: 'Pikachu', number: '025', lang: 'en', set_ref: { id: 'sv1', name: 'Scarlet & Violet' } } },
  { id: 2, quantity: 1, card: { id: 'ball', name: 'Ultra Ball', number: '196', lang: 'en', set_ref: { id: 'sv2', name: 'Paldea Evolved' } } },
]

function renderPicker(props) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client },
    createElement(CardListPicker, {
      open: true,
      title: 'Add cards',
      collection,
      t: key => key,
      label: (key, values) => Object.entries(values || {}).reduce((text, [name, value]) => text.replace(`{${name}}`, value), key),
      onSubmit: async () => ({}),
      ...props,
    }),
  ))
}

describe('CardListPicker unavailable cards', () => {
  it('hides already added cards behind a toggle', () => {
    const markup = renderPicker({ existingCardIds: ['ball'] })

    expect(markup).toContain('Pikachu')
    expect(markup).not.toContain('Ultra Ball')
    expect(markup).toContain('cardListPicker.showUnavailable')
    expect(markup).toContain('aria-pressed="false"')
  })

  it('shows no toggle when every card can be added', () => {
    const markup = renderPicker({ existingCardIds: [] })

    expect(markup).toContain('Pikachu')
    expect(markup).toContain('Ultra Ball')
    expect(markup).not.toContain('cardListPicker.showUnavailable')
  })

  it('hides collection copies that have no free quantity', () => {
    const markup = renderPicker({ selectionMode: 'collection-item', maxQuantityById: { 1: 1, 2: 0 } })

    expect(markup).toContain('Pikachu')
    expect(markup).not.toContain('Ultra Ball')
    expect(markup).toContain('cardListPicker.showUnavailable')
  })
})
