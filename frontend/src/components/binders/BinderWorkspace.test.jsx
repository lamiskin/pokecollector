import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BinderPage } from './BinderWorkspace'

vi.mock('../CollectionCardImage', () => ({ CollectionCardDisplay: () => createElement('div', { 'data-private-artwork': true }) }))
vi.mock('../card-system', () => ({ CardDisplay: () => createElement('div', { 'data-public-artwork': true }) }))
const props = {
  number: 2,
  layout: { rows: 3, columns: 3 },
  placements: [{ id: 'copy-b', binder_card_id: 7, page: 2, slot: 7 }],
  entries: [{ binder_card_id: 7, card_id: 'sample-1_en', name: 'Sample card', variant: 'Holo' }],
  t: key => ({ 'binderLayout.location': 'Page {page} · Slot {slot}', 'binderLayout.page': 'Page {page}', 'binderLayout.emptySlot': 'Empty slot' }[key] || key),
}
describe('physical pages', () => {
  it.each([3, 4])('renders every stable slot in a %s-column page', columns => {
    const markup = renderToStaticMarkup(createElement(BinderPage, { ...props, layout: { rows: 3, columns } }))
    expect((markup.match(/data-slot=/g) || [])).toHaveLength(columns * 3)
    expect(markup).toContain('data-slot="7" data-page="2" data-placement="copy-b"')
    expect(markup).toContain('Page 2 · Slot 7 · Sample card · Holo')
    expect(markup).toContain(`repeat(${columns}, minmax(0,1fr))`)
  })
  it('search highlights without compacting slots or hiding other cards', () => {
    const markup = renderToStaticMarkup(createElement(BinderPage, { ...props, filter: 'sample' }))
    expect((markup.match(/data-slot=/g) || [])).toHaveLength(9)
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
})
