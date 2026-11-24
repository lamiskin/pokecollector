import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CardLocationRow, locationRemovalPrompt } from './CardLocations'

// The row only needs the link's rendered anchor; a real router adds nothing to
// a static markup assertion and warns during server rendering.
vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }) => createElement('a', { href: to, ...props }, children),
}))
vi.mock('../../api/client', () => ({
  getCardLocations: vi.fn(),
  getApiErrorMessage: (_error, fallback) => fallback,
  removeBinderCopy: vi.fn(),
}))
vi.mock('../../api/publicClient', () => ({ getPublicCardLocations: vi.fn() }))
vi.mock('../../contexts/ConfirmDialogContext', () => ({ useConfirmDialog: () => vi.fn() }))

const t = key => ({
  'binderLayout.location': 'Page {page} · Slot {slot}',
  'binderLayout.unplacedCopies': 'Not placed ×{count}',
  'binderLayout.removeLocation': 'Remove one copy from {binder}',
  'binderLayout.removeLocationTitle': 'Remove one copy from {binder}?',
  'binderLayout.removeLocationBodyPlaced': 'Page {page}, slot {slot} becomes free in this binder. The copy stays in your collection.',
  'binderLayout.removeLocationBodyMany': 'One copy leaves this binder. The rest stay in Not placed and in your collection.',
  'binderLayout.removeLocationBodyUnplaced': 'This copy leaves this binder and stays in your collection.',
  'binderLayout.removeLocationConfirm': 'Remove copy',
}[key] || key)

const placed = { binder_id: 4, binder_card_id: 7, card_id: 'sample-1_en', binder_name: 'Trade binder', placement_id: 'copy-b', page: 2, slot: 7, quantity: 1 }
const unplacedGroup = { binder_id: 4, binder_card_id: 9, card_id: 'sample-1_en', binder_name: 'Trade binder', placement_id: null, page: null, slot: null, quantity: 3 }

const row = overrides => renderToStaticMarkup(createElement(CardLocationRow, {
  t,
  location: placed,
  pending: false,
  disabled: false,
  onRemove() {},
  ...overrides,
}))

describe('card binder locations', () => {
  it('offers a private row a remove control beside, never inside, the link', () => {
    const markup = row()
    expect(markup).toContain('aria-label="Remove one copy from Trade binder"')
    expect(markup).toContain('Page 2 · Slot 7')
    // The destructive control is a sibling of the navigation link so a tap on
    // the row still opens the binder and only the button removes a copy.
    const links = markup.match(/<a[\s\S]*?<\/a>/g) || []
    expect(links).toHaveLength(1)
    expect(links[0]).not.toContain('Remove one copy')
    expect(markup.indexOf('</a>')).toBeLessThan(markup.indexOf('aria-label="Remove one copy'))
  })

  it('never offers removal in the public view', () => {
    const markup = row({ handle: 'collector' })
    expect(markup).toContain('Page 2 · Slot 7')
    expect(markup).not.toContain('Remove one copy')
    expect(markup).not.toContain('<button')
  })

  it('counts the copies that stay in an unplaced group', () => {
    const markup = row({ location: unplacedGroup })
    expect(markup).toContain('Not placed ×3')
    expect(markup).toContain('Remove one copy from Trade binder')
    const prompt = locationRemovalPrompt(t, unplacedGroup)
    expect(prompt.title).toBe('Remove one copy from Trade binder?')
    expect(prompt.message).toBe('One copy leaves this binder. The rest stay in Not placed and in your collection.')
    expect(prompt.confirmLabel).toBe('Remove copy')
    expect(prompt.destructive).toBe(true)
  })

  it('frees the exact page and slot for a placed copy', () => {
    expect(locationRemovalPrompt(t, placed).message).toBe('Page 2, slot 7 becomes free in this binder. The copy stays in your collection.')
    expect(locationRemovalPrompt(t, { ...unplacedGroup, quantity: 1 }).message).toBe('This copy leaves this binder and stays in your collection.')
  })
})
