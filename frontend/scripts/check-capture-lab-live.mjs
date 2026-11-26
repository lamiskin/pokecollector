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

// Server assist: CollectorVision is polled beside the local detector, and the
// auto rule may prefer the server shape only while it is clearly cheaper.
expect(html.includes('id="assist-mode"'), 'index.html must contain the server assist control')
for (const mode of ['auto', 'off', 'on']) {
  expect(
    new RegExp(`<option value="${mode}"`).test(html),
    `index.html must offer server assist mode ${mode}`,
  )
}
// Assist is parked: it stays available as an instrument, but `off` is the
// default in both the control and the script state, and the page says so.
expect(/<option value="off"[^>]*selected/.test(html), 'server assist must default to off (parked)')
expect(!/<option value="auto"[^>]*selected/.test(html), 'server assist must not default to auto')
expect(script.includes("mode: 'off'"), 'live.js must default state.assist.mode to off')
expect(/parked/i.test(html), 'index.html must say the server assist is parked')
expect(html.includes('<code>on</code> is for experiments only'), 'index.html must scope on to experiments')
expect(html.includes('id="s-assist"'), 'index.html must show the server assist state')
expect(html.includes('id="assist-frame"'), 'index.html must contain the assist upload canvas')
expect(script.includes("'/api/capture-lab/cv-detect'"), 'live.js must poll the capture-lab cv-detect endpoint')
expect(script.includes('ASSIST_POLL_MS = 1100'), 'live.js must poll the server every 1100 ms')
expect(script.includes('ASSIST_TIMEOUT_MS = 15000'), 'live.js must time the server request out at 15 s')
expect(script.includes('ASSIST_UPLOAD_EDGE = 1280'), 'live.js must upload a 1280 px long edge')
expect(script.includes('ASSIST_JPEG_QUALITY = 0.8'), 'live.js must encode the upload at JPEG q0.8')
expect(script.includes('ASSIST_COST_RATIO = 0.8'), 'live.js must require the server below 0.8x local cost')
expect(script.includes('ASSIST_MIN_SAMPLES = 3'), 'live.js must require three samples from each side')
expect(script.includes('ASSIST_BACKOFF_MS = 30000'), 'live.js must back off for 30 s when the server is slower')
expect(script.includes('ASSIST_BLEND_MS = 250'), 'live.js must blend the ring to the server quad over 250 ms')
expect(script.includes('ASSIST_DISAGREE = 0.12'), 'live.js must flag disagreement above 12% mean corner distance')
expect(script.includes('ASSIST_MAX_PAIRS = 600'), 'live.js must cap the paired sample log at 600')
expect(script.includes('function quadIou'), 'live.js must compute polygon IoU for paired samples')
expect(script.includes('agreed:'), 'live.js must record whether a pair agreed')
expect(script.includes("localStorage.getItem('token')"), 'live.js must send the app bearer token')
expect(script.includes('assist: assistSummary(pairs)'), 'the experiment payload must carry an assist summary')
expect(
  script.includes('pairs: pairsForPayload(result.pairs)'),
  'each experiment run must carry its paired samples',
)

// Correctness and motion: a pair must carry timing, both sources' scores, the
// server's detection mode, the frame time and inter-pair motion, with quads in
// one canonical order so the analysis never has to re-derive corner order.
for (const field of [
  'localAt:', 'serverAt:', 'frameAt:', 'localSharpness:', 'localConfidence:',
  'serverSharpness:', 'serverConfidence:', 'serverDetection:', 'serverResized:',
  'motion:',
]) {
  expect(script.includes(field), `live.js must record the pair field ${field}`)
}
expect(script.includes('function canonicalQuad'), 'live.js must canonicalise quad corner order')
expect(
  /function canonicalQuad[\s\S]{0,900}?orderQuad\(/.test(script),
  "canonicalQuad must build on orderQuad's counter-clockwise winding",
)
expect(
  /function canonicalQuad[\s\S]{0,900}?slice\(start\)/.test(script),
  'canonicalQuad must rotate the winding to the top-left-most corner',
)
expect(
  script.includes('ASSIST_STILL_MOTION = 0.01'),
  'live.js must define the documented still-motion threshold',
)
expect(script.includes('medianIouStill:'), 'the assist summary must report a still-only median IoU')
for (const key of [
  'stillPairs:', 'movingPairs:', 'medianLocalSharpness:',
  'medianServerSharpness:', 'localFoundShare:',
]) {
  expect(script.includes(key), `the assist summary must report ${key}`)
}
expect(
  script.includes('assist: assistSummary(result.pairs)'),
  'each experiment run must carry its own assist summary',
)

// Ground-truth frames: at most two 480 px q0.6 JPEGs per run, taken from the
// worst- and median-IoU pair, and only when that pair has both quads.
expect(script.includes('ASSIST_FRAME_EDGE = 480'), 'live.js must encode ground-truth frames at a 480 px long edge')
expect(script.includes('ASSIST_FRAME_QUALITY = 0.6'), 'live.js must encode ground-truth frames at JPEG q0.6')
expect(script.includes('ASSIST_FRAME_MAX = 2'), 'live.js must cap ground-truth frames at 2 per run')
expect(script.includes("kind: 'worst'"), 'live.js must label the worst-IoU frame')
expect(script.includes("kind: 'median'"), 'live.js must label the median-IoU frame')
expect(script.includes('jpegB64'), 'a frame must carry its JPEG as base64')
expect(
  /pair\.localQuad && pair\.serverQuad && Number\.isFinite\(pair\.iou\)/.test(script),
  'a frame must be skipped when its pair lacks both quads',
)
expect(script.includes('frames: result.frames || []'), 'each experiment run must carry its frames')

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
