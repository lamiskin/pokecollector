import { expect, test } from '@playwright/test'

const USER = { id: 1, username: 'misty', role: 'admin', is_active: true, must_change_password: false }
const SCANNER_CONFIGURATION = {
  provider: 'gemini',
  model: 'gemini-flash-latest',
  status: 'ready',
  visual_verification: 'automatic',
  providers: [
    { id: 'gemini', label: 'Gemini', models: ['gemini-flash-latest'], default_model: 'gemini-flash-latest', selected_model: 'gemini-flash-latest', requires_api_key: true, api_key_configured: true, endpoint_type: 'hosted', custom_model_allowed: true, custom_model: '' },
    { id: 'openai', label: 'Local Ollama', models: ['vision-fast'], default_model: 'vision-fast', selected_model: 'vision-fast', requires_api_key: false, api_key_configured: false, endpoint_type: 'custom', custom_model_allowed: true, custom_model: '' },
  ],
}
const cards = [
  { id: 'pair', name: 'Café fox', image: null, set_name: 'Éclat', set_id: 's01', number: '007/100', rarity: 'Rare', variant: 'Holo', lang: 'fr', quantity: 2, market_value: 3 },
  { id: 'pair', name: 'Café fox', image: null, set_name: 'Éclat', set_id: 's01', number: '007/100', rarity: 'Rare', variant: 'Normal', lang: 'fr', quantity: 2, market_value: 3 },
  { id: 'single', name: 'Bear', image: null, set_name: 'Éclat', set_id: 's01', number: '008/100', rarity: 'Common', variant: 'Normal', lang: 'en', quantity: 3, market_value: 10 },
  { id: 'cross-set', name: 'Zebra', image: null, set_name: 'Aardvark Set', set_id: 's02', number: '001/100', rarity: 'Common', variant: 'Normal', lang: 'en', quantity: 1, market_value: 1 },
]

async function installApi(page, { featureEnabled = true, showValues = true, allOwnedCards = false, privateBinderCount = 2, cardRows = cards } = {}) {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'public-route-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  const errors = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })

  let settings = {
    language: 'en', currency: 'EUR', price_primary: 'trend', price_display: '["trend"]',
    public_profiles_enabled: featureEnabled ? 'true' : 'false',
    scan_diagnostics_available: 'false', scan_diagnostics_deletion_available: 'false',
  }
  let profile = {
    public_handle: 'misty', trainer_name: 'Misty', is_profile_public: false,
    public_show_values: showValues, public_default_new_binders: false,
    public_show_all_owned_cards: false, private_collection_binder_count: privateBinderCount,
  }
  let savedProfile = null
  let publishRequests = 0
  let cardsRequestAuthorization
  await page.route('**/api/**', async route => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    // The Vite source path /src/api/client.js also matches the broad glob.
    if (!pathname.startsWith('/api/')) return route.continue()
    if (pathname === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (pathname === '/api/auth/me') return route.fulfill({ json: USER })
    if (pathname === '/api/settings/' && request.method() === 'GET') return route.fulfill({ json: settings })
    if (pathname === '/api/settings/' && request.method() === 'PUT') {
      settings = { ...settings, ...request.postDataJSON() }
      return route.fulfill({ json: settings })
    }
    if (pathname === '/api/settings/scanner') return route.fulfill({ json: SCANNER_CONFIGURATION })
    if (pathname === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (pathname === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }] } })
    if (pathname === '/api/profile/' && request.method() === 'GET') return route.fulfill({ json: profile })
    if (pathname === '/api/profile/' && request.method() === 'PUT') {
      savedProfile = request.postDataJSON()
      profile = { ...profile, ...savedProfile }
      return route.fulfill({ json: profile })
    }
    if (pathname === '/api/binders/publish-all-collection' && request.method() === 'POST') {
      publishRequests += 1
      profile = { ...profile, private_collection_binder_count: 0 }
      return route.fulfill({ json: { published: privateBinderCount } })
    }
    if (pathname === '/api/public/profiles') return route.fulfill({ json: [] })
    if (pathname === '/api/public/profiles/misty') {
      return route.fulfill({ json: {
        handle: 'misty', trainer_name: 'Misty', avatar_id: null,
        binders: [{ id: 4, name: 'Shared Binder', color: '#e3000b', card_count: 10, unique_card_count: 8, total_value: null }],
      } })
    }
    if (pathname === '/api/public/profiles/misty/cards') {
      cardsRequestAuthorization = request.headers().authorization
      return route.fulfill({ json: {
        handle: 'misty', trainer_name: 'Misty', show_values: showValues, all_owned_cards: allOwnedCards,
        cards: cardRows, card_count: cardRows.reduce((sum, card) => sum + (Number(card.quantity) || 0), 0),
        unique_card_count: new Set(cardRows.map(card => card.id)).size, total_value: showValues ? 123 : null,
      } })
    }
    if (pathname === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (pathname === '/api/analytics/investment-tracker') return route.fulfill({ json: [] })
    if (pathname === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (pathname === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (pathname === '/api/sets/' || pathname === '/api/cards/custom' || pathname === '/api/users/') return route.fulfill({ json: [] })
    if (pathname.includes('supporters') || pathname.includes('contributors') || pathname.includes('custom-matches')) return route.fulfill({ json: [] })
    if (pathname.includes('donations')) return route.fulfill({ json: { total: 0, donations: [] } })
    if (pathname.startsWith('/api/settings/')) return route.fulfill({ json: { value: '' } })
    return route.fulfill({ json: {} })
  })

  return { errors, savedProfile: () => savedProfile, cardsRequestAuthorization: () => cardsRequestAuthorization, publishRequests: () => publishRequests }
}

