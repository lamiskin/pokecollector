import { expect, test } from '@playwright/test'

const HARNESS = '/tests/visual/fixtures/scanner-variants.html'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=', 'base64')
const match = {
  id: 'synthetic-001', tcg_card_id: 'synthetic-001', lang: 'en', name: 'Scanner candidate', number: '001',
  set_abbreviation: 'SYN', image: '/api/synthetic-art.png',
  // A future scanner may guess these fields. Catalogue-only selection must ignore them.
  variant: 'Normal', finish: 'Normal', variants_normal: true, price_tcg_normal_market: 99,
}
const canonicalOptions = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']
const knownFlags = flags => ({ variants_normal: false, variants_holo: false, variants_reverse: false, variants_first_edition: false, ...flags })
const detail = (lang = 'en', flags = knownFlags({ variants_holo: true })) => ({
  id: `synthetic-001_${lang}`, lang, name: 'Catalogue card', ...flags,
})

async function installApi(page, { lookup = (_route, lang) => detail(lang), matches = [match] } = {}) {
  const evidence = { lookups: [], adds: [], photos: [], resolves: [] }
  const item = {
    id: 71, position: 0, status: 'done', resolved: false, has_image: true,
    recognized: { name: 'Stored scan', language: 'en', variant: 'Normal' }, matches,
  }
  const job = {
    id: 7, status: 'done', total: 1, processed: 1, attention: 1, active: 0,
    pending: 0, processing: 0, retrying: 0, failed: 0, failed_attention: 0, items: [item],
  }
  await page.addInitScript(() => localStorage.setItem('app_language', 'en'))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const lookupMatch = path.match(/^\/api\/cards\/synthetic-\d+_([a-z-]+)$/)
    if (lookupMatch) {
      evidence.lookups.push(path)
      const card = await lookup(route, lookupMatch[1], path)
      if (card !== undefined) await route.fulfill({ json: card })
      return
    }
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: { id: 1, username: 'Synthetic reviewer', role: 'admin', is_active: true } })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/cards/recognize') return route.fulfill({ json: { recognized: { name: 'Scan', language: 'en', finish: 'Normal' }, matches } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [job] } })
    if (path === '/api/cards/recognize/jobs/7') return route.fulfill({ json: job })
    if (path.endsWith('/resolve-and-add')) {
      const payload = request.postDataJSON()
      evidence.adds.push(payload)
      evidence.resolves.push({ card_id: payload.confirmed_card_id })
      item.resolved = true
      item.has_image = false
      return route.fulfill({ json: {
        item,
        collection_item: { id: 88, card: { id: payload.card_id }, has_scan_photo: false },
      } })
    }
    if (path.endsWith('/resolve')) {
      evidence.resolves.push(request.postDataJSON())
      item.resolved = true
      return route.fulfill({ json: { status: 'resolved' } })
    }
    if (path === '/api/collection/' && request.method() === 'POST') {
      const payload = request.postDataJSON()
      evidence.adds.push(payload)
      return route.fulfill({ json: { id: 88, card: { id: payload.card_id }, has_scan_photo: false } })
    }
    if (path.includes('/collection/88/photo') && request.method() !== 'GET') {
      evidence.photos.push(request.headers()['content-type'])
      return route.fulfill({ json: { has_scan_photo: true } })
    }
    if (path.includes('image') || path.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: PNG })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }, { code: 'de', name: 'German' }] } })
    if (path === '/api/cards/search') return route.fulfill({ json: { cards: [], total: 0 } })
    if (path === '/api/sets/' || path === '/api/cards/custom') return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
  return evidence
}

const dialog = page => page.getByRole('dialog', { name: 'Add to collection', exact: true })
const finish = page => dialog(page).getByRole('combobox', { name: /Variant/ })
const language = page => dialog(page).getByRole('combobox', { name: /Language/ })
const add = page => dialog(page).getByRole('button', { name: 'Add to collection', exact: true })
const options = page => finish(page).locator('option')
const enabledOptions = page => finish(page).locator('option:not([disabled])')

