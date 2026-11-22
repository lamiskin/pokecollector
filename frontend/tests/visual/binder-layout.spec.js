import { expect, test } from '@playwright/test'

const initial = () => ({
  binder_id: 11, layout: { page_count: 2, rows: 3, columns: 3, first_page_single: false }, revision: 'r1', can_undo: false,
  entries: [
    { binder_card_id: 71, card_id: 'sample-1_en', name: 'Sample Pikachu', quantity: 3, unplaced_quantity: 1, collection_item_id: 21, variant: 'Holo', lang: 'en', unresolved: false, has_scan_photo: false },
    { binder_card_id: 72, card_id: 'sample-2_en', name: 'Sample Eevee', quantity: 1, unplaced_quantity: 0, collection_item_id: 22, variant: 'Normal', lang: 'en', unresolved: false, has_scan_photo: false },
  ],
  placements: [
    { id: '11111111-1111-4111-8111-111111111111', binder_card_id: 71, card_id: 'sample-1_en', page: 1, slot: 2 },
    { id: '22222222-2222-4222-8222-222222222222', binder_card_id: 71, card_id: 'sample-1_en', page: 2, slot: 7 },
    { id: '33333333-3333-4333-8333-333333333333', binder_card_id: 72, card_id: 'sample-2_en', page: 1, slot: 5 },
  ], placed_count: 3, unplaced_count: 1,
})
const binder = { id: 11, name: 'Sample physical binder', color: '#3b82f6', binder_type: 'collection', card_count: 4, unique_card_count: 2, is_public: true }

