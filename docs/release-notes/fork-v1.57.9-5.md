### Features

- **Card pickers hide cards you cannot add.** When adding cards to a binder,
  wishlist or deck, entries that are already in the list or have no free copies
  are no longer shown greyed out in the grid. A **Show unavailable** toggle with
  a count badge reveals them on demand, placed after the selectable cards, so a
  nearly complete binder can still be browsed and searched. The toggle covers
  the owned-cards and all-cards tabs and the deck editor, which share the same
  picker.

### Fixes and changes

- When a search or filter matches only unavailable cards, the picker now says
  they are already added or unavailable instead of showing a generic empty
  state; the toggle reveals the matches.
- Clearing filters or switching between My collection and All cards hides
  unavailable cards again.

### Limitations and notes

- The three new picker strings are English-only for now; other languages fall
  back to English until translated.
- The badge counts matches under the current filters. On the All cards tab it
  reflects the loaded result page, since that tab is searched server-side.
