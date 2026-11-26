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
// "Run all & send": every cap × input combination at the current camera size.
// 8 s each keeps the whole matrix under a minute and a half; the runs are stored
// keyed like the single sweeps, so a rerun replaces its line.
const MATRIX_CAPS = [1, 2, 4]
const MATRIX_EDGES = [320, 480, 640]
const MATRIX_DURATION_MS = 8000

// Server assist: CollectorVision's card boundary from the capture-lab endpoint,
// polled beside the local detector. On WiFi a server round trip can be cheaper
// than local inference; on mobile data it usually is not, so `auto` only adopts
// the server shape while it is clearly the faster source.
const ASSIST_PATH = '/api/capture-lab/cv-detect'
const ASSIST_POLL_MS = 1100
const ASSIST_TIMEOUT_MS = 15000
const ASSIST_UPLOAD_EDGE = 1280
const ASSIST_JPEG_QUALITY = 0.8
const ASSIST_WINDOW = 5
const ASSIST_MIN_SAMPLES = 3
const ASSIST_COST_RATIO = 0.8
const ASSIST_BACKOFF_MS = 30000
const ASSIST_BLEND_MS = 250
const ASSIST_DISAGREE = 0.12
const ASSIST_MAX_PAIRS = 600
const ASSIST_SEND_PAIRS = 120
const ASSIST_STALE_MS = 3500
const ASSIST_SERVER_STROKE = 'rgba(125, 211, 252, 0.55)'

// Paired samples are only comparable on a still card: the camera and the server
// keep sampling while the card moves, so the two quads can describe different
// moments. `motion` is the mean corner move (normalised to the frame) since the
// previous pair, and one pair interval is ASSIST_POLL_MS (~1.1 s). A threshold
// of 0.01 therefore means the corners drift less than 1% of the frame between
// samples: a card held at arm's length stays far below that (sub-pixel to a few
// pixels at 1280 px ≈ 0.002), while a deliberate pan clears it. `medianIouStill`
// uses it to drop motion artefacts instead of mixing them into the IoU.
const ASSIST_STILL_MOTION = 0.01

// Ground-truth frames: each run keeps the camera frame behind its worst- and
// median-IoU pair, at 480 px long edge and JPEG q0.6 — enough to judge the
// boundary without dominating the payload. A 16:9 frame is ~480×270 and encodes
// to roughly 25–45 KB; base64 adds a third, so ~35–60 KB per frame and at most
// two frames per run (~120 KB). A 9-run matrix therefore adds roughly 1 MB to
// the experiment post, which is why the backend accepts 4 MB for this payload.
const ASSIST_FRAME_EDGE = 480
const ASSIST_FRAME_QUALITY = 0.6
const ASSIST_FRAME_MAX = 2

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
  assistMode: document.getElementById('assist-mode'),
  assistFrame: document.getElementById('assist-frame'),
  isolated: document.getElementById('s-isolated'),
  threads: document.getElementById('s-threads'),
  capStat: document.getElementById('s-cap'),
  rate: document.getElementById('s-rate'),
  ms: document.getElementById('s-ms'),
  camera: document.getElementById('s-camera'),
  frame: document.getElementById('s-frame'),
  count: document.getElementById('s-count'),
  sharp: document.getElementById('s-sharp'),
  assist: document.getElementById('s-assist'),
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
  matrixRun: document.getElementById('matrix-run'),
  matrixStop: document.getElementById('matrix-stop'),
  matrixStatus: document.getElementById('matrix-status'),
  matrixRetry: document.getElementById('matrix-retry'),
  matrixSendStatus: document.getElementById('matrix-send-status'),
}

const HARDWARE = navigator.hardwareConcurrency || 1
// Measured on the collector's phone (8 cores, Firefox Android): cap 2 gave the
// best cadence (~205 ms, 3.5/s), while cap 4 was markedly worse (~264-385 ms,
// 1.9-2.6/s) - oversubscribing a phone's big.LITTLE cores costs more in thread
// contention than it wins in parallelism. Desktop-class core counts do scale
// (cap 4 ~3x faster than cap 1 on 16 cores), so the default splits by cores
// rather than always asking for four.
const DEFAULT_CAP = THREAD_CAPS
  .filter(cap => cap <= Math.min(HARDWARE <= 8 ? 2 : DEFAULT_THREAD_CAP, HARDWARE))
  .pop() || 1

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
  lastConfidence: null,
  detections: 0,
  stamps: [],
  runSamples: [],
  phase: 'idle',
  pillText: '',
  pillTone: '',
  blurKey: null,
  blurSize: null,
  blurShown: false,
  // The ring is the local quad unless server assist owns the shape; `blend`
  // eases it to each server quad over ASSIST_BLEND_MS.
  ring: { quad: null, blend: null },
  assist: {
    // Parked: `off` is the default. `auto` and `on` still work as instruments;
    // see the defect list at the head of the server-assist section before
    // making either of them the default again.
    mode: 'off',
    active: false,
    inFlight: false,
    timer: null,
    controller: null,
    // The last ASSIST_WINDOW values each; the auto rule compares their EWMAs.
    rtts: [],
    locals: [],
    lastRttEwma: null,
    lastLocalEwma: null,
    lastLocalMs: null,
    serverQuad: null,
    serverAt: 0,
    backoff: false,
    backoffUntil: 0,
    unavailable: false,
    error: '',
    pairs: [],
  },
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
  // Server-assist pairs recorded inside this window, sent with its run.
  pairs: [],
  // { pair, canvas } for each pair, so the worst/median pair can keep its frame.
  frameCandidates: [],
  token: 0,
  endTimer: null,
  countdownTimer: null,
  // The matrix uses the same window machinery with a shorter duration.
  duration: AB_DURATION_MS,
  resolveFinish: null,
}

