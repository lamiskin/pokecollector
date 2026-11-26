// Capture lab live — our detector, our ring, measured with threads.
//
// This is a static diagnostic served outside the SPA, from a location that sets
// COOP+COEP (nginx.conf). Cross-origin isolation is what makes
// SharedArrayBuffer (and therefore multi-threaded onnxruntime-web WASM)
// available, so the page can measure our own detector with a real thread pool
// instead of CollectorVision's minimal /cv-js-lab/.
//
// Nothing here captures, stores or uploads anything: one camera feed, one
// detector worker, one ring and a telemetry strip.
//
// The worker is the app's own src/workers/cardDetector.worker.js, not a copy.
// Vite emits it as a content-hashed asset and records it in the build manifest
// (.vite/manifest.json), because the page cannot know the hash at author time.
// The worker is started from a blob that imports that URL, mirroring
// CaptureLab.loadDetector (src/pages/CaptureLab.jsx lines 1244-1257): a blob
// worker inherits the document's CSP, which avoids a cached asset keeping a
// stale policy that would block the detector's wasm.

const MANIFEST_URL = '/.vite/manifest.json'
const WORKER_SOURCE = 'src/workers/cardDetector.worker.js'
const EXPERIMENTS_PATH = '/api/capture-lab/experiments'
const RUNTIME = 'wasm'
// The page offers a few caps so the same device can be compared A/B: a pool can
// help, or hurt when the phone is thermally limited or the cores are contended.
const THREAD_CAPS = [1, 2, 4, 8]
const DEFAULT_THREAD_CAP = 4
const AB_DURATION_MS = 10000

// Camera presets. 'max' re-applies the track's capability maximum (the start
// default); the rest are explicit ideal sizes. A rejected change keeps the
// stream that already works and says so in the camera stat.
const CAMERA_SIZES = [
  { key: 'max', label: 'Max (capability)', width: null, height: null },
  { key: '1920x1080', label: '1920 × 1080', width: 1920, height: 1080 },
  { key: '1280x720', label: '1280 × 720', width: 1280, height: 720 },
  { key: '960x540', label: '960 × 540', width: 960, height: 540 },
]
const DEFAULT_CAMERA_SIZE = 'max'

// Detector input long edge. The model squashes to 384x384 itself, so this only
// trades detection detail against per-frame cost; changing it resizes the frame
// canvas for the next tick and never restarts the worker.
const DETECTOR_EDGES = [320, 480, 640, 960]
const DEFAULT_DETECTOR_EDGE = 640
const DETECT_GAP_MS = 20
const MEDIAN_WINDOW = 20
const RATE_WINDOW_MS = 3000

const SMOOTHING = 0.35
const SNAP_DISTANCE = 0.28
const SOLID_HOLD_MS = 450
const QUAD_STALE_MS = 800
const MIN_SHARPNESS = 0.02

const GOLD = '#f5c842'
const GREEN = '#4ade80'
const BLUR_HOLE_MARGIN = 9
const BLUR_MASK_STEP_PX = 0.5

const READY_TIMEOUT_MS = 30000

