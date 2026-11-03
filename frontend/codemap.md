# frontend/

The browser client for PokéCollector: a single-page React application that is
built to static assets with Vite and served by an nginx container. This folder
contains everything needed to develop, build, and run that client — the Vite
toolchain, the `src/` application code, `public/` static assets, the nginx
config, and the Docker build/runtime glue.

See also:
- [`src/codemap.md`](src/codemap.md) — the application source tree.
- [`scripts/codemap.md`](scripts/codemap.md) — build/maintenance Node tooling.

## Responsibility

- Provide the entire web UI for PokéCollector: collection, pokedex, sets,
  binders, decks, analytics, trades, settings, and public profiles.
- Build to a self-contained `dist/` of hashed, cacheable static assets plus an
  `index.html` entry point, ready to be served by any static server.
- In production, double as the reverse-proxy entry for `/api` so the browser's
  same-origin API calls reach the backend without CORS.

## Design

**Toolchain (Vite + Tailwind 4).** `vite.config.js` wires two plugins —
`react()` (`@vitejs/plugin-react`, JSX/fast-refresh) and `tailwindcss()`
(`@tailwindcss/vite`, Tailwind v4 with no PostCSS config). It injects a
compile-time `__APP_VERSION__` constant read from the repo-root `VERSION` file,
falling back to `package.json`'s `version` when that file is absent. In `dev`,
it proxies `/api` to `http://localhost:8000` so the dev server talks to a local
backend directly.

**Package config.** `package.json` is `"type": "module"` (ESM throughout).
Runtime dependencies: React 18, `react-router-dom` v7, `@tanstack/react-query`,
`axios`, `recharts`, `lucide-react`, `date-fns`, `clsx`, `react-hot-toast`.
Scripts: `dev` (vite), `build` (vite build), `preview` (vite preview), plus
translation-check and test scripts (see `scripts/codemap.md`).

**Entry chain.** `index.html` (in `public/`-less root) mounts `<div id="root">`
and loads `/src/main.jsx`. `main.jsx` creates the React Query `QueryClient`,
applies the saved theme to `<html>` before first paint to avoid a flash, and
renders `<App>` wrapped in `React.StrictMode`, `QueryClientProvider`, and a
`react-hot-toast` `Toaster`. `App.jsx` (see `src/codemap.md`) composes the
`AuthProvider`/`SettingsProvider`/`ConfirmDialogProvider` contexts around a
`BrowserRouter`, and code-splits every page via `lazy()` + `Suspense` so each
route is its own chunk.

**Static assets.** `public/` holds the PWA manifest (`manifest.json`), favicons,
and the two robots stubs — `robots-allow.txt` / `robots-block.txt` — that the
runtime entrypoint swaps in based on `PUBLIC_MODE`. Vite copies `public/`
verbatim into `dist/` and fingerprints the JS/CSS it emits.

## Flow

1. **Development**: `npm run dev` starts Vite's dev server on `localhost:3000`.
   It serves `index.html` + on-the-fly-transformed JSX from `src/`, and proxies
   `/api/*` to a backend at `localhost:8000`. `import.meta.env.DEV` gates
   dev-only routes (e.g. the card-system gallery).
2. **Build**: `npm run build` runs `vite build` → an optimized, minified,
   fingerprinted `dist/` (`index.html` + hashed JS/CSS + `public/` assets).
3. **Container build** (`Dockerfile`, multi-stage):
   - **Builder stage** (`node:20-alpine`): `npm ci` from `package*.json`, copies
     the repo `VERSION` file and `frontend/`, writes
     `public/robots-block.txt` → `public/robots.txt`, then `npm run build`.
   - **Runtime stage** (`nginx:alpine`): copies `dist/` into
     `/usr/share/nginx/html`, installs `nginx.conf` as the default site, copies
     `docker-entrypoint.d/40-configure-public-mode.sh`, and snapshots the built
     `index.html` to `index.html.template`. Exposes port 80; `CMD` runs nginx in
     the foreground.
4. **Runtime**: nginx serves the static SPA and proxies `/api/` to `backend:8000`
   (see below). On every container start, the entrypoint script regenerates
   `index.html` from the template and selects public/private SEO + `robots.txt`.

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
  because Vite fingerprints filenames).

**Runtime configuration (`PUBLIC_MODE`).** `docker-entrypoint.d/40-configure-public-mode.sh`
runs on container start. It resets `index.html` from `index.html.template` (so
restarts never accumulate SEO tags), then branches on `PUBLIC_MODE`:
`true` writes full SEO/OG/Twitter metadata and `robots-allow.txt` →
`robots.txt`; anything else writes `noindex, nofollow` and `robots-block.txt`.
`docker-compose.yml` passes `${PUBLIC_MODE:-false}` to the frontend service and
publishes `${FRONTEND_PORT:-3000}:80`.

**Backend connection.** The browser never talks to the backend directly in
production — all API traffic is same-origin through nginx, avoiding CORS. The
CSP's `connect-src` whitelists the external third parties the client reaches
(TCGdex, GitHub, Google Fonts, the Gemini API).
