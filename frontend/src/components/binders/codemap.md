# frontend/src/components/binders/

## Responsibility

This folder hosts physical binder layouts, card-location links, and CSV import.
`BinderCsvImportModal` is a **presentational modal** that
onboards the user onto the CSV-import flow: it explains the expected column
schema, offers a downloadable template, and exposes the two actions (choose a
file / download the template). It does **not** own the file input, the upload,
or the API call — those live in the parent pages. It is the "explainer and
gateway" between the user and the binder CSV import endpoint.

## Design

### Physical pages and locations

- `BinderLayoutPanel` is the private integration boundary: a fresh React Query
  layout snapshot, revision-checked move/layout/undo mutations, Cards/Pages URL
  state, conflict refresh, and layout settings. `BinderDetail` retains ordinary
  gallery, membership editing, allocation, and card-detail behaviour.
- `BinderWorkspace` is shared by private and public pages. It receives snapshots
  and optional mutation callbacks; it does not fetch. Exported `BinderPage`
  renders all 9/12 numbered pockets, including gaps, through card-system artwork;
  each page carries an uppercase heading and an occupancy meter. Only occupied
  pockets (or every pocket while arranging) are buttons, so browsing and the
  public page never expose empty controls. Container width determines readable
  two-page spreads versus one-page viewing; the Not placed tray is alongside
  wide workspaces or expandable below a page.
- Arrange mode separates browsing from selection. Its gestures are advertised
  as three hint chips (select-then-slot, grip drag, hold-arrow paging) with the
  full sentence kept for assistive tech. One-copy tap/place, a spatial
  destination grid (page selector plus real pockets, with the source's own
  slot marked as current and not selectable), grip dragging on both mouse
  (HTML5 drag) and touch (pointer events with `touch-action: none` on the grip
  alone, so the card body still scrolls), deliberate dwell paging, occupied
  destination confirmation, save/error status, and conflict-safe Undo share one
  mutation path. Grips keep a 44px hit area while showing a smaller chip, and
  the destination pocket flashes after a successful save. Native buttons support
  keyboard moves and arrow-key slot focus; the chooser's grid supports arrow
  keys too. The selection bar is fixed at every width (the app shell's overflow
  makes `sticky` inert): bounded and centred over the pages column, its measured
  insets keep it clear of the shell padding and the side tray, and the workspace
  reserves scrollable space beneath it so no pocket is trapped behind it.
- `BinderLayoutSettings` requires a server preview before saving. The preview's
  revision and exact affected placement IDs accompany confirmation; geometry
  changes and disabling pages return occupied copies to Not placed, never repack.
  Preview is a review step: its own footer keeps Update preview, a neutral or
  warning-toned summary, and a separately labelled save button.
- `CardLocations` fetches all placed copies and grouped unplaced memberships for
  card dialogs. A public handle switches to the anonymous public client; private
  collection dialogs additionally scope by collection item. Links carry expected
  card/membership and placement identity, not coordinates alone, and show the
  location as a compact pill beside the binder name.
  Ordinary binders without layouts retain Cards view; linked unplaced entries
  receive an explicit explanation and an action opening the associated card.
- `utils/binderLayout.js` owns spread calculations, translated interpolation,
  location URLs and safe stale-target resolution. Fresh snapshots resolve moved
  targets before focus/highlight; ambiguous remaining copies get explicit links.
- `binder-layout.css` adds themed pockets (sleeve sheen, dashed empty recess),
  page headers and occupancy meters, selection/focus states, a destination grid,
  a short directional page reveal and a save flash. Reduced motion disables
  workspace motion and chooser transitions. Shared `Modal`/`ConfirmDialog`
  provide focus trapping and responsive overlays.
- Public callers provide sanitized snapshots and no mutation callbacks. Public
  artwork never passes through private collection-photo wrappers.

### CSV import

- **Pure presentation, no data fetching.** The modal receives everything it
  needs as props and renders against them; it holds no local state beyond the
  markup. This keeps it reusable across three distinct list contexts.
- **`listType` drives content, not behaviour.** The single component adapts its
  copy to the list type via a small key-selection map:
  - `'deck'` → `binderTypes.csvImportDeckDescription/Behavior`
  - `'collection'` (default) → `binderTypes.csvImportCollectionDescription/Behavior`
  - anything else (the wishlist case, passed as `'planned'`) →
    `binderTypes.csvImportWishlistDescription/Behavior`
  The `isCollection` flag additionally gates a `printingDetails.csvHelp` hint.
