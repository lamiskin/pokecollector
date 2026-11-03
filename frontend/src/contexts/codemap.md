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
| `AuthContext.jsx` | `AuthProvider`, `useAuth`, default context | Session identity and authentication mode |
| `SettingsContext.jsx` | `SettingsProvider`, `useSettings`, default context | User settings, display language, currency + exchange rate |
| `ConfirmDialogContext.jsx` | `ConfirmDialogProvider`, `useConfirmDialog`, default context | The imperative confirm/cancel modal request |
| `authBootstrap.js` | `authRetryDelay`, `isUnauthorized`, `loadAuthState` | Pure auth bootstrap logic (no React) |

`codemap.md`, `AuthContext.test.js` (if present) and
`SettingsContext.currency.test.jsx` are documentation/tests, not runtime state.

## Design

### Common provider pattern
Every provider follows the same shape:

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
   └─ ConfirmDialogProvider (reads useSettings)
      └─ BrowserRouter > Routes
```
Nesting is an explicit **dependency order**, not arbitrary:

- `SettingsProvider` depends on `AuthProvider` for `authLoading`, `multiUser`,
  and `user?.id` (it waits for auth before loading settings, and uses the user id
  to re-fetch when the account changes).
- `ConfirmDialogProvider` depends on `SettingsProvider` for `t` (its default
  labels are translated).

### State ownership boundaries

- **AuthContext** is the only owner of identity. `localStorage` keys `token` and
  `user` are written/cleared exclusively here (and by the axios interceptor on
  401). No page mutates them directly.
- **SettingsContext** owns the settings object, display language, and exchange
  rate. `localStorage` keys `app_language` and `app_currency` are *local caches
  for first paint only*; the backend (`GET/PUT /api/settings/`) is the source of
  truth, and the caches are always rewritten from backend responses. Cache
  reads/writes are defensive (try/catch) because storage can be unavailable
  (private mode, blocked cookies).
- **ConfirmDialogContext** owns only the transient modal request and the
  pending `Promise` resolver (in a `useRef`). Its value is a single memoized
  `confirm(options)` function — not a state object.

### Key abstractions

- **`authBootstrap.js` splits the pure logic from the React lifecycle.** Auth
  mode discovery, single-user admin resolution, expired-token handling, and
  backoff retry delays live here so they are unit-testable without React.
  - `authRetryDelay(attempt)` = `min(1000 * 2^attempt, 10_000)` ms exponential
    backoff capped at 10s.
  - `isUnauthorized(error)` = `error.response.status === 401`.
  - `loadAuthState({ token, getAuthMode, getMe })` performs the whole bootstrap
    and returns a discriminated result (`user`, `multiUser`, `modeLocked`,
    `clearSession`, `clearToken`); network/server failures **throw** so the
    caller can retry without destroying a valid session.
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
   - `getAuthMode()` returns `{ multi_user, locked }` (mode discovery is public,
     sent with `skipAuthentication` + `preserveSessionOnUnauthorized`).
   - Multi-user with no token → `{ user: null, multiUser: true }`.
   - Otherwise `getMe({ withoutToken: !multiUser, preserveSession: true })`:
     single-user mode always resolves the automatic admin regardless of a stale
     token; a 401 during bootstrap must not trigger the interceptor's
     clear-and-redirect.
   - Multi-user + token + 401 → treated as an **expired session** (resolved
     state with `clearSession`/`clearToken`), not a connectivity error.
   - Any other error → **throws** → `authStatus = 'offline'` and the effect
     schedules a retry with `authRetryDelay(attempt)`.
3. On success the provider sets `multiUser`, `modeLocked`, `user`, clears the
   token when `clearToken`, syncs `localStorage['user']`, and flips to
   `authStatus = 'ready'`.
4. `retryConnection()` resets to `loading` and bumps `bootstrapVersion`, which
   re-runs the effect (used by the offline startup screen's retry button).

### 2. Routing gate (in `App.jsx` `ProtectedRoutes`)
Reads `useAuth()` and gates the protected tree:
- `loading` → `<AuthStartupScreen>` (also shows the retry button when offline).
- `!user && multiUser` → `<Navigate to="/login">`.
- `!user` (single-user, not yet resolved) → loader.
- `user.must_change_password` → `<ForcePasswordChangeScreen>` (which calls
  `updateCurrentUser` after `forceChangePassword` succeeds).
- Otherwise the full nested route tree under `<Layout>`.

Public routes (`/login`, `/u/*`) are outside `ProtectedRoutes` but inside the
providers, so they can read auth/settings too.

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
   `/api/settings/exchange-rate`, derives `exchangeRate` (display rate) and
   `usdToDisplayRate`, and reports `stale`/provider date/sync time.

### 4. Session changes and mutations
- `loginUser(token, userData)` writes `token` + `user` to `localStorage` and
  updates state.
- `updateCurrentUser(updates)` merges into `user` and persists it.
- `logout()` clears `token` + `user`, sets `user` null, then forces
  `window.location.href = '/login'` (full reload to flush React Query caches so
  no data leaks between accounts).
- `updateSettings(updates)` optimistic-updates state, `PUT`s to
  `/api/settings/`, merges the server response (re-caching language/currency),
  and reverts on failure.

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
  `/login`. `AuthContext`/`authBootstrap` import `getAuthMode`, `getMe`;
  `SettingsContext` uses raw `fetch` (not the axios instance) for settings and
  exchange-rate endpoints.
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
- **Consumers of `useSettings()`** are broad (61 files): every page plus shared
  components (`Modal`, `Sheet`, `AppNav`, `BottomNav`, `CardItem`,
  `CardScanner`, `UnifiedCardScanner`, `CollectionCardImage`,
  `CardStateIndicators`, `PrintingDetailTagManager`, card-system components).
  They mostly pull `t`, `formatPrice`, `pricePrimaryField`, `exchangeRate`,
  `settings`, and `updateSettings`.
- **Consumers of `useAuth()`** are fewer: `App.jsx`, `Login.jsx`, `Settings.jsx`
  (`user`, `updateCurrentUser`, `multiUser`, `modeLocked`), `Achievements.jsx`
  (`user`, `multiUser`), and `SettingsContext` itself.
- **Consumers of `useConfirmDialog()`**: `Collection`, `CardScanner`, `Settings`,
  `Wishlist`, `Products`, `Binders`, `DeckEditor`, `CardItem`,
  `PrintingDetailTagManager` — used for destructive-action confirmations.
