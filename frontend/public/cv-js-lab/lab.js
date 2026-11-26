// Cross-origin-isolated detector lab. No framework, no build step.
//
// The page exists to answer one question on a real device: does multi-threaded
// onnxruntime-web WASM actually go faster than the single-threaded detector the
// app ships? That needs SharedArrayBuffer, which needs this document to be
// cross-origin isolated (COOP+COEP), which nginx sets only for /cv-js-lab/.
//
// This script owns the capture pump (no fixed interval: the next frame is
// captured the instant the previous result arrives) and the overlay drawing.
// The worker owns the model, the downscale and the inference loop.

const MODEL_URL = '/detector/cornelius-2.12.onnx'
const VENDOR_DIR = '/detector/vendor/'
const DETECTOR_SIZE = 384
// The runtime entry point plus the threaded wasm sidecar it resolves. A missing
// sidecar surfaces as a confusing "no available backend found", so it is part of
// the loud preflight instead.
const REQUIRED_ASSETS = [
  MODEL_URL,
  `${VENDOR_DIR}ort.wasm.min.mjs`,
  `${VENDOR_DIR}ort-wasm-simd-threaded.mjs`,
  `${VENDOR_DIR}ort-wasm-simd-threaded.wasm`,
]
const MEDIAN_WINDOW = 20
const READY_TIMEOUT_MS = 30000

