import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkPrTitle } from './check-pr-title.mjs'

const accepted = [
  'feat: group collection by Pokémon species and report species duplicates',
  'fix: use catalogue finish evidence when adding cards',
  'docs: require screenshots for visual PRs and release notes',
  'docs(fork): register fork-v1.57.9-7',
  'chore(release): fork-v1.57.9-7 release notes',
  'ci(release): require notes coverage for every merged change',
  'build: build fork release images for ARM64',
  'revert: binder pages and slots',
  'perf(scan-queue): claim work without a lock convoy',
  '  feat: accept surrounding whitespace  ',
]

for (const title of accepted) {
  test(`accepts ${JSON.stringify(title)}`, () => {
    assert.deepEqual(checkPrTitle(title), [])
  })
}

const rejected = [
  ['', 'empty'],
  [undefined, 'missing'],
  ['Register fork-v1.57.9-5', 'missing type'],
  ['feat(add binder pages)', 'missing colon'],
  ['feat:missing separator', 'missing space'],
  ['feature: add binder pages', 'unknown type'],
  ['Feat: add binder pages', 'capitalised type'],
  ['feat(Fork): add binder pages', 'capitalised scope'],
  ['feat: ', 'empty summary'],
  ['feat: add binder pages.', 'trailing period'],
]

for (const [title, reason] of rejected) {
  test(`rejects ${JSON.stringify(title)} (${reason})`, () => {
    assert.equal(checkPrTitle(title).length, 1)
  })
}
