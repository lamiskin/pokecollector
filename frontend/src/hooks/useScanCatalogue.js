import { useEffect, useState } from 'react'
import { getCard } from '../api/client'
import { normalizeTcgdexLanguage, TCGDEX_LANGUAGES } from '../utils/tcgdexLanguages'

// Match the collection endpoint's language-specific identity, including older
// queued matches that only carry a bare TCGdex ID.
export function getScanCatalogueId(id, lang) {
  const suffix = String(id).split('_').at(-1)
  const hasSuffix = id.includes('_') && TCGDEX_LANGUAGES.some(language => language.code === suffix)
  const baseId = hasSuffix ? id.slice(0, -(suffix.length + 1)) : id
  return `${baseId}_${lang}`
}

export function getScanCatalogueEvidence(card, lang) {
  if (!card) return null
  const evidence = { ...card }
  // Flags and prices can independently come from another language. Neither
  // proves a finish exists in the selected language when its source differs.
  if (card.data_source_lang && normalizeTcgdexLanguage(card.data_source_lang, '') !== lang) {
    for (const field of ['variants_normal', 'variants_reverse', 'variants_holo', 'variants_first_edition']) delete evidence[field]
  }
  if (card.price_source_lang && normalizeTcgdexLanguage(card.price_source_lang, '') !== lang) {
    for (const field of Object.keys(evidence)) {
      if (/^price_tcg_(normal|reverse|holo)_/.test(field)) delete evidence[field]
    }
  }
  return evidence
}

// Never infer a finish from a scanner match. Both the add form and express
// acceptance use this lookup, with stale results isolated by card/language ID.
export function useScanCatalogue(cardId, lang) {
  const id = cardId ? getScanCatalogueId(cardId, lang) : null
  const [catalogue, setCatalogue] = useState(null)
  const loading = Boolean(id) && catalogue?.id !== id

  useEffect(() => {
    if (!id) return
    let active = true
    getCard(id).then(({ data }) => {
      if (!active) return
      const card = data?.id === id && normalizeTcgdexLanguage(data.lang, '') === lang ? data : null
      setCatalogue({ id, card })
    }).catch(() => {
      if (active) setCatalogue({ id, card: null })
    })
    return () => { active = false }
  }, [id, lang])

  return { id, loading, card: id && !loading ? getScanCatalogueEvidence(catalogue?.card, lang) : null }
}
