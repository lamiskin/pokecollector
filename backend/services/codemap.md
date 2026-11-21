# backend/services/

## Responsibility

This is the application's **business-logic / service layer**. It sits between the
HTTP API routers (`backend/api/*.py`) and the persistence layer
(`backend/database.py` + `backend/models.py`), and it owns every integration with
the outside world. It contains no route handlers of its own; instead it exposes
plain functions (almost all taking a SQLAlchemy `Session` as their first `db`
argument) that routers, the background scheduler, and CLI scripts call.

Four broad responsibilities live here:

1. **Catalogue sync** — pulling sets/cards/prices from TCGdex into the local
   database (`sync_service.py`, `pokemon_api.py`, plus the card/set parsing and
   fallback helpers).
2. **Card scanning / recognition** — the sanitized-upload, queue, and
   multi-provider vision pipeline (`scan_storage`, `scan_queue`, `scan_trace`,
   `scan_providers`, `scan_candidate_images`, and the rate-limit guards).
3. **Domain calculations** — portfolio valuation, deck analysis/probability,
   Pokédex aggregation, price selection, product/ledger accounting.
4. **Ops & notifications** — APScheduler background jobs (`scheduler.py`),
   Telegram alerts (`telegram.py`), pre-upgrade backups, debug logging, and
   exchange-rate/currency handling.

## Design

**Session-injected functions.** There is no service base class or repository
pattern. Every data-touching function accepts a `db: Session` and manages its own
commit/rollback; long-running jobs open their own session via
`database.SessionLocal`. Shared helpers stay pure where possible.

**Upsert convention.** `card_upsert.upsert_card` and `sync_service.upsert_set`
implement query-then-update-or-insert. Card upserts support three modes —
`partial` (catalogue list rows), `metadata_only` (never touch price state), and
full — and preserve prior prices when an incoming payload has no valid price
(`price_utils.preserve_existing_prices_for_invalid_update`).

**Composite localized keys.** TCGdex cards and sets are stored per language with
composite primary keys `"{tcgdex_id}_{lang}"` (e.g. `sv1-1_de`). `pokemon_api`
builds these; `tcgdex_languages.strip_lang_suffix`/`with_lang_suffix` are the
single source of truth for suffix parsing and language normalization.

**Cross-language fallback.** `card_fallbacks.py` fills missing images/prices/data
on a native card row from a sibling-language row and records the source via
`image_source_lang` / `data_source_lang` / `price_source_lang` for UI tagging; it
can also materialize temporary fallback rows for sets that appear in one language
first. `card_visibility.py` governs which languages sync and "pins" the
localized sets of tracked collection/wishlist/binder cards so they stay synced
after a language is deselected.

**External-provider adapters.** `pokemon_api.py` is the sole TCGdex HTTP client
and parser. `scan_providers.ScanProvider` abstracts Gemini vs OpenAI-compatible
endpoints behind one `generate_text` call site. `exchange_rates.py` wraps
Frankfurter with a DB-backed, refresh-interval cache. `suruga_ya_pricing.py`
scrapes Suruga-ya via the Byparr sidecar.

**Persisted rate limiting without secrets.** `gemini_rate_limit.py` (token-bucket
pacing with interactive/background priority) and `provider_rate_limit.py`
(blocking backoff for non-Gemini providers) persist state in DB tables keyed by
HMAC **fingerprints** of credentials (`auth.secret_fingerprint`), never the raw
keys. Keys are scoped by endpoint so an admin changing `OPENAI_BASE_URL`
invalidates prior capability proofs.

**Concurrency & restart safety.** Full sync and price-history writes are guarded
by PostgreSQL advisory locks (`sync_service._full_sync_lock`,
`record_price_history_batch`), with a `SyncLog` "running" row as the
cross-process guard (stale after 60 min). The scan queue uses lease tokens,
`next_attempt_at` backoff, and `recover_expired_leases` so a crashed worker's
items return to the queue. `scan_queue._ProcessWideAsyncSemaphore` bounds
concurrent work across the web and scheduler event loops.

**Secret handling.** `auth.resolve_jwt_secret` persists a generated key to a
`0600` file under an `fcntl` lock, rejects the empty-string Compose default, and
falls back to an ephemeral key rather than a predictable one. `auth` also owns
`bootstrap_admin` (first-run admin + orphan-row reassignment).

**Defensive parsing & security.** `image_url_security.validate_public_https_image_url`
rejects SSRF-prone custom image URLs; `scan_providers` reads the OpenAI base URL
from environment only (not user input); `scan_storage` sanitizes/resizes uploads
with strict size/pixel/format caps; `scan_trace` redacts API keys from persisted
diagnostics.

