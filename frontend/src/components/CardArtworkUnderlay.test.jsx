/**
 * The large catalogue scan is slow on a cold cache while the small scan is
 * already painted in the grid behind the dialog. CardArtworkFrame derives a
 * small-scan underlay from the card itself, so every large-proxy surface gets
 * it — and nothing else does.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CardArtworkFrame } from './UnifiedCard'
import { resolveCardArtworkUnderlay } from '../utils/imageUrl'

const queryState = vi.hoisted(() => ({ useQuery: vi.fn() }))

vi.mock('@tanstack/react-query', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, useQuery: queryState.useQuery }
})

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    settings: { holo_effects_enabled: 'false' },
    t: key => key,
  }),
}))

const card = {
  id: 'sv1-1_en',
  card_id: 'sv1-1_en',
  tcg_card_id: 'sv1-1',
  lang: 'en',
  name: 'Pikachu',
  images_small: 'https://assets.tcgdex.net/en/sv/sv1/1/low.webp',
  images_large: 'https://assets.tcgdex.net/en/sv/sv1/1/high.webp',
}
const largeProxy = '/api/images/card/sv1-1_en/large'
const smallProxy = '/api/images/card/sv1-1_en/small'

function renderFrame(props = {}) {
  return renderToStaticMarkup(createElement(CardArtworkFrame, {
    card,
    image: largeProxy,
    alt: 'Pikachu',
    loading: 'eager',
    ...props,
  }))
}

describe('catalogue artwork underlay', () => {
  beforeEach(() => {
    queryState.useQuery.mockReset()
    queryState.useQuery.mockReturnValue({ data: null })
  })

  it('paints the small catalogue scan behind the large proxy while it loads', () => {
    const markup = renderFrame()

    expect(markup).toContain(`src="${smallProxy}"`)
    expect(markup).toContain(`src="${largeProxy}"`)
    // The shimmer stays as a backdrop for the small scan's own paint, but it
    // stacks behind it, so the underlay is what is seen.
    expect(markup).toContain('unified-card-skeleton absolute inset-0 unified-card-underlay')
    expect(markup.indexOf('unified-card-skeleton')).toBeLessThan(markup.indexOf('unified-card-underlay pointer-events-none'))
    // The underlay is painted before the real image, which fades in over it.
    expect(markup.indexOf('unified-card-underlay')).toBeLessThan(markup.indexOf('alt="Pikachu"'))
    expect(markup).toContain('unified-card-image-crossfade')
    expect(markup).toContain('style="opacity:0"')
  })

  it('keeps the underlay decorative and non-interactive', () => {
    const markup = renderFrame()
    const underlay = markup.slice(
      markup.indexOf('<img src="' + smallProxy),
      markup.indexOf('>', markup.indexOf('<img src="' + smallProxy)) + 1,
    )

    expect(underlay).toContain('aria-hidden="true"')
    expect(underlay).toContain('alt=""')
    expect(underlay).toContain('pointer-events-none')
    expect(underlay).not.toContain('tabindex')
    expect(underlay).not.toContain('role=')
    // The real image keeps its accessible name and eager loading.
    expect(markup).toContain('alt="Pikachu"')
    expect(markup).toContain('loading="eager"')
  })

  it.each([
    ['a custom card', { card: { ...card, is_custom: true } }],
    ['the owner photo', { image: 'blob:owner-photo' }],
    ['a cache-busted custom image', { image: `${largeProxy}?v=7` }],
    ['an upstream asset URL', { image: card.images_large }],
    ['a card with no small scan', { card: { ...card, images_small: null } }],
    ['a card with only a TCGdex image base', { card: { ...card, images_small: null, image: 'https://assets.tcgdex.net/en/sv/sv1/1' } }],
    ['a card without a catalogue id', { card: { ...card, id: 42, card_id: null } }],
    ['a compact thumbnail', { thumbnail: true }],
  ])('leaves %s on the existing skeleton', (_name, props) => {
    const markup = renderFrame(props)

    expect(markup).not.toContain('unified-card-underlay')
    expect(markup).not.toContain('unified-card-image-crossfade')
    expect(markup).toContain('unified-card-skeleton absolute inset-0"')
  })

  it('does not underlay the small proxy with itself', () => {
    const markup = renderFrame({ image: smallProxy })

    expect(markup.match(/src="\/api\/images\/card\/sv1-1_en\/small"/g)).toHaveLength(1)
    expect(markup).not.toContain('unified-card-underlay')
  })

  it('resolves only the proxy large/small pair from the card record', () => {
    expect(resolveCardArtworkUnderlay(card, largeProxy)).toBe(smallProxy)
    expect(resolveCardArtworkUnderlay({ ...card, images: { small: 'x' } }, largeProxy)).toBe(smallProxy)
    expect(resolveCardArtworkUnderlay(card, card.images_large)).toBeNull()
    expect(resolveCardArtworkUnderlay({ ...card, is_custom: true }, largeProxy)).toBeNull()
    expect(resolveCardArtworkUnderlay({ ...card, images_small: null }, largeProxy)).toBeNull()
    expect(resolveCardArtworkUnderlay({ ...card, images_small: null, image: 'https://assets.tcgdex.net/en/sv/sv1/1' }, largeProxy)).toBeNull()
    expect(resolveCardArtworkUnderlay(card, `${largeProxy}?v=7`)).toBeNull()
    expect(resolveCardArtworkUnderlay(card, 'blob:owner-photo')).toBeNull()
    expect(resolveCardArtworkUnderlay(null, largeProxy)).toBeNull()
  })
})
