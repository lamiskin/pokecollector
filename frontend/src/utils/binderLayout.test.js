import { describe, expect, it } from 'vitest'
import { binderLocationHref, binderMessage, resolveBinderTarget, visibleBinderPages } from './binderLayout'

const snapshot = {
  entries: [{ binder_card_id: 7, card_id: 'sample-1_en', unplaced_quantity: 1 }],
  placements: [
    { id: 'copy-a', binder_card_id: 7, card_id: 'sample-1_en', page: 1, slot: 2 },
    { id: 'copy-b', binder_card_id: 7, card_id: 'sample-1_en', page: 2, slot: 7 },
  ],
}

describe('physical binder navigation', () => {
  it('pairs numbered sides without manufacturing a final page', () => {
    expect(visibleBinderPages(2, 5, true)).toEqual([1, 2])
    expect(visibleBinderPages(4, 5, true)).toEqual([3, 4])
    expect(visibleBinderPages(5, 5, true)).toEqual([5])
    expect(visibleBinderPages(20, 5, false)).toEqual([5])
    expect(visibleBinderPages(0, 5, false)).toEqual([1])
    expect(visibleBinderPages('2.9', 5, false)).toEqual([2])
    expect(visibleBinderPages('not-a-page', 5, false)).toEqual([1])
  })
  it('builds private/public identity-aware links including unplaced quantities', () => {
    const location = { binder_id: 9, binder_card_id: 7, card_id: 'sample-1_en', placement_id: 'copy-b', page: 2, slot: 7 }
    expect(binderLocationHref(location)).toContain('/binders/9?view=pages&card=sample-1_en&member=7&placement=copy-b&page=2&slot=7')
    expect(binderLocationHref({ ...location, placement_id: null, page: null, slot: null }, 'example')).toContain('/u/example/binder/9?view=pages&card=sample-1_en&member=7&tray=1')
  })
  it('resolves both placed copies and the reserved tray group', () => {
    for (const p of snapshot.placements) expect(resolveBinderTarget(snapshot, new URLSearchParams({ card: p.card_id, member: '7', placement: p.id })).placement).toBe(p)
    expect(resolveBinderTarget(snapshot, new URLSearchParams({ card: 'sample-1_en', member: '7', tray: '1' })).kind).toBe('tray')
  })
  it('finds a moved placement by identity, not the old coordinates', () => {
    const target = resolveBinderTarget(snapshot, new URLSearchParams({ card: 'sample-1_en', member: '7', placement: 'copy-b', page: '1', slot: '2' }))
    expect(target.placement.id).toBe('copy-b')
    expect(target.moved).toBe(true)
  })
  it('never highlights a different occupant when the linked card is gone', () => {
    expect(resolveBinderTarget(snapshot, new URLSearchParams({ card: 'different', member: '8', placement: 'copy-b', page: '2', slot: '7' }))).toEqual({ kind: 'missing' })
  })
  it('offers remaining duplicates rather than inventing copy identity', () => {
    const noTray = { ...snapshot, entries: [{ ...snapshot.entries[0], unplaced_quantity: 0 }] }
    expect(resolveBinderTarget(noTray, new URLSearchParams({ card: 'sample-1_en', member: '7', placement: 'removed' })).kind).toBe('choices')
  })
  it('explains a placement returned to the tray', () => {
    expect(resolveBinderTarget(snapshot, new URLSearchParams({ card: 'sample-1_en', member: '7', placement: 'removed' }))).toMatchObject({ kind: 'tray', moved: true })
  })
  it('prefers the tray over claiming a different remaining copy is the deleted placement', () => {
    const oneRemaining = { ...snapshot, placements: [snapshot.placements[0]] }
    expect(resolveBinderTarget(oneRemaining, new URLSearchParams({ card: 'sample-1_en', member: '7', placement: 'removed' }))).toMatchObject({ kind: 'tray', moved: true })
  })
  it('can recover by card identity when an old membership has been merged', () => {
    expect(resolveBinderTarget(snapshot, new URLSearchParams({ card: 'sample-1_en', member: 'old-member', placement: 'removed' }))).toMatchObject({ kind: 'tray', moved: true })
  })
  it('interpolates repeated placeholders without altering translated text', () => {
    expect(binderMessage(() => '{count} / {count}', 'test', { count: 3 })).toBe('3 / 3')
  })
})