const els = {
  banner: document.getElementById('banner'),
  stage: document.getElementById('stage'),
  video: document.getElementById('video'),
  blur: document.getElementById('blur'),
  overlay: document.getElementById('overlay'),
  hint: document.getElementById('stage-hint'),
  pill: document.getElementById('pill'),
  pillText: document.getElementById('pill-text'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  cap: document.getElementById('thread-cap'),
  cameraSize: document.getElementById('camera-size'),
  detectorSize: document.getElementById('detector-size'),
  isolated: document.getElementById('s-isolated'),
  threads: document.getElementById('s-threads'),
  capStat: document.getElementById('s-cap'),
  rate: document.getElementById('s-rate'),
  ms: document.getElementById('s-ms'),
  camera: document.getElementById('s-camera'),
  frame: document.getElementById('s-frame'),
  count: document.getElementById('s-count'),
  sharp: document.getElementById('s-sharp'),
  blurState: document.getElementById('blur-state'),
  workerSrc: document.getElementById('worker-src'),
  abRun: document.getElementById('ab-run'),
  abRunCap: document.getElementById('ab-run-cap'),
  abRunInput: document.getElementById('ab-run-input'),
  abStatus: document.getElementById('ab-status'),
  abResults: document.getElementById('ab-results'),
  abRepeat: document.getElementById('ab-repeat'),
  abLabel: document.getElementById('ab-label'),
  abSend: document.getElementById('ab-send'),
  abSendStatus: document.getElementById('ab-send-status'),
}

const HARDWARE = navigator.hardwareConcurrency || 1
// min(4, hardwareConcurrency) rounded down to an offered cap (a 3-core phone
// gets 2, not a cap the worker cannot honour).
const DEFAULT_CAP = THREAD_CAPS.filter(cap => cap <= Math.min(DEFAULT_THREAD_CAP, HARDWARE)).pop() || 1

const state = {
  running: false,
  restarting: false,
  restartPromise: null,
  stream: null,
  worker: null,
  blobUrl: '',
  workerUrl: '',
  readyResolve: null,
  readyReject: null,
  seq: 0,
  inFlight: false,
  timer: null,
  frameSize: null,
  cameraMaximum: null,
  cameraSettings: null,
  cameraSize: DEFAULT_CAMERA_SIZE,
  cameraNote: '',
  detectorEdge: DEFAULT_DETECTOR_EDGE,
  threads: {
    cap: DEFAULT_CAP,
    requested: 0,
    granted: 0,
    matched: false,
    // Known before Start: the page is already isolated (or not) at load time.
    isolated: window.crossOriginIsolated === true,
    hasSAB: typeof SharedArrayBuffer !== 'undefined',
    hardware: HARDWARE,
  },
  quad: null,
  lastQuadAt: 0,
  lastUsableAt: 0,
  lastSharpness: null,
  detections: 0,
  stamps: [],
  runSamples: [],
  phase: 'idle',
  pillText: '',
  pillTone: '',
  blurKey: null,
  blurSize: null,
  blurShown: false,
  // A/B runs survive Start/Stop for the session; only a reload clears them.
  abResults: [],
  // Nothing is uploaded automatically: only Send results posts the list.
  abSending: false,
  abSendError: '',
}

// One measurement window: the detector loop keeps running unchanged, we just
// timestamp what arrives inside the window.
const AB = {
  active: false,
  cap: 0,
  cam: '',
  edge: DEFAULT_DETECTOR_EDGE,
  startedAt: 0,
  samples: [],
  stamps: [],
  endTimer: null,
  countdownTimer: null,
}

// ------------------------------------------------------------------ reporting

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

function cameraPreset(key) {
  return CAMERA_SIZES.find(preset => preset.key === key) || CAMERA_SIZES[0]
}

function resolvedCameraLabel() {
  const width = els.video.videoWidth
  const height = els.video.videoHeight
  return width && height ? `${width}×${height}` : '—'
}

function frameDimensions(width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function detectionsPerSecond() {
  const now = performance.now()
  while (state.stamps.length && state.stamps[0] < now - RATE_WINDOW_MS) state.stamps.shift()
  if (state.stamps.length < 2) return null
  const span = state.stamps[state.stamps.length - 1] - state.stamps[0]
  if (span <= 0) return null
  return ((state.stamps.length - 1) * 1000) / span
}

function pushSample(list, value) {
  list.push(value)
  if (list.length > MEDIAN_WINDOW) list.shift()
}

function renderTelemetry() {
  const isolated = state.threads.isolated
  setStat(els.isolated, isolated ? 'true' : 'false', isolated ? 'ok' : 'bad')

  const granted = state.threads.granted
  const requested = state.threads.requested
  const cap = state.threads.cap
  setStat(
    els.threads,
    granted ? String(granted) : '…',
    granted > 1 ? 'ok' : granted ? 'warn' : '',
  )
  const capLabel = !granted
    ? `cap ${cap}`
    : !state.threads.isolated
      ? `cap ${cap} · single thread (not isolated)`
      : state.threads.matched
        ? `cap ${cap} · asked ${requested} · matched`
        : `cap ${cap} · asked ${requested} · got ${granted}`
  setStat(
    els.capStat,
    capLabel,
    granted ? (state.threads.isolated && state.threads.matched ? 'ok' : 'warn') : '',
  )
  els.capStat.title = granted
    ? `Selected cap ${cap}; requested ${requested} of ${state.threads.hardware} hardware threads; the worker granted ${granted}.`
    : `Selected cap ${cap}; the grant is known after Start.`

  const rate = detectionsPerSecond()
  setStat(els.rate, rate === null ? '…' : rate.toFixed(1))

  const inference = median(state.runSamples)
  setStat(els.ms, inference === null ? '…' : inference.toFixed(1))

  const video = els.video
  const width = video.videoWidth
  const height = video.videoHeight
  const camText = width && height ? `${width} × ${height}` : '…'
  setStat(
    els.camera,
    state.cameraNote ? `${camText} · ${state.cameraNote}` : camText,
    state.cameraNote ? 'warn' : '',
  )
  if (width && height) {
    const settings = state.cameraSettings || {}
    const maximum = state.cameraMaximum
    const requested = cameraPreset(state.cameraSize).label
    els.camera.title = [
      `requested ${requested}`,
      settings.width && settings.height ? `track ${settings.width}×${settings.height}` : '',
      maximum ? `capability max ${maximum.width}×${maximum.height}` : '',
    ].filter(Boolean).join(' · ')
  }

  const frame = state.frameSize
  setStat(els.frame, frame ? `${frame.width} × ${frame.height}` : '…')

  setStat(els.count, String(state.detections))
  setStat(els.sharp, Number.isFinite(state.lastSharpness) ? state.lastSharpness.toFixed(3) : '…')
}

function resetTelemetry() {
  state.frameSize = null
  state.lastSharpness = null
  state.detections = 0
  state.stamps = []
  state.runSamples = []
  state.quad = null
  state.lastQuadAt = 0
  state.lastUsableAt = 0
  state.phase = 'idle'
  setPill('', '')
  renderTelemetry()
}

// ---------------------------------------------------------------------- pill

function setPill(text, tone) {
  if (state.pillText === text && state.pillTone === tone) return
  state.pillText = text
  state.pillTone = tone
  if (!text) {
    els.pill.hidden = true
    return
  }
  els.pill.hidden = false
  els.pillText.textContent = text
  els.pill.classList.toggle('detected', tone === 'detected')
  els.pill.style.color = tone === 'detected' ? GREEN : GOLD
}

function updatePhase() {
  const now = performance.now()
  if (!state.running) {
    state.phase = 'idle'
    setPill('', '')
    return
  }
  if (now - state.lastQuadAt > QUAD_STALE_MS) {
    state.phase = 'no-card'
    setPill('no card', 'tracking')
    return
  }
  if (now - state.lastUsableAt < SOLID_HOLD_MS) {
    state.phase = 'detected'
    setPill('card detected', 'detected')
    return
  }
  if (Number.isFinite(state.lastSharpness) && state.lastSharpness < MIN_SHARPNESS) {
    state.phase = 'soft'
    setPill('soft — hold flat', 'tracking')
    return
  }
  state.phase = 'tracking'
  setPill('tracking', 'tracking')
}

// --------------------------------------------------------------------- blur

function supportsBlurHole() {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  try {
    const blur = CSS.supports('backdrop-filter', 'blur(4px)')
      || CSS.supports('-webkit-backdrop-filter', 'blur(4px)')
    const mask = CSS.supports('mask-image', 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")')
      || CSS.supports('-webkit-mask-image', 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")')
    return Boolean(blur && mask)
  } catch {
    return false
  }
}

const BLUR_SUPPORTED = supportsBlurHole()

function hideBlur() {
  if (!BLUR_SUPPORTED) return
  if (state.blurShown) {
    state.blurShown = false
    els.blur.style.opacity = '0'
  }
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function outset(points, distance) {
  const cx = (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4
  const cy = (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4
  return points.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    const length = Math.hypot(dx, dy) || 1
    return [x + (dx / length) * distance, y + (dy / length) * distance]
  })
}

function toPath(points) {
  return `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')} Z`
}

function updateBlur(points, width, height) {
  if (!BLUR_SUPPORTED || !width || !height) return
  const hole = outset(points, BLUR_HOLE_MARGIN)
  let moved = state.blurKey ? 0 : Infinity
  if (state.blurKey) {
    for (let i = 0; i < 4; i += 1) {
      moved = Math.max(moved, Math.hypot(hole[i][0] - state.blurKey[i][0], hole[i][1] - state.blurKey[i][1]))
    }
  }
  const sameSize = state.blurSize && state.blurSize.width === width && state.blurSize.height === height
  if (moved < BLUR_MASK_STEP_PX && sameSize) {
    if (!state.blurShown) {
      state.blurShown = true
      els.blur.style.opacity = '1'
    }
    return
  }
  state.blurKey = hole
  state.blurSize = { width, height }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" '
    + `viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`
    + `<path d="M0 0 H${width} V${height} H0 Z ${toPath(hole)}" fill="#fff" fill-rule="evenodd"/></svg>`
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  els.blur.style.webkitMaskImage = url
  els.blur.style.maskImage = url
  state.blurShown = true
  els.blur.style.opacity = '1'
}

// -------------------------------------------------------------------- drawing

function clearOverlay() {
  const ctx = els.overlay.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height)
}

// Map normalised detector corners onto the letterboxed video content box, so the
// ring sits on the card in the rendered preview rather than on the element.
function mapToStage(quad, rect) {
  const video = els.video
  const frameWidth = video.videoWidth
  const frameHeight = video.videoHeight
  if (!frameWidth || !frameHeight) return null
  const scale = Math.min(rect.width / frameWidth, rect.height / frameHeight)
  const drawnWidth = frameWidth * scale
  const drawnHeight = frameHeight * scale
  const offsetX = (rect.width - drawnWidth) / 2
  const offsetY = (rect.height - drawnHeight) / 2
  return quad.map(([x, y]) => [
    offsetX + clamp01(x) * drawnWidth,
    offsetY + clamp01(y) * drawnHeight,
  ])
}

let lastTelemetryAt = 0

function drawFrame() {
  window.requestAnimationFrame(drawFrame)
  const now = performance.now()
  // Keep detections/s honest when results stop arriving: it is recomputed from
  // the timestamp window, so it needs a clock of its own, not just new results.
  if (now - lastTelemetryAt > 500) {
    lastTelemetryAt = now
    renderTelemetry()
  }

  const canvas = els.overlay
  const rect = els.stage.getBoundingClientRect()
  if (!rect.width || !rect.height) return

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

  updatePhase()

  const fresh = state.quad && now - state.lastQuadAt < QUAD_STALE_MS
  if (!fresh) {
    hideBlur()
    return
  }

  const points = mapToStage(state.quad, rect)
  if (!points) {
    hideBlur()
    return
  }

  const detected = now - state.lastUsableAt < SOLID_HOLD_MS
  const path = toPath(points)

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // Under-stroke keeps the gold readable on a bright card.
  ctx.beginPath()
  ctx.setLineDash([])
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.lineWidth = 4.6
  ctx.stroke(new Path2D(path))

  ctx.beginPath()
  ctx.setLineDash(detected ? [] : [7, 5])
  ctx.strokeStyle = detected ? GREEN : GOLD
  ctx.lineWidth = 2.2
  ctx.shadowColor = detected ? 'rgba(74, 222, 128, 0.55)' : 'rgba(245, 200, 66, 0.55)'
  ctx.shadowBlur = detected ? 14 : 8
  ctx.stroke(new Path2D(path))
  ctx.restore()

  updateBlur(points, rect.width, rect.height)
}

// --------------------------------------------------------------------- worker

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    )
    promise.then(
      value => { window.clearTimeout(timer); resolve(value) },
      error => { window.clearTimeout(timer); reject(error) },
    )
  })
}

