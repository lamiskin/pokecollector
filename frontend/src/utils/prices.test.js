import { describe, expect, it } from 'vitest'
import { formatJpy, getEffectiveCardPrice } from './prices'

describe('formatJpy', () => {
  it('formats a JPY amount with the yen symbol', () => {
    expect(formatJpy(580)).toBe('￥580')
  })

  it('returns null for missing values', () => {
    expect(formatJpy(null)).toBeNull()
    expect(formatJpy(undefined)).toBeNull()
  })

  it('returns null for non-numeric values', () => {
    expect(formatJpy('not a number')).toBeNull()
  })
})

describe('getEffectiveCardPrice', () => {
  it('returns 0 for a missing card', () => {
    expect(getEffectiveCardPrice(null, 'Normal', 'price_trend')).toBe(0)
  })

  it('uses the base Cardmarket price when present', () => {
    const card = { price_trend: 32.22, price_market: 26.81 }
    expect(getEffectiveCardPrice(card, 'Normal', 'price_trend')).toBe(32.22)
  })

  it('falls back to price_jpy_eur_equivalent when no Cardmarket price exists', () => {
    const card = { price_trend: null, price_market: null, price_jpy_eur_equivalent: 5.02 }
    expect(getEffectiveCardPrice(card, 'Normal', 'price_trend')).toBe(5.02)
  })

  it('real Cardmarket price still wins over the JPY fallback', () => {
    const card = { price_trend: 32.22, price_jpy_eur_equivalent: 5.02 }
    expect(getEffectiveCardPrice(card, 'Normal', 'price_trend')).toBe(32.22)
  })

  it('reverse holo also falls back to the JPY equivalent', () => {
    const card = {
      price_trend: null,
      price_trend_holo: null,
      price_market: null,
      price_market_holo: null,
      price_jpy_eur_equivalent: 5.02,
    }
    expect(getEffectiveCardPrice(card, 'Reverse Holo', 'price_trend')).toBe(5.02)
  })

  it('returns 0 when neither Cardmarket nor JPY price is available', () => {
    const card = { price_trend: null, price_market: null, price_jpy_eur_equivalent: null }
    expect(getEffectiveCardPrice(card, 'Normal', 'price_trend')).toBe(0)
  })

  it('does not error when price_jpy_eur_equivalent is entirely absent', () => {
    const card = { price_trend: null, price_market: null }
    expect(getEffectiveCardPrice(card, 'Normal', 'price_trend')).toBe(0)
  })

  it('falls back to manual_value_override when neither Cardmarket nor JPY price exists', () => {
    const card = { price_trend: null, price_market: null, price_jpy_eur_equivalent: null, manual_value_override: 12.5 }
    expect(getEffectiveCardPrice(card, 'Normal', 'price_trend')).toBe(12.5)
  })

  it('reverse holo also falls back to manual_value_override', () => {
    const card = {
      price_trend: null,
      price_trend_holo: null,
      price_market: null,
      price_market_holo: null,
      price_jpy_eur_equivalent: null,
      manual_value_override: 12.5,
    }
    expect(getEffectiveCardPrice(card, 'Reverse Holo', 'price_trend')).toBe(12.5)
  })

  it('the JPY price still wins over manual_value_override', () => {
    const card = { price_trend: null, price_market: null, price_jpy_eur_equivalent: 5.02, manual_value_override: 12.5 }
    expect(getEffectiveCardPrice(card, 'Normal', 'price_trend')).toBe(5.02)
  })
})