async function install(page, { unresolved = false, failMove = false, withoutLayout = false, scanPhoto = false, firstPageSingle = false, pageCount = 0, columns = 0 } = {}) {
  let state = initial()
  let history = null
  let serial = 1
  const writes = []
  const previews = []
  const refresh = () => {
    state.placed_count = state.placements.length
    state.entries.forEach(e => { e.unplaced_quantity = e.quantity - state.placements.filter(p => p.binder_card_id === e.binder_card_id).length })
    state.unplaced_count = state.entries.reduce((sum, e) => sum + e.unplaced_quantity, 0)
    state.revision = `r${++serial}`
    state.can_undo = true
  }
  if (unresolved) { state.entries.push({ binder_card_id: 73, card_id: 'legacy-1_en', name: 'Unlinked legacy card', quantity: 1, unplaced_quantity: 1, unresolved: true }); state.unplaced_count++ }
  if (scanPhoto) state.entries[0].has_scan_photo = true
  if (firstPageSingle && state.layout) state.layout.first_page_single = true
  if (pageCount && state.layout) state.layout.page_count = pageCount
  if (columns && state.layout) state.layout.columns = columns
  if (withoutLayout) { state.layout = null; state.placements = []; state.placed_count = 0; state.unplaced_count = 4; state.entries.forEach(e => { e.unplaced_quantity = e.quantity }) }
  await page.addInitScript(() => {
    localStorage.setItem('token', 'synthetic-test-token')
    localStorage.setItem('app_language', 'en')
  })
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (!path.startsWith('/api/')) return route.continue()
    const json = (body, status = 200) => route.fulfill({ status, json: body })
    if (path.startsWith('/api/images/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="126" height="176"><rect width="126" height="176" fill="#17294d"/><rect x="8" y="8" width="110" height="160" rx="5" fill="#dfbd49"/><circle cx="63" cy="65" r="30" fill="#566faf"/></svg>' })
    if (path.endsWith('/layout/preview')) {
      const body = request.postDataJSON()
      previews.push(body)
      // Changing how pages pair is presentation only: it never moves a copy.
      const affected = state.placements.filter(p => !body.page_count || body.columns !== state.layout.columns || p.page > body.page_count).map(p => ({ ...p, name: state.entries.find(e => e.binder_card_id === p.binder_card_id).name }))
      return json({ revision: state.revision, layout: body.page_count ? body : null, affected })
    }
    if (path === '/api/binders/11/layout' && request.method() === 'PUT') {
      const body = request.postDataJSON(); writes.push(body)
      history = structuredClone(state)
      state.layout = body.page_count ? { page_count: body.page_count, rows: body.rows, columns: body.columns, first_page_single: Boolean(body.first_page_single) } : null
      state.placements = state.placements.filter(p => !body.confirmed_unplace_ids.includes(p.id)); refresh()
      return json(state)
    }
    if (path.endsWith('/layout/undo')) {
      writes.push(request.postDataJSON())
      const previous = history; history = null; state = previous; refresh(); state.can_undo = false
      return json(state)
    }
    if (path === '/api/binders/11/placements') {
      const body = request.postDataJSON(); writes.push(body)
      if (failMove) { state.revision = 'r2'; return json({ detail: 'The binder changed. Refresh and choose the destination again.' }, 409) }
      history = structuredClone(state)
      const source = state.placements.find(p => p.id === body.placement_id)
      const occupant = state.placements.find(p => p.page === body.page && p.slot === body.slot)
      if (occupant && !body.confirm_occupied) return json({ detail: 'Confirmation required' }, 409)
      if (occupant) {
        if (source) { occupant.page = source.page; occupant.slot = source.slot }
        else state.placements = state.placements.filter(p => p.id !== occupant.id)
      }
      if (source) { if (body.page) { source.page = body.page; source.slot = body.slot } else state.placements = state.placements.filter(p => p.id !== source.id) }
      else state.placements.push({ id: '44444444-4444-4444-8444-444444444444', binder_card_id: body.binder_card_id, card_id: state.entries.find(e => e.binder_card_id === body.binder_card_id).card_id, page: body.page, slot: body.slot })
      refresh(); return json(state)
    }
    if (path === '/api/binders/11/layout') return json(state)
    if (path === '/api/public/profiles/example/binders/11/layout') {
      // Mirrors the public serializer: no collection ids, conditions, variants or
      // scan-photo flags, and no private image URLs.
      return json({ ...state, revision: undefined, can_undo: undefined, entries: state.entries.map(({ collection_item_id, condition, variant, has_scan_photo, ...entry }) => entry) })
    }
    if (path.endsWith('/photo')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="126" height="176"><rect width="126" height="176" fill="#3a2a1a"/><rect x="20" y="30" width="86" height="116" rx="6" fill="#b07a3c"/></svg>' })
    if (path.endsWith('/locations')) return json({ locations: state.placements.filter(p => p.card_id === 'sample-1_en').map(p => ({ ...p, placement_id: p.id, binder_id: 11, binder_name: binder.name, quantity: 1 })).concat([{ binder_id: 11, binder_name: binder.name, binder_card_id: 71, card_id: 'sample-1_en', placement_id: null, page: null, slot: null, quantity: 1 }]) })
    const cards = state.entries.map(e => ({ ...e, id: e.card_id, number: '001', set_name: 'Sample set', quantity: e.quantity, required_quantity: e.quantity, owned_quantity: e.quantity, collection_quantity: e.quantity, max_assignable_quantity: e.quantity }))
    const fixtures = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': { id: 1, username: 'Test Trainer', role: 'admin', is_active: true, must_change_password: false },
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'EUR', holo_effects_enabled: 'false' },
      '/api/profile/': { feature_enabled: false },
      '/api/binders/11/cards': { binder, cards, total_count: 4, unique_count: 2, owned_count: 4, available_collection_item_quantities: {} },
      '/api/collection/': cards.map(c => ({ id: c.collection_item_id, card_id: c.card_id, quantity: c.quantity, card: c })),
      '/api/cards/search': { data: [{ ...cards[0], owned: true, owned_quantity: 3, owned_items: [{ id: 21, quantity: 3, variant: 'Holo' }] }], total_count: 1, page: 1, page_size: 20 },
      '/api/binders/': [binder],
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/public/profiles/example': { handle: 'example', trainer_name: 'Sample Trainer', binders: [binder] },
      '/api/public/profiles/example/binders/11': { ...binder, cards, unique_card_count: 2 },
    }
    return json(fixtures[path] ?? (path.includes('equivalent-prints') ? { equivalents: [] } : []))
  })
  return { writes, previews, state: () => state }
}
test('duplicate copies remain on two pages with a separate tray; filtering preserves gaps', async ({ page, isMobile }, testInfo) => {
  await install(page)
  await page.goto('/binders/11')
  await expect(page.getByText('3 placed · 1 not placed · 18 slots')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('binder-layout.png'), fullPage: true })
  await expect(page.locator('[data-page="1"][data-slot="2"]')).toHaveAttribute('data-placement', initial().placements[0].id)
  await page.getByLabel('Find a card in these pages').fill('Pikachu')
  // Filtering highlights matches without collapsing empty pockets into gaps.
  await expect(page.locator('section[aria-label="Page 1"] li.binder-pocket')).toHaveCount(9)
  await expect(page.locator('[data-page="1"][data-slot="5"]')).toHaveAttribute('aria-label', /Sample Eevee/)
  await page.getByLabel('Go to page', { exact: true }).selectOption('2')
  await expect(page.locator('[data-page="2"][data-slot="7"]')).toHaveAttribute('data-placement', initial().placements[1].id)
  if (isMobile) await page.getByRole('button', { name: 'Not placed', exact: false }).click()
  await expect(page.locator('[data-tray-member="71"]')).toContainText('×1')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('keyboard chooser moves one copy, confirms a swap and supports Undo', async ({ page }) => {
  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  const source = page.locator('[data-page="1"][data-slot="2"]')
  await source.focus(); await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Move to…', exact: true }).click()
  const chooser = page.getByRole('dialog', { name: 'Move to…' })
  const grid = chooser.getByRole('group', { name: 'Destination slot' })
  await expect(grid.getByRole('button', { name: /Slot 5/ })).toBeVisible()
  await grid.getByRole('button', { name: /Slot 5/ }).click()
  await expect(grid.getByRole('button', { name: /Slot 5/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(chooser.getByRole('button', { name: 'Move card', exact: true })).toBeEnabled()
  await chooser.getByRole('button', { name: 'Move card', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'Swap these two cards?' })
  await expect(confirmation).toContainText('Sample Eevee')
  expect(fixture.writes).toHaveLength(0)
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(fixture.writes).toHaveLength(0)
  await page.locator('[data-page="1"][data-slot="5"]').click()
  await confirmation.getByRole('button', { name: 'Swap cards', exact: true }).click()
  await expect(page.locator('[data-page="1"][data-slot="5"]')).toHaveAttribute('data-placement', initial().placements[0].id)
  expect(fixture.writes[0].confirm_occupied).toBe(true)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('[data-page="1"][data-slot="2"]')).toHaveAttribute('data-placement', initial().placements[0].id)
  await expect(page.getByText('3 placed · 1 not placed · 18 slots')).toBeVisible()
})

test('tray placement replaces exactly one occupant and leaves other copies alone', async ({ page, isMobile }) => {
  await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  if (isMobile) await page.getByRole('button', { name: /^Not placed/ }).click()
  await page.locator('[data-tray-member="71"]').click()
  await page.locator('[data-page="1"][data-slot="5"]').click()
  const confirmation = page.getByRole('dialog', { name: 'This slot is occupied' })
  await expect(confirmation).toContainText('Sample Eevee will return to Not placed')
  await confirmation.getByRole('button', { name: 'Place and return other card' }).click()
  await expect(page.locator('[data-page="1"][data-slot="5"]')).toHaveAttribute('aria-label', /Sample Pikachu/)
  await expect(page.locator('[data-page="1"][data-slot="2"]')).toHaveAttribute('data-placement', initial().placements[0].id)
  await expect(page.getByText('3 placed · 1 not placed · 18 slots')).toBeVisible()
})

test('a stale move refreshes without moving the original card', async ({ page }) => {
  const fixture = await install(page, { failMove: true })
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  await page.locator('[data-page="1"][data-slot="2"]').click()
  await page.locator('[data-page="1"][data-slot="1"]').click()
  await expect(page.getByRole('alert')).toContainText('The binder changed')
  await expect(page.locator('[data-page="1"][data-slot="2"]')).toHaveAttribute('data-placement', initial().placements[0].id)
  expect(fixture.state().placements).toHaveLength(3)
  await page.locator('[data-page="1"][data-slot="1"]').click()
  await expect.poll(() => fixture.writes.length).toBe(2)
  // The refreshed snapshot is r2, but retrying the old selection must remain r1
  // until the owner cancels/reselects. Never silently bypass the stale-write gate.
  expect(fixture.writes.map(write => write.expected_revision)).toEqual(['r1', 'r1'])
})

test('shrinking pages previews exact locations before returning affected copies to tray', async ({ page }) => {
  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Layout settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Layout settings' })
  await settings.getByLabel('Number of pages').fill('1')
  await settings.getByRole('button', { name: 'Preview changes' }).click()
  await expect(settings).toContainText('Sample Pikachu · Page 2 · Slot 7')
  await expect(settings).toContainText('Preview only — nothing has changed yet.')
  await expect(settings.getByRole('button', { name: 'Update preview' })).toBeVisible()
  expect(fixture.writes).toHaveLength(0)
  await settings.getByRole('button', { name: 'Return cards to Not placed and save (1)' }).click()
  await expect(page.getByText('2 placed · 2 not placed · 9 slots')).toBeVisible()
  expect(fixture.writes[0].confirmed_unplace_ids).toEqual([initial().placements[1].id])
})

test('stale deep links resolve identity, focus the current slot and respect reduced motion', async ({ page }) => {
  await install(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`/binders/11?view=pages&card=sample-1_en&member=71&placement=${initial().placements[1].id}&page=1&slot=5`)
  await expect(page.getByText('This card’s location has changed. Showing its current location instead.')).toBeVisible()
  const destination = page.locator('[data-page="2"][data-slot="7"]')
  await expect(destination).toBeFocused()
  expect(await page.locator('.binder-page-reveal').first().evaluate(e => getComputedStyle(e).animationName)).toBe('none')
})

test('a missing deep-link target never highlights its replacement', async ({ page }) => {
  await install(page)
  await page.goto('/binders/11?view=pages&card=removed_en&member=99&placement=gone&page=1&slot=5')
  await expect(page.getByText('This card is no longer available at the linked location. No other card has been selected.')).toBeVisible()
  await expect(page.locator('.binder-pocket-highlight')).toHaveCount(0)
})

test('public physical layout is read-only and never makes mutation requests', async ({ page }) => {
  const fixture = await install(page)
  await page.goto('/u/example/binder/11')
  await expect(page.getByText('3 placed · 1 not placed · 18 slots')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Arrange', exact: true })).toHaveCount(0)
  await expect(page.locator('[draggable="true"]')).toHaveCount(0)
  // Empty pockets are not dead controls on the public page.
  await expect(page.locator('.binder-pocket-empty [data-slot]')).toHaveCount(0)
  await page.locator('[data-page="1"][data-slot="2"]').click()
  await expect(page.getByRole('dialog')).toContainText('Binder locations')
  expect(fixture.writes).toHaveLength(0)
})

test('legacy entries show an explicit resolution path instead of invented inventory', async ({ page, isMobile }) => {
  await install(page, { unresolved: true })
  await page.goto('/binders/11')
  if (isMobile) await page.getByRole('button', { name: /^Not placed/ }).click()
  await expect(page.getByText(/This older entry is not linked to owned inventory/)).toBeVisible()
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  await expect(page.locator('[data-tray-member="73"]')).toBeDisabled()
})

test('geometry changes preview all placements and render twelve stable pockets', async ({ page }) => {
  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Layout settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Layout settings' })
  await settings.getByLabel('Slots per page').selectOption('4')
  await settings.getByRole('button', { name: 'Preview changes' }).click()
  await expect(settings).toContainText('Cards returning to Not placed: 3')
  expect(fixture.writes).toHaveLength(0)
  await settings.getByRole('button', { name: 'Return cards to Not placed and save (3)' }).click()
  await expect(page.locator('section[aria-label="Page 1"] li.binder-pocket')).toHaveCount(12)
  await expect(page.getByText('No cards are placed yet. Choose Arrange to put a card from Not placed into a pocket.')).toBeVisible()
  await expect(page.getByText('0 placed · 4 not placed · 24 slots')).toBeVisible()
})

test('collection details list every copy and navigate to the matching slot', async ({ page }) => {
  await install(page)
  await page.goto('/collection?itemId=21')
  const locations = page.getByRole('region', { name: 'Binder locations' })
  await expect(locations.getByRole('link')).toHaveCount(3)
  await locations.getByRole('link', { name: /Page 2 · Slot 7/ }).click()
  await expect(page.locator('[data-page="2"][data-slot="7"]')).toBeFocused()
})

test('owned catalogue results expose both placed copies and Not placed', async ({ page }) => {
  await install(page)
  await page.goto('/search?q=Pikachu')
  await page.getByRole('button', { name: 'Sample Pikachu', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('tab', { name: 'Owned copies', exact: true }).click()
  const locations = page.getByRole('region', { name: 'Binder locations' })
  await expect(locations.getByRole('link')).toHaveCount(3)
  await locations.getByRole('link', { name: /Not placed ×1/ }).click()
  await expect(page.locator('[data-tray-member="71"]')).toBeFocused()
})

test('drag dwell changes page without saving, and an off-target drop does not commit', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Native desktop drag enhancement; tap and keyboard equivalents run on both viewports.')
  const fixture = await install(page)
  await page.setViewportSize({ width: 750, height: 1000 })
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  const grip = page.getByRole('button', { name: 'Drag one copy of Sample Pikachu', exact: true }).first()
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await grip.dispatchEvent('dragstart', { dataTransfer: transfer })
  await page.getByRole('button', { name: 'Next page', exact: true }).dispatchEvent('dragover', { dataTransfer: transfer })
  await expect(page.locator('[data-page="2"][data-slot="7"]')).toBeVisible()
  expect(fixture.writes).toHaveLength(0)
  await page.getByRole('button', { name: 'Next page', exact: true }).dispatchEvent('drop', { dataTransfer: transfer })
  expect(fixture.writes).toHaveLength(0)
  await page.locator('[data-page="2"][data-slot="1"]').dispatchEvent('drop', { dataTransfer: transfer })
  await expect(page.locator('[data-page="2"][data-slot="1"]')).toHaveAttribute('data-placement', initial().placements[0].id)
  expect(fixture.writes).toHaveLength(1)
})

test('a finger drag from the pocket grip moves the copy', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mouse uses native HTML5 drag; this covers the touch pointer path.')
  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  // Slots and their grips sit in the same row, so one scroll keeps both on screen.
  await page.locator('[data-page="1"][data-slot="1"]').scrollIntoViewIfNeeded()
  const grip = page.getByRole('button', { name: 'Drag one copy of Sample Pikachu', exact: true }).first()
  const origin = await grip.boundingBox()
  const middle = { x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 }
  const pointer = { pointerId: 41, pointerType: 'touch', isPrimary: true }
  await grip.dispatchEvent('pointerdown', { ...pointer, buttons: 1, clientX: middle.x, clientY: middle.y })
  // The selection bar appears on pointerdown, so measure the pocket afterwards.
  const target = await page.locator('[data-page="1"][data-slot="1"]').boundingBox()
  const drop = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
  const viewport = page.viewportSize()
  expect(drop.y).toBeGreaterThan(0)
  expect(drop.y).toBeLessThan(viewport.height)
  expect(middle.y).toBeLessThan(viewport.height)
  const move = (x, y) => page.evaluate(({ pointer, x, y }) => window.dispatchEvent(
    new PointerEvent('pointermove', { ...pointer, bubbles: true, clientX: x, clientY: y })), { pointer, x, y })
  await move(middle.x, middle.y - 2)
  await move(drop.x, drop.y)
  const dropTarget = page.locator('li.binder-pocket', { has: page.locator('[data-page="1"][data-slot="1"]') })
  await expect(dropTarget).toHaveClass(/binder-pocket-highlight/)
  await page.evaluate(({ pointer, x, y }) => window.dispatchEvent(
    new PointerEvent('pointerup', { ...pointer, bubbles: true, clientX: x, clientY: y })), { pointer, x: drop.x, y: drop.y })
  await expect(page.locator('[data-page="1"][data-slot="1"]')).toHaveAttribute('data-placement', initial().placements[0].id)
  expect(fixture.writes).toHaveLength(1)
  expect(fixture.writes[0]).toMatchObject({ placement_id: initial().placements[0].id, page: 1, slot: 1 })
})

test('ordinary binder location links explain Cards view and open the associated entry', async ({ page }) => {
  await install(page, { withoutLayout: true })
  await page.goto('/binders/11?view=pages&card=sample-1_en&member=71&tray=1')
  await expect(page.getByText(/This binder uses Cards view rather than physical pages/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cards', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Open associated card' }).click()
  await expect(page.getByRole('dialog', { name: 'Sample Pikachu', exact: true })).toBeVisible()
})

test('return to Not placed preserves the allocated copies', async ({ page }) => {
  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  await page.locator('[data-page="1"][data-slot="2"]').click()
  await page.getByRole('button', { name: 'Return to Not placed', exact: true }).click()
  await expect(page.getByText('2 placed · 2 not placed · 18 slots')).toBeVisible()
  expect(fixture.state().entries[0].quantity).toBe(3)
  expect(fixture.writes[0]).toMatchObject({ page: null, slot: null, placement_id: initial().placements[0].id })
})

test('a tray copy fills an empty slot when clicked', async ({ page, isMobile }) => {
  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  if (isMobile) await page.getByRole('button', { name: /^Not placed/ }).click()
  await page.locator('[data-tray-member="71"]').click()
  await page.locator('[data-page="1"][data-slot="1"]').click()
  // A tray source has no placement id, so an empty slot must not be mistaken
  // for "the copy is already there". It has to reach the server.
  await expect(page.locator('[data-page="1"][data-slot="1"]')).toHaveAttribute('aria-label', /Sample Pikachu/)
  expect(fixture.writes).toHaveLength(1)
  expect(fixture.writes[0]).toMatchObject({ binder_card_id: 71, placement_id: null, page: 1, slot: 1 })
  await expect(page.getByText('4 placed · 0 not placed · 18 slots')).toBeVisible()
})

test('Move to… places a tray copy in an empty slot', async ({ page, isMobile }) => {  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  if (isMobile) await page.getByRole('button', { name: /^Not placed/ }).click()
  await page.locator('[data-tray-member="71"]').click()
  await page.getByRole('button', { name: 'Move to…', exact: true }).click()
  const chooser = page.getByRole('dialog', { name: 'Move to…' })
  await chooser.getByRole('group', { name: 'Destination slot' }).getByRole('button', { name: /Slot 3/ }).click()
  await chooser.getByRole('button', { name: 'Move card', exact: true }).click()
  await expect(page.locator('[data-page="1"][data-slot="3"]')).toHaveAttribute('aria-label', /Sample Pikachu/)
  expect(fixture.writes).toHaveLength(1)
  expect(fixture.writes[0]).toMatchObject({ binder_card_id: 71, placement_id: null, page: 1, slot: 3 })
})

test('arrange mode names its gestures and gives the grips a touch-sized target', async ({ page, isMobile }) => {
  await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  await expect(page.getByText('Select a card, then a slot')).toBeVisible()
  await expect(page.getByText('Drag a card onto a slot')).toBeVisible()
  await expect(page.getByText('Hold a page arrow to turn')).toBeVisible()
  await expect(page.getByText('Select one card, then select a destination slot. Or use Move to…')).toHaveCount(1, { timeout: 1000 })
  await page.locator('[data-page="1"][data-slot="2"]').scrollIntoViewIfNeeded()
  const grip = page.getByRole('button', { name: 'Drag one copy of Sample Pikachu', exact: true }).first()
  const target = await grip.boundingBox()
  expect(target.width).toBeGreaterThanOrEqual(44)
  expect(target.height).toBeGreaterThanOrEqual(44)
  await page.locator('[data-page="1"][data-slot="2"]').click()
  const bar = page.getByRole('region', { name: 'Selected card actions' })
  if (isMobile) await expect(bar).toBeInViewport()
  else await expect(bar).toBeVisible()
})

test('the chooser marks the current slot, needs a destination and keeps arrow-key focus', async ({ page }) => {
  await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  await page.locator('[data-page="1"][data-slot="2"]').click()
  await page.getByRole('button', { name: 'Move to…', exact: true }).click()
  const chooser = page.getByRole('dialog', { name: 'Move to…' })
  const grid = chooser.getByRole('group', { name: 'Destination slot' })
  await expect(grid).toBeVisible()
  await expect(chooser.getByRole('button', { name: 'Move card', exact: true })).toBeDisabled()
  await expect(chooser).toContainText('Choose a destination slot')
  // The copy's own pocket cannot be a destination, so it says so instead of
  // silently swallowing the request.
  await expect(grid.getByRole('button', { name: /Slot 2 .* Current slot/ })).toHaveAttribute('aria-disabled', 'true')
  await grid.getByRole('button', { name: /Slot 6/ }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(grid.getByRole('button', { name: /Slot 7/ })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(chooser.getByRole('button', { name: 'Move card', exact: true })).toBeEnabled()
  await expect(chooser).toContainText('Page 1 · Slot 7')
  await page.keyboard.press('Escape')
  await expect(chooser).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Selected card actions' })).toBeVisible()
})

test('the selection bar stays on screen and clear of the tray on a short desktop viewport', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Short desktop viewport regression; the fixed mobile bar is covered above.')
  await install(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  await page.locator('[data-page="1"][data-slot="2"]').click()
  const bar = page.getByRole('region', { name: 'Selected card actions' })
  const viewport = page.viewportSize()
  const box = await bar.boundingBox()
  expect(box).not.toBeNull()
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  // The bar is narrowed away from the tray, so its grip is neither covered nor
  // intercepted: a click must reach the tray button itself.
  const grip = page.getByRole('region', { name: 'Not placed' }).getByRole('button', { name: 'Drag one copy of Sample Pikachu', exact: true })
  await grip.scrollIntoViewIfNeeded()
  const gripBox = await grip.boundingBox()
  const overlaps = gripBox.x < box.x + box.width && gripBox.x + gripBox.width > box.x && gripBox.y < box.y + box.height && gripBox.y + gripBox.height > box.y
  expect(overlaps).toBe(false)
  await grip.click()
  await expect(grip).toBeFocused()
})

test('pocket artwork names the printing and shows the owner photo only in private view', async ({ page }) => {
  await install(page, { scanPhoto: true })
  await page.goto('/binders/11')
  const pocket = page.locator('[data-page="1"][data-slot="2"]')
  const tile = page.locator('li.binder-pocket', { has: pocket })
  await expect(tile.getByTitle('Holo')).toHaveAttribute('aria-label', 'Holo')
  await expect(tile.getByTitle('Your own photo of this card')).toBeVisible()
  // One pocket is one copy, so the artwork never claims a quantity; the tray groups them.
  await expect(tile.locator('[title*="×"]')).toHaveCount(0)
  await expect(page.locator('section[aria-label="Page 1"] .card-variant-effect')).toHaveCount(1)

  // The public snapshot carries no variant and no scan-photo flag, so neither
  // marker may appear, and no private photo may be requested.
  const publicPhotos = []
  // Match the endpoint path, not a substring: the module that shrinks uploads is
  // served as /src/utils/photoCompression.js and is not a photo request.
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/photo')) publicPhotos.push(request.url())
  })
  await page.goto('/u/example/binder/11')
  const publicTile = page.locator('li.binder-pocket', { has: page.locator('[data-page="1"][data-slot="2"]') })
  await expect(publicTile).toBeVisible()
  await expect(publicTile.locator('.card-variant-effect')).toHaveCount(0)
  await expect(publicTile.getByTitle('Your own photo of this card')).toHaveCount(0)
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(0)
  expect(publicPhotos).toHaveLength(0)
})

test('enabling the first-page setting starts page 1 alone and then pairs 2|3', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Spread pairing needs a wide viewport.')
  const fixture = await install(page, { pageCount: 4, firstPageSingle: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/binders/11')
  await expect(page.locator('section.binder-page')).toHaveCount(1)
  await expect(page.locator('section[aria-label="Page 1"]')).toBeVisible()
  await expect(page.getByText('3 placed · 1 not placed · 36 slots')).toBeVisible()
  await page.getByLabel('Go to page', { exact: true }).selectOption('2')
  await expect(page.locator('section.binder-page')).toHaveCount(2)
  await expect(page.locator('section[aria-label="Page 2"]')).toBeVisible()
  await expect(page.locator('section[aria-label="Page 3"]')).toBeVisible()
  await page.getByLabel('Go to page', { exact: true }).selectOption('4')
  await expect(page.locator('section.binder-page')).toHaveCount(1)
  await expect(page.locator('section[aria-label="Page 4"]')).toBeVisible()
  expect(fixture.writes).toHaveLength(0)
})

test('the first-page option reaches preview and save without returning any copy to Not placed', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Spread pairing needs a wide viewport.')
  const fixture = await install(page, { pageCount: 4 })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/binders/11')
  await expect(page.locator('section.binder-page')).toHaveCount(2)
  await expect(page.locator('section[aria-label="Page 2"]')).toBeVisible()

  await page.getByRole('button', { name: 'Layout settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Layout settings' })
  const toggle = settings.getByLabel('Start page 1 on its own')
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(toggle).toBeChecked()
  await settings.getByRole('button', { name: 'Preview changes' }).click()
  await expect(settings).toContainText('All existing card locations will be preserved.')
  expect(fixture.previews.at(-1)).toMatchObject({ page_count: 4, first_page_single: true })
  await settings.getByRole('button', { name: 'Save layout' }).click()
  await expect(page.locator('section.binder-page')).toHaveCount(1)
  expect(fixture.writes.at(-1)).toMatchObject({ page_count: 4, first_page_single: true, confirmed_unplace_ids: [] })

  await page.getByRole('button', { name: 'Layout settings' }).click()
  await expect(settings.getByLabel('Start page 1 on its own')).toBeChecked()
  await settings.getByLabel('Start page 1 on its own').uncheck()
  await settings.getByRole('button', { name: 'Preview changes' }).click()
  await expect(settings).toContainText('All existing card locations will be preserved.')
  expect(fixture.previews.at(-1)).toMatchObject({ first_page_single: false })
  await settings.getByRole('button', { name: 'Save layout' }).click()
  await expect(page.locator('section.binder-page')).toHaveCount(2)
  await expect(page.locator('section[aria-label="Page 2"]')).toBeVisible()
  expect(fixture.writes.at(-1)).toMatchObject({ first_page_single: false })
})

test('a lone page is centred at one page width with no decorative neighbour', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Spread geometry needs a wide viewport.')
  for (const columns of [3, 4]) {
    await page.unroute('**/api/**')
    await install(page, { firstPageSingle: true, columns })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/binders/11')
    await expect(page.locator('section.binder-page')).toHaveCount(1)
    // No facing panel, no inside-cover icon, no faded stand-in page.
    await expect(page.locator('.binder-page.opacity-30')).toHaveCount(0)
    await expect(page.locator('.binder-page svg.lucide-book-open')).toHaveCount(0)
    // The reveal animation translates the page for 180ms; measure once it rests.
    await expect.poll(async () => {
      const box = await page.locator('section.binder-page').boundingBox()
      const outer = await page.locator('.binder-spread').boundingBox()
      return Math.abs(box.x + box.width / 2 - (outer.x + outer.width / 2))
    }).toBeLessThan(2)
    const container = await page.locator('.binder-spread').boundingBox()
    const lone = await page.locator('section.binder-page').boundingBox()
    const onePage = (container.width - 12) / 2
    expect(lone.width).toBeGreaterThan(onePage - 2)
    expect(lone.width).toBeLessThan(onePage + 2)
    expect(Math.abs(lone.x + lone.width / 2 - (container.x + container.width / 2))).toBeLessThan(3)
    await expect(page.locator('section.binder-page ol').first()).toHaveAttribute('style', new RegExp(`repeat\\(${columns}`))
  }
})

test('dropping a placed copy on Not placed returns it, while a tray copy dropped there is a no-op', async ({ page }) => {
  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  const tray = page.getByRole('region', { name: 'Not placed' })
  const source = page.locator('[data-page="1"][data-slot="2"]')
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: transfer })
  await expect(page.locator('.binder-drag-ghost')).toBeVisible()
  await tray.dispatchEvent('dragover', { dataTransfer: transfer, bubbles: true })
  await expect(tray).toHaveClass(/binder-tray-drop/)
  await expect(tray).toContainText('Drop to return this copy to Not placed')
  await tray.dispatchEvent('drop', { dataTransfer: transfer })
  await expect(page.getByText('2 placed · 2 not placed · 18 slots')).toBeVisible()
  expect(fixture.writes.at(-1)).toMatchObject({ page: null, slot: null, placement_id: initial().placements[0].id })
  expect(fixture.writes).toHaveLength(1)
  await expect(page.locator('.binder-drag-ghost')).toHaveCount(0)
  await expect(tray).not.toHaveClass(/binder-tray-drop/)

  // The returned copy now lives in the tray; dragging it back is a no-op.
  const row = page.locator('[data-tray-row="71"]')
  await expect(row).toHaveAttribute('draggable', 'true')
  const transfer2 = await page.evaluateHandle(() => new DataTransfer())
  await row.dispatchEvent('dragstart', { dataTransfer: transfer2 })
  await tray.dispatchEvent('dragover', { dataTransfer: transfer2, bubbles: true })
  await tray.dispatchEvent('drop', { dataTransfer: transfer2 })
  expect(fixture.writes).toHaveLength(1)
  await expect(page.locator('.binder-drag-ghost')).toHaveCount(0)
})

test('the tray filter never receives the dragged card text', async ({ page, isMobile }) => {
  await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  if (isMobile) await page.getByRole('button', { name: /^Not placed/ }).click()
  const filter = page.getByLabel('Filter Not placed')
  await filter.fill('Pika')
  await page.evaluate(() => {
    window.__dropPrevented = null
    document.addEventListener('drop', event => { window.__dropPrevented = event.defaultPrevented }, { once: true })
  })
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await page.locator('[data-page="1"][data-slot="2"]').dispatchEvent('dragstart', { dataTransfer: transfer })
  await filter.dispatchEvent('dragover', { dataTransfer: transfer, bubbles: true })
  await filter.dispatchEvent('drop', { dataTransfer: transfer })
  await expect.poll(() => page.evaluate(() => window.__dropPrevented)).toBe(true)
  await expect(filter).toHaveValue('Pika')
  await expect(page.locator('.binder-tray-drop')).toHaveCount(0)
})

test('the held copy follows the drag with a tilt, dims its source and marks the drop target', async ({ page }) => {
  await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  const source = page.locator('[data-page="1"][data-slot="2"]')
  await source.dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) })
  const ghost = page.locator('.binder-drag-ghost')
  await expect(ghost).toBeVisible()
  await expect(ghost).toHaveCSS('pointer-events', 'none')
  await expect(page.locator('li.binder-pocket-dragging')).toHaveCount(1)
  // Dragging to the right of the source leans the held copy the other way.
  const target = page.locator('[data-page="1"][data-slot="3"]')
  const targetBox = await target.boundingBox()
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await target.dispatchEvent('dragover', { dataTransfer: transfer, clientX: targetBox.x + targetBox.width / 2, clientY: targetBox.y + targetBox.height / 2, bubbles: true })
  await expect(target.locator('..')).toHaveClass(/binder-pocket-highlight/)
  const transform = await ghost.evaluate(element => getComputedStyle(element).transform)
  const matrix = transform.match(/matrix\(([^)]*)\)/)?.[1].split(',').map(Number) ?? []
  expect(matrix[1]).toBeGreaterThan(0.001)
  await expect(ghost).not.toHaveCSS('left', '0px')
})

