# frontend/scripts/

Build- and maintenance-time tooling for the frontend. This folder holds two
Node ES-module scripts (`check-translations.mjs`,
`configure-public-mode.test.mjs`) that run outside the Vite dev/build pipeline:
one guards translation-key completeness, the other integration-tests the runtime
Docker entrypoint that bakes SEO/metadata into the served `index.html`. Neither
script is bundled into the application; both are invoked only through `npm`
scripts in `package.json`.

## Responsibility

- **`check-translations.mjs`** (`npm run check:translations`): statically verifies
  that every `t('...')` translation call in the source tree resolves to a string
  in the canonical English catalog `src/i18n/en.js`. It fails the run with a
  per-file, per-line list of missing keys, so a translation reference can never
  point at an undefined key.
- **`configure-public-mode.test.mjs`**: integration test (Node's built-in
  `node:test` runner) for `docker-entrypoint.d/40-configure-public-mode.sh`. It
  exercises the entrypoint's `PUBLIC_MODE`/`WEB_ROOT` contract against a temp web
  root and asserts the public, private, and invalid-value behaviours produce the
  correct `index.html` and `robots.txt` output.

This is the frontend's only non-`src` JavaScript: it is maintenance/build
tooling, not application code.

## Design

- **ESM throughout**: both files use `import` and `import.meta.url` (the package
  is `"type": "module"`); paths are resolved relative to the script via
  `fileURLToPath(new URL(...))` rather than `__dirname`.
- **`check-translations.mjs`**:
  - Recursively collects `.js`/`.jsx` files under `src/` (`collectFiles`), then
    skips `i18n/` and `*.test.js(x)`.
  - Matches translation calls with the regex
    `/(?:^|[^\w$])t\s*\(\s*(['"`])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1/g` —
    the `t()` helper called with a single string literal whose key contains at
    least one dot. Dot-separated keys encode nested-catalog lookups
    (e.g. `t('nav.dashboard')`); single-segment keys are intentionally not
    matched.
  - `resolveTranslation(key)` walks `en.js` by splitting on `.` and descending
    (`path.split('.').reduce((v, p) => v?.[p], en)`), tolerating missing
    intermediate objects via optional chaining. A key is "present" only if the
    final value is a `string`; an object (a namespace) or `undefined` is treated
    as missing.
  - Errors accumulate with `path:line` (the line is derived by counting newlines
    up to the key's offset within the file); a non-empty list prints a readable
    report and exits `1`.
- **`configure-public-mode.test.mjs`**:
  - `runEntrypoint(publicMode)` scaffolds an isolated temp web root (via
    `mkdtempSync`) containing `index.html.template`, a stale `index.html`,
    `robots-allow.txt`, and `robots-block.txt`, then runs the shell entrypoint
    with `execFileSync('sh', [script], { env })` (with `PUBLIC_MODE` and
    `WEB_ROOT` injected) and returns the resulting `index.html`/`robots.txt`
    contents before tearing the dir down (`rmSync`).
  - Three `test(...)` cases use `assert.match`/`assert.doesNotMatch` against the
    rendered output, one per `PUBLIC_MODE` branch (`true`, `false`, and an
    invalid value).

## Flow

1. **`npm test` → `npm run check:translations` → `node scripts/check-translations.mjs`**:
   enumerate `src/**/*.{js,jsx}` → filter out `i18n/` and tests → read each file
   → scan for `t('dot.key')` calls → resolve each key against `en.js` → collect
   missing-key errors → exit non-zero with a report if any are missing, otherwise
   print "Translation-key check passed".
2. **`npm test` → `node --test scripts/configure-public-mode.test.mjs`**: for each
   of `true` / `false` / `unexpected`, create a temp web root with the template
   and robot stubs → exec `40-configure-public-mode.sh` with `PUBLIC_MODE` /
   `WEB_ROOT` → read back `index.html` and `robots.txt` → assert the expected
   SEO/robots content.
3. **`npm test` → `vitest run src`** runs the app's own unit tests afterward; the
   two scripts act as fast, dependency-light gates ahead of the Vitest suite.

## Integration

- **`package.json` scripts** are the only entry points:
  - `check:translations` → `node scripts/check-translations.mjs`
  - `test` → `npm run check:translations && node --test scripts/configure-public-mode.test.mjs && vitest run src`
  - (`dev`, `build`, and `preview` do not touch this folder.)
- **`check-translations.mjs` ↔ `src/i18n/en.js`**: `en.js` is the canonical
  English catalog (imported directly as a module) and the reference the other
  language files (`de.js`, `ru.js`, `sv.js`, …) fall back to. The script enforces
  the convention that the `t()` helper resolves dot-separated keys against
  nested objects. A key added to any translation without a matching `en.js`
  entry breaks `npm test` (and any CI step that runs the check).
- **`configure-public-mode.test.mjs` ↔ `docker-entrypoint.d/40-configure-public-mode.sh`**:
  the test validates the runtime entrypoint that, on nginx container start,
  regenerates `index.html` from `index.html.template` and swaps in the
  public/private `robots.txt` based on `PUBLIC_MODE`. The `index.html.template`
  convention (built asset plus a `.template` source) and the `robots-allow.txt` /
  `robots-block.txt` stubs are part of the served-image contract that the test
  recreates in a temp directory. This is the only script here that reaches
  outside the JS tooling and into deployment.
