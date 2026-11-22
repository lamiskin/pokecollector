import { expect, test } from '@playwright/test'

const HARNESS = '/tests/visual/fixtures/collection-edit-variants.html'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=', 'base64')
const canonicalOptions = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']

async function installApi(page) {
  await page.addInitScript(() => localStorage.setItem('app_language', 'en'))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: { id: 1, username: 'Synthetic collector', role: 'admin', is_active: true } })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }] } })
    if (path === '/api/binders/') return route.fulfill({ json: [] })
    if (path.endsWith('/locations')) return route.fulfill({ json: { locations: [] } })
    if (path.includes('image') || path.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: PNG })
    return route.fulfill({ json: {} })
  })
}

const manageDialog = page => page.getByRole('dialog')
const variantSelect = page => manageDialog(page).getByRole('combobox', { name: /Variant/ })

test('manage copies disables finishes the catalogue contradicts and keeps the stored one', async ({ page }) => {
  await installApi(page)
  await page.goto(HARNESS)
  const select = variantSelect(page)
  await expect(select).toHaveValue('Holo')
  await expect(select.locator('option')).toHaveText(canonicalOptions)
  await expect(select.locator('option:not([disabled])')).toHaveText(['Holo'])
  await expect(manageDialog(page).getByText(/Available: Holo/).first()).toBeVisible()

  await page.goto(`${HARNESS}?scenario=contradicted`)
  const contradicted = variantSelect(page)
  await expect(contradicted).toHaveValue('Normal')
  // DOM order, not selection order: the stored Normal row stays selectable.
  await expect(contradicted.locator('option:not([disabled])')).toHaveText(['Normal', 'Holo'])
})

test('manage copies keeps every finish editable without catalogue evidence', async ({ page }) => {
  await installApi(page)
  await page.goto(`${HARNESS}?scenario=unknown`)
  const select = variantSelect(page)
  await expect(select.locator('option:not([disabled])')).toHaveText(canonicalOptions)
  await expect(manageDialog(page).getByText(/Available:/)).toHaveCount(0)
})

test('capture the gated selector for release notes', async ({ page }, testInfo) => {
  await installApi(page)
  await page.goto(HARNESS)
  const select = variantSelect(page)
  await expect(select.locator('option:not([disabled])')).toHaveText(['Holo'])
  await select.scrollIntoViewIfNeeded()
  // A collapsed native select cannot show per-option state in a screenshot.
  // A handle keeps working after size changes the element's role.
  const handle = await select.elementHandle()
  await handle.evaluate(element => { element.size = 4 })
  await page.screenshot({ path: `/tmp/opencode/manage-copies-${testInfo.project.name}.png` })
  await handle.evaluate(element => element.removeAttribute('size'))
})
