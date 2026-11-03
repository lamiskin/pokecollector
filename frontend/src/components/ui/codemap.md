# frontend/src/components/ui/

## Responsibility

This folder holds the app's **shared UI primitives** — small, reusable,
presentational and overlay components that pages and feature components compose
instead of re-implementing:

- **Badge** — tiny rounded status pill with a fixed color/size vocabulary.
- **Card** — glass/solid/elevated surface container; becomes a keyboard-accessible
  clickable surface when `onClick` is supplied.
- **Modal** — responsive overlay: centered dialog on desktop, bottom sheet on
  mobile. Owns backdrop, Esc/backdrop close, body-scroll locking, and focus
  return.
- **Sheet** — standalone bottom sheet (also the mobile rendering target of
  `Modal`).
- **ConfirmDialog** — a `Modal` specialized for confirm/cancel flows, with
  destructive styling and a pending spinner.
- **OverflowMenu** — "⋯" trigger that opens an absolutely-positioned menu,
  closed on outside click or Esc.
- **dialogBehavior.js** — the shared focus-management hook (`useDialogBehavior`)
  backing every overlay, not a component itself.

The folder is intentionally **dumb**: no data fetching, routing, or business
state lives here. Components render children/strings and delegate side effects
(focus, scroll lock, keyboard) to the shared hook or to themselves. The single
exception is reading `useSettings` for the `t` translation function (labels such
as "Close"/"Dialog"), which keeps the primitives i18n-aware.

## Design

- **Tailwind + custom component classes.** Layout, spacing, and color are
  Tailwind utility classes plus theme tokens (`bg-bg-card`, `border`,
  `text-text-primary`, `brand-red`, …). Surface/button look-and-feel comes from
  CSS component classes defined in `frontend/src/index.css` under
  `@layer components`: `.card` (glass morphism), `.stat-card` (elevated variant
  with top highlight), and `.btn-primary` / `.btn-secondary` / `.btn-ghost`
  (glow-styled buttons). `Card` maps `variant` → `.card` / `.stat-card` / solid
  utilities; `ConfirmDialog` and `OverflowMenu` reuse the `.btn-*` classes.

- **Map-based prop → class lookup with a safe default.** Every `variant` /
  `size` / `padding` prop uses an object lookup indexed by the prop and falls
  back via `||` (`{ … }[variant] || 'default…'`), so an unknown value degrades
  to the default rather than crashing.

- **Composition over duplication.**
  - `ConfirmDialog` wraps `Modal` (size `sm`, `mobileSheet=false`, stacked
    overlay `z-[500]`) and only supplies its icon + footer buttons.
  - `Modal` is a thin responsive router: `mobileSheet=true` (default) renders
    `<Sheet>` below the `1024px` breakpoint and the internal `DesktopModal`
    at/above it; `mobileSheet=false` always renders `DesktopModal`. This is the
    only place the breakpoint decision is made.

- **Shared dialog behavior in one hook.** `useDialogBehavior(isOpen, onClose,
  { restoreFocus })` centralizes: focusing the dialog on open, Esc-to-close,
  and a manual Tab/Shift+Tab focus trap (details below). `Modal` opts out of the
  hook's own focus restore (`restoreFocus:false`) because the responsive
  wrapper must survive switching between `Sheet` and `DesktopModal` without
  losing the original trigger element.

- **Rendering via portals.** `Modal` (desktop) and `Sheet` use
  `createPortal(…, document.body)` so overlays escape any overflow/transform
  clipping from ancestors.

