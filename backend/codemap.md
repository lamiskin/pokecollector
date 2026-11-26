# backend/

## Responsibility

This is the FastAPI application root for PokéCollector, a self-hosted Pokémon TCG
collection management system. It exposes the entire REST API consumed by the
React frontend and owns all server-side persistence and business logic:

- Collection, wishlist, binders, and decks management (user-scoped inventory).
- Sealed-product ledger, trades, and portfolio valuation.
- Card scanning/recognition (Gemini + provider routing) with a durable job queue.
- Pricing/market data (TCGdex, TCGPlayer, Cardmarket, Suruga-ya) and exchange rates.
- Authentication (JWT, single- and multi-user modes), settings, public profiles,
  community, analytics, sync, export, backup, images, and Pokédex metadata.
- PWA support surface: replay-safe mutation endpoints (`Idempotency-Key`),
  Web Push alert subscriptions, and a health payload that advertises API level
  and feature markers.

`main.py` is the entrypoint (`main:app`, served by uvicorn on port 8000). It
assembles the app, wires middleware and routers, and owns the startup/shutdown
lifecycle. The sibling modules `database.py`, `models.py`, and `schemas.py` are
the persistence/contract layer; `api/` and `services/` hold the HTTP and domain
layers respectively (see their submaps below).

## Design

The backend is a thin layered stack with a clear direction of dependency:

```text
main.py (app assembly, lifespan, middleware, router registration)
   └─► api/*.py   (APIRouter endpoints; HTTP + authn/authz concerns only)
        └─► services/*.py  (pure business logic; no HTTP imports)
             └─► models.py (SQLAlchemy ORM)  +  database.py (engine/session/migrations)
                  └─► PostgreSQL
```

Key architectural decisions:

- **Single entrypoint.** `main.py` creates one `FastAPI` instance with a lifespan
  context manager; every subdomain is an `APIRouter` registered under an
  `/api/<domain>` prefix (see Flow for the full list).
- **ORM + hand-rolled migrations.** SQLAlchemy 2.x declarative models live in
  `models.py`. Schema changes are applied by `database.py`'s `_run_migrations`,
  a flat list of idempotent, versioned raw-SQL statements (v31–v64 plus the
  later additive PWA blocks for `idempotency_keys`/`push_subscriptions`,
  `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` guards). Alembic is present in
  `requirements.txt` but is not the migration path in this codebase.
- **`init_db` is the migration orchestrator.** Beyond `create_all`, it runs
  `_run_migrations`, audits/constrains collection variants
  (`harden_collection_variant_constraints`), and performs legacy data migrations
  (`migrate_legacy_collection_binder_entries`, `migrate_custom_card_ownership`,
  `migrate_card_ids`). Each migration statement is individually committed and
  failures are rolled back, so startup is best-effort per-step.
- **Request/response contracts in `schemas.py`.** Pydantic `BaseModel` classes
  with `orm_mode` (`Config`) mirror the ORM for create/update/response shapes;
  endpoints do not expose raw ORM objects.
- **Optional physical layouts.** `Binder` stores numbered-side/grid metadata and
  undo state; `BinderPlacement` references a reserved `BinderCard` membership for
  each occupied pocket. `services/binder_layout_schema.py` applies the fail-fast
  layout migration after the legacy schema loop. PostgreSQL deferred triggers
  enforce bounds, membership/owner identity and copy counts without rewriting
  existing memberships. See `services/binder_layouts.py` and `api/binder_layouts.py`.
- **Auth.** JWT bearer tokens (python-jose + bcrypt) via
  `OAuth2PasswordBearer(tokenUrl="/api/auth/login")` in `api/auth.py`. The
  shared dependencies are `get_current_user` (401 on missing/invalid token) and
  `get_optional_user` (public-vs-private branching). A `USER_MODE` env var can
  force single- or multi-user mode (`env_user_mode` / `mode_is_env_locked`).
- **Rate limiting.** `slowapi` (`Limiter`, `SlowAPIMiddleware`) at 60 req/min/IP,
  with the shared `limiter` instance in `services/rate_limit.py` (capture-lab
  routes opt out per route with `@limiter.exempt`),
  plus a bespoke in-memory middleware capping login at 5 attempts/min/IP.
- **Config is env-var driven with DB-backed settings.** Secrets/URLs come from
  environment variables (`DATABASE_URL`, `JWT_SECRET_KEY`, `ADMIN_PASSWORD`,
  `GEMINI_API_KEY`, `OPENAI_BASE_URL`, `CORS_ORIGINS`, `APP_VERSION`, `USER_MODE`,
  plus the push keys `VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` and their key-file
  fallback).
  Tunable runtime settings are rows in the `settings` table with defaults in
  `database.py`'s `DEFAULT_SETTINGS`, accessed via `get_setting`/`save_setting`
  helpers; per-user preferences (`offline_collection_enabled`, scanner
  credentials) live in `user_settings`.