test('public profile opens all cards with combined search, filters, and aggregate tile sorting', async ({ page }) => {
  const api = await installApi(page)
  await page.goto('/u/misty')
  await page.getByRole('link', { name: /All public cards/ }).click()
  await expect(page).toHaveURL('/u/misty/cards')
  await expect(page.getByRole('heading', { name: 'Misty · All public cards' })).toBeVisible()
  await expect(page.locator('article')).toHaveCount(3)
  expect(api.cardsRequestAuthorization()).toBeUndefined()

  const articles = page.locator('article')
  await expect(articles.nth(0)).toContainText('Café fox')
  await expect(articles.nth(1)).toContainText('Bear')
  await expect(articles.nth(2)).toContainText('Zebra')

  await page.getByLabel('Search name, set, or number').fill('eclat 007/100')
  await expect(articles).toHaveCount(1)
  await expect(articles.first()).toContainText('Café fox')
  await page.getByLabel('Search name, set, or number').clear()
  await page.getByLabel('Rarity', { exact: true }).selectOption('Rare')
  await page.getByLabel('Variant', { exact: true }).selectOption('Holo')
  await page.getByLabel('Language', { exact: true }).selectOption('fr')
  await expect(articles).toHaveCount(1)
  await expect(articles.first()).toContainText('2 shared')

  await page.getByLabel('Rarity', { exact: true }).selectOption('')
  await page.getByLabel('Variant', { exact: true }).selectOption('')
  await page.getByLabel('Language', { exact: true }).selectOption('')
  await page.getByLabel('Sort by', { exact: true }).selectOption('quantity')
  await expect(articles.nth(0)).toContainText('Zebra')
  await expect(articles.nth(1)).toContainText('Bear')
  await expect(articles.nth(2)).toContainText('Café fox')
  await page.getByRole('button', { name: 'Ascending' }).click()
  await expect(articles.nth(0)).toContainText('Café fox')
  await expect(articles.nth(2)).toContainText('Zebra')

  await page.getByRole('button', { name: 'Descending' }).click()
  await page.getByLabel('Sort by', { exact: true }).selectOption('value')
  await expect(articles.nth(0)).toContainText('Zebra')
  await expect(articles.nth(1)).toContainText('Café fox')
  await expect(articles.nth(2)).toContainText('Bear')
  expect(api.errors).toEqual([])
})