async function resolveWorkerUrl() {
  let response
  try {
    response = await fetch(MANIFEST_URL, { cache: 'no-store' })
  } catch (error) {
    throw new Error(`could not read ${MANIFEST_URL}: ${error?.message || String(error)}`)
  }
  if (!response.ok) {
    throw new Error(
      `${MANIFEST_URL} → HTTP ${response.status}. Rebuild the frontend with `
      + 'build.manifest enabled (vite.config.js).',
    )
  }
  const manifest = await response.json()
  const entry = Object.values(manifest).find(value => value && value.src === WORKER_SOURCE)
  if (!entry || !entry.file) {
    throw new Error(`the build manifest has no ${WORKER_SOURCE} entry`)
  }
  return new URL(`/${String(entry.file).replace(/^\/+/, '')}`, window.location.origin).href
}

function onWorkerMessage(event) {
  const message = event.data || {}

  if (message.type === 'ready') {
    const resolve = state.readyResolve
    state.readyResolve = null
    state.readyReject = null
    resolve?.(message)
    return
  }

  if (message.type === 'result') {
    state.inFlight = false
    if (message.seq !== state.seq) return

    const corners = Array.isArray(message.corners) && message.corners.length === 4
      ? message.corners
      : null
    if (corners) {
      state.lastQuadAt = performance.now()
      smoothQuad(corners)
    }
    if (message.usable === true) state.lastUsableAt = performance.now()
    state.lastSharpness = Number.isFinite(message.sharpness) ? message.sharpness : null

    const inferenceMs = message.detectParts && Number.isFinite(message.detectParts.runMs)
      ? message.detectParts.runMs
      : message.ms
    if (Number.isFinite(inferenceMs)) {
      pushSample(state.runSamples, inferenceMs)
      if (AB.active) AB.samples.push(inferenceMs)
    }

    state.detections += 1
    state.stamps.push(performance.now())
    if (AB.active) AB.stamps.push(performance.now())
    renderTelemetry()
    scheduleTick(DETECT_GAP_MS)
    return
  }

  if (message.type === 'error') {
    state.inFlight = false
    // An init failure carries no seq: reject the ready promise so startCamera()
    // reports it immediately instead of waiting out READY_TIMEOUT_MS.
    if (message.seq == null) {
      const reject = state.readyReject
      state.readyResolve = null
      state.readyReject = null
      reject?.(new Error(message.message || 'The detector failed to load.'))
      return
    }
    if (message.seq !== state.seq) return
    fail('Detection failed', message.message || 'The detector worker reported an error.')
  }
}

