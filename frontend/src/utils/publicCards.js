import { normalizeSearchText } from './textSearch.js'

const value = input => Number.isFinite(Number(input)) ? Number(input) : 0
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const compare = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''))

export function filterPublicCards(cards = [], options = {}) {
  const { query = '', rarity = '', variant = '', language = '' } = options
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean)
  const filtered = (Array.isArray(cards) ? cards : []).filter(card => {
    if (!card || typeof card !== 'object') return false
    if (rarity && (card.rarity || 'Unknown') !== rarity) return false
    if (variant && (variant === '__none__' ? card.variant != null : card.variant !== variant)) return false
    if (language && (language === '__none__' ? card.lang != null : card.lang !== language)) return false
    const fields = [card.name, card.set_name, card.set_id, card.number, `${card.set_name ?? ''} ${card.number ?? ''}`, `${card.set_id ?? ''} ${card.number ?? ''}`]
    const searchable = normalizeSearchText(fields.filter(Boolean).join(' '))
    return terms.every(term => searchable.includes(term))
  })
  return filtered
}

function compareCollectorOrder(a, b) {
  return compare(a.set_id, b.set_id)
    || compare(a.number, b.number)
    || compare(a.prints?.[0]?.variant, b.prints?.[0]?.variant)
    || compare(a.name, b.name)
}

/** Sort grouped card tiles by the aggregate quantities/values actually shown. */
export function sortPublicCardTiles(tiles = [], { sort = 'collector', direction = 'asc', showValues = false } = {}) {
  const sign = direction === 'desc' ? -1 : 1
  return [...tiles].sort((a, b) => {
    let result = 0
    if (sort === 'name') result = compare(a.name, b.name)
    else if (sort === 'quantity') {
      const quantity = tile => (tile.prints || []).reduce((sum, print) => sum + value(print.quantity), 0)
      result = quantity(a) - quantity(b)
    } else if (sort === 'rarity') result = compare(a.rarity || 'Unknown', b.rarity || 'Unknown')
    else if (sort === 'value' && showValues) result = value(a.total_value) - value(b.total_value)
    else result = compareCollectorOrder(a, b)
    if (sort === 'collector') return (result * sign) || compareCollectorOrder(a, b)
    return (result * sign) || compareCollectorOrder(a, b)
  })
}

export function uniquePublicCardValues(cards = [], field) {
  return [...new Set((Array.isArray(cards) ? cards : []).map(card => card?.[field]).filter(value => value != null && value !== '').map(String))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

export function hasPublicValue(cards = [], field) {
  return (Array.isArray(cards) ? cards : []).some(card => card?.[field] == null)
}

export function isPublicProfilesFeatureEnabled(settings) {
  return settings?.public_profiles_enabled === 'true'
}
