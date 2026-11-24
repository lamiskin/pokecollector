# frontend/src/components/

Shared React component layer for the PokéCollector frontend: presentational
primitives, the card artwork/display system, navigation and offline/sync chrome,
and the scanner/review flow. Components here are leaves or small composites that
pages assemble; application state and server data live in `../contexts`,
`../hooks`, `../offline` and `../api`, and `../pages` owns routing and
orchestration.

## Responsibility

- **Card rendering** — `UnifiedCard`, `CardImage`, `CollectionCardImage`, and the
  `card-system/` package render card artwork, fallback states, ownership/wishlist
  badges, and captions consistently across grids, lists, rows, tables, dialogs,
  dashboards, and trades.
- **Card detail & editing** — `CardItem` (grid tile, `CardModal` detail dialog,
  `CustomCardModal` creator), `CardListItem` (compact list identity/row).
- **Grouping chrome** — `CardGroupSection` is the collapsible header (sprite, dex
  number, counts, value) shared by the Collection's species grid and the
  Analytics species list; each caller keeps its own card rendering inside.
- **Windowing / virtualization** — `WindowedCardGrid` (backed by
  `@tanstack/react-virtual`) renders large card sets in buffered grid rows using
  the nearest vertical scroller or the page window. It backs the collection
  grid, card-list gallery/picker, set/pokedex/custom-card grids, public binder
  tiles, scan-review candidates and the scanner's staged-file grid.
- **Scanning** — `UnifiedCardScanner` (multi-file/webcam capture → offline batch
  submit or `enqueueScanJob`), `ScanReview` (persistent batch review:
  `ScanItemPanel`, windowed `CandidateGrid`, `CardZoomModal`), `ScanCustomCardModal`
  (turn a photo no candidate matched into a custom card and collection item), and
  `CardScanner`'s `ScanAddModal` (add a match to the collection with best-effort
  own-photo attach). `CardScanner` retains the single-shot inline scan flow.
- **Navigation chrome** — `Layout` (route shell + `<Outlet/>`, offline strips),
  `AppNav` (top title strip + floating Pokéball home button), `TabNav` /
  `AnalyticsSectionNav` (sub-nav tabs), `PublicHomeButton` (public directory entry
  point).
- **Offline / sync chrome** — `components/sync/` (banner, stale-data label, queue
  controls and storage summary, server sync settings, logout guard) and
  `components/pwa/` (install hint, update banner, notifications, collection
  download), plus `OfflineUnavailable` for server-only pages while offline.
- **Bulk actions** — `BulkRemovalToolbar` (+ `BulkRemovalToggle`/`BulkRemovalActions`)
  driven by `useBulkRemoval` in Collection, BinderDetail and DeckEditor.
- **Form & config widgets** — `MoneyInput`, `PeriodSelector`,
  `PrintingDetailSelector` / `PrintingDetailTagManager` / `PrintingDetailBadges`,
  `AvatarPicker`, `TcgdexLanguageSelect`, `PokedexGenerationFilter`, `SetName`
  (set label with optional translated-name tooltip).
- **Feedback & loading** — `OfflineBanner`/`StaleDataLabel` (sync/),
  `ActionErrorNotice`, `PokeBallLoader`, `AuthStartupScreen`, `FallbackBadges`,
  `ImageZoomOverlay`, `CardStateIndicators` (+ `CardStateLegend`,
  `CardStateLegendDisclosure`), `TrainerCard`, `ProductSourceList`,
  `ScannerSettingsCard`, `HoloDeviceMotionController`.

## Subareas

| Directory | Purpose | Codemap |
| --- | --- | --- |
| `ui/` | Dependency-free shells: `Modal`, `Sheet`, `ConfirmDialog`, `Badge`, `SettingsControls` (SectionHeader/SettingsCard/SettingsRow/Toggle/SelectControl), and `dialogBehavior` (focus trap + Escape handling). | [ui/codemap.md](ui/codemap.md) |
| `card-system/` | Card rendering tokens + primitives (`CardDisplay`, `CardRow`, `CardIdentity`, `CardPriceDetails`, `CardStack`, `CardDialog`, `CardLegend`, `CardRequirementProgress`, `CardSelectionQuantityModal`, `CardSystemGallery`) with barrel `index.js`. | [card-system/codemap.md](card-system/codemap.md) |
| `decks/` | Deck analytics/validation/composition visuals (`DeckAnalyticsPanel`, `DeckAnalyticsVisuals`, `DeckCompositionBar`, `DeckCardViewer`, `DeckValidationPanel`). | [decks/codemap.md](decks/codemap.md) |
| `card-lists/` | `CardListPicker`, `CardListGallery`. | [card-lists/codemap.md](card-lists/codemap.md) |
| `binders/` | Physical pages/slots workspace, revisioned layout settings and moves, card-location links, `BinderCsvImportModal`. | [binders/codemap.md](binders/codemap.md) |
| `public/` | `PublicProfileShell` (public profile layout, reuses `TabNav`). | [public/codemap.md](public/codemap.md) |
| `sync/` | Offline/sync chrome: `OfflineBanner`, `StaleDataLabel` (+ `SavedAtContext`), `ServerSyncSettings` (admin sync controls, hosted at `/offline`), `SyncSheet` (`SyncControls`, `SyncItemList`, `StorageSummary`), `EvictedNotice`, `LogoutGuardDialog`. | — |
| `pwa/` | Install/update/push surface: `InstallHint`, `UpdateBanner`, `NotificationsCard`, `CollectionDownload`. | — |

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
  `useAuth` (`user`, `logout`, `multiUser`); offline/sync chrome additionally
  reads `useOutbox()`/`useOffline()` and the automatic-collection context.
  Server data is fetched inside components with TanStack Query
  (`PrintingDetailSelector`, `CollectionCardImage`, `ServerSyncSettings`,
  `NotificationsCard`).
