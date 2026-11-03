# frontend/src/pages/

## Responsibility

This folder is the route layer of the React app. Every `lazy()` import and every
`<Route>` in `App.jsx` resolves to a top-level component here — one file per URL,
one default export per page. The folder owns:

- **Route/page composition** — each page is a thin container that mounts a
  feature's data-fetching, then delegates rendering to the shared UI in
  `components/`. Pages rarely own presentational logic beyond their specific
  layout shell.
- **The public/private boundary at the page level.** Anonymous read-only pages
  (`Login`, and the `/u/*` share pages) live side-by-side with the authenticated
  app pages, but they are wired to a *different HTTP client* and a *different
  data-fetching pattern* (see Design).
- **Data fetching for reads** — every list/detail view pulls its data via
  `@tanstack/react-query` (`useQuery`) or, on the public pages, via a plain
  `useEffect` + `useState` fetch. Pages do **not** call `axios`/`fetch` directly;
  they import named helpers from `../api/client` (authenticated) or
  `../api/publicClient` (anonymous).
- **Mutations and cache invalidation** — writes go through `useMutation` and
  `queryClient.invalidateQueries(...)`, plus the shared `utils/queryInvalidation`
  helpers (`invalidateCardState`, `invalidateTcgdexFilterLanguages`).

Routing itself lives in `App.jsx` (not this folder); these files are the *targets*
of that routing table.

## Design

- **Lazy, code-split pages.** `App.jsx` wraps every page in `React.lazy(() => import('./pages/…'))`
  and renders each through `lazyRoute()` inside a `<Suspense>` whose fallback is
  the `PokeBallLoader` spinner (`RouteLoader`). This keeps the initial bundle small;
  each feature ships as its own chunk.
- **Two fetch paradigms, split exactly along the auth boundary.**
  - **Authenticated pages** use React Query: declarative `queryKey`s, `refetchInterval`
    polling, `placeholderData`, and a `useQueryClient` for invalidation after
    mutations. Examples of the convention: `queryKey: ['dashboard', priceField]`,
    `queryKey: ['sets', settings.language]`, `queryKey: ['wishlist']`.
  - **Public pages** (`PublicDirectory`, `PublicProfile`, `PublicBinderView`,
    `PublicWishlistView`, `PublicDeckView`) deliberately **do not use React Query**.
    They fetch once with `getPublic*` in a `useEffect` guarded by a `cancelled`
    flag, and hold results in `useState`. This keeps anonymous traffic on the
    interceptor-free `publicClient` and outside the authenticated query cache.
- **Context is the shared "props" bus.** Pages read app-wide state through
  `useSettings()` (translations `t`, `formatPrice`, `settings`, `pricePrimaryField`,
  `language`, `currency`), `useAuth()` (`user`, `loading`, `multiUser`), and
  `useConfirmDialog()`. They never receive these as props — the providers wrap the
  router in `App.jsx`.
- **URL state is part of the page contract.** List pages sync filters, sorting,
  and selection to the address bar via `useDynamicFilterUrlState` (Collection,
  Wishlist, BinderDetail, Products) or explicit `useSearchParams` handling (Sets,
  Pokedex, DeckCompare). This makes every filtered view shareable and
  back/forward-friendly.
- **Deep-link target resolution.** Collection and other list pages read `itemId` /
  `cardId` query params and auto-open the matching item modal, so a shared card
  link lands on the right editor.
- **Domain helpers, not page-local logic.** Sorting, price math, image URLs,
  deck progress, binder counts, and scan-job state are pulled from `utils/` and
  `hooks/` (`useDebouncedValue`, `useListScrollRestoration`,
  `useVisibleTcgdexLanguages`, `useDeckQuantitySync`) rather than reimplemented in
  each page.

## Flow

**Authentication gate (in `App.jsx`, wrapping every page here).**

1. `App` mounts `AuthProvider → SettingsProvider → ConfirmDialogProvider → BrowserRouter`.
2. `/login` and `/u/*` render unconditionally (public). Everything else falls
   through `/*` into `ProtectedRoutes`.
