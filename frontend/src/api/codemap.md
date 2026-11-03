# frontend/src/api/

## Responsibility

This folder is the single client-side gateway to the FastAPI backend. It owns every
HTTP call the React app makes, so no page or component reaches `axios` or `fetch`
directly — they import typed helper functions from here instead. It encapsulates:

- **Two Axios instances** with distinct trust profiles (`client.js` for authenticated
  app traffic, `publicClient.js` for anonymous public pages).
- **Auth plumbing** — attaching the bearer token, and the 401 → clear-session →
  redirect behaviour.
- **Error normalization** — turning backend `detail` payloads (strings, Pydantic
  validation arrays, nested objects) into a single human-readable message.
- **Binary/download handling** — blobs fetched as `responseType: 'blob'` and either
  handed back raw or converted to object URLs, since `<img src>` and anchor
  downloads cannot carry an `Authorization` header.
- **Multipart uploads** — card recognition, collection photos, CSV imports, backups.

## Design

- **Two instances, one trust boundary.** `client.js` creates `axios.create({ baseURL: '/api' })`
  with request/response interceptors; `publicClient.js` creates a separate
  `axios.create({ baseURL: '/api/public' })` with **no interceptors at all**. Public
  endpoints must never set an `Authorization` header and never bounce an anonymous
  visitor to `/login`.
- **`Content-Type: application/json` is the default** on both instances. This is why
  multipart endpoints explicitly override `Content-Type: multipart/form-data`; without
  the override Axios would send the FormData under `application/json` and the server
  rejects it as a missing field.
- **Request interceptor (client only).** Every request reads `token` from
  `localStorage` and sets `Authorization: Bearer <token>`. A per-request
  `skipAuthentication` flag (used by `getAuthMode`) bypasses this so a stale token
  cannot influence bootstrap.
- **Response interceptor (client only).** On a `401` it clears `token` and `user` from
  `localStorage` and redirects to `/login` — unless the request set
  `preserveSessionOnUnauthorized` (bootstrap/discovery) or the user is already on
  `/login` or a public share path (`/u`, `/u/…`). The interceptor returns
  `Promise.reject(error)` so callers still see the rejection.
- **Token storage is `localStorage`, not cookies.** The token is written by
  `AuthContext.loginUser`, read by the interceptor and by the ad-hoc blob-download
  helpers (`exportCSV`, `exportPDF`, `downloadBackup`, `downloadDebugLog`,
  `exportBinderCsv`), which set the header manually because they drive a programmatic
  `<a>.click()` rather than an XHR-with-defaults path.
- **`getApiErrorMessage(error, fallback)`** is the shared error formatter. It walks
  `detail` (string, array of Pydantic errors with `msg`/`loc`, or nested objects) and
  joins everything into one string; `ActionErrorNotice` and several pages render it.
- **Scanner timeouts are decoupled.** `scannerRecognitionRequestTimeoutMs` and
  `scannerTestRequestTimeoutMs` (from `utils/scannerTimeout`) are applied per-request
  (`recognizeCard`, `testScannerConfiguration`) to cover the backend's multi-attempt
  recognition flow, overriding the instance's 30s default.

## Flow

1. A component imports a named helper (e.g. `getCollection`, `searchCards`) from
   `../api/client` (authenticated) or `../api/publicClient` (anonymous).
2. The helper calls the Axios instance; the request interceptor injects the bearer
   token unless `skipAuthentication` is set.
3. The backend responds. Success returns `r.data` (some helpers leave the full
   response, e.g. `searchCards`, so callers can read headers). Blob endpoints return
   a `Blob` or an object URL.
4. On failure the response interceptor handles `401` (session teardown + redirect) and
   re-rejects; callers format the message via `getApiErrorMessage`.
5. On bootstrap, `AuthContext` calls `getAuthMode()` then `getMe()` (both
   `preserveSessionOnUnauthorized`) through `authBootstrap`'s `loadAuthState` to
   reconcile the stored session against the server before marking the app `ready`.

## Integration

`client.js` exposes one helper per backend domain (all under `/api`):

- **Auth** `/auth/*` — login (OAuth2 form-encoded), me, mode (public discovery),
  user CRUD, password/avatar/username changes.
- **Profile** `/profile/` — owner's public profile get/update.
- **Cards** `/cards/*` — search, detail, per-language, price history, custom cards and
  migration, Gemini recognition (`/cards/recognize`), and the persistent scan-job
  queue (`/cards/recognize/jobs`).
- **Collection** `/collection/*` — list/search/add/bulk/import-CSV, per-item update,
  photos (owner-only, blob), printing-detail tags, stats.
- **Decks** `/decks/*` — CRUD, duplicate, convert planned↔real, entries, compare,
  probability.
- **Sets** `/sets/*` — list, detail, checklist, new-sets, mark-seen.
- **Wishlist** `/wishlist/*`; **Pokédex** `/pokedex*`; **Binders** `/binders/*`
  (CRUD, cards/entries, equivalent-prints, print optimization, wishlist conversion,
  CSV import/export); **Dashboard** `/dashboard/`; **Analytics** `/analytics/*`;
  **Sync** `/sync/*` (trigger + status + reschedule); **Products** `/products/*`
  (CRUD, card linking, ledger, lifecycle); **Trades** `/trades/*`; **Export**
  `/export/csv` + `/export/pdf`; **Backup** `/backup/download` + `/backup/restore`;
  **Settings** `/settings/*` (CRUD, scanner config/test, telegram status, scan
  diagnostics, debug log); **GitHub/Community** `/github/*`, `/community/supporters`;
  **Social** `/social/*` (leaderboard, compare, achievements).

`publicClient.js` exposes anonymous read helpers under `/api/public`:

- `/profiles` (directory), `/profiles/:handle`, and per-handle `/binders/:id`,
  `/wishlist`, `/decks/:id`, `/decks/:id/probability`.

Consumers are spread across `pages/`, `components/`, `contexts/` (AuthContext),
and `hooks/`; the default export (`api`) is imported directly only where raw
interceptor behaviour is needed (e.g. `Settings.jsx`).
