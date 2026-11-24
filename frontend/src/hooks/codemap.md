# frontend/src/hooks/

Reusable React hooks that own non-visual, cross-cutting behavior for pages and
components: URL↔filter state, deck quantity persistence, list/page scroll
restoration, theming, debouncing, bulk-selection removal, scan photos, and
shared TCGDex language data. None of these render anything; each exposes state
and/or handlers for a consumer to wire into its own markup.

## Responsibility

This folder isolates reusable *behavior* from presentation. Its job is to keep
stateful logic (async persistence, URL sync, browser scroll/location handling,
localStorage) out of page/component bodies and give it a single owner with a
stable API. Consumers import a hook, pass small config, and receive the derived
state + callbacks they need.

The hooks fall into a few families:

- **Debounce / data** — `useDebouncedValue`, `useVisibleTcgdexLanguages`,
  `useScanCatalogue` (language-specific catalogue finish evidence for scanner adds),
  `useScanItemPhoto` (authenticated blob → object URL for a queued scan item)
- **Persistence / server sync** — `useDeckQuantitySync`
- **URL state** — `useDynamicFilterUrlState`
- **Selection** — `useBulkRemoval` (selection, confirmation and cache invalidation
  shared by collection, binder and deck views)
- **Navigation / scroll** — `useListScrollRestoration` (module of helpers + hooks,
  including `usePageScrollReset`)
- **UI appearance** — `useTheme`

## Design

- **Hooks over components.** Each hook returns data + handlers; the consumer
  decides how to render. There are no hooks coupled to a specific component
  tree, which is why the same hooks serve multiple pages (e.g.
  `useDynamicFilterUrlState` backs Collection, Wishlist, Products, CardSearch,
  BinderDetail, and UserCollection).

- **Refs for mutable/imperative state, state for render state.** Hooks that
  manage async flows (`useDeckQuantitySync`, `useBulkRemoval`) keep their
  non-render bookkeeping in refs (`desired`, `timers`, `inFlight`, `sequences`)
  and only expose what the UI must react to (`optimisticQuantities`,
  `pendingEntryIds`, the derived selection) via `useState`.

- **Live refs for config.** `useDynamicFilterUrlState` mirrors its
  `definitions` / `normalizeState` / `resetParams` props into refs
  (`definitionsRef`, etc.) updated on every render, so the memoized callbacks
  stay stable while always reading fresh config.

- **Optimistic updates + debounce + stale-response guarding.** Deck quantity
  changes are applied locally first, debounced (150 ms) to a single PATCH per
  entry, and a `latestDesired === quantity` check discards stale responses when
  the user kept tapping. Failures invalidate the query cache so the server state
  wins back.

- **URL as source of truth for filters.** `useDynamicFilterUrlState` reads and
  writes `URLSearchParams` through pure helpers in
  `../utils/filterUrlState` (`readFilterUrlState` / `writeFilterUrlState` /
  `cloneFilterState`). An `ownUrlKeyRef` guard prevents the write→read feedback
  loop from re-triggering state changes on the hook's own writes.

