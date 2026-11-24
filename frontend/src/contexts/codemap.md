# frontend/src/contexts/

## Responsibility

This folder holds the app's **global client-side state** exposed through React
Context, and the pure helpers that back it. It is the single place where
cross-cutting state is owned and made available to every page/component, so that
features (collection, binders, trades, settings, scanner, …) never read global
state from `localStorage` or duplicate bootstrap logic themselves.

Three providers (plus their hooks) and one non-React helper module:

| File | Exports | Owns |
|------|---------|------|
| `AuthContext.jsx` | `AuthProvider`, `useAuth`, default context | Session identity, authentication mode/status and the logout guard |
| `SettingsContext.jsx` | `SettingsProvider`, `useSettings`, default context | User settings, display language, currency + exchange rate, offline settings cache |
| `ConfirmDialogContext.jsx` | `ConfirmDialogProvider`, `useConfirmDialog`, default context | The imperative confirm/cancel modal request |
| `authBootstrap.js` | `AUTH_STARTUP_TIMEOUT_MS`, `authRetryDelay`, `isUnauthorized`, `normalizeAuthCapabilities`, `loadAuthState` | Pure auth bootstrap logic (no React) |

`codemap.md`, `authBootstrap.test.js` and `SettingsContext.currency.test.jsx` are
documentation/tests, not runtime state.

## Design

### Common provider pattern
Every provider in this folder follows the same shape:

- `createContext(null)` at module scope; the context object is also the **default
  export**.
- A named `XxxProvider({ children })` component holds all state and renders
  `<XxxContext.Provider value={…}>{children}</XxxContext.Provider>`.
- A `useXxx()` hook calls `useContext` and **throws** if the context is null
  (i.e. used outside its provider), giving a clear mount-order failure instead of
  silent undefined reads.

### Provider nesting (defined in `App.jsx`)
```text
AuthProvider
└─ SettingsProvider        (reads useAuth)
   └─ OfflineProvider      (reads useAuth + useSettings)
      └─ ConfirmDialogProvider (reads useSettings)
         └─ BrowserRouter > Routes
```
Nesting is an explicit **dependency order**, not arbitrary:

- `SettingsProvider` depends on `AuthProvider` for `authLoading`, `multiUser`,
  and `user?.id` (it waits for auth before loading settings, and uses the user id
  to re-fetch when the account changes).
- `OfflineProvider` depends on both: it keys the outbox/read cache by user and
  origin, and restores the per-user settings cache.
- `ConfirmDialogProvider` depends on `SettingsProvider` for `t` (its default
  labels are translated).

### State ownership boundaries

- **AuthContext** is the only owner of identity. `localStorage` keys `token` and
  `user` are written/cleared exclusively here (and by the axios interceptor on
  401). It also mirrors a bootstrap snapshot (`offline/authSnapshot`) and clears
  the settings cache on sign-out. No page mutates these directly.
- **SettingsContext** owns the settings object, display language, and exchange
  rate. `localStorage` keys `app_language` and `app_currency` are *local caches
  for first paint only*; the backend (`GET/PUT /api/settings/`) is the source of
  truth, and the caches are always rewritten from backend responses. The per-user
  `offline/settingsCache` keeps the last good settings + rates for an offline
  launch and holds a locally staged download preference until the server
  acknowledges its revision. Cache reads/writes are defensive (try/catch)
  because storage can be unavailable (private mode, blocked cookies).
- **ConfirmDialogContext** owns only the transient modal request and the
  pending `Promise` resolver (in a `useRef`). Its value is a single memoized
  `confirm(options)` function — not a state object.

### Key abstractions

- **`authBootstrap.js` splits the pure logic from the React lifecycle.** Auth
  mode discovery, OIDC capability normalization, single-user admin resolution,
  expired-token handling, and backoff retry delays live here so they are
  unit-testable without React.
  - `AUTH_STARTUP_TIMEOUT_MS` = 5 s; iOS keeps requests pending while offline, so
    the startup calls must give up on their own.
  - `normalizeAuthCapabilities(mode)` validates `multi_user` and the optional
    `auth_mode`/`password_login_enabled`/`oidc_enabled`/`oidc_display_name`
    fields; legacy responses without them keep password login and hide SSO, while
    malformed values fail bootstrap.
  - `authRetryDelay(attempt)` = `min(1000 * 2^attempt, 10_000)` ms exponential
    backoff capped at 10s.
  - `isUnauthorized(error)` = `error.response.status === 401`.
  - `loadAuthState({ token, getAuthMode, getMe })` performs the whole bootstrap
    and returns a discriminated result (`user`, `multiUser`, `modeLocked`, the
    OIDC capabilities, `clearSession`, `clearToken`); network/server failures
    **throw** so the caller can retry without destroying a valid session.
