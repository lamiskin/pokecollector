# frontend/src/components/card-system/

## Responsibility

This folder is the **public, feature-facing façade of the card system**. Feature
code (pages and feature-level components) must import card UI *only* from here —
never from the shared primitives directly, and never by assembling its own
page-specific card frame.

It provides:

- **A curated, stable re-export surface** (`index.js`) that maps friendly names to
  the shared card primitives: `CardDisplay`, `CardDialog`, `CardRow` +
  `CardIdentity`, `CardLegend`, `CardStack`, `CardRequirementProgress`,
  `CardPriceDetails`, plus the `CARD_DISPLAY_VARIANTS` / `CARD_SYSTEM_TOKENS`
  constants and the data-normalization helpers from `../UnifiedCard`.
- **The one sanctioned entry point for new visual card behavior** (`CardDisplay`).
  A genuinely new visual treatment is added as a `variant` here (and documented in
  the gallery) rather than as a bespoke component in a page.
- **A handful of card-system-specific leaf components** that are not plain
  aliases: `CardPriceDetails` (price/history presentation), `CardSelectionQuantityModal`
  (binder "add" quantity picker), `CardRequirementProgress` (owned/required badge),
  and `CardStack` (layered print treatment).
- **`CardSystemGallery`**, a DEV-only living example / "executable spec" that shows
  every approved variant and state with synthetic sample cards, used as the visual
  regression surface for the system.

The invariant is enforced in the `CardSystem.test.js` suite: `CardDisplay` throws on
any variant not listed in `CARD_DISPLAY_VARIANTS`, so page-specific variants cannot
silently leak into the shared system.

## Design

### Thin façade over shared primitives

Most files here are one-line delegations to the shared card modules in `../`:

| This file | Delegates to |
|-----------|--------------|
| `CardDisplay.jsx` | `UnifiedCard`, `CardArtworkFrame`, `CompactCardArtwork` (from `../UnifiedCard`) |
| `CardDialog.jsx` | `UnifiedCardDialog` (from `../UnifiedCard`) |
| `CardRow.jsx` | `CardListItem` / `CompactCardIdentity` (from `../CardListItem`) |
| `CardLegend.jsx` | `CardStateLegend` / `CardStateLegendDisclosure` (from `../CardStateIndicators`) |

The rendering primitives stay internal; only the façade and the pure data helpers are
public (see the comment block in `index.js`).

### Variant dispatch (single source of truth)

`tokens.js` freezes `CARD_SYSTEM_TOKENS`, including the **variant whitelist**
(`variants`), which is re-exported as `CARD_DISPLAY_VARIANTS`. `CardDisplay`:

1. Rejects any variant outside the whitelist (`throw`).
2. Maps `artwork` / `compact-artwork` / `comparison` to the artwork-only primitives.
3. Maps everything else to `UnifiedCard`, deriving `compact` for artwork-only
   presentation (`carousel`, `ranking`), and deriving `interactive` from the presence
   of `onClick` / `onSelect`.

### Border/fallback token system

`tokens.css` defines `--pc-card-*` CSS custom properties (border colors for the four
fallback sources — `default`/`data`/`price`/`image` — plus frame/art radii, compact
sizing, caption height). `tokens.js` mirrors the border colors as JS values consumed
by `getFallbackBorderGradient` in `../UnifiedCard`, so the same source-of-truth drives
both the CSS variables and the inline `conic-gradient` fallback borders.
`styles.css` layers the frame/animation classes (`unified-card-frame`,
`unified-card-add`, `unified-card-selection`, shimmer keyframes, etc.) under
`@layer components`, with `clsx` used for conditional composition throughout.

### Data helpers as public API

`index.js` re-exports pure helpers from `../UnifiedCard` so pages can normalize API
rows *before* handing them to a visual component:

- `getCardFallbackKinds` — detect `data`/`price`/`image` source-language fallbacks.
- `getCardSetNumber` — derive the `SET NUMBER` monospace label from set ref + number.
- `getFallbackBorderGradient` — map fallback kinds to a border gradient.
- `shouldDimUnownedCard` — dim unowned cards when requested.
- `withCollectionItemState` — merge a collection item's quantity into `owned` /
  `owned_quantity` / `owned_variants`.

### `CardPriceDetails` as a self-contained, testable data component

This is the one folder component with real logic. Its pure breakdown functions
(`cardmarketPriceBreakdown`, `tcgplayerPriceBreakdown`) are exported and unit-tested
separately from the React rendering (see `CardPriceDetails.test.jsx`), while the
component itself handles fetching and charting price history. Variant handling is
explicit: a "Reverse Holo" copy prefers the `*_holo` Cardmarket fields and falls back
to the regular fields when absent.

### Composition & controlled components

- `CardStack` composes layered `CardDisplay variant="artwork"` frames behind a
  front frame to render a "pile of cards".
- `CardRequirementProgress` is a pure presentational badge (`owned/required`, or a
  green check when complete) shared by planned Card List tiles.
