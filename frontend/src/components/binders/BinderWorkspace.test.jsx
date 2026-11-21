import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BinderPage } from './BinderWorkspace'

vi.mock('../CollectionCardImage', () => ({
  CollectionCardDisplay: ({ item, stateIndicatorProps }) => createElement('div', {
    'data-private-artwork': true,
    'data-scan-photo': String(Boolean(item?.has_scan_photo)),
    'data-printing': stateIndicatorProps?.card?.owned_variants?.[0]?.variant || '',
    'data-quantity': String(stateIndicatorProps?.showQuantity),
  }),
}))
vi.mock('../card-system', () => ({
  CardDisplay: ({ stateIndicatorProps }) => createElement('div', {
    'data-public-artwork': true,
    'data-printing': stateIndicatorProps?.card?.owned_variants?.[0]?.variant || '',
  }),
}))
const props = {
  number: 2,
  layout: { rows: 3, columns: 3 },
  placements: [{ id: 'copy-b', binder_card_id: 7, page: 2, slot: 7 }],
  entries: [{ binder_card_id: 7, card_id: 'sample-1_en', name: 'Sample card', variant: 'Holo', collection_item_id: 21, has_scan_photo: true }],
  t: key => ({ 'binderLayout.location': 'Page {page} · Slot {slot}', 'binderLayout.page': 'Page {page}', 'binderLayout.emptySlot': 'Empty slot' }[key] || key),
}
describe('physical pages', () => {
  it.each([3, 4])('renders every stable slot in a %s-column page', columns => {
    const markup = renderToStaticMarkup(createElement(BinderPage, { ...props, layout: { rows: 3, columns } }))
    expect((markup.match(/<li class="binder-pocket/g) || [])).toHaveLength(columns * 3)
    expect(markup).toContain('data-slot="7" data-page="2" data-placement="copy-b"')
    expect(markup).toContain('Page 2 · Slot 7 · Sample card · Holo')
    expect(markup).toContain(`repeat(${columns}, minmax(0,1fr))`)
  })
  it('keeps empty pockets visible but stops them being dead controls outside arrange mode', () => {
    const browse = renderToStaticMarkup(createElement(BinderPage, props))
    expect((browse.match(/data-slot="/g) || [])).toHaveLength(1)
    expect(browse).toContain('binder-pocket-empty')
    expect(browse).toContain('Page 2 · Slot 1 · Empty slot')
    const arranging = renderToStaticMarkup(createElement(BinderPage, { ...props, arranging: true }))
    expect((arranging.match(/data-slot="/g) || [])).toHaveLength(9)
  })
  it('search highlights without compacting slots or hiding other cards', () => {
    const markup = renderToStaticMarkup(createElement(BinderPage, { ...props, filter: 'sample' }))
    expect((markup.match(/<li class="binder-pocket/g) || [])).toHaveLength(9)
    expect(markup).toContain('binder-pocket-highlight')
    expect(markup).toContain('data-placement="copy-b"')
  })
  it('public pages never render the private image wrapper or drag handles', () => {
    const markup = renderToStaticMarkup(createElement(BinderPage, { ...props, readOnly: true }))
    expect(markup).toContain('data-public-artwork')
    expect(markup).not.toContain('data-private-artwork')
    expect(markup).not.toContain('draggable=')
    expect(markup).not.toContain('binder-drag-handle')
  })
  it('gives the private pocket its own photo flag and printing, but never a quantity', () => {
    const markup = renderToStaticMarkup(createElement(BinderPage, props))
    expect(markup).toContain('data-private-artwork="true"')
    expect(markup).toContain('data-scan-photo="true"')
    expect(markup).toContain('data-printing="Holo"')
    expect(markup).toContain('data-quantity="false"')
  })
  it('does not invent a printing for a sanitized public entry', () => {
    const entries = [{ binder_card_id: 7, card_id: 'sample-1_en', name: 'Sample card' }]
    const markup = renderToStaticMarkup(createElement(BinderPage, { ...props, entries, readOnly: true }))
    expect(markup).toContain('data-public-artwork')
    expect(markup).toContain('data-printing=""')
    expect(markup).not.toContain('data-scan-photo')
  })
})
