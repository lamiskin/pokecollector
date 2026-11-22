import { describe, expect, it } from 'vitest'
import { getScanCatalogueEvidence, getScanCatalogueId } from '../hooks/useScanCatalogue'
import { CARD_VARIANTS, getAvailableVariants, getSelectableVariants } from '../utils/cardVariants'

describe('scanner catalogue identity', () => {
  it.each([
    ['synthetic-001', 'de', 'synthetic-001_de'],
    ['synthetic-001_en', 'de', 'synthetic-001_de'],
    ['synthetic-001_de', 'de', 'synthetic-001_de'],
    ['synthetic-001_zh-tw', 'pt-br', 'synthetic-001_pt-br'],
    ['synthetic_unknown', 'en', 'synthetic_unknown_en'],
    ['en', 'de', 'en_de'],
    ['synthetic_jp', 'en', 'synthetic_jp_en'],
  ])('resolves %s in %s as %s', (id, lang, expected) => {
    expect(getScanCatalogueId(id, lang)).toBe(expected)
  })
})

describe('add form finish eligibility', () => {
  const known = {
    variants_normal: false, variants_holo: true,
    variants_reverse: false, variants_first_edition: false,
  }
  it('disables explicitly excluded finishes when there is positive catalogue evidence', () => {
    expect(getSelectableVariants(known)).toEqual(['Holo'])
  })
  it('allows positive finish pricing to override a false flag', () => {
    expect(getSelectableVariants({ ...known, price_tcg_normal_market: 1, price_tcg_reverse_market: '0.5' }))
      .toEqual(['Normal', 'Holo', 'Reverse Holo'])
  })
  it.each([null, {}, { variants_holo: null }, { ...known, variants_holo: false }, {
    variants_normal: false, variants_holo: false, variants_reverse: false,
    price_tcg_normal_market: 0, price_tcg_holo_market: -1, price_tcg_reverse_market: 'invalid',
  }])('leaves every finish editable without positive evidence: %j', card => {
    expect(getSelectableVariants(card)).toEqual(CARD_VARIANTS)
  })
  it('does not treat missing or null flags as exclusion in partial metadata', () => {
    expect(getSelectableVariants({ variants_holo: true, variants_normal: false, variants_reverse: null }))
      .toEqual(['Holo', 'Reverse Holo', 'First Edition'])
  })
  it('supports First Edition separately without inferring it from foil prices', () => {
    expect(getSelectableVariants({ ...known, variants_first_edition: true })).toEqual(['Holo', 'First Edition'])
    expect(getSelectableVariants({ ...known, price_tcg_holo_market: 1 })).toEqual(['Holo'])
  })
  it('filters foreign flags and prices independently before exclusions', () => {
    const foreignFlags = { ...known, data_source_lang: 'en', price_source_lang: 'de', price_tcg_reverse_market: 1 }
    expect(getSelectableVariants(getScanCatalogueEvidence(foreignFlags, 'de'))).toEqual(CARD_VARIANTS)
    const foreignPrices = { ...known, data_source_lang: 'de', price_source_lang: 'en', price_tcg_reverse_market: 1 }
    expect(getSelectableVariants(getScanCatalogueEvidence(foreignPrices, 'de'))).toEqual(['Holo'])
    expect(getSelectableVariants(getScanCatalogueEvidence({ ...foreignPrices, data_source_lang: 'en' }, 'de'))).toEqual(CARD_VARIANTS)
  })
})

describe('scanner catalogue language evidence', () => {
  const card = { variants_holo: true, price_tcg_reverse_market: 2 }
  it('preserves legacy rows without explicit source languages', () => {
    expect(getAvailableVariants(getScanCatalogueEvidence(card, 'de'))).toEqual(['Reverse Holo', 'Holo'])
  })
  it('ignores foreign flags but retains local pricing evidence', () => {
    expect(getAvailableVariants(getScanCatalogueEvidence({ ...card, data_source_lang: 'en', price_source_lang: 'de' }, 'de')))
      .toEqual(['Reverse Holo'])
  })
  it('ignores foreign prices but retains local flags', () => {
    expect(getAvailableVariants(getScanCatalogueEvidence({ ...card, data_source_lang: 'de', price_source_lang: 'en' }, 'de')))
      .toEqual(['Holo'])
  })
  it('treats fully foreign evidence as unknown without mutating the catalogue', () => {
    const foreign = { ...card, data_source_lang: 'en', price_source_lang: 'en' }
    expect(getAvailableVariants(getScanCatalogueEvidence(foreign, 'de'))).toEqual([])
    expect(foreign).toEqual({ ...card, data_source_lang: 'en', price_source_lang: 'en' })
  })
})