function smoothQuad(corners) {
  if (!state.quad) {
    state.quad = corners.map(([x, y]) => [x, y])
    return
  }
  let jump = 0
  for (let i = 0; i < 4; i += 1) {
    jump = Math.max(jump, Math.hypot(corners[i][0] - state.quad[i][0], corners[i][1] - state.quad[i][1]))
  }
  // A re-found card elsewhere is a cut, not a swoop across the frame.
  if (jump > SNAP_DISTANCE) {
    state.quad = corners.map(([x, y]) => [x, y])
    return
  }
  state.quad = corners.map(([x, y], i) => [
    state.quad[i][0] + (x - state.quad[i][0]) * SMOOTHING,
    state.quad[i][1] + (y - state.quad[i][1]) * SMOOTHING,
  ])
}

async function startWorker() {
  state.workerUrl = await resolveWorkerUrl()
  els.workerSrc.textContent = state.workerUrl

  state.blobUrl = URL.createObjectURL(
    new Blob([`import ${JSON.stringify(state.workerUrl)}`], { type: 'text/javascript' }),
  )
  const worker = new Worker(state.blobUrl, { type: 'module' })
  state.worker = worker

  const ready = new Promise((resolve, reject) => {
    state.readyResolve = resolve
    state.readyReject = reject
  })

  worker.onmessage = event => {
    if (state.worker !== worker) return
    onWorkerMessage(event)
  }
  worker.onerror = event => {
    if (state.worker !== worker) return
    const error = new Error(event?.message || 'the detector worker crashed')
    state.readyReject?.(error)
    state.readyReject = null
    state.readyResolve = null
    state.inFlight = false
    fail('Detector worker crashed', error.message)
  }

  const isolated = window.crossOriginIsolated === true
  const hasSAB = typeof SharedArrayBuffer !== 'undefined'
  const hardware = navigator.hardwareConcurrency || 1
  const cap = state.threads.cap || DEFAULT_CAP
  // The guard the task exists for: a pool only when the document is isolated and
  // the browser exposes SharedArrayBuffer. The worker re-checks and clamps too.
  const requested = isolated && hasSAB ? Math.min(cap, hardware) : 1
  state.threads = { cap, requested, granted: 0, matched: false, isolated, hasSAB, hardware }

  worker.postMessage({
    type: 'init',
    runtime: RUNTIME,
    numThreads: requested,
    assetBase: window.location.origin,
  })

  const info = await withTimeout(ready, READY_TIMEOUT_MS)
  state.threads.granted = Number(info.threads) || 1
  state.threads.matched = state.threads.granted === state.threads.requested
  state.threads.runtime = info.runtime || RUNTIME
  renderTelemetry()

  if (!isolated) {
    showBanner(
      'warn',
      'NOT cross-origin isolated — running single-threaded',
      '<p>This page is served without COOP+COEP, so SharedArrayBuffer is unavailable and '
        + 'the measurement is the single-thread baseline. Check the '
        + '<code>/capture-lab-live/</code> nginx location.</p>',
    )
  } else if (state.threads.granted <= 1) {
    showBanner(
      'warn',
      'Isolated, but only one WASM thread was granted',
      `<p>SharedArrayBuffer is ${hasSAB ? 'available' : 'unavailable'}; `
        + `hardwareConcurrency is ${hardware}. Requested ${requested} with cap ${cap}.</p>`,
    )
  } else {
    showBanner(
      'ok',
      `Cross-origin isolated · ${state.threads.granted} WASM threads`,
      `<p>Cap ${cap}, requested ${requested}, hardwareConcurrency ${hardware}, runtime `
        + `<code>${state.threads.runtime}</code>.</p>`,
    )
  }
}