3. `ProtectedRoutes` calls `useAuth()`:
   - `loading` → `AuthStartupScreen` (bootstrap/reconnect).
   - `!user && multiUser` → `<Navigate to="/login" replace />`.
   - `!user` (single-user mode) → spinner while the implicit session resolves.
   - `user.must_change_password` → `ForcePasswordChangeScreen` (a form that calls
     `forceChangePassword`, then clears the flag via `updateCurrentUser`).
   - otherwise → the `<Routes>` inside `<Layout>`.

**Per-page data flow (authenticated).**

1. Page reads route params/query state (`useParams`, `useSearchParams`, or
   `useDynamicFilterUrlState`).
2. A `useQuery` calls a `get*` helper from `api/client`; the request interceptor
   attaches the bearer token. Polling pages (Dashboard, Collection, HomeScreen)
   set `refetchInterval`.
3. Result state renders through shared components (`CardListGallery`,
   `CollectionCardDisplay`, `TrainerCard`, deck/binder panels, `CardModal`).
4. User actions run `useMutation` helpers; `onSuccess` invalidates the affected
   `queryKey`(s) so reads refresh. Cross-cutting helpers
   (`invalidateCardState`, `invalidateTcgdexFilterLanguages`) keep card/language
   state consistent across Collection, Wishlist, Binders, Decks, Products.

**Per-page data flow (public).**

1. Page reads `handle` (and `binderId`/`deckId`) from `useParams`.
2. `useEffect` fires `getPublicProfile(handle)` (and, on detail pages,
   `Promise.all` with `getPublicBinder`/`getPublicDeck`) through `publicClient`,
   storing the result in `useState` with a `cancelled` guard and an `error` flag.
3. `PublicProfileShell` renders the shared profile chrome; the page fills in
   binders/decks/wishlist/deck-cards via `CardStack`, `CardListGallery`, and the
   deck analytics panels. `PublicWishlistView` additionally drives a server-side
   paginated query (`search`/`set_id`/`rarity`/`sort`/`order`/`page`) with a
   debounced search input.

## Integration

**Public / private route split** (from `App.jsx`):

| Route | Page | Client | Gate |
|---|---|---|---|
| `/login` | `Login` | `client.login` | public (redirects away if authed/single-user) |
| `/u` (index) | `PublicDirectory` | `getPublicProfiles` | public |
| `/u/:handle` | `PublicProfile` | `getPublicProfile` | public |
| `/u/:handle/decks` | `PublicProfile` | `getPublicProfile` | public (deck tab) |
| `/u/:handle/binder/:binderId` | `PublicBinderView` | `getPublicProfile` + `getPublicBinder` | public |
| `/u/:handle/wishlist` | `PublicWishlistView` | `getPublicProfile` + `getPublicWishlist` | public |
| `/u/:handle/deck/:deckId` | `PublicDeckView` | `getPublicProfile` + `getPublicDeck` + `getPublicDeckProbability` | public |
| `/*` (everything else) | `ProtectedRoutes` → `<Layout>` | authenticated `client` | auth + password-change gate |

**Authenticated route → page → API map:**

