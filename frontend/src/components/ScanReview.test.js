import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CandidateGrid } from './ScanReview'
import { cardLookupLinks } from '../utils/cardLookup'

// CandidateGrid renders CardImage for candidates that have a catalogue image,
// and CardImage reads its translations from SettingsContext. The lookup link
// itself is translated through the `t` prop, so we pass an identity stub.
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: key => key }),
}))

const t = key => key

function renderGrid(matches, nameEn) {
  return renderToStaticMarkup(createElement(CandidateGrid, {
    matches,
    nameEn,
    onZoom: () => {},
    t,
  }))
}

// A trainer-kit printing — the sort of candidate TCGdex has no scan for, and
// exactly the case the lookup links exist to cover.
const imagelessMatch = {
  id: 1,
  name: 'Bisharp',
  set: 'XY Trainer Kit (Bisharp)',
  set_abbreviation: 'TK7A',
  number: '25',
}

describe('CandidateGrid external lookup links', () => {
  it('offers a Google Images lookup link for a candidate with no catalogue image', () => {
    const markup = renderGrid([imagelessMatch], 'Bisharp')
    const imagesUrl = cardLookupLinks(imagelessMatch, 'Bisharp')[0].url
    // renderToStaticMarkup HTML-escapes & inside attribute values, so read the
    // rendered href back and unescape it before comparing to the helper's URL.
    const href = markup.match(/href="([^"]*tbm=isch[^"]*)"/)?.[1]?.replace(/&amp;/g, '&')

    expect(href).toBe(imagesUrl)
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
  })

  it('keeps the lookup link outside the selection button', () => {
    const markup = renderGrid([imagelessMatch], 'Bisharp')

    // The only button in an imageless tile is the selection button.
    const buttonStart = markup.indexOf('<button')
    const buttonEnd = markup.indexOf('</button>', buttonStart)
    const buttonMarkup = markup.slice(buttonStart, buttonEnd)

    // The link's Google Images href must not appear inside <button>…</button>,
    // and the link itself must render after the button closes.
    expect(buttonMarkup).not.toContain('tbm=isch')
    expect(markup.indexOf('</button>')).toBeLessThan(markup.indexOf('tbm=isch'))
  })

  it('shows no lookup link when the candidate has a catalogue image', () => {
    const markup = renderGrid([{ id: 2, name: 'Pikachu', image: 'https://example.test/pikachu.webp' }], 'Bisharp')

    expect(markup).not.toContain('tbm=isch')
    expect(markup).not.toContain('scanner.lookupShort')
  })
})
