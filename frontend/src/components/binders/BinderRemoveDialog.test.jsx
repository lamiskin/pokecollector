import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RemoveCopyChooser, RemoveCopyConfirm } from './BinderRemoveDialog'

vi.mock('../CollectionCardImage', () => ({
  CollectionCardDisplay: ({ item }) => createElement('div', {
    'data-private-artwork': true,
    'data-scan-photo': String(Boolean(item?.has_scan_photo)),
  }),
}))
vi.mock('../card-system', () => ({
  CardDisplay: () => createElement('div', { 'data-public-artwork': true }),
}))

const t = key => ({
  'binderLayout.removeFromBinder': 'Remove from this binder',
  'binderLayout.removeFromBinderHelpOnly': 'This is the only copy of this card in this binder, so the card leaves the binder.',
  'binderLayout.removeFromBinderHelpMany': 'This copy leaves this binder and stays in your collection. Every other copy stays in this binder.',
  'binderLayout.removeFromBinderHelpUnresolved': 'This older entry leaves this binder.',
  'binderLayout.removeFromCollection': 'Remove from collection',
  'binderLayout.removeFromCollectionHelp': 'Also deletes one of your {owned} owned copies from your collection.',
  'binderLayout.removeFromCollectionHelpSingle': 'Also deletes your last owned copy: it leaves your collection.',
  'binderLayout.removeFromCollectionHelpUnknown': 'Also deletes one owned copy from your collection.',
  'binderLayout.removeProductRule': 'If this is your last owned copy and it is linked to a product, removal is refused.',
  'binderLayout.removeCopiesHere': '{count} in this binder',
  'binderLayout.removeCopiesOwned': '{count} in your collection',
  'binderLayout.removeConfirmTitle': 'Delete this copy from your collection?',
  'binderLayout.removeConfirmBody': 'One of {owned} owned copies of {name} is deleted and the binder copy is released.',
  'binderLayout.removeConfirmBodySole': '{name} is your last owned copy. It is deleted from your collection.',
  'binderLayout.removeConfirmBodyUnknown': 'An owned copy of {name} is deleted and the binder copy is released.',
  'binderLayout.removeConfirmAction': 'Delete from collection',
  'binderLayout.removeBack': 'Back',
}[key] || key)

const entry = {
  binder_card_id: 7,
  card_id: 'sample-1_en',
  name: 'Sample card',
  quantity: 3,
  unplaced_quantity: 1,
  owned_quantity: 2,
  collection_item_id: 21,
}
const location = 'Page 2 · Slot 7'
const chooser = overrides => renderToStaticMarkup(createElement(RemoveCopyChooser, {
  t,
  entry,
  location,
  pending: null,
  stale: false,
  onRemoveBinder() {},
  onRemoveCollection() {},
  ...overrides,
}))

describe('remove-copy dialog', () => {
  it('names the copy and offers both removals for a linked collection item', () => {
    const markup = chooser()
    expect(markup).toContain('data-private-artwork')
    expect(markup).toContain('Page 2 · Slot 7')
    expect(markup).toContain('3 in this binder')
    expect(markup).toContain('2 in your collection')
    expect(markup).toContain('Remove from this binder')
    expect(markup).toContain('Remove from collection')
    expect(markup).toContain('This copy leaves this binder and stays in your collection. Every other copy stays in this binder.')
    expect(markup).toContain('Also deletes one of your 2 owned copies from your collection.')
    expect(markup).toContain('removal is refused')
  })
  it('hides collection removal for an entry that owns no inventory link', () => {
    const markup = chooser({ entry: { ...entry, collection_item_id: null, unresolved: true } })
    expect(markup).toContain('Remove from this binder')
    expect(markup).not.toContain('Remove from collection')
    expect(markup).toContain('This older entry leaves this binder.')
    expect(markup).not.toContain('removal is refused')
  })
  it('warns that the last owned copy leaves the collection entirely', () => {
    const lastCopy = chooser({ entry: { ...entry, owned_quantity: 1 } })
    expect(lastCopy).toContain('Also deletes your last owned copy: it leaves your collection.')
    const confirm = renderToStaticMarkup(createElement(RemoveCopyConfirm, { t, entry: { ...entry, owned_quantity: 1 }, pending: null, onBack() {}, onConfirm() {} }))
    expect(confirm).toContain('Delete this copy from your collection?')
    expect(confirm).toContain('Sample card is your last owned copy.')
    expect(confirm).toContain('Delete from collection')
    expect(confirm).toContain('Back')
  })
})
