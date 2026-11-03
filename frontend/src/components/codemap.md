# frontend/src/components/

Shared React component layer for the PokéCollector frontend: presentational
primitives, the card artwork/display system, navigation chrome, and the
scanner/review flow. Components here are leaves or small composites that pages
assemble; application state and server data live in `../contexts`, `../hooks`,
and `../api`, and `../pages` owns routing and orchestration.

## Responsibility

- **Card rendering** — `UnifiedCard`, `CardImage`, `CollectionCardImage`, and the
  `card-system/` package render card artwork, fallback states, ownership/wishlist
  badges, and captions consistently across grids, lists, rows, tables, dialogs,
  dashboards, and trades.
- **Card detail & editing** — `CardItem` (grid tile, `CardModal` detail dialog,
  `CustomCardModal` creator), `CardListItem` (compact list identity/row).
- **Scanning** — `UnifiedCardScanner` (multi-file capture → `enqueueScanJob`),
  `ScanReview` (persistent batch review: `ScanItemPanel`, `CandidateGrid`,
  `CardZoomModal`), and `CardScanner`'s `ScanAddModal` (add a match to the
  collection with best-effort own-photo attach). `CardScanner` retains the
  single-shot inline scan flow.
- **Navigation chrome** — `Layout` (route shell + `<Outlet/>`), `AppNav` (top
  title strip + floating Pokéball home button), `TabNav` / `AnalyticsSectionNav`
  (sub-nav tabs), `PublicHomeButton` (public directory entry point). `Sidebar`
  (desktop) and `BottomNav` (mobile) are legacy and not currently mounted.
- **Form & config widgets** — `MoneyInput`, `PeriodSelector`,
  `PrintingDetailSelector` / `PrintingDetailTagManager` / `PrintingDetailBadges`,
  `AvatarPicker`, `TcgdexLanguageSelect`, `PokedexGenerationFilter`.
- **Feedback & loading** — `SyncStatus`, `ActionErrorNotice`, `PokeBallLoader`,
  `AuthStartupScreen`, `FallbackBadges`, `ImageZoomOverlay`,
  `CardStateIndicators` (+ `CardStateLegend`, `CardStateLegendDisclosure`),
  `TrainerCard`, `ProductSourceList`, `ScannerSettingsCard`.

## Subareas

| Directory | Purpose | Codemap |
| --- | --- | --- |
| `ui/` | Dependency-free shells: `Modal`, `Sheet`, `ConfirmDialog`, `OverflowMenu`, `Badge`, `Card`, and `dialogBehavior` (focus trap + Escape handling). | [ui/codemap.md](ui/codemap.md) |
| `card-system/` | Card rendering tokens + primitives (`CardDisplay`, `CardRow`, `CardIdentity`, `CardPriceDetails`, `CardStack`, `CardDialog`, `CardLegend`, `CardRequirementProgress`, `CardSelectionQuantityModal`, `CardSystemGallery`) with barrel `index.js`. | [card-system/codemap.md](card-system/codemap.md) |
| `decks/` | Deck analytics/validation/composition visuals (`DeckAnalyticsPanel`, `DeckAnalyticsVisuals`, `DeckCompositionBar`, `DeckCardViewer`, `DeckValidationPanel`). | [decks/codemap.md](decks/codemap.md) |
| `card-lists/` | `CardListPicker`, `CardListGallery`. | [card-lists/codemap.md](card-lists/codemap.md) |
| `binders/` | `BinderCsvImportModal`. | [binders/codemap.md](binders/codemap.md) |
| `public/` | `PublicProfileShell` (public profile layout, reuses `TabNav`). | [public/codemap.md](public/codemap.md) |

## Design

- **Layered composition.** `ui/` primitives are dependency-free shells;
  `card-system/` adds the card visual language (borders, variant/fallback tones
  via `tokens.js`/`tokens.css`); `UnifiedCard` composes `CardImage`,
  `CardStateIndicators`, `FallbackBadges`, and `ImageZoomOverlay` into
  `CardArtworkFrame`, `CompactCardArtwork`, and `UnifiedCardDialog`.