test('single scan looks up canonical detail, defaults Holo, submits it and keeps the photo', async ({ page }, testInfo) => {
  const api = await installApi(page)
  await page.goto(`${HARNESS}?single`)
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: PNG })
  await page.getByRole('button', { name: 'Use selected match' }).click()
  await expect(finish(page)).toHaveValue('Holo')
  await expect(options(page)).toHaveText(canonicalOptions)
  await expect(enabledOptions(page)).toHaveText(['Holo'])
  expect(api.lookups).toContain('/api/cards/synthetic-001_en')
  await page.screenshot({ path: `/tmp/opencode/scanner-catalogue-single-${testInfo.project.name}.png` })
  await add(page).click()
  await expect.poll(() => api.adds).toEqual([{
    card_id: 'synthetic-001_en', variant: 'Holo', lang: 'en', quantity: 1, condition: 'NM', printing_details: [],
  }])
  await expect.poll(() => api.photos.length).toBe(1)
  await expect(dialog(page)).toHaveCount(0)
})

test('persisted batch queue match uses the same catalogue default and existing resolve/photo callbacks', async ({ page }, testInfo) => {
  const api = await installApi(page, { lookup: (_route, lang) => detail(lang, knownFlags({ variants_reverse: true })) })
  await page.goto('/scans/7')
  await page.getByRole('button', { name: 'Add to collection', exact: true }).click()
  await expect(finish(page)).toHaveValue('Reverse Holo')
  await expect(options(page)).toHaveText(canonicalOptions)
  await expect(enabledOptions(page)).toHaveText(['Reverse Holo'])
  await page.screenshot({ path: `/tmp/opencode/scanner-catalogue-batch-${testInfo.project.name}.png` })
  await add(page).click()
  await expect.poll(() => api.adds[0]?.variant).toBe('Reverse Holo')
  await expect.poll(() => api.photos.length).toBe(1)
  await expect.poll(() => api.resolves).toEqual([{ card_id: 'synthetic-001' }])
})

const comparison = page => page.getByRole('dialog', { name: 'Compare with your photo', exact: true })
async function openComparison(page) {
  await page.goto('/scans/7')
  await page.getByRole('button', { name: 'Compare with your photo' }).first().click()
}

for (const [name, flags, expected] of [
  ['holo only', { variants_holo: true }, 'Holo'],
  ['reverse only', { variants_reverse: true }, 'Reverse Holo'],
  ['Normal and reverse', { variants_normal: true, variants_reverse: true }, 'Normal'],
  ['holo and reverse', { variants_holo: true, variants_reverse: true }, 'Reverse Holo'],
  ['positive pricing contradicts flags', { variants_holo: true, price_tcg_normal_market: 1 }, 'Normal'],
  ['no evidence', {}, 'Normal'],
  ['all false', { variants_normal: false, variants_reverse: false, variants_holo: false }, 'Normal'],
  ['foreign evidence', { variants_reverse: true, price_tcg_reverse_market: 1, data_source_lang: 'de', price_source_lang: 'de' }, 'Normal'],
]) {
  test(`express acceptance uses catalogue ${name} for both label and payload`, async ({ page }, testInfo) => {
    const api = await installApi(page, {
      lookup: (_route, lang) => detail(lang, flags),
      matches: [{ ...match, variants_normal: false, variants_holo: true, price_tcg_normal_market: 0, price_tcg_holo_market: 99, finish: 'Holo' }],
    })
    await openComparison(page)
    const express = comparison(page).getByRole('button', { name: `Add as NM · ${expected}`, exact: true })
    await expect(express).toBeEnabled()
    await expect(express).toHaveAttribute('title', `Add this card now as Near Mint, ${expected} — using the catalogue finish default, not a scanner guess.`)
    if (name === 'reverse only') await page.screenshot({ path: `/tmp/opencode/scanner-express-reverse-${testInfo.project.name}.png` })
    await express.click()
    await expect.poll(() => api.adds).toEqual([{
      card_id: 'synthetic-001_en', confirmed_card_id: 'synthetic-001', variant: expected,
      lang: 'en', quantity: 1, condition: 'NM', printing_details: [],
    }])
    await expect.poll(() => api.photos.length).toBe(1)
    await expect.poll(() => api.resolves).toEqual([{ card_id: 'synthetic-001' }])
    await expect(dialog(page)).toHaveCount(0)
  })
}