test('the held copy keeps a static lift under reduced motion', async ({ page }) => {
  await install(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  const source = page.locator('[data-page="1"][data-slot="2"]')
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: transfer })
  const target = page.locator('[data-page="1"][data-slot="3"]')
  const targetBox = await target.boundingBox()
  await target.dispatchEvent('dragover', { dataTransfer: transfer, clientX: targetBox.x + targetBox.width / 2, clientY: targetBox.y + targetBox.height / 2, bubbles: true })
  const ghost = page.locator('.binder-drag-ghost')
  await expect(ghost).toBeVisible()
  const style = await ghost.evaluate(element => ({ transform: getComputedStyle(element).transform, animationName: getComputedStyle(element).animationName }))
  const matrix = style.transform.match(/matrix\(([^)]*)\)/)?.[1].split(',').map(Number) ?? []
  expect(Math.abs(matrix[1])).toBeLessThan(0.001)
  expect(Math.abs(matrix[2])).toBeLessThan(0.001)
  expect(matrix[0]).toBeGreaterThan(1.01)
  expect(style.animationName).toBe('none')
})

test('an arranged copy is grabbed by the whole card, and a plain click still selects', async ({ page }) => {
  const fixture = await install(page)
  await page.goto('/binders/11')
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  const source = page.locator('[data-page="1"][data-slot="2"]')
  const target = page.locator('[data-page="1"][data-slot="1"]')
  await expect(source).toHaveAttribute('draggable', 'true')
  await expect(source).toHaveCSS('cursor', 'grab')
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: transfer })
  await target.dispatchEvent('dragover', { dataTransfer: transfer, bubbles: true })
  await target.dispatchEvent('drop', { dataTransfer: transfer })
  await expect(target).toHaveAttribute('data-placement', initial().placements[0].id)
  expect(fixture.writes).toHaveLength(1)

  // A click without movement is still a selection, not a drag.
  await page.locator('[data-page="1"][data-slot="5"]').click()
  await expect(page.getByRole('region', { name: 'Selected card actions' })).toBeVisible()

  // Browse mode offers no drag affordance at all.
  await page.getByRole('button', { name: 'Done arranging', exact: true }).click()
  await expect(page.locator('[data-page="1"][data-slot="5"]')).not.toHaveAttribute('draggable', 'true')
})
