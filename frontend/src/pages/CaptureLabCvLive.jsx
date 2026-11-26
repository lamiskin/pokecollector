import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Camera, RefreshCw, VideoOff } from 'lucide-react'
import api, { getApiErrorMessage } from '../api/client'

// Dev-only comparison page: it draws CollectorVision's live card boundary over
// the camera preview so it can be compared with our detector on the same phone.
// Nothing is captured, stored or sent to the scanner.
//
// CollectorVision is amber; our detector's existing live overlay is green
// (#22c55e). This page deliberately does not re-implement the detector/tracker
// loop from CaptureLab, so only the amber boundary is drawn here.

const POLL_INTERVAL_MS = 800
const REQUEST_TIMEOUT_MS = 15000
const MAX_FRAME_EDGE = 1280
const JPEG_QUALITY = 0.8
const CV_STROKE = '#f59e0b'
const CV_DETECT_PATH = '/capture-lab/cv-detect'

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
  const downscaled = typeof data.downscaled === 'boolean'
    ? data.downscaled
    : typeof data.frame?.downscaled === 'boolean'
      ? data.frame.downscaled
      : null
  return {
    corners: normalizeQuad(rawQuad, frame),
    detection,
    sharpness,
    downscaled,
    found: data.found !== false,
  }
}

function formatTelemetry(telemetry) {
  if (!telemetry) return 'No frame sent yet.'
  return [
    telemetry.roundTripMs == null ? 'round trip —' : `round trip ${telemetry.roundTripMs} ms`,
    `detection ${telemetry.detection || '—'}`,
    `sharpness ${telemetry.sharpness == null ? '—' : telemetry.sharpness.toFixed(3)}`,
    telemetry.downscaled == null
      ? 'downscaled unknown'
      : telemetry.downscaled ? 'downscaled yes' : 'downscaled no',
  ].join(' · ')
}

export default function CaptureLabCvLive() {
  const [cameraStatus, setCameraStatus] = useState('idle')
  const [cameraError, setCameraError] = useState('')
  const [quad, setQuad] = useState(null)
  const [telemetry, setTelemetry] = useState(null)
  const [inFlight, setInFlight] = useState(false)
  const [notice, setNotice] = useState(null)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const inFlightRef = useRef(false)
  const unavailableRef = useRef(false)
  const controllerRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      streamRef.current?.getTracks?.().forEach(track => track.stop())
      streamRef.current = null
    }
  }, [])

  const stopCamera = () => {
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
          setCameraStatus('error')
          setCameraError('The camera stream ended.')
        }
      }
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
      let controller = null
      try {
        const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(video.videoWidth, video.videoHeight))
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
        setTelemetry({
          roundTripMs: Math.round(performance.now() - requestStarted),
          detection: result.detection,
          sharpness: result.sharpness,
          downscaled: result.downscaled,
        })
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
          every 800 ms. The amber outline is CollectorVision; our own detector&apos;s boundary is
          not drawn on this page.
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

        <div className="mt-3 flex justify-center overflow-hidden rounded bg-black">
          <div className="relative block w-full">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
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
          </div>
        </div>

        <canvas ref={canvasRef} className="hidden" aria-hidden />

        <p className="mt-2 text-xs text-text-secondary">
          {formatTelemetry(telemetry)}
        </p>
        {notice ? <p className={`mt-1 text-xs ${noticeClass}`}>{notice.text}</p> : null}
      </section>
    </main>
  )
}
