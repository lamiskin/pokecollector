// Card-corner detector worker (Cornelius 2.12, onnxruntime-web 1.24.3).
//
// The runtime is loaded from the vendored public assets at request time, not
// bundled: onnxruntime-web ships a wasm sidecar that must sit beside the .mjs.
// Three modes are selectable per init: asyncify, plain simd, and experimental
// webgpu. WebGPU is known to produce plausible-but-wrong quads on Android ARM,
// so it is checked once per session against a plain-simd reference; that check
// can degrade to "unverified" without stopping detection. Wasm modes keep
// numThreads at 1 so no SharedArrayBuffer / COOP+COEP is needed.

import { cropQuadToFrame } from '../utils/refineCrop'

const DETECTOR_SIZE = 384
const MIN_SHARPNESS = 0.02
const RUNTIME_URLS = {
  asyncify: '/detector/vendor/ort.webgpu.min.mjs',
  wasm: '/detector/vendor/ort.wasm.min.mjs',
  // Same bundle as asyncify, but the session is created with the webgpu EP.
  webgpu: '/detector/vendor/ort.webgpu.min.mjs',
}
const MODEL_URL = '/detector/cornelius-2.12.onnx'
const WASM_DIR = '/detector/vendor/'
// The worker may be started from a blob (so its policy is the document's, see
// CaptureLab.loadDetector), and inside a blob worker a root-relative path like
// '/detector/x' has no base to resolve against - Firefox rejects it outright.
// The page supplies its origin with the init message and every detector URL is
// resolved against it.
let assetBase = ''
const assetUrl = path => (assetBase ? new URL(path, assetBase).href : path)
const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]

const runtimeModules = new Map()
let ort = null
let session = null
let modelBuffer = null
let activeRuntime = null
// Lazily created plain-simd session used only to sanity-check webgpu output.
let reference = null
let referencePromise = null
let verificationAttempted = false
// The tensor, source size and main result of the latest detection, reused by
// an explicit verify request so both sessions see exactly the same frame.
let lastDetection = null
let scratch = null
let scratchCtx = null

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0))
}

// Canonical TL, TR, BR, BL order, ported from the reference web scanner.
// Edge length is deliberately not used: a portrait card has two short edges,
// and under perspective one is always marginally shorter, so choosing the
// shortest edge as the top flips the card 180° between frames. The user holds
// the card in the same orientation they see, so the corner nearest the frame's
// top-left is the correct reference.
function orderCorners(points, width, height) {
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length
  const sorted = [...points].sort(
    ([ax, ay], [bx, by]) => Math.atan2(ay - cy, ax - cx) - Math.atan2(by - cy, bx - cx),
  )
  let start = 0
  let best = Infinity
  for (let i = 0; i < sorted.length; i += 1) {
    const score = sorted[i][0] + sorted[i][1]
    if (score < best) {
      best = score
      start = i
    }
  }
  const ordered = [
    sorted[start],
    sorted[(start + 1) % 4],
    sorted[(start + 2) % 4],
    sorted[(start + 3) % 4],
  ]
  const signedArea = ordered.reduce((sum, [x1, y1], i) => {
    const [x2, y2] = ordered[(i + 1) % ordered.length]
    return sum + (x1 * y2 - x2 * y1)
  }, 0)
  const canonical = signedArea < 0
    ? [ordered[0], ordered[3], ordered[2], ordered[1]]
    : ordered
  return canonical
}

function quadArea(corners) {
  let area = 0
  for (let i = 0; i < corners.length; i += 1) {
    const [x1, y1] = corners[i]
    const [x2, y2] = corners[(i + 1) % corners.length]
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area) * 0.5
}

function isUsableQuad(corners) {
  if (!corners || corners.length !== 4) return false
  const area = quadArea(corners)
  if (!Number.isFinite(area) || area < 0.01) return false
  for (let i = 0; i < corners.length; i += 1) {
    for (let j = i + 1; j < corners.length; j += 1) {
      const dx = corners[i][0] - corners[j][0]
      const dy = corners[i][1] - corners[j][1]
      if (dx * dx + dy * dy < 0.0004) return false
    }
  }
  // Reject concave quads: a missed corner usually produces three nearly
  // collinear points and one outlier, which flips one cross-product sign.
  let positive = 0
  let negative = 0
  for (let i = 0; i < 4; i += 1) {
    const prev = corners[(i + 3) % 4]
    const curr = corners[i]
    const next = corners[(i + 1) % 4]
    const cross = (curr[0] - prev[0]) * (next[1] - curr[1])
      - (curr[1] - prev[1]) * (next[0] - curr[0])
    if (cross > 0) positive += 1
    if (cross < 0) negative += 1
  }
  return !(positive > 0 && negative > 0)
}

