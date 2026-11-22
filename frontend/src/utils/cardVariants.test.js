import { describe, expect, it } from 'vitest'
import { CARD_VARIANTS, getAvailableVariants, getDefaultVariant, getOwnedVariants } from './cardVariants'

const row = (over = {}) => ({
  id: 1, card_id: 'sv01-003_en', card: { id: 'sv01-003_en', name: 'Card' },
  quantity: 1, condition: 'NM', variant: 'Normal', lang: 'en', purchase_price: null,
  ...over,
})

describe('getOwnedVariants', () => {
  it('returns one entry per distinct owned variant', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal' }),
      row({ id: 2, variant: 'Reverse Holo' }),
    ])
    expect(result).toEqual([
      { variant: 'Normal', quantity: 1 },
      { variant: 'Reverse Holo', quantity: 1 },
    ])
  })

  it('sums quantity across rows of the same variant with different conditions', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', condition: 'NM', quantity: 1 }),
      row({ id: 2, variant: 'Normal', condition: 'LP', quantity: 2 }),
    ])
    expect(result).toEqual([{ variant: 'Normal', quantity: 3 }])
  })

  it('orders variants canonically regardless of row order', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'First Edition' }),
      row({ id: 2, variant: 'Holo' }),
      row({ id: 3, variant: 'Normal' }),
    ])
    expect(result.map(entry => entry.variant)).toEqual(['Normal', 'Holo', 'First Edition'])
  })

  it('treats a missing variant as Normal', () => {
    expect(getOwnedVariants([row({ variant: null })])).toEqual([{ variant: 'Normal', quantity: 1 }])
  })

  it('ignores non-canonical variants defensively', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Full Art' }),
      row({ id: 2, variant: 'Normal' }),
    ])
    expect(result.map(entry => entry.variant)).toEqual(['Normal'])
  })

  it('omits a variant whose total quantity is zero', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', quantity: 0 }),
      row({ id: 2, variant: 'Reverse Holo', quantity: 1 }),
    ])
    expect(result).toEqual([{ variant: 'Reverse Holo', quantity: 1 }])
  })

  it('omits a variant whose quantity is null', () => {
    expect(getOwnedVariants([row({ variant: 'Normal', quantity: null })])).toEqual([])
  })

  it('keeps a variant whose rows sum above zero even if one row is zero', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', condition: 'NM', quantity: 0 }),
      row({ id: 2, variant: 'Normal', condition: 'LP', quantity: 2 }),
    ])
    expect(result).toEqual([{ variant: 'Normal', quantity: 2 }])
  })

  it('accepts numeric API strings without concatenating quantities', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', quantity: '2' }),
      row({ id: 2, variant: 'Normal', quantity: 1 }),
    ])
    expect(result).toEqual([{ variant: 'Normal', quantity: 3 }])
  })

  it('ignores negative and non-numeric quantities defensively', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', quantity: -2 }),
      row({ id: 2, variant: 'Holo', quantity: 'not-a-number' }),
    ])
    expect(result).toEqual([])
  })

  it('returns an empty array for no rows', () => {
    expect(getOwnedVariants([])).toEqual([])
  })
})

describe('getDefaultVariant (manual and scan catalogue defaults)', () => {
  it.each([
    ['holo only', { variants_holo: true }, 'Holo'],
    ['reverse only', { variants_reverse: true }, 'Reverse Holo'],
    ['Normal and reverse', { variants_normal: true, variants_reverse: true }, 'Normal'],
    ['holo and reverse', { variants_holo: true, variants_reverse: true }, 'Reverse Holo'],
    ['missing metadata', undefined, 'Normal'],
    ['null metadata', null, 'Normal'],
    ['empty metadata', {}, 'Normal'],
    ['all false', { variants_normal: false, variants_reverse: false, variants_holo: false, variants_first_edition: false }, 'Normal'],
    ['Normal pricing contradicts holo-only flags', { variants_holo: true, variants_normal: false, price_tcg_normal_market: 0.5 }, 'Normal'],
    ['positive reverse pricing only', { variants_reverse: false, price_tcg_reverse_market: 0.5 }, 'Reverse Holo'],
    ['positive holo pricing only', { variants_holo: false, price_tcg_holo_market: '0.5' }, 'Holo'],
  ])('defaults %s to %s', (_description, card, expected) => {
    expect(getDefaultVariant(card)).toBe(expected)
  })
})

describe('getAvailableVariants', () => {
  it('uses TCGplayer pricing as evidence when TCGdex flags contradict it', () => {
    expect(getAvailableVariants({
      variants_normal: true,
      variants_reverse: false,
      variants_holo: false,
      price_tcg_reverse_market: 0.22,
      price_tcg_holo_market: 0.41,
    })).toEqual(['Normal', 'Reverse Holo', 'Holo'])
  })

  it('does not infer a variant from missing or zero prices', () => {
    expect(getAvailableVariants({
      variants_normal: false,
      variants_reverse: false,
      variants_holo: false,
      price_tcg_reverse_market: 0,
    })).toEqual([])
  })
})

import { getCardOwnedVariants, getEditableVariants } from './cardVariants'

describe('card tile ownership normalization', () => {
  it('prefers owned_variants over owned_items', () => {
    expect(getCardOwnedVariants({ owned_variants: [{ variant: 'Holo', quantity: 2 }], owned_items: [row({ variant: 'Normal' })] }))
      .toEqual([{ variant: 'Holo', quantity: 2 }])
  })

  it('uses owned_items when detailed summary variants are absent', () => {
    expect(getCardOwnedVariants({ owned_items: [row({ variant: 'Reverse Holo' })] }))
      .toEqual([{ variant: 'Reverse Holo', quantity: 1 }])
  })

  it('does not invent a variant from generic ownership totals', () => {
    expect(getCardOwnedVariants({ owned: true })).toEqual([])
    expect(getCardOwnedVariants({ owned_quantity: 3 })).toEqual([])
  })
})


describe('getEditableVariants', () => {
  it('keeps the stored finish selectable when the catalogue contradicts it', () => {
    const card = { variants_normal: false, variants_reverse: false, variants_holo: true, variants_first_edition: false }
    expect(getEditableVariants(card, 'Normal')).toEqual(['Holo', 'Normal'])
    expect(getEditableVariants(card, 'Holo')).toEqual(['Holo'])
  })

  it('leaves every finish editable without positive evidence', () => {
    expect(getEditableVariants(null, 'Reverse Holo')).toEqual(CARD_VARIANTS)
    expect(getEditableVariants({}, 'Normal')).toEqual(CARD_VARIANTS)
  })
})

describe('advanced effect independence', () => {
  it('does not introduce a synthetic physical finish', () => {
    expect(getOwnedVariants([row({ variant: 'Special' })])).toEqual([])
    expect(getAvailableVariants({ variants_holo: true, variants_reverse: true })).toEqual(['Reverse Holo', 'Holo'])
  })
})
