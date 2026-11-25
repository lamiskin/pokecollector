// Blob workers cannot resolve relative imports: the built chunk keeps the
// specifier verbatim, there is no base URL, and the module graph fails before
// the worker posts anything. Every worker-side dependency must be inlined.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../src/workers', import.meta.url)
const files = []
for (const name of readdirSync(root)) {
  const path = join(root.pathname, name)
  if (statSync(path).isFile() && /\.(js|jsx|ts|tsx)$/.test(name)) files.push(path)
}

const offenders = []
for (const path of files) {
  const source = readFileSync(path, 'utf8')
  const pattern = /(?:from\s+|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g
  let match
  while ((match = pattern.exec(source))) {
    offenders.push(`${relative(process.cwd(), path)}: ${match[1]}`)
  }
}

if (offenders.length) {
  console.error('Relative imports found in worker source:')
  for (const offender of offenders) console.error(`- ${offender}`)
  console.error(
    'Workers are started from a blob with no base URL; Vite leaves relative '
    + 'specifiers verbatim and the built chunk fails to evaluate. Inline the dependency.',
  )
  process.exit(1)
}

console.log('worker import sanity check passed')
