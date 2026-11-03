# frontend/src/hooks/

Reusable React hooks that own non-visual, cross-cutting behavior for pages and
components: URL↔filter state, deck quantity persistence, list scroll
restoration, theming, debouncing, tilt animation, and shared TCGDex language
data. None of these render anything; each exposes state and/or handlers for a
consumer to wire into its own markup.

## Responsibility

This folder isolates reusable *behavior* from presentation. Its job is to keep
stateful logic (async persistence, URL sync, browser scroll/location handling,
localStorage, animation loops) out of page/component bodies and give it a single
owner with a stable API. Consumers import a hook, pass small config, and receive
the derived state + callbacks they need.

The hooks fall into a few families:

- **Debounce / data** — `useDebouncedValue`, `useVisibleTcgdexLanguages`
- **Persistence / server sync** — `useDeckQuantitySync`
- **URL state** — `useDynamicFilterUrlState`
- **Navigation / scroll** — `useListScrollRestoration` (module of helpers + hooks)
- **UI appearance / motion** — `useTheme`, `useTilt`

## Design

- **Hooks over components.** Each hook returns data + handlers; the consumer
  decides how to render. There are no hooks coupled to a specific component
  tree, which is why the same hooks serve multiple pages (e.g.
  `useDynamicFilterUrlState` backs Collection, Wishlist, Products, CardSearch,
  BinderDetail, and UserCollection).

- **Refs for mutable/imperative state, state for render state.** Hooks that
  manage async flows (`useDeckQuantitySync`) or animation (`useTilt`) keep their
  non-render bookkeeping in `useRef` (`desired`, `timers`, `inFlight`,
  `sequences`, `cur`, `tgt`) and only expose what the UI must react to
  (`optimisticQuantities`, `pendingEntryIds`) via `useState`.

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
  coordinates the global enable/release.

- **Edge-case hardening.** `sessionStorage` access is wrapped in try/catch for
  private-browsing contexts; `readSavedPosition` validates the parsed shape;
  scroll restore falls back to an anchor `scrollIntoView` when the viewport or
  results changed (`restoreListScrollPosition`). `useTilt` short-circuits on
  touch devices.

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
On the list, `saveScrollPosition(anchorId, listState)` persists
`{ scrollY, anchorId, pathname, search, locationKey, listState }` to
sessionStorage; `createDetailNavigationState(anchorId)` builds the
`location.state` (`fromList`, `returnPath`, `anchorId`, `detailHistoryDepth: 0`)
handed to the detail route. On return (`POP`), `useListScrollRestoration`
waits (via `requestAnimationFrame`) until the `[data-scroll-list="<key>"]`
surface is visible, then restores the offset/anchor and releases manual
restoration. On the detail side, `useDetailBackNavigation(listKey, fallbackPath)`
computes a negative `navigate(delta)` from `getDetailBackDelta` (or falls back
to `fallbackPath`), while `useReleaseManualHistoryScrollRestoration` and
`useScrollToTopOnPush` keep native vs. manual restoration and PUSH-scroll-to-top
behaviour consistent across routes.

**Theme.** `useTheme` seeds from `localStorage.getItem('theme')` (default
`'default'`), and an effect mirrors the value to `document.documentElement`'s
`data-theme` attribute (removing it for the default) and persists it to
`localStorage`. `setTheme` simply updates state.

## Integration

- **`../api/client`** — `useDeckQuantitySync` → `updateDeckEntry` (PATCH
  `/decks/:deckId/entries/:entryId`); `useVisibleTcgdexLanguages` →
  `getTcgdexFilterLanguages` (GET `/settings/tcgdex-filter-languages`).
- **`../utils/filterUrlState`** — pure serialization helpers used by
  `useDynamicFilterUrlState` (and its consumers for `clearFilterUrlState`,
  `hasFilterUrlState`, etc.).
- **`react-router-dom`** — `useDynamicFilterUrlState` uses `useSearchParams`;
  the scroll module uses `useLocation` / `useNavigate` / `useNavigationType` and
  relies on `BrowserRouter` (not a data router).
- **`@tanstack/react-query`** — `useVisibleTcgdexLanguages` (`useQuery`) and
  `useDeckQuantitySync` (reads/writes/invalidates the `['deck', …]` and
  `['decks']` caches) require a `QueryClient`/`QueryClientProvider` up the tree.
- **Consumers (examples):**
  - `useDynamicFilterUrlState` — `pages/Collection.jsx`, `Wishlist.jsx`,
    `Products.jsx`, `CardSearch.jsx`, `BinderDetail.jsx`, `UserCollection.jsx`,
    each with its own `*_FILTER_DEFINITIONS`.
  - `useListScrollRestoration` — `pages/Pokedex.jsx`, `Sets.jsx` (lists);
    `useDetailBackNavigation` / `useScrollToTopOnPush` — `PokedexSpecies.jsx`,
    `SetDetail.jsx`; `useReleaseManualHistoryScrollRestoration` —
    `components/Layout.jsx`.
  - `useDeckQuantitySync` — `pages/DeckEditor.jsx`, which maps
    `optimisticQuantities` over deck entries to render optimistic
    `required_quantity` and uses `pendingEntryIds` for per-entry busy state.
  - `useTheme` — `pages/Settings.jsx`.
  - `useDebouncedValue` — `components/card-lists/CardListPicker.jsx`,
    `pages/PublicWishlistView.jsx`, `pages/CardSearch.jsx`, `pages/Collection.jsx`.
  - `useVisibleTcgdexLanguages` — `pages/Collection.jsx`, `CardSearch.jsx`,
    `Sets.jsx`, `PokedexSpecies.jsx`.
  - `useTilt` — currently **no consumers** in the source tree (only its own
    definition references it), likely prepared for an upcoming card-tilt UI.

**Notes / constraints.**
- `useDeckQuantitySync` must receive a live TanStack `queryClient`; it does not
  fetch the deck itself, only patches and updates cache.
- The scroll module's singleton `activeHistoryRestoration` means only one
  list→detail flow should enable manual restoration at a time.
- `useTilt` returns inert no-op handlers on touch devices, so callers must still
  spread all four (`ref`, `onMouseMove`, `onMouseEnter`, `onMouseLeave`).
- `useVisibleTcgdexLanguages` returns an array augmented with `isLoading`
  rather than a plain object; consumers treat it as an array.