// ------------------------------------------------------------------ thread cap

// Restart only the worker: the camera, ring and page stay as they are, so a cap
// change is a like-for-like comparison without a reload.
function restartWorker() {
  if (!state.running) return Promise.resolve()
  // Chain restarts so a cap chosen while one is already loading still wins.
  const run = (state.restartPromise || Promise.resolve()).then(performRestart)
  state.restartPromise = run
  return run
}

async function performRestart() {
  if (!state.running || state.restarting) return
  cancelAbRun('cap changed')
  state.restarting = true
  updateAbRunButton()
  window.clearTimeout(state.timer)
  state.timer = null
  state.inFlight = false
  state.seq += 1

  if (state.worker) {
    state.worker.onmessage = null
    state.worker.onerror = null
    state.worker.terminate()
    state.worker = null
  }
  state.readyResolve = null
  state.readyReject = null
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl)
    state.blobUrl = ''
  }
  // Fresh samples so the median reflects the new pool, not a blend of both.
  state.runSamples = []
  state.stamps = []

  try {
    await startWorker()
  } catch (error) {
    state.restarting = false
    updateAbRunButton()
    // Stop may have interrupted the init on purpose; do not turn that into a banner.
    if (state.running) fail('Detector unavailable', error?.message || String(error))
    return
  }
  state.restarting = false
  updateAbRunButton()
  if (state.running) scheduleTick(0)
}

async function changeCap(cap) {
  state.threads.cap = cap
  els.cap.value = String(cap)
  updateAbRunButton()
  renderTelemetry()
  if (state.running) await restartWorker()
}

// ---------------------------------------------------------------- A/B helper

function rateFromStamps(stamps) {
  if (stamps.length < 2) return null
  const span = stamps[stamps.length - 1] - stamps[0]
  return span > 0 ? ((stamps.length - 1) * 1000) / span : null
}

function updateAbRunButton() {
  els.abRunCap.textContent = String(state.threads.cap)
  els.abRunInput.textContent = String(state.detectorEdge)
  els.abRun.disabled = !state.running || AB.active || state.restarting
}

function updateAbStatus() {
  if (!AB.active) return
  const left = Math.max(0, AB_DURATION_MS - (performance.now() - AB.startedAt))
  els.abStatus.textContent = `hold still — ${(left / 1000).toFixed(1)} s left at cap ${AB.cap} · in ${AB.edge}`
}

function startAbRun() {
  if (!state.running || AB.active || state.restarting) return
  AB.active = true
  AB.cap = state.threads.cap
  AB.cam = resolvedCameraLabel()
  AB.edge = state.detectorEdge
  AB.startedAt = performance.now()
  AB.samples = []
  AB.stamps = []
  els.abRepeat.replaceChildren()
  updateAbRunButton()
  updateAbStatus()
  AB.countdownTimer = window.setInterval(updateAbStatus, 200)
  AB.endTimer = window.setTimeout(finishAbRun, AB_DURATION_MS)
}

function cancelAbRun(reason = '') {
  if (!AB.active) return
  AB.active = false
  window.clearTimeout(AB.endTimer)
  window.clearInterval(AB.countdownTimer)
  AB.endTimer = null
  AB.countdownTimer = null
  AB.samples = []
  AB.stamps = []
  els.abStatus.textContent = reason ? `run cancelled (${reason}).` : 'run cancelled.'
  updateAbRunButton()
}

