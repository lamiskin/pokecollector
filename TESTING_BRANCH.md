# `testing` branch — what's merged in

Not meant for upstream. This branch exists to run multiple in-progress feature
branches together locally in one build, so they can be tested as a whole
before deciding what (if anything) gets opened as separate PRs.

Update this file's list whenever a branch is merged into or removed from
`testing`.

## Merged branches

- `feature/scan-review-ui-fresh` — linked pan/zoom review, prefetched/progressive
  candidate images, sequential auto-advance review, collapse-on-resolve,
  grid hover polish + printed-total mismatch badge. No rotate button (deliberate
  scope cut). Independent branch off bare `main`. Later fix: the candidate
  zoom placeholder oversized itself 5% via a `scale-105` transform to hide
  blur edge artifacts, but only the blur filter was transitioned — the scale
  snapped instantly the moment the high-res image landed. Caught mid-blur-fade
  (or in a screenshot), the candidate briefly read as a different scale from
  the user's own photo beside it. Switched the oversize to width/height
  instead of transform (transform is reserved for pan/zoom, where a
  transition would lag every drag a frame behind the pointer), so it can now
  animate away smoothly instead of snapping. Second later fix: on mobile the
  stacked frames were sized with `vh`, which mobile browsers compute against
  the address-bar-retracted layout viewport rather than what's actually
  visible — with the bar showing, the two frames plus header/accept-bar
  could run taller than the real screen, reading as the top frame cut off.
  Switched to `dvh`, and added a `safe-area-inset-top` floor on the overlay's
  own top padding as a second line of defense against full-screen fixed
  overlays rendering behind (not below) the address bar. Third later fix:
  found comparing this branch's own before/after screenshots against
  `main` -- a candidate whose TCGdex image genuinely 404s showed the
  proper "Artwork unavailable, Retry" state on `main`, but nothing on
  this branch. Both the grid tile and the zoom modal's candidate side had
  switched to a bare `<img>` with no `onError` handling somewhere in the
  rewrite; grid tile now routes through `CardImage` (non-compact, since
  these tiles are large enough that the icon-only `compactError` mode
  used for small thumbnails elsewhere read as unexplained), the zoom
  modal's candidate side got the same failed/retry state added inline
  instead, since it needs the pan/zoom transform and progressive-blur
  styling `CardImage` doesn't support. Also folded in
  `fix/scanner-candidate-image-hd`'s change (see its own entry below,
  further down this list before this session's split) rather than
  keeping it a separate PR: this branch's own frontend code already
  reads `image_hd` (the whole point of the linked pan/zoom review), so
  without that fix the feature never actually delivered on its premise —
  zooming just scaled up the same low-res thumbnail. On `testing`, that
  fold's own new test doesn't apply (this branch's pre-refactor,
  live-API-only candidate search isn't the code path here anymore, and
  `testing` already had separate `image_hd` coverage from the original
  `fix/scanner-candidate-image-hd` merge below) — dropped here, kept on
  `feature/scan-review-ui-fresh` itself where the code it exercises still
  exists. Fourth later fix: the zoom modal's new artwork-unavailable panel
  used `bg-bg-elevated` (a flat grey fill) first, which clashed against
  the modal's dark background instead of reading as a card-shaped
  placeholder; a near-transparent `rgba(255,255,255,0.03)` fill (matching
  the sibling "no catalogue image" state) was tried next, but that one
  sits over solid black while this one sits over a card-shaped skeleton,
  so the same alpha just clashed a different way instead of disappearing.
  Settled on `bg-black/55`, the same treatment this same modal's loading
  spinner circle already uses.
- `fix/card-dialog-mobile-safe-area` — the shared card-detail dialog
  (`UnifiedCardDialog` in `UnifiedCard.jsx`, used by Collection, Analytics,
  and BinderDetail) had the same fixed-overlay-behind-the-address-bar
  symptom as the scan review zoom modal above: reported as the dialog's top
  edge, and the card image inside it, appearing cut off on a real phone.
  Added the same `safe-area-inset-top`-floored top padding. Independent
  branch off bare `main`, since `UnifiedCard.jsx` isn't owned by any of the
  scan-review branches. Neither that nor the scan-review `dvh` fix actually
  moved anything on a real phone, confirmed by a follow-up screenshot —
  `env(safe-area-inset-top)` is for hardware display cutouts, not a
  browser's own retractable UI, and resolves to 0 without one, so that part
  was always inert. Root cause turned out to be simpler: without
  `interactive-widget=resizes-content` in the viewport meta tag, Chrome's
  default is to shrink only the *visual* viewport when its address bar
  shows, without reflowing layout — so `dvh` and a `fixed inset-0`
  overlay's own top edge stayed sized against the address-bar-retracted
  viewport regardless, which is exactly why switching to `dvh` alone hadn't
  helped either. Added the directive to `frontend/index.html`, app-wide.
