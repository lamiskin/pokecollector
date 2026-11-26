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
const RUNTIME = 'wasm'
const THREAD_CAP = 4

// Matches the app's live loop (CaptureLab LIVE_MAX_EDGE): the model squashes to
// 384x384 itself, so a 640 px long edge is enough and keeps phones cool.
const FRAME_MAX_EDGE = 640
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
  isolated: document.getElementById('s-isolated'),
  threads: document.getElementById('s-threads'),
  rate: document.getElementById('s-rate'),
  ms: document.getElementById('s-ms'),
  camera: document.getElementById('s-camera'),
  frame: document.getElementById('s-frame'),
  count: document.getElementById('s-count'),
  sharp: document.getElementById('s-sharp'),
  blurState: document.getElementById('blur-state'),
  workerSrc: document.getElementById('worker-src'),
}

const state = {
  running: false,
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
  threads: { requested: 0, granted: 0, isolated: false, hasSAB: false, hardware: 1 },
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
  setStat(
    els.threads,
    granted ? `${granted}${requested > granted ? ` / ${requested} asked` : ''}` : '…',
    granted > 1 ? 'ok' : granted ? 'warn' : '',
  )

  const rate = detectionsPerSecond()
  setStat(els.rate, rate === null ? '…' : rate.toFixed(1))

  const inference = median(state.runSamples)
  setStat(els.ms, inference === null ? '…' : inference.toFixed(1))

  const video = els.video
  const width = video.videoWidth
  const height = video.videoHeight
  setStat(els.camera, width && height ? `${width} × ${height}` : '…')
  if (width && height) {
    const settings = state.cameraSettings || {}
    const maximum = state.cameraMaximum
    els.camera.title = [
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

function drawFrame() {
  window.requestAnimationFrame(drawFrame)
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

  const fresh = state.quad && performance.now() - state.lastQuadAt < QUAD_STALE_MS
  if (!fresh) {
    hideBlur()
    return
  }

  const points = mapToStage(state.quad, rect)
  if (!points) {
    hideBlur()
    return
  }

  const detected = performance.now() - state.lastUsableAt < SOLID_HOLD_MS
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
    if (Number.isFinite(inferenceMs)) pushSample(state.runSamples, inferenceMs)

    state.detections += 1
    state.stamps.push(performance.now())
    renderTelemetry()
    scheduleTick(DETECT_GAP_MS)
    return
  }

  if (message.type === 'error') {
    state.inFlight = false
    if (message.seq != null && message.seq !== state.seq) return
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

  worker.onmessage = onWorkerMessage
  worker.onerror = event => {
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
  // The guard the task exists for: a pool only when the document is isolated and
  // the browser exposes SharedArrayBuffer. The worker re-checks and clamps too.
  const requested = isolated && hasSAB ? Math.min(THREAD_CAP, hardware) : 1
  state.threads = { requested, granted: 0, isolated, hasSAB, hardware }

  worker.postMessage({
    type: 'init',
    runtime: RUNTIME,
    numThreads: requested,
    assetBase: window.location.origin,
  })

  const info = await withTimeout(ready, READY_TIMEOUT_MS)
  state.threads.granted = Number(info.threads) || 1
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
        + `hardwareConcurrency is ${hardware}. Requested ${requested}.</p>`,
    )
  } else {
    showBanner(
      'ok',
      `Cross-origin isolated · ${state.threads.granted} WASM threads`,
      `<p>Requested ${requested}, hardwareConcurrency ${hardware}, runtime `
        + `<code>${state.threads.runtime}</code>.</p>`,
    )
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

  const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight))
  const width = Math.max(1, Math.round(video.videoWidth * scale))
  const height = Math.max(1, Math.round(video.videoHeight * scale))

  const canvas = document.getElementById('frame-source')
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  canvas.getContext('2d').drawImage(video, 0, 0, width, height)
  state.frameSize = { width, height }

  let bitmap
  try {
    bitmap = await createImageBitmap(canvas)
  } catch {
    scheduleTick(250)
    return
  }
  if (!state.running || !state.worker) {
    bitmap.close?.()
    return
  }

  state.seq += 1
  state.inFlight = true
  try {
    state.worker.postMessage({ type: 'detect', bitmap, seq: state.seq }, [bitmap])
  } catch (error) {
    state.inFlight = false
    bitmap.close?.()
    fail('Could not send a frame', error?.message || String(error))
    return
  }
  renderTelemetry()
}

// --------------------------------------------------------------------- camera

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
  if (maxWidth && maxHeight) {
    state.cameraMaximum = { width: maxWidth, height: maxHeight }
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints({ width: { ideal: maxWidth }, height: { ideal: maxHeight } })
      } catch {
        // Keep the browser's initial 1920x1080 when the maximum is rejected.
      }
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

  try { state.cameraSettings = track?.getSettings?.() || {} } catch { state.cameraSettings = {} }
  if (els.video.videoWidth && els.video.videoHeight) {
    els.stage.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`
  }
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
  renderTelemetry()
  scheduleTick(0)
}

function stopCamera() {
  state.running = false
  window.clearTimeout(state.timer)
  state.timer = null
  state.inFlight = false

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

  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop()
    state.stream = null
  }
  els.video.srcObject = null

  state.cameraMaximum = null
  state.cameraSettings = null
  state.blurKey = null
  state.blurSize = null
  hideBlur()
  clearOverlay()
  resetTelemetry()

  els.start.disabled = false
  els.stop.disabled = true
  els.hint.hidden = false
  els.hint.textContent = 'Stopped. Press Start camera to measure again.'
  els.stage.style.aspectRatio = '4 / 3'
}

function fail(title, detail) {
  // stopCamera() resets the camera, worker and ring but leaves the banner alone,
  // so the failure stays on screen until the next Start.
  stopCamera()
  showBanner('error', title, `<p>${detail}</p>`)
}

// ---------------------------------------------------------------------- wiring

els.start.addEventListener('click', startCamera)
els.stop.addEventListener('click', stopCamera)

window.addEventListener('resize', () => {
  if (!state.running) clearOverlay()
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.running) scheduleTick(0)
})

els.blurState.textContent = BLUR_SUPPORTED ? 'on (backdrop-filter masked by the quad)' : 'off (unsupported in this browser)'
if (!BLUR_SUPPORTED) els.blur.style.display = 'none'

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