test('express waits for catalogue lookup before displaying and saving a finish', async ({ page }) => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  const api = await installApi(page, { lookup: async (_route, lang) => { await ready; return detail(lang) } })
  await openComparison(page)
  await expect(comparison(page).getByRole('button', { name: /Loading/ })).toBeDisabled()
  expect(api.adds).toEqual([])
  release()
  await comparison(page).getByRole('button', { name: 'Add as NM · Holo', exact: true }).click()
  await expect.poll(() => api.adds[0]?.variant).toBe('Holo')
})

test('express falls back to Normal on catalogue failure without blocking the edit form', async ({ page }) => {
  const api = await installApi(page, { lookup: async route => {
    await route.fulfill({ status: 503, json: { detail: 'Catalogue unavailable' } })
  } })
  await openComparison(page)
  await expect(comparison(page).getByRole('button', { name: 'Add as NM · Normal', exact: true })).toBeEnabled()
  await comparison(page).getByRole('button', { name: 'Accept match', exact: true }).click()
  await expect(options(page)).toHaveText(['Normal', 'Holo', 'Reverse Holo', 'First Edition'])
  await finish(page).selectOption('Holo')
  await add(page).click()
  await expect.poll(() => api.adds[0]?.variant).toBe('Holo')
})

test('express candidate navigation never applies an old catalogue response to the next match', async ({ page }) => {
  let releaseFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  let delivered = 0
  const api = await installApi(page, {
    matches: [match, { ...match, id: 'synthetic-002_de', lang: 'de', tcg_card_id: 'synthetic-002', name: 'Second candidate' }],
    lookup: async (_route, lang, path) => {
      if (path.includes('synthetic-001')) { await first; delivered++; return detail(lang) }
      return { ...detail(lang, { variants_reverse: true }), id: 'synthetic-002_de' }
    },
  })
  await openComparison(page)
  await expect(comparison(page).getByRole('button', { name: /Loading/ })).toBeDisabled()
  await comparison(page).getByRole('button', { name: 'Next match', exact: true }).click()
  const express = comparison(page).getByRole('button', { name: 'Add as NM · Reverse Holo', exact: true })
  await expect(express).toBeEnabled()
  releaseFirst()
  await expect.poll(() => delivered).toBeGreaterThan(0)
  await expect(express).toBeEnabled()
  await express.click()
  await expect.poll(() => api.adds[0]).toMatchObject({
    card_id: 'synthetic-002_de', confirmed_card_id: 'synthetic-002', variant: 'Reverse Holo', lang: 'de', condition: 'NM',
  })
})

for (const [name, flags, expectedOptions, expected] of [
  ['Normal and reverse', { variants_normal: true, variants_reverse: true }, ['Normal', 'Reverse Holo'], 'Normal'],
  ['holo and reverse', { variants_holo: true, variants_reverse: true }, ['Reverse Holo', 'Holo'], 'Reverse Holo'],
  ['contradictory positive Normal pricing', { variants_holo: true, variants_normal: false, price_tcg_normal_market: 1 }, ['Normal', 'Holo'], 'Normal'],
]) {
  test(`catalogue ${name} stays editable`, async ({ page }) => {
    const api = await installApi(page, { lookup: (_route, lang) => detail(lang, knownFlags(flags)) })
    await page.goto(HARNESS)
    await expect(finish(page)).toHaveValue(expected)
    await expect(options(page)).toHaveText(canonicalOptions)
    await expect(enabledOptions(page)).toHaveText(canonicalOptions.filter(value => expectedOptions.includes(value)))
    const chosen = expectedOptions.find(value => value !== expected)
    await finish(page).selectOption(chosen)
    await add(page).click()
    await expect.poll(() => api.adds[0]?.variant).toBe(chosen)
    await expect(page.getByTestId('added-count')).toHaveText('1')
  })
}

for (const scenario of ['missing metadata', 'all false', 'fetch failure', 'foreign language fallback', 'foreign source evidence']) {
  test(`${scenario} permits all finishes and ignores scanner guesses`, async ({ page }) => {
    const api = await installApi(page, { lookup: async (route, lang) => {
      if (scenario === 'fetch failure') {
        await route.fulfill({ status: 503, json: { detail: 'Catalogue unavailable' } })
        return
      }
      if (scenario === 'foreign language fallback') return detail('de')
      if (scenario === 'foreign source evidence') return detail(lang, {
        variants_holo: true, price_tcg_normal_market: 1, data_source_lang: 'de', price_source_lang: 'de',
      })
      return detail(lang, scenario === 'all false' ? { variants_normal: false, variants_holo: false, variants_reverse: false } : {})
    } })
    await page.goto(HARNESS)
    await expect(finish(page)).toHaveValue('Normal')
    await expect(options(page)).toHaveText(['Normal', 'Holo', 'Reverse Holo', 'First Edition'])
    await finish(page).selectOption('First Edition')
    await add(page).click()
    await expect.poll(() => api.adds[0]?.variant).toBe('First Edition')
  })
}

