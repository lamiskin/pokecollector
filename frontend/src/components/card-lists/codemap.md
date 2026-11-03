# frontend/src/components/card-lists/

## Responsibility

This folder contains the UI for rendering and composing *lists of cards* — the
read-only gallery that shows what a binder/deck/wishlist contains, and the
interactive picker used to add or edit the cards in such a list. It is a
presentation/selection layer: it knows nothing about persistence or routing,
and receives all data, constraints and callbacks as props.

Two components share this job:

- **`CardListGallery`** — a pure, presentational grid. Given a list of
  `entries`, it renders a responsive card grid in one of two display modes:
  - `planned` — the owner's private view of a list they are building, with
    per-card "owned / required" progress, dimmed unowned cards, and state
    indicators showing actual collection quantity.
  - `public` — a shared/read-only view that deliberately hides ownership
    information (owned quantity, collection ids, scan photos) and instead
    shows market price, a "wanted ×N" badge, and a public detail line.
- **`CardListPicker`** — the full-featured, stateful card-selection surface.
  It lets a user search and filter their owned collection (or the live card
  catalog), toggle cards into a working selection, choose quantities, and
  submit the result via an `onSubmit(items)` callback. It supports two
  selection modes (`card` = one row per distinct card, `collection-item` =
  one row per exact physical copy, preserving variant/condition/printing
  details).

## Design

- **Shared card-system primitives, no bespoke rendering.** Both components
  delegate every tile to the shared `../card-system` (`CardDisplay`,
  `CardRequirementProgress`, `withCollectionItemState`,
  `CardSelectionQuantityModal`) and to `../CollectionCardImage`
  (`CollectionCardDisplay`). They only compute *which* card, *what* price,
  and *what* captions/overlays, then hand off the visuals.
- **Gallery is dumb; picker is the brain.** `CardListGallery` has no hooks and
  no side effects — it is a pure function of `entries` + render helpers, which
  makes it trivially testable via `renderToStaticMarkup` (see
  `CardListGallery.test.jsx`). All interactivity lives in `CardListPicker`.
- **Normalization at the edges.** Both files defensively unwrap two API shapes:
  an entry may nest the card under `entry.card`, or flatten card fields onto the
  entry itself (`const card = entry.card || entry`). `CardListGallery` and
  `CardListPicker` both reconcile `required_quantity`/`owned_quantity`/
  `available_quantity` and clamp them with `Math.max`/`Math.min` so a grid
  never crashes on a missing field.
- **Two-mode abstraction.** `CardListGallery` branches on `mode` into distinct
  render paths (`publicView` uses `CardDisplay`; `planned` uses
  `CollectionCardDisplay`). `CardListPicker` branches on `selectionMode`
  (`exactCopyMode` = `collection-item`), which changes aggregation, filtering,
  keys, and the availability semantics.
- **Pure utility functions extracted to `../../utils`.** Filtering
  (`filterCollectionCards`, `filterExactCollectionItems`), option derivation
  (`cardListPickerOptions`), aggregation (`aggregateCollectionItems`), and
  quantity clamping/validation (`binderQuantity.js`) are all testable,
  side-effect-free helpers. `CardListPicker` keeps only a thin local
  `pickerItem` normalizer (card → selectable `{id, card, sourceItem, name,
  subtitle, image, maxQuantity}`).
- **Debounced + gated catalog query.** Catalog search uses
  `useDebouncedValue(search, 300)` and a TanStack Query `useQuery` that is
  `enabled` only when the picker is open, catalog mode is allowed and active,
  and the query is ≥ 2 characters — so the network is only hit on a real,
  settled search term.
- **Accessibility & responsive plumbing.** Tabs use `role="tablist"`/
  `role="tab"`/`aria-selected`; filters use `aria-label`; the section has an
  `aria-controls`/`aria-expanded` collapse toggle; and there is a mobile-only
  sticky "add" bar (`sm:hidden`) duplicating the desktop header action.

## Flow

**`CardListGallery` (read-only):**
1. Receives already-normalized `entries` plus render helpers (`t`,
   `formatPrice`, `label`, `pricePrimaryField`, `publicQuantityLabel`,
   `publicDetailLabel`).