| Route | Page | Primary API helpers (`api/client`) |
|---|---|---|
| `/` | `HomeScreen` | `getDashboard`, `getInvestmentTracker`, `triggerPriceSync`, `getSyncStatus`, `getScanJobs` |
| `/dashboard` | `Dashboard` | `getDashboard`, `getInvestmentTracker` |
| `/search` | `CardSearch` | `searchCards`, `getSets`, `getCustomCards`, `bulkAddToCollection`, `getScanJobs` |
| `/collection` | `Collection` | `getCollection`, `getWishlist`, `getSets`, `getBinders`, add/update/remove/import + photo upload/delete + `exportCSV`/`exportPDF` |
| `/pokedex`, `/pokedex/:dexId` | `Pokedex`, `PokedexSpecies` | `getPokedex`, `getPokedexSpecies`, `searchCards` |
| `/collection/user/:userId` | `UserCollection` | `getUserCollection` |
| `/sets`, `/sets/:setId` | `Sets`, `SetDetail` | `getSets`, `markSetsSeen`; `getSetChecklist`, `getBinders`, `addOwnedSetToBinder`, `addOwnedSetToAutoBinder` |
| `/wishlist` | `Wishlist` | `getWishlist`, `removeFromWishlist`, `updateWishlistItem` |
| `/binders`, `/binders/:binderId` | `Binders`, `BinderDetail` | `getBinders`/CRUD; `getBinderCards`, entry add/remove/update, print optimization, wishlist conversion, CSV import/export |
| `/decks` → `/binders` (redirect) | `Binders` | (legacy deck routes remap to binders) |
| `/decks/compare` | `DeckCompare` | `compareDecks`, `getDecks` |
| `/decks/:deckId`, `/decks/:deckId/build` | `DeckEditor` (+ `LegacyDeckBuildRedirect`) | `getDeck`, `updateDeck`, `addDeckEntry`, `deleteDeckEntry`, convert planned↔real, duplicate, `getCollection` |
| `/analytics` | `Analytics` | `getDuplicates`, `getTopMovers`, `getRarityStats`, `getInvestmentTracker`, `getTradeStats`, `getAnalyticsNewSets`, `getProducts`, `createProduct` |
| `/products` | `Products` | `getProducts`, `getProductsSummary`, create/update/delete, `bulkUpdateProductLifecycle`, `linkProductCards`/`unlinkProductCard`, `sellProductCard`, `addProductLedgerEntry`, `getCollection` |
| `/trades` | `Trades` | `getTrades`, `getTrade`, `createTrade`, `updateTrade`, `searchCards`, `getCollection`, `getCustomCards`, `cloneCustomCard` |
| `/leaderboard`, `/leaderboard/compare/:userId` | `Leaderboard`, `Compare` | `getLeaderboard`; `compareUsers` |
| `/achievements`, `/achievements/:userId` | `Achievements` | `getAchievements` |
| `/settings` | `Settings` | `getSetting`/`setSetting`/`saveSettings`, `getUsers`/`createUser`/`updateUser`/`deleteUser`, `changePassword`/`changeAvatar`/`changeUsername`, `getProfile`/`updateProfile`, sync controls, backup/restore, `exportCSV`, `getSupporters`/`getContributors`, `downloadDebugLog` (also imports raw `api` for interceptor-sensitive calls) |
| `/migration` | `CardMigration` | `getCustomMatches`, `migrateCustomCard`, `dismissCustomMatch` |
| `/scans`, `/scans/:jobId` | `ScanQueue` | `getScanJobs`, `getScanJob`, `resolveScanJobItem`, `resolveAndAddScanJobItem`, `retryScanJobItem`, `deleteScanJob`, image blob fetch |

**Cross-cutting integration points:**

- **`components/Layout`** wraps every authenticated route and owns the app nav /
  tab chrome; pages render into its `<Outlet>`.
- **`components/public/PublicProfileShell`** wraps every public share page and owns
  the shared profile header, so the five public pages only supply the section body.
- **`components/CardItem`** (`CardModal`, `CustomCardModal`) and
  **`components/card-system`** (`CardDisplay`, `CardStack`, `CardLegend`,
  `withCollectionItemState`) are the shared card-rendering primitives nearly every
  page uses.
- **`components/card-lists/CardListGallery`** and `CardListPicker` render card grids
  for both private pages and the `mode="public"` share views.
- **`utils/queryInvalidation`** provides the shared cache keys so a mutation in one
  page (e.g. editing a collection item) refreshes dependent views in another.
- **`utils/scanJobs`** centralizes the scan-queue query key and polling helpers so
  `HomeScreen`, `CardSearch`, and `ScanQueue` agree on the same job state.
