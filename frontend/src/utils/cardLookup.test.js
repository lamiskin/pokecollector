import { describe, expect, it } from 'vitest'
import { cardLookupLinks } from './cardLookup'

// A representative scan candidate: a Japanese trainer-kit printing, the sort
// of card TCGdex has no catalogue scan for and this helper exists to cover.
const match = {
  name: 'Bisharp',
  set: 'XY Trainer Kit (Bisharp)',
  set_abbreviation: 'TK7A',
  number: '25',
  lang: 'ja',
}

describe('cardLookupLinks', () => {
  it('offers the four outbound searches in a stable order', () => {
    const links = cardLookupLinks(match, 'Bisharp')
    expect(links.map(link => link.key)).toEqual(['images', 'ebay', 'cardmarket', 'pokellector'])
  })

  it('builds image and listing searches from the full descriptive query', () => {
    const [images, ebay] = cardLookupLinks(match, 'Bisharp')
    const expected = 'Bisharp%20XY%20Trainer%20Kit%20(Bisharp)%20TK7A%2025%20pokemon%20card'
    expect(images.url).toBe(`https://www.google.com/search?tbm=isch&q=${expected}`)
    expect(ebay.url).toBe(`https://www.ebay.com/sch/i.html?_nkw=${expected}`)
  })

  it('keeps the Cardmarket search narrow enough to disambiguate the set', () => {
    const [, , cardmarket] = cardLookupLinks(match, 'Bisharp')
    expect(cardmarket.url).toContain('https://www.cardmarket.com/en/Pokemon/Products/Singles?')
    expect(cardmarket.url).toContain('searchString=Bisharp+TK7A+25')
  })

  it('uses the English name and bare number for Pokellector', () => {
    const [, , , pokellector] = cardLookupLinks(match, 'Bisharp')
    expect(pokellector.url).toBe('https://jp.pokellector.com/search?criteria=Bisharp%2025')
  })

  it('prefers the model English reading over a localised name', () => {
    const japanese = { ...match, name: 'キリキザン', number: '035' }
    const [, , , pokellector] = cardLookupLinks(japanese, 'Bisharp')
    // "Jigglypuff 35", not "キリキザン 035": Pokellector indexes by English
    // name and bare number even on the Japanese subdomain.
    expect(pokellector.url).toBe('https://jp.pokellector.com/search?criteria=Bisharp%2035')
  })

  it('tolerates candidates with no number or set', () => {
    const minimal = { name: 'Energy' }
    const links = cardLookupLinks(minimal, undefined)
    expect(links).toHaveLength(4)
    const [, , , pokellector] = links
    // No number and no set: Pokellector falls back to the name alone.
    expect(pokellector.url).toBe('https://www.pokellector.com/search?criteria=Energy')
  })
})
