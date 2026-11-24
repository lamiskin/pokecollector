import { describe, expect, it } from 'vitest'
import { formatJpy, getEffectiveCardPrice, getEffectiveCardPriceDetails, getCardFallbackQuote } from './prices'

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

describe('variant pricing', () => {
  it('preserves marketplace provenance on already-valued social and public cards', () => {
    expect(getEffectiveCardPriceDetails({ lang: 'de', price_market: 3.6, price_source: 'tcgplayer' }, 'Normal').source).toBe('tcgplayer')
    expect(getCardFallbackQuote({ lang: 'de', market_value: 3.6, price_source: 'tcgplayer' }).source).toBe('tcgplayer')
  })
  it('allows German TCGplayer estimates only with the existing fallback permission', () => {
    for (const lang of ['en', 'de', 'fr', 'ja', null, undefined]) {
      for (const allowed of [false, true]) {
        const card = { lang, tcgplayer_fallback_allowed: allowed, price_source_lang: 'en', price_tcg_normal_market: 4, price_tcg_usd_to_eur: 0.9 }
        expect(getEffectiveCardPrice(card, 'Normal')).toBe(lang === 'en' || (lang === 'de' && allowed) ? 3.6 : 0)
        expect(getEffectiveCardPrice({ ...card, price_market: 2 }, 'Normal')).toBe(2)
      }
    }
  })
  it('keeps Holo and Reverse Holo fallback prices separate and rejects invalid conversion', () => {
    const card = { lang: 'en', price_tcg_holo_market: 12, price_tcg_reverse_market: 16, price_tcg_usd_to_eur: 0.9 }
    expect(getEffectiveCardPrice(card, 'Holo')).toBeCloseTo(10.8)
    expect(getEffectiveCardPrice(card, 'Reverse Holo')).toBeCloseTo(14.4)
    expect(getEffectiveCardPrice(card, 'Normal')).toBe(0)
    for (const rate of [undefined, 0, -1, true, NaN, Infinity, 'invalid']) {
      expect(getEffectiveCardPrice({ ...card, price_tcg_usd_to_eur: rate }, 'Holo')).toBe(0)
    }
  })
  it('uses the matching TCGplayer edition in EUR only when Cardmarket is unavailable', () => {
    const card = { lang: 'en', price_tcg_normal_market: 4, price_tcg_first_edition_market: 8, price_tcg_usd_to_eur: 0.9 }
    expect(getEffectiveCardPrice(card, 'Normal')).toBeCloseTo(3.6)
    expect(getEffectiveCardPrice(card, 'First Edition')).toBeCloseTo(7.2)
    expect(getEffectiveCardPrice({ ...card, price_trend: 2 }, 'First Edition')).toBe(2)
    expect(getEffectiveCardPrice(card, 'Reverse Holo')).toBe(0)
    expect(getEffectiveCardPrice({ ...card, price_tcg_usd_to_eur: null }, 'Normal')).toBe(0)
  })
  it('uses the ordinary Cardmarket selected field instead of Holo or Reverse pricing', () => {
    const card = {
      price_trend: 12.5,
      price_trend_holo: 25,
      price_market: 13,
      price_market_holo: 26,
    }

    expect(getEffectiveCardPrice(card, 'Special', 'price_trend')).toBe(12.5)
    expect(getEffectiveCardPrice(card, 'Reverse Holo', 'price_trend')).toBe(25)
  })
})