- **Accessibility patterns.**
  - Dialogs: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` (title) or
    `aria-label` fallback, `tabIndex={-1}` on the panel, focus trap on
    Tab/Shift+Tab, Esc closes, focus restored to the invoking element on close.
  - Body scroll is locked while open and the prior `overflow` value restored on
    unmount.
  - Stacked dialogs: the `isObscured` prop switches a lower dialog to
    `aria-modal={undefined}` + `aria-hidden="true"` so screen readers ignore it
    while a higher dialog sits on top.
  - `Card` clickables: `role="button"`, `tabIndex={0}`, and an `Enter`
    keydown handler mirror the `onClick`.
  - `OverflowMenu`: `aria-label`, `aria-expanded`, `aria-haspopup="menu"`, and a
    `role="menu"` container.
  - Decorative icons use `aria-hidden` (`X`, `AlertTriangle`, `Loader2`,
    `MoreHorizontal`).

- **Responsive animations.** Backdrops use `animate-fade-in`; panels use
  `animate-slide-up` (desktop modal and mobile sheet share the slide-up
  entrance).

## Flow

**Modal (responsive overlay).**
1. On first `isOpen`, the current `document.activeElement` is captured into
   `returnFocusRef` before any focus moves.
2. A `matchMedia('(min-width: 1024px)')` listener keeps `isDesktop` in sync with
   the viewport (re-evaluated live, so resizing across the breakpoint switches
   rendering mode).
3. While open, body scroll is locked; on close the previous overflow is
   restored.
4. If `!isOpen` the component returns `null` (nothing is portaled).
5. When open: `mobileSheet && !isDesktop` → `<Sheet>`
   (`manageBodyScroll=false`, `restoreFocus=false` — the wrapper owns both so
   the mode switch doesn't double-lock or drop focus); otherwise →
   `DesktopModal` (a portal with backdrop + panel).
6. The backdrop `onClick` closes; the panel `stopPropagation()`s clicks so
   interior clicks don't dismiss. Esc is handled by `onDialogKeyDown` from the
   hook.
7. On unmount of the open state, focus is returned to the captured trigger via
   `requestAnimationFrame` (only if still connected).

**Sheet.** Portals a backdrop (`aria-hidden`) and a fixed bottom panel with a
drag handle, optional header, and scrollable body. It owns its own body-scroll
lock (`manageBodyScroll`, default true) and delegates Esc/focus to
`useDialogBehavior` with `restoreFocus` (default true).

**ConfirmDialog.** Renders `Modal` with `size="sm"`, `mobileSheet=false`, and
`overlayClassName="z-[500]"`. While `isPending`, `onClose` is disabled (so the
modal can't be dismissed mid-operation), both buttons are `disabled`, and the
confirm button shows a spinning `Loader2`. `destructive` switches the icon and
confirm-button to red styling.

**useDialogBehavior (the focus engine).**
- On open: captures the active element, then focuses the dialog ref on the next
  frame (`requestAnimationFrame`).
- On close: cancels that frame and (if `restoreFocus`) re-focuses the captured
  element on the next frame.
- `onDialogKeyDown`: `Escape` → `preventDefault`/`stopPropagation` + `onClose`.
  `Tab` → `stopPropagation` (so a parent dialog can't also trap focus for a
  nested dialog) and manually cycles focus among *visible* focusable elements
  (`a[href]`, enabled `button`/`input`/`select`/`textarea`, `[tabindex]`,
  filtered to non-`hidden`, not inside `[aria-hidden="true"]`, and with a
  bounding box). If none are found, focus is held on the dialog itself.

**OverflowMenu.** Internal `open` state; when open, attaches document-level
`pointerdown` (outside-click) and `keydown` (Esc) listeners that set `open` to
false. `children` is a render prop invoked with `close` so menu items can close
the menu after acting.

## Integration

**Direct consumers (imports of the primitives):**
- `Modal` — `pages/ScanQueue.jsx`, `pages/Settings.jsx`, `pages/Products.jsx`,
  `pages/BinderDetail.jsx`.
- `ConfirmDialog` — `contexts/ConfirmDialogContext.jsx` (the app-wide confirm
  provider) and `pages/ScanQueue.jsx`.
- `Sheet` — `pages/CardSearch.jsx`.
- `Badge` — `components/PrintingDetailBadges.jsx`.
- `Card`, `OverflowMenu` — **currently unused** (defined primitives with no
  importers in `frontend/src`; `overflowMenuItemClass` is exported but only
  referenced by its own definition).

**Consumers of `useDialogBehavior` (shared hook, beyond `Modal`/`Sheet`):**
- `components/CardScanner.jsx`
- `components/ScanReview.jsx` (`restoreFocus:false`)
- `components/ImageZoomOverlay.jsx`

**Dependencies on the rest of the system:**
- `contexts/SettingsContext` — `useSettings()` supplies `t` for
  `common.close` / `common.dialog` labels (keeps overlays i18n-aware).
- `lucide-react` — icons (`X`, `AlertTriangle`, `Loader2`, `MoreHorizontal`).
- `react-dom` — `createPortal`.
- `frontend/src/index.css` — theme tokens and `.card` / `.stat-card` /
  `.btn-*` component classes, plus the `animate-fade-in` / `animate-slide-up`
  keyframe animations.
