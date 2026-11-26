import { expect, test } from '@playwright/test'
import { getEffectiveCardPriceDetails } from '../../src/utils/prices.js'

const artist = 'Fixture Illustrator'
const artwork = '<svg xmlns="http://www.w3.org/2000/svg" width="126" height="176"><rect width="126" height="176" rx="8" fill="#17324d"/><circle cx="63" cy="70" r="30" fill="#e7be47"/></svg>'
const card = {
  id: 'visual-artist-card_en',
  card_id: 'visual-artist-card_en',
  tcg_card_id: 'visual-artist-card',
  name: 'Illustration of Pikachu',
  number: '001',
  set_id: 'visual-set_en',
  set_name: 'Visual Set',
  set_ref: { id: 'visual-set_en', name: 'Visual Set' },
  lang: 'en',
  artist,
  images_small: '/api/images/visual-artist-card/small',
  images_large: '/api/images/visual-artist-card/large',
  price_market: null,
  price_trend: null,
  price_tcg_normal_market: null,
  manual_value_override: 12.5,
  variants_normal: true,
  printings: [{ id: 'visual-printing', lang: 'en', variant: 'Normal' }],
}

test('artist directory and checklist render artwork and manual-valued cards', async ({ page }, testInfo) => {
  const pageErrors = []
  const consoleErrors = []
  const checklistRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.addInitScript(() => {
    localStorage.setItem('token', 'synthetic-artist-visual-token')
    localStorage.setItem('app_language', 'en')
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url
    const json = body => route.fulfill({ status: 200, json: body })

    if (pathname.startsWith('/api/images/')) {
      return route.fulfill({ contentType: 'image/svg+xml', body: artwork })
    }
    if (pathname === '/api/auth/mode') return json({ multi_user: true })
    if (pathname === '/api/auth/me') return json({ id: 1, username: 'Visual Trainer', role: 'admin', is_active: true, must_change_password: false })
    if (pathname === '/api/settings/') return json({ language: 'en', currency: 'EUR', price_primary: 'market', holo_effects_enabled: 'false' })
    if (pathname === '/api/settings/exchange-rate') return json({ rate: 1 })
    if (pathname === '/api/profile/') return json({})
    if (pathname === '/api/cards/artists') {
      return json({
        artists: [{ name: artist, total_count: 1, owned_count: 0, missing_count: 1, progress: 0, preview_cards: [{ ...card, valuation: { amount: 12.5, source: 'manual' } }] }],
        total_count: 1,
        languages: ['en'],
      })
    }
    if (pathname === '/api/cards/artist-checklist') {
      checklistRequests.push(Object.fromEntries(url.searchParams.entries()))
      return json({ cards: [card], total_count: 1, owned_count: 0, missing_count: 1, missing_value: 12.5, list_count: 1, artists: [artist], languages: ['en'] })
    }
    if (pathname === '/api/settings/tcgdex-filter-languages') return json(['en'])
    return json({})
  })

  await page.goto('/artists')
  await expect(page.getByRole('heading', { name: 'Artists' })).toBeVisible()
  await expect(page.getByText(artist, { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`artists-${testInfo.project.name || 'viewport'}.png`), fullPage: true })

  await page.getByRole('link', { name: new RegExp(artist) }).first().click()
  await expect(page.getByRole('heading', { name: artist })).toBeVisible()
  await expect(page.getByText('Illustration of Pikachu').first()).toBeVisible()
  await expect(page.getByText(/12[.,]50|12\.5/).first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`artist-checklist-${testInfo.project.name || 'viewport'}.png`), fullPage: true })

  await expect.poll(() => checklistRequests.length).toBeGreaterThan(0)
  expect(checklistRequests.at(-1)).toMatchObject({ artist, artist_match: 'exact', price_field: 'price_market' })
  expect(getEffectiveCardPriceDetails(card, null, 'price_market')).toMatchObject({ amount: 12.5, currency: 'EUR', source: 'manual' })
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
