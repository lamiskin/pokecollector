import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Camera, RefreshCw, VideoOff } from 'lucide-react'
import api, { getApiErrorMessage } from '../api/client'

// Dev-only comparison page: it draws CollectorVision's live card boundary over
// the camera preview so it can be compared with our detector on the same phone.
// Nothing is captured, stored or sent to the scanner.
//
// CollectorVision is amber; our detector is green (#22c55e). This page does not
// re-implement the detector/tracker loop from CaptureLab: it only starts the
// existing detector worker on a downscaled frame and draws the raw quad it
// returns. No tracker, smoothing or capture logic is involved.

const POLL_INTERVAL_MS = 800
const REQUEST_TIMEOUT_MS = 15000
const JPEG_QUALITY = 0.8
const CV_STROKE = '#f59e0b'
const CV_DETECT_PATH = '/capture-lab/cv-detect'
const EXPERIMENTS_PATH = '/capture-lab/experiments'

// Camera presets renegotiated on the live track. 'max' re-applies the track's
// capability maximum, which is what the start request asks for.
const CAMERA_SIZES = [
  { key: 'max', label: 'Max (capability)', width: null, height: null },
  { key: '1920x1080', label: '1920 × 1080', width: 1920, height: 1080 },
  { key: '1280x720', label: '1280 × 720', width: 1280, height: 720 },
  { key: '960x540', label: '960 × 540', width: 960, height: 540 },
]
const DEFAULT_CAMERA_SIZE = 'max'

// Our detector's own cadence, independent of the CV poll. The detector input is
// the long edge of the frame canvas only: changing it never restarts the worker.
const OURS_INTERVAL_MS = 400
const DETECTOR_EDGES = [320, 480, 640, 960]
const DEFAULT_DETECTOR_EDGE = 640
const OURS_STROKE = '#22c55e'
const OURS_RUNTIME = 'asyncify'
const OURS_MEDIAN_WINDOW = 20

// The JPEG long edge uploaded to CollectorVision. Smaller uploads are cheaper to
// encode and send; the server downsizes again to its own detection edge anyway.
const CV_UPLOAD_EDGES = [640, 960, 1280, 1600]
const DEFAULT_CV_UPLOAD_EDGE = 1280

const SWEEP_DURATION_MS = 10000
// "Run all & send": every detector input × CV upload combination at the current
// camera size. There is no thread cap on this page (the detector worker is
// started once by the app), so six 8 s runs cover the matrix in about 48 s.
const MATRIX_INPUT_EDGES = [320, 480, 640]
const MATRIX_CV_EDGES = [960, 1280]
const MATRIX_DURATION_MS = 8000