async function loadRuntime(runtime) {
  if (!runtimeModules.has(runtime)) {
    // One namespace per build URL: switching back reuses the imported module.
    runtimeModules.set(runtime, await import(/* @vite-ignore */ assetUrl(RUNTIME_URLS[runtime])))
  }
  const module = runtimeModules.get(runtime)
  module.env.wasm.numThreads = 1
  module.env.wasm.wasmPaths = assetUrl(WASM_DIR)
  return module
}

async function getModelBuffer() {
  if (modelBuffer) return modelBuffer
  const response = await fetch(assetUrl(MODEL_URL))
  if (!response.ok) {
    throw new Error(`model download failed: HTTP ${response.status}`)
  }
  modelBuffer = await response.arrayBuffer()
  return modelBuffer
}

async function init(runtime = 'asyncify') {
  const selected = ['wasm', 'webgpu'].includes(runtime) ? runtime : 'asyncify'
  const isWebgpu = selected === 'webgpu'
  if (isWebgpu && (typeof navigator === 'undefined' || !navigator.gpu)) {
    throw new Error(
      `webgpu unavailable: typeof self.navigator=${typeof self.navigator}, `
      + `typeof self.navigator?.gpu=${typeof self.navigator?.gpu}, `
      + `self.isSecureContext=${Boolean(self.isSecureContext)}`,
    )
  }

  ort = await loadRuntime(selected)
  if (isWebgpu && ort.env.webgpu) ort.env.webgpu.forceFp16 = false

  let nextSession
  try {
    nextSession = await ort.InferenceSession.create(await getModelBuffer(), {
      executionProviders: [isWebgpu ? 'webgpu' : 'wasm'],
    })
  } catch (error) {
    if (isWebgpu) {
      throw new Error(`webgpu session creation failed: ${error?.message || error}`)
    }
    throw error
  }

  const previousSession = session
  session = nextSession
  activeRuntime = selected
  verificationAttempted = false
  lastDetection = null
  if (previousSession) {
    try {
      await previousSession.release?.()
    } catch {
      // Older builds may not expose release(); replacing the reference is enough.
    }
  }
}

async function ensureReference() {
  if (reference) return reference
  if (!referencePromise) {
    referencePromise = (async () => {
      const module = await loadRuntime('wasm')
      const referenceSession = await module.InferenceSession.create(await getModelBuffer(), {
        executionProviders: ['wasm'],
      })
      reference = { ort: module, session: referenceSession }
      return reference
    })()
  }
  try {
    return await referencePromise
  } catch (error) {
    referencePromise = null
    throw error
  }
}

async function runOn(module, targetSession, tensorData, width, height) {
  const inputName = targetSession.inputNames[0] || 'image'
  const runStarted = performance.now()
  const outputs = await targetSession.run({
    [inputName]: new module.Tensor('float32', tensorData, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]),
  })
  const runMs = performance.now() - runStarted
  const decodeStarted = performance.now()
  const cornerData = outputs.corners?.data
  if (!cornerData || cornerData.length < 8) {
    throw new Error('Detector returned no corners')
  }
  const points = []
  for (let i = 0; i < 8; i += 2) {
    points.push([clamp01(cornerData[i]), clamp01(cornerData[i + 1])])
  }
  const result = {
    corners: orderCorners(points, width, height),
    sharpness: outputs.sharpness ? Number(outputs.sharpness.data[0]) : null,
    runMs,
    decodeMs: performance.now() - decodeStarted,
  }
  return result
}

// Never throw from verification: the detection loop must keep running with an
// "unverified" result when the wasm reference cannot be created (e.g. memory).
async function verifyWebgpu() {
  if (activeRuntime !== 'webgpu') {
    return { unverified: true, reason: 'the active runtime is not webgpu' }
  }
  if (!lastDetection) {
    return { unverified: true, reason: 'no detection frame is available yet' }
  }
  const { tensorData, width, height, main } = lastDetection
  try {
    const referenceRuntime = await ensureReference()
    const started = performance.now()
    const referenceResult = await runOn(
      referenceRuntime.ort,
      referenceRuntime.session,
      tensorData,
      width,
      height,
    )
    const referenceMs = Math.round(performance.now() - started)
    let maxCornerDelta = 0
    for (let i = 0; i < 4; i += 1) {
      maxCornerDelta = Math.max(
        maxCornerDelta,
        Math.hypot(
          main.corners[i][0] - referenceResult.corners[i][0],
          main.corners[i][1] - referenceResult.corners[i][1],
        ),
      )
    }
    const sharpnessDelta = Number.isFinite(main.sharpness)
      && Number.isFinite(referenceResult.sharpness)
      ? Math.abs(main.sharpness - referenceResult.sharpness)
      : null
    return { maxCornerDelta, sharpnessDelta, referenceMs }
  } catch (error) {
    return { unverified: true, reason: `wasm reference unavailable: ${error?.message || error}` }
  }
}