- `fix/scanner-search-uses-local-db` — scanner candidate search now queries the
  local `cards` table instead of calling the live TCGdex API. Falls back to a
  single live TCGdex call per (language, name) search pair that has zero
  local rows, so a not-yet-synced set (new release, or a full sync still in
  progress) doesn't read as "card does not exist" — not persisted to the
  catalogue, best-effort on network failure. Independent branch off bare
  `main`.
- `feature/scan-external-lookup-fresh` — outbound lookup links (Google Images,
  eBay, Cardmarket, Pokellector) + reverse image search via Lens, for
  candidates with no catalogue scan. Hand-ported (not merged) from the deleted
  `feature/scan-external-lookup-v2`, which was built against the old
  `feature/scan-review-ui-v2` chain. Stacked on `feature/scan-review-ui-fresh`.
- `fix/scanner-vintage-multilingual-accuracy` — prompt clarification and a
  safety-net cleanup so a card's printed National Pokedex reference ("No.
  0094") stops getting used as its collector number, which was silently
  poisoning `_metadata_decision`'s confident-match paths; the
  English-translation search pair now only runs as an actual fallback when
  the reliable native-language search came back thin, instead of
  unconditionally merging in a possibly wrong-species translation; new
  `sole_candidate` decision path for a search that narrows to exactly one
  match (fixes Trainer/Energy cards, which have no HP for the existing
  `artist_hp` path to use). Stacked on `fix/scanner-search-uses-local-db`.
  A fourth fix originally in this same commit — raising vision-call
  timeouts for slow local models — was split into its own branch below
  (`fix/scanner-vision-timeout`) since it's a general reliability concern,
  not specific to vintage/multilingual accuracy; the split rewrote this
  branch's one commit (amended in place) and required rebuilding `testing`
  from `main` and re-merging everything, since `testing` is local-only and
  never pushed.
- `fix/scanner-vision-timeout` — vision-call timeouts raised 30s/20s ->
  180s (`VISION_REQUEST_TIMEOUT_SECONDS`), the Settings scanner-test call
  30s -> 60s, and the scan queue lease 10min -> 20min to match, since a
  local reasoning model can spend 15-45s+ (measured up to 120s on one
  ambiguous symbol) "thinking" through a card before answering, which made
  vision calls fail silently on nearly every call at the old timeouts.
  Split out of `fix/scanner-vintage-multilingual-accuracy` (see above).
  Independent branch off bare `main`.
- `fix/scanner-candidate-image-hd` — the review zoom modal, the candidate-
  image cache endpoint, and the frontend's `image_hd`-first fallback chain
  were all already written to prefer a high-res `image_hd` field over the
  245px `images_small` thumbnail, but nothing ever populated `image_hd`, so
  every candidate silently rendered the thumbnail instead. At rest (no
  interactive zoom) that meant the candidate sat small and centered with
  visible padding versus the photo filling its frame — `max-h-full`/
  `max-w-full` only caps size, it doesn't upscale a naturally-smaller image
  to fill available space — and looked "fixed" once the reviewer
  interactively zoomed, since a `transform: scale()` forces the box larger
  regardless of intrinsic size, whereas it was still visibly low-res the
  whole time. Populated `image_hd` at all three places a candidate dict
  gets built (local-DB search via `Card.images_large`, the live-TCGdex
  fallback's `/high.webp` sibling URL, and the final per-candidate reshape
  `public_matches` is built from). Existing already-recognized scan items
  keep their persisted low-res-only match data until re-recognized (a
  retry, or a fresh scan) — this only fixes it going forward. Stacked on
  `fix/scanner-vintage-multilingual-accuracy`, since the candidate-dict
  construction it edits was extracted into `_fetch_candidates_for_pair` by
  that branch.
