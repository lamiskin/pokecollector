# frontend/src/components/public/

## Responsibility

This folder holds the shared layout shell for the public-facing "profile" pages — the
anonymous, unauthenticated read-only views of another collector's shared binders,
wishlist, and decks. It does **not** fetch data or own any route; its single component,
`PublicProfileShell`, is a pure presentational wrapper that renders the persistent
"identity + section tabs" chrome around whatever content a page passes in as `children`.

Concretely the shell:

- Renders the visitor-facing header card: trainer avatar (Pokédex sprite), the
  `publicProfiles.publicProfile` eyebrow, `trainer_name`, and `@handle`.
- Computes and renders the tab bar (`TabNav`) for the profile's sections:
  - **Binders** — always present, links to `/u/:handle` (exact match).
  - **Wishlist** — only when `profile.wishlist_is_public`, with a `wishlist_count` badge.
  - **Decks** — only when `profile.decks.length > 0`, with a deck-count badge.
- Renders `children` (the page-specific content) below the tabs inside a
  `max-w-5xl` column.

It is intentionally dumb: it knows nothing about data fetching, error/loading states,
pagination, or the backend. Pages decide `activeSection` and pass it down so the shell
highlights the correct tab.

## Design

**Single-presentational-component folder.** There is exactly one component here
(`PublicProfileShell.jsx`). All data-fetching and feature logic lives in the page
components under `src/pages/` (`PublicProfile.jsx`, `PublicBinderView.jsx`,
`PublicWishlistView.jsx`, `PublicDeckView.jsx`), which import and wrap this shell. The
shell is a layout/frame, the pages are the content.

**Props contract** (all required):
- `profile` — the `PublicProfile` payload (see Flow). Drives avatar, name, handle, and
  which tabs exist.
- `handle` — the raw `:handle` URL param, used to build tab links.
- `activeSection` — one of `'binders' | 'wishlist' | 'decks'`; highlights the tab. The
  shell sets each tab's `active` flag from this, so `TabNav` can treat `active` as
  precomputed rather than deriving it from the path.
- `t` — the translation function from `SettingsContext` (`useSettings().t`).
- `children` — React children rendered below the tab bar.

**Conditional tab composition.** The tabs array is built with spread-conditional
entries (`...(condition ? [tab] : [])`) so the wishlist tab appears only when the owner
shares it and the decks tab only when the owner has decks. Each tab uses a
`lucide-react` icon (`BookOpen`, `Heart`, `Layers3`).

**Reuses shared primitives rather than reinventing them.** Navigation is delegated to
`../TabNav` (a generic tab bar used across the app), and every text label goes through
`t(...)` under the `publicProfiles.*` namespace. Styling follows the app's Tailwind
design-token classes (`bg-bg-primary`, `text-text-primary`, `border-border`,
`text-text-muted`, `brand-red`, etc.) rather than inline styles.

**Avatar convention.** The avatar is an optional sprite served from
`/api/pokedex/images/sprites/{avatar_id}.png` with the `pixelated` class; the
`avatar_id &&` guard renders nothing when the owner has no avatar.

## Flow

1. A user visits a public route (see Integration). React Router renders the matching
   page component, which reads `:handle` via `useParams()` and calls the relevant
   `getPublic*` function from `src/api/publicClient.js`.
2. The page resolves `profile` (and any content-specific payload) and, on success,
   renders `<PublicProfileShell profile={profile} handle={handle} activeSection=... t={t}>…</PublicProfileShell>`.
3. `PublicProfileShell` derives the `tabs` array from `profile`:
   - `wishlist_is_public` and `wishlist_count` gate/annotate the wishlist tab;
   - `decks.length` gates/annotates the decks tab.
4. It renders the header (avatar + trainer name + handle), then `<TabNav tabs={tabs} />`.
   `TabNav` navigates with `useNavigate()` and highlights the tab whose `active` flag
   is truthy (the shell sets this from `activeSection`).
5. `children` — the page-specific body — renders below the tabs.

**Data shape it depends on** (`PublicProfile` from `backend/api/public.py`):
`handle`, `trainer_name`, `avatar_id`, `show_values`, `wishlist_is_public`,
`wishlist_count`, `binders[]`, `decks[]`. The shell reads only `avatar_id`,
`trainer_name`, `handle`, `wishlist_is_public`, `wishlist_count`, and `decks`; the
rest is consumed by the pages.

## Integration

**Routes.** Wired in `src/App.jsx` under the unauthenticated `PublicRoutes` layout
(`<Route path="/u" element={<PublicRoutes />}>`). The four pages that wrap this shell
are lazy-loaded and mounted at:

| Path | Page | `activeSection` |
| --- | --- | --- |
| `/u/:handle` | `PublicProfile` | `'binders'` |
| `/u/:handle/decks` | `PublicProfile` (decks branch) | `'decks'` |
| `/u/:handle/binder/:binderId` | `PublicBinderView` | `'binders'` |
| `/u/:handle/wishlist` | `PublicWishlistView` | `'wishlist'` |
| `/u/:handle/deck/:deckId` | `PublicDeckView` | `'decks'` |

`/u` index is `PublicDirectory` (does **not** use this shell — it has its own header).
`PublicRoutes` also renders `PublicHomeButton` (a fixed Pokéball link back to `/u`),
shown across all public pages.

**Client.** All pages fetch via `src/api/publicClient.js`, a dedicated `axios` instance
with `baseURL: '/api/public'` and — critically — **no** `Authorization` header and **no**
`401 → /login` redirect, so anonymous visitors are never bounced to login. Relevant
endpoints: `getPublicProfile(handle)`, `getPublicProfiles()`,
`getPublicBinder(handle, binderId)`, `getPublicWishlist(handle, params)`,
`getPublicDeck(handle, deckId)`, `getPublicDeckProbability(handle, deckId, params)`.

**Backend.** Served by `backend/api/public.py` (router mounted at `/api/public`), which
enforces `public_profiles_enabled` and per-owner visibility (`wishlist_visibility`,
`public_show_values`, custom-card exclusion), sets `Cache-Control: public, max-age=0,
must-revalidate`, and returns the `PublicProfile`/`PublicBinderDetail`/`PublicWishlist`/
`PublicDeckDetail` models. `wishlist_is_public` (tab gating) mirrors
`user.wishlist_visibility == "public"`; `decks.length` mirrors published shared decks.

**Cross-cutting dependencies.**
- `../TabNav` — generic tab bar (icon + label + optional badge + active highlight).
- `lucide-react` — `BookOpen`, `Heart`, `Layers3` icons.
- `SettingsContext` (`useSettings`) — supplies `t`, `formatPrice`, and `language`;
  `formatPrice` is used by pages (not the shell) and is gated by `show_values`.
- Shared card/list renderers used by pages, not the shell: `CardListGallery`,
  `CardStack`/`CardLegend`, `DeckAnalyticsPanel`, `DeckCompositionBar`,
  `DeckValidationPanel`, `PrintingDetailBadges`.

**Why it exists separately from `PublicDirectory`.** The directory is a standalone
landing/listing page with its own header; the four profile sub-pages share identical
identity + tab chrome, which this shell deduplicates so each page only supplies content.