- `CardSelectionQuantityModal` is fully controlled: it takes `items`,
  `quantities` (a `{id → string}` map), `onQuantityChange`, `onSubmit`, `isSubmitting`
  and delegates to the shared `ui/Modal` + `utils/binderQuantity` helpers.

## Flow

### Data flow (pages → primitives)

1. A page fetches card rows from the API and normalizes them with the re-exported
   helpers (`withCollectionItemState`, `getCardSetNumber`, `getCardPriceValue` /
   `getPrimaryCardPrice` from `utils/prices`).
2. The normalized `card` object, plus an `image` URL and optional `price`, are passed
   to `CardDisplay` / `CardRow` / `CardIdentity`.
3. The façade delegates to a shared primitive, which **derives** presentation from the
   card: `getCardFallbackKinds` → border gradient; `CardStateIndicators` → owned
   variants / wishlist / custom badges; `getCardVariantEffectClass` → foil shine;
   `CardCaption` / `CompactCardIdentity` → name + set number + price caption.
4. The primitive renders a `CardImage` (lazy by default) and wires image load/error
   status back up through `onLoadingChange` / `onImageStatusChange` for skeletons and
   retry.

### `CardPriceDetails` data flow

- Inputs: `card`, `variant`, optional `summary` node (collection-specific content
  injected above the shared details).
- Fetches history via React Query — `useQuery(['price-history', cardId])` →
  `getPriceHistory(cardId)` (only when a stable `card_id`/string `id` exists),
  5-minute `staleTime`, `retry: false`.
- Renders, in order: `summary` slot → Cardmarket section (primary price + breakdown
  grid) → Suruga-ya section (`price_jpy_*` fields, JPY-formatted) → purchase links
  (`cardmarketLinks`) → TCGPlayer section → price-history `AreaChart` with a
  first-vs-last percentage change footer.

### Control flow

- Pointer/keyboard activation: `CardArtworkFrame` renders an invisible primary-action
  button and an "add" overlay button; `handleKeyboardActivation` routes Enter/Space to
  `onClick` or `onSelect`. `interactive` is derived from whether a handler exists.
- `CardSelectionQuantityModal` is controlled by its parent: it computes validity from
  `binderPickerQuantitiesAreValid`, clamps via `clampBinderPickerQuantity`, and disables
  submit while invalid or submitting.
- `CardDialog` (via `UnifiedCardDialog`) is an uncontrolled portal with tab
  navigation, a focus trap, Escape handling that defers to the zoom overlay, and
  focus restoration on close.
- `CardLegend` toggles between the always-visible `CardStateLegend` and the
  disclosure-wrapped `CardStateLegendDisclosure` via a `collapsible` prop.

## Integration

### Consumers (pages / feature components)

`card-system` is imported across the app; every card surface routes through it:

- **Pages**: `Collection`, `UserCollection`, `Wishlist`, `SetDetail`, `CardSearch`,
  `BinderDetail`, `PublicBinderView`, `Dashboard`, `HomeScreen`, `Leaderboard`,
  `Trades`, `Compare`, `Products`, `PokedexSpecies`, `CardMigration`.
- **Feature components**: `CardScanner`, `CollectionCardImage`,
  `decks/DeckCardViewer`, `card-lists/CardListPicker`, `card-lists/CardListGallery`.
- **Route**: `App.jsx` lazy-loads `CardSystemGallery` and mounts it at the DEV-only
  route `/__card-system`.

### API

- `CardPriceDetails` → `getPriceHistory` from `api/client` (`GET /cards/:id/price-history`),
  the only direct API call in this folder.

### Contexts

- `useSettings` (from `contexts/SettingsContext`) supplies `t` (i18n), `formatPrice`,
  `formatUsdPrice`, `pricePrimary`, `pricePrimaryField`, and currency, used by
  `CardPriceDetails`, `CardSystemGallery`, and (indirectly) every shared primitive.

### Shared modules / utils

- `../UnifiedCard` — core `UnifiedCard`, `CardArtworkFrame`, `CompactCardArtwork`,
  `UnifiedCardDialog`, `CardCaption`, and the re-exported data helpers.
- `../CardStateIndicators` — ownership/wishlist badges and the legend.
- `../CardListItem` — row + compact identity.
- `../CardImage`, `../FallbackBadges`, `../ImageZoomOverlay`, `../ui/Modal`,
  `../CardStateIndicators` (legend) — rendering dependencies of the primitives.
- `utils/prices` — `getCardPriceValue`, `getPrimaryCardPrice`, `formatJpy`.
- `utils/cardmarket` — `cardmarketLinks` (product links with fallback search).
- `utils/binderQuantity` — picker quantity clamping/validation.
- `utils/cardVariantEffect` — foil/holo shine class (used by `CardArtworkFrame`).

### Tests

- `CardSystem.test.js` — public API surface: every `CardDisplay` variant renders,
  unsupported variants throw, row/identity/legend/stack building blocks work,
  `CardRequirementProgress` states.
- `CardPriceDetails.test.jsx` — breakdown helpers and shared-details rendering
  (Cardmarket / TCGPlayer / summary slot / secondary-only price omission).
- `CardSystemGallery.test.jsx` — currency formatting of synthetic samples.
