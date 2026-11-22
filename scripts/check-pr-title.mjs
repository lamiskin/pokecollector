import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Conventional Commit types accepted in this repository. Kept in sync with the
// guidance in AGENTS.md and docs/FORK_WORKFLOW.md.
export const TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
]

const TITLE_PATTERN = new RegExp(
  `^(${TYPES.join('|')})(?:\\(([a-z0-9]+(?:-[a-z0-9]+)*)\\))?: (\\S.*)$`,
  'u',
)

// Returns a list of problems with a pull request title; empty means acceptable.
export function checkPrTitle(title) {
  const value = typeof title === 'string' ? title.trim() : ''

  if (!value) {
    return ['The pull request title is empty.']
  }

  const match = value.match(TITLE_PATTERN)
  if (!match) {
    return [
      `"${value}" must start with a Conventional Commit type and a colon, for example "feat: add binder pages" or "docs(fork): register fork-v1.57.9-7". Accepted types: ${TYPES.join(', ')}.`,
    ]
  }

  const summary = match[3]
  if (summary.endsWith('.')) {
    return [`"${value}" should not end its summary with a period.`]
  }

  return []
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const title = process.argv[2] ?? process.env.PR_TITLE ?? ''
  const errors = checkPrTitle(title)

  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }

  console.log('The pull request title follows the repository naming scheme.')
}
