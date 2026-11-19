import { describe, expect, it } from 'vitest'

import { allocationNotice } from './scanAllocationNotice'

const strings = {
  'scanner.allocationPartial': 'Card added — {allocated} of {requested} copies filed into {name}.',
  'scanner.allocationNone': 'Card added, but no copies were filed into {name}.',
  'scanner.allocationNoCopies': 'Card added, but no free copies were available for {name}.',
  'scanner.allocationListUnavailable': 'Card added, but {name} is no longer available — no copies were filed.',
  'scanner.allocationFallbackName': 'the chosen card list',
}
const t = key => strings[key]

describe('scan allocation notice', () => {
  it('stays silent when every requested copy was filed', () => {
    expect(allocationNotice(
      { binder_name: 'Binders', requested: 3, allocated: 3, reason: null },
      t,
      'Binders',
    )).toBeNull()
  })

  it('stays silent when the job had no destination and nothing was allocated', () => {
    expect(allocationNotice(null, t, null)).toBeNull()
  })

  it('explains a partial filing', () => {
    expect(allocationNotice(
      { binder_name: 'Binders', requested: 3, allocated: 1, reason: 'partial' },
      t,
    )).toBe('Card added — 1 of 3 copies filed into Binders.')
  })

  it('explains a filing that allocated nothing', () => {
    expect(allocationNotice(
      { binder_name: 'Binders', requested: 2, allocated: 0, reason: 'partial' },
      t,
    )).toBe('Card added, but no copies were filed into Binders.')
  })

  it('explains a list whose copies are all taken', () => {
    expect(allocationNotice(
      { binder_name: 'Binders', requested: 2, allocated: 0, reason: 'no_unallocated_copies' },
      t,
    )).toBe('Card added, but no free copies were available for Binders.')
  })

  it('falls back to the job destination when the response has no binder name', () => {
    expect(allocationNotice(
      { binder_name: null, requested: 1, allocated: 0, reason: 'list_unavailable' },
      t,
      'Old Binder',
    )).toBe('Card added, but Old Binder is no longer available — no copies were filed.')
  })

  it('uses a generic phrase when no binder name exists anywhere', () => {
    expect(allocationNotice(
      { binder_name: null, requested: 1, allocated: 0, reason: 'no_unallocated_copies' },
      t,
    )).toBe('Card added, but no free copies were available for the chosen card list.')
  })

  it('reports a deleted destination when the response allocation is null', () => {
    expect(allocationNotice(null, t, 'Old Binder'))
      .toBe('Card added, but Old Binder is no longer available — no copies were filed.')
  })

  it('ignores a zero request instead of inventing a shortfall', () => {
    expect(allocationNotice(
      { binder_name: 'Binders', requested: 0, allocated: 0, reason: null },
      t,
    )).toBeNull()
  })
})