- **`t(path)` dot-path translation lookup** with automatic English fallback is
  provided by `SettingsContext`. i18n module internals are **out of scope** for
  this codemap; only the loader/selection wiring lives here.
- **Currency is EUR-based.** The settings exchange rate is expressed as
  `EUR → displayCurrency`; a parallel `USD → displayCurrency` rate is kept so a
  later currency switch works offline. `convertEurToDisplay` / `convertDisplayToEur`
  / `formatPrice` / `formatUsdPrice` are the only currency-conversion surface
  exposed to the rest of the app.

## Flow

### 1. Authentication bootstrap (on mount)
1. `AuthProvider` seeds `user` from `localStorage['user']` (parsed defensively;
   corrupt JSON is removed) and starts `authStatus = 'loading'`.
2. An effect runs `bootstrap()` → `loadAuthState(token, getAuthMode, getMe)`:
   - `getAuthMode()` returns the mode/capabilities (mode discovery is public,
     sent with `skipAuthentication` + `preserveSessionOnUnauthorized`).
   - Multi-user with no token → `{ user: null, multiUser: true }`.
   - Otherwise `getMe({ withoutToken: !multiUser, preserveSession: true })`:
     single-user mode always resolves the automatic admin regardless of a stale
     token; a 401 during bootstrap must not trigger the interceptor's
     clear-and-redirect. Both calls use the 5 s startup timeout.
   - Multi-user + token + 401 → treated as an **expired session** (resolved
     state with `clearSession`/`clearToken`), not a connectivity error.
   - Any other error → **throws**. With the offline queue enabled, a valid cached
     auth snapshot opens `authStatus = 'degraded'`; otherwise `authStatus =
     'offline'`. Either way the effect schedules a retry with
     `authRetryDelay(attempt)`.
3. On success the provider sets `multiUser`, `modeLocked`, the OIDC capabilities,
   `user`, clears the token when `clearToken`, syncs `localStorage['user']` +
   `writeAuthSnapshot(...)`, and flips to `authStatus = 'ready'`.
