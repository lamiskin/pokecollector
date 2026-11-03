# frontend/src/utils/

Pure, side-effect-free helper modules shared across pages and components. No React, no
fetch/network calls, no context — just deterministic transforms over plain data. This
folder is the "no-UI logic" layer of the frontend: the rules for prices, variants,
currency, sorting, URL state, scanner timing and trade payloads live here so views stay
thin and the same rule is applied identically everywhere.

## Responsibility

- Single source of truth for domain rules: canonical variants, price-field precedence,
  currency conversion, scan-timeout math, language normalization.
- Adapter/glue between three shapes of the same data: API payloads, URL search params,
  and component/editor state (most visibly in `tradeDraft`, `filterUrlState`,
  `pokedexUrlState`).
- Presentational formatting (currency, counts, countdowns, chart axes) kept out of JSX.
- One place to mirror backend business logic on the client (`prices.js` re-implements
  `effective_market_price()` from `backend/services/card_values.py`).

## Design

Consistent, deliberate patterns across all 35 modules:

- **Pure functions.** Everything except `cardLookup.searchGoogleByPhoto` (opens a window +
  triggers a download) is a deterministic input→output transform. No mutations of inputs —
  copies via spread/`[...x]`/`new URLSearchParams` before mutating.
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

- `prices.getEffectiveCardPrice(card, variant, priceField)` resolves one number through an
  ordered candidate list (reverse-holo field map → requested field → market → JPY-EUR
  fallback → manual override), mirroring the backend's precedence. `getPrimaryCardPrice`
  wraps it with a final `getCardPriceValue` fallback that digs into nested
  `cardmarket.prices` / `pricing.cardmarket`.
- `cardVariants.getAvailableVariants` / `getOwnedVariants` / `getCardOwnedVariants`
  determine which of the four canonical prints exist and which the user owns, collapsing
  condition-only duplicates; `getCardVariantEffectClass` maps a variant to a CSS animation
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
`retryCountdown` converts `next_attempt_at` into human labels.

## Integration

Consumed from three places (all via relative import `../utils/...` / `../../utils/...`):

- **Pages (`src/pages/`)**: `Collection`, `Wishlist`, `UserCollection`, `Trades`,
  `Pokedex`, `PokedexSpecies`, `SetDetail`, `Sets`, `CardSearch`, `BinderDetail`,
  `ScanQueue`, `Settings`. These are the primary callers — e.g. `Trades` drives
  `tradeDraft`, `prices`, `cardVariants`; `Sets` drives `filterUrlState`; `BinderDetail`
  drives `binderCards`/`binderQuantity`/`binderCounts`.
- **Hooks (`src/hooks/`)**: `useDynamicFilterUrlState` delegates directly to
  `filterUrlState.read/write` so list/boolean/scalar URL fields work generically.
- **Components (`src/components/`)**: `card-system/CardPriceDetails`,
  `CardItem`, `CardStateIndicators`, `CardScanner`, `UnifiedCardScanner`, `ScanReview`,
  `card-lists/CardListGallery`, `card-lists/CardListPicker`, `decks/*`.
- **Context (`src/contexts/SettingsContext.jsx`)**: imports `priceFieldFromPrimary` to
  resolve the user's chosen price field.

Cross-module dependencies are minimal and always import "down": `cardListPicker` →
`cardNumbers` + `textSearch`; `productCardPicker` → `textSearch`; `tradeDraft` →
`moneyInput`; `portfolioChart` → `date-fns`. `prices`, `cardVariants`, `textSearch`,
`imageUrl`, `cardmarket`, `cardLookup` and the three URL-state modules are leaf
dependencies used widely and imported by nothing else in this folder.

Each module ships a matching `*.test.js` (Vitest) that locks the pure behaviour; the tests
are the only other files in this directory.