// Orchestration for "Run all & send". It drives the single-run machinery above
// rather than sampling anything itself: each combination is one normal run whose
// finish resolves the promise the loop awaits.
const MATRIX = {
  active: false,
  cancelled: false,
  // Set while the matrix applies its own settings, so those setters do not
  // mistake the matrix for a user change and abort it.
  internal: false,
  queue: [],
  index: 0,
  total: 0,
  collected: [],
  note: '',
  sending: false,
  lastPayload: null,
  sendError: '',
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

  const assistTone = state.assist.unavailable
    ? 'bad'
    : state.assist.active ? 'ok' : state.assist.backoff ? 'warn' : ''
  setStat(els.assist, assistStatusText(), assistTone)

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

  const localFresh = state.quad && now - state.lastQuadAt < QUAD_STALE_MS
  const serverFresh = assistShapeInUse(now)
  if (!localFresh && !serverFresh) {
    hideBlur()
    return
  }

  // The ring is the local quad unless server assist owns the shape, in which
  // case it eases to each server quad over ASSIST_BLEND_MS.
  const shape = ringQuadAt(now, serverFresh)
  const points = shape ? mapToStage(shape, rect) : null
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

  // A server quad that disagrees with the ring is drawn faintly, so the
  // disagreement is visible on the phone and not only in the logged numbers.
  if (serverFresh && state.assist.serverQuad
    && meanQuadDistance(state.assist.serverQuad, shape) > 0.02) {
    const serverPoints = mapToStage(state.assist.serverQuad, rect)
    if (serverPoints) {
      ctx.save()
      ctx.beginPath()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = ASSIST_SERVER_STROKE
      ctx.lineWidth = 1.2
      ctx.stroke(new Path2D(toPath(serverPoints)))
      ctx.restore()
    }
  }

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
    // The worker reports a score only when its runtime exposes one; keep the
    // pair record honest with null rather than inventing a confidence.
    state.lastConfidence = Number.isFinite(message.confidence)
      ? message.confidence
      : Number.isFinite(message.score) ? message.score : null

    const inferenceMs = message.detectParts && Number.isFinite(message.detectParts.runMs)
      ? message.detectParts.runMs
      : message.ms
    if (Number.isFinite(inferenceMs)) {
      pushSample(state.runSamples, inferenceMs)
      // The server-assist auto rule compares its round trips against these.
      state.assist.lastLocalMs = inferenceMs
      pushWindow(state.assist.locals, inferenceMs, ASSIST_WINDOW)
      state.assist.lastLocalEwma = ewmaOf(state.assist.locals)
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
    followLocalRing()
    return
  }
  let jump = 0
  for (let i = 0; i < 4; i += 1) {
    jump = Math.max(jump, Math.hypot(corners[i][0] - state.quad[i][0], corners[i][1] - state.quad[i][1]))
  }
  // A re-found card elsewhere is a cut, not a swoop across the frame.
  if (jump > SNAP_DISTANCE) {
    state.quad = corners.map(([x, y]) => [x, y])
    followLocalRing()
    return
  }
  state.quad = corners.map(([x, y], i) => [
    state.quad[i][0] + (x - state.quad[i][0]) * SMOOTHING,
    state.quad[i][1] + (y - state.quad[i][1]) * SMOOTHING,
  ])
  followLocalRing()
}

// While the server owns the ring shape the local quad keeps updating for the
// phase pill and counts but must not pull the drawn ring back.
function followLocalRing() {
  if (!assistShapeInUse() && !state.ring.blend) state.ring.quad = state.quad
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

  let info
  try {
    info = await withTimeout(ready, READY_TIMEOUT_MS)
  } catch (error) {
    // A threaded pool can hang without an error when its nested worker scripts
    // are refused (a cached /detector/ response from before COEP was added is
    // the usual cause). Degrade to the single-thread baseline instead of
    // failing the page, and say so plainly: the measurement stays valid, it is
    // just not the threaded one.
    if (requested <= 1) throw error
    // Tear down the hung pool the same way the stop path does.
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
    state.threads.fellBack = true
    state.threads.fellBackReason = error?.message || String(error)
    state.threads.requested = 1
    state.workerUrl = state.workerUrl || await resolveWorkerUrl()
    const retryBlob = URL.createObjectURL(
      new Blob([`import ${JSON.stringify(state.workerUrl)}`], { type: 'text/javascript' }),
    )
    const retry = new Worker(retryBlob, { type: 'module' })
    state.worker = retry
    state.blobUrl = retryBlob
    const retryReady = new Promise((resolve, reject) => {
      state.readyResolve = resolve
      state.readyReject = reject
    })
    retry.onmessage = event => {
      if (state.worker !== retry) return
      onWorkerMessage(event)
    }
    retry.onerror = event => {
      if (state.worker !== retry) return
      const err = new Error(event?.message || 'the detector worker crashed')
      state.readyReject?.(err)
      state.readyReject = null
      state.readyResolve = null
      state.inFlight = false
      fail('Detector worker crashed', err.message)
    }
    retry.postMessage({
      type: 'init',
      runtime: RUNTIME,
      numThreads: 1,
      assetBase: window.location.origin,
    })
    info = await withTimeout(retryReady, READY_TIMEOUT_MS)
    showBanner(
      'warn',
      'Threaded start failed — running single-threaded',
      `<p>The ${requested}-thread pool did not become ready (${state.threads.fellBackReason}). `
        + 'The measurement below is the single-thread baseline. A stale cached '
        + '<code>/detector/</code> response without COEP is the usual cause: clear this site\'s '
        + 'data once, or open the page in a private window.</p>',
    )
  }
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
  // The local cost changed with the pool, so the auto comparison restarts.
  state.assist.locals = []
  state.assist.lastLocalEwma = null
  state.assist.lastLocalMs = null

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
  if (MATRIX.active && !MATRIX.internal) abortMatrix('thread cap changed')
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
  els.abRun.disabled = !state.running || AB.active || state.restarting || MATRIX.active
  updateMatrixButton()
}

function matrixCombinations() {
  // A pool only exists when the document is isolated and SharedArrayBuffer is
  // exposed; without both the worker clamps to one thread, so cap 1 is the only
  // combination the device can honour.
  const caps = state.threads.isolated && state.threads.hasSAB ? MATRIX_CAPS : [1]
  const combos = []
  for (const cap of caps) {
    for (const edge of MATRIX_EDGES) combos.push({ cap, edge })
  }
  return combos
}

function matrixNote() {
  if (state.threads.isolated && state.threads.hasSAB) return ''
  return state.threads.isolated
    ? 'cap 1 only — SharedArrayBuffer unavailable'
    : 'cap 1 only — not cross-origin isolated'
}