4. `retryConnection()` resets to `loading` and bumps `bootstrapVersion`, which
   re-runs the effect (used by the offline startup screen's retry button).

### 2. Routing gate (in `App.jsx` `ProtectedRoutes`)
Reads `useAuth()` and gates the protected tree:
- `loading` (which includes `offline`) → `<AuthStartupScreen>` (also shows the
  retry button when `connectionError`).
- `!user && multiUser` → `<Navigate to="/login">`.
- `!user` (single-user, not yet resolved) → loader.
- `user.must_change_password` → `<ForcePasswordChangeScreen>` (which calls
  `updateCurrentUser` after `forceChangePassword` succeeds).
- Otherwise the full nested route tree under `<Layout>`.

A `degraded` session counts as loaded, so the app opens display-only from the
cached snapshot and recovers when bootstrap retries succeed. Public routes
(`/login`, `/auth/oidc/complete`, `/u/*`) are outside `ProtectedRoutes` but inside
the providers, so they can read auth/settings too.

### 3. Settings + exchange-rate load
1. `SettingsProvider` waits until `authLoading` is false, then:
   - Multi-user with no token → apply cached defaults, mark loaded.
   - Otherwise `GET /api/settings/` (Bearer header only in multi-user mode;
     single-user relies on the bootstrap admin auto-auth). Success caches
     language/currency, maps `zh` → `zh-cn`, normalizes `tcgdex_sync_languages`,
     and merges into state. Failure falls back to defaults.
2. A separate effect lazily loads the non-English translation chunk for the
   selected language via dynamic `import()` (`loadedTranslations` map); English
   is always present.
3. A third effect fetches the exchange-rate pairs `EUR→curr` and `USD→curr` from
   `/api/settings/exchange-rate` (with a timeout and the per-user rate cache as a
   fallback), derives `exchangeRate` (display rate) and `usdToDisplayRate`, and
   reports `stale`/provider date/sync time.

### 4. Session changes and mutations
- `loginUser(token, userData)` writes `token` + `user` to `localStorage`, updates
  state, and refreshes the auth snapshot.
- `updateCurrentUser(updates)` merges into `user` and persists it.
- `logout()` first awaits the offline logout guard (`setLogoutGuard`, which can
  sync/keep/discard queued items), then clears `token` + `user`, the auth
  snapshot and the settings cache, sets `user` null, and forces
  `window.location.href = '/login'` (full reload to flush React Query caches so
  no data leaks between accounts).
- `updateSettings(updates)` optimistic-updates state, `PUT`s to
  `/api/settings/`, merges the server response (re-caching language/currency and
  the per-user settings cache), and reverts on failure. An
  `offline_collection_enabled` change is staged locally first and only treated
  as saved once the server acknowledges its revision.

### 5. Confirm dialog (imperative)
`confirm(options)` returns a `Promise<boolean>`: it stores the resolver in a
ref, sets the request, and renders `<ConfirmDialog>`. `onConfirm`/`onClose` call
`close(true|false)`, which resolves the stored promise and clears the request.
A new `confirm` call first resolves any prior pending promise with `false`.

## Integration

- **`api/client.js`** — the axios instance that all contexts use for network
  calls. Its request interceptor injects `Authorization: Bearer <token>` from
  `localStorage`; its response interceptor, on 401 (unless
  `preserveSessionOnUnauthorized`), clears `token`/`user` and redirects to
  `/login`, and on a response-less failure notifies the offline monitor.
  `AuthContext`/`authBootstrap` import `getAuthMode`, `getMe`;
  `SettingsContext` uses raw `fetch` (not the axios instance) for settings and
  exchange-rate endpoints.
- **`offline/`** — `authSnapshot` (cached bootstrap session), `settingsCache`
  (settings/rate cache + staged download preference) and `readCache` are the
  persistence behind these contexts; `OfflineProvider` keys them by user.
- **`App.jsx`** — the only place providers are mounted, and the main consumer of
  `useAuth` (routing gate, `ForcePasswordChangeScreen`, `forceChangePassword`)
  and `useSettings` (translation in the force-password screen).
- **Utils consumed by `SettingsContext`**: `priceFieldFromPrimary`
  (`utils/prices`), `normalizeTcgdexLanguageCsv` (`utils/tcgdexLanguages`),
  `currencySymbolFor` / `formatSelectedCurrency` / `rateForSelectedCurrency`
  (`utils/currencyFormatting`).
- **Components**: `ConfirmDialogProvider` renders `components/ui/ConfirmDialog`;
  `App.jsx` renders `components/AuthStartupScreen`, `components/PokeBallLoader`,
  `components/Layout`.
- **Consumers of `useSettings()`** are broad (95 files, including tests): every
  page plus shared components (`Modal`, `Sheet`, `AppNav`, `CardItem`,
  `CardScanner`, `UnifiedCardScanner`, `CollectionCardImage`,
  `CardStateIndicators`, `PrintingDetailTagManager`, card-system components,
  sync/pwa chrome). They mostly pull `t`, `formatPrice`, `pricePrimaryField`,
  `exchangeRate`, `settings`, and `updateSettings`.
- **Consumers of `useAuth()`** are fewer than `useSettings` but span the shell:
  `App.jsx`, `AppNav`, `CardItem`, `CollectionCardImage`, `Login`, `OidcComplete`,
  `Settings`, `Achievements`, `Compare`, `Dashboard`, `HomeScreen`, `Leaderboard`,
  `components/sync/ServerSyncSettings.jsx` (admin role), and the offline layer
  (`OfflineProvider`, `AutomaticCollectionProvider`). `AuthStartupScreen` takes
  its connection state as props. `OfflineProvider` registers the logout guard
  through `setLogoutGuard`.
- **Consumers of `useConfirmDialog()`**: `Collection`, `CardScanner`, `Settings`,
  `Wishlist`, `Products`, `Binders`, `DeckEditor`, `CardItem`,
  `PrintingDetailTagManager` — used for destructive-action confirmations.