- **Background work.** APScheduler (`services/scheduler.py`) is started/stopped in
  the lifespan; the scanner queue is PostgreSQL-backed with filesystem image
  storage (`services/scan_queue.py`, `services/scan_storage.py`).
- **Replay-safe writes.** `services/idempotency.py` stores a completed 2xx
  response under a per-user `Idempotency-Key` (14-day TTL) in the same
  transaction as the business write; retries replay it with
  `Idempotent-Replayed: true`. Advisory transaction locks serialise concurrent
  use of one key, and `X-Expected-User-Id` rejects a queued write replayed under
  another account.
- **Capability advertisement.** `GET /api/health` returns `api_level` and
  `features` from `services/api_info.py`; the PWA sends queued writes only to a
  backend that advertises `idempotency-v1`.

## Flow

**Startup (lifespan):**
1. Resolve the effective user mode (`env_user_mode`) and log warnings for forced
   single/multi mode.
2. Read the app version (`read_app_version`: `APP_VERSION` env → `VERSION` file →
   `"0.0.0"`).
3. `maybe_create_pre_upgrade_backup` (pre-upgrade safety snapshot), then
   `init_db()` (create_all + migrations + hardening + legacy migrations).
4. `bootstrap_admin` (ensure the admin user exists), `migrate_public_profile_handles`
   (public trainer-name URL migration), `configure_debug_logging` (from the
   `debug_mode` setting), and `record_successful_app_version`.
5. `start_scheduler()`.

**Per request:** middleware stack in order — SlowAPI rate limit, CORS,
cache-control guard (no-store for failed `/api/public` responses), debug request
logging (gated by `debug_mode`), and the login rate-limit middleware — then the
matched router. Endpoints pull a session via `get_db` (dependency), authenticate
via `get_current_user`/`get_optional_user`, delegate to `services/`, and return
Pydantic responses.

**Shutdown:** `stop_scheduler()`.

**Router prefixes** (all registered in `main.py`):
`/api/auth`, `/api/cards` (cards + recognize + scan-jobs), `/api/collection`,
`/api/sets`, `/api/wishlist`, `/api/binders`, `/api/decks`, `/api/dashboard`,
`/api/analytics`, `/api/sync`, `/api/products`, `/api/trades`, `/api/export`,
`/api/backup`, `/api/settings`, `/api/images`, `/api/social`, `/api/pokedex`,
`/api/public`, `/api/profile`, `/api/github`, `/api/community`, `/api/push`
(Web Push subscriptions), plus `/api/health` (liveness + API level/features).

## Integration

- **Frontend:** a React 18 + Vite SPA consumes `/api/*`; CORS is configured from
  `CORS_ORIGINS` (defaults to `*`). `static/` serves bundled assets.
- **Database:** PostgreSQL via SQLAlchemy (`engine` with pooling, `SessionLocal`
  session factory, `get_db` dependency). Default DSN
  `postgresql://pokemon:changeme@localhost:5432/pokemon_tcg`; overridden by
  `DATABASE_URL`.
- **External services (via `services/`):** TCGdex (card/set data and images),
  TCGPlayer and Cardmarket (pricing, with TCGplayer converted to EUR at sync),
  Suruga-ya (JPY pricing, personal feature), PokéAPI (species metadata), Gemini
  and OpenAI-compatible endpoints (scanning), currency exchange-rate providers,
  and browser push services (FCM, Apple, Mozilla, Windows) for wishlist alerts.
- **Scheduling:** APScheduler jobs in `services/scheduler.py` (full/price sync,
  the fork's artwork sweep and Suruga-ya JP sync, the idempotency-key cleanup,
  snapshot capture).
- **Operational scripts:** `scripts/` (submap `scripts/codemap.md`) holds
  standalone CLI entrypoints run via `python -m scripts.<module>` — e.g.
  `backfill_pokedex_metadata`, `cache_pokedex_images`, `set_admin_password`.
- **Deployment:** `Dockerfile` builds a `python:3.11-slim` image that runs
  `uvicorn main:app --host 0.0.0.0 --port 8000`, with `VERSION` and the backend
  source copied in.

## Submaps

- `api/codemap.md` — HTTP routers, endpoint contracts, authn/authz.
- `services/codemap.md` — domain logic and external integrations.
- `scripts/codemap.md` — standalone CLI/admin utilities.