test('reconciles an unsupported explicit edit when late catalogue detail arrives', async ({ page }) => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  const api = await installApi(page, { lookup: async (_route, lang) => { await ready; return detail(lang) } })
  await page.goto(HARNESS)
  await expect(dialog(page).getByRole('button', { name: /Loading/ })).toBeDisabled()
  await expect(finish(page)).toHaveValue('')
  await finish(page).selectOption('Reverse Holo')
  expect(api.adds).toEqual([])
  release()
  await expect(add(page)).toBeEnabled()
  await expect(finish(page)).toHaveValue('Holo')
  await expect(options(page)).toHaveText(canonicalOptions)
  await expect(enabledOptions(page)).toHaveText(['Holo'])
  await add(page).click()
  await expect.poll(() => api.adds[0]?.variant).toBe('Holo')
})

test('bare ID preserves match language and late old-language response cannot replace selected-language default', async ({ page }) => {
  let releaseGerman
  const german = new Promise(resolve => { releaseGerman = resolve })
  let delivered = 0
  const api = await installApi(page, { lookup: async (_route, lang) => {
    if (lang === 'de') { await german; delivered++; return detail('de', { variants_reverse: true }) }
    return detail(lang)
  } })
  await page.goto(`${HARNESS}?lang=de`)
  await expect.poll(() => api.lookups.length).toBeGreaterThan(0)
  expect(api.lookups.every(path => path.endsWith('_de'))).toBe(true)
  await language(page).selectOption('en')
  await expect(finish(page)).toHaveValue('Holo')
  releaseGerman()
  await expect.poll(() => delivered).toBeGreaterThan(0)
  await expect(finish(page)).toHaveValue('Holo')
  await add(page).click()
  await expect.poll(() => api.adds[0]).toMatchObject({ card_id: 'synthetic-001_en', lang: 'en', variant: 'Holo' })
})

test('unsupported explicit choice is reconciled after language change and payload matches', async ({ page }) => {
  const api = await installApi(page, { lookup: (_route, lang) => detail(lang, knownFlags(lang === 'de' ? { variants_reverse: true } : { variants_normal: true, variants_holo: true })) })
  await page.goto(HARNESS)
  await expect(finish(page)).toHaveValue('Normal')
  await finish(page).selectOption('Holo')
  await language(page).selectOption('de')
  await expect(add(page)).toBeEnabled()
  await expect(finish(page)).toHaveValue('Reverse Holo')
  await expect(options(page)).toHaveText(canonicalOptions)
  await expect(enabledOptions(page)).toHaveText(['Reverse Holo'])
  await add(page).click()
  await expect.poll(() => api.adds[0]).toMatchObject({ card_id: 'synthetic-001_de', lang: 'de', variant: 'Reverse Holo' })
})

test('late response for a cancelled match cannot affect the next selected card', async ({ page }) => {
  let releaseFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  let delivered = 0
  const api = await installApi(page, {
    matches: [match, { ...match, id: 'synthetic-002', name: 'Second candidate', tcg_card_id: 'synthetic-002' }],
    lookup: async (_route, lang, path) => {
      if (path.includes('synthetic-001')) { await first; delivered++; return detail(lang) }
      return { ...detail(lang, { variants_reverse: true }), id: 'synthetic-002_en' }
    },
  })
  await page.goto(`${HARNESS}?single`)
  await page.locator('input[type=file]').nth(1).setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: PNG })
  await page.getByRole('button', { name: 'Use selected match' }).click()
  await expect(dialog(page).getByRole('button', { name: /Loading/ })).toBeDisabled()
  await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Second candidate', exact: true }).click()
  await page.getByRole('button', { name: 'Use selected match' }).click()
  await expect(finish(page)).toHaveValue('Reverse Holo')
  releaseFirst()
  await expect.poll(() => delivered).toBeGreaterThan(0)
  await expect(finish(page)).toHaveValue('Reverse Holo')
  await add(page).click()
  await expect.poll(() => api.adds[0]).toMatchObject({ card_id: 'synthetic-002_en', variant: 'Reverse Holo' })
})

