# frontend/src/utils/

Mostly pure, source-agnostic helper modules shared across pages and components.
Almost all are deterministic transforms over plain data; a few own narrow browser
side effects by design (`cardLookup.searchGoogleByPhoto`, `photoCompression`'s
canvas work, `artworkRetry`'s in-memory token map, `holoEffects`' asset fetches).
This folder is the "no-UI logic" layer: the rules for prices, variants, currency,
sorting, URL state, scanner timing and trade payloads live here so views stay thin
and the same rule is applied identically everywhere.

## Responsibility

- `oidcAuth.js`: strict completion-response parsing for login, linking and the
  first-account naming challenge. Its injected-request completion runner only
  applies a session for a token response; allowlisted status/code pairs identify
  retryable name errors without rendering provider/server detail text.

- `binderLayout.js`: numbered-side spread pairing, localized layout messages,
  private/public identity-aware location URLs, and stale deep-link resolution.
  It preserves physical gaps and never resolves coordinates to an unrelated
  occupant; removed identities fall back to the tray or explicit copy choices.

- Single source of truth for domain rules: canonical variants, price-field precedence,
  currency conversion, scan-timeout math, language normalization.
- Adapter/glue between three shapes of the same data: API payloads, URL search params,
  and component/editor state (most visibly in `tradeDraft`, `filterUrlState`,
  `pokedexUrlState`).
- Presentational formatting (currency, counts, countdowns, chart axes) kept out of JSX.
- Collection species grouping (`species.js`): the first `dex_ids` entry is the group
  key, names come from `GET /api/pokedex/directory`, sprite URLs are built from the
  dex id, and cards without dex ids return in a separate `other` bucket so trainers,
  energy and manual cards stay reachable.
- One place to mirror backend business logic on the client (`prices.js` re-implements
  `effective_market_price()` / `effective_price_quote()` from
  `backend/services/card_values.py`, including the EUR-labelled `manual` last resort).
- PWA/offline support helpers: `photoCompression` and `memoryBlob` prepare images
  and WebKit-safe upload parts; `publicRoutes` identifies anonymous share paths;
  `artworkRetry` carries in-memory only retry tokens for failed artwork;
  `scannerImages` defines accepted scan image types and `webcamStability` scores
  live frames for auto-capture.

## Design

Consistent, deliberate patterns across all 50 modules:

- **Pure by default.** Almost everything is a deterministic input→output
transform. The documented exceptions are `cardLookup.searchGoogleByPhoto`
(opens a window + triggers a download), `photoCompression` (canvas re-encode),
`artworkRetry` (a module-level retry-token map, never persisted) and
`holoEffects` (network/cache reads of immutable effect assets). No mutations of
inputs — copies via spread/`[...x]`/`new URLSearchParams` before mutating.
- **Defensive null handling.** Optional chaining (`card?.set_ref?.id`) plus `Number()`
  coercion plus `Number.isFinite()` guards. Missing/invalid numeric data degrades to
  `null`, `0`, `-`, or a safe fallback rather than throwing or producing `NaN`.
- **Derived constants from one list.** `cardVariants.VARIANT_DEFINITIONS` is the single
  source for `CARD_VARIANTS` (names) and `VARIANT_PILL_META` (codes + Tailwind classes);
  `tcgdexLanguages` builds its lookup maps and badge class table off `TCGDEX_LANGUAGES`;
  `portfolioChart` derives `portfolioApiPeriod` from `PORTFOLIO_PERIODS`. Names/order are
  written once.
- **Normalization before compare.** Diacritic-stripping (`normalize('NFD')` +
  combining-mark regex) in `textSearch`, `cardVariantEffect`, `printingDetails`;
  `toLowerCase` + alias maps in `cardNumbers` and `tcgdexLanguages`. All "is X equal to Y"
  decisions go through a normalizer.
