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
   Telegram plus Web Push alerts (`telegram.py`, `push.py`), pre-upgrade
   backups, debug logging, exchange-rate/currency handling, and exactly-once
   replay of retried mutations (`idempotency.py`).

## Design

**Session-injected functions.** There is no service base class or repository
pattern. Every data-touching function accepts a `db: Session` and manages its own
commit/rollback; long-running jobs open their own session via
`database.SessionLocal`. Shared helpers stay pure where possible.

**Physical binder locations.** `binder_layouts.py` overlays occupied pockets on
reserved membership quantities; unplaced copies are computed, never duplicated
inventory. Writes acquire `binder_allocations.lock_user_card_allocations` before
binder locks, compare revision/membership snapshots and commit swaps/replacements
atomically. Undo retains one server-side snapshot and refuses intervening changes.
`binder_layout_schema.py` performs the idempotent fail-fast schema upgrade and
installs PostgreSQL cross-table integrity/revision triggers. `require_unplaced`
protects legacy quantity, removal, conversion, printing and allocation-release
workflows; explicit account erasure removes that owner's locations with its data.

**Upsert convention.** `card_upsert.upsert_card` and `sync_service.upsert_set`
implement query-then-update-or-insert. Card upserts support three modes —
`partial` (catalogue list rows), `metadata_only` (never touch price state), and
full — and preserve prior prices when an incoming payload has no valid price
(`price_utils.preserve_existing_prices_for_invalid_update`, whose
`PRICE_FIELDS` covers the `price_tcg_*` columns too). Full upserts that carry
any TCGplayer price also save a `price_tcg_usd_to_eur` rate, resolved once per
session through `exchange_rates.get_exchange_rate("USD", "EUR")` so valuation
never needs a live lookup.

**Price resolution.** Stored `price_market`/`price_trend`/`*_holo` fields stay
Cardmarket EUR data (zero treated as missing). `card_values.effective_price_quote`
is the single resolver: Cardmarket → an allowed TCGplayer market price (permitted
by `Card.tcgplayer_fallback_allowed`: English always, German only with the
`cross_language_price_fallback` setting; either needs a saved USD/EUR rate)
→ the fork's personal last resort (`price_jpy_eur_equivalent`, then
`manual_value_override`), reported as source `manual`. `effective_market_price`
is the amount-only wrapper used by `portfolio_valuation`, and
`GET /api/cards/{id}/valuation` returns the quote with its provenance. Valuation
performs no network requests or writes.

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

**OIDC profile enrichment.** `oidc_provider.py` validates discovery and signed ID
tokens, then retrieves JSON UserInfo when advertised. The bearer access token is
transient; an exact subject match binds optional profile claims to the validated
identity. `oidc_identity.py` uses a sanitized profile hint only when provisioning
a new local account; existing accounts resolve by issuer and subject without
renaming or merging users. When a new identity has no usable hint, completion
waits for an available user-chosen name before creating the account.
`oidc_transactions.py` owns browser-bound one-use login/link state and handoffs;
`oidc_link.py` completes explicit account linking.

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

**Idempotent mutation replay.** `idempotency.py` implements the client
`Idempotency-Key` contract: keys are per-user, 16–64 URL-safe characters, scoped
(`collection.add`, `wishlist.add`, `scan.enqueue`) and bound to a SHA-256 request
fingerprint; a mismatched reuse is a 422 and a *concurrently running* key is a
409 with `Retry-After` (a `pg_try_advisory_xact_lock`, never a blocking wait
inside async handlers). Only 2xx results are stored, staged in the caller's
transaction via `IdempotencyContext.record`, replayed by `replay_response` with
`Idempotent-Replayed: true`, and expired after 14 days by
`purge_expired_idempotency_keys` in bounded batches.

**Web Push delivery.** `push.py` stores one subscription row per browser, only
for allow-listed push-service hosts (FCM plus Apple/Mozilla/Windows suffixes),
and sends declarative Web Push JSON capped at 4096 bytes. VAPID keys come from
`VAPID_PRIVATE_KEY`, else a `0600` PEM under `DATA_DIR/auth` created under an
`fcntl` lock, else an ephemeral pair (subscriptions then break on restart).
Subscriptions are deleted on 404/410 or after 10 failures; 403/429 are skipped
without counting. Price alerts carry only the card name — never the price or
threshold.

**API capability markers.** `api_info.py` holds `API_LEVEL` and
`API_FEATURES` (`idempotency-v1`), which `main.py` exposes through
`GET /api/health` so the PWA knows whether replay-safe writes are supported.

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
price history → fire wishlist alerts via Telegram and Web Push → snapshot
portfolio values → probe custom cards for new TCGdex equivalents.
`perform_price_sync` runs the price-only subset on the scheduler's short
interval.

**Price fairness.** `sync_service._price_sync_plan` scales a per-run cap to
collection size, reserves capacity for both missing-price and already-priced
cards, and cools down permanently-unpriced cards (24 h) so they cannot monopolize
every run.