test('supported nondefault choice survives late metadata and a language change', async ({ page }) => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  const api = await installApi(page, { lookup: async (_route, lang) => {
    if (lang === 'en') await ready
    return detail(lang, knownFlags({ variants_normal: true, variants_holo: true }))
  } })
  await page.goto(HARNESS)
  await finish(page).selectOption('Holo')
  release()
  await expect(add(page)).toBeEnabled()
  await expect(finish(page)).toHaveValue('Holo')
  await language(page).selectOption('de')
  await expect(add(page)).toBeEnabled()
  await expect(finish(page)).toHaveValue('Holo')
  await add(page).click()
  await expect.poll(() => api.adds[0]).toMatchObject({ variant: 'Holo', lang: 'de' })
})

for (const entry of ['scan', 'card']) {
  const modal = page => entry === 'scan' ? dialog(page) : page.getByRole('dialog')
  const selector = page => modal(page).getByRole('combobox', { name: /Variant/ })
  const submit = page => modal(page).getByRole('button', { name: /Add to collection/i, exact: true })
  for (const [name, flags, enabled, selected] of [
    ['known holo only', knownFlags({ variants_holo: true }), ['Holo'], 'Holo'],
    ['positive prices override false flags', knownFlags({ variants_holo: true, price_tcg_normal_market: 1, price_tcg_reverse_market: 2 }), ['Normal', 'Holo', 'Reverse Holo'], 'Reverse Holo'],
    ['missing metadata', {}, canonicalOptions, 'First Edition'],
    ['all false', knownFlags({}), canonicalOptions, 'First Edition'],
    ['partial metadata', { variants_holo: true, variants_normal: false, variants_reverse: null }, ['Holo', 'Reverse Holo', 'First Edition'], 'First Edition'],
    ['foreign flags only', { ...knownFlags({ variants_holo: true }), data_source_lang: 'de', price_source_lang: 'en', price_tcg_reverse_market: 1 }, canonicalOptions, 'First Edition'],
    ['foreign prices only', { ...knownFlags({ variants_holo: true }), data_source_lang: 'en', price_source_lang: 'de', price_tcg_reverse_market: 1 }, ['Holo'], 'Holo'],
    ['fully foreign evidence', { ...knownFlags({ variants_holo: true }), data_source_lang: 'de', price_source_lang: 'de', price_tcg_reverse_market: 1 }, canonicalOptions, 'Normal'],
    ['First Edition separately supported', knownFlags({ variants_holo: true, variants_first_edition: true }), ['Holo', 'First Edition'], 'First Edition'],
  ]) {
    test(`${entry} add: ${name} keeps all options visible and submits the visible choice`, async ({ page }, testInfo) => {
      const api = await installApi(page, { lookup: (_route, lang) => detail(lang, flags) })
      await page.goto(`${HARNESS}${entry === 'card' ? '?card' : ''}`)
      const select = selector(page)
      await expect(select.locator('option')).toHaveText(canonicalOptions)
      await expect(select.locator('option:not([disabled])')).toHaveText(enabled)
      await select.selectOption(selected)
      await expect(select).toHaveValue(selected)
      if (name === 'known holo only') {
        // Expose the native option styling in a screenshot; the production
        // control remains a collapsed select (restored before submission).
        await select.evaluate(element => { element.size = 4 })
        await page.screenshot({ path: `/tmp/opencode/finish-disabled-${entry}-${testInfo.project.name}.png` })
        await modal(page).getByRole('listbox', { name: /Variant/ }).evaluate(element => element.removeAttribute('size'))
      }
      await submit(page).click()
      await expect.poll(() => api.adds[0]?.variant).toBe(selected)
    })
  }
}

