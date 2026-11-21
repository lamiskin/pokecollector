# backend/api/

## Responsibility

`api/` is the HTTP transport layer of the FastAPI backend. Each module is a
resource-domain router (one `APIRouter` per feature area) that defines the
URL surface, decodes request bodies into Pydantic models, enforces
authentication/authorization, and hands domain work to `services/` and
persistence to `models`/`database`. It contains no business rules of its own
beyond thin endpoint orchestration (a few larger modules — `cards.py`,
`collection.py`, `recognize.py` — also hold domain logic local to their area).

Routers are registered centrally in `backend/main.py` via
`app.include_router(<module>.router, prefix="/api/<x>", tags=["<x>"])`.

## Design

- **One router per domain.** `auth`, `cards`, `collection`, `sets`, `wishlist`,
  `binders`, `decks`, `dashboard`, `analytics`, `sync`, `products`, `trades`,
  `export`, `backup`, `settings`, `images`, `social`, `pokedex`, `public`,
  `profile`, `community`, plus `github` and `recognize`. Three routers share
  the `/api/cards` prefix: `cards.router` (search/custom cards),
  `recognize.router` (live scan), `scan_jobs.router` (persistent scan queue).
- **Shared auth dependency.** `api/auth.py` exposes `get_current_user`
  (OAuth2 bearer via `oauth2_scheme`, `auto_error=False`) and
  `get_optional_user`. In single-user mode (`multi_user_enabled` false) a
  missing token falls back to the active admin user, so the API is usable
  without login; otherwise missing/invalid tokens raise 401. Admin-only
  endpoints check `current_user.role == "admin"` inline (403).
- **Session dependency.** Every DB-touching endpoint takes
  `db: Session = Depends(get_db)` (SQLAlchemy session from `database.py`).
- **Schema layer.** `schemas.py` holds shared Pydantic request/response models
  (`CardBase`, `CollectionItemCreate/Response`, `ProfileUpdate`, …). Small
  module-local request models are defined inline where they are only used once
  (`auth.py` user/`TokenResponse`, `scan_jobs.py` resolve requests).
- **Services hold the logic.** Complex, reusable behavior lives in
  `services/` (`card_upsert`, `card_state`, `scan_queue`, `scan_storage`,
  `public_profile`, `pokemon_api`, `scheduler`, …). Routers import these and
  keep endpoints thin.
- **BackgroundTasks for post-response work.** Search/scan endpoints schedule
  deferred work (metadata enrichment, queue draining) via FastAPI
  `BackgroundTasks` so the response is not blocked.
- **Unannotated public surface.** `public.py` serves shared profiles, binders,
  decks, and wishlists with no auth dependency, gated by
  `public_profiles_enabled(db)` and the owner's `is_profile_public`, using
  `Cache-Control: public, max-age=0, must-revalidate` and `no-store` on 404.

## Flow

1. `main.py` `lifespan` runs startup: `init_db()` migrations,
   `bootstrap_admin`, public-handle migration, debug-logging config, pre-upgrade
   backup, `start_scheduler()`; shutdown stops the scheduler.
2. A request passes middleware (CORS, SlowAPI global 60/min limiter, a custom
   5/min-per-IP login limiter, optional debug logging, `no-store` for failed
   `/api/public` responses).
3. The matching route handler resolves `current_user` (auth) and `db`
   (session), validates the body against a Pydantic schema, then queries
   `models` ORM objects and/or calls `services.*` for domain logic.
4. Read endpoints serialize ORM rows to dicts/Pydantic responses; write
   endpoints `db.add`/`db.commit` (with rollback on `IntegrityError`, mapped to
   400/409). Scan endpoints (`recognize`, `scan_jobs`) dispatch provider work
   (Gemini via `services/scan_providers`) and reconcile results through
   `services/scan_queue`/`scan_storage`, with collection adds delegated to
   `collection.py` helpers.

## Integration

- **Upstream (main.py)** — `main.py` is the only caller; it imports each
  router and mounts it under its `/api/<prefix>`.
- **`database.py`** — provides `get_db` (session) and `get_setting`/
  `save_setting` for the flat `settings` table; `init_db` owns schema
  migrations.
- **`models`** — SQLAlchemy ORM models (`Card`, `Set`, `CollectionItem`,
  `Binder`, `User`, `ScanJob`, …) are queried directly by routers.
- **`schemas.py`** — shared request/response Pydantic models.
- **`services/`** — the bulk of business logic and external integrations
  (TCGdex via `pokemon_api`, Gemini scanning, queue/storage, auth hashing/JWT,
  public-profile serialization, valuation, scheduler).
- **External systems** — `github.py` calls the GitHub API/raw CSV; `recognize.py`
  and scan services call the Gemini API and TCGdex; `sync.py` drives scheduled
  catalogue/price sync.
