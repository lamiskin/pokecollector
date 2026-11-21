### Features

- **Quick add from the scan review comparison.** Beside **Accept match**, an **Add as NM · Normal** action files the candidate on screen as one Near Mint, normal-printing copy — quantity 1, no printing details, no purchase price, using the match's own language — without opening the add form, then walks on to the next unresolved photo. The scanned photo is still retained and attached best-effort, so a card without catalogue artwork keeps it. **Accept match** remains the path for another condition, variant or purchase price.

  ![Scan review comparison with the photographed card and its match, showing Accept match and Add as NM · Normal](https://github.com/lamiskin/pokecollector/releases/download/fork-v1.57.9-2/fork-v1.57.9-2-quick-add.webp)

### Fixes and changes

- None user-visible. The remaining fork commits in this release are the test-only locator fix for the OIDC settings check and the release-register documentation update.

### Limitations and notes

- Quick add always records condition NM and variant Normal; there is no per-card override in this flow.
- This release predates the curated release-notes pipeline. This file was backfilled from the frozen tree to keep the published notes consistent with later releases.
