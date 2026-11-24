# frontend/src/

## Responsibility

This is the entire React 18 + Vite single-page app for PokéCollector — a Pokémon TCG
collection manager. It is the only client-side codebase: it renders the UI, owns the
router, the auth/settings state, i18n, and every HTTP call to the FastAPI backend
through the `api/` layer. It keeps only client-side caches: `localStorage` for the
auth token, cached user, auth bootstrap snapshot, display preferences and a
small per-user settings cache; IndexedDB (behind `offline/`) for the optional
read cache and the offline outbox. The backend remains the source of truth for
all data.

Entry point: `main.jsx` → `App.jsx`.

## Design

- **SPA with code-split routes.** `App.jsx` lazy-loads every page (`lazy(() => import(...))`)
  wrapped in `lazyRoute()`, which provides a shared `Suspense` fallback (`PokeBallLoader`).
  This keeps the initial bundle to the app shell plus the context providers.
- **Provider nesting** (outermost first): `AuthProvider` → `SettingsProvider` →
  `OfflineProvider` → `ConfirmDialogProvider` → `BrowserRouter`. This order
  matters — `SettingsProvider` reads `useAuth()` and the offline layer needs
  both the user and settings; `ConfirmDialogProvider` reads `useSettings()`, so
  each sits inside the one it depends on. `HoloDeviceMotionController` mounts
  among the providers; `UpdateBanner` sits beside the router, outside its route
  content.
- **Route zones** at the top level of `App.jsx`:
  - `/login` and `/auth/oidc/complete` — anonymous sign-in and the cookie-bound
    OIDC handoff (`Login`, `OidcComplete`).
  - `/u` (public) — anonymous share directory/profile/binder/wishlist/deck views,
    rendered through `PublicRoutes` (adds a `PublicHomeButton`), served by the
    no-auth `api/publicClient`.
  - `/*` (protected) — everything else, gated by `ProtectedRoutes`.
  - A dev-only `/__card-system` gallery (`CardSystemGallery`) when `import.meta.env.DEV`.
  - `/offline` is the protected sync center inside `Layout`.
- **PWA + offline shell.** `main.jsx` registers the opt-in service worker
  (`pwa/register.js`) and `UpdateBanner` offers a waiting update. `offline/`
  provides `OfflineProvider` (outbox, reachability probe, read-cache restore,
  logout guard), `useOffline()`/`useOutbox()` consumers, and `AutomaticCollectionProvider`
  for the downloaded collection. When the server is unreachable, `Layout` swaps
  pages that are not on the offline allow-list (`offline/routes.js`) for
  `OfflineUnavailable`, and shows `OfflineBanner`/`StaleDataLabel` instead.
- **`ProtectedRoutes` is a gate, not a route table container only.** It consumes
  `useAuth()` and returns, in order: the `AuthStartupScreen` while `loading` (with
  offline retry), a redirect to `/login` when unauthenticated in multi-user mode, a
  bare loader while awaiting the single-user admin, a `ForcePasswordChangeScreen`
  when `user.must_change_password`, and finally the nested `<Routes>` under `Layout`.
- **`Layout`** renders `AppNav` (hidden on the home route), the offline/stale
  strips, and the `<Outlet/>`. Each lazy route is wrapped in `lazyRoute()` →
  `PageScrollBoundary`, which calls `usePageScrollReset()` from
  `hooks/useListScrollRestoration` (a new PUSH/REPLACE starts at the top; POP
  stays with list restoration).
- **State lives in four providers**, not a store library:
  - `AuthContext` — user, auth `loading`/`offline`/`degraded` status,
    `multiUser`, `modeLocked`, OIDC capabilities, and
    `loginUser`/`updateCurrentUser`/`logout`/`setLogoutGuard`/`retryConnection`.
  - `SettingsContext` — backend settings, the `t()` translator, currency/exchange-rate
    machinery, price-formatting helpers (`formatPrice`, `convertEurToDisplay`, …),
    and the offline settings cache + pending download preference.
  - `OfflineProvider` — the outbox, reachability state, cached auth/settings
    restoration and the logout guard; consumed via `useOutbox`/`useOffline`.
  - `ConfirmDialogContext` — a promise-based `confirm()` that drives the single
    `ConfirmDialog` modal (resolve via a ref).
- **Server state** is handled by TanStack Query (`QueryClient` in `main.jsx`, with
  `retry: 1`, `staleTime: 30s`, no `refetchOnWindowFocus`); `main.jsx` also applies the
  saved `data-theme` before first paint and mounts the `react-hot-toast` `Toaster`.