## Flow

**Startup** (`main.py` lifespan → services): pre-upgrade backup
(`pre_upgrade_backup`) → `init_db` → `auth.bootstrap_admin` →
`public_profile.migrate_public_profile_handles` → `debug_logging.configure_debug_logging`
→ `scheduler.start_scheduler`.

**Full sync** (`sync_service.perform_full_sync`): take the full-sync lock →
sync sets for configured languages → refresh pinned set rows → enrich
detail-less sets → sync each set's card catalogue (native rows then
cross-language fallbacks) → enrich missing card metadata (bounded) → run the fair
price-sync queue (collection/wishlist/binder + pinned-set cards) → record daily
price history → fire wishlist alerts via Telegram → snapshot portfolio values →
probe custom cards for new TCGdex equivalents. `perform_price_sync` runs the
price-only subset on the scheduler's short interval.

**Price fairness.** `sync_service._price_sync_plan` scales a per-run cap to
collection size, reserves capacity for both missing-price and already-priced
cards, and cools down permanently-unpriced cards (24 h) so they cannot monopolize
every run.

**Scan pipeline** (`scan_queue` + `scan_storage` + `scan_providers`): uploads are
validated/sanitized into `ScanJob`/`ScanJobItem` rows; the 1-minute maintenance
job drains the queue, acquires leases, resolves the provider (`ScanProvider`),
respects rate-limit/quota state, calls Gemini or an OpenAI-compatible endpoint,
and caches candidate artwork (`scan_candidate_images`). Recognition results flow
back to the `api/recognize.py` and `api/scan_jobs.py` routers.

## Integration

- **`api/*` routers** call service functions for every non-trivial operation.
  Note the one intentional reverse edge: `scan_providers` imports Gemini
  plumbing (`get_gemini_model`, `get_gemini_key`, `post_gemini_generate`,
  `build_gemini_generate_url`) from `api/recognize.py`.
- **`models` + `database`**: services read/write via `Session` and ORM models,
  and read app configuration from `Setting` / `UserSetting` rows (sync intervals,
  sync languages, currency, scanner provider/model, Telegram credentials, feature
  toggles like `digital_sets_enabled`).
- **External providers**: TCGdex (`api.tcgdex.net`), Frankfurter
  (`api.frankfurter.dev`), Telegram Bot API, Gemini / OpenAI-compatible vision,
  and Suruga-ya (via the `byparr` FlareSolverr sidecar).
- **`scheduler.py`** registers the APScheduler jobs that drive `sync_service`,
  `suruga_ya_pricing`, `scan_queue`/`scan_storage`, the rate-limit purge
  functions, and `pokedex_backfill`.
- **`scripts/*`** (`backfill_pokedex_metadata`, `cache_pokedex_images`) are thin
  CLI wrappers over `pokedex_backfill` / `pokedex_images`.

### Module map

- **Sync / catalogue**: `sync_service`, `pokemon_api`, `card_upsert`,
  `card_fallbacks`, `card_metadata`, `card_visibility`, `card_values`,
  `card_numbers`, `price_utils`, `tcgdex_languages`, `digital_sets`,
  `display_language`.
- **Pokédex**: `pokedex` (static catalogue), `pokedex_forms`, `pokedex_backfill`,
  `pokedex_images`.
- **Scanner**: `scan_storage`, `scan_queue`, `scan_trace`, `scan_providers`,
  `scan_candidate_images`, `gemini_rate_limit`, `provider_rate_limit`,
  `image_url_security`.
- **Valuation / products**: `portfolio_valuation`, `product_ledger`,
  `product_sources`, `product_images`, `printing_details`,
  `printing_detail_tags`, `exchange_rates`, `suruga_ya_pricing`.
- **Gameplay / deck**: `card_gameplay`, `card_state`, `card_composite`,
  `card_list_names`, `standard_legality`, `supporters`, `deck_analysis`,
  `deck_allocation`, `deck_comparison`, `deck_effects`, `deck_probability`,
  `deck_validation`, `deck_display_variants`.
- **Collection / social**: `collection_csv`, `collection_photos`,
  `collection_variants`, `binder_allocations`, `binder_csv`, `wishlist_missing`,
  `public_profile`, `public_profile_feature`, `text_search`.
- **Ops**: `auth`, `scheduler`, `telegram`, `pre_upgrade_backup`, `postgres_cli`,
  `debug_logging`, `analytics`.