function fillInputTensor(bitmap) {
  if (!scratch) {
    scratch = new OffscreenCanvas(DETECTOR_SIZE, DETECTOR_SIZE)
    scratchCtx = scratch.getContext('2d', { willReadFrequently: true })
  }
  const drawStarted = performance.now()
  scratchCtx.drawImage(bitmap, 0, 0, DETECTOR_SIZE, DETECTOR_SIZE)
  const drawMs = performance.now() - drawStarted

  const tensorStarted = performance.now()
  const { data } = scratchCtx.getImageData(0, 0, DETECTOR_SIZE, DETECTOR_SIZE)
  const plane = DETECTOR_SIZE * DETECTOR_SIZE
  const tensor = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i += 1) {
    const r = data[i * 4] / 255
    const g = data[i * 4 + 1] / 255
    const b = data[i * 4 + 2] / 255
    tensor[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
    tensor[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1]
    tensor[plane * 2 + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2]
  }
  return { tensor, drawMs, tensorMs: performance.now() - tensorStarted }
}

async function detect(bitmap) {
  const started = performance.now()
  if (!session) throw new Error('Detector is not loaded')
  const width = bitmap.width
  const height = bitmap.height
  const { tensor: tensorData, drawMs, tensorMs } = fillInputTensor(bitmap)

  let main
  try {
    main = await runOn(ort, session, tensorData, width, height)
  } catch (error) {
    if (activeRuntime === 'webgpu') {
      throw new Error(`webgpu detection failed: ${error?.message || error}`)
    }
    throw error
  }
  const ms = Math.round(performance.now() - started)
  const round = value => Math.round(value * 10) / 10
  const detectParts = {
    drawMs: round(drawMs),
    tensorMs: round(tensorMs),
    runMs: round(main.runMs),
    decodeMs: round(main.decodeMs),
  }
  const quadUsable = isUsableQuad(main.corners)
  const sharpEnough = Number.isFinite(main.sharpness) && main.sharpness >= MIN_SHARPNESS
  const usable = quadUsable && sharpEnough
  // Say which gate failed, so the UI can ask for steadiness instead of pointing
  // the camera. A finite-but-low score is "soft"; a valid quad with no finite
  // score is also treated as soft, since the geometry is not the problem.
  const unusableReason = usable
    ? null
    : (quadUsable ? 'soft' : 'no-quad')
  lastDetection = { tensorData, width, height, main }

  // Verify only once per webgpu session; an explicit verify message can retest.
  let verification
  if (activeRuntime === 'webgpu' && !verificationAttempted) {
    verificationAttempted = true
    try {
      verification = await verifyWebgpu()
    } catch (error) {
      // Verification must never break the detection loop.
      verification = { unverified: true, reason: error?.message || String(error) }
    }
  }
  return {
    corners: main.corners,
    sharpness: main.sharpness,
    usable,
    unusableReason,
    ms,
    detectParts,
    ...(verification ? { verification } : {}),
  }
}

async function refine(bitmap, cropRect) {
  if (!bitmap || bitmap.width < 24 || bitmap.height < 24) {
    return { corners: null, sharpness: null, usable: false, reason: 'bad-crop' }
  }
  const aspect = bitmap.width / bitmap.height
  if (aspect > 4 || aspect < 0.25) {
    return { corners: null, sharpness: null, usable: false, reason: 'bad-crop' }
  }
  const result = await detect(bitmap)
  return {
    corners: cropQuadToFrame(result.corners, cropRect),
    sharpness: result.sharpness,
    usable: result.usable,
    reason: result.unusableReason,
  }
}

self.onmessage = async event => {
  const message = event.data || {}
  try {
    if (message.type === 'init') {
      assetBase = message.assetBase || ''
      await init(message.runtime)
      self.postMessage({ type: 'ready', runtime: activeRuntime })
      return
    }
    if (message.type === 'detect') {
      const result = await detect(message.bitmap)
      self.postMessage({ type: 'result', seq: message.seq, ...result })
      return
    }
    if (message.type === 'refine') {
      const result = await refine(message.bitmap, message.cropRect)
      self.postMessage({ type: 'refined', seq: message.seq, cropRect: message.cropRect, ...result })
      return
    }
    if (message.type === 'verify') {
      self.postMessage({ type: 'verification', verification: await verifyWebgpu() })
      return
    }
    throw new Error(`Unknown message type: ${message.type}`)
  } catch (error) {
    self.postMessage({
      type: 'error',
      seq: message.seq,
      message: `${error?.name || 'Error'}: ${error?.message || String(error)}`,
    })
  } finally {
    if (message.type === 'detect' || message.type === 'refine') message.bitmap?.close()
  }
}