2. For each entry: extract `card`, compute `requiredQuantity` (falling back to
   `card.required_quantity` → `card.quantity` → 1) and `ownedQuantity`
   (clamped to `requiredQuantity`, from `available_quantity` →
   `owned_quantity` → `card.owned_quantity`), and resolve `variant`.
3. Compute `price`: `market_value` for public mode, otherwise
   `getEffectiveCardPrice(card, variant, pricePrimaryField)` (holo-variant
   aware, with price-field fallbacks).
4. Build a `displayCard`/`stateItem`/`collectionItem` shape and render either
   `CardDisplay` (public: price, language, public quantity badge, public detail
   line) or `CollectionCardDisplay` (planned: own-photo aware, dimmed when
   unowned, `CardRequirementProgress` caption, collection-state indicators).

**`CardListPicker` (add/edit):**
1. Derives from props: an `aggregatedCollection` (grouping duplicate copies by
   card id, summing quantity) via `useMemo`, filter options, a variant list,
   and `Set`-based membership for already-added and unavailable items.
2. Tracks UI state: `source` (`owned` | `catalog`), filters (`search`, `type`,
   `set`, `language`, `variant`, `condition`), `selectedItems`, and pagination
   (`visibleCount`, `PAGE_SIZE = 24`).
3. `source === 'owned'` → filters the collection client-side
   (`filterCollectionCards` for `card` mode, `filterExactCollectionItems` for
   `collection-item` mode) and slices to `visibleCount`.
   `source === 'catalog'` → `searchCards` via React Query, page size =
   `visibleCount`.
4. Clicking a card toggles it in `selectedItems`, rejecting already-added and
   unavailable (max-quantity-reached) items; catalog clicks use
   `CardDisplay`, owned clicks use `CollectionCardDisplay` (with state
   indicators and, in `exactCopyMode`, a bottom overlay of variant/condition/
   printing details).
5. "Add (n)" → `prepareQuantities` builds `quantityItems`, clamps initial
   quantities, and opens `CardSelectionQuantityModal`.
6. Modal submit → `submitQuantities` validates via
   `binderPickerQuantitiesAreValid`, calls `onSubmit(items)`, then prunes the
   ids reported as succeeded (`result.succeededIds`, defaulting to all) from
   the selection and quantities so the user can keep adding.

## Integration

- **`../card-system`** — `CardDisplay` (canonical catalogue card tile),
  `CardRequirementProgress` (owned/required progress caption),
  `withCollectionItemState` (normalizes a collection row into a display card
  carrying owned state), and `CardSelectionQuantityModal` (the quantity-entry
  dialog). This is the shared visual language the whole app renders cards
  through.
- **`../CollectionCardImage`** — `CollectionCardDisplay`, the
  collection-aware wrapper that resolves an owner's private scan photo vs.
  catalogue artwork and draws the own-photo badge. The gallery uses it for
  the planned mode; the picker uses it for owned-source tiles.
- **`../../api/client`** — `searchCards` is the only network call made here,
  backing the catalog tab with paginated, lang-agnostic search.
- **`../../hooks/useDebouncedValue`** — 300 ms debounce for the catalog query.
- **`../../utils/prices`** — `getEffectiveCardPrice` implements the
  variant/price-field fallback chain mirroring the backend's
  `effective_market_price`.
- **`../../utils/imageUrl`** — `resolveCardImageUrl` turns a card into its
  image URL.
- **`../../utils/cardNumbers`, `../../utils/textSearch`,
  `../../utils/printingDetails`** — the search/filter matching primitives
  (shortcode parsing, normalized text includes, card-number matching,
  printing-detail names).
- **`../../utils/binderQuantity`** — quantity max/clamp/validate logic shared
  with binder flows.
- **`../../utils/cardListPicker`** — aggregation, filtering, and
  filter-option derivation used by the picker.
- **`../../contexts/SettingsContext`** — consumed indirectly via
  `CollectionCardDisplay` (for `t`, settings such as
  `prefer_own_card_photos`); the gallery test mocks it to an identity `t`.
- **TanStack Query** — powers both the catalog search and (through
  `CollectionCardDisplay`) the per-item own-photo fetch with a shared cache
  key.
