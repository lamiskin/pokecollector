import { describe, expect, it } from 'vitest'
import { filterPublicCards, hasPublicValue, isPublicProfilesFeatureEnabled, sortPublicCardTiles, uniquePublicCardValues } from './publicCards'
import { groupCardsByPrint } from './groupCardsByPrint'

const cards = [
  { id: '1', name: 'Pikachu', set_name: 'Écarlate & Violet', set_id: 'sv01', number: '025/198', rarity: 'Rare', variant: 'Normal', lang: 'en', quantity: 2, market_value: 4 },
  { id: '1', name: 'Pikachu', set_name: 'Écarlate & Violet', set_id: 'sv01', number: '025/198', rarity: 'Rare', variant: 'Holo', lang: 'fr', quantity: 1, market_value: 9 },
  { id: '2', name: 'Évoli', set_name: 'Paldea Evolved', set_id: 'sv02', number: '100/193', rarity: 'Common', variant: null, lang: null, quantity: 5, market_value: 1000 },
  { id: '3', name: 'Custom', set_name: null, number: null, rarity: null, lang: 'en', quantity: 1, market_value: 0 },
]

describe('public card search and filters', () => {
  it('normalizes accents and matches multi-field set plus number combinations', () => {
    expect(filterPublicCards(cards, { query: 'ecarlate 025/198' })).toHaveLength(2)
    expect(filterPublicCards(cards, { query: 'ÉVOLI' })).toHaveLength(1)
  })
  it('applies rarity, language and variant together; null is distinct from Normal', () => {
    expect(filterPublicCards(cards, { rarity: 'Rare', language: 'fr', variant: 'Holo' })).toHaveLength(1)
    expect(filterPublicCards(cards, { variant: 'Normal' })).toHaveLength(1)
    expect(filterPublicCards(cards, { variant: '__none__' })).toHaveLength(2)
    expect(filterPublicCards(cards, { language: '__none__' })).toHaveLength(1)
  })
  it('sorts grouped tiles by aggregate displayed quantities and values in both directions', () => {
    const examples = [
      { id: 'pair', set_id: 'sv01', number: '02', name: 'Pair', set_name: 'Set', variant: 'Normal', quantity: 2, market_value: 6 },
      { id: 'pair', set_id: 'sv01', number: '02', name: 'Pair', set_name: 'Set', variant: 'Holo', quantity: 2, market_value: 3 },
      { id: 'single', set_id: 'sv01', number: '03', name: 'Single', set_name: 'Set', variant: 'Normal', quantity: 1, market_value: 10 },
    ]
    const tiles = groupCardsByPrint(examples)
    expect(sortPublicCardTiles(tiles, { sort: 'quantity' }).map(tile => tile.id)).toEqual(['single', 'pair'])
    expect(sortPublicCardTiles(tiles, { sort: 'quantity', direction: 'desc' }).map(tile => tile.id)).toEqual(['pair', 'single'])
    expect(sortPublicCardTiles(tiles, { sort: 'value', showValues: true }).map(tile => tile.id)).toEqual(['single', 'pair'])
    expect(sortPublicCardTiles(tiles, { sort: 'value', direction: 'desc', showValues: true }).map(tile => tile.id)).toEqual(['pair', 'single'])
  })
  it('uses backend collector identity order: set ID, natural number, then variant', () => {
    const rows = [
      { id: 'late', set_id: 'sv10', set_name: 'A Set', number: '1', name: 'A', variant: 'Normal' },
      { id: 'num10', set_id: 'sv1', set_name: 'Z Set', number: '10', name: 'B', variant: 'Normal' },
      { id: 'num2', set_id: 'sv1', set_name: 'Z Set', number: '2', name: 'C', variant: 'Holo' },
    ]
    expect(sortPublicCardTiles(groupCardsByPrint(rows)).map(tile => tile.id)).toEqual(['num2', 'num10', 'late'])
    expect(sortPublicCardTiles(groupCardsByPrint(rows), { sort: 'name' })[0].name).toBe('A')
  })
  it('sorts tile rarity in either direction with unknown metadata kept stable', () => {
    const tiles = groupCardsByPrint([
      { id: 'rare', set_id: 's01', number: '1', name: 'Rare', rarity: 'Rare' },
      { id: 'common', set_id: 's01', number: '2', name: 'Common', rarity: 'Common' },
      { id: 'unknown', set_id: 's01', number: '3', name: 'Unknown', rarity: null },
    ])
    expect(sortPublicCardTiles(tiles, { sort: 'rarity' }).map(tile => tile.id)).toEqual(['common', 'rare', 'unknown'])
    expect(sortPublicCardTiles(tiles, { sort: 'rarity', direction: 'desc' }).map(tile => tile.id)).toEqual(['unknown', 'rare', 'common'])
  })
  it('ignores values completely when value sorting is unavailable', () => {
    const rows = [
      { id: 'b', set_id: 'sv02', number: '1', market_value: 100000 },
      { id: 'a', set_id: 'sv01', number: '1', market_value: 0 },
    ]
    expect(sortPublicCardTiles(groupCardsByPrint(rows), { sort: 'value', showValues: false }).map(tile => tile.id)).toEqual(['a', 'b'])
  })
  it('handles missing metadata and exposes null categories without merging them', () => {
    expect(uniquePublicCardValues(cards, 'rarity')).toEqual(['Common', 'Rare'])
    expect(hasPublicValue(cards, 'variant')).toBe(true)
    expect(filterPublicCards([null, undefined, {}, { name: 'Safe' }])).toHaveLength(2)
  })
  it('gates the signed-in directory entry strictly on global feature availability', () => {
    expect(isPublicProfilesFeatureEnabled({ public_profiles_enabled: 'true' })).toBe(true)
    for (const setting of ['false', undefined, true, 'TRUE']) {
      expect(isPublicProfilesFeatureEnabled({ public_profiles_enabled: setting })).toBe(false)
    }
  })
})