- **Manual history scroll restoration.** The app uses `BrowserRouter`, which
  has no data-router `<ScrollRestoration/>`. `useListScrollRestoration`
  re-implements it by saving positions to `sessionStorage`, watching for `POP`
  navigation, and toggling `window.history.scrollRestoration = 'manual'` during
  the detail→list transition so the saved list offset is not applied to the
  still-mounted detail DOM. A module-level `activeHistoryRestoration` singleton
  coordinates the global enable/release. `usePageScrollReset` (called from
  `App.jsx`'s `PageScrollBoundary`) covers the other half: a new pathname on
  PUSH/REPLACE starts at the top, while query-only changes, hashes and POP are
  left to the page or the list restoration.

- **Edge-case hardening.** `sessionStorage` access is wrapped in try/catch for
  private-browsing contexts; `readSavedPosition` validates the parsed shape;
  scroll restore falls back to an anchor `scrollIntoView` when the viewport or
  results changed (`restoreListScrollPosition`). `useBulkRemoval` keys its
  selection by an explicit `scopeKey`, resets it when the scope changes, prunes
  ids that are no longer visible, and caps a selection at 500 entries.

## Flow

**Debounced data (read path).**
`useDebouncedValue(value, delay)` holds the latest `value` in a `useState`
seeded with the initial value, and a `useEffect` schedules a `setTimeout` to
commit it after `delay`, clearing the timer on cleanup. Consumers feed the
returned, lagged value into a TanStack Query `useQuery` key so text queries
don't fire on every keystroke.

**Shared language list (read path).**
`useVisibleTcgdexLanguages()` issues `useQuery(['tcgdex-filter-languages'])`
against `getTcgdexFilterLanguages()` and returns an array-like object
(`Object.assign([...languages], { isLoading })`) so consumers can `.map()` it
while still reading `isLoading`. Consumers (`Collection`, `CardSearch`, `Sets`,
`PokedexSpecies`) extract language `code`s from entries.

**Scanner catalogue evidence (read path).**
`useScanCatalogue(cardId, lang)` resolves a language-suffixed card identity and
fetches canonical detail through `getCard`. Both `ScanAddModal` and `ScanQueue`'s
express add use it; scanner-provided finish flags/prices are never inputs.
Stale card/language responses are ignored, and explicitly foreign-source flags
and prices are excluded independently. Unknown/error evidence remains an
editable Normal fallback; acceptance waits for the initial lookup.

**Deck quantity (write path).**
`changeQuantity(entryId, renderedQuantity, delta)` clamps the next value to
1–99, records it in `desired` (a `Map`), sets the optimistic quantity, and
schedules `synchronize(entryId)` after 150 ms. `synchronize` skips if that entry
is already in flight, PATCHes via `updateDeckEntry`, then on success writes the
response into the `['deck', String(deckId)]` query cache and invalidates
`['decks']`; on failure it clears the optimistic value and invalidates both
queries to refetch server truth. `finally` removes in-flight state and
re-schedules immediately if the user changed the value during the request.
`timers` are cleared on unmount.

**Filters ↔ URL (bidirectional).**
State is initialized lazily from the current search params via `readState`.
External URL changes (back/forward, links) flow into state through an effect
that diffs serialized state. Local changes go through `replaceFilters`, which
normalizes, updates state, writes params via `writeFilterUrlState`, deletes
`resetParams`, and (only when the URL actually changed) calls
`setSearchParams(..., { replace: true })`, marking the write with
`ownUrlKeyRef` so the echo is ignored. `updateFilter(key, value)` and
`clearFilters` are thin wrappers over `replaceFilters`.

**Scroll restoration (navigation path).**
On the list, the hook's `saveScrollPosition(anchorId, listState)` persists
`{ scrollY, anchorId, pathname, search, locationKey, listState }` to
sessionStorage; its `createDetailNavigationState(anchorId)` builds the
`location.state` (`fromList`, `returnPath`, `anchorId`, `detailHistoryDepth: 0`)
handed to the detail route. On return (`POP`), `useListScrollRestoration`
waits (via `requestAnimationFrame`) until the `[data-scroll-list="<key>"]`
surface is visible, then restores the offset/anchor and releases manual
restoration. On the detail side, `useDetailBackNavigation(listKey, fallbackPath)`
computes a negative `navigate(delta)` from `getDetailBackDelta` (or falls back
to `fallbackPath`), while `useReleaseManualHistoryScrollRestoration` keeps native
vs. manual restoration consistent across routes. `usePageScrollReset` resets a
new PUSH/REPLACE pathname to the top; it deliberately does not run for POP,
query-only changes or hashes.

**Bulk removal (write path).**
`useBulkRemoval({ items, kind, scopeKey, remove, t, blocked })` owns the
selection set, select-all/clear, and the confirm-then-remove loop. It calls the
caller's `remove` for the selected entries, then invalidates the shared card
state, collection-photo state and TCGDex-language queries so tiles, binder
pages and product links re-fetch. `BulkRemovalToolbar` renders its
`BulkRemovalToggle`/`BulkRemovalActions` in Collection, BinderDetail and
DeckEditor.

**Scan photo (read path).**
`useScanItemPhoto(jobId, item)` fetches the authenticated scan image as a blob
and exposes an object URL, revoking it on cleanup. Because the fetch is
re-done, the photo survives a reload where a local `blob:` URL would not.

**Theme.** `useTheme` seeds from `localStorage.getItem('theme')` (default
`'default'`), and an effect mirrors the value to `document.documentElement`'s
`data-theme` attribute (removing it for the default) and persists it to
`localStorage`. `setTheme` simply updates state.

## Integration

- **`../api/client`** — `useDeckQuantitySync` → `updateDeckEntry` (PATCH
  `/decks/:deckId/entries/:entryId`); `useVisibleTcgdexLanguages` →
  `getTcgdexFilterLanguages` (GET `/settings/tcgdex-filter-languages`);
  `useBulkRemoval` → `releaseCollectionAssignments`, `unlinkProductCard`,
  `bulkUnlinkProductCards`; `useScanItemPhoto` → `fetchScanJobItemImage`.
- **`../utils/filterUrlState`** — pure serialization helpers used by
  `useDynamicFilterUrlState` (and its consumers for `clearFilterUrlState`,
  `hasFilterUrlState`, etc.).
- **`../utils/queryInvalidation`** — `useBulkRemoval` invalidates the shared
  card/photo/language query families after a removal.
- **`react-router-dom`** — `useDynamicFilterUrlState` uses `useSearchParams`;
  the scroll module uses `useLocation` / `useNavigate` / `useNavigationType` and
  relies on `BrowserRouter` (not a data router); `usePageScrollReset` also uses
  `useLayoutEffect` and must run inside the router.
- **`@tanstack/react-query`** — `useVisibleTcgdexLanguages` (`useQuery`) and
  `useDeckQuantitySync` (reads/writes/invalidates the `['deck', …]` and
  `['decks']` caches) require a `QueryClient`/`QueryClientProvider` up the tree.
- **Consumers (examples):**
  - `useDynamicFilterUrlState` — `pages/Collection.jsx`, `Wishlist.jsx`,
    `Products.jsx`, `CardSearch.jsx`, `BinderDetail.jsx`, `UserCollection.jsx`,
    each with its own `*_FILTER_DEFINITIONS`.
  - `useListScrollRestoration` — `pages/Pokedex.jsx`, `Sets.jsx`,
    `PokedexSpecies.jsx`, `SetDetail.jsx`, `Collection.jsx` (lists);
    `useDetailBackNavigation` — `PokedexSpecies.jsx`, `SetDetail.jsx`;
    `useReleaseManualHistoryScrollRestoration` — `components/Layout.jsx`;
    `usePageScrollReset` — `App.jsx`'s `PageScrollBoundary`.
  - `useDeckQuantitySync` — `pages/DeckEditor.jsx`, which maps
    `optimisticQuantities` over deck entries to render optimistic
    `required_quantity` and uses `pendingEntryIds` for per-entry busy state.
  - `useBulkRemoval` — `pages/Collection.jsx`, `BinderDetail.jsx`, `DeckEditor.jsx`.
  - `useScanItemPhoto` — `components/ScanReview.jsx`, `ScanCustomCardModal.jsx`,
    `pages/ScanQueue.jsx`.
  - `useTheme` — `pages/Settings.jsx`.
  - `useDebouncedValue` — `components/card-lists/CardListPicker.jsx`,
    `pages/Artists.jsx`, `PublicWishlistView.jsx`, `CardSearch.jsx`,
    `Collection.jsx`.
  - `useVisibleTcgdexLanguages` — `pages/Collection.jsx`, `CardSearch.jsx`,
    `Sets.jsx`, `PokedexSpecies.jsx`.

**Notes / constraints.**
- `useDeckQuantitySync` must receive a live TanStack `queryClient`; it does not
  fetch the deck itself, only patches and updates cache.
- The scroll module's singleton `activeHistoryRestoration` means only one
  list→detail flow should enable manual restoration at a time.
- `useBulkRemoval` mutates through the caller-supplied `remove` function, so each
  view keeps its own API call and confirmation copy; pass a stable `scopeKey`.
- `useVisibleTcgdexLanguages` returns an array augmented with `isLoading`
  rather than a plain object; consumers treat it as an array.