- **Schema lives in one place.** `BINDER_CSV_IMPORT_HEADER` is the single
  source of truth for the accepted column order, exported for reuse, and
  rendered verbatim in the modal so the user sees the exact expected header.
- **Template is client-side only.** `BINDER_CSV_IMPORT_TEMPLATE` is a one-row
  sample (a `BLK/057/Holo` example) downloaded via `downloadBinderCsvTemplate`,
  which builds a `Blob`, creates an object URL, clicks a temporary anchor, and
  cleans up — no server round-trip.
- **Controlled by callbacks.** `onChooseFile`, `onClose`, `onDownloadTemplate`
  and the `isImporting` flag are all injected. This is a classic
  "dumb component + smart parent" split: the modal cannot trigger the file
  picker or mutation itself; the parent wires `onChooseFile` to a hidden
  `<input type="file">`.
- **Responsive sheet/modal pattern.** On mobile it renders as a bottom sheet
  (`fixed bottom-0`, rounded top, drag-handle strip, `max-h-[90dvh]`); on
  `md:` and up it becomes a centered dialog (`max-w-lg`, full border). The
  backdrop click closes, while the panel stops propagation.

## Flow

1. A parent page sets a `showCsvImportModal` state to `true` (from an "Import
   CSV" button).
2. The modal renders its header, the two action buttons, and the three
   help sections (card code format, column list, allowed/default values),
   plus an error-behaviour warning.
3. The user clicks **Choose CSV file** → `onChooseFile()` → the parent calls
   `csvInputRef.current?.click()` (or `fileInputRef` in `BinderDetail`) on a
   hidden file input.
4. The file input's `onChange` reads `event.target.files[0]` and calls the
   parent's `importMutation.mutate(file)`, then clears the input value so the
   same file can be re-selected.
5. `importMutation.mutationFn` calls `importBinderCsv(id, file)`, which builds
   `FormData` and `POST`s to `/binders/{id}/import-csv`.
6. While pending, `isImporting` disables the Choose button and swaps its label
   to `importingCsv`.
7. On success the parent shows a toast from the returned summary
   (`added`/`updated`/`skipped`/`failed`/`errors`), invalidates the relevant
   React Query caches, and closes the modal by clearing the show state.
8. The **Download template** button is independent and always available; it
   triggers the client-side blob download without touching the mutation.

## Integration

- **Pages** (`frontend/src/pages/`):
  - `BinderDetail.jsx` — imports the component plus `downloadBinderCsvTemplate`.
    Passes `listType={isWishlist ? 'planned' : 'collection'}`, wires
    `onChooseFile` to `fileInputRef`, and supplies `isImporting` from its
    `importMutation`. Its `importMutation` posts to the current binder and, on
    success, invalidates `binder-cards`, `binders`, and TCGDEX filter-language
    caches before closing.
  - `DeckEditor.jsx` — reuses the same modal with `listType="deck"` (a planned
    deck), wiring `onChooseFile` to its own `csvInputRef` and `isImporting` from
    its own `importMutation` (which targets `deckId`). It does not pass
    `onDownloadTemplate`, so the component falls back to its default
    `downloadBinderCsvTemplate`.
- **API** (`frontend/src/api/client.js`):
  - `importBinderCsv(binderId, file)` → `POST /binders/{binderId}/import-csv`
    with `multipart/form-data`; returns the per-row summary object.
  - `exportBinderCsv(binderId)` → `GET /binders/{binderId}/export-csv` as a
    blob; the sibling of the import flow (not rendered by this modal).
- **Backend** (`backend/api/binders.py`):
  - `POST /{binder_id}/import-csv` validates the `.csv` extension, size and
    UTF-8 encoding, accepts several historical header variants
    (`BINDER_CSV_COLUMNS*`, `BINDER_CSV_PHYSICAL_COLUMNS*`, `BINDER_CSV_LEGACY_COLUMNS`),
    enforces row limits, and returns `added/updated/skipped/failed/errors`
    counts plus per-row error strings. It rejects `physical_deck` binders
    (must convert to planned first) and takes row locks for collection binders.
- **i18n** — all visible strings go through the `t` translation function under
  the `binderTypes.csvImport*` and `common.*` namespaces; the modal itself
  holds no hard-coded user-facing copy beyond the raw column header.
