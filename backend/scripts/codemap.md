# backend/scripts/

## Responsibility

This folder holds the **standalone CLI / admin utilities** for PokéCollector — the
operational entrypoints a host operator runs from a shell rather than through the
HTTP API. None of these modules are part of the FastAPI application; they are thin,
self-contained commands that open their own resources and exit with a process
status. Four scripts live here:

1. **`analyse_scan_traces.py`** — read-only, offline summary of consented scanner
   diagnostics. It never touches the database or the network; it aggregates JSON
   trace files already written to disk.
2. **`backfill_pokedex_metadata.py`** — host-triggered backfill of TCGdex Pokédex
   and Cardmarket metadata onto already-synced (non-custom) card rows.
3. **`cache_pokedex_images.py`** — populate the persistent National Pokédex image
   cache (sprites + official artwork) from PokéAPI's hosted sprite repository.
4. **`set_admin_password.py`** — reset (and optionally promote) an account's
   password from the host, for recovering a lost/locked admin account.

They are operational glue, not domain logic: every script except
`analyse_scan_traces` delegates the real work to `services/` and the persistence
layer.

## Design

- **Plain `argparse` CLIs with explicit exit codes.** Each script parses its own
  arguments and returns via `raise SystemExit(main())`: `0` success, `1` failure
  (a failed enrich/cache result, unknown user), `2` for input errors (empty/
  mismatched password). `set_admin_password` additionally uses `getpass` for an
  interactive double-prompt so the password stays out of shell history.
- **Session-injected, self-managed DB access.** DB-backed scripts import
  `database.SessionLocal` and open/close their own session in a `try/finally`,
  mirroring the service layer's convention rather than sharing the web app's
  `get_db` dependency. `analyse_scan_traces` imports no `database` or `models` at
  all — it is pure filesystem/JSON analysis.
- **Thin wrappers over services.** `backfill_pokedex_metadata` selects rows with
  `services.pokedex_backfill.pokedex_backfill_query` and hands them to
  `services.card_metadata.enrich_cards_metadata`; `cache_pokedex_images` calls
  `services.pokedex_images.populate_image_ids`/`populate_cache`; the password
  script uses `services.auth.hash_password`. No business rules are re-implemented
  in this folder.
- **`__init__.py` makes `scripts` a package**, so the three DB-backed scripts run
  as `python -m scripts.<module>` from the backend working directory (resolving
  sibling `database`/`models`/`services` imports). `analyse_scan_traces.py` is
  invoked by direct path (`python scripts/analyse_scan_traces.py`) and has no
  intra-app imports.
- **Result reporting is machine-readable.** The backfill and cache scripts print a
  JSON result dict (`attempted`/`updated`/`missing`/`failed`/`deferred`, or
  `cached`/`downloaded`/`missing`/`failed`) before returning their exit status.

## Flow

**`analyse_scan_traces.py`** — `argparse` (`trace_dir` default
`data/scan-traces`, `--failures`, `--field-nulls`) → `load()` yields
`(path, dict)` for every `user-*/*/*.json` under the dir, sorted, skipping
unparseable files to stderr → aggregate with `Counter`/`defaultdict` →
print a report: trace totals, top-1 accuracy, retrieval/ranking stats
("correct card in candidates", "ranked below #1", "never retrieved"),
decision-mechanism accuracy, mode counts, and pHash outcomes; with
`--field-nulls` it adds per-field null rates from `extraction.parsed`, and with
`--failures` it lists each incorrect decision.

**`backfill_pokedex_metadata.py`** — parse `--limit` (default 1000), `--language`,
`--refresh`, `--missing-only` → open `SessionLocal` → build the candidate query:
`pokedex_backfill_query(db)` (missing dex_ids/cardmarket products, Pokémon
supertype) or, with `--refresh`, a full `Card` query (non-custom, has
`tcg_card_id`) → filter by `--language` → order by `updated_at`, `id` →
limit → `enrich_cards_metadata(db, cards, force=True, ignore_cooldown=args.refresh,
commit_every=25)` (the generic missing-metadata predicate is bypassed because
Cardmarket IDs can be absent on otherwise complete rows) → print JSON result →
exit `1` if `result["failed"]` else `0`.

**`cache_pokedex_images.py`** — parse `--min`/`--max` (dex-id range), `--refresh`,
`--missing-only` (no-op compatibility flag), `--delay` (default 0.05 s) → with no
range, build `image_ids` as `range(1, MAX_DEX_ID+1)` plus every form
`image_id` from `services.pokedex_forms.form_catalogue()`, then call
`populate_image_ids`; with a range, call `populate_cache(minimum, maximum)` →
print JSON result → exit `1` if `result["failed"]` else `0`. The service
deduplicates IDs, skips already-cached files (unless `--refresh`), fetches both
`sprites` and `artwork` per ID, and throttles with `--delay`.

**`set_admin_password.py`** — parse `--username` (default `admin`), `--password`
(optional; otherwise interactive), `--make-admin` → open `SessionLocal` → look up
`User` by username (if absent, list existing usernames and exit `1`) → read the
new password (non-empty; interactive path confirms twice) → set
`hashed_password = hash_password(password)` and clear `must_change_password`;
with `--make-admin` also set `role="admin"`, `is_active=True` → `db.commit()` →
print confirmation, exit `0`.

## Integration

- **Invocation is from inside the backend container**, e.g.
  `docker compose exec backend python -m scripts.backfill_pokedex_metadata
  --limit 5000`, `... python -m scripts.cache_pokedex_images`, `... python -m
  scripts.set_admin_password`, and `... python scripts/analyse_scan_traces.py
  /app/data/scan-traces` (documented in `README.md`, `docs/POKEDEX.md`,
  `docs/FORK_DEPLOYMENT.md`, and `AGENTS.md`).
- **Persistence layer:** `database.SessionLocal` (SQLAlchemy session factory) and
  `models.Card` / `models.User` — the same engine/models the web app uses, so the
  scripts operate on the live database.
- **Service layer (downward calls):**
  - `backfill_pokedex_metadata` → `services.pokedex_backfill.pokedex_backfill_query`
    (selection) and `services.card_metadata.enrich_cards_metadata` (per-card TCGdex
    fetch + `card_upsert.upsert_card`); the same enrichment path the full sync runs.
  - `cache_pokedex_images` → `services.pokedex_images` (fetch/download/atomic
    replace into `CACHE_ROOT`, default `/app/data/pokedex-images`, overridable via
    `POKEDEX_IMAGE_CACHE_DIR`) and `services.pokedex_forms.form_catalogue` (the
    10000-range form image IDs).
  - `set_admin_password` → `services.auth.hash_password` (bcrypt), matching
    `services.auth.verify_password` at login.
- **Scanner pipeline (producer, read side):** `analyse_scan_traces.py` consumes
  the JSON files written by `services.scan_trace.py` (`ScanTrace.save` →
  `<stem>.json` under `SCAN_TRACE_DIR/user-<id>/<YYYY-MM-DD>/`; `record_ground_truth`
  later labels each with `ground_truth`, `correct`, `ground_truth_rank`). It is
  the offline counterpart to the runtime consent-controlled tracing feature.
- **Tests:** `tests/test_set_admin_password.py` and `tests/test_pokedex_feature.py`
  import these modules directly and patch `SessionLocal`/service functions to
  exercise `main()` without a live DB or network.