function finishAbRun() {
  if (!AB.active) return
  AB.active = false
  window.clearTimeout(AB.endTimer)
  window.clearInterval(AB.countdownTimer)
  AB.endTimer = null
  AB.countdownTimer = null

  const result = {
    cap: AB.cap,
    cam: AB.cam,
    edge: AB.edge,
    ms: median(AB.samples),
    rate: rateFromStamps(AB.stamps),
    detections: AB.stamps.length,
    at: new Date().toISOString(),
  }
  // One line per cap · camera · input: rerunning the same combination replaces it.
  const existing = state.abResults.findIndex(
    entry => entry.cap === result.cap && entry.cam === result.cam && entry.edge === result.edge,
  )
  if (existing >= 0) state.abResults[existing] = result
  else state.abResults.push(result)

  // A changed list has not been sent yet, so do not keep claiming the old send.
  state.abSendError = ''
  els.abSendStatus.textContent = ''

  renderAbResults()
  renderAbRepeat()
  const key = `cap ${result.cap} · in ${result.edge}`
  els.abStatus.textContent = result.ms === null
    ? `${key}: no inference samples — keep the card in view and try again.`
    : `${key} recorded. Run another cap or input to compare.`
  updateAbRunButton()
}

function formatAbLine(result) {
  const ms = result.ms === null ? '—' : result.ms.toFixed(1)
  const rate = result.rate === null ? '—' : result.rate.toFixed(1)
  return `cap ${result.cap} · cam ${result.cam} · in ${result.edge} → ${ms} ms, ${rate}/s`
}

function renderAbResults() {
  els.abResults.replaceChildren()
  updateAbSendButton()
  if (!state.abResults.length) {
    els.abResults.hidden = true
    return
  }
  for (const result of state.abResults) {
    const item = document.createElement('li')
    item.textContent = formatAbLine(result)
    els.abResults.append(item)
  }
  els.abResults.hidden = false
}

// Send results — the only path that uploads anything. The payload is the
// accumulated A/B list, one entry per cap · camera · input, with the detector
// half filled in and no CV half (this page has none).
function deviceInfo() {
  return {
    ua: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency || 1,
    isolated: window.crossOriginIsolated === true,
    threadsGranted: state.threads.granted || null,
  }
}

function round1(value) {
  return value == null ? null : Math.round(value * 10) / 10
}

function experimentPayload() {
  const label = (els.abLabel.value || '').trim()
  return {
    page: 'capture-lab-live',
    ...(label ? { label } : {}),
    device: deviceInfo(),
    runs: state.abResults.map(result => ({
      settings: { cap: result.cap, cam: result.cam, input: result.edge },
      ours: {
        msMedian: round1(result.ms),
        perSecond: round1(result.rate),
        detections: result.detections,
      },
      cv: null,
      at: result.at,
    })),
  }
}

function updateAbSendButton() {
  els.abSend.disabled = state.abSending || !state.abResults.length
  els.abSend.textContent = state.abSending
    ? 'Sending…'
    : state.abSendError ? 'Retry send' : 'Send results'
}

async function sendAbResults() {
  if (state.abSending || !state.abResults.length) return
  state.abSending = true
  state.abSendError = ''
  updateAbSendButton()
  els.abSendStatus.textContent = 'sending…'

  const token = localStorage.getItem('token')
  try {
    const response = await fetch(EXPERIMENTS_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(experimentPayload()),
    })
    let body = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok) {
      const detail = body?.detail ?? body?.message
      const reason = response.status === 401
        ? 'not signed in — sign in to the app in this browser first'
        : typeof detail === 'string' ? detail : `HTTP ${response.status}`
      throw new Error(reason)
    }
    const id = body?.id
    els.abSendStatus.textContent = id == null ? 'sent' : `sent · id ${id}`
  } catch (error) {
    // Keep the list: the button stays enabled as Retry send.
    state.abSendError = error?.message || String(error)
    els.abSendStatus.textContent = `send failed: ${state.abSendError} — press Retry send.`
  } finally {
    state.abSending = false
    updateAbSendButton()
  }
}

function renderAbRepeat() {
  els.abRepeat.replaceChildren()
  if (!state.abResults.length) return
  const last = state.abResults[state.abResults.length - 1]
  for (const cap of THREAD_CAPS) {
    if (cap === last.cap) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `Repeat 10 s at cap ${cap} (in ${last.edge})`
    button.addEventListener('click', () => { void runAtSettings(cap, last.edge) })
    els.abRepeat.append(button)
  }
  for (const edge of DETECTOR_EDGES) {
    if (edge === last.edge) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = `Repeat 10 s at input ${edge} (cap ${last.cap})`
    button.addEventListener('click', () => { void runAtSettings(last.cap, edge) })
    els.abRepeat.append(button)
  }
}

async function runAtSettings(cap, edge) {
  if (!state.running) {
    els.abStatus.textContent = 'start the camera first.'
    return
  }
  if (AB.active || state.restarting) return
  // Input first: it needs no restart, then the cap restart clears the samples.
  changeDetectorEdge(edge)
  await changeCap(cap)
  if (state.running && !state.restarting) startAbRun()
}

