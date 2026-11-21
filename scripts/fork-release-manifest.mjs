import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

const TAG_PATTERN = /^fork-v(\d+\.\d+\.\d+)-(\d+)$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const NAMESPACE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const PLATFORM_PATTERN = /^linux\/[a-z0-9]+$/u

/**
 * Parse `--name value` pairs. Unknown or repeated options are errors so a typo
 * cannot silently produce a release manifest with a defaulted field.
 */
export function parseArgs(argv) {
  const known = new Set([
    'tag',
    'sha',
    'upstream-base',
    'upstream-tip',
    'upstream-lag',
    'highlights',
    'prior-manifest',
    'prior-tag',
    'prior-sha',
    'prior-upstream-base',
    'upstream-change-count',
    'fork-change-count',
    'namespace',
    'repository',
    'digest-backend',
    'digest-frontend',
    'platform',
    'backend-tests',
    'frontend-tests',
    'workflow-run',
    'dry-run',
    'out',
  ])
  const values = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument: ${arg}`)
    }
    const name = arg.slice(2)
    if (!known.has(name)) {
      throw new Error(`unknown option: --${name}`)
    }
    if (Object.hasOwn(values, name)) {
      throw new Error(`repeated option: --${name}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${name}`)
    }
    values[name] = value
    index += 1
  }

  return values
}

export function validate(input) {
  const errors = []
  const dryRun = input['dry-run'] === 'true'
  const required = [
    'tag',
    'sha',
    'upstream-base',
    'upstream-tip',
    'upstream-lag',
    'highlights',
    'namespace',
    'repository',
  ]
  if (!dryRun) {
    required.push('digest-backend', 'digest-frontend')
  }
  for (const name of required) {
    if (!input[name]) {
      errors.push(`--${name} is required`)
    }
  }
  if (errors.length) {
    throw new Error(errors.join('\n'))
  }
  if (dryRun && (input['digest-backend'] || input['digest-frontend'])) {
    errors.push('--dry-run must not carry image digests; nothing is pushed')
  }

  const tagMatch = TAG_PATTERN.exec(input.tag)
  if (!tagMatch) {
    errors.push(`--tag must look like fork-v1.55.1-1, got ${input.tag}`)
  }
  for (const name of ['sha', 'upstream-base']) {
    if (!SHA_PATTERN.test(input[name])) {
      errors.push(`--${name} must be a 40-character lowercase commit SHA, got ${input[name]}`)
    }
  }
  if (!SHA_PATTERN.test(input['upstream-tip'])) {
    errors.push(`--upstream-tip must be a 40-character lowercase commit SHA, got ${input['upstream-tip']}`)
  }
  if (!/^\d+$/u.test(input['upstream-lag'])) {
    errors.push(`--upstream-lag must be a non-negative commit count, got ${input['upstream-lag']}`)
  }
  for (const name of ['digest-backend', 'digest-frontend']) {
    if (!dryRun && !DIGEST_PATTERN.test(input[name])) {
      errors.push(`--${name} must be sha256:<64 lowercase hex>, got ${input[name]}`)
    }
  }
  if (!NAMESPACE_PATTERN.test(input.namespace)) {
    errors.push(`--namespace must be a lowercase registry namespace, got ${input.namespace}`)
  }
  const platforms = (input.platform ?? 'linux/amd64,linux/arm64').split(',')
  if (platforms.some((platform) => !PLATFORM_PATTERN.test(platform)) || new Set(platforms).size !== platforms.length) {
    errors.push(`--platform must be a comma-separated list of unique linux/<arch> values, got ${input.platform}`)
  }
  const repository = input.repository ?? ''
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    errors.push(`--repository must be owner/name, got ${repository}`)
  }
  if (errors.length) {
    throw new Error(errors.join('\n'))
  }

  let priorRelease = null
  if (input['prior-manifest']) {
    let prior
    try {
      prior = JSON.parse(readFileSync(resolve(root, input['prior-manifest']), 'utf8'))
    } catch (error) {
      errors.push(`--prior-manifest could not be read: ${error.message}`)
    }
    if (prior) {
      if (prior.schema !== 1 || prior.repository !== repository || !TAG_PATTERN.test(prior.tag ?? '') || prior.tag === input.tag || !SHA_PATTERN.test(prior.fork_sha ?? '') || !SHA_PATTERN.test(prior.upstream_base_sha ?? '') || prior.dry_run !== false) {
        errors.push('--prior-manifest must be a published fork manifest with valid tag, fork_sha and upstream_base_sha')
      } else {
        priorRelease = { tag: prior.tag, fork_sha: prior.fork_sha, upstream_base_sha: prior.upstream_base_sha }
        for (const [option, field] of [['prior-tag', prior.tag], ['prior-sha', prior.fork_sha], ['prior-upstream-base', prior.upstream_base_sha]]) {
          if (input[option] !== field) errors.push(`--${option} does not match the downloaded prior manifest`)
        }
        if (!/^\d+$/u.test(input['upstream-change-count'] ?? '') || !/^\d+$/u.test(input['fork-change-count'] ?? '')) {
          errors.push('--upstream-change-count and --fork-change-count are required with --prior-manifest')
        }
      }
    }
  } else if (['prior-tag', 'prior-sha', 'prior-upstream-base', 'upstream-change-count', 'fork-change-count'].some((name) => input[name] !== undefined)) {
    errors.push('prior release details and comparison counts require --prior-manifest')
  }
  if (errors.length) throw new Error(errors.join('\n'))

  const [, upstreamVersion, releaseNumber] = tagMatch
  return {
    tag: input.tag,
    forkVersion: `${upstreamVersion}-${releaseNumber}`,
    upstreamVersion,
    sha: input.sha,
    upstreamBase: input['upstream-base'],
    upstreamTip: input['upstream-tip'],
    upstreamLag: Number(input['upstream-lag']),
    highlights: input.highlights,
    priorRelease,
    upstreamChangeCount: input['upstream-change-count'] === undefined ? null : Number(input['upstream-change-count']),
    forkChangeCount: input['fork-change-count'] === undefined ? null : Number(input['fork-change-count']),
    namespace: input.namespace,
    repository,
    dryRun,
    digestBackend: input['digest-backend'],
    digestFrontend: input['digest-frontend'],
    platforms,
    backendTests: input['backend-tests'] ?? 'success',
    frontendTests: input['frontend-tests'] ?? 'success',
    workflowRun: input['workflow-run'] ?? '',
    out: input.out ?? 'release-assets',
  }
}

function imageRef(namespace, image, digest) {
  return `ghcr.io/${namespace}/pokecollector-${image}@${digest}`
}

export function buildManifest(fields, generatedAt) {
  const images = {
    backend: {
      tag_ref: `ghcr.io/${fields.namespace}/pokecollector-backend:${fields.tag}`,
      digest: fields.dryRun ? null : fields.digestBackend,
      ref: fields.dryRun ? null : imageRef(fields.namespace, 'backend', fields.digestBackend),
    },
    frontend: {
      tag_ref: `ghcr.io/${fields.namespace}/pokecollector-frontend:${fields.tag}`,
      digest: fields.dryRun ? null : fields.digestFrontend,
      ref: fields.dryRun ? null : imageRef(fields.namespace, 'frontend', fields.digestFrontend),
    },
  }

  return {
    schema: 1,
    dry_run: fields.dryRun,
    tag: fields.tag,
    fork_version: fields.forkVersion,
    upstream_version: fields.upstreamVersion,
    repository: fields.repository,
    fork_sha: fields.sha,
    upstream_base_sha: fields.upstreamBase,
    upstream_main_tip_sha: fields.upstreamTip,
    upstream_main_lag_commits: fields.upstreamLag,
    prior_release: fields.priorRelease,
    upstream_changes_since_prior: fields.upstreamChangeCount,
    fork_changes_since_prior: fields.forkChangeCount,
    highlights_file: `docs/release-notes/${fields.tag}.md`,
    platforms: fields.platforms ?? [fields.platform ?? 'linux/amd64'],
    images,
    tests: {
      backend: fields.backendTests,
      frontend: fields.frontendTests,
    },
    migrations: {
      run_at_startup: true,
      upstream_version: fields.upstreamVersion,
    },
    workflow_run: fields.workflowRun,
    generated_at: generatedAt,
  }
}

export function renderNotes(manifest, highlights) {
  const { images } = manifest
  const warning = manifest.dry_run
    ? '**Dry run — the images were built but not pushed. This manifest is not deployable.**\n\n'
    : ''
  const imageLines = manifest.dry_run
    ? '- not pushed (dry run)'
    : `- backend: \`${images.backend.ref}\`\n- frontend: \`${images.frontend.ref}\``

  return `${warning}# PokéCollector fork release ${manifest.tag}

Fork build of upstream ${manifest.upstream_version}, pinned by image digest.

| | |
| --- | --- |
| Fork commit | \`${manifest.fork_sha}\` |
| Upstream base (fork's adopted upstream position) | \`${manifest.upstream_base_sha}\` |
| Upstream \`origin/main\` mirror tip at workflow run | \`${manifest.upstream_main_tip_sha}\` |
| Commits \`origin/main\` was ahead of release base at workflow run | ${manifest.upstream_main_lag_commits} |
| Platform | ${manifest.platforms.join(', ')} |
| Backend tests | ${manifest.tests.backend} |
| Frontend tests | ${manifest.tests.frontend} |

## Fork highlights

${highlights.trim()}

## Upstream sync position

\`main\` is the fast-forward mirror of upstream \`main\`; \`fork/main\` is the stable fork branch and adopts upstream only after integration. This release is based on upstream commit \`${manifest.upstream_base_sha}\`. At workflow run time, the mirror tip was \`${manifest.upstream_main_tip_sha}\`, ${manifest.upstream_main_lag_commits} commit(s) ahead of that base. This is a point-in-time measurement, not a claim about the mirror's state now.

## Upstream changes since the prior published fork release

${manifest.prior_release
    ? `Since [${manifest.prior_release.tag}](https://github.com/${manifest.repository}/releases/tag/${manifest.prior_release.tag}) (upstream base \`${manifest.prior_release.upstream_base_sha}\`): [compare upstream bases](https://github.com/Git-Romer/pokecollector/compare/${manifest.prior_release.upstream_base_sha}...${manifest.upstream_base_sha}) — ${manifest.upstream_changes_since_prior} commit(s).`
    : 'No prior published fork release was found; comparison ranges are omitted.'}

## Fork release commit range since the prior published fork release

${manifest.prior_release
    ? `The full fork history range since [${manifest.prior_release.tag}](https://github.com/${manifest.repository}/releases/tag/${manifest.prior_release.tag}) (fork commit \`${manifest.prior_release.fork_sha}\`) spans ${manifest.fork_changes_since_prior} commit(s): [compare fork commits](https://github.com/${manifest.repository}/compare/${manifest.prior_release.fork_sha}...${manifest.fork_sha}). This range includes upstream and fork-specific commits; fork-only feature highlights are listed above.`
    : 'No prior published fork release was found; comparison ranges are omitted.'}

## Tests

- Backend: ${manifest.tests.backend}
- Frontend tests and build: ${manifest.tests.frontend}

## Pinned images

Pull by digest; do not rebuild or substitute upstream images.

${imageLines}

## Deploy

1. Take a consistent database and media backup, and verify it restores.
2. Copy \`pokecollector.env.example\` to \`.env.prod\`, keep the two image lines,
   and fill in the instance's own secrets.
3. \`./scripts/instance.sh prod up -d\` — the pinned images are pulled by digest.
4. Check readiness, login, collection counts and photos before use.

Migrations run at backend startup. A failed migration or an incompatible schema
needs the matching backup, not an image-only rollback.

## Rollback

Point \`BACKEND_IMAGE\` and \`FRONTEND_IMAGE\` back at the previous release's
digests, then \`./scripts/instance.sh prod up -d\`. If this release changed the
schema, restore the database backup taken before the upgrade first.
`
}