- **`URLSearchParams` for query state.** Every URL-state module clones into a new
  `URLSearchParams`, mutates, and returns it — the caller owns the React Router navigation.
  Defaults that equal "nothing" are deleted rather than written (`cardSearchUrlState`
  drops `sort_order=asc`; `filterUrlState` drops values equal to the definition default).
- **`Intl` + `date-fns` for locale output.** Currency via `Intl.NumberFormat` (with
  try/catch fallback to `${code} ${n.toFixed(2)}`); dates via `date-fns` `parseISO`/`format`.
- **React Query invalidation as a service.** `queryInvalidation.js` centralises the
  "what cache is now stale after this mutation" matrix instead of scattering it across
  pages.

## Flow

Data flows through these modules in two directions:

**API → view (read path).** A page receives payloads and pipes them through a pure
transform for display:

- `prices.getEffectiveCardPriceDetails(card, variant, priceField)` resolves one
  quote through an ordered candidate list (reverse-holo field map → requested
  field → market), then the allowed TCGplayer fallback (only English, or German
  with `tcgplayer_fallback_allowed`; variant USD field × `price_tcg_usd_to_eur`),
  then the fork's personal last resort — `price_jpy_eur_equivalent`, else
  `manual_value_override` — labelled `source: 'manual'`. `getEffectiveCardPrice`
  returns just the amount, while `getPrimaryCardPrice` wraps it with a final
  `getCardPriceValue` fallback that digs into nested `cardmarket.prices` /
  `pricing.cardmarket`.
- `cardVariants.getAvailableVariants` / `getOwnedVariants` / `getCardOwnedVariants`
  determine which of the four canonical prints exist and which the user owns, collapsing
  condition-only duplicates. `getSelectableVariants` keeps unknown finishes editable,
  excluding only explicit false flags with positive catalogue evidence and no
  contradictory finish price. `getEditableVariants` layers the edit-form rule on top:
  the stored finish stays selectable even when the catalogue now contradicts it.
  `getCardVariantEffectClass` maps a variant to a CSS animation
  class, with `EFFECT_PRIORITY` keeping grouped tiles to a single stable effect.
- `groupCardsByPrint` folds a public binder's flat one-entry-per-print list into
  one-tile-per-card (relying on the API's set→number→variant ordering for contiguity) and
  sums `total_value`.
- `binderCards.sortBinderCards`, `deckProgress`* and `productBatches.buildProductDisplayRows`
  reorder/reshape into display blocks (`productBatches` collapses ≥2 products sharing a
  `batch_id` into an expandable batch block, honouring `expandedBatchIds`).

**View → URL/API (write path).** Component state is serialised outward:

- `filterUrlState.writeFilterUrlState` (and `pokedexUrlState`, `cardSearchUrlState`)
  turn component state into `URLSearchParams`; `readFilterUrlState` reverses it against a
  per-page `definitions` object describing each field's param name, type (`list`/`boolean`/
  scalar) and default. `pokedexUrlState` additionally normalises/validates (generation
  1–9, mode `forms` vs `grouped`, form-family allow-list) so bad params are dropped, not
  echoed.
- `tradeDraft` round-trips a persisted trade: `tradeToDraft` flattens trade items into the
  editor's draft shape (cash lines split by `direction`, card items stamped with synthetic
  `key`s and `maxQuantity: 999`), and `buildTradeUpdatePayload` converts the draft back
  into the API payload, distinguishing existing items by `trade_item_id` and new ones by
  `collection_item_id`/`card_id`. `moneyInput` handles the currency conversion on the way
  in (`formatMoneyInputValue` = amount × rate) and out (`parseMoneyInputValue` = amount ÷
  rate, rounded to 4dp).

**Mutation → cache invalidation.** After a collection/wishlist/photo mutation, callers run
`queryInvalidation.invalidateCardState` / `invalidateCollectionPhotoState` /
`invalidateTcgdexFilterLanguages`, which blast the affected query keys (and
`predicate`-matched families like `card-search`, `pokedex`, `set-checklist`) so cached
tiles re-fetch.

