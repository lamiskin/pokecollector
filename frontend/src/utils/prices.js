// Raw JPY display for Suruga-ya prices — never run through formatPrice(), which
// assumes a EUR input and applies the user's currency conversion; these are shown
// as the actual yen figure alongside the converted price, not instead of it.
export function formatJpy(value) {
  if (value == null || Number.isNaN(Number(value))) return null
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(Number(value))
}

export const PRICE_PRIMARY_TO_FIELD = {
  market: 'price_market',
  avg: 'price_market',
  trend: 'price_trend',
  avg1: 'price_avg1',
  avg7: 'price_avg7',
  avg30: 'price_avg30',
  low: 'price_low',
}

export const REVERSE_HOLO_VARIANTS = new Set(['Reverse Holo'])

export const HOLO_FIELD_MAP = {
  price_market: 'price_market_holo',
  price_trend: 'price_trend_holo',
  price_avg1: 'price_avg1_holo',
  price_avg7: 'price_avg7_holo',
  price_avg30: 'price_avg30_holo',
  price_low: 'price_low_holo',
}

export function priceFieldFromPrimary(pricePrimary) {
  return PRICE_PRIMARY_TO_FIELD[pricePrimary] || 'price_trend'
}

function positivePrice(value) {
  if (value == null) return null
  const price = Number(value)
  return Number.isFinite(price) && price > 0 ? price : null
}

// Only entry point for price_jpy_eur_equivalent (a personal, local-only Suruga-ya
// price pre-converted to EUR at sync time) and manual_value_override (a hand-entered
// EUR fallback, personal/local-only, absolute last resort) into "the" price —
// mirrors effective_market_price() in backend/services/card_values.py exactly.
function lastResortPrice(card) {
  const jpy = positivePrice(card.price_jpy_eur_equivalent)
  if (jpy != null) return jpy
  return positivePrice(card.manual_value_override) || 0
}

export function getEffectiveCardPrice(card, variant, priceField = 'price_trend') {
  if (!card) return 0
  if (REVERSE_HOLO_VARIANTS.has(variant)) {
    const holoField = HOLO_FIELD_MAP[priceField]
    const candidates = [
      holoField ? card[holoField] : null,
      card[priceField],
      card.price_market_holo,
      card.price_market,
    ]
    for (const candidate of candidates) {
      const price = positivePrice(candidate)
      if (price != null) return price
    }
    return lastResortPrice(card)
  }

  for (const candidate of [card[priceField], card.price_market]) {
    const price = positivePrice(candidate)
    if (price != null) return price
  }
  return lastResortPrice(card)
}