// ----------------------------------------------------------------------- loop

function scheduleTick(ms) {
  if (!state.running) return
  window.clearTimeout(state.timer)
  state.timer = window.setTimeout(tick, ms)
}

async function tick() {
  if (!state.running) return
  if (document.hidden) {
    scheduleTick(250)
    return
  }
  if (state.inFlight) {
    scheduleTick(50)
    return
  }

  const video = els.video
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
    scheduleTick(80)
    return
  }

  // Pin the worker for this tick: a cap change can terminate it while we await
  // the bitmap, and a frame must never reach the replacement before its init.
  const worker = state.worker
  if (!worker) {
    scheduleTick(80)
    return
  }

  // The detector input only decides the frame canvas size: the next tick picks
  // up a change without touching the worker, the ring or the stream.
  const frame = frameDimensions(video.videoWidth, video.videoHeight, state.detectorEdge)

  const canvas = els.frameSource || (els.frameSource = document.getElementById('frame-source'))
  if (canvas.width !== frame.width) canvas.width = frame.width
  if (canvas.height !== frame.height) canvas.height = frame.height
  canvas.getContext('2d').drawImage(video, 0, 0, frame.width, frame.height)
  state.frameSize = frame

  let bitmap
  try {
    bitmap = await createImageBitmap(canvas)
  } catch {
    scheduleTick(250)
    return
  }
  if (!state.running || state.worker !== worker) {
    bitmap.close?.()
    return
  }

  state.seq += 1
  state.inFlight = true
  try {
    worker.postMessage({ type: 'detect', bitmap, seq: state.seq }, [bitmap])
  } catch (error) {
    state.inFlight = false
    bitmap.close?.()
    fail('Could not send a frame', error?.message || String(error))
    return
  }
  renderTelemetry()
}

// --------------------------------------------------------------------- camera

function updateStageAspect() {
  const track = state.stream?.getVideoTracks?.()?.[0]
  try { state.cameraSettings = track?.getSettings?.() || state.cameraSettings } catch { /* keep */ }
  const width = state.cameraSettings?.width || els.video.videoWidth
  const height = state.cameraSettings?.height || els.video.videoHeight
  if (width && height) els.stage.style.aspectRatio = `${width} / ${height}`
}

function cameraTarget(key) {
  const preset = cameraPreset(key)
  if (preset.width && preset.height) return { width: preset.width, height: preset.height }
  return state.cameraMaximum
}

// Renegotiate the live track, not the stream: the worker, ring and A/B samples
// stay up. A rejected preference leaves the working stream untouched.
async function applyCameraSize(key) {
  state.cameraSize = key
  els.cameraSize.value = key
  state.cameraNote = ''
  if (!state.running || !state.stream) {
    renderTelemetry()
    return
  }
  if (AB.active) cancelAbRun('camera changed')
  const track = state.stream.getVideoTracks()[0]
  const target = cameraTarget(key)
  if (!track?.applyConstraints) {
    state.cameraNote = 'size control unsupported'
    renderTelemetry()
    return
  }
  if (!target) {
    state.cameraNote = 'capability max unknown — kept current'
    renderTelemetry()
    return
  }
  try {
    await track.applyConstraints({
      width: { ideal: target.width },
      height: { ideal: target.height },
    })
  } catch {
    // Never drop a working stream for a rejected preference: the old size stays.
    state.cameraNote = 'size change rejected — kept previous'
    renderTelemetry()
    return
  }
  updateStageAspect()
  renderTelemetry()
}

// Detection input is a local frame-canvas decision: no worker restart, no lost ring.
function changeDetectorEdge(edge) {
  state.detectorEdge = edge
  els.detectorSize.value = String(edge)
  updateAbRunButton()
  if (AB.active) cancelAbRun('input changed')
  if (state.running) {
    const width = els.video.videoWidth
    const height = els.video.videoHeight
    if (width && height) state.frameSize = frameDimensions(width, height, edge)
  }
  renderTelemetry()
}