**Scanner timing/attention.** `scannerTimeout` derives request timeouts from a bounded
option set (covering retry/fallback attempts with a headroom constant); `scanJobs` turns a
job into a poll interval (`active` → 3s, else `false`) and aggregates `attention` counts;
`retryCountdown` converts `next_attempt_at` into human labels; `scanSubmitLabel`
separates the prepare (downscale) and upload phases in the submit button.
`scannerGrouping` resolves the scanner's provider-derived default grouping against each
staged photo's tri-state choice (`null` follows the default, `true`/`false` is the
user's), so local models default to individual scans without that ever being stored as
a preference. `scanAllocationNotice` explains a short auto-file shortfall without
implying the add failed, and `settledResults.partitionSettledResults` splits
`Promise.allSettled` batches into succeeded ids and failed results.

**Holocard effects.** `holoEffects` validates the catalogue's holo-effect metadata
(sha256, allowed finishes, design keys) and fetches immutable effect assets;
`holoMotion` maps effect profiles to motion and `holoDeviceMotion` owns the single
permission + orientation stream shared by all card surfaces. Nothing raw from the
sensors is persisted or sent.

## Integration

Consumed from several places (all via relative import `../utils/...` / `../../utils/...`):

- **Pages (`src/pages/`)**: `Collection`, `Wishlist`, `UserCollection`, `Trades`,
  `Pokedex`, `PokedexSpecies`, `SetDetail`, `Sets`, `CardSearch`, `BinderDetail`,
  `DeckEditor`, `ScanQueue`, `Settings`, `OfflineCenter`. These are the primary
  callers — e.g. `Trades` drives `tradeDraft`, `prices`, `cardVariants`; `Sets`
  drives `filterUrlState`; `BinderDetail` drives
  `binderCards`/`binderQuantity`/`binderCounts`; `OfflineCenter` drives
  `artworkRetry`.
- **Hooks (`src/hooks/`)**: `useDynamicFilterUrlState` delegates directly to
  `filterUrlState.read/write` so list/boolean/scalar URL fields work generically.
- **Components (`src/components/`)**: `card-system/CardPriceDetails`,
  `CardItem`, `CardStateIndicators`, `CardScanner`, `UnifiedCardScanner`,
  `ScanReview`, `WebcamCapture` (`webcamStability`), `HoloEffectOverlay` /
  `HoloDeviceMotionController` (`holoEffects`/`holoMotion`/`holoDeviceMotion`),
  `card-lists/CardListGallery`, `card-lists/CardListPicker`, `decks/*`.
- **Offline layer (`src/offline/`)**: `ops/scanSubmit` and `outbox/ops/scanUpload`
  validate scan images/timeouts via `scannerImages`/`constants`; the outbox ops
  invalidate query state via `queryInvalidation` after a replay succeeds.
- **Context (`src/contexts/SettingsContext.jsx`)**: imports `priceFieldFromPrimary` to
  resolve the user's chosen price field.

Cross-module dependencies are minimal and always import "down": `cardListPicker` →
`cardNumbers` + `textSearch`; `productCardPicker` → `textSearch`; `tradeDraft` →
`moneyInput`; `portfolioChart` → `date-fns`; `holoMotion` → `holoDeviceMotion`;
`navigation` → URL builders. `prices`, `cardVariants`, `textSearch`,
`imageUrl` (including its small-scan underlay derivation for large catalogue
frames), `cardmarket`, `cardLookup` and the three URL-state modules are leaf
dependencies used widely and imported by nothing else in this folder.

Most modules (42 of 50) ship a matching `*.test.js` (Vitest) that locks the behaviour;
the tests are the only other files in this directory. `appLanguages`, `artworkRetry`,
`cardmarket`, `cardNumbers`, `holoMotion`, `navigation`, `scannerTimeout` and
`tcgdexLanguages` have no dedicated test file.
