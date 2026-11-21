import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildManifest,
  parseArgs,
  pinEnvExample,
  renderNotes,
  validate,
  writeAssets,
} from './fork-release-manifest.mjs'

const sha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const digest = (character) => `sha256:${character.repeat(64)}`

const baseArgs = [
  '--tag',
  'fork-v1.55.1-2',
  '--sha',
  sha,
  '--upstream-base',
  otherSha,
  '--upstream-tip',
  sha,
  '--upstream-lag',
  '0',
  '--highlights',
  'docs/release-notes/fork-v1.55.1-2.md',
  '--namespace',
  'lamiskin',
  '--repository',
  'lamiskin/pokecollector',
]

const validArgs = [
  ...baseArgs,
  '--digest-backend',
  digest('1'),
  '--digest-frontend',
  digest('2'),
]

test('parseArgs reads every option once', () => {
  const parsed = parseArgs(validArgs)
  assert.equal(parsed.tag, 'fork-v1.55.1-2')
  assert.equal(parsed['digest-backend'], digest('1'))
})

test('parseArgs rejects unknown, repeated and valueless options', () => {
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown option: --bogus/)
  assert.throws(() => parseArgs([...validArgs, '--sha', sha]), /repeated option: --sha/)
  assert.throws(() => parseArgs(['--tag']), /missing value for --tag/)
  assert.throws(() => parseArgs(['stray']), /unexpected argument: stray/)
})

test('validate derives the fork and upstream versions from the tag', () => {
  const fields = validate(parseArgs(validArgs))
  assert.equal(fields.forkVersion, '1.55.1-2')
  assert.equal(fields.upstreamVersion, '1.55.1')
  assert.deepEqual(fields.platforms, ['linux/amd64', 'linux/arm64'])
})

test('validate rejects a tag, digest, SHA or namespace that cannot be published', () => {
  const cases = [
    ['--tag', 'v1.55.1'],
    ['--digest-backend', 'sha256:xyz'],
    ['--sha', 'A'.repeat(40)],
    ['--namespace', 'Lamiskin'],
    ['--platform', 'amd64'],
  ]
  for (const [option, value] of cases) {
    const args = [...validArgs]
    args[args.indexOf(option) + 1] = value
    assert.throws(() => validate(parseArgs(args)), `${option} ${value} should be rejected`)
  }
})

test('platform option parses a validated list and manifest records every platform', () => {
  const fields = validate(parseArgs([...validArgs, '--platform', 'linux/amd64,linux/arm64']))
  const manifest = buildManifest(fields, '2026-11-04T00:00:00.000Z')
  assert.deepEqual(manifest.platforms, ['linux/amd64', 'linux/arm64'])
  assert.throws(
    () => validate(parseArgs([...validArgs, '--platform', 'linux/amd64,linux/amd64'])),
    /unique linux/,
  )
})

test('a dry run needs no digests and refuses to carry them', () => {
  const dry = validate(parseArgs([...baseArgs, '--dry-run', 'true']))
  assert.equal(dry.dryRun, true)
  assert.equal(dry.digestBackend, undefined)

  assert.throws(
    () => validate(parseArgs([...validArgs, '--dry-run', 'true'])),
    /must not carry image digests/,
  )
})

