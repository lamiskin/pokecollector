# frontend/

The browser client for PokéCollector: a single-page React application that is
built to static assets with Vite and served by an nginx container, with an
opt-in installable-PWA layer (service worker, offline queue, read cache). This
folder contains everything needed to develop, build, and run that client — the
Vite toolchain, the `src/` application code, `public/` static assets, the nginx
config, and the Docker build/runtime glue.

See also:
- [`src/codemap.md`](src/codemap.md) — the application source tree.
- [`scripts/codemap.md`](scripts/codemap.md) — build/maintenance Node tooling.

## Responsibility

- Provide the entire web UI for PokéCollector: collection, pokedex, sets,
  binders, decks, analytics, trades, settings, a sync/offline center, and public
  profiles.
- Optionally ship an installable PWA shell with a precached app, an offline
  outbox for scanning/adding, and a read cache of previously viewed data.
- Build to a self-contained `dist/` of hashed, cacheable static assets plus an
  `index.html` entry point, ready to be served by any static server.
- In production, double as the reverse-proxy entry for `/api` so the browser's
  same-origin API calls reach the backend without CORS.

## Design

**Toolchain (Vite + Tailwind 4).** `vite.config.js` wires two plugins —
`react()` (`@vitejs/plugin-react`, JSX/fast-refresh) and `tailwindcss()`
(`@tailwindcss/vite`, Tailwind v4 with no PostCSS config). It injects a
compile-time `__APP_VERSION__` constant read from the repo-root `VERSION` file,
falling back to `package.json`'s `version` when that file is absent. It also
defines `__PWA_DEFAULT__` from `VITE_PWA_DEFAULT` (the build-time default for
the service-worker and queue flags, used when no runtime meta tag is present).
In `dev`, it proxies `/api` to
`http://localhost:8000` so the dev server talks to a local backend directly.

**Package config.** `package.json` is `"type": "module"` (ESM throughout).
Runtime dependencies: React 18, `react-router-dom` v7, `@tanstack/react-query`,
`@tanstack/react-virtual` (windowed card grids), `axios`, `recharts`,
`lucide-react`, `date-fns`, `clsx`, `react-hot-toast`. Scripts: `dev` (vite),
`build` (holo CSS prebuild → `vite build` → `scripts/build-sw.mjs`), `preview`
(vite preview), `test` (translation, holo, PWA/nginx/config script checks +
Vitest), `test:pwa` (Playwright with `playwright.pwa.config.js`), plus the
visual-test scripts (see `scripts/codemap.md`).

**Entry chain.** `index.html` at the frontend root mounts `<div id="root">`,
declares the PWA manifest/theme/iOS meta tags, and loads `/src/main.jsx` with
the Google Fonts stylesheet deferred via `media="print"`.
`main.jsx` creates the React Query `QueryClient`, applies the saved theme to
`<html>` before first paint to avoid a flash, enables the font sheet once it
loads, and renders `<App>` wrapped in `React.StrictMode`,
`QueryClientProvider`, and a `react-hot-toast` `Toaster`. After render it calls
`initServiceWorker(...)` with the parsed PWA flags and wires
`vite:preloadError` to the update store. `App.jsx` (see `src/codemap.md`)
composes the `AuthProvider`/`SettingsProvider`/`OfflineProvider`/
`ConfirmDialogProvider` contexts around a `BrowserRouter`, and code-splits every
page via `lazy()` + `Suspense` so each route is its own chunk.

**Static assets.** `public/` holds the PWA manifest (`manifest.json`), the
versioned icon set under `icons/` (app/maskable/apple-touch), favicons, the card
back, the holo-effect assets, and the two robots stubs — `robots-allow.txt` /
`robots-block.txt` — that the runtime entrypoint swaps in based on
`PUBLIC_MODE`. Vite copies `public/` verbatim into `dist/` and fingerprints the
JS/CSS it emits; the post-build service-worker step then precaches them.

## Flow

1. **Development**: `npm run dev` starts Vite's dev server (Vite's default port,
   since `vite.config.js` sets no `server.port`). It serves `index.html` +
   on-the-fly-transformed JSX from `src/`, and proxies `/api/*` to a backend at
   `localhost:8000`. `import.meta.env.DEV` gates dev-only routes (e.g. the
   card-system gallery).