function matrixProgressText(leftMs, cap, edge) {
  const prefix = MATRIX.note ? `${MATRIX.note} · ` : ''
  return `${prefix}run ${MATRIX.index + 1}/${MATRIX.total} · cap ${cap} · in ${edge} · `
    + `${(Math.max(0, leftMs) / 1000).toFixed(1)} s left`
}

function updateMatrixButton() {
  els.matrixRun.disabled = !state.running || AB.active || MATRIX.active
    || state.restarting || MATRIX.sending
  els.matrixRun.textContent = MATRIX.active ? 'Running matrix…' : 'Run all & send'
  els.matrixStop.hidden = !MATRIX.active
  els.matrixStop.disabled = !MATRIX.active
}

function updateAbStatus() {
  if (!AB.active) return
  const left = Math.max(0, AB.duration - (performance.now() - AB.startedAt))
  if (MATRIX.active) {
    els.matrixStatus.textContent = matrixProgressText(left, AB.cap, AB.edge)
    return
  }
  els.abStatus.textContent = `hold still — ${(left / 1000).toFixed(1)} s left at cap ${AB.cap} · in ${AB.edge}`
}

function startAbRun(durationMs = AB_DURATION_MS) {
  if (!state.running || AB.active || state.restarting) return Promise.resolve(null)
  AB.active = true
  AB.cap = state.threads.cap
  AB.cam = resolvedCameraLabel()
  AB.edge = state.detectorEdge
  AB.duration = durationMs
  AB.startedAt = performance.now()
  AB.samples = []
  AB.stamps = []
  AB.pairs = []
  AB.frameCandidates = []
  AB.token += 1
  els.abRepeat.replaceChildren()
  if (!MATRIX.active) els.abStatus.textContent = ''
  const done = new Promise(resolve => { AB.resolveFinish = resolve })
  updateAbRunButton()
  updateAbStatus()
  AB.countdownTimer = window.setInterval(updateAbStatus, 200)
  AB.endTimer = window.setTimeout(finishAbRun, durationMs)
  return done
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
  AB.pairs = []
  AB.frameCandidates = []
  AB.token += 1
  if (MATRIX.active) {
    els.matrixStatus.textContent =
      `matrix cancelled (${reason}) — ${MATRIX.collected.length} run(s) kept.`
  } else {
    els.abStatus.textContent = reason ? `run cancelled (${reason}).` : 'run cancelled.'
  }
  const resolve = AB.resolveFinish
  AB.resolveFinish = null
  resolve?.(null)
  updateAbRunButton()
}