test('pinEnvExample pins both images and leaves secrets and comments alone', () => {
  const source = [
    '# header stays',
    'BACKEND_IMAGE=pokecollector-backend:prod',
    'FRONTEND_IMAGE=pokecollector-frontend:prod',
    'POSTGRES_PASSWORD=replace-me',
    '',
  ].join('\n')
  const manifest = buildManifest(
    validate(parseArgs(validArgs)),
    '2026-11-04T00:00:00.000Z',
  )

  const pinned = pinEnvExample(source, manifest)

  assert.match(pinned, /^BACKEND_IMAGE=ghcr\.io\/lamiskin\/pokecollector-backend@sha256:1111/m)
  assert.match(pinned, /^FRONTEND_IMAGE=ghcr\.io\/lamiskin\/pokecollector-frontend@sha256:2222/m)
  assert.match(pinned, /^POSTGRES_PASSWORD=replace-me$/m)
  assert.match(pinned, /^# header stays$/m)
})

test('pinEnvExample refuses a template with no image line', () => {
  const manifest = buildManifest(validate(parseArgs(validArgs)), '2026-11-04T00:00:00.000Z')
  assert.throws(() => pinEnvExample('POSTGRES_PASSWORD=x\n', manifest), /no BACKEND_IMAGE=/)
})

test('a dry run writes only the manifest and notes', () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-release-dry-'))
  const outDir = join(root, 'out')
  try {
    mkdirSync(join(root, 'docs/release-notes'), { recursive: true })
    writeFileSync(join(root, 'docs/release-notes/fork-v1.55.1-2.md'), '## Features\n\n- Curated highlight.\n')
    const fields = validate(parseArgs([...baseArgs, '--dry-run', 'true', '--out', outDir]))
    writeAssets(fields, outDir, root)

    const manifest = JSON.parse(readFileSync(join(outDir, 'release-manifest.json'), 'utf8'))
    assert.equal(manifest.dry_run, true)
    assert.deepEqual(manifest.platforms, ['linux/amd64', 'linux/arm64'])
    assert.equal(manifest.images.backend.digest, null)
    assert.equal(manifest.images.backend.ref, null)
    assert.match(readFileSync(join(outDir, 'RELEASE_NOTES.md'), 'utf8'), /Dry run/)
    assert.match(readFileSync(join(outDir, 'RELEASE_NOTES.md'), 'utf8'), /Curated highlight/)
    assert.throws(() => readFileSync(join(outDir, 'docker-compose.yml')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeAssets emits the manifest, notes, pinned env and compose file', () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-release-'))
  const outDir = join(root, 'out')
  try {
    mkdirSync(join(root, 'docs/release-notes'), { recursive: true })
    writeFileSync(join(root, 'docs/release-notes/fork-v1.55.1-2.md'), '## Features\n\n- Curated highlight.\n')
    writeFileSync(join(root, '.env.prod.example'), 'BACKEND_IMAGE=old\nFRONTEND_IMAGE=old\n')
    writeFileSync(join(root, 'docker-compose.yml'), 'services:\n')
    const fields = validate(parseArgs([...validArgs, '--out', outDir]))
    const { manifest } = writeAssets(fields, outDir, root)

    const written = JSON.parse(readFileSync(join(outDir, 'release-manifest.json'), 'utf8'))
    assert.deepEqual(written, manifest)
    assert.equal(written.dry_run, false)
    assert.equal(written.images.backend.digest, digest('1'))
    assert.equal(written.images.backend.ref, `ghcr.io/lamiskin/pokecollector-backend@${digest('1')}`)
    assert.equal(written.upstream_base_sha, otherSha)
    assert.equal(written.upstream_main_tip_sha, sha)
    assert.equal(written.upstream_main_lag_commits, 0)
    assert.equal(written.fork_sha, sha)
    assert.deepEqual(written.platforms, ['linux/amd64', 'linux/arm64'])

    const notes = readFileSync(join(outDir, 'RELEASE_NOTES.md'), 'utf8')
    assert.match(notes, /fork-v1\.55\.1-2/)
    assert.match(notes, /Fork build of upstream 1\.55\.1/)
    assert.match(notes, /ghcr\.io\/lamiskin\/pokecollector-backend@sha256:1111/)
    assert.match(notes, /Curated highlight/)
    assert.match(notes, /No prior published fork release was found/)

    const env = readFileSync(join(outDir, 'pokecollector.env.example'), 'utf8')
    assert.match(env, /^BACKEND_IMAGE=ghcr\.io\/lamiskin\/pokecollector-backend@sha256:1111/m)

    assert.match(readFileSync(join(outDir, 'docker-compose.yml'), 'utf8'), /^services:/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release highlights are mandatory and must be non-empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-release-highlights-'))
  const outDir = join(root, 'out')
  const fields = validate(parseArgs([...baseArgs, '--dry-run', 'true', '--out', outDir]))
  try {
    mkdirSync(join(root, 'docs/release-notes'), { recursive: true })
    assert.throws(() => writeAssets(fields, outDir, root), /highlights file is missing/)
    writeFileSync(join(root, fields.highlights), ' \n\t')
    assert.throws(() => writeAssets(fields, outDir, root), /highlights file is empty/)
    writeFileSync(join(root, fields.highlights), '<!-- RELEASE-NOTES-TEMPLATE-PLACEHOLDER -->\n')
    assert.throws(() => writeAssets(fields, outDir, root), /replace the template placeholder/)
    assert.throws(
      () => writeAssets({ ...fields, highlights: 'docs/release-notes/other.md' }, outDir, root),
      /must be docs\/release-notes/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release notes include exact prior-release comparisons and point-in-time sync data', () => {
  const fields = validate(parseArgs(validArgs))
  const manifest = buildManifest({
    ...fields,
    upstreamTip: otherSha,
    upstreamLag: 3,
    priorRelease: {
      tag: 'fork-v1.55.1-1',
      fork_sha: otherSha,
      upstream_base_sha: sha,
    },
    upstreamChangeCount: 4,
    forkChangeCount: 7,
  }, '2026-11-04T00:00:00.000Z')
  const notes = renderNotes(manifest, '## Features\n\n- Verified feature.')

  assert.equal(manifest.upstream_main_tip_sha, otherSha)
  assert.equal(manifest.upstream_main_lag_commits, 3)
  assert.match(notes, /Git-Romer\/pokecollector\/compare\/a{40}\.\.\.b{40}/)
  assert.match(notes, /lamiskin\/pokecollector\/compare\/b{40}\.\.\.a{40}/)
  assert.match(notes, /4 commit\(s\)/)
  assert.match(notes, /7 commit\(s\)/)
  assert.match(notes, /point-in-time measurement/)
})

test('prior release comparisons must match the downloaded published manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fork-release-prior-'))
  const manifestPath = join(directory, 'release-manifest.json')
  writeFileSync(manifestPath, JSON.stringify({
    schema: 1,
    dry_run: false,
    tag: 'fork-v1.55.1-1',
    repository: 'lamiskin/pokecollector',
    fork_sha: otherSha,
    upstream_base_sha: sha,
  }))
  const comparisonArgs = [
    ...validArgs,
    '--prior-manifest', manifestPath,
    '--prior-tag', 'fork-v1.55.1-1',
    '--prior-sha', otherSha,
    '--prior-upstream-base', sha,
    '--upstream-change-count', '17',
    '--fork-change-count', '66',
  ]
  try {
    const fields = validate(parseArgs(comparisonArgs))
    assert.deepEqual(fields.priorRelease, {
      tag: 'fork-v1.55.1-1',
      fork_sha: otherSha,
      upstream_base_sha: sha,
    })
    assert.equal(fields.upstreamChangeCount, 17)
    assert.equal(fields.forkChangeCount, 66)
    const mismatchedArgs = [...comparisonArgs]
    mismatchedArgs[mismatchedArgs.indexOf('--prior-sha') + 1] = sha
    assert.throws(
      () => validate(parseArgs(mismatchedArgs)),
      /does not match the downloaded prior manifest/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