- **One windowed grid, measured per breakpoint.** `WindowedCardGrid` derives
  column count and row height from the rendered CSS grid, preserves the first
  visible item across responsive reflow, and supports `measureRows` when a tile
  is taller than the standard caption (stack/binder/scan tiles). It uses
  `listKey` for the collection's saved scroll position and keeps focused rows
  mounted for keyboard navigation.
- **Own-photo priority.** `CollectionCardImage` chooses between catalogue artwork
  and the owner's private scan photo (`showsOwnPhoto`, `useCollectionPhotoResource`,
  `useCollectionPhotoUrl`), honoring the `prefer_own_card_photos` setting. The
  `CollectionCardDisplay` / `CollectionCardIdentity` / `CollectionCardRow`
  wrappers re-render that same resolution through `card-system` and add the
  own-photo marker.

## Flow

1. **Scan → add.** `UnifiedCardScanner` stages files from camera/gallery or the
   live `WebcamCapture` preview. With the offline queue enabled it calls
   `offline/ops/scanSubmit.submitScanBatch` (persist-then-send: photos go to the
   IndexedDB outbox first and are only uploaded inline when the server is
   reachable); otherwise it calls `enqueueScanJob`. Either path lands on
   `/scans`. `ScanReview` renders each queued item (`ScanItemPanel`) with
   candidate matches in a windowed `CandidateGrid` and a linked-zoom
   `CardZoomModal`. Confirming a match opens `ScanAddModal`
   (`CardScanner.jsx`); both the form and `ScanQueue`'s express add read canonical
   finish availability through `useScanCatalogue`, ignoring scanner foil guesses.
   The comparison's **Add as NM · {variant}** action displays and files that
   catalogue default, with quantity one and NM condition. `JobDetail` sends
   either request and both best-effort attach the scan photo via
   `attachScanFallbackPhoto` — a photo failure never blocks the add. A photo
   with no usable match offers `ScanCustomCardModal`, which creates a custom
   card from the recognition data and adds the photographed card to the
   collection with the same photo-attach path. Both scan-add
   and card-detail add forms use `getSelectableVariants` to disable explicitly
   excluded finishes while leaving unknown evidence editable.
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
  (hidden on `/`), `OfflineBanner`, `StaleDataLabel` and `OfflineUnavailable`;
  `App.jsx` wraps everything in `AuthProvider` → `SettingsProvider` →
  `OfflineProvider` → `ConfirmDialogProvider` → `BrowserRouter`, mounts
  `UpdateBanner`, and renders `PublicHomeButton` inside the `/u` public routes.
  `AuthStartupScreen` and `PokeBallLoader` gate the auth-loading and route-lazy
  states. The sync/pwa components read `useOutbox`/`useOffline` and
  `AutomaticCollectionProvider` rather than receiving queue state as props.
- **Contexts.** `AuthContext` (user/logout/multiUser), `SettingsContext`
  (i18n `t`, price formatting, currency), `ConfirmDialogContext`
  (`useConfirmDialog` in `PrintingDetailTagManager` and the scanners).
- **Pages** import these components directly — e.g. `Collection` (MoneyInput,
  PrintingDetailSelector/TagManager, CollectionCard*, BulkRemovalToolbar, windowed
  grid), `CardSearch` (CardItem, CustomCardModal, UnifiedCardScanner,
  PrintingDetailSelector, windowed grid), `ScanQueue` (ScanAddModal, ScanReview,
  ScanCustomCardModal), `Products`/`Analytics` (PeriodSelector, MoneyInput,
  CollectionCard*, AnalyticsSectionNav), `Dashboard` (TrainerCard,
  CollectionCardDisplay), `Settings`/`Binders` (AvatarPicker; Settings also mounts
  `pwa/NotificationsCard` and the card-artwork sweep panel), `OfflineCenter`
  (sync/* panels, CollectionDownload, InstallHint), `Trades`
  (MoneyInput, CustomCardModal), and `CardModal` consumers (`UserCollection`,
  `Wishlist`, `Leaderboard`, `SetDetail`, `Compare`, `PokedexSpecies`).
