// Raw JPY display for Suruga-ya prices — never run through formatSelectedCurrency(),
// which assumes a EUR/USD input and applies the user's currency conversion; these
// are shown as the actual yen figure alongside the converted price, not instead of it.
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

export function getCardPriceValue(card, priceKey) {
  const field = PRICE_PRIMARY_TO_FIELD[priceKey] || priceKey
  return card?.[field]
    ?? card?.cardmarket?.prices?.[priceKey]
    ?? card?.pricing?.cardmarket?.[priceKey]
    ?? null
}

function positivePrice(value) {
  if (value == null || typeof value === 'boolean') return null
  const price = Number(value)
  return Number.isFinite(price) && price > 0 ? price : null
}

// Only entry point for price_jpy_eur_equivalent (a personal, local-only Suruga-ya
// price pre-converted to EUR at sync time) and manual_value_override (a hand-entered
// EUR fallback, personal/local-only, absolute last resort) into "the" price —
// mirrors effective_price_quote()/effective_market_price() in
// backend/services/card_values.py exactly.
function lastResortPrice(card) {
  if (!card) return 0
  const jpy = positivePrice(card.price_jpy_eur_equivalent)
  if (jpy != null) return jpy
  return positivePrice(card.manual_value_override) || 0
}

function lastResortQuote(card) {
  const amount = lastResortPrice(card)
  return amount > 0
    ? { amount, currency: 'EUR', source: 'manual', sourceAmount: amount, sourceCurrency: 'EUR' }
    : { amount: 0, currency: 'EUR', source: null }
}

function cardmarketPrice(card, variant, priceField = 'price_trend') {  if (!card) return 0
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
    return 0
  }

  for (const candidate of [card[priceField], card.price_market]) {
    const price = positivePrice(candidate)
    if (price != null) return price
  }
  return 0
}

export function getEffectiveCardPriceDetails(card, variant, priceField = 'price_trend') {
  const value = cardmarketPrice(card, variant, priceField)
  if (value > 0) return { amount: value, currency: 'EUR', source: card?.price_source === 'tcgplayer' ? 'tcgplayer' : 'cardmarket' }
  if (card?.lang !== 'en' && !(card?.lang === 'de' && card?.tcgplayer_fallback_allowed === true)) {
    return lastResortQuote(card)
  }
  const selectedVariant = variant ?? (card?.variants_holo && card?.variants_normal === false ? 'Holo' : 'Normal')
  const field = {
    Normal: 'price_tcg_normal_market',
    Holo: 'price_tcg_holo_market',
    'Reverse Holo': 'price_tcg_reverse_market',
    'First Edition': 'price_tcg_first_edition_market',
  }[selectedVariant]
  const usd = positivePrice(field ? card?.[field] : null)
  const rate = positivePrice(card?.price_tcg_usd_to_eur)
  if (usd != null && rate != null && Number.isFinite(usd * rate)) {
    return { amount: usd * rate, currency: 'EUR', source: 'tcgplayer', sourceAmount: usd, sourceCurrency: 'USD' }
  }
  return lastResortQuote(card)
}

export function getEffectiveCardPrice(card, variant, priceField = 'price_trend') {
  return getEffectiveCardPriceDetails(card, variant, priceField).amount
}

export function getCardFallbackQuote(card, priceField = 'price_trend') {
  // Public tiles carry a resolved value instead of the private catalogue fields.
  const publicValue = positivePrice(card?.market_value ?? card?.total_value)
  if (card?.price_source === 'tcgplayer' && publicValue != null) {
    return { amount: publicValue, currency: 'EUR', source: 'tcgplayer' }
  }
  const variant = card?.variant ?? (card?.owned_variants?.length === 1 ? card.owned_variants[0].variant : undefined)
  return getEffectiveCardPriceDetails(card, variant, priceField)
}

export function getPrimaryCardPrice(card, variant, pricePrimary = 'trend', priceField = priceFieldFromPrimary(pricePrimary)) {
  const effectivePrice = getEffectiveCardPrice(card, variant, priceField)
  if (effectivePrice > 0) return effectivePrice
  return getCardPriceValue(card, pricePrimary)
}
