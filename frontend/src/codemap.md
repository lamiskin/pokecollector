# frontend/src/

## Responsibility

This is the entire React 18 + Vite single-page app for PokéCollector — a Pokémon TCG
collection manager. It is the only client-side codebase: it renders the UI, owns the
router, the auth/settings state, i18n, and every HTTP call to the FastAPI backend
through the `api/` layer. It has no state persistence of its own beyond `localStorage`
for the auth token, the cached user, and display preferences; the backend is the source
of truth for all data.

Entry point: `main.jsx` → `App.jsx`.

## Design

- **SPA with code-split routes.** `App.jsx` lazy-loads every page (`lazy(() => import(...))`)
  wrapped in `lazyRoute()`, which provides a shared `Suspense` fallback (`PokeBallLoader`).
  This keeps the initial bundle to the app shell plus the context providers.
- **Provider nesting** (outermost first): `AuthProvider` → `SettingsProvider` →
  `ConfirmDialogProvider` → `BrowserRouter`. This order matters — `SettingsProvider`
  reads `useAuth()` and `ConfirmDialogProvider` reads `useSettings()`, so each sits
  inside the one it depends on.
- **Three route zones** at the top level of `App.jsx`:
  - `/login` — anonymous sign-in (`Login`).
  - `/u` (public) — anonymous share directory/profile/binder/wishlist/deck views,
    rendered through `PublicRoutes` (adds a `PublicHomeButton`), served by the
    no-auth `api/publicClient`.
  - `/*` (protected) — everything else, gated by `ProtectedRoutes`.
  - A dev-only `/__card-system` gallery (`CardSystemGallery`) when `import.meta.env.DEV`.
- **`ProtectedRoutes` is a gate, not a route table container only.** It consumes
  `useAuth()` and returns, in order: the `AuthStartupScreen` while `loading` (with
  offline retry), a redirect to `/login` when unauthenticated in multi-user mode, a
  bare loader while awaiting the single-user admin, a `ForcePasswordChangeScreen`
  when `user.must_change_password`, and finally the nested `<Routes>` under `Layout`.
- **`Layout`** renders `AppNav` (hidden on the home route) plus the `<Outlet/>` and
  is the mount point for scroll restoration (`useReleaseManualHistoryScrollRestoration`).
- **State lives in three contexts**, not a store library:
  - `AuthContext` — user, auth `loading`/`connectionError`, `multiUser`, `modeLocked`,
    and `loginUser`/`updateCurrentUser`/`logout`/`retryConnection`.
  - `SettingsContext` — backend settings, the `t()` translator, currency/exchange-rate
    machinery, and price-formatting helpers (`formatPrice`, `convertEurToDisplay`, …).
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
2. `App.jsx` nests the three providers and the router; the router mounts the matching
   top-level route (`/login`, `/u/…`, or the `/*` gate).
3. `AuthProvider` seeds `user` from `localStorage` (best-effort, pre-bootstrap), then runs
   `loadAuthState` (in `contexts/authBootstrap.js`): `getAuthMode()` (public) first to
   learn single vs multi-user, then `getMe()` (with `preserveSession`), reconciling the
   stored token against the server. Network/server failures put the app in `offline`
   with exponential backoff (`authRetryDelay`); an expired-token 401 is treated as a
   resolved multi-user sign-out, not a connectivity error. `retryConnection` re-runs
   bootstrap.
4. Once auth resolves, `SettingsProvider` (gated on `authLoading`) fetches `/api/settings/`,
   loads the matching translation chunk, and fetches exchange rates; until then it falls
   back to cached language/currency and defaults.
5. `ProtectedRoutes` then releases the gate: authenticated users see `Layout` + the
   nested route; unauthenticated multi-user visitors are redirected to `/login`.
6. Runtime data flows are one-directional: pages/components call named helpers from
   `api/client` (or `api/publicClient` for `/u` views), which attach the bearer token
   via the request interceptor and normalize/redirect on 401. Mutations invalidate
   TanStack Query caches via `utils/queryInvalidation`.

Logout clears `localStorage` and forces `window.location.href = '/login'` to purge all
in-memory caches (React Query, settings) between users.

## Integration

Frontend → backend only through `api/`; there is no direct `axios`/`fetch` in pages or
components (except `SettingsContext`'s settings/exchange-rate `fetch`, which predates
the client and talks to `/api/settings/`).

Child codemaps (read for per-folder detail; this atlas does not duplicate them):

- [`api/`](api/codemap.md) — the axios clients (`client.js` authenticated, `publicClient.js`
  anonymous) and one helper per backend domain.
- [`contexts/`](contexts/codemap.md) — `AuthContext` + `authBootstrap`, `SettingsContext`,
  `ConfirmDialogContext`.
- [`components/`](components/codemap.md) — shared/leaf components, `Layout`, `AppNav`,
  nav/scan UI; plus focused sub-maps: [`ui/`](components/ui/codemap.md),
  [`card-system/`](components/card-system/codemap.md), [`decks/`](components/decks/codemap.md),
  [`binders/`](components/binders/codemap.md), [`card-lists/`](components/card-lists/codemap.md),
  [`public/`](components/public/codemap.md).
- [`pages/`](pages/codemap.md) — one route component per page (Dashboard, Collection,
  Binders, Decks, Pokedex, Sets, Wishlist, Analytics, Products, Trades, Settings, …)
  plus the public profile/directory views.
- [`hooks/`](hooks/codemap.md) — shared hooks (debounce, theme, tilt, scroll restoration,
  URL-state sync, deck quantity sync, …).
- [`utils/`](utils/codemap.md) — pure helpers (prices/currency, card variants/lookup,
  URL state serialization, scan jobs, trade drafts, …) and their unit tests.
- `i18n/` — translation dictionaries (no codemap); loaded lazily by `SettingsContext`.
