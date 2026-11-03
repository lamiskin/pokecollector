# frontend/src/components/decks/

Deck presentation and editing UI. This folder owns everything that renders a single
deck's state — composition, validation, analytics/probability — plus the modal used to
edit individual card entries, and the reusable chart/metric primitives shared by the
deck editor, the public deck view, and the deck-comparison page.

## Files

- `DeckAnalyticsPanel.jsx` — default export. Tabbed analytics view (overview, pokémon,
  trainers/energy, attacks, consistency, probability, comparison).
- `DeckAnalyticsVisuals.jsx` — named exports only. Presentational chart/metric primitives
  built on `recharts` plus the shared color constants.
- `DeckCardViewer.jsx` — default export. Modal (`CardDialog`) for one deck entry:
  quantity +/−, remove, and print switching.
- `DeckCompositionBar.jsx` — default export. Segmented bar of Pokémon/Trainer/Energy/Other
  with progress + missing-copies summary.
- `DeckValidationPanel.jsx` — default export. Collapsible validation checklist; supports a
  `compact` one-line form for headers.

## Responsibility

- Render deck state as UI without owning any data: every component is controlled — it
  receives the deck/analysis/entries plus callbacks and a `t` translator from its parent.
- `DeckAnalyticsPanel` is the main read-only analytics surface; `DeckCompositionBar` and
  `DeckValidationPanel` are the compact "at a glance" summaries; `DeckCardViewer` is the
  only component here that mutates state (via callbacks, not directly).
- `DeckAnalyticsVisuals` is a pure primitives library (sections, metric grids, probability
  bars, donut, paired-comparison bars) with zero data or API coupling.

## Design

- **Controlled + translation-injected**: components take `t` and an interpolation helper
  `label(key, values)` (a `{placeholder}` string replacement) so all copy resolves through
  `decks.*` / `effects.*` i18n keys. No component calls `useSettings` directly.
- **Shared primitives**: `DeckAnalyticsVisuals` exports `DeckAnalyticsSection`,
  `DeckMetricGrid`, `DeckProbabilityBar`, `DeckCompositionDonut`, `DeckPairLegend`,
  `DeckPairedBar`, `DeckSideMetricCard`, and `DECK_COMPOSITION_COLORS` /
  `DECK_COMPARISON_COLORS` (left=blue, right=violet). `DeckCompare.jsx` imports these
  directly rather than duplicating them.
- **Color/label maps as data**: `DeckAnalyticsPanel` keeps static maps of
  stage/type/trainer/attack-kind/cost/effect → hex color and translation key, so the
  renderer stays declarative. `TYPE_ALIASES` + `normalizeType` (NFD diacritic stripping,
  lowercase) fold localized type names into canonical keys.
- **A11y-first markup**: `role="tablist"` / `role="tab"` / `aria-selected`,
  `aria-expanded`, `aria-label` on inputs, `aria-live="polite"` on the quantity readout.
  `data-*` attributes (`data-analytics-row`, `data-composition-donut`, `data-deck-pair`,
  `data-comparison-metric`) are stable test hooks.
- **Design tokens via Tailwind classes**: `text-text-primary`, `bg-bg-card`, `border-border`,
  `bg-brand-red`, `text-green`/`text-yellow`, plus utility classes `card`, `input`,
  `select`, `btn-primary`, `btn-ghost`, `skeleton`.
- **Charting**: only the composition donut uses a chart library (`recharts`
  `PieChart`/`Pie`/`Cell`); bars are plain divs with percentage widths.

## Flow

- **Data in** comes from a deck object returned by the API: `entries[]`, `analysis`
  (`composition`, `pokemon`, `trainers`, `energy`, `attacks`, `diversity`, `effects`),
  `validation` (`valid`, `errors[]`, `checks[]`), `composition_counts`,
  `card_count`/`target_size`/`status`, `binder_type`, `format`.
- **`DeckCompositionBar`** calls `deckComposition(entries, progress.target, compositionCounts)`
  from `utils/deckProgress`, which groups entries by `card.supertype` into the four
  categories, uses server `compositionCounts` when provided, and returns segment widths plus
  the remaining-gap percentage shown as an empty filler segment.
- **`DeckValidationPanel`** maps each `check.code` (`deck_size`, `basic_pokemon`,
  `copy_limit`, `ownership`, `format_legality`) to `decks.validation<Code><Pass|Fail|Unavailable>`
  keys, interpolates `check.details`, and on expand renders `violations[]`, `cards[]`
  (missing copies), and `illegal_cards[]`.
- **`DeckAnalyticsPanel`** holds its own tab state and renders the `analysis` sections; the
  probability tab fetches via React Query (`getDeckProbability` with controlled
  hand/draws/prize/key-card inputs), and the comparison tab lists `getDecks` then navigates
  to `/decks/compare?left=…&right=…`. `probabilityFetcher`/`probabilityQueryKey` are
  injectable so the public view can point at its own endpoint.
- **`DeckCardViewer`** is fully callback-driven: `onQuantityChange(entry, delta)`,
  `onRemove(entry)`, `onSwitchPrint(id)`, `onPrevious`/`onNext` (also wired to Arrow keys).
  It computes a stats row (required/owned/allocated/available/shortage) from the entry and,
  for real decks, renders `allocated_prints` with `PrintingDetailBadges`.

## Integration

- **Pages**
  - `pages/DeckEditor.jsx` — editor/analytics tabs; renders `DeckCompositionBar`,
    `DeckValidationPanel`, `DeckAnalyticsPanel`, and drives `DeckCardViewer` with its
    mutation callbacks and `equivalentPrints` state.
  - `pages/PublicDeckView.jsx` — read-only: `compact` validation in the header, composition
    bar, and `DeckAnalyticsPanel` with a public probability fetcher and `showComparison={false}`.
  - `pages/DeckCompare.jsx` — does not use the panel; imports the `DeckAnalyticsVisuals`
    primitives + color constants directly for its side-by-side rendering.
- **API** (`api/client.js`): `getDeck`, `getDecks`, `getDeckProbability`,
  `compareDecks`, plus the entry-mutation helpers the editor uses. Public equivalents live
  in `api/publicClient.js` (`getPublicDeck`, `getPublicDeckProbability`).
- **Utils** (`utils/deckProgress.js`): `deckComposition`, `deckProgress`,
  `groupDeckEntries`, `sortDeckEntries`, `next/previousDeckCardIndex`.
- **Shared components**: `CardDialog` (`../card-system`), `CollectionCardDisplay`,
  `PrintingDetailBadges`, `CardListGallery`.
- **i18n**: `t`/`formatPrice` come from `SettingsContext` via `useSettings`; keys use the
  `decks.*`, `effects.*`, `cardTabs.*`, and `binderTypes.*` namespaces.
