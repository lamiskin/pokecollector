// Detector worker for the cross-origin-isolated lab.
//
// Loads onnxruntime-web from /detector/vendor/ and runs Cornelius 2.12 on
// 384×384 frames. Unlike the app's worker it does NOT pin numThreads to 1: this
// page is served with COOP+COEP precisely so SharedArrayBuffer exists and the
// runtime can use a real thread pool. If isolation was not granted the runtime
// is forced back to 1 and the page is told, loudly.
//
// Everything here is plain JS: this file is served from /cv-js-lab/ by nginx,
// not bundled by Vite, so there are no relative imports and no build step.

const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]

let ort = null
let session = null
let inputName = 'image'
let scratch = null
let scratchCtx = null
let detectorSize = 384
let runtimeInfo = null

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0))
}

// Same canonical TL,TR,BR,BL ordering as the app's detector worker, so a quad
// drawn here can be compared directly with the app's.
function orderCorners(points) {
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
  return signedArea < 0 ? [ordered[0], ordered[3], ordered[2], ordered[1]] : ordered
}

async function init(message) {
  const isolated = self.crossOriginIsolated === true
  const hasSAB = typeof SharedArrayBuffer !== 'undefined'
  const hardwareConcurrency = self.navigator?.hardwareConcurrency || 1
  detectorSize = Number(message.size) || 384

  const requested = Math.max(1, Math.min(Number(message.threads) || 1, hardwareConcurrency))
  // ORT only spawns a pool when SharedArrayBuffer is available; that requires
  // cross-origin isolation. Asking for >1 without it throws at session creation,
  // so the page's fallback is explicit rather than an accidental exception.
  const effective = isolated && hasSAB ? requested : 1

  const vendorBase = new URL(message.wasmPaths, self.location.origin).href
  const moduleUrl = new URL(`${message.wasmPaths}ort.wasm.min.mjs`, self.location.origin).href
  ort = await import(moduleUrl)

  ort.env.wasm.wasmPaths = vendorBase
  ort.env.wasm.numThreads = effective
  ort.env.wasm.simd = true
  ort.env.wasm.proxy = false

  const response = await fetch(message.modelUrl)
  if (!response.ok) {
    throw new Error(`model download failed: ${message.modelUrl} → HTTP ${response.status}`)
  }
  const model = await response.arrayBuffer()
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
  inputName = session.inputNames[0] || 'image'

  runtimeInfo = {
    isolated,
    hasSAB,
    requested,
    granted: Number(ort.env.wasm.numThreads) || 1,
    hardwareConcurrency,
    simd: ort.env.wasm.simd !== false,
    wasmPaths: vendorBase,
    inputs: session.inputNames,
    outputs: session.outputNames,
  }
  return runtimeInfo
}

function fillTensor(bitmap) {
  if (!scratch) {
    scratch = new OffscreenCanvas(detectorSize, detectorSize)
    scratchCtx = scratch.getContext('2d', { willReadFrequently: true })
  }
  scratchCtx.drawImage(bitmap, 0, 0, detectorSize, detectorSize)
  const { data } = scratchCtx.getImageData(0, 0, detectorSize, detectorSize)

  const plane = detectorSize * detectorSize
  const tensor = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i += 1) {
    const r = data[i * 4] / 255
    const g = data[i * 4 + 1] / 255
    const b = data[i * 4 + 2] / 255
    tensor[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
    tensor[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1]
    tensor[plane * 2 + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2]
  }
  return tensor
}

async function detect(bitmap, frameWidth, frameHeight) {
  if (!session) throw new Error('the detector session is not ready')

  const prepStarted = performance.now()
  const tensor = fillTensor(bitmap)
  const prepMs = performance.now() - prepStarted

  const runStarted = performance.now()
  const outputs = await session.run({
    [inputName]: new ort.Tensor('float32', tensor, [1, 3, detectorSize, detectorSize]),
  })
  const runMs = performance.now() - runStarted

  const cornerData = outputs.corners?.data
  if (!cornerData || cornerData.length < 8) {
    throw new Error(`the model returned no corners (outputs: ${Object.keys(outputs).join(', ')})`)
  }
  const points = []
  for (let i = 0; i < 8; i += 2) {
    points.push([clamp01(cornerData[i]), clamp01(cornerData[i + 1])])
  }

  return {
    corners: orderCorners(points),
    sharpness: outputs.sharpness ? Number(outputs.sharpness.data[0]) : null,
    prepMs,
    runMs,
    totalMs: prepMs + runMs,
    frameWidth,
    frameHeight,
    threads: runtimeInfo?.granted ?? 1,
  }
}

self.onmessage = async event => {
  const message = event.data || {}
  try {
    if (message.type === 'init') {
      const info = await init(message)
      self.postMessage({ type: 'ready', ...info })
      return
    }
    if (message.type === 'frame') {
      const result = await detect(message.bitmap, message.frameWidth, message.frameHeight)
      self.postMessage({ type: 'result', seq: message.seq, ...result })
      return
    }
    throw new Error(`unknown message type: ${message.type}`)
  } catch (error) {
    self.postMessage({
      type: 'error',
      seq: message.seq,
      message: `${error?.name || 'Error'}: ${error?.message || String(error)}`,
    })
  } finally {
    if (message.type === 'frame') message.bitmap?.close?.()
  }
}