function toFiniteNumber(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// The endpoint is expected to answer with a normalized quad (0..1 of the frame
// it was sent). Pixel corners are accepted only when the response also states
// the frame size, because guessing a divisor would silently misplace the box.
function normalizeQuad(raw, frame) {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const points = []
  let maxAbs = 0
  for (const point of raw) {
    const pair = Array.isArray(point) ? point : [point?.x, point?.y]
    if (!Array.isArray(pair) || pair.length < 2) return null
    const x = Number(pair[0])
    const y = Number(pair[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y))
    points.push([x, y])
  }
  if (maxAbs <= 1.5) return points
  const width = toFiniteNumber(frame?.width)
  const height = toFiniteNumber(frame?.height)
  if (!width || !height) return null
  return points.map(([x, y]) => [x / width, y / height])
}

function readDetection(payload) {
  const data = payload || {}
  const block = data.detection && typeof data.detection === 'object' ? data.detection : null
  const frame = data.frame || data
  const rawQuad = data.corners ?? data.quad ?? data.polygon ?? block?.corners
  const detection = block?.path
    ?? block?.mode
    ?? (typeof data.detection === 'string' ? data.detection : null)
    ?? data.detectionPath
    ?? data.path
    ?? null
  const sharpness = toFiniteNumber(
    data.sharpness ?? block?.sharpness ?? data.quality?.sharpness,
  )
  // The server times its own decode + detection; it is the CV half's compute
  // cost without the upload, encode or network.
  const detectMs = toFiniteNumber(data.ms?.detect ?? data.detectMs ?? data.detect_ms)
  // The server reports this as `resized` (the frame was downscaled before
  // detection); older shapes used `downscaled`.
  const downscaled = typeof data.resized === 'boolean'
    ? data.resized
    : typeof data.downscaled === 'boolean'
      ? data.downscaled
      : typeof data.frame?.downscaled === 'boolean'
        ? data.frame.downscaled
        : null
  return {
    corners: normalizeQuad(rawQuad, frame),
    detection,
    sharpness,
    detectMs,
    downscaled,
    // The server answers `detected`; older shapes used `found`.
    found: data.detected !== false && data.found !== false,
  }
}

function formatTelemetry(telemetry) {
  if (!telemetry) return 'No frame sent yet.'
  return [
    telemetry.roundTripMs == null ? 'round trip —' : `round trip ${telemetry.roundTripMs} ms`,
    telemetry.detectMs == null ? 'detect —' : `detect ${telemetry.detectMs} ms`,
    `detection ${telemetry.detection || '—'}`,
    `sharpness ${telemetry.sharpness == null ? '—' : telemetry.sharpness.toFixed(3)}`,
    telemetry.downscaled == null
      ? 'downscaled unknown'
      : telemetry.downscaled ? 'downscaled yes' : 'downscaled no',
  ].join(' · ')
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function round1(value) {
  return value == null ? null : Math.round(value * 10) / 10
}

function rateFromStamps(stamps) {
  if (stamps.length < 2) return null
  const span = stamps[stamps.length - 1] - stamps[0]
  return span > 0 ? ((stamps.length - 1) * 1000) / span : null
}

// One line per cam · in · cv: the standalone page's format with the cap absent
// and the CV half appended.
function formatResultLine(result) {
  const ours = result.ours
  const ms = ours?.msMedian == null ? '—' : ours.msMedian.toFixed(1)
  const rate = ours?.perSecond == null ? '—' : ours.perSecond.toFixed(1)
  const head = `cam ${result.cam} · in ${result.edge} · cv ${result.cvUpload} → ${ms} ms, ${rate}/s`
  if (!result.cv) return `${head} · cv no samples`
  const cv = result.cv
  const roundTrip = cv.roundTripMs == null ? '—' : `${cv.roundTripMs} ms rt`
  const detect = cv.detectMs == null ? '—' : `${cv.detectMs} ms detect`
  const sharp = cv.sharpness == null ? '—' : cv.sharpness.toFixed(3)
  return `${head} · cv ${roundTrip} / ${detect} · ${cv.detection || '—'} · sharp ${sharp}`
    + ` · ${cv.found ? 'found' : 'no card'} · ${cv.resized ? 'resized' : 'not resized'}`
}

function formatOurTelemetry(status, telemetry) {
  if (status === 'unavailable') return 'ours · our detector unavailable'
  if (status !== 'ready') return 'ours · detector starting…'
  return [
    'ours',
    `inference ${telemetry?.inferenceMs == null ? '—' : `${Math.round(telemetry.inferenceMs)} ms`}`,
    `detections ${telemetry?.detections ?? 0}`,
  ].join(' · ')
}

export default function CaptureLabCvLive() {
  const [cameraStatus, setCameraStatus] = useState('idle')
  const [cameraError, setCameraError] = useState('')
  const [cameraSizeKey, setCameraSizeKey] = useState(DEFAULT_CAMERA_SIZE)
  const [cameraResolved, setCameraResolved] = useState('')
  const [cameraNote, setCameraNote] = useState('')
  const [detectorEdge, setDetectorEdge] = useState(DEFAULT_DETECTOR_EDGE)
  const [cvUploadEdge, setCvUploadEdge] = useState(DEFAULT_CV_UPLOAD_EDGE)
  const [quad, setQuad] = useState(null)
  const [telemetry, setTelemetry] = useState(null)
  const [inFlight, setInFlight] = useState(false)
  const [notice, setNotice] = useState(null)
  const [ourStatus, setOurStatus] = useState('idle')
  const [ourQuad, setOurQuad] = useState(null)
  const [ourTelemetry, setOurTelemetry] = useState(null)
  const [sweepActive, setSweepActive] = useState(false)
  const [sweepStatus, setSweepStatus] = useState('')
  const [results, setResults] = useState([])
  const [label, setLabel] = useState('')
  const [sending, setSending] = useState(false)
  const [sendState, setSendState] = useState(null)
  const [matrixActive, setMatrixActive] = useState(false)
  const [matrixStatus, setMatrixStatus] = useState('')
  const [matrixSending, setMatrixSending] = useState(false)
  const [matrixSendState, setMatrixSendState] = useState(null)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const detectorCanvasRef = useRef(null)
  const detectorWorkerRef = useRef(null)
  const ourInFlightRef = useRef(false)
  const ourSeqRef = useRef(0)
  const ourSamplesRef = useRef([])
  const streamRef = useRef(null)
  const inFlightRef = useRef(false)
  const unavailableRef = useRef(false)
  const controllerRef = useRef(null)
  const mountedRef = useRef(true)

  // Read by the two sampling loops, which only depend on cameraStatus: a
  // selector change must affect the next frame, not restart an effect.
  const cameraSizeRef = useRef(DEFAULT_CAMERA_SIZE)
  const detectorEdgeRef = useRef(DEFAULT_DETECTOR_EDGE)
  const cvUploadEdgeRef = useRef(DEFAULT_CV_UPLOAD_EDGE)
  const cameraMaximumRef = useRef(null)
  const threadsGrantedRef = useRef(null)

  // The 10 s sweep accumulates here while both loops keep running unchanged.
  const sweepRef = useRef({
    active: false,
    startedAt: 0,
    cam: '',
    edge: DEFAULT_DETECTOR_EDGE,
    cvUpload: DEFAULT_CV_UPLOAD_EDGE,
    oursMs: [],
    oursStamps: [],
    cv: [],
  })
  const sweepTimerRef = useRef(null)
  const sweepIntervalRef = useRef(null)
  // Orchestration for "Run all & send". It drives the single-run machinery
  // below: each combination is one normal sweep whose finish resolves the
  // promise the matrix loop awaits. The token guards against a CV request that
  // began under the previous combination landing in the new window.
  const matrixRef = useRef({
    active: false,
    cancelled: false,
    internal: false,
    queue: [],
    index: 0,
    total: 0,
    collected: [],
  })
  const matrixPayloadRef = useRef(null)
  const matrixSendingRef = useRef(false)
  const sweepTokenRef = useRef(0)
  const ourSampleTokenRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      streamRef.current?.getTracks?.().forEach(track => track.stop())
      streamRef.current = null
      if (sweepTimerRef.current != null) window.clearTimeout(sweepTimerRef.current)
      if (sweepIntervalRef.current != null) window.clearInterval(sweepIntervalRef.current)
      sweepTimerRef.current = null
      sweepIntervalRef.current = null
      sweepRef.current.resolve?.(null)
      sweepRef.current.resolve = null
      matrixRef.current.cancelled = true
    }
  }, [])

  // Keep the displayed camera size current when applyConstraints renegotiates
  // the track; the media 'resize' event is the reliable signal for that.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined
    video.addEventListener('resize', updateResolvedCamera)
    return () => video.removeEventListener('resize', updateResolvedCamera)
  }, [])

  const updateResolvedCamera = () => {
    const video = videoRef.current
    if (video?.videoWidth && video?.videoHeight) {
      setCameraResolved(`${video.videoWidth} × ${video.videoHeight}`)
    }
  }

  // A settings change during a sweep ends that sweep: the line would otherwise
  // mix two configurations under one key.
  const cancelSweep = reason => {
    const run = sweepRef.current
    if (!run.active) return
    run.active = false
    if (sweepTimerRef.current != null) window.clearTimeout(sweepTimerRef.current)
    if (sweepIntervalRef.current != null) window.clearInterval(sweepIntervalRef.current)
    sweepTimerRef.current = null
    sweepIntervalRef.current = null
    setSweepActive(false)
    const resolve = run.resolve
    run.resolve = null
    resolve?.(null)
    const matrix = matrixRef.current
    if (matrix.active) {
      setMatrixStatus(
        `matrix cancelled (${reason}) — ${matrix.collected.length} run(s) kept; press Send results.`,
      )
    } else {
      setSweepStatus(`run cancelled (${reason}).`)
    }
  }

  // Abort the matrix but keep every run already collected: they are in the
  // results list, so the ordinary Send results button can still post them.
  const abortMatrix = reason => {
    const matrix = matrixRef.current
    if (!matrix.active || matrix.cancelled) return
    matrix.cancelled = true
    if (sweepRef.current.active) {
      cancelSweep(reason)
    } else {
      setMatrixStatus(
        `matrix cancelled (${reason}) — ${matrix.collected.length} run(s) kept; press Send results.`,
      )
    }
  }

  const cameraTarget = key => {
    const preset = CAMERA_SIZES.find(item => item.key === key) || CAMERA_SIZES[0]
    if (preset.width && preset.height) return { width: preset.width, height: preset.height }
    return cameraMaximumRef.current
  }

  // Renegotiate the live track, never the stream: the worker, ring and a running
  // sweep stay up. A rejected preference keeps the size that already works.
  const applyCameraSize = async key => {
    setCameraSizeKey(key)
    cameraSizeRef.current = key
    setCameraNote('')
    if (matrixRef.current.active) abortMatrix('camera changed')
    cancelSweep('camera changed')
    const track = streamRef.current?.getVideoTracks?.()[0]
    // Before Start there is no track: the selection is applied when it opens.
    if (!track) return
    if (!track.applyConstraints) {
      setCameraNote('size control unsupported')
      return
    }
    const target = cameraTarget(key)
    if (!target) {
      setCameraNote('capability max unknown — kept current')
      return
    }
    try {
      await track.applyConstraints({
        width: { ideal: target.width },
        height: { ideal: target.height },
      })
    } catch {
      setCameraNote('size change rejected — kept previous')
      return
    }
    updateResolvedCamera()
  }

  // Our detector input is a local frame-canvas decision: no worker restart.
  const changeDetectorEdge = edge => {
    const matrix = matrixRef.current
    if (matrix.active && !matrix.internal) abortMatrix('detector input changed')
    setDetectorEdge(edge)
    detectorEdgeRef.current = edge
    cancelSweep('input changed')
  }

  // The CV upload size only changes the next JPEG's long edge.
  const changeCvUploadEdge = edge => {
    const matrix = matrixRef.current
    if (matrix.active && !matrix.internal) abortMatrix('cv upload changed')
    setCvUploadEdge(edge)
    cvUploadEdgeRef.current = edge
    cancelSweep('cv upload changed')
  }

  const updateSweepStatus = () => {
    const run = sweepRef.current
    if (!run.active) return
    const left = Math.max(0, run.duration - (performance.now() - run.startedAt))
    const matrix = matrixRef.current
    if (matrix.active) {
      setMatrixStatus(
        `run ${matrix.index + 1}/${matrix.total} · in ${run.edge} · cv ${run.cvUpload} · `
          + `${(left / 1000).toFixed(1)} s left`,
      )
      return
    }
    setSweepStatus(
      `sampling — ${(left / 1000).toFixed(1)} s left at cam ${run.cam} · in ${run.edge} · cv ${run.cvUpload}`,
    )
  }

  const startSweep = (durationMs = SWEEP_DURATION_MS) => {
    const run = sweepRef.current
    if (cameraStatus !== 'live' || !streamRef.current || run.active) {
      return Promise.resolve(null)
    }
    const video = videoRef.current
    const token = (sweepTokenRef.current += 1)
    let resolve
    const done = new Promise(doneResolve => { resolve = doneResolve })
    sweepRef.current = {
      active: true,
      token,
      duration: durationMs,
      startedAt: performance.now(),
      cam: video?.videoWidth && video?.videoHeight ? `${video.videoWidth}×${video.videoHeight}` : '—',
      edge: detectorEdgeRef.current,
      cvUpload: cvUploadEdgeRef.current,
      oursMs: [],
      oursStamps: [],
      cv: [],
      resolve,
    }
    setSweepActive(true)
    if (!matrixRef.current.active) setSweepStatus('')
    updateSweepStatus()
    sweepIntervalRef.current = window.setInterval(updateSweepStatus, 200)
    sweepTimerRef.current = window.setTimeout(finishSweep, durationMs)
    return done
  }

  const finishSweep = () => {
    const run = sweepRef.current
    if (!run.active) return
    run.active = false
    if (sweepTimerRef.current != null) window.clearTimeout(sweepTimerRef.current)
    if (sweepIntervalRef.current != null) window.clearInterval(sweepIntervalRef.current)
    sweepTimerRef.current = null
    sweepIntervalRef.current = null
    setSweepActive(false)

    const msMedian = round1(median(run.oursMs))
    const perSecond = round1(rateFromStamps(run.oursStamps))
    const ours = msMedian == null && perSecond == null
      ? null
      : { msMedian, perSecond, detections: run.oursStamps.length }

    // Medians for the numeric CV telemetry; the last response for the
    // categorical fields (detection path, sharpness, found, resized).
    let cv = null
    if (run.cv.length) {
      const last = run.cv[run.cv.length - 1]
      const roundTrip = median(run.cv.map(sample => sample.roundTripMs))
      const detect = median(
        run.cv.map(sample => sample.detectMs).filter(value => value != null),
      )
      cv = {
        roundTripMs: roundTrip == null ? null : Math.round(roundTrip),
        detectMs: detect == null ? null : Math.round(detect * 100) / 100,
        detection: last.detection,
        sharpness: last.sharpness,
        found: last.found,
        resized: last.downscaled === true,
      }
    }

    const matrix = matrixRef.current
    if (!ours && !cv && !matrix.active) {
      setSweepStatus('no samples — keep the card in view and try again.')
      const resolve = run.resolve
      run.resolve = null
      resolve?.(null)
      return
    }

    const result = {
      cam: run.cam,
      edge: run.edge,
      cvUpload: run.cvUpload,
      ours,
      cv,
      at: new Date().toISOString(),
    }
    setResults(previous => {
      const index = previous.findIndex(
        entry => entry.cam === result.cam
          && entry.edge === result.edge
          && entry.cvUpload === result.cvUpload,
      )
      if (index < 0) return [...previous, result]
      const next = [...previous]
      next[index] = result
      return next
    })
    // The list changed, so an earlier send no longer covers it.
    setSendState(null)
    if (!matrix.active) {
      setSweepStatus(
        `recorded cam ${result.cam} · in ${result.edge} · cv ${result.cvUpload}. `
          + 'Run another combination to compare.',
      )
    }
    const resolve = run.resolve
    run.resolve = null
    resolve?.(result)
  }

  const runPayload = result => ({
    settings: { cam: result.cam, input: result.edge, cvUpload: result.cvUpload },
    ours: result.ours
      ? {
          msMedian: result.ours.msMedian,
          perSecond: result.ours.perSecond,
          detections: result.ours.detections,
        }
      : null,
    cv: result.cv
      ? {
          roundTripMs: result.cv.roundTripMs,
          detectMs: result.cv.detectMs,
          detection: result.cv.detection,
          sharpness: result.cv.sharpness,
          found: result.cv.found,
          resized: result.cv.resized,
        }
      : null,
    at: result.at,
  })

  const buildPayload = (runs, mode = '') => {
    const trimmed = label.trim()
    return {
      page: 'cv-live',
      ...(mode ? { mode } : {}),
      ...(trimmed ? { label: trimmed } : {}),
      device: {
        ua: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency || 1,
        isolated: window.crossOriginIsolated === true,
        threadsGranted: threadsGrantedRef.current,
      },
      runs: runs.map(runPayload),
    }
  }

  const postExperiment = async payload => {
    const response = await api.post(EXPERIMENTS_PATH, payload)
    return response.data?.id ?? null
  }

  const sendResults = async () => {
    if (sending || !results.length) return
    setSending(true)
    setSendState(null)
    try {
      const id = await postExperiment(buildPayload(results))
      setSendState({ tone: 'ok', text: id == null ? 'sent' : `sent · id ${id}` })
    } catch (error) {
      setSendState({
        tone: 'error',
        text: `send failed: ${getApiErrorMessage(error)} — press Retry send.`,
      })
    } finally {
      setSending(false)
    }
  }

  // The matrix posts exactly once, on completion. A failed post keeps the
  // payload so the retry button repeats the same request; the manual Send
  // results button above remains a separate path and never fires by itself.
  const postMatrixPayload = async () => {
    if (matrixSendingRef.current || !matrixPayloadRef.current) return
    matrixSendingRef.current = true
    setMatrixSending(true)
    setMatrixSendState(null)
    try {
      const id = await postExperiment(matrixPayloadRef.current)
      setMatrixSendState({ tone: 'ok', text: id == null ? 'sent' : `sent · id ${id}` })
    } catch (error) {
      setMatrixSendState({
        tone: 'error',
        text: `send failed: ${getApiErrorMessage(error)}`,
      })
    } finally {
      matrixSendingRef.current = false
      setMatrixSending(false)
    }
  }

  const autoSendMatrix = async () => {
    const matrix = matrixRef.current
    if (!matrix.collected.length) return
    matrixPayloadRef.current = buildPayload(matrix.collected, 'matrix')
    await postMatrixPayload()
  }

  const startMatrix = async () => {
    if (cameraStatus !== 'live' || sweepRef.current.active || matrixRef.current.active) return
    const combos = []
    for (const edge of MATRIX_INPUT_EDGES) {
      for (const cvUpload of MATRIX_CV_EDGES) combos.push({ edge, cvUpload })
    }
    const matrix = matrixRef.current
    matrix.active = true
    matrix.cancelled = false
    matrix.internal = false
    matrix.queue = combos
    matrix.index = 0
    matrix.total = combos.length
    matrix.collected = []
    matrixPayloadRef.current = null
    setMatrixActive(true)
    setMatrixSendState(null)
    setMatrixStatus('starting…')

    try {
      for (let i = 0; i < combos.length; i += 1) {
        if (!matrix.active || matrix.cancelled) break
        matrix.index = i
        const combo = combos[i]
        // Applying the settings is the matrix's own doing, so suppress the
        // user-change abort inside the setters.
        matrix.internal = true
        try {
          changeDetectorEdge(combo.edge)
          changeCvUploadEdge(combo.cvUpload)
        } finally {
          matrix.internal = false
        }
        if (!matrix.active || matrix.cancelled) break
        setMatrixStatus(
          `run ${i + 1}/${matrix.total} · in ${combo.edge} · cv ${combo.cvUpload} · `
            + `${(MATRIX_DURATION_MS / 1000).toFixed(1)} s left`,
        )
        const result = await startSweep(MATRIX_DURATION_MS)
        if (result) matrix.collected.push(result)
        if (!matrix.active || matrix.cancelled) break
      }
    } finally {
      const completed = matrix.active && !matrix.cancelled
      matrix.active = false
      matrix.internal = false
      setMatrixActive(false)
      if (completed) {
        if (matrix.collected.length) {
          setMatrixStatus(`matrix complete — ${matrix.collected.length} run(s).`)
          await autoSendMatrix()
        } else {
          setMatrixStatus('matrix finished with no samples — nothing to send.')
        }
      }
    }
  }

  const stopCamera = () => {
    abortMatrix('camera stopped')
    cancelSweep('camera stopped')
    controllerRef.current?.abort()
    controllerRef.current = null
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks?.().forEach(track => track.stop())
    if (videoRef.current) videoRef.current.srcObject = null
    inFlightRef.current = false
    setInFlight(false)
    setCameraStatus('idle')
    setQuad(null)
    setTelemetry(null)
    setNotice(null)
    // The detector effect tears down with cameraStatus; these keep the UI in
    // step if a result was already queued when the camera stopped.
    setOurQuad(null)
    setOurTelemetry(null)
    setOurStatus('idle')
    setCameraResolved('')
    setCameraNote('')
    cameraMaximumRef.current = null
  }

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('error')
      setCameraError('getUserMedia is unavailable in this browser.')
      return
    }
    stopCamera()
    unavailableRef.current = false
    setCameraError('')
    setCameraStatus('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })
      if (!mountedRef.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try {
          await videoRef.current.play()
        } catch {
          // Autoplay can be refused; the stream is still attached to the element.
        }
      }
      const track = stream.getVideoTracks()[0]
      if (track) {
        track.onended = () => {
          if (!mountedRef.current) return
          abortMatrix('camera ended')
          cancelSweep('camera ended')
          setCameraStatus('error')
          setCameraError('The camera stream ended.')
        }
      }
      // Ask the track for its capability maximum, then apply the selected preset:
      // 'max' is the capability maximum, and the start request only used ideals.
      let capabilities = {}
      try { capabilities = track?.getCapabilities?.() || {} } catch { capabilities = {} }
      const maxWidth = typeof capabilities.width?.max === 'number' ? capabilities.width.max : null
      const maxHeight = typeof capabilities.height?.max === 'number' ? capabilities.height.max : null
      cameraMaximumRef.current = maxWidth && maxHeight ? { width: maxWidth, height: maxHeight } : null
      setCameraNote('')
      const initial = cameraTarget(cameraSizeRef.current)
      if (initial && track?.applyConstraints) {
        try {
          await track.applyConstraints({
            width: { ideal: initial.width },
            height: { ideal: initial.height },
          })
        } catch {
          setCameraNote('size change rejected — kept previous')
        }
      }
      updateResolvedCamera()
      setCameraStatus('live')
    } catch (error) {
      const name = error?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') setCameraStatus('denied')
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') setCameraStatus('no-camera')
      else setCameraStatus('error')
      setCameraError(error?.message || String(error))
    }
  }

  // Poll while the camera is live and the tab is visible. One request at a time:
  // a tick that finds a request in flight returns immediately, so a slow server
  // drops frames instead of building a queue. Hiding the tab clears the timer.
  useEffect(() => {
    if (cameraStatus !== 'live') return undefined
    let stopped = false
    let timer = null

    const tick = async () => {
      if (stopped || inFlightRef.current || unavailableRef.current) return
      const video = videoRef.current
      if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return
      const track = streamRef.current?.getVideoTracks?.()[0]
      if (track && track.readyState !== 'live') return
      const canvas = canvasRef.current
      if (!canvas) return

      inFlightRef.current = true
      setInFlight(true)
      // The token of the run that owns this frame. A response whose request
      // began before the current combination started is discarded, so a frame
      // encoded with the previous upload edge cannot land in the new window.
      const requestToken = sweepRef.current.token
      let controller = null
      try {
        const scale = Math.min(1, cvUploadEdgeRef.current / Math.max(video.videoWidth, video.videoHeight))
        const width = Math.max(1, Math.round(video.videoWidth * scale))
        const height = Math.max(1, Math.round(video.videoHeight * scale))
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
        canvas.getContext('2d').drawImage(video, 0, 0, width, height)

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
        if (stopped || !mountedRef.current) return
        if (!blob) throw new Error('The camera frame could not be encoded.')

        controller = new AbortController()
        controllerRef.current = controller
        const form = new FormData()
        form.append('image', blob, 'frame.jpg')
        const requestStarted = performance.now()
        const response = await api.post(CV_DETECT_PATH, form, {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: REQUEST_TIMEOUT_MS,
          signal: controller.signal,
        })
        if (stopped || !mountedRef.current) return

        const result = readDetection(response.data)
        const roundTripMs = Math.round(performance.now() - requestStarted)
        setTelemetry({
          roundTripMs,
          detectMs: result.detectMs,
          detection: result.detection,
          sharpness: result.sharpness,
          downscaled: result.downscaled,
        })
        const sweepRun = sweepRef.current
        if (sweepRun.active && sweepRun.token === requestToken) {
          sweepRun.cv.push({
            roundTripMs,
            detectMs: result.detectMs,
            detection: result.detection,
            sharpness: result.sharpness,
            found: result.found,
            downscaled: result.downscaled,
          })
        }
        if (!result.found || !result.corners) {
          setQuad(null)
          setNotice({ tone: 'muted', text: 'No card seen in the last frame.' })
        } else {
          setQuad(result.corners)
          setNotice(null)
        }
      } catch (error) {
        if (stopped || !mountedRef.current) return
        if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return
        const status = error?.response?.status
        if (status === 503) {
          unavailableRef.current = true
          setQuad(null)
          setNotice({ tone: 'error', text: 'CollectorVision is not available on this server.' })
        } else if (status === 404) {
          unavailableRef.current = true
          setQuad(null)
          setNotice({ tone: 'error', text: 'The capture lab is not enabled on this server.' })
        } else {
          setNotice({ tone: 'error', text: `Detection request failed: ${getApiErrorMessage(error)}` })
        }
      } finally {
        // Only the request that still owns the controller may clear the guard:
        // a stop-and-restart can leave an aborted request unwinding while a new
        // one is already in flight, and clearing it then would allow an overlap.
        const ownsFlight = controller != null
          ? controllerRef.current === controller
          : controllerRef.current == null
        if (ownsFlight) {
          controllerRef.current = null
          inFlightRef.current = false
          if (!stopped && mountedRef.current) setInFlight(false)
        }
      }
    }

    const sync = () => {
      if (document.visibilityState === 'visible') {
        if (timer != null) return
        tick()
        timer = setInterval(tick, POLL_INTERVAL_MS)
      } else if (timer != null) {
        clearInterval(timer)
        timer = null
      }
    }

    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', sync)
      if (timer != null) clearInterval(timer)
    }
  }, [cameraStatus])

  // Our detector runs beside the CV poll on its own 400 ms interval. It reuses
  // the existing worker (init/detect with a serial queue) rather than the
  // CaptureLab loop, so only a raw quad is drawn: no tracker or smoothing.
  // The in-flight guard means a slow inference skips ticks instead of queueing
  // frames, and the worker's seq is checked so a stale result cannot repaint.
  useEffect(() => {
    if (cameraStatus !== 'live') return undefined
    let stopped = false
    let ready = false
    let worker = null
    let bootstrapUrl = ''
    let timer = null

    ourInFlightRef.current = false
    ourSeqRef.current = 0
    ourSamplesRef.current = []
    setOurQuad(null)
    setOurTelemetry(null)
    setOurStatus('loading')

    // Copied from CaptureLab.jsx loadDetector (lines 1244-1257): the worker is
    // started from a blob so it inherits the document's CSP rather than a
    // cached asset's headers, which would otherwise block the detector's wasm.
    try {
      const moduleUrl = new URL('../workers/cardDetector.worker.js', import.meta.url)
      bootstrapUrl = URL.createObjectURL(
        new Blob([`import ${JSON.stringify(moduleUrl.href)}`], { type: 'text/javascript' }),
      )
      worker = new Worker(bootstrapUrl, { type: 'module' })
    } catch {
      setOurStatus('unavailable')
      return () => {
        if (bootstrapUrl) URL.revokeObjectURL(bootstrapUrl)
      }
    }
    detectorWorkerRef.current = worker

    const tick = async () => {
      if (stopped || !ready || ourInFlightRef.current) return
      if (detectorWorkerRef.current !== worker) return
      const video = videoRef.current
      if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return
      const track = streamRef.current?.getVideoTracks?.()[0]
      if (track && track.readyState !== 'live') return
      const canvas = detectorCanvasRef.current
      if (!canvas) return

      const scale = Math.min(1, detectorEdgeRef.current / Math.max(video.videoWidth, video.videoHeight))
      const width = Math.max(1, Math.round(video.videoWidth * scale))
      const height = Math.max(1, Math.round(video.videoHeight * scale))
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height

      ourInFlightRef.current = true
      const seq = (ourSeqRef.current += 1)
      let bitmap = null
      try {
        canvas.getContext('2d').drawImage(video, 0, 0, width, height)
        bitmap = await createImageBitmap(canvas)
        if (stopped || detectorWorkerRef.current !== worker) {
          bitmap.close?.()
          ourInFlightRef.current = false
          return
        }
        ourSampleTokenRef.current = sweepRef.current.token
        worker.postMessage({ type: 'detect', bitmap, seq }, [bitmap])
        bitmap = null
      } catch {
        bitmap?.close?.()
        ourInFlightRef.current = false
      }
    }

    worker.onmessage = event => {
      if (stopped || detectorWorkerRef.current !== worker) return
      const message = event.data || {}
      if (message.type === 'ready') {
        ready = true
        if (Number.isFinite(message.threads)) threadsGrantedRef.current = message.threads
        setOurStatus('ready')
        return
      }
      if (message.type === 'result') {
        ourInFlightRef.current = false
        if (message.seq !== ourSeqRef.current) return
        const corners = Array.isArray(message.corners) && message.corners.length === 4
          ? message.corners
          : null
        setOurQuad(corners)
        // runMs is the model run itself, the same number the standalone page's
        // A/B records; fall back to the whole detect time if it is absent.
        const inferenceMs = Number.isFinite(message.detectParts?.runMs)
          ? message.detectParts.runMs
          : Number.isFinite(message.ms) ? message.ms : null
        if (inferenceMs != null) {
          ourSamplesRef.current = [...ourSamplesRef.current, inferenceMs]
            .slice(-OURS_MEDIAN_WINDOW)
        }
        const sweepRun = sweepRef.current
        if (sweepRun.active && sweepRun.token === ourSampleTokenRef.current) {
          if (inferenceMs != null) sweepRun.oursMs.push(inferenceMs)
          sweepRun.oursStamps.push(performance.now())
        }
        setOurTelemetry(previous => ({
          inferenceMs: median(ourSamplesRef.current),
          detections: (previous?.detections || 0) + 1,
        }))
        return
      }
      if (message.type === 'error') {
        ourInFlightRef.current = false
        // A missing model or a CSP-blocked wasm runtime fails during init and
        // carries no seq. The page exists for the CV overlay, so degrade the
        // line instead of showing an error page.
        if (message.seq == null) {
          ready = false
          setOurStatus('unavailable')
          setOurQuad(null)
          setOurTelemetry(null)
        }
      }
    }
    worker.onerror = () => {
      if (stopped || detectorWorkerRef.current !== worker) return
      ready = false
      setOurStatus('unavailable')
      setOurQuad(null)
      setOurTelemetry(null)
    }
    // The worker runs from a blob, where root-relative URLs cannot be resolved.
    worker.postMessage({ type: 'init', runtime: OURS_RUNTIME, assetBase: window.location.origin })
    timer = setInterval(tick, OURS_INTERVAL_MS)

    return () => {
      stopped = true
      if (timer != null) clearInterval(timer)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      if (detectorWorkerRef.current === worker) detectorWorkerRef.current = null
      if (bootstrapUrl) URL.revokeObjectURL(bootstrapUrl)
      ourInFlightRef.current = false
      ourSamplesRef.current = []
      setOurQuad(null)
      setOurTelemetry(null)
      setOurStatus('idle')
    }
  }, [cameraStatus])

  const cameraMessage = {
    requesting: 'Requesting camera…',
    denied: 'Camera permission was denied. Allow camera access in the browser and retry.',
    'no-camera': 'No camera was found. Open this page on the phone that has one.',
    error: `The camera could not start${cameraError ? `: ${cameraError}` : '.'}`,
  }[cameraStatus]

  const noticeClass = notice?.tone === 'error'
    ? 'text-brand-red'
    : notice?.tone === 'muted' ? 'text-text-muted' : 'text-text-secondary'

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-xl font-semibold text-text-primary">CollectorVision live</h1>
          <Link to="/capture-lab" className="btn-ghost-sm">Capture lab</Link>
        </div>
        <p className="mt-1 text-sm text-text-secondary">
          Dev-only: CollectorVision&apos;s card boundary over the live camera, refreshed about
          every 800 ms, and our own detector&apos;s boundary in green, refreshed about every
          400 ms. Amber is CollectorVision; green is ours.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          {cameraStatus === 'live' ? (
            <button type="button" className="btn-ghost-sm" onClick={stopCamera}>
              <VideoOff size={15} aria-hidden />
              Stop camera
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary-sm"
              disabled={cameraStatus === 'requesting'}
              onClick={startCamera}
            >
              <Camera size={15} aria-hidden />
              Start camera
            </button>
          )}
          {['denied', 'no-camera', 'error'].includes(cameraStatus) ? (
            <button type="button" className="btn-ghost-sm" onClick={startCamera}>
              <RefreshCw size={15} aria-hidden />
              Retry
            </button>
          ) : null}
          {inFlight ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs" style={{ color: CV_STROKE }}>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: CV_STROKE }} />
              request in flight
            </span>
          ) : null}
        </div>

        {cameraMessage ? <p className="mt-2 text-xs text-text-secondary">{cameraMessage}</p> : null}

        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <label className="text-xs text-text-muted">
            Camera size
            <select
              className="select-sm mt-1 w-auto"
              value={cameraSizeKey}
              onChange={event => void applyCameraSize(event.target.value)}
            >
              {CAMERA_SIZES.map(preset => (
                <option key={preset.key} value={preset.key}>{preset.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            Our detector input
            <select
              className="select-sm mt-1 w-auto"
              value={detectorEdge}
              onChange={event => changeDetectorEdge(Number(event.target.value))}
            >
              {DETECTOR_EDGES.map(edge => (
                <option key={edge} value={edge}>{edge}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-text-muted">
            CV upload size
            <select
              className="select-sm mt-1 w-auto"
              value={cvUploadEdge}
              onChange={event => changeCvUploadEdge(Number(event.target.value))}
            >
              {CV_UPLOAD_EDGES.map(edge => (
                <option key={edge} value={edge}>{edge}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-ghost-sm"
            disabled={cameraStatus !== 'live' || sweepActive || matrixActive}
            onClick={() => void startSweep()}
          >
            {sweepActive ? 'Sampling…' : 'Run 10 s sweep'}
          </button>
          <p className="pb-1 text-xs text-text-secondary">
            camera (resolved) {cameraResolved || '—'}{cameraNote ? ` · ${cameraNote}` : ''}
          </p>
        </div>

        <div className="mt-3 flex justify-center overflow-hidden rounded bg-black">
          <div className="relative block w-full">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={updateResolvedCamera}
              className={`block h-auto w-full rounded bg-black object-contain ${cameraStatus === 'live' ? '' : 'hidden'}`}
            />
            {cameraStatus !== 'live' ? (
              <div className="flex h-64 w-full items-center justify-center text-sm text-text-muted">
                Camera not started
              </div>
            ) : null}
            {cameraStatus === 'live' && quad ? (
              <>
                <svg
                  viewBox="0 0 1 1"
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  aria-hidden
                >
                  <polygon
                    points={quad.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none"
                    stroke={CV_STROKE}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                <span
                  className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: CV_STROKE }}
                >
                  CollectorVision
                </span>
              </>
            ) : null}
            {cameraStatus === 'live' && ourQuad ? (
              <>
                <svg
                  viewBox="0 0 1 1"
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  aria-hidden
                >
                  <polygon
                    points={ourQuad.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none"
                    stroke={OURS_STROKE}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                <span
                  className="pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: OURS_STROKE }}
                >
                  ours
                </span>
              </>
            ) : null}
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden" aria-hidden />
        <canvas ref={detectorCanvasRef} className="hidden" aria-hidden />

        <div className="mt-2 space-y-0.5 text-xs text-text-secondary">
          <p>{formatTelemetry(telemetry)}</p>
          <p>{formatOurTelemetry(ourStatus, ourTelemetry)}</p>
        </div>
        {notice ? <p className={`mt-1 text-xs ${noticeClass}`}>{notice.text}</p> : null}
      </section>

      <section className="rounded-lg border border-border bg-bg-card p-4">
        <h2 className="text-sm font-semibold text-text-primary">Run all &amp; send</h2>
        <p className="mt-1 text-xs text-text-secondary">
          Runs every combination once — detector input 320 / 480 / 640 × CV upload
          960 / 1280 at the current camera size, 8 s each (6 runs, about 48 s) — then
          posts the whole set once with mode matrix. Stop keeps the runs collected so
          far, and Send results still posts them. A sample whose CV request began before
          the current combination is discarded rather than credited to it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary-sm"
            disabled={cameraStatus !== 'live' || sweepActive || matrixActive || matrixSending}
            onClick={() => void startMatrix()}
          >
            {matrixActive ? 'Running matrix…' : 'Run all & send'}
          </button>
          {matrixActive ? (
            <button type="button" className="btn-ghost-sm" onClick={() => abortMatrix('stopped')}>
              Stop
            </button>
          ) : null}
          {matrixStatus ? <p className="text-xs text-text-secondary">{matrixStatus}</p> : null}
        </div>
        {matrixSendState ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className={`text-xs ${matrixSendState.tone === 'error' ? 'text-brand-red' : 'text-text-secondary'}`}>
              {matrixSendState.text}
            </p>
            {matrixSendState.tone === 'error' ? (
              <button
                type="button"
                className="btn-ghost-sm"
                disabled={matrixSending}
                onClick={() => void postMatrixPayload()}
              >
                {matrixSending ? 'Sending…' : 'Retry send'}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-bg-card p-4">
        <h2 className="text-sm font-semibold text-text-primary">Sweep results</h2>
        <p className="mt-1 text-xs text-text-secondary">
          A 10 s sweep records our median inference and detections/s from the green pass,
          and the CV half&apos;s median round trip and server detect time, with the last
          detection path, sharpness, found and resized of the window. Lines are keyed by
          cam · in · cv, so rerunning a combination replaces it. Results survive Stop/Start,
          and nothing is uploaded until you press Send results (matrix runs are 8 s and
          appear in this list too).
        </p>
        {sweepStatus ? <p className="mt-2 text-xs text-text-secondary">{sweepStatus}</p> : null}
        {results.length ? (
          <ol className="mt-2 space-y-1 font-mono text-[11px] leading-relaxed text-text-secondary">
            {results.map(result => (
              <li key={`${result.cam}|${result.edge}|${result.cvUpload}`}>
                {formatResultLine(result)}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-xs text-text-muted">No sweeps recorded yet.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <label className="text-xs text-text-muted">
            Label (optional)
            <input
              type="text"
              maxLength={120}
              value={label}
              onChange={event => setLabel(event.target.value)}
              className="input mt-1 w-48"
              placeholder="e.g. pixel 8, outdoor"
            />
          </label>
          <button
            type="button"
            className="btn-primary-sm"
            disabled={sending || !results.length}
            onClick={() => void sendResults()}
          >
            {sending ? 'Sending…' : sendState?.tone === 'error' ? 'Retry send' : 'Send results'}
          </button>
          {sendState ? (
            <p className={`text-xs ${sendState.tone === 'error' ? 'text-brand-red' : 'text-text-secondary'}`}>
              {sendState.text}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  )
}
