import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildManifest,
  parseArgs,
  pinEnvExample,
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
  assert.equal(fields.platform, 'linux/amd64')
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
  const outDir = mkdtempSync(join(tmpdir(), 'fork-release-dry-'))
  try {
    const fields = validate(parseArgs([...baseArgs, '--dry-run', 'true', '--out', outDir]))
    writeAssets(fields)

    const manifest = JSON.parse(readFileSync(join(outDir, 'release-manifest.json'), 'utf8'))
    assert.equal(manifest.dry_run, true)
    assert.equal(manifest.images.backend.digest, null)
    assert.equal(manifest.images.backend.ref, null)
    assert.match(readFileSync(join(outDir, 'RELEASE_NOTES.md'), 'utf8'), /Dry run/)
    assert.throws(() => readFileSync(join(outDir, 'docker-compose.yml')))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('writeAssets emits the manifest, notes, pinned env and compose file', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'fork-release-'))
  try {
    const fields = validate(parseArgs([...validArgs, '--out', outDir]))
    const { manifest } = writeAssets(fields)

    const written = JSON.parse(readFileSync(join(outDir, 'release-manifest.json'), 'utf8'))
    assert.deepEqual(written, manifest)
    assert.equal(written.dry_run, false)
    assert.equal(written.images.backend.digest, digest('1'))
    assert.equal(written.images.backend.ref, `ghcr.io/lamiskin/pokecollector-backend@${digest('1')}`)
    assert.equal(written.upstream_base_sha, otherSha)
    assert.equal(written.fork_sha, sha)

    const notes = readFileSync(join(outDir, 'RELEASE_NOTES.md'), 'utf8')
    assert.match(notes, /fork-v1\.55\.1-2/)
    assert.match(notes, /Fork build of upstream 1\.55\.1/)
    assert.match(notes, /ghcr\.io\/lamiskin\/pokecollector-backend@sha256:1111/)

    const env = readFileSync(join(outDir, 'pokecollector.env.example'), 'utf8')
    assert.match(env, /^BACKEND_IMAGE=ghcr\.io\/lamiskin\/pokecollector-backend@sha256:1111/m)

    assert.match(readFileSync(join(outDir, 'docker-compose.yml'), 'utf8'), /^services:/m)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