- **i18n** is a lazy-loaded dictionary map (`SettingsContext.TRANSLATION_LOADERS` →
  `i18n/*.js`), keyed by dot-path lookups with English fallback; language/currency are
  cached in `localStorage` for first paint but the backend remains authoritative.

## Flow

Startup (bootstrap) is the most consequential flow here:

1. `main.jsx` applies the saved theme, creates the `QueryClient`, and renders `<App/>`.
2. `App.jsx` nests the providers and the router; the router mounts the matching
   top-level route (`/login`, `/auth/oidc/complete`, `/u/…`, or the `/*` gate).
3. `AuthProvider` seeds `user` from `localStorage` (best-effort, pre-bootstrap), then runs
   `loadAuthState` (in `contexts/authBootstrap.js`): `getAuthMode()` (public) first to
   learn single vs multi-user and the OIDC capabilities, then `getMe()` (with
   `preserveSession`). Both startup calls use a 5 s timeout because iOS leaves
   requests pending offline. Network/server failures put the app in `offline`
   with exponential backoff (`authRetryDelay`); with the offline queue enabled a
   cached auth snapshot (`offline/authSnapshot`) opens a display-only `degraded`
   state instead. An expired-token 401 is treated as a resolved multi-user
   sign-out, not a connectivity error. `retryConnection` re-runs bootstrap.
4. Once auth resolves, `SettingsProvider` (gated on `authLoading`) fetches `/api/settings/`,
   loads the matching translation chunk, and fetches exchange rates; until then it falls
   back to cached language/currency and defaults.
5. `ProtectedRoutes` then releases the gate: authenticated users see `Layout` + the
   nested route; unauthenticated multi-user visitors are redirected to `/login`.
6. Runtime data flows are one-directional: pages/components call named helpers from
   `api/client` (or `api/publicClient` for `/u` views), which attach the bearer token
   via the request interceptor and normalize/redirect on 401. Mutations invalidate
   TanStack Query caches via `utils/queryInvalidation`.

Logout awaits the offline logout guard, clears `localStorage` (token, user, auth
snapshot), the settings cache and then forces `window.location.href = '/login'`
to purge all in-memory caches (React Query, settings) between users.

## Integration

Frontend → backend only through `api/`; there is no direct `axios`/`fetch` in pages or
components (except `SettingsContext`'s settings/exchange-rate `fetch`, which predates
the client and talks to `/api/settings/`).

Child codemaps (read for per-folder detail; this atlas does not duplicate them):

- [`api/`](api/codemap.md) — the axios clients (`client.js` authenticated, `publicClient.js`
  anonymous) and one helper per backend domain.
- [`contexts/`](contexts/codemap.md) — `AuthContext` + `authBootstrap`, `SettingsContext`,
  `ConfirmDialogContext`, plus the offline/settings caches they use.
- [`components/`](components/codemap.md) — shared/leaf components, `Layout`, `AppNav`,
  windowed card grids, offline/sync/PWA chrome and scan UI; plus focused sub-maps:
  [`ui/`](components/ui/codemap.md), [`card-system/`](components/card-system/codemap.md),
  [`decks/`](components/decks/codemap.md), [`binders/`](components/binders/codemap.md),
  [`card-lists/`](components/card-lists/codemap.md), [`public/`](components/public/codemap.md).
- [`pages/`](pages/codemap.md) — one route component per page (Dashboard, Collection,
  Binders, Decks, Pokedex, Sets, Wishlist, Analytics, Products, Trades, Settings,
  OfflineCenter, …) plus the public profile/directory views.
- [`hooks/`](hooks/codemap.md) — shared hooks (debounce, theme, page/list scroll
  restoration, bulk removal, scan photos, URL-state sync, deck quantity sync, …).
- [`utils/`](utils/codemap.md) — pure helpers (prices/currency, card variants/lookup,
  URL state serialization, scan jobs, trade drafts, PWA support helpers …) and their unit tests.
- `offline/` — IndexedDB outbox, replay/probe, read/settings/auth caches,
  automatic collection download (no codemap; see `docs/PWA_OFFLINE_DESIGN.md`).
- `pwa/` — service-worker registration/update store, flags and Web Push helpers
  (no codemap).
- `sw/` — service-worker and kill-worker sources, inlined by `frontend/scripts/build-sw.mjs`.
- `i18n/` — translation dictionaries (no codemap); loaded lazily by `SettingsContext`.