function finishAbRun() {
  if (!AB.active) return
  AB.active = false
  window.clearTimeout(AB.endTimer)
  window.clearInterval(AB.countdownTimer)
  AB.endTimer = null
  AB.countdownTimer = null

  const pairs = AB.pairs.slice()
  const candidates = AB.frameCandidates.slice()
  AB.pairs = []
  AB.frameCandidates = []

  const result = {
    cap: AB.cap,
    cam: AB.cam,
    edge: AB.edge,
    ms: median(AB.samples),
    rate: rateFromStamps(AB.stamps),
    detections: AB.stamps.length,
    pairs,
    // Filled in below once the two ground-truth frames are encoded.
    frames: [],
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
  if (!MATRIX.active) {
    const key = `cap ${result.cap} · in ${result.edge}`
    els.abStatus.textContent = result.ms === null
      ? `${key}: no inference samples — keep the card in view and try again.`
      : `${key} recorded. Run another cap or input to compare.`
  }
  updateAbRunButton()
  const resolve = AB.resolveFinish
  AB.resolveFinish = null
  // Encoding runs off the pair canvases and takes ~100 ms. "Run all & send"
  // awaits this promise, so the frames are attached before it posts.
  runFrames(pairs, candidates)
    .then(frames => { result.frames = frames })
    .catch(() => {})
    .finally(() => { resolve?.(result) })
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

function experimentPayload(results = state.abResults, mode = '') {
  const label = (els.abLabel.value || '').trim()
  // The summary describes the runs in this payload, not every pair ever seen.
  const pairs = results.flatMap(result => result.pairs || [])
  return {
    page: 'capture-lab-live',
    ...(mode ? { mode } : {}),
    ...(label ? { label } : {}),
    device: deviceInfo(),
    assist: assistSummary(pairs),
    runs: results.map(result => ({
      settings: { cap: result.cap, cam: result.cam, input: result.edge },
      ours: {
        msMedian: round1(result.ms),
        perSecond: round1(result.rate),
        detections: result.detections,
      },
      cv: null,
      assist: assistSummary(result.pairs),
      pairs: pairsForPayload(result.pairs),
      frames: result.frames || [],
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

async function postExperiment(payload) {
  const token = localStorage.getItem('token')
  const response = await fetch(EXPERIMENTS_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
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
  return body?.id ?? null
}

async function sendAbResults() {
  if (state.abSending || !state.abResults.length) return
  state.abSending = true
  state.abSendError = ''
  updateAbSendButton()
  els.abSendStatus.textContent = 'sending…'
  try {
    const id = await postExperiment(experimentPayload())
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

// "Run all & send": the matrix posts once on completion, and only then. A failed
// post keeps the payload so the retry button repeats that same request; the
// manual Send results button above remains a separate path.
async function postMatrixPayload() {
  if (MATRIX.sending || !MATRIX.lastPayload) return
  MATRIX.sending = true
  MATRIX.sendError = ''
  updateMatrixButton()
  els.matrixRetry.hidden = true
  els.matrixSendStatus.textContent = 'sending…'
  try {
    const id = await postExperiment(MATRIX.lastPayload)
    els.matrixSendStatus.textContent = id == null ? 'sent' : `sent · id ${id}`
  } catch (error) {
    MATRIX.sendError = error?.message || String(error)
    els.matrixSendStatus.textContent = `send failed: ${MATRIX.sendError}`
    els.matrixRetry.hidden = false
  } finally {
    MATRIX.sending = false
    updateMatrixButton()
  }
}

async function autoSendMatrix() {
  if (!MATRIX.collected.length) return
  MATRIX.lastPayload = experimentPayload(MATRIX.collected, 'matrix')
  await postMatrixPayload()
}

function abortMatrix(reason) {
  if (!MATRIX.active) return
  MATRIX.cancelled = true
  if (AB.active) {
    cancelAbRun(reason)
  } else {
    els.matrixStatus.textContent =
      `matrix cancelled (${reason}) — ${MATRIX.collected.length} run(s) kept.`
    updateMatrixButton()
  }
}

async function startMatrix() {
  if (!state.running || AB.active || MATRIX.active || state.restarting) return
  const combos = matrixCombinations()
  MATRIX.active = true
  MATRIX.cancelled = false
  MATRIX.internal = false
  MATRIX.queue = combos
  MATRIX.index = 0
  MATRIX.total = combos.length
  MATRIX.collected = []
  MATRIX.note = matrixNote()
  MATRIX.sendError = ''
  MATRIX.lastPayload = null
  els.matrixRetry.hidden = true
  els.matrixSendStatus.textContent = ''
  els.abStatus.textContent = ''
  els.matrixStatus.textContent = MATRIX.note
    ? `${MATRIX.note} · starting ${combos.length} runs…`
    : `starting ${combos.length} runs…`
  updateAbRunButton()

  try {
    for (let i = 0; i < combos.length; i += 1) {
      if (!MATRIX.active || MATRIX.cancelled || !state.running) break
      MATRIX.index = i
      const combo = combos[i]
      // Applying the settings is the matrix's own doing, so suppress the
      // user-change abort inside the setters. The flag covers only the
      // synchronous call: a restart is awaited with it cleared, so a user
      // change during that restart still aborts the matrix.
      MATRIX.internal = true
      try {
        changeDetectorEdge(combo.edge)
      } finally {
        MATRIX.internal = false
      }
      if (state.threads.cap !== combo.cap) {
        els.matrixStatus.textContent = `loading cap ${combo.cap} worker…`
        MATRIX.internal = true
        let restart
        try {
          restart = changeCap(combo.cap)
        } finally {
          MATRIX.internal = false
        }
        await restart
      }
      if (!MATRIX.active || MATRIX.cancelled || !state.running) break
      els.matrixStatus.textContent = matrixProgressText(MATRIX_DURATION_MS, combo.cap, combo.edge)
      const result = await startAbRun(MATRIX_DURATION_MS)
      if (result) MATRIX.collected.push(result)
      if (!MATRIX.active || MATRIX.cancelled) break
    }
  } finally {
    const completed = MATRIX.active && !MATRIX.cancelled
    MATRIX.active = false
    MATRIX.internal = false
    updateAbRunButton()
    if (completed) {
      if (MATRIX.collected.length) {
        els.matrixStatus.textContent = `matrix complete — ${MATRIX.collected.length} run(s).`
        await autoSendMatrix()
      } else {
        els.matrixStatus.textContent = 'matrix finished with no samples — nothing to send.'
      }
    }
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
  if (AB.active || state.restarting || MATRIX.active) return
  // Input first: it needs no restart, then the cap restart clears the samples.
  changeDetectorEdge(edge)
  await changeCap(cap)
  if (state.running && !state.restarting) startAbRun()
}

// ---------------------------------------------------------------- server assist
//
// PARKED — the default mode is `off`. `auto` and `on` remain fully wired, but
// re-enabling assist as default behaviour means fixing these four known defects
// first. They are left in place deliberately: this is a bookmark, not a repair.
//
//   1. Freshness is stamped when the response arrives, not when the frame was
//      exposed: handleAssistResponse sets `assist.serverAt = performance.now()`,
//      so a slow round trip still counts as fresh for ASSIST_STALE_MS after it
//      lands, and the ring can show a stale shape as if it were current.
//   2. The server quad replaces the ring's absolute position while it is fresh:
//      syncRingToAssist/ringQuadAt stop copying `state.quad` into the ring
//      whenever assist owns the shape, so local movement cannot correct, follow
//      or move the ring until the server quad goes stale.
//   3. The disagreement overlay (drawFrame, near ASSIST_SERVER_STROKE) compares
//      the server quad against a ring that has already converged to that same
//      quad, so the pair it is meant to expose is not the pair it draws.
//   4. Failure paths skip the backoff: pollAssist's non-ok and throw branches set
//      assist.error but never call beginAssistBackoff, so a 429/500/timeout is
//      retried every ASSIST_POLL_MS instead of waiting ASSIST_BACKOFF_MS.

function pushWindow(list, value, cap) {
  list.push(value)
  if (list.length > cap) list.splice(0, list.length - cap)
}

// EWMA over the retained window (span = ASSIST_WINDOW): alpha = 2 / (span + 1).
function ewmaOf(values) {
  if (!values.length) return null
  const alpha = 2 / (ASSIST_WINDOW + 1)
  let value = values[0]
  for (let i = 1; i < values.length; i += 1) value += alpha * (values[i] - value)
  return value
}

function cloneQuad(quad) {
  return quad ? quad.map(([x, y]) => [x, y]) : null
}

function roundTo(value, digits) {
  if (value == null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// --- quad geometry (normalised coordinates) ---------------------------------

function signedArea(points) {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

// Order corners counter-clockwise around their centroid. The detector and the
// server need not start at the same corner, and clipping needs one winding.
function orderQuad(quad) {
  const cx = quad.reduce((sum, [x]) => sum + x, 0) / quad.length
  const cy = quad.reduce((sum, [, y]) => sum + y, 0) / quad.length
  const ordered = [...quad].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx),
  )
  return signedArea(ordered) < 0 ? ordered.reverse() : ordered
}

// Canonical storage order: counter-clockwise (orderQuad's winding) from the
// top-left-most corner (smallest x + y, ties broken by the smaller y). Pairs are
// recorded this way so the analysis never has to re-derive corner ordering, and
// consecutive quads line up corner-for-corner for `motion`.
function canonicalQuad(quad) {
  if (!quad || quad.length !== 4) return null
  const ordered = orderQuad(quad)
  let start = 0
  for (let i = 1; i < ordered.length; i += 1) {
    const candidate = ordered[i]
    const current = ordered[start]
    const candidateKey = candidate[0] + candidate[1]
    const currentKey = current[0] + current[1]
    if (candidateKey < currentKey - 1e-9
      || (Math.abs(candidateKey - currentKey) <= 1e-9 && candidate[1] < current[1])) {
      start = i
    }
  }
  return ordered.slice(start).concat(ordered.slice(0, start)).map(([x, y]) => [x, y])
}

function polygonArea(points) {
  return Math.abs(signedArea(points))
}

function lineIntersection(p1, p2, q1, q2) {
  const r = [p2[0] - p1[0], p2[1] - p1[1]]
  const s = [q2[0] - q1[0], q2[1] - q1[1]]
  const denom = r[0] * s[1] - r[1] * s[0]
  if (Math.abs(denom) < 1e-12) return null
  const t = ((q1[0] - p1[0]) * s[1] - (q1[1] - p1[1]) * s[0]) / denom
  return [p1[0] + t * r[0], p1[1] + t * r[1]]
}

// Sutherland–Hodgman: clip `subject` by the convex `clip` polygon.
function clipPolygon(subject, clip) {
  let output = subject
  for (let i = 0; i < clip.length; i += 1) {
    const a = clip[i]
    const b = clip[(i + 1) % clip.length]
    const input = output
    output = []
    if (!input.length) break
    let previous = input[input.length - 1]
    let previousInside = (b[0] - a[0]) * (previous[1] - a[1])
      - (b[1] - a[1]) * (previous[0] - a[0]) >= 0
    for (const point of input) {
      const inside = (b[0] - a[0]) * (point[1] - a[1])
        - (b[1] - a[1]) * (point[0] - a[0]) >= 0
      if (inside) {
        if (!previousInside) {
          const hit = lineIntersection(previous, point, a, b)
          if (hit) output.push(hit)
        }
        output.push(point)
      } else if (previousInside) {
        const hit = lineIntersection(previous, point, a, b)
        if (hit) output.push(hit)
      }
      previous = point
      previousInside = inside
    }
  }
  return output
}

// Polygon intersection-over-union in normalised coordinates (0..1 of the
// frame), so two quads from different sources are directly comparable.
function quadIou(a, b) {
  if (!a || !b) return null
  const first = orderQuad(a)
  const second = orderQuad(b)
  const intersection = clipPolygon(first, second)
  const intersectionArea = intersection.length >= 3 ? polygonArea(intersection) : 0
  const union = polygonArea(first) + polygonArea(second) - intersectionArea
  return union > 0 ? intersectionArea / union : 0
}

// Mean corner distance, aligned over the four cyclic rotations and both
// windings so a different starting corner is not mistaken for disagreement.
function meanQuadDistance(a, b) {
  if (!a || !b) return Infinity
  let best = Infinity
  for (let reversed = 0; reversed < 2; reversed += 1) {
    for (let offset = 0; offset < 4; offset += 1) {
      let sum = 0
      for (let i = 0; i < 4; i += 1) {
        const j = (i + offset) % 4
        const point = reversed ? b[3 - j] : b[j]
        sum += Math.hypot(a[i][0] - point[0], a[i][1] - point[1])
      }
      best = Math.min(best, sum / 4)
    }
  }
  return best
}

// Rotate/reverse `target` to the correspondence closest to `reference`, so the
// ring's corners move to their nearest server corner rather than crossing.
function alignQuad(target, reference) {
  if (!target || !reference) return cloneQuad(target)
  let best = target
  let bestDistance = Infinity
  for (let reversed = 0; reversed < 2; reversed += 1) {
    for (let offset = 0; offset < 4; offset += 1) {
      const candidate = []
      for (let i = 0; i < 4; i += 1) {
        const j = (i + offset) % 4
        candidate.push(reversed ? target[3 - j] : target[j])
      }
      let sum = 0
      for (let i = 0; i < 4; i += 1) {
        sum += Math.hypot(candidate[i][0] - reference[i][0], candidate[i][1] - reference[i][1])
      }
      if (sum < bestDistance) {
        bestDistance = sum
        best = candidate
      }
    }
  }
  return cloneQuad(best)
}

function assistShapeInUse(now = performance.now()) {
  const assist = state.assist
  return assist.active && assist.serverQuad != null && now - assist.serverAt < ASSIST_STALE_MS
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2
}

function ringQuadAt(now, serverFresh) {
  const ring = state.ring
  if (!serverFresh && !ring.blend && state.quad) ring.quad = state.quad
  const blend = ring.blend
  if (!blend) return ring.quad
  const t = Math.min(1, (now - blend.start) / blend.duration)
  const eased = easeInOut(t)
  const quad = blend.from.map(([x, y], i) => [
    x + (blend.to[i][0] - x) * eased,
    y + (blend.to[i][1] - y) * eased,
  ])
  if (t >= 1) {
    ring.quad = cloneQuad(blend.to)
    ring.blend = null
  }
  return quad
}

function beginRingBlend(target) {
  if (!target) return
  const from = ringQuadAt(performance.now(), assistShapeInUse())
  if (!from) {
    state.ring.quad = cloneQuad(target)
    state.ring.blend = null
    return
  }
  state.ring.blend = {
    from: cloneQuad(from),
    to: cloneQuad(target),
    start: performance.now(),
    duration: ASSIST_BLEND_MS,
  }
}

// Leaving server shape: ease the ring back from wherever it is (including a
// half-finished blend) to the local quad instead of leaving it on the server.
function releaseAssistShape() {
  if (!state.quad) {
    state.ring.blend = null
    state.ring.quad = null
    return
  }
  if (state.ring.blend) {
    beginRingBlend(state.quad)
  } else {
    state.ring.quad = state.quad
  }
}

function syncRingToAssist() {
  const assist = state.assist
  if (assist.active && assist.serverQuad) {
    beginRingBlend(alignQuad(assist.serverQuad, ringQuadAt(performance.now(), assistShapeInUse())))
  } else {
    releaseAssistShape()
  }
}

// --- polling ----------------------------------------------------------------

function assistStatusText() {
  const assist = state.assist
  if (assist.mode === 'off') return 'off (manual)'
  if (assist.unavailable) {
    return assist.error ? `off — ${assist.error}` : 'off — server unavailable'
  }
  if (!state.running) return `idle (${assist.mode})`
  const rtt = assist.lastRttEwma
  const local = assist.lastLocalEwma
  const rttText = rtt == null ? '—' : `${Math.round(rtt)} ms`
  const localText = local == null ? '—' : `${Math.round(local)} ms`
  if (assist.backoff) {
    const left = Math.max(0, Math.ceil((assist.backoffUntil - performance.now()) / 1000))
    return `off — server slower (${rttText} vs ${localText}) · retry in ${left} s`
  }
  if (assist.active) {
    if (rtt == null) return 'on — waiting for samples'
    return `on (${rttText} vs ${localText})`
  }
  if (assist.rtts.length < ASSIST_MIN_SAMPLES) {
    return `waiting — ${assist.rtts.length}/${ASSIST_MIN_SAMPLES} round trips`
  }
  return 'waiting'
}

function scheduleAssistPoll(delay) {
  const assist = state.assist
  if (assist.timer != null) window.clearTimeout(assist.timer)
  assist.timer = null
  if (!state.running || assist.mode === 'off' || assist.unavailable || assist.backoff) return
  assist.timer = window.setTimeout(pollAssist, Math.max(0, delay))
}

function beginAssistBackoff() {
  const assist = state.assist
  if (assist.backoff) return
  assist.backoff = true
  assist.backoffUntil = performance.now() + ASSIST_BACKOFF_MS
  assist.active = false
  assist.serverQuad = null
  if (assist.timer != null) window.clearTimeout(assist.timer)
  assist.timer = window.setTimeout(retryAssist, ASSIST_BACKOFF_MS)
  syncRingToAssist()
  renderTelemetry()
}

// One probe cycle after the backoff: reset only the round-trip window and ask
// again. If the server is still slower the rule backs off for another 30 s.
function retryAssist() {
  const assist = state.assist
  assist.timer = null
  if (!state.running || assist.mode !== 'auto' || assist.unavailable) return
  assist.backoff = false
  assist.backoffUntil = 0
  assist.rtts = []
  assist.lastRttEwma = null
  scheduleAssistPoll(0)
  renderTelemetry()
}

function evaluateAssistAuto() {
  const assist = state.assist
  if (assist.rtts.length < ASSIST_MIN_SAMPLES || assist.locals.length < ASSIST_MIN_SAMPLES) {
    assist.active = false
    return
  }
  const rtt = ewmaOf(assist.rtts)
  const local = ewmaOf(assist.locals)
  assist.lastRttEwma = rtt
  assist.lastLocalEwma = local
  if (rtt < ASSIST_COST_RATIO * local) {
    assist.active = true
    assist.backoff = false
    return
  }
  assist.active = false
  beginAssistBackoff()
}

function normalizeServerQuad(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const points = []
  for (const point of raw) {
    const pair = Array.isArray(point) ? point : [point?.x, point?.y]
    const x = Number(pair?.[0])
    const y = Number(pair?.[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    points.push([x, y])
  }
  return points
}

function recordAssistPair({
  roundTripMs, serverMs, serverQuad, localQuad, localMs, localAt, serverAt,
  frameAt, thumb, localSharpness, localConfidence,
  serverSharpness, serverConfidence, serverDetection, serverResized, pairToken,
}) {
  const assist = state.assist
  // Canonical order is stored, not just used for IoU, so a pair can be read
  // corner-for-corner without guessing the source's starting corner.
  const canonicalLocal = canonicalQuad(localQuad)
  const canonicalServer = canonicalQuad(serverQuad)
  // Motion is only meaningful against the immediately previous pair of the same
  // run: a gap of two intervals would otherwise look like one interval of slow
  // drift, and a run boundary would compare two unrelated card positions.
  const reference = AB.active && AB.token === pairToken ? AB.pairs : assist.pairs
  const previous = reference.length ? reference[reference.length - 1] : null
  const previousLocal = previous?.localQuad || null
  const pair = {
    at: new Date().toISOString(),
    // performance.now() when the local result arrived and the server JSON was
    // parsed, plus the video time of the uploaded frame so a moving sample can
    // be detected and excluded.
    localAt: roundTo(localAt, 1),
    serverAt: roundTo(serverAt, 1),
    frameAt: roundTo(frameAt, 3),
    localQuad: canonicalLocal,
    serverQuad: canonicalServer,
    iou: canonicalLocal && canonicalServer ? roundTo(quadIou(canonicalLocal, canonicalServer), 4) : null,
    localSharpness: roundTo(localSharpness, 4),
    localConfidence: roundTo(localConfidence, 4),
    serverSharpness: roundTo(serverSharpness, 4),
    serverConfidence: roundTo(serverConfidence, 4),
    serverDetection: serverDetection ?? null,
    serverResized: serverResized === true,
    motion: previousLocal && canonicalLocal
      ? roundTo(meanQuadDistance(previousLocal, canonicalLocal), 4)
      : null,
    localMs: roundTo(localMs, 1),
    serverMs: roundTo(serverMs, 1),
    roundTripMs: Math.round(roundTripMs),
    agreed: Boolean(
      canonicalLocal && canonicalServer
      && meanQuadDistance(canonicalLocal, canonicalServer) <= ASSIST_DISAGREE,
    ),
  }
  assist.pairs.push(pair)
  if (assist.pairs.length > ASSIST_MAX_PAIRS) {
    assist.pairs.splice(0, assist.pairs.length - ASSIST_MAX_PAIRS)
  }
  // A request that began before the current run must not land in its pairs.
  if (AB.active && AB.token === pairToken) {
    AB.pairs.push(pair)
    if (thumb) AB.frameCandidates.push({ pair, canvas: thumb })
  }
  return pair
}

function handleAssistResponse(data, meta) {
  const {
    roundTripMs, serverAt, localQuad, localMs, localAt, pairToken, frameAt, thumb,
  } = meta
  const assist = state.assist
  const payload = data || {}
  const corners = normalizeServerQuad(payload.corners)
  const found = payload.detected !== false && corners != null
  const detectMs = Number.isFinite(payload.ms?.detect) ? payload.ms.detect : null
  const detection = typeof payload.detection === 'string' ? payload.detection : null

  pushWindow(assist.rtts, roundTripMs, ASSIST_WINDOW)
  assist.lastRttEwma = ewmaOf(assist.rtts)
  if (assist.locals.length) assist.lastLocalEwma = ewmaOf(assist.locals)

  if (found) {
    assist.serverQuad = corners
    assist.serverAt = performance.now()
  } else {
    assist.serverQuad = null
  }

  if (assist.mode === 'auto') evaluateAssistAuto()
  else if (assist.mode === 'on') assist.active = true

  // Adopt the server shape when active; on deactivation or a no-card response
  // this lets the ring return to the local quad.
  syncRingToAssist()

  recordAssistPair({
    roundTripMs,
    serverMs: detectMs,
    serverQuad: found ? corners : null,
    localQuad,
    localMs,
    localAt,
    serverAt,
    frameAt,
    thumb,
    localSharpness: state.lastSharpness,
    localConfidence: state.lastConfidence,
    serverSharpness: Number.isFinite(payload.sharpness) ? payload.sharpness : null,
    serverConfidence: Number.isFinite(payload.confidence) ? payload.confidence : null,
    serverDetection: detection,
    serverResized: payload.resized === true,
    pairToken,
  })
  renderTelemetry()
}

async function pollAssist() {
  const assist = state.assist
  assist.timer = null
  if (!state.running || assist.mode === 'off' || assist.unavailable || assist.backoff) return
  if (document.hidden) {
    scheduleAssistPoll(500)
    return
  }
  if (assist.inFlight) return

  const video = els.video
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
    scheduleAssistPoll(400)
    return
  }

  const canvas = els.assistFrame
  if (!canvas) {
    scheduleAssistPoll(ASSIST_POLL_MS)
    return
  }
  const scale = Math.min(1, ASSIST_UPLOAD_EDGE / Math.max(video.videoWidth, video.videoHeight))
  const width = Math.max(1, Math.round(video.videoWidth * scale))
  const height = Math.max(1, Math.round(video.videoHeight * scale))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  canvas.getContext('2d').drawImage(video, 0, 0, width, height)

  // The uploaded frame's identity: `frameAt` lets the analysis exclude a pair
  // whose card moved, and a run keeps a 480 px copy as ground truth. The copy is
  // only made while a run is recording, so idle polling costs nothing.
  const frameAt = video.currentTime
  const thumb = AB.active ? captureFrameThumb(video) : null

  // Pair the response with the frame's local result, not with whatever the
  // local detector has moved on to by the time the server answers.
  const sentLocalQuad = state.quad && performance.now() - state.lastQuadAt < QUAD_STALE_MS
    ? cloneQuad(state.quad)
    : null
  const sentLocalAt = sentLocalQuad ? state.lastQuadAt : null
  const sentLocalMs = assist.lastLocalMs

  let blob = null
  try {
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', ASSIST_JPEG_QUALITY))
  } catch {
    blob = null
  }
  if (!state.running || assist.mode === 'off' || assist.backoff || assist.unavailable) return
  if (!blob) {
    scheduleAssistPoll(ASSIST_POLL_MS)
    return
  }

  const pairToken = AB.token
  const controller = new AbortController()
  assist.controller = controller
  assist.inFlight = true
  const startedAt = performance.now()
  const timeout = window.setTimeout(() => controller.abort(), ASSIST_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('image', blob, 'frame.jpg')
    const token = localStorage.getItem('token')
    const response = await fetch(ASSIST_PATH, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: controller.signal,
    })
    let data = null
    try { data = await response.json() } catch { data = null }
    if (!response.ok) {
      const detail = data?.detail ?? data?.message
      if (response.status === 401) {
        assist.unavailable = true
        assist.error = 'sign in to use server assist'
      } else if (response.status === 404 || response.status === 503) {
        assist.unavailable = true
        assist.error = 'server unavailable'
      } else {
        assist.error = typeof detail === 'string' ? detail : `HTTP ${response.status}`
      }
      throw new Error(assist.error || `HTTP ${response.status}`)
    }
    const roundTripMs = performance.now() - startedAt
    const serverAt = performance.now()
    handleAssistResponse(data, {
      roundTripMs,
      serverAt,
      localQuad: sentLocalQuad,
      localMs: sentLocalMs,
      localAt: sentLocalAt,
      pairToken,
      frameAt,
      thumb,
    })
  } catch (error) {
    if (!assist.unavailable) {
      assist.error = error?.name === 'AbortError'
        ? `timed out after ${Math.round(ASSIST_TIMEOUT_MS / 1000)} s`
        : error?.message || String(error)
    }
  } finally {
    window.clearTimeout(timeout)
    if (assist.controller === controller) assist.controller = null
    assist.inFlight = false
    if (state.running && assist.mode !== 'off' && !assist.unavailable && !assist.backoff) {
      const elapsed = performance.now() - startedAt
      scheduleAssistPoll(Math.max(0, ASSIST_POLL_MS - elapsed))
    }
    renderTelemetry()
  }
}

function startAssist() {
  const assist = state.assist
  assist.unavailable = false
  assist.error = ''
  assist.backoff = false
  assist.backoffUntil = 0
  assist.rtts = []
  assist.locals = []
  assist.lastRttEwma = null
  assist.lastLocalEwma = null
  assist.lastLocalMs = null
  assist.serverQuad = null
  assist.serverAt = 0
  assist.active = assist.mode === 'on'
  scheduleAssistPoll(0)
}

function stopAssist() {
  const assist = state.assist
  if (assist.timer != null) window.clearTimeout(assist.timer)
  assist.timer = null
  assist.controller?.abort()
  assist.controller = null
  assist.inFlight = false
  assist.active = false
  assist.serverQuad = null
  assist.serverAt = 0
  assist.backoff = false
  assist.backoffUntil = 0
  assist.error = ''
  assist.unavailable = false
  state.ring.blend = null
  state.ring.quad = null
}

function setAssistMode(mode) {
  const assist = state.assist
  // An unrecognised mode is treated as `off`: the parked default, and the
  // fail-safe choice (no polling) rather than silently polling in `auto`.
  const next = mode === 'auto' || mode === 'on' ? mode : 'off'
  assist.mode = next
  if (els.assistMode) els.assistMode.value = next
  if (assist.timer != null) window.clearTimeout(assist.timer)
  assist.timer = null
  assist.backoff = false
  assist.backoffUntil = 0
  assist.unavailable = false
  assist.error = ''
  assist.rtts = []
  assist.lastRttEwma = null
  assist.active = next === 'on'
  if (next === 'off') {
    assist.controller?.abort()
    assist.controller = null
    assist.serverQuad = null
    syncRingToAssist()
  } else if (state.running) {
    scheduleAssistPoll(0)
  }
  renderTelemetry()
}

// --- ground-truth frames ----------------------------------------------------

// A 480 px long-edge copy of the frame just uploaded. It is kept per pair (one
// small canvas, not an encoded JPEG) so only the worst and median pair of a run
// are ever encoded; see ASSIST_FRAME_* for the size budget.
function captureFrameThumb(video) {
  if (!video.videoWidth || !video.videoHeight) return null
  const { width, height } = frameDimensions(video.videoWidth, video.videoHeight, ASSIST_FRAME_EDGE)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  try {
    canvas.getContext('2d').drawImage(video, 0, 0, width, height)
  } catch {
    return null
  }
  return canvas
}

function canvasToBase64(canvas) {
  return new Promise(resolve => {
    try {
      canvas.toBlob(async blob => {
        if (!blob) return resolve(null)
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let binary = ''
          // Chunked so a frame cannot overflow the argument list.
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          }
          resolve(btoa(binary))
        } catch {
          resolve(null)
        }
      }, 'image/jpeg', ASSIST_FRAME_QUALITY)
    } catch {
      resolve(null)
    }
  })
}

// Pick the worst- and median-IoU pair of a run and encode their frames. Both
// need both quads, so a pair the server missed is never used as ground truth.
// With a single eligible pair the two choices coincide and only one frame is
// sent; the cap is applied last, so a missing canvas cannot consume a slot.
async function runFrames(pairs, candidates) {
  if (!candidates.length) return []
  const eligible = pairs.filter(pair => pair.localQuad && pair.serverQuad && Number.isFinite(pair.iou))
  if (!eligible.length) return []

  const byPair = new Map(candidates.map(entry => [entry.pair, entry.canvas]))
  let worst = eligible[0]
  for (const pair of eligible) if (pair.iou < worst.iou) worst = pair
  const middle = median(eligible.map(pair => pair.iou))
  let medianPair = eligible[0]
  for (const pair of eligible) {
    if (Math.abs(pair.iou - middle) < Math.abs(medianPair.iou - middle)) medianPair = pair
  }

  const chosen = [{ kind: 'worst', pair: worst }]
  if (medianPair !== worst) chosen.push({ kind: 'median', pair: medianPair })

  const frames = []
  for (const entry of chosen) {
    if (frames.length >= ASSIST_FRAME_MAX) break
    const canvas = byPair.get(entry.pair)
    if (!canvas) continue
    const jpegB64 = await canvasToBase64(canvas)
    if (!jpegB64) continue
    frames.push({ kind: entry.kind, iou: roundTo(entry.pair.iou, 4), jpegB64 })
  }
  return frames
}

// --- payload ----------------------------------------------------------------

function downsample(list, max) {
  if (list.length <= max) return list.slice()
  if (max <= 1) return [list[list.length - 1]]
  const step = (list.length - 1) / (max - 1)
  const out = []
  for (let i = 0; i < max; i += 1) out.push(list[Math.round(i * step)])
  return out
}

function pairsForPayload(pairs) {
  return downsample(pairs || [], ASSIST_SEND_PAIRS).map(pair => ({ ...pair }))
}

function assistSummary(pairs = state.assist.pairs) {
  const assist = state.assist
  const ious = pairs.map(pair => pair.iou).filter(value => Number.isFinite(value))
  const localMs = pairs.map(pair => pair.localMs).filter(value => Number.isFinite(value))
  const serverMs = pairs.map(pair => pair.serverMs).filter(value => Number.isFinite(value))
  const localSharpness = pairs.map(pair => pair.localSharpness).filter(value => Number.isFinite(value))
  const serverSharpness = pairs.map(pair => pair.serverSharpness).filter(value => Number.isFinite(value))
  // Stillness is judged only on pairs that have a motion value, i.e. two
  // consecutive local quads; the first pair of a run and pairs without a local
  // quad are counted in neither bucket rather than guessed.
  const measured = pairs.filter(pair => pair.motion != null)
  const still = measured.filter(pair => pair.motion < ASSIST_STILL_MOTION)
  const stillIous = still
    .filter(pair => pair.localQuad && pair.serverQuad && Number.isFinite(pair.iou))
    .map(pair => pair.iou)
  return {
    mode: assist.mode,
    samples: pairs.length,
    meanIou: ious.length
      ? roundTo(ious.reduce((sum, value) => sum + value, 0) / ious.length, 3)
      : null,
    // IoU restricted to pairs whose card barely moved: the honest comparison of
    // boundary quality, without latency and motion mixed in.
    medianIouStill: roundTo(median(stillIous), 3),
    stillPairs: still.length,
    movingPairs: measured.length - still.length,
    stillThreshold: ASSIST_STILL_MOTION,
    medianLocalSharpness: roundTo(median(localSharpness), 3),
    medianServerSharpness: roundTo(median(serverSharpness), 3),
    medianRoundTripMs: round1(median(pairs.map(pair => pair.roundTripMs))),
    medianLocalMs: round1(median(localMs)),
    medianServerMs: round1(median(serverMs)),
    agreedShare: pairs.length
      ? roundTo(pairs.filter(pair => pair.agreed).length / pairs.length, 3)
      : null,
    localFoundShare: pairs.length
      ? roundTo(pairs.filter(pair => pair.localQuad != null).length / pairs.length, 3)
      : null,
    serverFoundShare: pairs.length
      ? roundTo(pairs.filter(pair => pair.serverQuad != null).length / pairs.length, 3)
      : null,
  }
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
  if (MATRIX.active) abortMatrix('camera changed')
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
  if (MATRIX.active && !MATRIX.internal) abortMatrix('detector input changed')
  state.detectorEdge = edge
  els.detectorSize.value = String(edge)
  // A different input edge is a different local inference cost.
  state.assist.locals = []
  state.assist.lastLocalEwma = null
  state.assist.lastLocalMs = null
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
  startAssist()
  scheduleTick(0)
}

function stopCamera() {
  abortMatrix('camera stopped')
  state.running = false
  cancelAbRun('camera stopped')
  stopAssist()
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
els.assistMode.addEventListener('change', () => setAssistMode(els.assistMode.value))
els.abRun.addEventListener('click', () => { void startAbRun() })
els.abSend.addEventListener('click', () => { void sendAbResults() })
els.matrixRun.addEventListener('click', () => { void startMatrix() })
els.matrixStop.addEventListener('click', () => abortMatrix('stopped'))
els.matrixRetry.addEventListener('click', () => { void postMatrixPayload() })

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
els.assistMode.value = state.assist.mode
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