test('existing card reconciles newly excluded choices after refreshed metadata but preserves supported choices', async ({ page }) => {
  let flags = knownFlags({ variants_normal: true, variants_holo: true, variants_reverse: true })
  const api = await installApi(page, { lookup: (_route, lang) => detail(lang, flags) })
  await page.goto(`${HARNESS}?card`)
  const modal = page.getByRole('dialog')
  const select = modal.getByRole('combobox', { name: /Variant/ })
  await select.selectOption('Holo')
  flags = knownFlags({ variants_normal: true, variants_holo: true })
  await page.locator('#refresh-card-evidence').evaluate(button => button.click())
  await expect(select.locator('option[value="Reverse Holo"]')).toBeDisabled()
  await expect(select).toHaveValue('Holo')
  flags = knownFlags({ variants_reverse: true })
  await page.locator('#refresh-card-evidence').evaluate(button => button.click())
  await expect(select).toHaveValue('Reverse Holo')
  await modal.getByRole('button', { name: /Add to collection/i, exact: true }).click()
  await expect.poll(() => api.adds[0]?.variant).toBe('Reverse Holo')
})

for (const identity of ['explicit normalized language', 'ID suffix only']) {
  test(`existing card ${identity} never applies legacy English evidence to Japanese printing`, async ({ page }) => {
    const api = await installApi(page, { lookup: (_route, lang) => ({
      ...detail(lang, knownFlags({ variants_holo: true })),
      lang: identity === 'ID suffix only' ? undefined : 'EN',
      data_source_lang: null,
      price_source_lang: null,
    }) })
    await page.goto(`${HARNESS}?card`)
    const modal = page.getByRole('dialog')
    const select = modal.getByRole('combobox', { name: /Variant/ })
    const languages = modal.locator('select').filter({ has: page.locator('option[value="ja"]') })
    await expect(select.locator('option:not([disabled])')).toHaveText(['Holo'])
    await expect(select).toHaveValue('Holo')

    await languages.selectOption('ja')
    await expect(select.locator('option:not([disabled])')).toHaveText(canonicalOptions)
    await expect(select).toHaveValue('Normal')
    await select.selectOption('Holo')
    await languages.selectOption('en')
    await expect(select).toHaveValue('Holo')
    await languages.selectOption('ja')
    await expect(select).toHaveValue('Holo')
    await select.selectOption('Normal')

    await languages.selectOption('en')
    await expect(select.locator('option:not([disabled])')).toHaveText(['Holo'])
    await expect(select).toHaveValue('Holo')

    await languages.selectOption('ja')
    await expect(select.locator('option:not([disabled])')).toHaveText(canonicalOptions)
    await expect(select).toHaveValue('Normal')
    await select.selectOption('Normal')
    await modal.getByRole('button', { name: /Add to collection/i, exact: true }).click()
    await expect.poll(() => api.adds[0]).toMatchObject({ card_id: 'synthetic-001_ja', lang: 'ja', variant: 'Normal' })
  })
}

test('existing card preserves a custom card ID unchanged when collection language changes', async ({ page }) => {
  const customId = 'custom-synthetic_en'
  const api = await installApi(page, { lookup: () => ({
    id: customId, is_custom: true, lang: 'en', name: 'Synthetic custom card',
  }) })
  await page.goto(`${HARNESS}?card`)
  const modal = page.getByRole('dialog')
  const select = modal.getByRole('combobox', { name: /Variant/ })
  const languages = modal.locator('select').filter({ has: page.locator('option[value="ja"]') })
  await languages.selectOption('ja')
  await expect(select.locator('option:not([disabled])')).toHaveText(canonicalOptions)
  await select.selectOption('First Edition')
  await modal.getByRole('button', { name: /Add to collection/i, exact: true }).click()
  await expect.poll(() => api.adds[0]).toMatchObject({ card_id: customId, lang: 'ja', variant: 'First Edition' })
})

test('existing card derives its automatic default only from language-filtered evidence', async ({ page }) => {
  const api = await installApi(page, { lookup: (_route, lang) => detail(lang, {
    ...knownFlags({ variants_holo: true }), data_source_lang: 'de', price_source_lang: 'de',
  }) })
  await page.goto(`${HARNESS}?card`)
  const modal = page.getByRole('dialog')
  const select = modal.getByRole('combobox', { name: /Variant/ })
  await expect(select.locator('option:not([disabled])')).toHaveText(canonicalOptions)
  await expect(select).toHaveValue('Normal')
  await modal.getByRole('button', { name: /Add to collection/i, exact: true }).click()
  await expect.poll(() => api.adds[0]).toMatchObject({ card_id: 'synthetic-001_en', lang: 'en', variant: 'Normal' })
})