async function startCamera() {
  if (state.running) return
  els.start.disabled = true
  hideBanner()

  if (!navigator.mediaDevices?.getUserMedia) {
    els.start.disabled = false
    fail('Camera unavailable', 'getUserMedia is unavailable (needs HTTPS or localhost).')
    return
  }

  els.hint.hidden = false
  els.hint.textContent = 'Requesting camera…'

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    })
  } catch (error) {
    els.start.disabled = false
    fail('Camera unavailable', error?.message || String(error))
    return
  }
  state.stream = stream
  els.video.srcObject = stream

  try {
    await els.video.play()
  } catch (error) {
    fail('Camera preview did not start', error?.message || String(error))
    return
  }

  const track = stream.getVideoTracks()[0]
  if (track) {
    track.onended = () => {
      if (state.running) fail('Camera stream ended', 'The video track stopped delivering.')
    }
  }

  // Ask the track for its capability maximum, like CaptureLab.startCamera does.
  let capabilities = {}
  try { capabilities = track?.getCapabilities?.() || {} } catch { capabilities = {} }
  const maxWidth = typeof capabilities.width?.max === 'number' ? capabilities.width.max : null
  const maxHeight = typeof capabilities.height?.max === 'number' ? capabilities.height.max : null
  state.cameraMaximum = maxWidth && maxHeight ? { width: maxWidth, height: maxHeight } : null
  state.cameraNote = ''
  const initial = cameraTarget(state.cameraSize)
  if (initial && track?.applyConstraints) {
    try {
      await track.applyConstraints({ width: { ideal: initial.width }, height: { ideal: initial.height } })
    } catch {
      // Keep the browser's initial size when the preference is rejected.
      state.cameraNote = 'size change rejected — kept previous'
    }
  }

  if (!els.video.videoWidth) {
    await new Promise(resolve => {
      const timer = window.setTimeout(resolve, 2000)
      els.video.addEventListener('loadedmetadata', () => {
        window.clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  updateStageAspect()
  renderTelemetry()

  els.hint.textContent = 'Loading detector…'
  try {
    await startWorker()
  } catch (error) {
    fail('Detector unavailable', error?.message || String(error))
    return
  }

  state.running = true
  els.hint.hidden = true
  els.stop.disabled = false
  els.start.disabled = true
  updateAbRunButton()
  renderTelemetry()
  scheduleTick(0)
}

function stopCamera() {
  state.running = false
  cancelAbRun('camera stopped')
  window.clearTimeout(state.timer)
  state.timer = null
  state.inFlight = false

  if (state.worker) {
    state.worker.onmessage = null
    state.worker.onerror = null
    state.worker.terminate()
    state.worker = null
  }
  // A pending init (e.g. a cap-change restart) must not hang for 30 s after Stop.
  const rejectReady = state.readyReject
  state.readyResolve = null
  state.readyReject = null
  rejectReady?.(new Error('camera stopped'))
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl)
    state.blobUrl = ''
  }

  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop()
    state.stream = null
  }
  els.video.srcObject = null

  state.cameraMaximum = null
  state.cameraSettings = null
  state.cameraNote = ''
  state.blurKey = null
  state.blurSize = null
  hideBlur()
  clearOverlay()
  resetTelemetry()
  // resetTelemetry() reads the video, whose intrinsic size may survive until the
  // next metadata event; clear the two camera-derived readouts explicitly.
  setStat(els.camera, '…')
  setStat(els.frame, '…')

  els.start.disabled = false
  els.stop.disabled = true
  els.hint.hidden = false
  els.hint.textContent = 'Stopped. Press Start camera to measure again.'
  els.stage.style.aspectRatio = '4 / 3'
  updateAbRunButton()
}

function fail(title, detail) {
  // stopCamera() resets the camera, worker and ring but leaves the banner alone,
  // so the failure stays on screen until the next Start.
  stopCamera()
  const text = String(detail)
  const hint = /wasm|compile|content security policy|unsafe-eval/i.test(text)
    ? '<p>If this names a WebAssembly or CSP error, the deployment must be built with '
      + '<code>DETECTOR_ENABLED=true</code>: that widens the policy with '
      + "<code>'wasm-unsafe-eval'</code> and <code>worker-src 'self' blob:</code>.</p>"
    : ''
  showBanner('error', title, `<p>${text}</p>${hint}`)
}

// ---------------------------------------------------------------------- wiring

els.start.addEventListener('click', startCamera)
els.stop.addEventListener('click', stopCamera)
els.cap.addEventListener('change', () => {
  void changeCap(Number(els.cap.value) || 1)
})
els.cameraSize.addEventListener('change', () => {
  void applyCameraSize(els.cameraSize.value)
})
els.detectorSize.addEventListener('change', () => {
  changeDetectorEdge(Number(els.detectorSize.value) || DEFAULT_DETECTOR_EDGE)
})
els.abRun.addEventListener('click', startAbRun)
els.abSend.addEventListener('click', () => { void sendAbResults() })

els.video.addEventListener('resize', () => {
  updateStageAspect()
  renderTelemetry()
})

window.addEventListener('resize', () => {
  if (!state.running) clearOverlay()
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.running) scheduleTick(0)
})

els.blurState.textContent = BLUR_SUPPORTED ? 'on (backdrop-filter masked by the quad)' : 'off (unsupported in this browser)'
if (!BLUR_SUPPORTED) els.blur.style.display = 'none'

els.cap.value = String(DEFAULT_CAP)
els.cameraSize.value = state.cameraSize
els.detectorSize.value = String(state.detectorEdge)
updateAbRunButton()
renderAbResults()
renderTelemetry()
window.requestAnimationFrame(drawFrame)

if (window.crossOriginIsolated === true) {
  showBanner('ok', 'Cross-origin isolated', '<p>Press Start camera to measure multi-threaded inference.</p>')
} else {
  showBanner(
    'warn',
    'NOT cross-origin isolated — single thread only',
    '<p>Multi-threaded WASM needs SharedArrayBuffer, so any measurement here is the '
      + 'single-thread baseline. Fix the <code>/capture-lab-live/</code> response headers '
      + '(COOP+COEP) before trusting results.</p>',
  )
}