- `fix/scanner-english-fallback-cap` — the English-translation fallback
  (see `fix/scanner-vintage-multilingual-accuracy` above) had no cap on how
  many candidates it could add once triggered, only a check between search
  pairs — confirmed on a real Japanese card (Magmar / マグマラシ, a species
  TCGdex's own Japanese catalogue only has two printings of) where it
  filled the whole shared 15-candidate budget, burying two genuine native
  matches under eight translated English ones. Both native hits still
  ranked first, but the review grid read as "barely finds the right
  language" regardless — reported directly as "showing English cards as
  candidates" for Japanese scans. Added `ENGLISH_FALLBACK_MAX_CANDIDATES`
  (2x the trigger threshold) and enforced it on what actually gets added,
  not just checked between pairs, since a single pair's own result limit
  can already exceed the cap in one call. Originally its own branch
  stacked on `fix/scanner-vintage-multilingual-accuracy`; folded into that
  branch directly (cherry-picked, pushed, standalone branch deleted) once
  it had an open PR — this fix only makes sense against the fallback
  mechanism that branch introduces (`ENGLISH_FALLBACK_MIN_CANDIDATES`
  doesn't exist without it), so reviewing them apart meant presenting a
  known-flooding version of the mechanism before immediately fixing it in
  a follow-up. No functional change to `testing` itself, already merged
  here independently before the fold.
- `feature/scanner-gemini-fallback` — opt-in per-user toggle
  (`scanner_gemini_fallback`, default off), now surfaced in Settings under
  AI/Card Scanner next to the diagnostics toggle. When on, an OpenAI-
  compatible primary provider that comes back unconfident gets a second,
  independent Gemini extraction+match attempt; non-blocking on failure
  (verified live against real Gemini 503 and 429 responses). Review UI shows
  a "Resolved via Gemini fallback" badge on items where it fired. Stacked on
  `fix/scanner-search-uses-local-db`, independent of the accuracy branch
  above.
- `fix/scan-queue-concurrency-and-upload-limit` — two operational fixes found
  load-testing a real batch scan: a semaphore (`MAX_CONCURRENT_SCAN_PROCESSING
  = 3`) capping concurrent recognition processing, since each retry request
  schedules its own uncapped background task and `process_claimed_scan_item`
  holds a DB connection open for the whole recognition call — a burst of
  retries hit real `QueuePool` exhaustion (3 of 48 retried items failed this
  way) once vision calls routinely take minutes; and the `/api/` nginx
  location's `client_max_body_size` raised from `100M` to `500M` to match the
  server-level default, since a full 50-photo batch at realistic phone-camera
  sizes was getting rejected with a 413 before it ever reached the backend.
  Independent branch off bare `main` — content was already live on `testing`
  as direct commits before this got its own branch, so no rebuild was needed
  when it landed.
- `fix/collection-lang-suffix-priority` — `POST /api/collection/` silently
  dropped an explicit language suffix on `card_id` (e.g. `PMCG3-031_ja`).
  `CollectionItemCreate.lang` defaults to `"en"`, and `_add_collection_item`
  computed the effective language as `item.lang or detected_lang or "en"` —
  since the default is truthy, `item.lang` always won even when the caller
  never set it, silently rewriting the target to `PMCG3-031_en`. If that
  English row isn't locally synced, `ensure_card_exists` falls through to a
  live TCGdex fetch, which 500s with no network (as it does in this sandbox)
  and otherwise just adds the wrong-language card. Found while scripting a
  bulk add of a real Japanese card collection through the API — every
  `_ja`-suffixed `card_id` 500'd until `lang` was passed explicitly
  alongside it, which shouldn't be required when the suffix already says so.
  `ensure_card_exists` in the same file already had the correct precedence
  (`detected_lang if has_lang_suffix(card_id) else lang`); `_add_collection_item`
  now mirrors it. Independent branch off bare `main`.
- `feature/custom-card-photos` — custom cards can now get an owner-uploaded
  photo via `POST /api/collection/{item_id}/photo`, same as any synced card.
  Found immediately after the bulk-add above: a custom card's only other
  artwork slot (`image_url`) needs a public HTTPS URL, which a physical card
  with no listing anywhere online — the exact case custom cards exist for —
  can't supply. The upload endpoint refused them outright ("Custom cards
  already have editable artwork"), and the same assumption was baked into
  two frontend spots: `Collection.jsx`'s `hasReferenceArtwork` treated
  `is_custom` alone as proof of having artwork (so an uploaded photo could
  never become the default image for a custom card missing `image_url`),
  and `CollectionCardImage.jsx`'s `showsOwnPhoto` — the shared logic behind
  every grid/list/carousel card view — had the identical `!card.is_custom`
  exclusion. All three removed; `hasApiImage`/`hasCatalogueImage` already
  correctly detect a custom card that *does* have `image_url` set (the
  backend stores it in `images_small`/`images_large` same as a synced
  card), so no new "does this custom card have real art" check was needed.
  Independent branch off bare `main`.
- `fix/batching-respects-provider-capability` — a composite grid asks the
  model to read several cards out of one image, which needs the same
  multi-image capability visual verification already depends on
  (`scanner_capability_mode`, proven once by the `/settings/scanner/test`
  probe and persisted as an endpoint/model-bound proof). `recognize.py`'s
  single-photo path already respected the mode; the batch enqueue path in
  `scan_jobs.py` called `require_scanner_capability_mode(...)` for its
  validation side effect only and discarded the returned mode, so a
  provider proven single-image-only (`degraded`) could still be asked to
  composite whenever the client's per-photo `individual` toggle wasn't set.
  Now `capability_mode` gates `batch_modes` directly — server-side defense
  in depth, not just trusting the frontend's own toggle state. Frontend
  hides the now-pointless "process individually" toggles (per-photo and
  toggle-all) in degraded mode, inferred from
  `scannerConfiguration?.visual_verification !== 'disabled'`. Found while
  auditing an abandoned pre-#355 branch; most of its Gemini-specific
  retry/UI text was already superseded by #355's provider-neutral rewrite,
  but this gate was never carried over. Independent branch off bare
  `main`. Upstream PR: Git-Romer/pokecollector#382.
- `fix/firefox-android-white-canvas-v2` — the app had no opaque
  `background-color` on `html` or `body`; the whole dark appearance
  depended on a single animated gradient image. `body`'s winning
  background rule uses the unlayered `background` shorthand, which resets
  `background-color` to transparent, leaving `body` with only a gradient
  image propagated to the canvas over the browser's default white.
  Chromium extends that propagated image across overscroll/safe-area
  regions; Firefox on Android doesn't, so those regions showed white bars.
  Sets `background-color: var(--color-bg)` on `html` (whose background
  always paints the whole canvas) and restores an opaque colour to
  `body`'s shorthand as a fallback. Cherry-picked from the old fork main,
  where it had already shipped and then silently dropped out when the
  fork was reset to exactly match `upstream/main`. Independent branch off
  bare `main`. Deleted once by mistake mid-session (assumed superseded by
  `testing` content that turned out not to include it) and restored from
  the object store once that was caught. Second commit added after a
  real-device screenshot showed a persistent white strip on the *right*
  edge, at rest rather than only during a bounce gesture -- a different
  bug from the vertical case the first commit targets, where painting a
  colour over it would only have hidden a real horizontal-overflow bug
  rather than fixed it. Nothing at the page root should ever scroll
  sideways, so `overflow-x: hidden` was added to `html, body` to remove
  that scroll surface (and the bounce region it creates) entirely, on top
  of -- not instead of -- the vertical opaque-background fix, which
  remains correct for the legitimate top/bottom overscroll case. No PR
  yet.
- `feature/aud-currency-support` — adds AUD as a third supported display
  currency alongside EUR/USD, generalizing the existing binary EUR/USD
  branching (exchange-rate fetching, CSV/PDF export, Telegram price
  alerts, settings dropdown) to a small currency-keyed lookup instead.
  Reuses the existing Frankfurter-backed live rate lookup with static
  fallbacks the same way EUR/USD already did. Verified with the full
  backend test suite (all passing, plus new targeted tests for the
  changed functions) and a live browser check in an isolated throwaway
  stack (own database, own network, unique container names — the
  production containers were never touched by the actual test run).
  Independent branch off bare `main`. Not meant for upstream, per explicit
  user request.
