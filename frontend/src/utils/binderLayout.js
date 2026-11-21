export function binderMessage(t, key, values = {}) {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t(`binderLayout.${key}`))
}

export function visibleBinderPages(page, pageCount, spread, firstPageSingle = false) {
  const bounded = Math.max(1, Math.min(pageCount, Math.trunc(Number(page)) || 1))
  if (!spread) return [bounded]
  // A binder can open like a book: page 1 stands alone as the cover, then every
  // spread starts on an even page (2|3, 4|5…). Without that, spreads pair an odd
  // page with the next even one (1|2, 3|4…). Neither rule manufactures a page.
  if (firstPageSingle && bounded === 1) return [1]
  const start = firstPageSingle
    ? 2 + Math.floor((bounded - 2) / 2) * 2
    : (bounded % 2 ? bounded : bounded - 1)
  return start < pageCount ? [start, start + 1] : [start]
}

export function binderLocationHref(location, handle) {
  const query = new URLSearchParams({ view: 'pages', card: location.card_id, member: String(location.binder_card_id) })
  if (location.placement_id) query.set('placement', location.placement_id)
  else query.set('tray', '1')
  if (location.page) query.set('page', String(location.page))
  if (location.slot) query.set('slot', String(location.slot))
  return `${handle ? `/u/${encodeURIComponent(handle)}/binder` : '/binders'}/${location.binder_id}?${query}`
}

// Coordinates are hints, never identity: a stale link must not select a new occupant.
export function resolveBinderTarget(snapshot, params) {
  const card = params.get('card')
  const member = params.get('member')
  const id = params.get('placement')
  if (!card && !member && !id) return null
  const exactMatches = entry => (!card || entry.card_id === card) && (!member || String(entry.binder_card_id) === member)
  const memberExists = (snapshot.entries || []).some(exactMatches)
  const matches = entry => (!card || entry.card_id === card) && (!member || !memberExists || String(entry.binder_card_id) === member)
  const entry = (snapshot.entries || []).find(matches)
  if (!entry) return { kind: 'missing' }
  const exact = (snapshot.placements || []).find(p => p.id === id && exactMatches(p))
  if (exact) return { kind: 'slot', placement: exact, moved: Boolean(params.get('page') && (Number(params.get('page')) !== exact.page || Number(params.get('slot')) !== exact.slot)) }
  if (entry.unplaced_quantity > 0) return { kind: 'tray', entry, moved: Boolean(id || !memberExists) }
  const fallback = (snapshot.placements || []).filter(matches)
  // Identical copies are interchangeable, but don't pretend to identify a removed copy.
  if (fallback.length === 1) return { kind: 'slot', placement: fallback[0], moved: true }
  return { kind: fallback.length ? 'choices' : 'missing', entry, placements: fallback }
}