2. **Build**: `npm run build` runs `vite build` (after the holo-CSS prebuild) →
   an optimized, minified, fingerprinted `dist/` (`index.html` + hashed JS/CSS +
   `public/` assets), then `scripts/build-sw.mjs` writes `dist/sw.real.js` and a
   `dist/sw.js` with the precache manifest and `BUILD_ID` filled in, plus the
   kill worker.
3. **Container build** (`Dockerfile`, multi-stage):
   - **Builder stage** (`node:20-alpine`): `npm ci` from `package*.json`, copies
     the repo `VERSION` file and `frontend/`, writes
     `public/robots-block.txt` → `public/robots.txt`, then `npm run build`.
   - **Runtime stage** (`nginx:alpine`): copies `dist/` into
     `/usr/share/nginx/html`, installs `nginx.conf` and the
     `nginx-security-headers.conf` snippet, copies
     `docker-entrypoint.d/40-configure-public-mode.sh` and
     `docker-entrypoint.d/45-configure-pwa.sh`, and snapshots the built
     `index.html` to `index.html.template`. Exposes port 80; `CMD` runs nginx in
     the foreground.
4. **Runtime**: nginx serves the static SPA and proxies `/api/` to `backend:8000`
   (see below). On every container start, the entrypoint scripts regenerate
   `index.html` from the template and select public/private SEO + `robots.txt`,
   then install either `sw.real.js` or `sw.kill.js` as `sw.js` and inject the
   `pokecollector-pwa` flags meta (`PWA_ENABLED`, `OFFLINE_QUEUE_ENABLED`).
5. **PWA test harness**: `scripts/serve-pwa-test.mjs` builds with
   `VITE_PWA_DEFAULT=on` and serves `dist/` on `127.0.0.1:4175` for the Playwright
   specs in `tests/pwa/`.

## Integration

**Static runtime container entry.** The runtime image is the *static* server for
the built assets and the *reverse proxy* for the API:

- `nginx.conf` roots at `/usr/share/nginx/html` with `index index.html`, sets
  security headers (CSP, frame/anchor/permissions policy), and enables gzip.
- SPA fallback: `location / { try_files $uri $uri/ /index.html; }` so client-side
  routes survive a hard refresh.
- API proxying: `location ^~ /api/` proxies to `http://backend:8000` with
  forwarding headers. Dedicated `location =` blocks for
  `/api/cards/recognize/jobs`, `/api/settings/scanner/test`, and
  `/api/cards/recognize` raise `client_max_body_size` and read/send timeouts to
  accommodate multi-hundred-MiB scan uploads and long recognition requests.
- Static assets get `Cache-Control: public, immutable` + `expires 1y` (safe
  because Vite fingerprints filenames). `index.html`, `manifest.json` and the
  service-worker family (`/sw.js`, `/sw.real.js`, `/sw.kill.js`) are served
  `no-cache` so updates and the kill switch propagate immediately.

**Runtime configuration (`PUBLIC_MODE` + PWA flags).**
`docker-entrypoint.d/40-configure-public-mode.sh` runs on container start. It
resets `index.html` from `index.html.template` (so restarts never accumulate
SEO/meta tags), then branches on `PUBLIC_MODE`: `true` writes full
SEO/OG/Twitter metadata and `robots-allow.txt` → `robots.txt`; anything else
writes `noindex, nofollow` and `robots-block.txt`.
`45-configure-pwa.sh` then copies `sw.real.js` or `sw.kill.js` to `sw.js`
according to `PWA_ENABLED`, and injects a
`<meta name="pokecollector-pwa" content="sw=…;queue=…">` tag from
`PWA_ENABLED` / `OFFLINE_QUEUE_ENABLED` (both default off). `docker-compose.yml`
passes `${PUBLIC_MODE:-false}`, `${PWA_ENABLED:-}` and
`${OFFLINE_QUEUE_ENABLED:-}` to the frontend service and publishes
`${FRONTEND_PORT:-3000}:80`.

**Backend connection.** The browser never talks to the backend directly in
production — all API traffic is same-origin through nginx, avoiding CORS. The
CSP's `connect-src` whitelists the external third parties the client reaches
(TCGdex, GitHub, Google Fonts, the Gemini API, Frankfurter for exchange rates).
When a request fails without a response, the API client notifies the offline
reachability monitor instead of assuming the session is invalid.