test('hides hostile public price fields and removes value sorting when values are disabled', async ({ page }) => {
  const hostileCards = [
    { ...cards[0], id: 'first', set_id: 's01', number: '001/100', quantity: 1, market_value: 987654321 },
    { ...cards[1], id: 'second', set_id: 's01', number: '002/100', quantity: 3, market_value: 876543210 },
  ]
  const api = await installApi(page, { showValues: false, cardRows: hostileCards })
  await page.goto('/u/misty/cards')
  await expect(page.locator('article')).toHaveCount(2)
  await expect(page.getByLabel('Sort by', { exact: true }).locator('option[value="value"]')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('987654321')
  await expect(page.locator('body')).not.toContainText('876543210')
  await expect(page.locator('body')).not.toContainText('€')
  expect(api.errors).toEqual([])
})

test('public cards copy distinguishes all-owned cards from binder-only sharing', async ({ page }) => {
  const api = await installApi(page, { allOwnedCards: true })
  await page.goto('/u/misty/cards')
  await expect(page.getByRole('heading', { name: 'Misty · All owned cards' })).toBeVisible()
  await expect(page.getByText('Cards and quantities from the full collection, including cards outside public binders.')).toBeVisible()
  expect(api.errors).toEqual([])
})

for (const enabled of [true, false]) {
  test(`signed-in home ${enabled ? 'shows' : 'hides'} public directory entry with feature ${enabled ? 'on' : 'off'}`, async ({ page }) => {
    const api = await installApi(page, { featureEnabled: enabled })
    await page.goto('/')
    await expect(page.getByText('Hello,')).toBeVisible({ timeout: 15_000 })
    const directoryLink = page.getByRole('button', { name: 'Public profiles' })
    if (!enabled) {
      await expect(directoryLink).toHaveCount(0)
    } else {
      await expect(directoryLink).toBeVisible()
      await directoryLink.click()
      await expect(page).toHaveURL('/u')
      await expect(page.getByRole('heading', { name: 'Public profiles' })).toBeVisible()
    }
    expect(api.errors).toEqual([])
  })
}

test('saves new-binder public default while profile sharing is private', async ({ page }) => {
  const api = await installApi(page, { featureEnabled: true })
  await page.goto('/settings')
  const publicProfileSection = page.locator('section').filter({ hasText: 'Public trainer name' })
  const preference = publicProfileSection.getByRole('button', { name: 'New binders public by default' })
  const allOwnedPreference = publicProfileSection.getByRole('button', { name: 'Share all owned cards' })
  await expect(preference).toHaveAttribute('aria-pressed', 'false')
  await preference.click()
  await expect(page.getByText('Publish 2 existing private collection binders now? This does not include wishlists. They will only be visible while your profile is public.')).toBeVisible()
  expect(api.publishRequests()).toBe(0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(preference).toHaveAttribute('aria-pressed', 'true')
  await allOwnedPreference.click()
  await publicProfileSection.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(api.savedProfile).toMatchObject({
    is_profile_public: false,
    public_default_new_binders: true,
    public_show_all_owned_cards: true,
  })
  await expect(preference).toHaveAttribute('aria-pressed', 'true')
  await expect(allOwnedPreference).toHaveAttribute('aria-pressed', 'true')
  expect(api.publishRequests()).toBe(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'New binders public by default' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Share all owned cards' })).toHaveAttribute('aria-pressed', 'true')
  expect(api.errors).toEqual([])
})

test('accepting the new-binder prompt publishes existing collection binders explicitly', async ({ page }) => {
  const api = await installApi(page, { privateBinderCount: 3 })
  await page.goto('/settings')
  const section = page.locator('section').filter({ hasText: 'Public trainer name' })
  await section.getByRole('button', { name: 'New binders public by default' }).click()
  await expect(page.getByText('Publish 3 existing private collection binders now? This does not include wishlists. They will only be visible while your profile is public.')).toBeVisible()
  expect(api.publishRequests()).toBe(0)
  await page.getByRole('button', { name: 'Publish binders', exact: true }).click()
  await expect.poll(api.publishRequests).toBe(1)
  await expect(page.getByRole('button', { name: 'Publish existing binders (3)' })).toHaveCount(0)
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(api.savedProfile).toMatchObject({ public_default_new_binders: true, is_profile_public: false })
  expect(api.errors).toEqual([])
})

test('persistent publish action can be canceled or accepted without changing wishlist policy', async ({ page }) => {
  const api = await installApi(page, { privateBinderCount: 1 })
  await page.goto('/settings')
  const action = page.getByRole('button', { name: 'Publish existing binders (1)' })
  await expect(action).toBeVisible()
  await action.click()
  await expect(page.getByText('Publish 1 existing private collection binder now? This does not include wishlists. It will only be visible while your profile is public.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(api.publishRequests()).toBe(0)
  await action.click()
  await page.getByRole('button', { name: 'Publish binders', exact: true }).click()
  await expect.poll(api.publishRequests).toBe(1)
  expect(api.errors).toEqual([])
})
