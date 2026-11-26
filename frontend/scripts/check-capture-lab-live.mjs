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
expect(script.includes('Math.min(cap, hardware)'), 'live.js must cap threads at min(selected cap, hardware)')

// The thread cap is selectable so the same device can be compared A/B, and the
// page must show the requested cap next to the grant.
for (const cap of ['1', '2', '4', '8']) {
  expect(
    new RegExp(`<option value="${cap}">${cap}</option>`).test(html),
    `index.html must offer thread cap ${cap}`,
  )
}
expect(html.includes('id="thread-cap"'), 'index.html must contain the thread cap control')
expect(html.includes('id="s-cap"'), 'index.html must show the requested thread cap')
expect(script.includes('DEFAULT_THREAD_CAP'), 'live.js must default the cap to min(4, hardwareConcurrency)')
expect(script.includes('matched'), 'live.js must report whether the thread grant matched')

// Resolution knobs: the camera track is renegotiated live and the detector input
// only resizes the frame canvas, so neither may restart the worker.
expect(html.includes('id="camera-size"'), 'index.html must contain the camera size control')
expect(html.includes('id="detector-size"'), 'index.html must contain the detector input control')
for (const label of ['Max (capability)', '1920 × 1080', '1280 × 720', '960 × 540']) {
  expect(html.includes(label), `index.html must offer camera size ${label}`)
}
for (const edge of ['320', '480', '640', '960']) {
  expect(
    new RegExp(`<option value="${edge}"`).test(html),
    `index.html must offer detector input ${edge}`,
  )
}
expect(script.includes('DEFAULT_DETECTOR_EDGE = 640'), 'live.js must default the detector input to 640')
expect(script.includes('applyConstraints'), 'live.js must renegotiate the camera on the live track')
expect(script.includes('cameraNote'), 'live.js must report a rejected camera size instead of dropping the stream')
expect(script.includes('state.detectorEdge'), 'live.js must size the detection canvas from the selected input edge')
expect(!script.includes('FRAME_MAX_EDGE'), 'live.js must not hard-code the detection edge')
const detectorWiring = script.slice(script.indexOf('els.detectorSize.addEventListener'))
const detectorBlock = detectorWiring.slice(0, detectorWiring.indexOf('})') + 2)
expect(
  detectorBlock.includes('changeDetectorEdge') && !detectorBlock.includes('restartWorker'),
  'changing the detector input must not restart the worker',
)

// A/B helper: a 10 s window per cap, results printed and kept for the session.
expect(html.includes('id="ab-run"'), 'index.html must contain the A/B run button')
expect(script.includes('AB_DURATION_MS = 10000'), 'live.js must run the A/B window for 10 s')
expect(script.includes('restartWorker'), 'live.js must restart the worker when the cap changes')
expect(script.includes('formatAbLine'), 'live.js must print one result line per cap')
expect(html.includes('id="ab-run-input"'), 'index.html must show the input in the A/B run button')
expect(script.includes('AB.cam = resolvedCameraLabel()'), 'live.js must record the resolved camera size per A/B run')
expect(
  /cap \$\{[^}]+\} · cam \$\{[^}]+\} · in \$\{[^}]+\} →/.test(script),
  'live.js must print cap · cam · in on each A/B line',
)
expect(
  script.includes('entry.cap === result.cap')
    && script.includes('entry.cam === result.cam')
    && script.includes('entry.edge === result.edge'),
  'live.js must key A/B results by cap, camera and input',
)
expect(script.includes('runAtSettings'), 'live.js must offer repeats at another cap or input')
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