- **Data helpers are exported, rendering stays internal.** `card-system/index.js`
  re-exports `getCardFallbackKinds`, `getCardSetNumber`, `withCollectionItemState`,
  `shouldDimUnownedCard`, etc. from `UnifiedCard` so pages can normalize API rows
  before handing them to a visual component.
- **Contexts over prop-drilling.** Global concerns come from `useSettings`
  (`t`, `formatPrice`, `currencySymbol`, `exchangeRateReady`, `settings`) and
  `useAuth` (`user`, `logout`, `multiUser`); server data is fetched inside
  components with TanStack Query (`Sidebar`, `SyncStatus`, `PrintingDetailSelector`,
  `CollectionCardImage`).
- **Own-photo priority.** `CollectionCardImage` chooses between catalogue artwork
  and the owner's private scan photo (`showsOwnPhoto`, `useCollectionPhotoResource`,
  `useCollectionPhotoUrl`), honoring the `prefer_own_card_photos` setting. The
  `CollectionCardDisplay` / `CollectionCardIdentity` / `CollectionCardRow`
  wrappers re-render that same resolution through `card-system` and add the
  own-photo marker.

## Flow

1. **Scan → add.** `UnifiedCardScanner` stages files (camera/gallery), calls
   `enqueueScanJob`, then navigates to `/scans`. `ScanReview` renders each queued
   item (`ScanItemPanel`) with candidate matches (`CandidateGrid`) and a
   linked-zoom `CardZoomModal`. Confirming a match opens `ScanAddModal`
   (`CardScanner.jsx`), which adds to the collection and best-effort attaches the
   scan photo via `attachScanFallbackPhoto` — a photo failure never blocks the add.
2. **Display.** Pages fetch collection/search/set rows, normalize them with
   `withCollectionItemState` (owned/quantity/variant), and render through
   `CollectionCardDisplay` / `CollectionCardIdentity` / `CollectionCardRow` or a
   bare `UnifiedCard`/`CardImage`. `CardImage` lazy-loads on viewport
   intersection, retries failed URLs, and falls back to the card back.
3. **Detail.** `CardItem`'s `CardModal` / `UnifiedCardDialog` open a portal dialog
   with artwork, tabbed content, and an `ImageZoomOverlay` for full-size pan/zoom;
   `CardListItem` / `CompactCardIdentity` provide the compact clickable-row
   equivalent.
4. **Editing/forms.** `MoneyInput` disables until the exchange rate is ready;
   `PeriodSelector` maps period keys to price fields and date cutoffs;
   `PrintingDetailSelector` / `PrintingDetailTagManager` read/write the shared
   `printing-detail-tags` query and invalidate caches on change.

## Integration

- **Routing shell.** `Layout` wraps the protected `<Outlet/>` and mounts `AppNav`
  (hidden on `/`); `App.jsx` wraps everything in `AuthProvider` →
  `SettingsProvider` → `ConfirmDialogProvider` → `BrowserRouter`, and renders
  `PublicHomeButton` inside the `/u` public routes. `AuthStartupScreen` and
  `PokeBallLoader` gate the auth-loading and route-lazy states.
- **Contexts.** `AuthContext` (user/logout/multiUser), `SettingsContext`
  (i18n `t`, price formatting, currency), `ConfirmDialogContext`
  (`useConfirmDialog` in `PrintingDetailTagManager` and the scanners).
- **Pages** import these components directly — e.g. `Collection` (MoneyInput,
  PrintingDetailSelector/TagManager, CollectionCard*), `CardSearch` (CardItem,
  CustomCardModal, UnifiedCardScanner, PrintingDetailSelector), `ScanQueue`
  (ScanAddModal, ScanReview), `Products`/`Analytics` (PeriodSelector, MoneyInput,
  CollectionCard*, AnalyticsSectionNav), `Dashboard` (TrainerCard,
  CollectionCardDisplay), `Settings`/`Binders` (AvatarPicker), `Trades`
  (MoneyInput, CustomCardModal), and `CardModal` consumers (`UserCollection`,
  `Wishlist`, `Leaderboard`, `SetDetail`, `Compare`, `PokedexSpecies`).
