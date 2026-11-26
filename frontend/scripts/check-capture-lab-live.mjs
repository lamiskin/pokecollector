// Guards the standalone /capture-lab-live/ diagnostic: it is static (no SPA
// build step), reuses the app's compiled detector worker through the Vite
// manifest, and only gets a WASM thread pool when the document is cross-origin
// isolated. Each of those is easy to break silently, so assert the wiring here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')

const failures = []
const expect = (condition, message) => {
  if (!condition) failures.push(message)
}

const html = read('public', 'capture-lab-live', 'index.html')
const script = read('public', 'capture-lab-live', 'live.js')
const css = read('public', 'capture-lab-live', 'live.css')
const worker = read('src', 'workers', 'cardDetector.worker.js')
const nginx = read('nginx.conf')
const sw = read('src', 'sw', 'sw.js')
const vite = read('vite.config.js')

// The page is its own document, wired to its own assets.
expect(/<script[^>]+src="\.\/live\.js"/.test(html), 'index.html must load ./live.js')
expect(/<link[^>]+href="\.\/live\.css"/.test(html), 'index.html must load ./live.css')
expect(html.includes('id="stage"'), 'index.html must contain the camera stage')
expect(css.includes('backdrop-filter'), 'live.css must carry the optional blur layer')

// Reuse, not a copy: the compiled worker is resolved from the build manifest.
expect(script.includes("'/.vite/manifest.json'"), 'live.js must read the Vite manifest')
expect(script.includes("'src/workers/cardDetector.worker.js'"), 'live.js must name the app worker source')
expect(!/new Worker\(\s*['"]\.\/live-worker\.js/.test(script), 'live.js must not fall back to a copied worker')
expect(vite.includes('manifest: true'), 'vite.config.js must emit the build manifest')

// Threading guard: request a pool only when isolation and SharedArrayBuffer exist.
expect(script.includes('crossOriginIsolated'), 'live.js must check crossOriginIsolated')
expect(script.includes('SharedArrayBuffer'), 'live.js must check SharedArrayBuffer')
expect(script.includes('Math.min(THREAD_CAP, hardware)'), 'live.js must cap threads at min(4, hardware)')
expect(/numThreads = threads/.test(worker), 'the worker must accept the requested thread count')
expect(worker.includes('isolated && hasSAB ? requested : 1'), 'the worker must clamp threads without isolation')

// Serving rules.
expect(nginx.includes('location ^~ /capture-lab-live/'), 'nginx.conf must scope the page location')
expect(/Cross-Origin-Opener-Policy "same-origin"/.test(nginx), 'nginx.conf must send COOP for the page')
expect(/Cross-Origin-Embedder-Policy "require-corp"/.test(nginx), 'nginx.conf must send COEP for the page')
expect(/capture-lab-live\//.test(sw) && sw.includes("startsWith('/capture-lab-live/')"), 'the service worker must not serve the SPA shell for the page')

if (failures.length) {
  console.error('capture-lab-live check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('capture-lab-live check passed')
