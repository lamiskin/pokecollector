import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CandidateGrid, ScanItemPanel } from './ScanReview'
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

// ─── Manual card fallback on a no-match photo ──────────────────────────────
// ScanItemPanel is what the review list renders. The manual-card action is
// the only in-scanner way to file a card the catalogue does not have, so its
// presence and absence are worth pinning without a backend.
const failedItem = {
  id: 9,
  position: 0,
  status: 'failed',
  resolved: false,
  has_image: false,
  batch_mode: false,
  recognized: { name: 'Unbekannt' },
  matches: [],
}

function renderPanel(item, extra = {}) {
  return renderToStaticMarkup(createElement(ScanItemPanel, {
    jobId: 1,
    item,
    onAdd: () => {},
    onRetry: () => {},
    onDismiss: () => {},
    onReview: () => {},
    ...extra,
    t,
  }))
}

describe('ScanItemPanel manual card fallback', () => {
  it('offers the manual card action for a photo with no matches', () => {
    const markup = renderPanel({ ...failedItem, status: 'done' }, { onCustomCard: () => {} })

    expect(markup).toContain('scanner.addCardManuallyHint')
    expect(markup).toContain('scanner.addCardManually<')
    expect(markup).toContain('common.retry')
  })

  it('offers it for a failed recognition as well', () => {
    const markup = renderPanel(failedItem, { onCustomCard: () => {} })

    expect(markup).toContain('scanner.addCardManuallyHint')
    expect(markup).toContain('scanner.recognitionFailed')
  })

  it('replaces the action with the handled state once a card was created', () => {
    const markup = renderPanel({ ...failedItem, status: 'done' }, {
      onCustomCard: () => {},
      customCardHandled: true,
    })

    expect(markup).toContain('scanner.manualCardHandled')
    expect(markup).not.toContain('scanner.addCardManuallyHint')
  })

  it('does not add a competing path when candidates exist', () => {
    const markup = renderPanel({
      ...failedItem,
      status: 'done',
      matches: [{ id: 3, name: 'Pikachu', image: 'https://example.test/card.webp', lang: 'en' }],
    }, { onCustomCard: () => {} })

    expect(markup).not.toContain('scanner.addCardManuallyHint')
  })
})
