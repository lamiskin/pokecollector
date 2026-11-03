# frontend/src/components/binders/

## Responsibility

This folder hosts the UI for importing card lists into a binder via CSV. Its
single component, `BinderCsvImportModal`, is a **presentational modal** that
onboards the user onto the CSV-import flow: it explains the expected column
schema, offers a downloadable template, and exposes the two actions (choose a
file / download the template). It does **not** own the file input, the upload,
or the API call — those live in the parent pages. It is the "explainer and
gateway" between the user and the binder CSV import endpoint.

## Design

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