**Scan pipeline** (`scan_queue` + `scan_storage` + `scan_providers`): uploads are
validated/sanitized into `ScanJob`/`ScanJobItem` rows; the 1-minute maintenance
job drains the queue, acquires leases, resolves the provider (`ScanProvider`),
respects rate-limit/quota state, calls Gemini or an OpenAI-compatible endpoint,
and caches candidate artwork (`scan_candidate_images`). Recognition results flow
back to the `api/recognize.py` and `api/scan_jobs.py` routers. A keyed enqueue
replays before any provider/credential check; `scan_storage.create_scan_job`
accepts a `before_commit` hook so the idempotency row and the job (including the
fork's destination Card List) commit atomically.

## Integration

- **`api/*` routers** call service functions for every non-trivial operation.
  Note the one intentional reverse edge: `scan_providers` imports Gemini
  plumbing (`get_gemini_model`, `get_gemini_key`, `post_gemini_generate`,
  `build_gemini_generate_url`) from `api/recognize.py`.
- **`models` + `database`**: services read/write via `Session` and ORM models,
  and read app configuration from `Setting` / `UserSetting` rows (sync intervals,
  sync languages, currency, scanner provider/model, Telegram credentials, feature
  toggles like `digital_sets_enabled`, `cross_language_price_fallback`,
  `offline_collection_enabled`, artwork-sweep batch/interval).
- **External providers**: TCGdex (`api.tcgdex.net`), Frankfurter
  (`api.frankfurter.dev`), Telegram Bot API, Gemini / OpenAI-compatible vision,
  Suruga-ya (via the `byparr` FlareSolverr sidecar), and browser push services
  (FCM/Apple/Mozilla/Windows) through `pywebpush`.
- **`scheduler.py`** registers the APScheduler jobs that drive `sync_service`,
  `suruga_ya_pricing`, `scan_queue`/`scan_storage`, the rate-limit purge
  functions, `pokedex_backfill`, the fork's `artwork_sweep_job`, and the hourly
  `idempotency_key_cleanup_job`.
- **`scripts/*`** (`backfill_pokedex_metadata`, `cache_pokedex_images`) are thin
  CLI wrappers over `pokedex_backfill` / `pokedex_images`.

### Module map

- **Sync / catalogue**: `sync_service`, `pokemon_api`, `card_upsert`,
  `card_fallbacks`, `card_metadata`, `card_visibility`, `card_values`,
  `card_numbers`, `price_utils`, `tcgdex_languages`, `digital_sets`,
  `display_language`, `card_artwork` (shared card-artwork cache key, fetch/store
  and background warmer), `artwork_backfill` (set-level sweep with per-set
  backoff that recovers artwork TCGdex published after the card synced).
- **Pokédex**: `pokedex` (static catalogue), `pokedex_forms`, `pokedex_backfill`,
  `pokedex_images`.
- **Scanner**: `scan_storage`, `scan_queue`, `scan_trace`, `scan_providers`,
  `scan_candidate_images`, `scan_decision` (experimental calibrated-confidence
  model; provisional weights, not wired into the runtime scanner),
  `scan_quality` (deterministic preflight on a sanitized photo, used by
  `api/recognize.py`), `artwork_index` (optional ONNX/`onnxruntime`
  artwork-similarity candidate source; unavailable means an empty result),
  `gemini_rate_limit`, `provider_rate_limit`, `image_url_security`.
- **Valuation / products**: `portfolio_valuation`, `product_ledger`,
  `product_sources`, `product_images`, `product_card_unlink`, `printing_details`,
  `printing_detail_tags`, `exchange_rates`, `suruga_ya_pricing`.
- **Gameplay / deck**: `card_gameplay`, `card_state`, `card_composite`,
  `card_list_names`, `standard_legality`, `supporters`, `deck_analysis`,
  `deck_allocation`, `deck_comparison`, `deck_effects`, `deck_probability`,
  `deck_validation`, `deck_display_variants`.
- **Collection / social**: `collection_csv`, `collection_photos`,
  `collection_variants`, `collection_removal_conflicts`, `bulk_removal_errors`,
  `card_list_removal`, `custom_cards`, `binder_allocations`, `binder_csv`,
  `wishlist_missing`, `public_profile`, `public_profile_feature`, `text_search`.
- **Ops**: `auth`, `auth_policy`, `auth_admin`, `idempotency`, `push`,
  `api_info`, `scheduler`, `telegram` (the fork keeps `send_new_sets_notification`
  for `sync_service`; shared-message helpers are `send_message` and
  `send_price_alert`), `pre_upgrade_backup`, `postgres_cli`, `debug_logging`,
  `analytics`, `access_log` (uvicorn access-log query redaction for OIDC paths).
- **OIDC**: `oidc_provider`, `oidc_identity`, `oidc_link`, `oidc_transactions`,
  `oidc_crypto`.