/**
 * Pin the two image variables in a copy of the Prod env example. The source
 * file is the deployment template operators actually copy, so a missing line is
 * a hard error rather than a quietly unpinned release.
 */
export function pinEnvExample(source, manifest) {
  const { images } = manifest
  const replacements = [
    ['BACKEND_IMAGE', images.backend.ref],
    ['FRONTEND_IMAGE', images.frontend.ref],
  ]

  let output = source
  for (const [name, ref] of replacements) {
    const pattern = new RegExp(`^${name}=.*$`, 'mu')
    if (!pattern.test(output)) {
      throw new Error(`.env.prod.example has no ${name}= line to pin`)
    }
    output = output.replace(pattern, `${name}=${ref}`)
  }
  return output
}

export function writeAssets(fields, outDir = fields.out, repoRoot = root) {
  const highlightsPath = resolve(repoRoot, fields.highlights)
  if (fields.highlights !== `docs/release-notes/${fields.tag}.md`) {
    throw new Error(`highlights file must be docs/release-notes/${fields.tag}.md`)
  }
  let highlights
  try {
    highlights = readFileSync(highlightsPath, 'utf8')
  } catch {
    throw new Error(`required highlights file is missing: ${fields.highlights}`)
  }
  if (!highlights.trim()) throw new Error(`required highlights file is empty: ${fields.highlights}`)
  if (highlights.includes('<!-- RELEASE-NOTES-TEMPLATE-PLACEHOLDER -->')) {
    throw new Error(`replace the template placeholder in ${fields.highlights} with release-specific notes`)
  }
  const manifest = buildManifest(fields, new Date().toISOString())
  const absoluteOut = resolve(repoRoot, outDir)
  mkdirSync(absoluteOut, { recursive: true })

  writeFileSync(resolve(absoluteOut, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(resolve(absoluteOut, 'RELEASE_NOTES.md'), renderNotes(manifest, highlights))

  // A dry run has no digests to pin, so it ships nothing an operator could
  // mistake for a deployable deployment file.
  if (!manifest.dry_run) {
    const envSource = readFileSync(resolve(repoRoot, '.env.prod.example'), 'utf8')
    writeFileSync(resolve(absoluteOut, 'pokecollector.env.example'), pinEnvExample(envSource, manifest))
    copyFileSync(resolve(repoRoot, 'docker-compose.yml'), resolve(absoluteOut, 'docker-compose.yml'))
  }

  return { manifest, outDir: absoluteOut }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const fields = validate(parseArgs(process.argv.slice(2)))
    const { manifest, outDir } = writeAssets(fields)
    console.log(`Wrote release assets for ${manifest.tag} to ${outDir}`)
    for (const [name, image] of Object.entries(manifest.images)) {
      console.log(`${name}: ${image.ref}`)
    }
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