const els = {
  banner: document.getElementById('banner'),
  video: document.getElementById('video'),
  overlay: document.getElementById('overlay'),
  hint: document.getElementById('stage-hint'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  threadCap: document.getElementById('thread-cap'),
  isolated: document.getElementById('s-isolated'),
  threads: document.getElementById('s-threads'),
  dps: document.getElementById('s-dps'),
  ms: document.getElementById('s-ms'),
  loop: document.getElementById('s-loop'),
  count: document.getElementById('s-count'),
  sharp: document.getElementById('s-sharp'),
}

const state = {
  worker: null,
  stream: null,
  running: false,
  paused: false,
  seq: 0,
  pendingSeq: 0,
  pendingResolve: null,
  pendingReject: null,
  readyResolve: null,
  readyReject: null,
  runMs: [],
  loopMs: [],
  stamps: [],
  detections: 0,
  frameWidth: 0,
  frameHeight: 0,
}

// ---------------------------------------------------------------- reporting

function showBanner(kind, title, bodyHtml = '') {
  els.banner.hidden = false
  els.banner.className = `banner ${kind}`
  els.banner.innerHTML = `<strong>${title}</strong>${bodyHtml}`
}

function hideBanner() {
  els.banner.hidden = true
  els.banner.innerHTML = ''
}

function setStat(el, text, tone = '') {
  el.textContent = text
  el.className = `v${tone ? ` ${tone}` : ''}`
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function detectionsPerSecond() {
  if (state.stamps.length < 2) return null
  const span = state.stamps[state.stamps.length - 1] - state.stamps[0]
  if (span <= 0) return null
  return ((state.stamps.length - 1) * 1000) / span
}

function renderStats(lastSharpness) {
  const isolated = window.crossOriginIsolated === true
  setStat(els.isolated, isolated ? 'true' : 'false', isolated ? 'ok' : 'bad')

  const dps = detectionsPerSecond()
  setStat(els.dps, dps === null ? '…' : dps.toFixed(1))

  const inference = median(state.runMs)
  setStat(els.ms, inference === null ? '…' : inference.toFixed(1))

  const loop = median(state.loopMs)
  setStat(els.loop, loop === null ? '…' : loop.toFixed(1))

  setStat(els.count, String(state.detections))
  setStat(els.sharp, Number.isFinite(lastSharpness) ? lastSharpness.toFixed(3) : '…')
}

function resetStats() {
  state.runMs = []
  state.loopMs = []
  state.stamps = []
  state.detections = 0
  renderStats(null)
}

// ---------------------------------------------------------------- preflight

// A diagnostic page that half-works is worse than one that refuses: check the
// assets the worker will need and name the exact missing URL.
async function preflight() {
  const missing = []
  await Promise.all(REQUIRED_ASSETS.map(async url => {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      if (!response.ok) missing.push(`${url} → HTTP ${response.status}`)
    } catch (error) {
      missing.push(`${url} → ${error?.message || String(error)}`)
    }
  }))
  if (!missing.length) return true

  showBanner(
    'error',
    'Detector assets are missing — this page cannot run',
    '<p>The build must fetch the detector before the frontend image is built '
      + '(<code>npm run fetch-detector-assets</code>, normally run by '
      + '<code>npm run build</code>). Missing:</p>'
      + `<ul>${missing.map(item => `<li><code>${item}</code></li>`).join('')}</ul>`,
  )
  return false
}

// ---------------------------------------------------------------- worker

function chooseThreadCap() {
  const requested = Number(els.threadCap.value) || 4
  const hardware = navigator.hardwareConcurrency || 1
  return Math.max(1, Math.min(requested, hardware))
}

function startWorker(threads) {
  const worker = new Worker('./lab-worker.js', { type: 'module' })
  const ready = new Promise((resolve, reject) => {
    state.readyResolve = resolve
    state.readyReject = reject
  })

  worker.onmessage = event => {
    const message = event.data || {}
    if (message.type === 'ready') {
      state.readyResolve?.(message)
      state.readyResolve = null
      state.readyReject = null
      return
    }
    if (message.type === 'result') {
      if (message.seq === state.pendingSeq) {
        const resolve = state.pendingResolve
        state.pendingResolve = null
        state.pendingReject = null
        resolve?.(message)
      }
      return
    }
    if (message.type === 'error') {
      const error = new Error(message.message || 'unknown worker error')
      if (message.seq && message.seq === state.pendingSeq) {
        const reject = state.pendingReject
        state.pendingResolve = null
        state.pendingReject = null
        reject?.(error)
        return
      }
      fail('Detector error', error.message)
    }
  }

  worker.onerror = event => {
    const error = new Error(event.message || 'worker crashed')
    state.readyReject?.(error)
    state.pendingReject?.(error)
    state.readyReject = null
    state.pendingReject = null
    fail('Worker crashed', error.message)
  }

  worker.postMessage({
    type: 'init',
    threads,
    modelUrl: MODEL_URL,
    wasmPaths: VENDOR_DIR,
    size: DETECTOR_SIZE,
  })
  state.worker = worker
  return ready
}

function waitForReady(ready) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the detector did not become ready within ${READY_TIMEOUT_MS / 1000}s`))
    }, READY_TIMEOUT_MS)
    ready.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function stopWorker() {
  if (state.worker) {
    state.worker.terminate()
    state.worker = null
  }
  state.pendingResolve = null
  state.pendingReject = null
}

// ---------------------------------------------------------------- camera

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia is unavailable (needs HTTPS or localhost)')
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  })
}

function closeCamera() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop()
    state.stream = null
  }
  els.video.srcObject = null
}

// ---------------------------------------------------------------- drawing

function clearOverlay() {
  const ctx = els.overlay.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height)
}

// Map normalised detector corners onto the letterboxed video content box, so the
// polygon sits on the card in the *rendered* preview rather than on the element.
function drawQuad(corners) {
  const canvas = els.overlay
  const rect = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, Math.round(rect.width * dpr))
  const height = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, rect.width, rect.height)

  const frameWidth = state.frameWidth || els.video.videoWidth
  const frameHeight = state.frameHeight || els.video.videoHeight
  if (!corners || corners.length !== 4 || !frameWidth || !frameHeight) return

  const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight)
  const drawnWidth = frameWidth * scale
  const drawnHeight = frameHeight * scale
  const offsetX = (rect.width - drawnWidth) / 2
  const offsetY = (rect.height - drawnHeight) / 2
  const points = corners.map(([x, y]) => [
    offsetX + Math.min(1, Math.max(0, x)) * drawnWidth,
    offsetY + Math.min(1, Math.max(0, y)) * drawnHeight,
  ])

  ctx.beginPath()
  points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.closePath()
  ctx.lineWidth = 2
  ctx.strokeStyle = '#4ade80'
  ctx.fillStyle = 'rgba(74, 222, 128, 0.12)'
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = '#4ade80'
  for (const [x, y] of points) {
    ctx.beginPath()
    ctx.arc(x, y, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }
}

// ---------------------------------------------------------------- loop

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function captureFrame() {
  // Downscale on the capture path: createImageBitmap resizes off the main thread
  // and the worker then only has to draw a 384×384 bitmap 1:1.
  try {
    return await createImageBitmap(els.video, {
      resizeWidth: DETECTOR_SIZE,
      resizeHeight: DETECTOR_SIZE,
      resizeQuality: 'low',
    })
  } catch {
    // Older engines reject the resize options; the worker downscales instead.
    return createImageBitmap(els.video)
  }
}

function detectFrame(bitmap) {
  const seq = ++state.seq
  return new Promise((resolve, reject) => {
    state.pendingSeq = seq
    state.pendingResolve = resolve
    state.pendingReject = reject
    state.worker.postMessage(
      { type: 'frame', seq, bitmap, frameWidth: els.video.videoWidth, frameHeight: els.video.videoHeight },
      [bitmap],
    )
  })
}

async function pump() {
  while (state.running) {
    if (state.paused) {
      await sleep(150)
      continue
    }
    if (els.video.readyState < 2 || !els.video.videoWidth) {
      await sleep(50)
      continue
    }

    const started = performance.now()
    let bitmap
    try {
      bitmap = await captureFrame()
    } catch (error) {
      fail('Frame capture failed', error?.message || String(error))
      return
    }
    if (!state.running) {
      bitmap.close?.()
      return
    }

    let result
    try {
      result = await detectFrame(bitmap)
    } catch (error) {
      if (!state.running) return
      fail('Detection failed', error?.message || String(error))
      return
    }
    if (!result) return

    const loopMs = performance.now() - started
    state.detections += 1
    state.runMs.push(result.runMs)
    state.loopMs.push(loopMs)
    state.stamps.push(performance.now())
    for (const list of [state.runMs, state.loopMs, state.stamps]) {
      if (list.length > MEDIAN_WINDOW) list.shift()
    }

    state.frameWidth = result.frameWidth || els.video.videoWidth
    state.frameHeight = result.frameHeight || els.video.videoHeight
    drawQuad(result.corners)
    renderStats(result.sharpness)
  }
}

// ---------------------------------------------------------------- lifecycle

function fail(title, detail) {
  showBanner(
    'error',
    title,
    `<p>${detail}</p>`
      + (/wasm|compile|content security policy|unsafe-eval/i.test(detail)
        ? '<p>If this names a CSP/WebAssembly compile error, the deployment must be built '
          + 'with <code>DETECTOR_ENABLED=true</code>: that widens the policy with '
          + "<code>'wasm-unsafe-eval'</code> and <code>worker-src 'self' blob:</code>.</p>"
        : ''),
  )
  stop()
}

function stop() {
  state.running = false
  state.paused = false
  stopWorker()
  closeCamera()
  clearOverlay()
  els.start.disabled = false
  els.stop.disabled = true
  els.threadCap.disabled = false
  els.hint.hidden = false
  els.hint.textContent = 'Stopped. Press Start camera to measure again.'
}

async function start() {
  if (state.running) return
  els.start.disabled = true
  els.stop.disabled = true
  hideBanner()
  els.hint.textContent = 'Checking detector assets…'

  if (!(await preflight())) {
    els.start.disabled = false
    return
  }

  els.hint.textContent = 'Requesting camera…'
  try {
    state.stream = await openCamera()
  } catch (error) {
    fail('Camera unavailable', error?.message || String(error))
    return
  }
  els.video.srcObject = state.stream
  try {
    await els.video.play()
  } catch (error) {
    fail('Camera preview did not start', error?.message || String(error))
    return
  }

  const threads = chooseThreadCap()
  els.hint.textContent = 'Loading detector…'
  resetStats()

  try {
    const info = await waitForReady(startWorker(threads))
    setStat(els.isolated, info.isolated ? 'true' : 'false', info.isolated ? 'ok' : 'bad')
    setStat(
      els.threads,
      `${info.granted}${info.granted === 1 && info.requested > 1 ? ' (capped)' : ''}`,
      info.granted > 1 ? 'ok' : 'warn',
    )
    if (!info.isolated) {
      showBanner(
        'warn',
        'NOT cross-origin isolated — running single-threaded',
        '<p>This page is worthless for threading measurement without COOP+COEP. '
          + 'The response is missing <code>Cross-Origin-Opener-Policy: same-origin</code> '
          + 'and/or <code>Cross-Origin-Embedder-Policy: require-corp</code> (check the '
          + '<code>/cv-js-lab/</code> nginx location), or the browser refused to grant '
          + 'isolation. <code>SharedArrayBuffer</code>: '
          + `<strong>${info.hasSAB ? 'available' : 'unavailable'}</strong>. `
          + `Requested ${info.requested} thread(s), got 1.</p>`,
      )
    } else if (info.granted <= 1) {
      showBanner(
        'warn',
        'Isolated, but only one thread was granted',
        `<p><code>SharedArrayBuffer</code> is ${info.hasSAB ? 'available' : 'unavailable'}, `
          + `hardwareConcurrency is ${info.hardwareConcurrency}. Check the thread cap above.</p>`,
      )
    } else {
      showBanner(
        'ok',
        `Cross-origin isolated · ${info.granted} WASM threads`,
        `<p>hardwareConcurrency ${info.hardwareConcurrency}, SIMD `
          + `${info.simd ? 'on' : 'off'}, wasm from <code>${info.wasmPaths}</code>.</p>`,
      )
    }
  } catch (error) {
    fail('Detector failed to load', error?.message || String(error))
    return
  }

  els.hint.hidden = true
  els.start.disabled = true
  els.stop.disabled = false
  els.threadCap.disabled = true
  state.running = true
  pump()
}

// ---------------------------------------------------------------- wiring

document.getElementById('start').addEventListener('click', start)
document.getElementById('stop').addEventListener('click', stop)

document.addEventListener('visibilitychange', () => {
  state.paused = document.hidden
})

window.addEventListener('resize', () => {
  if (!state.running) clearOverlay()
})

// Report isolation immediately: the whole point of the page is visible before
// the camera is even started.
renderStats(null)
if (window.crossOriginIsolated === true) {
  showBanner('ok', 'Cross-origin isolated', '<p>Press Start camera to measure multi-threaded inference.</p>')
} else {
  showBanner(
    'warn',
    'NOT cross-origin isolated — single thread only',
    '<p>This document did not receive COOP+COEP. Multi-threaded WASM needs '
      + '<code>SharedArrayBuffer</code>, so any measurement here is the slow single-thread '
      + 'baseline. Fix the <code>/cv-js-lab/</code> response headers before trusting results.</p>',
  )
}
