import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Check, Download, Eye, EyeOff, ImagePlus, Loader2, RefreshCw, Save, ScanLine, Trash2, VideoOff, Volume2, VolumeX, X } from 'lucide-react'
import api, {
  deleteCaptureLabEntry,
  enqueueScanJob,
  fetchCaptureLabFileBlob,
  listCaptureLabEntries,
  uploadCaptureLabDiagnostics,
  uploadCaptureLabImage,
} from '../api/client'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { useSettings } from '../contexts/SettingsContext'
import CaptureOverlay from '../components/CaptureOverlay'
import CaptureDock from '../components/CaptureDock'
import TrayItemSheet from '../components/TrayItemSheet'
import {
  TRAY_CAPACITY,
  buildCaptureGeometry,
  buildTraySubmission,
  latestUnsentItem,
  nextRotationCW,
  normalizeRotation,
  sortTrayItems,
} from '../utils/captureTray'
import {
  isCaptureSoundEnabled,
  playCaptureSuccess,
  primeCaptureAudio,
  setCaptureSoundEnabled,
} from '../utils/captureSound'
import { quadAreaFraction } from '../utils/perspectiveWarp'
import {
  signatureDistance,
  signatureOf,
  nextRearmStreak,
  shouldRearmByChange,
  REARM_CHANGED_COOLDOWN_MS,
  REARM_SIGNATURE_DIFF,
} from '../utils/patchSignature'
import {
  cornerAgreement,
  createTracker,
  derivePhase,
  evaluateTentative,
  FIRST_TRACK_RADIUS,
  framingPresence,
  isCorroborated,
  CAPTURE_QUAD_MAX_AGE_MS,
  isContainableQuad,
  MAX_AREA_RATIO,
  MAX_FRAME_MOVE,
  MAX_PATCH_MSE_FLOOR,
  MIN_AREA_RATIO,
  PATCH_RADIUS,
  PATCH_VARIANCE_RATIO,
  SEARCH_RADIUS,
  shouldAcceptCapture,
  shouldKeepTracking,
  trackerFallbackEligible,
  TENTATIVE_CONFIRM_TRACKS,
  TENTATIVE_MAX_MISSES,
  TRACKER_FALLBACK_HITS,
  TRACK_AGREE_MAX,
  TRACK_KEEP_MS,
  TRACK_LOST_AFTER,
  TRACK_MAX_EDGE,
  TRACK_MAX_MISSES,
  TRACK_PHASE_MAX_AGE_MS,
} from '../utils/cornerTracker'
import {
  autoHoldDecision,
  AUTO_STABLE_GAP_MS,
  AUTO_STEP_DT_MAX_MS,
  AUTO_STEP_SPEED,
  AUTO_TOTAL_MOVE,
} from '../utils/autoHold'
import { computeMotionScore, toGrayscale } from '../utils/webcamStability'
import { edgeVariance, toGrayscale as toFocusGrayscale } from '../utils/focusScore'

// Dev-only tool: lab-specific strings stay in English on purpose, while shared
// actions reuse the existing translated keys. It is never shown in navigation.
const CONDITIONS = ['Bare card', 'Penny sleeve', 'Top loader', 'Holo or foil', 'Dark art', 'Dim room']
const ROUTES = ['Phone browser', 'Phone native', 'Other']
const RESOLUTION_PRESETS = [
  { id: 'default', label: 'Camera maximum', width: 1920, height: 1080 },
  { id: 'high', label: 'High (1920×2560)', width: 1920, height: 2560 },
  { id: 'max', label: 'Max (4000×3000)', width: 4000, height: 3000 },
]
const CAPTURE_LAB_QUERY_KEY = ['capture-lab', 'entries']
const CAPTURE_POLICY_STORAGE_KEY = 'capture-lab-capture-policy'

// Live-detection recording: two seconds per sample, three minutes of ring
// buffer, and a small JPEG every fifth sample for a visual cross-check.
const DIAG_SAMPLE_MS = 2000
const DIAG_MAX_SAMPLES = 90
const DIAG_SNAPSHOT_EVERY = 5
const DIAG_MAX_EVENTS = 400
// Keep the POST comfortably inside the backend's 8 MiB limit.
const DIAG_MAX_PAYLOAD_BYTES = 6 * 1024 * 1024
const DIAG_SNAPSHOT_EDGE = 320

// Full-frame live detection is downscaled to this long edge before the model's
// own 384×384 squash; full-resolution bitmaps are expensive on phones.
const LIVE_MAX_EDGE = 640
const LIVE_MIN_INTERVAL_MS = 120
// When hunting for a new card there is no tracker to carry the outline, so run
// the next detection as soon as inference finishes plus a small gap.
const HUNT_GAP_MS = 120
// While no card is found and the scene is still, stop hammering the detector.
// This is a load/heat reduction, not a fix for the phone's thermal limits.
const HUNT_BACKOFF_MS = 8000
const HUNT_BACKOFF_GAP_MS = 1200
// After a capture, look for the next card while the user is still panning.
const CAPTURE_HUNT_DELAY_MS = 150
const LIVE_SEQ_BASE = 1_000_000
// Capture waits at most this long for a video frame newer than the last one it
// used; a frozen feed must not be captured twice or reported as success.
const CAPTURE_FRAME_WAIT_MS = 200
// The crop is taken from the native frame around the card, not the whole frame.
// Bound staging memory while retaining high-resolution card photos.
const CAPTURE_SOURCE_MAX_EDGE = 3200
// Shared by capture and the re-arm signature so both compare the same region.
const CAPTURE_BOX_PAD_FRACTION = 0.12
// One bounded retry after a stale geometry result: request a fresh detection
// and try the capture again when it lands.
const CAPTURE_RETRY_MS = 900
// A tracker fallback must be backed by a recent agreeing detector result and no
// recent dispute; these are deliberately tighter than "last usable".
const CAPTURE_DISAGREE_MS = 1500
const CAPTURE_AGREE_MS = 3000
// Candidate validation for automatic captures.
const CAPTURE_EDGE_MIN = 0.015
const CAPTURE_ASPECT_MIN = 0.55
const CAPTURE_ASPECT_MAX = 0.85
const CAPTURE_LOW_DETAIL = 200
// Confidence pulse after an accepted model result. The overlay turns the pulse
// into one eased lock strength for the ring, so this only has to be long enough
// for consecutive detections to overlap, not a visible state of its own.
const CONFIRM_PULSE_MS = 300
// A new presentation changes the picture inside the tracked quad even while the
// geometry barely moves. Two consecutive checks above this difference re-arm.
const REARM_CHECK_INTERVAL_MS = 250
// A tracker whose last success is older than this is treated as gone when a
// usable model result arrives, so it cannot block the model capture path.
const TRACK_STALE_RESET_MS = 2000

// Inference costs ~0.3 s on the target phone, so the loop skips it while the
// scene is static and no card is tracked. This is about battery and heat, not
// latency: motion is sampled cheaply at 128 px, with a heartbeat detection so a
// slowly appearing card is still found.
const MOTION_SAMPLE_SIZE = 128
const MOTION_SAMPLE_INTERVAL_MS = 100
// Mean grayscale delta (0-255) below which the scene counts as static, matching
// the scanner's existing stability default.
const IDLE_MOTION_THRESHOLD = 10
const IDLE_HEARTBEAT_MS = 2000

// 63:88 card aspect at a 1600 px long edge.

// Automatic capture must never send the scanner a card that occupies less of
// the frame than a deliberate phone photo would.
const MIN_CARD_AREA = 0.12

// Auto-capture stability heuristic. Detection rate is device-dependent (~1 fps
// on the target Android phone), so a frame count would mean very different waits
// on different phones; this is wall-clock. The window must stay open for
// AUTO_STABLE_MS, then auto-capture disarms until the quad has been absent for
// AUTO_REARM_MS. Whether the window stays open is decided per observation in
// autoHold.js against a median of the last 500 ms: tremor and single tracker
// corrections are normal, sustained movement cancels.
// Internal settle trial: 400 ms instead of 800. Compare on a real phone before
// keeping it; the capture path and hold decision use this constant.
const AUTO_STABLE_MS = 400
// The hold window is wall-clock, but the capture must not wait for the next
// model result: detection is device-dependent (~1 s here), so that would add
// up to a second of dead time after the user has already held long enough.
const AUTO_FIRE_CHECK_MS = 100
const AUTO_REARM_MS = 800
// Auto-capture stability may follow the tracker for up to this long between
// model results. Separate from capture geometry freshness so changing capture
// rules cannot silently change the hold rule.
const AUTO_TRACK_OBS_MAX_AGE_MS = 1500
// How long the overlay's success beat stays on screen; the overlay itself fades
// the ring inside this window, so it only needs to outlive that animation.
const CAPTURE_BEAT_MS = 230

// Every capture attempt (automatic fire or manual tap) is kept in memory for the
// session outcome panel and the POSTed session report. Oldest go first.
const ATTEMPT_LOG_LIMIT = 200

// Which gates each policy actually applies. The quad policy keeps the historical
// full set; the framing policy keeps freshness, presence, edge containment, size
// and the stability hold, and drops only the aspect heuristic and the separate
// detector-corroboration requirement. Manual capture keeps the quad geometry
// gates but never requires corroboration, area or a hold.
const POLICY_GATES = {
  quad: [
    'fresh-geometry',
    'edge-containment',
    'aspect',
    'corroboration',
    'min-area',
    'stability-hold',
  ],
  framing: [
    'fresh-geometry',
    'presence',
    'edge-containment',
    'min-area',
    'stability-hold',
  ],
}

function gatesAppliedFor(policy, trigger) {
  // Manual capture keeps today's behaviour: it only enforces fresh geometry and
  // falls back to the full frame when that refuses, so it never claims the
  // automatic policy's gates.
  if (trigger === 'manual') return ['fresh-geometry']
  return [...(POLICY_GATES[policy] || POLICY_GATES.quad)]
}

// The pill owns the copy for the two containment causes; every other refusal is
// an internal reason with no dedicated pill string, so it is recorded as-is.
const REFUSAL_PILL_TEXT = {
  aspect: 'Show the whole card',
  edge: 'Move the card away from the edge',
  rechecking: 'Checking the card…',
}

function refusalReasonText(reason) {
  return REFUSAL_PILL_TEXT[reason] || reason
}

// Per-side padding actually left around the card in the delivered crop, plus
// whether the padded box was large enough to contain every corner unclipped.
function regionCheckFor(corners, acquisition) {
  const frameWidth = acquisition?.frameWidth
  const frameHeight = acquisition?.frameHeight
  const box = acquisition?.sourceRect
  if (!corners || corners.length !== 4 || !box || !frameWidth || !frameHeight) return null
  const xs = corners.map(([x]) => x * frameWidth)
  const ys = corners.map(([, y]) => y * frameHeight)
  const quadMinX = Math.min(...xs)
  const quadMaxX = Math.max(...xs)
  const quadMinY = Math.min(...ys)
  const quadMaxY = Math.max(...ys)
  const boxWidth = Math.max(1, quadMaxX - quadMinX)
  const boxHeight = Math.max(1, quadMaxY - quadMinY)
  return {
    quadInsideBox: quadMinX >= box.x && quadMaxX <= box.x + box.width
      && quadMinY >= box.y && quadMaxY <= box.y + box.height,
    boxPaddingFraction: {
      left: Number(((quadMinX - box.x) / boxWidth).toFixed(4)),
      top: Number(((quadMinY - box.y) / boxHeight).toFixed(4)),
      right: Number(((box.x + box.width - quadMaxX) / boxWidth).toFixed(4)),
      bottom: Number(((box.y + box.height - quadMaxY) / boxHeight).toFixed(4)),
    },
  }
}

// Compare the delivered crop against the last staged capture's signature. The
// signature is the existing patchSignature one; similarity is 1 - its distance,
// clamped to 0..1, and a duplicate is the existing re-arm threshold on distance.
function appearanceAgainstLast(canvas, lastSignature) {
  if (!canvas) return { similarity: null, duplicate: null, signature: null }
  let signature = null
  try {
    signature = signatureOf(canvas, 0, 0, canvas.width, canvas.height)
  } catch {
    signature = null
  }
  if (!signature) return { similarity: null, duplicate: null, signature: null }
  // The first staged capture has nothing to compare against, but its signature
  // still becomes the baseline for the next one.
  if (!lastSignature) return { similarity: null, duplicate: null, signature }
  const distance = signatureDistance(lastSignature, signature)
  if (!Number.isFinite(distance)) return { similarity: null, duplicate: null, signature }
  return {
    similarity: Number(Math.max(0, Math.min(1, 1 - distance)).toFixed(4)),
    duplicate: distance <= REARM_SIGNATURE_DIFF,
    signature,
  }
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function errorMessage(error) {
  return error?.response?.data?.detail || error?.message || 'Request failed'
}

function scanUploadPercent(progress) {
  if (progress?.phase === 'upload' && progress.total) {
    return Math.round((progress.loaded / progress.total) * 100)
  }
  return 0
}

function scanErrorMessage(error) {
  const detail = error?.response?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  if (detail != null) {
    try {
      return JSON.stringify(detail)
    } catch {
      return String(detail)
    }
  }
  return error?.message || 'Scan job could not be submitted.'
}

function verificationTone(delta) {
  if (!Number.isFinite(delta)) return 'text-brand-red'
  if (delta <= 0.01) return 'text-green'
  if (delta <= 0.02) return 'text-yellow'
  return 'text-brand-red'
}

const DETECTOR_RUNTIME_LABELS = {
  asyncify: 'asyncify',
  wasm: 'plain simd',
  webgpu: 'webgpu (experimental)',
}

const LIVE_STATE_LABELS = {
  tracking: 'tracking',
  moving: 'moving',
  idle: 'idle — no card',
}

function newAutoState() {
  return {
    anchorCorners: null,
    anchorTs: null,
    lastCorners: null,
    lastQualifyingTs: null,
    lastSource: 'tracked',
    disarmed: false,
    absentSince: null,
  }
}

function readDimensions(previewUrl, onSize) {
  const probe = new Image()
  probe.onload = () => onSize(probe.naturalWidth, probe.naturalHeight)
  probe.onerror = () => onSize(null, null)
  probe.src = previewUrl
}

function PendingCard({ item, onChange, onRemove, onSave, onScan }) {
  const { t } = useSettings()
  const saved = item.status === 'saved'
  const uploading = item.status === 'uploading'

  return (
    <div className="rounded-lg border border-border bg-bg-card p-4">
      <div className="flex gap-4">
        <img
          src={item.previewUrl}
          alt=""
          className="h-28 w-28 flex-shrink-0 rounded border border-border bg-black object-contain"
        />
        <div className="min-w-0 flex-1">
          <p className="break-all text-sm text-text-primary">{item.file.name}</p>
          <p className="text-xs text-text-secondary">
            {item.width && item.height ? `${item.width} × ${item.height}px` : 'dimensions unknown'}
            {' · '}
            {formatBytes(item.file.size)}
            {' · '}
            {item.file.type || 'unknown type'}
          </p>
          {saved ? (
            <p className="mt-2 break-all text-xs text-green">Saved as {item.savedName}</p>
          ) : null}
          {item.error ? <p className="mt-2 text-xs text-brand-red">{item.error}</p> : null}
          {item.scanStatus === 'uploading' ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={13} className="animate-spin" aria-hidden />
              Submitting scan{item.scanProgress ? ` ${item.scanProgress}%` : '…'}
            </p>
          ) : null}
          {item.scanStatus === 'done' && item.scanJobId ? (
            <p className="mt-2 text-xs text-text-secondary">
              Scan job queued.{' '}
              <Link className="text-brand-red underline" to={`/scans/${item.scanJobId}`}>
                Open job {item.scanJobId}
              </Link>
            </p>
          ) : null}
          {item.scanStatus === 'error' ? (
            <p className="mt-2 text-xs text-brand-red">{item.scanError}</p>
          ) : null}
          {uploading ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={13} className="animate-spin" aria-hidden />
              Uploading {item.progress}%
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-text-muted">
          {t('common.condition')}
          <select
            className="select mt-1 w-full"
            value={item.condition}
            disabled={uploading || saved}
            onChange={event => onChange({ condition: event.target.value })}
          >
            <option value="">Not set</option>
            {CONDITIONS.map(condition => (
              <option key={condition} value={condition}>{condition}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-muted">
          Card label
          <input
            className="input mt-1 w-full"
            value={item.card_label}
            disabled={uploading || saved}
            placeholder="e.g. Base Set Charizard"
            onChange={event => onChange({ card_label: event.target.value })}
          />
        </label>
        <label className="text-xs text-text-muted">
          Route
          <select
            className="select mt-1 w-full"
            value={item.route}
            disabled={uploading || saved}
            onChange={event => onChange({ route: event.target.value })}
          >
            {ROUTES.map(route => (
              <option key={route} value={route}>{route}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-muted">
          {t('common.notes')}
          <input
            className="input mt-1 w-full"
            value={item.note}
            disabled={uploading || saved}
            placeholder="lighting, distance, anything useful"
            onChange={event => onChange({ note: event.target.value })}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary-sm justify-center"
          disabled={uploading || saved}
          onClick={onSave}
        >
          <Save size={14} aria-hidden />
          Save to Dev
        </button>
        <button
          type="button"
          className="btn-ghost-sm justify-center"
          disabled={item.scanStatus === 'uploading'}
          onClick={onScan}
        >
          <ScanLine size={14} aria-hidden />
          {item.scanStatus === 'uploading' ? 'Scanning…' : 'Scan now'}
        </button>
        <button type="button" className="btn-ghost-sm justify-center" onClick={onRemove}>
          <Trash2 size={14} aria-hidden />
          {t('common.remove')}
        </button>
      </div>
    </div>
  )
}

export default function CaptureLab() {
  const confirm = useConfirmDialog()
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const mountedRef = useRef(true)
  const pendingRef = useRef([])
  const inFlightRef = useRef(new Set())
  const batchScanRef = useRef(false)
  const detectorWorkerRef = useRef(null)
  const detectorWorkerUrlRef = useRef('')
  const detectorSeqRef = useRef(0)
  const detectorImageUrlRef = useRef(null)
  const liveCanvasRef = useRef(null)
  const liveTimerRef = useRef(null)
  const liveInFlightRef = useRef(false)
  const liveSeqRef = useRef(0)
  const liveLastTsRef = useRef(null)
  const liveIntervalRef = useRef(null)
  const liveDetectionRef = useRef(false)
  const liveResultRef = useRef(null)
  const liveLoopRef = useRef(null)
  const liveScheduleRef = useRef(null)
  const liveScheduleMsRef = useRef(null)
  const liveResultHandlerRef = useRef(null)
  const liveErrorHandlerRef = useRef(null)
  const motionCanvasRef = useRef(null)
  const motionLastGrayRef = useRef(null)
  const motionScoreRef = useRef(Infinity)
  const motionTimerRef = useRef(null)
  const motionBusyRef = useRef(false)
  const liveParkedRef = useRef(false)
  const lastDetectionAtRef = useRef(null)
  const lastModelFrameAtRef = useRef(null)
  const lastUsableAtRef = useRef(null)
  const trackerRef = useRef(null)
  if (!trackerRef.current) trackerRef.current = createTracker()
  const trackerCanvasRef = useRef(null)
  const trackerGrayRef = useRef(null)
  const detectionGrayRef = useRef(null)
  const detectionFrameRef = useRef(null)
  const trackerRafRef = useRef(null)
  const trackerLoopRef = useRef(null)
  const trackedQuadRef = useRef(null)
  const trackerFailuresRef = useRef(0)
  const tentativeRef = useRef(null)
  const lastCapturedFrameTimeRef = useRef(null)
  const captureInFlightRef = useRef(false)
  const pendingCaptureRetryRef = useRef(null)
  const lastConfirmTsRef = useRef(null)
  const lastConfirmCornersRef = useRef(null)
  const lastConfirmSharpnessRef = useRef(null)
  const lastDisagreementAtRef = useRef(null)
  const lastAgreementAtRef = useRef(null)
  const lastAgreementRef = useRef(null)
  const lastDecisionRef = useRef(null)
  const lastAttemptFieldsRef = useRef(null)
  const trackerStatsRef = useRef({ hits: 0, attempts: 0, reason: 'frame' })
  const lastTrackFrameTimeRef = useRef(null)
  const lastUsableModelAtRef = useRef(null)
  const diagRef = useRef({ startedAt: null, samples: [], events: [], meta: null, frames: 0, taken: 0 })
  const diagTimerRef = useRef(null)
  const diagSnapshotCanvasRef = useRef(null)
  const diagPhaseRef = useRef('none')
  const diagSampleRef = useRef(null)
  const diagSendingRef = useRef(false)
  const lastHoldDriftRef = useRef(null)
  const trackerFrameMsRef = useRef(null)
  const modelIntervalMsRef = useRef(null)
  const trackInLostRef = useRef(false)
  const phaseReasonRef = useRef('no-quad')
  const lastPhaseRef = useRef(null)
  const trackerFpsRef = useRef(null)
  const trackerLastTsRef = useRef(null)
  const trackerLastFpsPushRef = useRef(0)
  const overlayRef = useRef(null)
  const quadSourceRef = useRef(null)
  const autoCaptureRef = useRef(false)
  const capturePolicyRef = useRef('quad')
  const autoFireTimerRef = useRef(null)
  const autoFireRef = useRef(null)
  const autoStateRef = useRef(newAutoState())
  // First observation of the card currently in view, for time-to-stage.
  const presenceSincePerfRef = useRef(null)
  // Last staged crop's appearance signature, retained across re-arms so the
  // duplicate check can compare against the previous capture, not just the
  // current re-arm baseline.
  const lastStagedSignatureRef = useRef(null)
  const attemptLogRef = useRef([])
  const attemptByItemIdRef = useRef(new Map())

  const [status, setStatus] = useState('idle')
  const [cameraError, setCameraError] = useState('')
  const [trackInfo, setTrackInfo] = useState(null)
  const [cameraMaximum, setCameraMaximum] = useState(null)
  const [largeUploadWarning, setLargeUploadWarning] = useState(false)
  const [resolutionPreset, setResolutionPreset] = useState('default')
  const [requestedResolution, setRequestedResolution] = useState(null)
  const [resolutionError, setResolutionError] = useState('')
  const [applyingResolution, setApplyingResolution] = useState(false)
  const [stillProbe, setStillProbe] = useState(null)
  const [detectorStatus, setDetectorStatus] = useState('idle')
  const [detectorError, setDetectorError] = useState('')
  const [detectorBusy, setDetectorBusy] = useState(false)
  const [detectorImage, setDetectorImage] = useState(null)
  const [detectorResult, setDetectorResult] = useState(null)
  const [detectorRuntime, setDetectorRuntime] = useState('asyncify')
  const [detectorRuntimeActive, setDetectorRuntimeActive] = useState('')
  const [webgpuVerification, setWebgpuVerification] = useState(null)
  const [webgpuVerifying, setWebgpuVerifying] = useState(false)
  const [webgpuProbe, setWebgpuProbe] = useState('')
  const [liveDetection, setLiveDetection] = useState(false)
  const [liveResult, setLiveResult] = useState(null)
  const [liveState, setLiveState] = useState('idle')
  const [confirmPulseUntil, setConfirmPulseUntil] = useState(0)
  const [liveFps, setLiveFps] = useState(0)
  const [trackerFps, setTrackerFps] = useState(0)
  const [trackerStats, setTrackerStats] = useState({ hits: 0, attempts: 0, reason: 'frame' })
  const [diagCount, setDiagCount] = useState({ samples: 0, frames: 0, events: 0 })
  const [diagSend, setDiagSend] = useState({ status: 'idle', message: '', error: '' })
  const [attempts, setAttempts] = useState([])
  const [reportSend, setReportSend] = useState({ status: 'idle', message: '', error: '', id: null })
  const [detectAgeMs, setDetectAgeMs] = useState(null)
  // Auto-capture is the mode this page exists for; forgetting it on every reload
  // costs the user a step they will not always remember. Persisted like the other
  // preferences, and only applied once live detection actually starts.
  const [autoCapture, setAutoCapture] = useState(() => {
    try {
      return window.localStorage.getItem('capture-lab-auto-capture') === '1'
    } catch {
      return false
    }
  })
  // Which rule decides when automatic capture fires. 'quad' is the historical
  // gate (fresh geometry, edge containment, aspect, detector corroboration);
  // 'framing' keeps fresh geometry, presence, edge containment, size and the
  // stability hold, dropping only the aspect heuristic and the separate
  // detector-corroboration requirement. Persisted like the other preferences.
  const [capturePolicy, setCapturePolicyState] = useState(() => {
    try {
      return window.localStorage.getItem(CAPTURE_POLICY_STORAGE_KEY) === 'framing'
        ? 'framing'
        : 'quad'
    } catch {
      return 'quad'
    }
  })
  const [autoDisarmed, setAutoDisarmed] = useState(false)
  const [autoHoldStartTs, setAutoHoldStartTs] = useState(null)
  const [quadSource, setQuadSource] = useState(null)
  const [captureBeatAt, setCaptureBeatAt] = useState(null)
  const [captureNote, setCaptureNote] = useState('')
  // Pill copy the ring cannot explain on its own: the cause of the last
  // automatic refusal, and whether a fresh detection is being requested. The
  // overlay owns the 900 ms persistence; the page only owns these states.
  const [captureRefusal, setCaptureRefusal] = useState(null)
  const [captureRechecking, setCaptureRechecking] = useState(false)
  const [soundOn, setSoundOn] = useState(isCaptureSoundEnabled)
  const [receiptCorners, setReceiptCorners] = useState(null)
  const [dockAnnouncement, setDockAnnouncement] = useState('')
  const [flight, setFlight] = useState(null)
  const flightTokenRef = useRef(0)
  // Sequence is assigned once when an item is staged and never recomputed from
  // recognition, upload or decode completion. Rotation is snapshotted from the
  // session default at the same moment, so changing the default later leaves
  // existing items exactly as they are.
  const sequenceRef = useRef(0)
  const [sessionRotation, setSessionRotation] = useState(null)
  const sessionRotationRef = useRef(sessionRotation)
  sessionRotationRef.current = sessionRotation
  const [inspectedId, setInspectedId] = useState(null)
  const sheetOpenRef = useRef(false)
  const [removedNotice, setRemovedNotice] = useState(null)
  const removedNoticeRef = useRef(null)
  removedNoticeRef.current = removedNotice
  const removedTimerRef = useRef(null)
  const trayRef = useRef(null)
  const capturedSignatureRef = useRef(null)
  const lastRearmCheckAtRef = useRef(0)
  const lastStagedAtRef = useRef(0)
  const lastRearmFrameTimeRef = useRef(null)
  const rearmChangedStreakRef = useRef(0)
  const [softFocus, setSoftFocus] = useState(() => {
    try {
      const stored = window.localStorage.getItem('capture-lab-soft-focus')
      return stored == null ? true : stored === '1'
    } catch {
      return true
    }
  })
  const [pending, setPending] = useState([])
  const [batchScanning, setBatchScanning] = useState(false)
  const [batchScanMessage, setBatchScanMessage] = useState('')
  const [batchScanError, setBatchScanError] = useState('')
  const [libraryError, setLibraryError] = useState('')
  const [storedScans, setStoredScans] = useState({})

  pendingRef.current = pending
  liveDetectionRef.current = liveDetection
  autoCaptureRef.current = autoCapture
  capturePolicyRef.current = capturePolicy
  const inspectedItem = inspectedId
    ? pending.find(item => item.id === inspectedId) || null
    : null
  const sheetOpen = inspectedItem != null

  // Inspecting a capture pauses auto-capture without touching the user's mode
  // or re-arming anything. Closing drops any hold window that elapsed while the
  // sheet covered the preview, so the same unchanged card is not captured again.
  useEffect(() => {
    sheetOpenRef.current = sheetOpen
    const state = autoStateRef.current
    state.anchorCorners = null
    state.anchorTs = null
    state.lastCorners = null
    state.lastQualifyingTs = null
    setAutoHoldStartTs(null)
    if (autoFireTimerRef.current != null) {
      window.clearInterval(autoFireTimerRef.current)
      autoFireTimerRef.current = null
    }
  }, [sheetOpen])

  const {
    data,
    isLoading,
    error: listError,
  } = useQuery({
    queryKey: CAPTURE_LAB_QUERY_KEY,
    queryFn: listCaptureLabEntries,
    retry: false,
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const stream = streamRef.current
      streamRef.current = null
      stream?.getTracks().forEach(track => track.stop())
      pendingRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl))
      const removed = removedNoticeRef.current
      if (removed?.item?.previewUrl) URL.revokeObjectURL(removed.item.previewUrl)
      window.clearTimeout(removedTimerRef.current)
      window.clearTimeout(liveTimerRef.current)
      window.clearInterval(motionTimerRef.current)
      window.clearInterval(autoFireTimerRef.current)
      window.clearInterval(diagTimerRef.current)
      pendingCaptureRetryRef.current?.(false)
      if (trackerRafRef.current != null) window.cancelAnimationFrame(trackerRafRef.current)
      trackerRef.current?.reset()
      liveDetectionRef.current = false
      detectorWorkerRef.current?.terminate()
      detectorWorkerRef.current = null
      if (detectorImageUrlRef.current) URL.revokeObjectURL(detectorImageUrlRef.current)
    }
  }, [])

  // Tick the detect-age readout while live. The overlay animates its own hold
  // progress, so this is the only thing that needs a clock here.
  useEffect(() => {
    if (!liveDetection) return undefined
    const tick = () => {
      setDetectAgeMs(
        lastDetectionAtRef.current == null
          ? null
          : performance.now() - lastDetectionAtRef.current,
      )
    }
    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [liveDetection])

  const stopTrackerLoop = useCallback(() => {
    if (trackerRafRef.current != null) {
      window.cancelAnimationFrame(trackerRafRef.current)
      trackerRafRef.current = null
    }
    trackerRef.current?.reset()
    tentativeRef.current = null
    trackInLostRef.current = false
    trackedQuadRef.current = null
    trackerFailuresRef.current = 0
    trackerFpsRef.current = null
    trackerLastTsRef.current = null
    lastTrackFrameTimeRef.current = null
    trackerStatsRef.current = { hits: 0, attempts: 0, reason: 'frame' }
    setTrackerStats({ hits: 0, attempts: 0, reason: 'frame' })
    setTrackerFps(0)
    setDetectAgeMs(null)
  }, [])

  // Draw each fresh model quad; the tracker takes over imperatively afterwards.
  // An unusable result no longer clears the outline outright: the tracker is the
  // better authority on whether a card is there, and blanking on every unusable
  // detection made the box blink about once a second. Clear only when the tracker
  // has nothing either, and let the tracker's own loss grace do the rest.
  useEffect(() => {
    if (!liveResult) return
    if (liveResult.usable) {
      if (!trackedQuadRef.current) applyQuadToPolygon(liveResult.corners)
      return
    }
    if (!trackedQuadRef.current) applyQuadToPolygon(null)
  }, [liveResult])

  // A phone browser freezes timers and animation frames while the page is hidden:
  // switching apps or locking the screen for a minute returns a page whose loop is
  // parked, whose motion baseline is minutes stale and whose hold is mid-window.
  // On return, drop that state and ask for a look immediately.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (!liveDetectionRef.current) return
      lastDetectionAtRef.current = null
      lastUsableAtRef.current = performance.now()
      motionLastGrayRef.current = null
      motionScoreRef.current = Infinity
      liveParkedRef.current = false
      liveInFlightRef.current = false
      autoStateRef.current = newAutoState()
      setAutoHoldStartTs(null)
      liveScheduleRef.current?.(0)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // The overlay fades its own success beat; this only bounds how long the
  // 'captured' phase can stay on the page's books.
  useEffect(() => {
    if (captureBeatAt == null) return undefined
    const timer = window.setTimeout(() => setCaptureBeatAt(null), CAPTURE_BEAT_MS)
    return () => window.clearTimeout(timer)
  }, [captureBeatAt])

  // ── live-detection recording ────────────────────────────────────────────
  // Ring buffer of what the detector and tracker are doing, plus a small JPEG
  // every tenth second. Nothing leaves the phone until Send diagnostics.
  function buildDiagMeta() {
    const video = videoRef.current
    const track = streamRef.current?.getVideoTracks?.()[0]
    const settings = track?.getSettings?.() || {}
    const capabilities = track?.getCapabilities?.() || {}
    const pick = (source, keys) => Object.fromEntries(
      keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]),
    )
    return {
      recorded_at: new Date().toISOString(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      video: { width: video?.videoWidth ?? null, height: video?.videoHeight ?? null },
      track: {
        settings: pick(settings, ['width', 'height', 'frameRate', 'facingMode', 'resizeMode']),
        capabilities: pick(capabilities, ['width', 'height', 'frameRate']),
      },
      user_agent: navigator.userAgent,
      device_pixel_ratio: window.devicePixelRatio,
      screen: { width: window.screen?.width ?? null, height: window.screen?.height ?? null },
      detector_runtime: detectorRuntimeActive || detectorRuntime,
      min_card_area: MIN_CARD_AREA,
      capture_policy: capturePolicyRef.current,
      // Consecutive tracked frames that satisfy the framing policy's presence
      // guard when no recent detector quad is available.
      framing_presence_hits: TRACKER_FALLBACK_HITS,
      // The quad policy's automatic-capture gate, including that its aspect
      // band is compared against min(r, 1/r). Under 'framing' only edge_min is
      // enforced; the aspect band and detector corroboration are dropped.
      capture_gate: {
        edge_min: CAPTURE_EDGE_MIN,
        aspect_min: CAPTURE_ASPECT_MIN,
        aspect_max: CAPTURE_ASPECT_MAX,
        aspect_orientation_normalised: true,
      },
      // Exactly which gates each policy applies, so a recording cannot be read
      // against the wrong rule.
      policy_gates: POLICY_GATES,
      // Hold-window thresholds, so a recording can be read against the rule that
      // produced its hold-reset events.
      auto_hold: {
        stable_ms: AUTO_STABLE_MS,
        step_speed: AUTO_STEP_SPEED,
        step_dt_max_ms: AUTO_STEP_DT_MAX_MS,
        total_move: AUTO_TOTAL_MOVE,
        gap_ms: AUTO_STABLE_GAP_MS,
      },
      tracker: {
        TRACK_MAX_EDGE,
        PATCH_RADIUS,
        SEARCH_RADIUS,
        FIRST_TRACK_RADIUS,
        TRACK_MAX_MISSES,
        TRACK_LOST_AFTER,
        TRACK_KEEP_MS,
        TRACK_AGREE_MAX,
        TRACK_PHASE_MAX_AGE_MS,
        TENTATIVE_CONFIRM_TRACKS,
        TENTATIVE_MAX_MISSES,
        MAX_FRAME_MOVE,
        MAX_PATCH_MSE_FLOOR,
        PATCH_VARIANCE_RATIO,
        MIN_AREA_RATIO,
        MAX_AREA_RATIO,
      },
    }
  }

  function captureDiagFrame() {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return null
    const scale = Math.min(1, DIAG_SNAPSHOT_EDGE / Math.max(video.videoWidth, video.videoHeight))
    const width = Math.max(1, Math.round(video.videoWidth * scale))
    const height = Math.max(1, Math.round(video.videoHeight * scale))
    let canvas = diagSnapshotCanvasRef.current
    if (!canvas) canvas = document.createElement('canvas')
    diagSnapshotCanvasRef.current = canvas
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    canvas.getContext('2d').drawImage(video, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.6)
  }

  function trimDiagPayload(diag) {
    const estimate = () => JSON.stringify({
      meta: diag.meta,
      samples: diag.samples,
      events: diag.events,
    }).length
    // Oldest frames go first, then the oldest events; meta and the sample
    // timeline are the last things to lose detail.
    while (estimate() > DIAG_MAX_PAYLOAD_BYTES) {
      const oldestFrame = diag.samples.find(sample => sample.frame)
      if (oldestFrame) {
        delete oldestFrame.frame
        diag.frames = Math.max(0, diag.frames - 1)
        continue
      }
      if (diag.events.length > 0) {
        diag.events.shift()
        continue
      }
      break
    }
  }

  function recordDiagEvent(type, payload = {}) {
    try {
      const diag = diagRef.current
      if (diag.startedAt == null) return
      // Capture events must always say which policy produced them, so the
      // policy is attached here instead of at every call site.
      const policyFields = type === 'capture' || type === 'capture-attempt'
        ? { policy: capturePolicyRef.current }
        : {}
      diag.events.push({
        t: Math.round(performance.now() - diag.startedAt),
        type,
        ...policyFields,
        ...payload,
      })
      while (diag.events.length > DIAG_MAX_EVENTS) diag.events.shift()
      trimDiagPayload(diag)
      setDiagCount(prev => (
        prev.events === diag.events.length ? prev : { ...prev, events: diag.events.length }
      ))
    } catch {
      // Diagnostics must never break the live path.
    }
  }

  function takeDiagSample() {
    try {
      const diag = diagRef.current
      const now = performance.now()
      if (diag.startedAt == null) diag.startedAt = now
      if (!diag.meta) diag.meta = buildDiagMeta()

      const model = liveResultRef.current
      const tracked = trackedQuadRef.current
      const quad = tracked || (model?.usable ? model.corners : null)
      const stats = trackerStatsRef.current
      const holdTs = autoStateRef.current.anchorTs
      const sample = {
        t: Math.round(now - diag.startedAt),
        detectMs: model?.ms ?? null,
        sharpness: Number.isFinite(model?.sharpness) ? Number(model.sharpness.toFixed(4)) : null,
        area: Number.isFinite(model?.area) ? Number(model.area.toFixed(4)) : null,
        source: quad ? (quadSourceRef.current || 'none') : 'none',
        trackFps: trackerFpsRef.current ? Math.round(1000 / trackerFpsRef.current) : 0,
        trackHits: stats.hits,
        trackAttempts: stats.attempts,
        trackReason: stats.reason,
        phase: diagPhaseRef.current,
        phaseReason: phaseReasonRef.current,
        modelUnusableReason: model?.unusableReason ?? null,
        detectAgeMs: lastDetectionAtRef.current == null
          ? null
          : Math.round(now - lastDetectionAtRef.current),
        detectParts: model?.detectParts ?? null,
        trackMs: trackerFrameMsRef.current,
        modelIntervalMs: modelIntervalMsRef.current,
        parked: liveParkedRef.current,
        hunting: !model?.usable,
        liveScheduleMs: liveScheduleMsRef.current,
        quad: quad ? quad.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]) : null,
        holdMs: holdTs == null ? null : Math.round(now - holdTs),
        holdElapsedMs: holdTs == null ? null : Math.round(now - holdTs),
        holdDrift: lastHoldDriftRef.current,
        holdSource: autoStateRef.current.lastSource || 'tracked',
        trackMisses: trackerFailuresRef.current,
        confirmAgeMs: lastConfirmTsRef.current == null
          ? null
          : Math.round(now - lastConfirmTsRef.current),
        motionScore: Number.isFinite(motionScoreRef.current)
          ? Math.round(motionScoreRef.current * 10) / 10
          : null,
        trackerIntervalMs: trackerFpsRef.current == null
          ? null
          : Math.round(trackerFpsRef.current),
      }

      // Monotonic cadence: an array-length modulo freezes once the 90-sample
      // ring is full, which silently stopped snapshots halfway through.
      diag.taken = (diag.taken || 0) + 1
      if (diag.taken % DIAG_SNAPSHOT_EVERY === 0) {
        const frame = captureDiagFrame()
        if (frame) {
          sample.frame = frame
          diag.frames += 1
        }
      }

      diag.samples.push(sample)
      while (diag.samples.length > DIAG_MAX_SAMPLES) {
        const dropped = diag.samples.shift()
        if (dropped?.frame) diag.frames = Math.max(0, diag.frames - 1)
      }
      trimDiagPayload(diag)
      setDiagCount({
        samples: diag.samples.length,
        frames: diag.frames,
        events: diag.events.length,
      })
    } catch {
      // A broken sample must never break the live loop.
    }
  }

  function startDiagRecorder() {
    if (diagTimerRef.current != null) return
    diagSampleRef.current = takeDiagSample
    const diag = diagRef.current
    if (diag.startedAt == null) diag.startedAt = performance.now()
    lastPhaseRef.current = null
    recordDiagEvent('phase', {
      phase: diagPhaseRef.current,
      reason: phaseReasonRef.current,
    })
    diagTimerRef.current = window.setInterval(() => diagSampleRef.current?.(), DIAG_SAMPLE_MS)
  }

  function stopDiagRecorder() {
    if (diagTimerRef.current != null) {
      window.clearInterval(diagTimerRef.current)
      diagTimerRef.current = null
    }
  }

  function clearDiagnostics() {
    diagRef.current = { startedAt: null, samples: [], events: [], meta: null, frames: 0, taken: 0 }
    lastPhaseRef.current = null
    setDiagCount({ samples: 0, frames: 0, events: 0 })
    setDiagSend({ status: 'idle', message: '', error: '' })
  }

  async function sendDiagnostics() {
    const diag = diagRef.current
    if (!diag.samples.length || diagSendingRef.current) return
    diagSendingRef.current = true
    setDiagSend({ status: 'sending', message: '', error: '' })
    try {
      const result = await uploadCaptureLabDiagnostics({
        // Build the toggle state at send time: it can change during recording.
        meta: {
          ...(diag.meta || buildDiagMeta()),
          auto_capture: autoCaptureRef.current,
          capture_policy: capturePolicyRef.current,
        },
        samples: diag.samples,
        events: diag.events,
      })
      setDiagSend({
        status: 'sent',
        message: `sent: ${result.name} · ${result.samples} samples · ${result.frames} frames`,
        error: '',
      })
    } catch (error) {
      setDiagSend({ status: 'error', message: '', error: scanErrorMessage(error) })
    } finally {
      diagSendingRef.current = false
    }
  }

  function markDiagnostics(label) {
    const now = performance.now()
    const hasTracked = trackedQuadRef.current != null
    const quadAgeMs = hasTracked && trackerLastTsRef.current != null
      ? Math.round(now - trackerLastTsRef.current)
      : (lastDetectionAtRef.current == null
        ? null
        : Math.round(now - lastDetectionAtRef.current))
    recordDiagEvent('mark', {
      label,
      phase: diagPhaseRef.current,
      phaseReason: phaseReasonRef.current,
      quadAgeMs,
      confirmAgeMs: lastConfirmTsRef.current == null
        ? null
        : Math.round(now - lastConfirmTsRef.current),
      holdElapsedMs: autoStateRef.current.anchorTs == null
        ? null
        : Math.round(now - autoStateRef.current.anchorTs),
      drift: lastHoldDriftRef.current,
    })
    setCaptureNote(label === 'good' ? 'Marked: good' : 'Marked: wrong')
  }

  const toggleCaptureSound = () => {
    const next = !soundOn
    setSoundOn(next)
    setCaptureSoundEnabled(next)
    // Unmuting is a user gesture, so it may also lift a parked AudioContext.
    if (next) primeCaptureAudio()
  }

  const toggleSoftFocus = () => {
    const next = !softFocus
    setSoftFocus(next)
    try {
      window.localStorage.setItem('capture-lab-soft-focus', next ? '1' : '0')
    } catch {
      // Private mode or a full quota: the toggle still works this session.
    }
  }

  // The confirmation pulse is a render-time state change: expire it so the
  // ring falls back to dashed tracking even if no new frame arrives.
  useEffect(() => {
    if (!confirmPulseUntil) return undefined
    const timer = window.setTimeout(
      () => setConfirmPulseUntil(0),
      Math.max(0, confirmPulseUntil - performance.now()),
    )
    return () => window.clearTimeout(timer)
  }, [confirmPulseUntil])

  const stopLiveDetection = useCallback(() => {
    stopDiagRecorder()
    stopTrackerLoop()
    liveDetectionRef.current = false
    setLiveDetection(false)
    window.clearTimeout(liveTimerRef.current)
    liveTimerRef.current = null
    window.clearInterval(motionTimerRef.current)
    motionTimerRef.current = null
    motionLastGrayRef.current = null
    motionScoreRef.current = Infinity
    motionBusyRef.current = false
    liveParkedRef.current = false
    lastDetectionAtRef.current = null
    lastModelFrameAtRef.current = null
    lastUsableAtRef.current = null
    presenceSincePerfRef.current = null
    liveInFlightRef.current = false
    liveLastTsRef.current = null
    liveIntervalRef.current = null
    liveResultRef.current = null
    setLiveResult(null)
    setLiveState('idle')
    setLiveFps(0)
    setAutoDisarmed(false)
    setAutoHoldStartTs(null)
    setConfirmPulseUntil(0)
    setCaptureBeatAt(null)
    setCaptureNote('')
    pendingCaptureRetryRef.current?.(false)
    lastConfirmTsRef.current = null
    lastConfirmCornersRef.current = null
    lastConfirmSharpnessRef.current = null
    lastDisagreementAtRef.current = null
    lastAgreementAtRef.current = null
    lastAgreementRef.current = null
    lastDecisionRef.current = null
    lastHoldDriftRef.current = null
    autoStateRef.current = newAutoState()
    stopAutoFireTimer()
    quadSourceRef.current = null
    detectionFrameRef.current = null
    setQuadSource(null)
    overlayRef.current?.setQuad(null)
  }, [stopTrackerLoop])

  const stopCamera = useCallback(() => {
    stopLiveDetection()
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach(track => track.stop())
    if (videoRef.current) videoRef.current.srcObject = null
    setStatus('idle')
    setTrackInfo(null)
    setRequestedResolution(null)
    setResolutionError('')
    setApplyingResolution(false)
    setStillProbe(null)
  }, [stopLiveDetection])

  const startCamera = async () => {
    // Opening the camera is the user gesture that unlocks WebAudio for the
    // capture cues; the context must exist before the async capture path runs.
    primeCaptureAudio()
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setCameraError('getUserMedia is unavailable in this browser.')
      return
    }
    stopCamera()
    setStatus('requesting')
    setCameraError('')
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
      let capabilities = {}
      try { capabilities = track?.getCapabilities?.() || {} } catch { capabilities = {} }
      const widths = capabilities.width
      const heights = capabilities.height
      const maxWidth = typeof widths?.max === 'number' ? widths.max : Array.isArray(widths) ? Math.max(...widths) : null
      const maxHeight = typeof heights?.max === 'number' ? heights.max : Array.isArray(heights) ? Math.max(...heights) : null
      if (maxWidth && maxHeight && track?.applyConstraints) {
        setCameraMaximum({ width: maxWidth, height: maxHeight })
        try {
          await track.applyConstraints({ width: { ideal: maxWidth }, height: { ideal: maxHeight } })
        } catch {
          // Keep the browser's initial 1920×1080 request when maximum is rejected.
        }
      } else setCameraMaximum(null)
      const settings = track?.getSettings?.() || {}
      try { capabilities = track?.getCapabilities?.() || capabilities } catch { /* retain earlier capabilities */ }
      if (track) {
        track.onended = () => {
          if (!mountedRef.current) return
          setStatus('error')
          setCameraError('The camera stream ended.')
        }
      }
      setTrackInfo({ settings, capabilities })
      setStatus('live')
    } catch (error) {
      const name = error?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('denied')
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setStatus('no-camera')
      } else {
        setStatus('error')
      }
      setCameraError(error?.message || String(error))
    }
  }

  // The real scanner asks for 1920×1080; this control measures whether a larger
  // delivered frame improves recognition before changing that default.
  const applyResolution = async () => {
    const preset = RESOLUTION_PRESETS.find(entry => entry.id === resolutionPreset)
    const track = streamRef.current?.getVideoTracks?.()[0]
    if (!preset || !track) return
    setApplyingResolution(true)
    setResolutionError('')
    const target = preset.id === 'default' ? cameraMaximum || { width: 1920, height: 1080 } : preset
    setRequestedResolution({ width: target.width, height: target.height })
    try {
      await track.applyConstraints({
        width: { ideal: target.width },
        height: { ideal: target.height },
      })
      const settings = track.getSettings?.() || {}
      const capabilities = track.getCapabilities?.() || {}
      if (!mountedRef.current) return
      setTrackInfo({ settings, capabilities })
    } catch (error) {
      // Keep the previous settings visible: the track is still delivering.
      if (!mountedRef.current) return
      setResolutionError(`${error?.name || 'Error'}: ${error?.message || String(error)}`)
    } finally {
      if (mountedRef.current) setApplyingResolution(false)
    }
  }

  // Device-dependent by design: a rejected probe is the finding, not a bug to
  // work around. The still is measured and discarded, never uploaded.
  const probeStill = async () => {
    const track = streamRef.current?.getVideoTracks?.()[0]
    if (!track || typeof window.ImageCapture !== 'function' || stillProbe?.status === 'running') return
    const started = performance.now()
    setStillProbe({ status: 'running' })
    let capabilities = null
    try {
      const capture = new window.ImageCapture(track)
      capabilities = await capture.getPhotoCapabilities()
      setStillProbe({ status: 'running', capabilities })
      const blob = await capture.takePhoto()
      const elapsedMs = Math.round(performance.now() - started)
      const objectUrl = URL.createObjectURL(blob)
      let dimensions
      try {
        dimensions = await new Promise((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
          image.onerror = () => reject(new Error('The still image could not be decoded.'))
          image.src = objectUrl
        })
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
      if (!mountedRef.current) return
      setStillProbe({
        status: 'done',
        capabilities,
        width: dimensions.width,
        height: dimensions.height,
        bytes: blob.size,
        type: blob.type || 'unknown',
        elapsedMs,
        blob,
      })
    } catch (error) {
      if (!mountedRef.current) return
      setStillProbe({
        status: 'error',
        capabilities,
        error: `${error?.name || 'Error'}: ${error?.message || String(error)}`,
      })
    }
  }

  // Detection probe + live loop: a worker keeps the ONNX runtime and inference
  // off the main thread. The file probe stays available alongside live mode.
  const loadDetector = (runtime = detectorRuntime) => {
    stopLiveDetection()
    detectorWorkerRef.current?.terminate()
    detectorWorkerRef.current = null
    setDetectorStatus('loading')
    setDetectorError('')
    setDetectorResult(null)
    setDetectorRuntimeActive('')
    setWebgpuVerification(null)
    setWebgpuVerifying(false)
    let worker
    let bootstrapUrl = ''
    try {
      // Start the worker from a blob that imports the real module. A worker
      // started from its own URL is governed by that script's response headers,
      // and a content-hashed asset can keep a stale Content-Security-Policy for
      // as long as the browser caches it - which blocked the detector's wasm
      // even after the policy was fixed on the server. A blob worker inherits the
      // document's policy instead, and the document is always revalidated.
      const moduleUrl = new URL('../workers/cardDetector.worker.js', import.meta.url)
      detectorWorkerUrlRef.current = moduleUrl.href
      bootstrapUrl = URL.createObjectURL(
        new Blob([`import ${JSON.stringify(moduleUrl.href)}`], { type: 'text/javascript' }),
      )
      worker = new Worker(bootstrapUrl, {
        type: 'module',
      })
    } catch (error) {
      setDetectorStatus('error')
      setDetectorError(`${error?.name || 'Error'}: ${error?.message || String(error)}`)
      return
    }
    detectorWorkerRef.current = worker
    worker.onmessage = event => {
      if (detectorWorkerRef.current !== worker) return
      const message = event.data || {}
      if (message.type === 'ready') {
        setDetectorStatus('ready')
        setDetectorRuntimeActive(
          ['asyncify', 'wasm', 'webgpu'].includes(message.runtime) ? message.runtime : runtime,
        )
        return
      }
      if (message.type === 'verification') {
        setWebgpuVerification(
          message.verification || { unverified: true, reason: 'no verification data' },
        )
        setWebgpuVerifying(false)
        return
      }
      if (message.type === 'result') {
        if (message.seq >= LIVE_SEQ_BASE) {
          liveResultHandlerRef.current?.(message)
          return
        }
        if (message.seq !== detectorSeqRef.current) return
        setDetectorBusy(false)
        setDetectorResult(message)
        if (message.verification) setWebgpuVerification(message.verification)
        return
      }
      if (message.type === 'error') {
        recordDiagEvent('worker-error', {
          message: message.message || 'Detector failed',
          workerUrl: detectorWorkerUrlRef.current,
        })
        if (message.seq >= LIVE_SEQ_BASE) {
          liveErrorHandlerRef.current?.(message)
          return
        }
        if (message.seq != null && message.seq !== detectorSeqRef.current) return
        if (message.seq == null) setDetectorStatus('error')
        else setDetectorBusy(false)
        setWebgpuVerifying(false)
        setDetectorError(message.message || 'Detector failed')
      }
    }
    worker.onerror = event => {
      if (detectorWorkerRef.current !== worker) return
      recordDiagEvent('worker-error', {
        message: event.message || 'The detector worker crashed.',
        workerUrl: detectorWorkerUrlRef.current,
      })
      setDetectorStatus('error')
      setDetectorError(event.message || 'The detector worker crashed.')
      setWebgpuVerifying(false)
      stopLiveDetection()
    }
    // The worker runs from a blob, where root-relative URLs cannot be resolved;
    // tell it the page's origin so its detector URLs stay absolute.
    worker.postMessage({ type: 'init', runtime, assetBase: window.location.origin })
  }

  const detectFile = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    const worker = detectorWorkerRef.current
    if (!file || detectorStatus !== 'ready' || !worker) return
    setDetectorBusy(true)
    setDetectorError('')
    setDetectorResult(null)
    setDetectorImage(null)
    if (detectorImageUrlRef.current) URL.revokeObjectURL(detectorImageUrlRef.current)
    const imageUrl = URL.createObjectURL(file)
    detectorImageUrlRef.current = imageUrl
    try {
      const bitmap = await createImageBitmap(file)
      setDetectorImage({ url: imageUrl, width: bitmap.width, height: bitmap.height })
      const seq = detectorSeqRef.current + 1
      detectorSeqRef.current = seq
      worker.postMessage({ type: 'detect', bitmap, seq }, [bitmap])
    } catch (error) {
      setDetectorBusy(false)
      setDetectorError(`${error?.name || 'Error'}: ${error?.message || String(error)}`)
    }
  }

  const addFiles = useCallback((files, defaultRoute = 'Phone browser', { rotationCW = null, geometry = null } = {}) => {
    const now = Date.now()
    const items = Array.from(files)
      .filter(file => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name))
      .map((file, index) => {
        if (file.size > 3.5 * 1024 * 1024 && !largeUploadWarning) {
          setLargeUploadWarning(true)
          setCaptureNote('This photo is over 3.5 MB. It will use a larger upload and may make the scan slower.')
        }
        const id = `${now}-${index}-${Math.random().toString(36).slice(2)}`
        const previewUrl = URL.createObjectURL(file)
        sequenceRef.current += 1
        const item = {
          id,
          sequence: sequenceRef.current,
          rotationCW: normalizeRotation(rotationCW),
          // Frozen at capture alongside the rotation: never rebuilt later from
          // the live overlay or the tray's visible order.
          geometry: geometry || null,
          file,
          previewUrl,
          width: null,
          height: null,
          condition: '',
          card_label: '',
          route: defaultRoute,
          note: '',
          status: 'pending',
          progress: 0,
          error: '',
          savedName: '',
          scanStatus: 'idle',
          scanProgress: 0,
          scanError: '',
          scanJobId: '',
        }
        readDimensions(previewUrl, (width, height) => {
          setPending(prev => prev.map(entry => (
            entry.id === id ? { ...entry, width, height } : entry
          )))
        })
        return item
      })
    if (items.length) setPending(prev => [...items, ...prev])
    return items
  }, [])

  const resizeMode = () => streamRef.current?.getVideoTracks?.()[0]?.getSettings?.().resizeMode || 'contain'

  // Capacity is about unsent photos, not everything still listed: once a batch
  // is on its way the tray can accept more.
  const trayUnsentCount = () => pendingRef.current.filter(item => (
    item.scanStatus !== 'done' && item.scanStatus !== 'uploading'
  )).length

  const stageDock = (item, corners, sourceRect, count) => {
    lastStagedAtRef.current = performance.now()
    setReceiptCorners(corners || null)
    setDockAnnouncement(`Captured #${item.sequence}${item.geometry ? '' : ' · guide crop'} · ${count} in tray`)
    flightTokenRef.current += 1
    setFlight({
      token: flightTokenRef.current,
      itemId: item.id,
      url: item.previewUrl,
      rotationCW: item.rotationCW,
      sourceRect,
      index: item.sequence,
      resizeMode: resizeMode(),
      committedAt: performance.now(),
    })
  }

  // Latest unsent capture by sequence — never the card nearest the viewport.
  const undoLastCapture = () => {
    const target = latestUnsentItem(pendingRef.current)
    if (!target) return
    setFlight(null)
    removePending(target.id)
    setReceiptCorners(null)
    setDockAnnouncement(`Removed #${target.sequence} · ${Math.max(0, pendingRef.current.length - 1)} in tray`)
  }

  // ── capture outcome instrumentation ────────────────────────────────────
  // One record per trigger (an automatic fire or a manual tap), not per internal
  // retry: a geometry retry and the manual full-frame fallback belong to the
  // same attempt.
  const createCaptureAttempt = trigger => {
    const nowPerf = performance.now()
    const nowWall = Date.now()
    const presencePerf = presenceSincePerfRef.current
    const record = {
      at: null,
      policy: capturePolicyRef.current,
      trigger,
      outcome: null,
      refusalReason: null,
      presenceAt: presencePerf == null
        ? null
        : new Date(nowWall - (nowPerf - presencePerf)).toISOString(),
      attemptedAt: new Date(nowWall).toISOString(),
      stagedAt: null,
      timeToStageMs: null,
      quadSource: 'none',
      quadAgeMs: null,
      contained: null,
      quadArea: null,
      stagedBox: null,
      regionCheck: null,
      appearanceSimilarity: null,
      duplicateSuspected: null,
      upload: null,
      gatesApplied: gatesAppliedFor(capturePolicyRef.current, trigger),
    }
    // Non-enumerable so neither the POST nor the summary carries bookkeeping.
    Object.defineProperty(record, '__meta', {
      value: { presencePerf, attemptPerf: nowPerf, stagedPerf: null, itemId: null },
      enumerable: false,
      writable: true,
    })
    return record
  }

  const pushAttempt = record => {
    const log = attemptLogRef.current
    log.push(record)
    while (log.length > ATTEMPT_LOG_LIMIT) log.shift()
    setAttempts([...log])
  }

  const finalizeCaptureAttempt = (record, fields = {}) => {
    if (!record || record.outcome) return
    Object.assign(record, fields)
    record.at = new Date().toISOString()
    if (record.outcome === 'staged' && record.__meta.stagedPerf != null
      && record.__meta.presencePerf != null) {
      record.timeToStageMs = Math.max(
        0,
        Math.round(record.__meta.stagedPerf - record.__meta.presencePerf),
      )
    }
    pushAttempt(record)
    recordDiagEvent('capture-outcome', { ...record })
  }

  const markAttemptStaged = (record, fields = {}) => {
    if (!record) return
    record.__meta.stagedPerf = performance.now()
    record.stagedAt = new Date().toISOString()
    finalizeCaptureAttempt(record, { outcome: 'staged', refusalReason: null, ...fields })
  }

  const captureFullFrame = ({ mode = 'manual', attemptRecord = null } = {}) => {
    const record = attemptRecord || createCaptureAttempt('manual')
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) {
      finalizeCaptureAttempt(record, {
        outcome: 'refused',
        refusalReason: refusalReasonText('no-video'),
        quadSource: 'none',
      })
      return
    }
    // No trustworthy geometry: use the centred card guide, with the same
    // generous margin as a detected-card crop. Never silently save the frame.
    const frameWidth = video.videoWidth
    const frameHeight = video.videoHeight
    const guideWidth = frameWidth * 0.6
    const guideHeight = Math.min(frameHeight * 0.8, guideWidth / 0.625)
    const padX = guideWidth * CAPTURE_BOX_PAD_FRACTION
    const padY = guideHeight * CAPTURE_BOX_PAD_FRACTION
    const sourceRect = {
      x: Math.max(0, Math.floor((frameWidth - guideWidth) / 2 - padX)),
      y: Math.max(0, Math.floor((frameHeight - guideHeight) / 2 - padY)),
      width: 0,
      height: 0,
    }
    const maxX = Math.min(frameWidth, Math.ceil((frameWidth + guideWidth) / 2 + padX))
    const maxY = Math.min(frameHeight, Math.ceil((frameHeight + guideHeight) / 2 + padY))
    sourceRect.width = maxX - sourceRect.x
    sourceRect.height = maxY - sourceRect.y
    const scale = Math.min(1, CAPTURE_SOURCE_MAX_EDGE / Math.max(sourceRect.width, sourceRect.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sourceRect.width * scale))
    canvas.height = Math.max(1, Math.round(sourceRect.height * scale))
    canvas.getContext('2d').drawImage(video, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(blob => {
      if (!blob) {
        setCaptureNote('The capture could not be encoded; nothing captured.')
        finalizeCaptureAttempt(record, {
          outcome: 'refused',
          refusalReason: refusalReasonText('encode'),
          quadSource: 'none',
          stagedBox: { ...sourceRect },
        })
        return
      }
      if (trayUnsentCount() >= TRAY_CAPACITY) {
        setCaptureNote(`Tray full · Review & send ${TRAY_CAPACITY}`)
        finalizeCaptureAttempt(record, {
          outcome: 'refused',
          refusalReason: refusalReasonText('tray-full'),
          quadSource: 'none',
          stagedBox: { ...sourceRect },
        })
        return
      }
      const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' })
      const created = addFiles([file], 'Phone browser', {
        rotationCW: sessionRotationRef.current,
      })
      if (created[0]) {
        stageDock(created[0], null, null, pendingRef.current.length + 1)
        attemptByItemIdRef.current.set(created[0].id, record)
      }
      const appearance = appearanceAgainstLast(canvas, lastStagedSignatureRef.current)
      if (appearance.signature) lastStagedSignatureRef.current = appearance.signature
      markAttemptStaged(record, {
        quadSource: 'none',
        quadAgeMs: null,
        contained: null,
        quadArea: null,
        stagedBox: { ...sourceRect },
        regionCheck: null,
        appearanceSimilarity: appearance.similarity,
        duplicateSuspected: appearance.duplicate,
      })
      if (soundOn) playCaptureSuccess()
      recordDiagEvent('capture', {
        mode,
        rectified: false,
        corners: null,
        // The whole frame is this capture's crop; no card quad was involved.
        cropRect: sourceRect,
        cropQuad: null,
        gatesApplied: record.gatesApplied,
      })
    }, 'image/jpeg', 0.92)
  }

  // Single acquisition path for rectified captures. The card's native-pixel
  // bounding box is drawn 1:1, then warped, so the crop is not an upscale of a
  // downscaled full frame. requestVideoFrameCallback is unavailable on Firefox
  // for Android, so currentTime is compared around drawImage; the same decoded
  // frame time is never captured twice.
  const acquireVideoFrame = corners => new Promise(resolve => {
    const started = performance.now()
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const attempt = async () => {
      const video = videoRef.current
      if (!video || !video.videoWidth || !video.videoHeight) {
        resolve({
          ok: false,
          reason: 'no-video',
          waitedMs: Math.round(performance.now() - started),
          frameTime: null,
        })
        return
      }
      const videoWidth = video.videoWidth
      const videoHeight = video.videoHeight
      const nativeQuad = corners.map(([x, y]) => [x * videoWidth, y * videoHeight])
      const xs = nativeQuad.map(point => point[0])
      const ys = nativeQuad.map(point => point[1])
      const boxWidth = Math.max(1, Math.max(...xs) - Math.min(...xs))
      const boxHeight = Math.max(1, Math.max(...ys) - Math.min(...ys))
      // Generous 12 % region around the card: how a person frames a hand-held
      // photo, and enough slack that recognisers see the whole card even when
      // the tracker is slightly tight. No rotation or rectification is applied.
      const padX = Math.round(boxWidth * CAPTURE_BOX_PAD_FRACTION)
      const padY = Math.round(boxHeight * CAPTURE_BOX_PAD_FRACTION)
      const rawMinX = Math.min(...xs) - padX
      const rawMaxX = Math.max(...xs) + padX
      const rawMinY = Math.min(...ys) - padY
      const rawMaxY = Math.max(...ys) + padY
      const minX = Math.max(0, Math.floor(rawMinX))
      const maxX = Math.min(videoWidth, Math.ceil(rawMaxX))
      const minY = Math.max(0, Math.floor(rawMinY))
      const maxY = Math.min(videoHeight, Math.ceil(rawMaxY))
      const sourceWidth = Math.max(1, maxX - minX)
      const sourceHeight = Math.max(1, maxY - minY)
      // Whether the frame edge cut the padded box. Provenance, not a decision.
      const paddingClipped = rawMinX < 0 || rawMaxX > videoWidth
        || rawMinY < 0 || rawMaxY > videoHeight
      // The box is a fraction of the frame and is capped only as a memory guard.
      const scale = Math.min(1, CAPTURE_SOURCE_MAX_EDGE / Math.max(sourceWidth, sourceHeight))
      const width = Math.max(1, Math.round(sourceWidth * scale))
      const height = Math.max(1, Math.round(sourceHeight * scale))
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const before = video.currentTime
      context.drawImage(video, minX, minY, sourceWidth, sourceHeight, 0, 0, width, height)
      const after = video.currentTime
      const waitedMs = Math.round(performance.now() - started)
      if (after === before && before === lastCapturedFrameTimeRef.current) {
        if (waitedMs >= CAPTURE_FRAME_WAIT_MS) {
          resolve({ ok: false, reason: 'stalled', waitedMs, frameTime: after })
          return
        }
        window.requestAnimationFrame(attempt)
        return
      }
      // A camera-native still is deliberately not used for the crop. Its field
      // of view can differ from the preview frame, so a quad measured on the
      // preview cannot be mapped onto it by proportion, and a crop stitched from
      // mismatched geometry is worse than a clean video frame. The camera is
      // already asked for its maximum resolution, so the video frame carries the
      // same pixels the still would.
      let cardLongEdge = 0
      for (let i = 0; i < 4; i += 1) {
        const [x1, y1] = nativeQuad[i]
        const [x2, y2] = nativeQuad[(i + 1) % 4]
        cardLongEdge = Math.max(cardLongEdge, Math.hypot(x2 - x1, y2 - y1))
      }
      resolve({
        ok: true,
        reason: 'ok',
        canvas,
        frameTime: after,
        waitedMs,
        // The delivered crop's long edge, and the card's own long edge in
        // native source pixels.
        sourceLongEdge: Math.max(width, height),
        cardLongEdge: Math.round(cardLongEdge),
        encodedWidth: width,
        encodedHeight: height,
        paddingClipped,
        // The frame the corners were normalised against, in native pixels. The
        // geometry mapping needs it to turn 0..1 corners into frame pixels.
        frameWidth: videoWidth,
        frameHeight: videoHeight,
        sourceRect: { x: minX, y: minY, width: sourceWidth, height: sourceHeight },
      })
    }
    attempt()
  })

  const rearmAutoCapture = () => {
    const state = autoStateRef.current
    state.disarmed = false
    state.anchorCorners = null
    state.anchorTs = null
    state.lastCorners = null
    state.lastQualifyingTs = null
    state.absentSince = null
    state.lastSource = 'tracked'
    setAutoDisarmed(false)
    capturedSignatureRef.current = null
    lastRearmCheckAtRef.current = 0
    lastRearmFrameTimeRef.current = null
    rearmChangedStreakRef.current = 0
    setAutoHoldStartTs(null)
    setCaptureRefusal(null)
    liveScheduleRef.current?.(0)
  }

  const disarmAutoCapture = () => {
    const state = autoStateRef.current
    state.disarmed = true
    state.anchorCorners = null
    state.anchorTs = null
    state.lastCorners = null
    state.lastQualifyingTs = null
    setAutoDisarmed(true)
    setAutoHoldStartTs(null)
    setCaptureRefusal(null)
  }

  const waitForModelResult = deadline => new Promise(resolve => {
    const remaining = Math.max(0, deadline - performance.now())
    const timer = window.setTimeout(() => {
      pendingCaptureRetryRef.current = null
      resolve(false)
    }, remaining)
    pendingCaptureRetryRef.current = ok => {
      window.clearTimeout(timer)
      pendingCaptureRetryRef.current = null
      resolve(Boolean(ok))
    }
    // No-op when a detection is already running: its result resolves the wait.
    // Otherwise request one immediately.
    liveScheduleRef.current?.(0)
  })

  const captureWithFreshGeometry = async ({ auto = false, attemptRecord = null } = {}) => {
    if (captureInFlightRef.current) return false
    captureInFlightRef.current = true
    const mode = auto ? 'auto' : 'manual'
    // The policy only decides when automatic capture fires; a manual tap keeps
    // today's quad gates and fallback behaviour.
    const framing = auto && capturePolicyRef.current === 'framing'
    const record = attemptRecord || createCaptureAttempt(mode)
    // A manual attempt is finalised by its caller after the full-frame fallback
    // has had its turn; only an automatic attempt ends here on refusal.
    const finishRefusal = (reason, extra = {}) => {
      if (record.trigger === 'auto') {
        finalizeCaptureAttempt(record, {
          outcome: 'refused',
          refusalReason: refusalReasonText(reason),
          ...extra,
        })
      }
      return false
    }
    try {
      // Two passes at most: the first may fail on stale geometry, then a fresh
      // detection is requested and the capture is retried once.
      for (let pass = 0; pass < 2; pass += 1) {
        const retry = pass > 0
        const now = performance.now()
        const sinceDisagreementMs = lastDisagreementAtRef.current == null
          ? null
          : Math.round(now - lastDisagreementAtRef.current)
        const sinceAgreementMs = lastAgreementAtRef.current == null
          ? null
          : Math.round(now - lastAgreementAtRef.current)
        const decisionAt = {
          trackerHits: trackerStatsRef.current.hits,
          trackerFailures: trackerFailuresRef.current,
          agreement: lastAgreementRef.current,
          pendingReanchor: lastDecisionRef.current === 'reanchor'
            || tentativeRef.current != null,
        }
        const attempt = {
          edgeContainment: null,
          quadAspect: null,
          orientationRatio: null,
          edgeVariance: null,
          sinceDisagreementMs,
          sinceAgreementMs,
          decisionAt,
        }
        const attemptFields = () => ({ ...attempt })
        lastAttemptFieldsRef.current = attemptFields()
        const hasTracked = trackedQuadRef.current != null
        const trackedAgeMs = hasTracked && trackerLastTsRef.current != null
          ? now - trackerLastTsRef.current
          : null
        // Age from the frame the model saw, not from when its result arrived:
        // inference can add a second, and a "fresh" result would otherwise
        // describe a stale frame.
        const modelAgeMs = lastModelFrameAtRef.current != null
          ? now - lastModelFrameAtRef.current
          : null
        const modelUsable = Boolean(liveResultRef.current?.usable)
        // Both policies keep fresh geometry: a tracked quad must be younger than
        // CAPTURE_QUAD_MAX_AGE_MS, otherwise the model quad must be younger than
        // CAPTURE_MODEL_MAX_AGE_MS. This is the freshness gate the framing policy
        // previously dropped.
        const freshness = shouldAcceptCapture({
          hasTracked,
          trackedAgeMs,
          modelAgeMs,
          modelUsable,
        })
        // The framing policy's presence guard names the quad to capture: a proven
        // tracker, else the recent detector quad. It keeps freshness, edge
        // containment, size and the hold, and drops only the aspect heuristic and
        // the separate detector-corroboration requirement.
        const presence = framing
          ? framingPresence({
            hasTrackedQuad: hasTracked,
            modelAgeMs: lastUsableModelAtRef.current == null
              ? null
              : now - lastUsableModelAtRef.current,
            trackerHits: trackerStatsRef.current.hits,
          })
          : null
        let decision
        if (framing) {
          if (!presence.ok) {
            decision = { ok: false, reason: 'no-presence', source: presence.source }
          } else if (!freshness.ok) {
            decision = { ok: false, reason: freshness.reason, source: freshness.source }
          } else {
            decision = { ok: true, reason: 'ok', source: freshness.source }
          }
        } else {
          decision = freshness
        }
        const quadAgeMs = decision.source === 'tracked'
          ? (trackedAgeMs == null ? null : Math.round(trackedAgeMs))
          : (modelAgeMs == null ? null : Math.round(modelAgeMs))
        if (!decision.ok) {
          recordDiagEvent('capture-attempt', {
            ok: false,
            retry,
            reason: decision.reason,
            waitedMs: null,
            quadAgeMs,
            frameTime: null,
            sharpness: null,
            corroborateAgeMs: null,
            sourceLongEdge: null,
            cardLongEdge: null,
            corroboration: 'none',
            ...attemptFields(),
          })
          if (!auto) return false
          if (!retry && liveDetectionRef.current) {
            setCaptureRechecking(true)
            const retryStarted = performance.now()
            const landed = await waitForModelResult(performance.now() + CAPTURE_RETRY_MS)
            setCaptureRechecking(false)
            if (landed) continue
            recordDiagEvent('capture-attempt', {
              ok: false,
              retry: true,
              reason: 'retry-timeout',
              waitedMs: Math.round(performance.now() - retryStarted),
              quadAgeMs,
              frameTime: null,
              sharpness: null,
              corroborateAgeMs: null,
              sourceLongEdge: null,
              cardLongEdge: null,
              corroboration: 'none',
              ...attemptFields(),
            })
          }
          if (auto) rearmAutoCapture()
          return finishRefusal(decision.reason, {
            quadSource: decision.source === 'tracked' ? 'tracker' : (decision.source === 'model' ? 'model' : 'none'),
            quadAgeMs,
          })
        }
        const corners = decision.source === 'tracked'
          ? trackedQuadRef.current
          : liveResultRef.current?.corners
        if (!corners) {
          recordDiagEvent('capture-attempt', {
            ok: false,
            retry,
            reason: 'no-quad',
            waitedMs: null,
            quadAgeMs,
            frameTime: null,
            sharpness: null,
            corroborateAgeMs: null,
            sourceLongEdge: null,
            cardLongEdge: null,
            corroboration: 'none',
            ...attemptFields(),
          })
          // The held quad disappeared before the frame could be cropped.
          if (auto) rearmAutoCapture()
          return finishRefusal('no-quad', { quadSource: 'none', quadAgeMs })
        }

        const confirmAgeMs = lastConfirmTsRef.current == null
          ? null
          : performance.now() - lastConfirmTsRef.current
        const captureSharpness = decision.source === 'model'
          ? (liveResultRef.current?.sharpness ?? null)
          : lastConfirmSharpnessRef.current
        const corroborateAgeMs = decision.source === 'model'
          ? 0
          : (confirmAgeMs == null ? null : Math.round(confirmAgeMs))
          const liveVideo = videoRef.current
          const frame = liveVideo?.videoWidth && liveVideo?.videoHeight
            ? { width: liveVideo.videoWidth, height: liveVideo.videoHeight }
            : null
          const contain = isContainableQuad(corners, {
            frame,
            minEdge: CAPTURE_EDGE_MIN,
            minAspect: CAPTURE_ASPECT_MIN,
            maxAspect: CAPTURE_ASPECT_MAX,
          })
          attempt.edgeContainment = Number(contain.edgeContainment.toFixed(4))
          attempt.quadAspect = Number(contain.quadAspect.toFixed(4))
          attempt.orientationRatio = Number(contain.orientationRatio.toFixed(4))
          lastAttemptFieldsRef.current = attemptFields()
          // Both policies require the whole card to be inside the frame. The
          // framing policy drops only the aspect band; the quad policy keeps it.
          const edgeOk = contain.edgeContainment >= CAPTURE_EDGE_MIN
          const containedOk = framing ? edgeOk : contain.ok
          const containCheck = framing
            ? (edgeOk ? null : 'edge')
            : (contain.check ?? 'aspect')
          if (auto) {
            // The pill names this cause for as long as the gate keeps refusing;
            // the next passing attempt or a different phase clears it.
            setCaptureRefusal(containedOk ? null : containCheck)
          }
          if (auto && !containedOk) {
            // The gate names the comparison that failed; the aspect band is
            // applied to the orientation-normalised ratio, so a sideways card
            // passes and its log describes the same number the gate compared.
            recordDiagEvent('capture-attempt', {
              ok: false,
              retry,
              reason: 'not-containable',
              check: containCheck,
              waitedMs: null,
              quadAgeMs,
              frameTime: null,
              sharpness: captureSharpness,
              corroborateAgeMs,
              sourceLongEdge: null,
              cardLongEdge: null,
              corroboration: 'none',
              ...attemptFields(),
            })
            liveScheduleRef.current?.(0)
            return finishRefusal(containCheck, {
              quadSource: decision.source === 'tracked' ? 'tracker' : 'model',
              quadAgeMs,
              contained: edgeOk,
              quadArea: Number(quadAreaFraction(corners).toFixed(4)),
            })
          }

        // The framing policy already established presence; it drops the
        // detector-corroboration requirement, including detector/tracker
        // agreement. The quad policy keeps the full check.
        let corroborated = false
        let trackerCorroborated = false
        let corroborationSource = 'none'
        if (framing) {
          corroborationSource = decision.source === 'tracked' ? 'tracker' : 'model'
        } else {
          corroborated = decision.source === 'model' || isCorroborated({
            lastConfirmTs: lastConfirmTsRef.current,
            now: performance.now(),
            quadAgreement: cornerAgreement({
              trackedCorners: corners,
              modelCorners: lastConfirmCornersRef.current,
            }),
          })
          // A tracker that has followed this quad for a dozen consecutive frames
          // is strong evidence of a card even while the detector's confidence is
          // too soft. It is a fallback, not a replacement for a fresh model result.
          trackerCorroborated = trackerFallbackEligible({
            source: decision.source,
            hits: trackerStatsRef.current.hits,
            failures: trackerFailuresRef.current,
            quadAgeMs,
            sinceDisagreementMs,
            sinceAgreementMs,
            maxQuadAgeMs: CAPTURE_QUAD_MAX_AGE_MS,
            disagreementWindowMs: CAPTURE_DISAGREE_MS,
            agreementWindowMs: CAPTURE_AGREE_MS,
          })
          corroborationSource = corroborated
            ? 'model'
            : (trackerCorroborated ? 'tracker' : 'none')
          if (auto && !corroborated && !trackerCorroborated) {
            recordDiagEvent('capture-attempt', {
              ok: false,
              retry,
              reason: 'uncorroborated',
              waitedMs: null,
              quadAgeMs,
              frameTime: null,
              sharpness: captureSharpness,
              corroborateAgeMs,
              sourceLongEdge: null,
              cardLongEdge: null,
              corroboration: 'none',
              ...attemptFields(),
            })
            if (!retry && liveDetectionRef.current) {
              setCaptureRechecking(true)
              const retryStarted = performance.now()
              const landed = await waitForModelResult(performance.now() + CAPTURE_RETRY_MS)
              setCaptureRechecking(false)
              if (landed) continue
              recordDiagEvent('capture-attempt', {
                ok: false,
                retry: true,
                reason: 'retry-timeout',
                waitedMs: Math.round(performance.now() - retryStarted),
                quadAgeMs,
                frameTime: null,
                sharpness: captureSharpness,
                corroborateAgeMs,
                sourceLongEdge: null,
                cardLongEdge: null,
                corroboration: 'none',
                ...attemptFields(),
              })
            }
            // This block only runs for auto-capture, which only starts after a
            // completed hold, so the refusal cue is never a positioning nudge.
            rearmAutoCapture()
            return finishRefusal('uncorroborated', {
              quadSource: decision.source === 'tracked' ? 'tracker' : 'model',
              quadAgeMs,
              contained: contain.edgeContainment >= CAPTURE_EDGE_MIN,
              quadArea: Number(quadAreaFraction(corners).toFixed(4)),
            })
          }
        }

        // Native-resolution crop of a generous box around the card: no warp, no
        // rotation, no fixed output size. The recogniser reads the camera's own
        // pixels better than a resampled rectification.
        const acquisition = await acquireVideoFrame(corners)
        if (!acquisition.ok) {
          setCaptureNote(
            acquisition.reason === 'stalled'
              ? 'The camera did not deliver a new frame; nothing captured.'
              : 'The video frame is not ready; nothing captured.',
          )
          recordDiagEvent('capture-attempt', {
            ok: false,
            retry,
            reason: acquisition.reason,
            waitedMs: acquisition.waitedMs,
            quadAgeMs,
            frameTime: acquisition.frameTime,
            sharpness: captureSharpness,
            corroborateAgeMs,
            sourceLongEdge: null,
            cardLongEdge: null,
            corroboration: corroborationSource,
            ...attemptFields(),
          })
          // A completed hold ended with nothing captured: the camera never
          // produced a fresh frame, which the user cannot see.
          if (auto) rearmAutoCapture()
          return finishRefusal(acquisition.reason, {
            quadSource: decision.source === 'tracked' ? 'tracker' : 'model',
            quadAgeMs,
            contained: contain.edgeContainment >= CAPTURE_EDGE_MIN,
            quadArea: Number(quadAreaFraction(corners).toFixed(4)),
          })
        }

        // The frame is now committed to this capture attempt; a retry must wait
        // for a different decoded frame.
        lastCapturedFrameTimeRef.current = acquisition.frameTime

        const blob = await new Promise(resolve => {
          acquisition.canvas.toBlob(resolve, 'image/jpeg', 0.92)
        })
        if (!blob) {
          setCaptureNote('The capture could not be encoded; nothing captured.')
          recordDiagEvent('capture-attempt', {
            ok: false,
            retry,
            reason: 'encode',
            waitedMs: acquisition.waitedMs,
            quadAgeMs,
            frameTime: acquisition.frameTime,
            sharpness: captureSharpness,
            corroborateAgeMs,
            sourceLongEdge: acquisition.sourceLongEdge,
            cardLongEdge: acquisition.cardLongEdge,
            corroboration: corroborationSource,
            ...attemptFields(),
          })
          if (auto) rearmAutoCapture()
          return finishRefusal('encode', {
            quadSource: decision.source === 'tracked' ? 'tracker' : 'model',
            quadAgeMs,
            contained: contain.edgeContainment >= CAPTURE_EDGE_MIN,
            quadArea: Number(quadAreaFraction(corners).toFixed(4)),
            stagedBox: { ...acquisition.sourceRect },
          })
        }

        // Focus proxy: annotation for manual captures, and a low-detail skip for
        // automatic ones. The backend's 500 threshold is measured on a 2048 px
        // copy, so this live number is not directly comparable to it.
        let focusVariance = null
        try {
          const focusScale = Math.min(
            1,
            512 / Math.max(acquisition.canvas.width, acquisition.canvas.height),
          )
          const focusWidth = Math.max(1, Math.round(acquisition.canvas.width * focusScale))
          const focusHeight = Math.max(1, Math.round(acquisition.canvas.height * focusScale))
          const focusCanvas = document.createElement('canvas')
          focusCanvas.width = focusWidth
          focusCanvas.height = focusHeight
          const focusContext = focusCanvas.getContext('2d', { willReadFrequently: true })
          focusContext.drawImage(acquisition.canvas, 0, 0, focusWidth, focusHeight)
          const gray = toFocusGrayscale(
            focusContext.getImageData(0, 0, focusWidth, focusHeight),
          )
          focusVariance = Math.round(edgeVariance(gray.data, gray.width, gray.height))
        } catch {
          focusVariance = null
        }
        attempt.edgeVariance = focusVariance
        if (auto && focusVariance != null && focusVariance < CAPTURE_LOW_DETAIL) {
          recordDiagEvent('capture-attempt', {
            ok: false,
            retry,
            reason: 'low-detail',
            check: 'edge-variance',
            waitedMs: acquisition.waitedMs,
            quadAgeMs,
            frameTime: acquisition.frameTime,
            sharpness: captureSharpness,
            corroborateAgeMs,
            sourceLongEdge: acquisition.sourceLongEdge,
            cardLongEdge: acquisition.cardLongEdge,
            corroboration: corroborationSource,
            ...attemptFields(),
          })
          lastAttemptFieldsRef.current = attemptFields()
          liveScheduleRef.current?.(0)
          return finishRefusal('low-detail', {
            quadSource: decision.source === 'tracked' ? 'tracker' : 'model',
            quadAgeMs,
            contained: contain.edgeContainment >= CAPTURE_EDGE_MIN,
            quadArea: Number(quadAreaFraction(corners).toFixed(4)),
            stagedBox: { ...acquisition.sourceRect },
          })
        }

        if (trayUnsentCount() >= TRAY_CAPACITY) {
          setCaptureNote(`Tray full · Review & send ${TRAY_CAPACITY}`)
          if (auto) disarmAutoCapture()
          return finishRefusal('tray-full', {
            quadSource: decision.source === 'tracked' ? 'tracker' : 'model',
            quadAgeMs,
            contained: contain.edgeContainment >= CAPTURE_EDGE_MIN,
            quadArea: Number(quadAreaFraction(corners).toFixed(4)),
            stagedBox: { ...acquisition.sourceRect },
          })
        }
        // Geometry provenance for this exact acquisition. The quad is the one
        // this capture used, mapped into the encoded crop's integer, clamped
        // rect; the evidence is the same decision that passed the gates above.
        const geometry = buildCaptureGeometry({
          quad: corners,
          cropRect: acquisition.sourceRect,
          // Corners are frame-normalised; this is the frame they were
          // normalised against, from the same acquisition that cropped them.
          frame: { width: acquisition.frameWidth, height: acquisition.frameHeight },
          encodedWidth: acquisition.encodedWidth,
          encodedHeight: acquisition.encodedHeight,
          source: decision.source === 'tracked' ? 'same-frame-track' : 'same-frame-model',
          modelScore: captureSharpness,
          modelAgeMs: modelAgeMs == null ? null : Math.round(modelAgeMs),
          agreement: decisionAt.agreement ?? null,
          pendingReanchor: decisionAt.pendingReanchor,
          frameEdgeMargin: attempt.edgeContainment,
          quadAspect: attempt.quadAspect,
          paddingClipped: acquisition.paddingClipped,
        })
        const file = new File([blob], `card-${Date.now()}.jpg`, { type: 'image/jpeg' })
        const created = addFiles([file], 'Phone browser', {
          rotationCW: sessionRotationRef.current,
          geometry,
        })
        if (created[0]) {
          stageDock(
            created[0],
            corners,
            acquisition.sourceRect,
            pendingRef.current.length + 1,
          )
          attemptByItemIdRef.current.set(created[0].id, record)
        }
        // A capture resets hunting to full speed for the next card.
        lastUsableAtRef.current = performance.now()
        // Reuse the existing appearance signature for both the re-arm baseline
        // and the duplicate check against the previous staged capture.
        const appearance = appearanceAgainstLast(acquisition.canvas, lastStagedSignatureRef.current)
        capturedSignatureRef.current = appearance.signature
        if (appearance.signature) lastStagedSignatureRef.current = appearance.signature
        record.quadSource = decision.source === 'tracked' ? 'tracker' : 'model'
        record.quadAgeMs = quadAgeMs
        record.contained = contain.edgeContainment >= CAPTURE_EDGE_MIN
        record.quadArea = Number(quadAreaFraction(corners).toFixed(4))
        record.stagedBox = { ...acquisition.sourceRect }
        record.regionCheck = regionCheckFor(corners, acquisition)
        record.appearanceSimilarity = appearance.similarity
        record.duplicateSuspected = appearance.duplicate
        rearmChangedStreakRef.current = 0
        lastRearmCheckAtRef.current = 0
        lastRearmFrameTimeRef.current = null
        // The success beat starts only once the File exists and is staged.
        setCaptureBeatAt(performance.now())
        if (soundOn) playCaptureSuccess()
        markAttemptStaged(record)
        recordDiagEvent('capture', {
          mode,
          rectified: false,
          corners,
          // Enough to reconstruct the encoded crop without the server: the
          // integer source rect and the quad relative to it.
          cropRect: acquisition.sourceRect,
          cropQuad: geometry ? geometry.quad : null,
          areaFraction: Number(quadAreaFraction(corners).toFixed(4)),
          sourceLongEdge: acquisition.sourceLongEdge,
          cardLongEdge: acquisition.cardLongEdge,
          jpegBytes: blob.size,
          quadSource: decision.source,
          edgeVariance: focusVariance,
          corroboration: corroborationSource,
          gatesApplied: record.gatesApplied,
          ...(corroborationSource === 'tracker'
            ? {
              trackerHits: trackerStatsRef.current.hits,
              trackerFailures: trackerFailuresRef.current,
              sinceUsableMs: lastUsableModelAtRef.current == null
                ? null
                : Math.round(performance.now() - lastUsableModelAtRef.current),
            }
            : {}),
        })
        recordDiagEvent('capture-attempt', {
          ok: true,
          retry,
          reason: 'ok',
          waitedMs: acquisition.waitedMs,
          quadAgeMs,
          frameTime: acquisition.frameTime,
          sharpness: captureSharpness,
          corroborateAgeMs,
          sourceLongEdge: acquisition.sourceLongEdge,
          cardLongEdge: acquisition.cardLongEdge,
          corroboration: corroborationSource,
          ...attemptFields(),
        })
        lastAttemptFieldsRef.current = attemptFields()
        // Start hunting for the next card while the user is still panning.
          liveScheduleRef.current?.(CAPTURE_HUNT_DELAY_MS)
        if (auto) disarmAutoCapture()
        return true
      }
      return false
    } finally {
      captureInFlightRef.current = false
    }
  }

  const captureFrame = () => {
    primeCaptureAudio()
    // One manual attempt spans the geometry capture and its full-frame fallback:
    // the tap is the attempt, not each internal step.
    const record = createCaptureAttempt('manual')
    if (liveDetectionRef.current) {
      // A tap is a decision: if freshness or the automatic gates refuse, stage
      // a full frame rather than refusing the collector.
      void captureWithFreshGeometry({ auto: false, attemptRecord: record }).then(ok => {
        if (ok) return
        recordDiagEvent('capture-attempt', {
          ok: false,
          retry: false,
          reason: 'manual-fallback',
          waitedMs: null,
          quadAgeMs: null,
          frameTime: null,
          sharpness: null,
          corroborateAgeMs: null,
          sourceLongEdge: null,
          cardLongEdge: null,
          corroboration: 'none',
          ...(lastAttemptFieldsRef.current || {}),
        })
        captureFullFrame({ attemptRecord: record })
      })
      return
    }
    // No live geometry to check: the full-frame path applies no policy gate.
    record.gatesApplied = []
    captureFullFrame({ attemptRecord: record })
  }

  const stopAutoFireTimer = () => {
    if (autoFireTimerRef.current != null) {
      window.clearInterval(autoFireTimerRef.current)
      autoFireTimerRef.current = null
    }
  }

  const fireAutoCaptureIfDue = () => {
    const state = autoStateRef.current
    if (!autoCaptureRef.current || !liveDetectionRef.current) return
    if (sheetOpenRef.current) return
    if (captureInFlightRef.current) return
    if (state.disarmed || state.anchorTs == null) return
    const now = performance.now()
    if (now - state.anchorTs < AUTO_STABLE_MS) return
    stopAutoFireTimer()

    // Clock-driven close: waiting for the next model result would leave the ring
    // at 100% with nothing happening for up to another second. Geometry and
    // frame freshness are checked inside the capture, which disarms on success
    // and re-arms on a stale look.
    state.anchorCorners = null
    state.anchorTs = null
    state.lastCorners = null
    state.lastQualifyingTs = null
    setAutoHoldStartTs(null)
    void captureWithFreshGeometry({ auto: true })
  }

  const startAutoFireTimer = () => {
    // A window restart is not a reason to churn the interval: the fire check
    // re-reads the anchor every tick and refuses to fire before AUTO_STABLE_MS.
    if (autoFireTimerRef.current != null) return
    autoFireTimerRef.current = window.setInterval(
      () => autoFireRef.current?.(),
      AUTO_FIRE_CHECK_MS,
    )
  }

  const startAutoWindow = (corners, now, source = 'tracked') => {
    const state = autoStateRef.current
    state.anchorCorners = corners
    state.anchorTs = now
    state.lastCorners = corners
    state.lastQualifyingTs = now
    state.lastSource = source
    setAutoHoldStartTs(now)
    startAutoFireTimer()
  }

  // One observation of the held card: a model result, or a fresh tracked quad.
  // Judge tracked speed (motion blur) and a loose pan distance; positional drift
  // is free because the warp uses the same frame's geometry.
  const noteAutoObservation = (corners, now, source = 'tracked') => {
    const state = autoStateRef.current
    if (sheetOpenRef.current || !autoCaptureRef.current || state.disarmed || !corners) return
    const decision = autoHoldDecision({
      anchorCorners: state.anchorCorners,
      lastCorners: state.lastCorners,
      corners,
      now,
      lastQualifyingTs: state.lastQualifyingTs,
      source,
      lastSource: state.lastSource || 'tracked',
    })
    if (decision.action === 'start') {
      startAutoWindow(corners, now, source)
      return
    }
    if (decision.action === 'restart') {
      // A moving card restarts the clock every tracked frame; only log resets
      // that ended a real hold attempt, not that churn.
      const heldMs = state.anchorTs == null ? 0 : now - state.anchorTs
      if (heldMs >= 150) {
        recordDiagEvent('hold-reset', {
          reason: decision.reason,
          heldMs: Math.round(heldMs),
          step: decision.step == null ? null : Number(decision.step.toFixed(4)),
          total: decision.total == null ? null : Number(decision.total.toFixed(4)),
        })
      }
      // Only sustained motion restarts the window; gap resets are a stalled loop.
      startAutoWindow(corners, now, source)
      return
    }
    state.lastCorners = corners
    state.lastQualifyingTs = now
    state.lastSource = source
    // The clock-driven fire check owns closing; observations only judge motion.
  }

  // Content check for a new presentation: the tracked quad may never leave, so
  // compare the current look inside it with the captured one.
  const checkSignatureRearm = (corners, now) => {
    const captured = capturedSignatureRef.current
    if (!captured) return
    if (now - lastRearmCheckAtRef.current < REARM_CHECK_INTERVAL_MS) return
    lastRearmCheckAtRef.current = now
    try {
      const video = videoRef.current
      if (!video || !video.videoWidth || !video.videoHeight) return
      const quad = trackedQuadRef.current || corners
      if (!quad || quad.length !== 4) return
      const xs = quad.map(([x]) => x * video.videoWidth)
      const ys = quad.map(([, y]) => y * video.videoHeight)
      const boxWidth = Math.max(1, Math.max(...xs) - Math.min(...xs))
      const boxHeight = Math.max(1, Math.max(...ys) - Math.min(...ys))
      const padX = Math.round(boxWidth * CAPTURE_BOX_PAD_FRACTION)
      const padY = Math.round(boxHeight * CAPTURE_BOX_PAD_FRACTION)
      const minX = Math.max(0, Math.floor(Math.min(...xs) - padX))
      const maxX = Math.min(video.videoWidth, Math.ceil(Math.max(...xs) + padX))
      const minY = Math.max(0, Math.floor(Math.min(...ys) - padY))
      const maxY = Math.min(video.videoHeight, Math.ceil(Math.max(...ys) + padY))
      const width = maxX - minX
      const height = maxY - minY
      if (!(width > 1) || !(height > 1)) return
      const frameTime = video.currentTime
      if (frameTime === lastRearmFrameTimeRef.current) return
      lastRearmFrameTimeRef.current = frameTime
      const distance = signatureDistance(
        captured,
        signatureOf(video, minX, minY, width, height),
      )
      const suppressed = lastStagedAtRef.current > 0
        && now - lastStagedAtRef.current < REARM_CHANGED_COOLDOWN_MS
      recordDiagEvent('rearm-check', {
        distance: Number.isFinite(distance) ? Number(distance.toFixed(4)) : null,
        trackHits: trackerStatsRef.current.hits,
        suppressed,
      })
      if (!Number.isFinite(distance)) return
      rearmChangedStreakRef.current = nextRearmStreak(
        distance,
        rearmChangedStreakRef.current,
        suppressed,
      )
      if (shouldRearmByChange(distance, rearmChangedStreakRef.current, suppressed)) {
        recordDiagEvent('auto-rearm', { reason: 'changed' })
        // A changed look inside the same quad is a new card: its presence clock
        // starts now, not when the previous card first appeared.
        presenceSincePerfRef.current = performance.now()
        rearmAutoCapture()
      }
    } catch {
      // A failed read must never re-arm or break the loop.
      rearmChangedStreakRef.current = 0
    }
  }

  // Deliberate physical-presentation heuristic, not card identity: two identical
  // copies in a row still require the card to be removed and replaced.
  const evaluateAutoCapture = result => {
    const now = performance.now()
    // Presence is the first observation of the card currently in view, used for
    // time-to-stage. It survives a capture in flight and a paused sheet; it
    // resets only when neither a usable model quad nor a live tracked quad
    // describes a card.
    const trackedNow = trackedQuadRef.current
    const trackerPresent = trackedNow != null
      && trackerLastTsRef.current != null
      && now - trackerLastTsRef.current <= AUTO_TRACK_OBS_MAX_AGE_MS
    const modelPresent = result.usable && result.area >= MIN_CARD_AREA
    if (modelPresent || trackerPresent) {
      if (presenceSincePerfRef.current == null) presenceSincePerfRef.current = now
    } else {
      presenceSincePerfRef.current = null
    }
    if (captureInFlightRef.current) return
    // The inspection sheet is an explicit pause: it neither accumulates nor
    // re-arms a hold while the collector is looking at a capture.
    if (sheetOpenRef.current) return
    const state = autoStateRef.current
    const qualifies = modelPresent
    const resetWindow = () => {
      state.anchorCorners = null
      state.anchorTs = null
      state.lastCorners = null
      state.lastQualifyingTs = null
      state.lastSource = 'tracked'
      stopAutoFireTimer()
      setAutoHoldStartTs(null)
    }

    if (!qualifies) {
      resetWindow()
      if (state.disarmed) {
        if (state.absentSince == null) state.absentSince = now
        if (now - state.absentSince >= AUTO_REARM_MS) {
          state.disarmed = false
          state.absentSince = null
          capturedSignatureRef.current = null
          rearmChangedStreakRef.current = 0
          lastRearmCheckAtRef.current = 0
          lastRearmFrameTimeRef.current = null
          setAutoDisarmed(false)
          setCaptureNote('')
          recordDiagEvent('auto-rearm', { reason: 'absent' })
          liveScheduleRef.current?.(0)
        }
      }
      return
    }
    state.absentSince = null
    if (state.disarmed) {
      // A card still in view is the same presentation: one automatic capture.
      // Retaking is deliberate, via the manual Capture button. A changed look
      // inside the same quad is a new card, so let content re-arm it.
      checkSignatureRearm(result.corners, now)
      return
    }
    if (!autoCaptureRef.current) {
      resetWindow()
      return
    }

    // A fresh tracked quad is a better observation than the model result it
    // arrived with: it is camera-rate geometry, and the two can disagree by up
    // to TRACK_AGREE_MAX without meaning the card moved. Use one quads stream so
    // switching sources never looks like a jump.
    const tracked = trackedQuadRef.current
    const trackerFresh = tracked != null
      && trackerLastTsRef.current != null
      && now - trackerLastTsRef.current <= AUTO_TRACK_OBS_MAX_AGE_MS
    noteAutoObservation(
      trackerFresh ? tracked : result.corners,
      now,
      trackerFresh ? 'tracked' : 'model',
    )
  }

  // The detection frame is kept until its result is consumed; a stale frame
  // (wrong seq) is never paired with newer corners.
  function consumeDetectionFrame(seq) {
    const frame = detectionFrameRef.current
    if (!frame) return null
    if (seq != null && frame.seq !== seq) return null
    detectionFrameRef.current = null
    return frame
  }

  const handleLiveResult = message => {
    if (!liveDetectionRef.current) {
      liveInFlightRef.current = false
      return
    }
    liveInFlightRef.current = false
    if (message.verification) setWebgpuVerification(message.verification)
    const result = { ...message, area: quadAreaFraction(message.corners) }
    liveResultRef.current = result
    setLiveResult(result)

    const now = performance.now()
    modelIntervalMsRef.current = lastDetectionAtRef.current == null
      ? null
      : Math.round(now - lastDetectionAtRef.current)
    lastDetectionAtRef.current = now
    // The model quad describes the frame at request time, not result time.
    const resultFrame = detectionFrameRef.current
    lastModelFrameAtRef.current = resultFrame && resultFrame.seq === message.seq
      ? resultFrame.postedAt
      : now
    // A fresh model result no longer clears the tracker-lost state by itself:
    // the phase is derived from consecutive misses, not from model results.
    setLiveState(
      result.usable
        ? 'tracking'
        : (motionScoreRef.current > IDLE_MOTION_THRESHOLD ? 'moving' : 'idle'),
    )
    if (liveLastTsRef.current != null) {
      const interval = now - liveLastTsRef.current
      liveIntervalRef.current = liveIntervalRef.current == null
        ? interval
        : liveIntervalRef.current * 0.7 + interval * 0.3
      setLiveFps(Math.round(1000 / liveIntervalRef.current))
    }
    liveLastTsRef.current = now

    // A model result must not destroy a healthy tracker: its patches come from
    // a frame ~300 ms old, and rebuilding from it makes the first track chase
    // the distance the card moved. Keep a recent, agreeing tracker as-is.
    const tracker = trackerRef.current
    const trackedNow = trackedQuadRef.current
    const trackerAge = trackerLastTsRef.current == null
      ? null
      : now - trackerLastTsRef.current
    const trackerStale = result.usable
      && trackerAge != null
      && trackerAge > TRACK_STALE_RESET_MS
    if (trackerStale) {
      recordDiagEvent('track-stale', { ageMs: Math.round(trackerAge) })
    }
    const decision = result.usable
      ? (trackerStale ? 'reset' : shouldKeepTracking({
        trackedCorners: trackedNow,
        modelCorners: result.corners,
        ageMs: trackerAge,
      }))
      : (trackedNow && trackerAge != null && trackerAge <= TRACK_KEEP_MS ? 'keep' : 'reset')
    const agreement = result.usable
      ? cornerAgreement({ trackedCorners: trackedNow, modelCorners: result.corners })
      : null
    recordDiagEvent('model', {
      detectMs: message.ms ?? null,
      sharpness: result.sharpness ?? null,
      area: result.area ?? null,
      usable: result.usable,
      unusableReason: result.unusableReason ?? null,
      source: result.source,
      seq: message.seq ?? null,
      detectParts: message.detectParts ?? null,
    })
    recordDiagEvent('decision', {
      decision,
      agreement: agreement == null ? null : Number(agreement.toFixed(4)),
      threshold: TRACK_AGREE_MAX,
    })
    lastDecisionRef.current = decision
    lastAgreementRef.current = agreement == null ? null : Number(agreement.toFixed(4))
    if (result.usable && decision === 'keep') lastAgreementAtRef.current = now
    if (result.usable && decision === 'reanchor') lastDisagreementAtRef.current = now

    if (decision === 'keep') {
      // Geometry and patches stay with the tracker; the model only refreshes
      // the shape anchor, and the model is still the authority on sharpness.
      tentativeRef.current = null
      if (result.usable) {
        tracker.refreshAnchor(result.corners)
        // The detector has just agreed with this geometry: the only evidence
        // that may later authorise an automatic capture.
        lastConfirmTsRef.current = now
        lastConfirmCornersRef.current = result.corners
        lastConfirmSharpnessRef.current = result.sharpness ?? null
      }
      // An accepted result earns a brief solid confirmation; a reanchor seed
      // or discard does not.
      if (result.usable) setConfirmPulseUntil(performance.now() + CONFIRM_PULSE_MS)
      detectionFrameRef.current = null
    } else if (decision === 'reanchor') {
      // Disagreement is not proof the tracker is wrong (the model quad can be
      // bad on a moving card). Probe a tentative reference while the healthy
      // tracker keeps running; only a confirmed tentative replaces it.
      const sample = consumeDetectionFrame(message.seq)
      if (sample) {
        try {
          const tentative = createTracker()
          tentative.setReference(sample.gray, sample.width, sample.height, result.corners)
          tentativeRef.current = {
            tracker: tentative,
            hits: 0,
            misses: 0,
            modelCorners: result.corners,
            sharpness: result.sharpness ?? null,
          }
          recordDiagEvent('reanchor', { agreement: agreement == null ? null : Number(agreement.toFixed(4)) })
          startTrackerLoop()
        } catch {
          // Keep the live tracker; the next model result can try again.
        }
      }
    } else {
      // Recovery path: nothing healthy to preserve, so commit the model quad.
      tentativeRef.current = null
      tracker.reset()
      trackedQuadRef.current = null
      trackerFailuresRef.current = 0
      trackInLostRef.current = false
      trackerLastTsRef.current = null
      trackerFpsRef.current = null
      trackerStatsRef.current = { hits: 0, attempts: 0, reason: 'frame' }
      lastTrackFrameTimeRef.current = null
      setTrackerStats({ hits: 0, attempts: 0, reason: 'frame' })
      if (result.usable) {
        try {
          // The reference must be the exact frame those corners came from; a
          // fresh grab after ~300 ms of inference would already be stale.
          const sample = consumeDetectionFrame(message.seq)
          if (sample) {
            tracker.setReference(sample.gray, sample.width, sample.height, result.corners)
            lastAgreementAtRef.current = now
            startTrackerLoop()
          }
        } catch {
          tracker.reset()
        }
      }
    }

    evaluateAutoCapture(result)
    // A capture waiting on stale geometry retries as soon as this result lands.
    pendingCaptureRetryRef.current?.(true)
    // Hunting (no usable card) is latency-bound: start the next look as soon as
    // inference ends. A usable card keeps the relaxed cadence because the
    // tracker carries the outline and the phone should not burn in the meantime.
    // After 8 s of a still scene with no card, ease off to a slower hunt; the
    // loop must still look, just not flat out.
    const detectMs = Number.isFinite(message.ms) ? message.ms : 0
    if (result.usable) lastUsableAtRef.current = now
    if (result.usable) lastUsableModelAtRef.current = now
    const huntingFor = lastUsableAtRef.current == null
      ? 0
      : now - lastUsableAtRef.current
    const slowHunt = !result.usable
      && huntingFor >= HUNT_BACKOFF_MS
      && motionScoreRef.current <= IDLE_MOTION_THRESHOLD
    const nextDelay = result.usable
      ? Math.max(LIVE_MIN_INTERVAL_MS, 2 * detectMs)
      : Math.max(
        LIVE_MIN_INTERVAL_MS,
        detectMs + (slowHunt ? HUNT_BACKOFF_GAP_MS : HUNT_GAP_MS),
      )
    liveScheduleRef.current?.(nextDelay)
  }

  const drawLiveFrame = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return null
    const scale = Math.min(1, LIVE_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight))
    const width = Math.max(1, Math.round(video.videoWidth * scale))
    const height = Math.max(1, Math.round(video.videoHeight * scale))
    if (!liveCanvasRef.current) liveCanvasRef.current = new OffscreenCanvas(width, height)
    const canvas = liveCanvasRef.current
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    canvas.getContext('2d').drawImage(video, 0, 0, width, height)
    return canvas
  }

  const runLiveDetection = async () => {
    if (!liveDetectionRef.current || liveInFlightRef.current) return
    // Every early exit below must reschedule, or the timer chain ends and the page
    // looks alive (samples keep recording) while never looking at the camera again.
    // A recording showed 143 s of exactly that.
    if (status !== 'live') {
      liveScheduleRef.current?.(1000)
      return
    }

    // Auto-capture is always hunting for the next card, so never park in that
    // mode: holding a new card still is exactly what a parked loop waits for.
    // The idle optimisation remains for auto-off sessions with no card in view.
    if (!autoCaptureRef.current && !liveResultRef.current?.usable) {
      const motion = motionScoreRef.current
      const heartbeatDue = lastDetectionAtRef.current == null
        || performance.now() - lastDetectionAtRef.current >= IDLE_HEARTBEAT_MS
      if (Number.isFinite(motion) && motion <= IDLE_MOTION_THRESHOLD && !heartbeatDue) {
        liveParkedRef.current = true
        setLiveState('idle')
        return
      }
    }

    const worker = detectorWorkerRef.current
    const canvas = drawLiveFrame()
    if (!worker || !canvas) {
      // Transient: the video element not being ready must not end the chain.
      liveScheduleRef.current?.(500)
      return
    }
    // Keep the exact 640 px frame the model is about to see; its corners and
    // this grayscale copy line up, which makes the first tracker reference far
    // more reliable than a fresh video grab after the ~300 ms inference.
    // The frame is tagged with the request seq and stays until that result has
    // been consumed; only then is it cleared.
    const seq = LIVE_SEQ_BASE + (liveSeqRef.current += 1)
    try {
      const sample = readTrackerGray(canvas)
      if (sample) {
        let copy = detectionGrayRef.current
        if (!copy || copy.length !== sample.gray.length) {
          copy = new Float32Array(sample.gray.length)
          detectionGrayRef.current = copy
        }
        copy.set(sample.gray)
        detectionFrameRef.current = {
          gray: copy,
          width: sample.width,
          height: sample.height,
          seq,
          postedAt: performance.now(),
        }
      } else {
        detectionFrameRef.current = null
      }
    } catch {
      detectionFrameRef.current = null
    }
    liveParkedRef.current = false
    liveInFlightRef.current = true
    let bitmap = null
    try {
      bitmap = await createImageBitmap(canvas)
      if (!liveDetectionRef.current) {
        bitmap.close()
        detectionFrameRef.current = null
        liveInFlightRef.current = false
        return
      }
      worker.postMessage({ type: 'detect', bitmap, seq }, [bitmap])
      bitmap = null
    } catch (error) {
      bitmap?.close?.()
      detectionFrameRef.current = null
      liveInFlightRef.current = false
      setCaptureNote(`Live detection failed: ${error?.message || String(error)}`)
      liveScheduleRef.current?.(1000)
    }
  }

  // Cheap motion sample on one reused 128 px canvas. It never queues inference:
  // it only wakes a parked loop when the scene moves or the heartbeat is due.
  const sampleMotion = () => {
    if (!liveDetectionRef.current || motionBusyRef.current) return
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return
    motionBusyRef.current = true
    try {
      if (!motionCanvasRef.current) {
        motionCanvasRef.current = new OffscreenCanvas(MOTION_SAMPLE_SIZE, MOTION_SAMPLE_SIZE)
      }
      const canvas = motionCanvasRef.current
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(video, 0, 0, MOTION_SAMPLE_SIZE, MOTION_SAMPLE_SIZE)
      const gray = toGrayscale(
        context.getImageData(0, 0, MOTION_SAMPLE_SIZE, MOTION_SAMPLE_SIZE),
      )
      const score = computeMotionScore(motionLastGrayRef.current, gray)
      motionLastGrayRef.current = gray
      motionScoreRef.current = score
      const moving = score > IDLE_MOTION_THRESHOLD
      // Movement means the user may be presenting a card: restart full-speed
      // hunting rather than staying in the slow mode. This must apply whether
      // or not the loop is parked.
      if (moving && !liveResultRef.current?.usable) {
        lastUsableAtRef.current = performance.now()
      }
      if (!liveParkedRef.current) return
      const heartbeatDue = lastDetectionAtRef.current == null
        || performance.now() - lastDetectionAtRef.current >= IDLE_HEARTBEAT_MS
      if (!moving && !heartbeatDue) {
        setLiveState('idle')
        return
      }
      setLiveState(moving ? 'moving' : 'idle')
      liveParkedRef.current = false
      liveScheduleRef.current?.(0)
    } finally {
      motionBusyRef.current = false
    }
  }

  // The tracker writes a new quad every animation frame, so the geometry goes
  // straight into the overlay instead of through React state. Only the quad's
  // *source* is state: it flips once per model result, and it is the fallback
  // hint the overlay uses to tell a predicted quad from a detected one.
  const applyQuadToPolygon = (corners, { tracked = false } = {}) => {
    overlayRef.current?.setQuad(corners)
    const next = corners ? (tracked ? 'tracked' : 'model') : null
    if (quadSourceRef.current === next) return
    quadSourceRef.current = next
    setQuadSource(next)
  }

  // One 480 px scratch frame per tracker step, reused every animation frame.
  const readTrackerGray = source => {
    if (!source) return null
    const sourceWidth = source.videoWidth || source.width
    const sourceHeight = source.videoHeight || source.height
    if (!sourceWidth || !sourceHeight) return null
    const scale = Math.min(1, TRACK_MAX_EDGE / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * scale))
    const height = Math.max(1, Math.round(sourceHeight * scale))
    if (!trackerCanvasRef.current) trackerCanvasRef.current = new OffscreenCanvas(width, height)
    const canvas = trackerCanvasRef.current
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(source, 0, 0, width, height)
    const { data } = context.getImageData(0, 0, width, height)
    let gray = trackerGrayRef.current
    if (!gray || gray.length !== width * height) {
      gray = new Float32Array(width * height)
      trackerGrayRef.current = gray
    }
    for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
      gray[pixel] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    }
    return { gray, width, height, frameTime: source.currentTime }
  }

  const drawTrackerGray = () => readTrackerGray(videoRef.current)

  const runTrackerFrame = () => {
    trackerRafRef.current = null
    if (!liveDetectionRef.current) return
    try {
      const sample = drawTrackerGray()
      if (!sample) return
      const frameStarted = performance.now()

      // Probe a tentative re-anchor first. It never touches the live quad unless
      // it proves itself with two clean tracks in a row.
      const tentative = tentativeRef.current
      if (tentative) {
        const tentativeQuad = tentative.tracker.track(sample.gray, sample.width, sample.height)
        if (tentativeQuad) {
          tentative.hits += 1
          tentative.misses = 0
          if (evaluateTentative(tentative) === 'adopt') {
            trackerRef.current = tentative.tracker
            lastConfirmTsRef.current = performance.now()
            lastConfirmCornersRef.current = tentative.modelCorners
            lastConfirmSharpnessRef.current = tentative.sharpness
            lastAgreementAtRef.current = performance.now()
            tentativeRef.current = null
            trackedQuadRef.current = tentativeQuad
            trackerFailuresRef.current = 0
            trackerFpsRef.current = null
            trackerLastTsRef.current = performance.now()
            trackerStatsRef.current = { hits: 0, attempts: 0, reason: 'ok' }
            setTrackerStats({ hits: 0, attempts: 0, reason: 'ok' })
            setConfirmPulseUntil(performance.now() + CONFIRM_PULSE_MS)
            trackerFrameMsRef.current = Math.round(performance.now() - frameStarted)
            recordDiagEvent('adopt', { hits: tentative.hits, misses: tentative.misses })
            if (trackInLostRef.current) {
              trackInLostRef.current = false
              recordDiagEvent('track-recovered', { via: 'adopt' })
            }
            applyQuadToPolygon(tentativeQuad, { tracked: true })
            // The adopted quad is the detector's coordinate frame; the hold
            // clock continues and its step is not judged as movement.
            noteAutoObservation(tentativeQuad, performance.now(), 'model')
            trackerRafRef.current = window.requestAnimationFrame(() => trackerLoopRef.current?.())
            return
          }
        } else {
          tentative.misses += 1
          tentative.hits = 0
          if (evaluateTentative(tentative) === 'discard') {
            tentativeRef.current = null
            recordDiagEvent('discard', { hits: tentative.hits, misses: tentative.misses })
          }
        }
      }

      const tracker = trackerRef.current
      const tracked = tracker.track(sample.gray, sample.width, sample.height)
      trackerFrameMsRef.current = Math.round(performance.now() - frameStarted)
      const now = performance.now()
      const stats = trackerStatsRef.current
      stats.attempts += 1
      stats.reason = tracker.getLastReason()

      if (!tracked) {
        // A single bad frame is normal: keep the last quad and the phase, and
        // only call it lost after TRACK_LOST_AFTER consecutive misses.
        trackerFailuresRef.current += 1
        stats.hits = 0
        if (trackerFailuresRef.current >= TRACK_LOST_AFTER && !trackInLostRef.current) {
          trackInLostRef.current = true
          recordDiagEvent('track-lost', { failures: trackerFailuresRef.current })
        }
        if (now - trackerLastFpsPushRef.current >= 500) {
          trackerLastFpsPushRef.current = now
          setTrackerStats({ ...stats })
        }
        if (trackerFailuresRef.current >= TRACK_MAX_MISSES) {
          // A tentative candidate may still prove itself; keep the loop alive.
          if (tentativeRef.current) {
            trackerRafRef.current = window.requestAnimationFrame(() => trackerLoopRef.current?.())
            return
          }
          tracker.reset()
          trackedQuadRef.current = null
          trackerFpsRef.current = null
          trackerLastTsRef.current = null
          setTrackerFps(0)
          setTrackerStats({ ...stats })
          const model = liveResultRef.current
          if (model?.usable) applyQuadToPolygon(model.corners)
          return
        }
        trackerRafRef.current = window.requestAnimationFrame(() => trackerLoopRef.current?.())
        return
      }

      trackerFailuresRef.current = 0
      const newExposure = sample.frameTime == null
        || sample.frameTime !== lastTrackFrameTimeRef.current
      if (newExposure) {
        lastTrackFrameTimeRef.current = sample.frameTime
        stats.hits += 1
      }
      trackedQuadRef.current = tracked
      // A tracked quad is a camera-rate observation of the card between model
      // results; feed it to the hold window so per-step motion is judged from
      // the freshest geometry. It refines an open window but never opens one:
      // the model result stays the authority on whether the card qualifies.
      if (autoCaptureRef.current && autoStateRef.current.anchorTs != null) {
        noteAutoObservation(tracked, now, 'tracked')
      }
      if (trackInLostRef.current) {
        trackInLostRef.current = false
        recordDiagEvent('track-recovered', { via: 'live' })
      }
      applyQuadToPolygon(tracked, { tracked: true })
      if (trackerLastTsRef.current != null) {
        const interval = now - trackerLastTsRef.current
        trackerFpsRef.current = trackerFpsRef.current == null
          ? interval
          : trackerFpsRef.current * 0.8 + interval * 0.2
        if (now - trackerLastFpsPushRef.current >= 500) {
          trackerLastFpsPushRef.current = now
          setTrackerFps(Math.round(1000 / trackerFpsRef.current))
          setTrackerStats({ ...stats })
        }
      }
      trackerLastTsRef.current = now
    } catch {
      trackerFailuresRef.current += 1
      trackerStatsRef.current.hits = 0
      if (trackerFailuresRef.current >= TRACK_MAX_MISSES) {
        if (tentativeRef.current) {
          trackerRafRef.current = window.requestAnimationFrame(() => trackerLoopRef.current?.())
          return
        }
        trackerRef.current?.reset()
        trackedQuadRef.current = null
        setTrackerFps(0)
        return
      }
    }
    trackerRafRef.current = window.requestAnimationFrame(() => trackerLoopRef.current?.())
  }

  const startTrackerLoop = () => {
    if (trackerRafRef.current != null) return
    trackerRafRef.current = window.requestAnimationFrame(() => trackerLoopRef.current?.())
  }

  // Refs keep the worker callback and the scheduled loop current across renders.
  trackerLoopRef.current = runTrackerFrame
  autoFireRef.current = fireAutoCaptureIfDue
  liveLoopRef.current = runLiveDetection
  liveScheduleRef.current = delay => {
    liveScheduleMsRef.current = delay
    window.clearTimeout(liveTimerRef.current)
    liveTimerRef.current = window.setTimeout(() => liveLoopRef.current?.(), delay)
  }
  liveResultHandlerRef.current = handleLiveResult
  liveErrorHandlerRef.current = message => {
    liveInFlightRef.current = false
    setCaptureNote(`Live detection error: ${message.message || 'unknown error'}`)
    liveScheduleRef.current?.(1000)
  }

  const setLiveDetectionEnabled = enabled => {
    if (!enabled) {
      stopLiveDetection()
      return
    }
    if (status !== 'live' || detectorStatus !== 'ready') return
    liveDetectionRef.current = true
    setLiveDetection(true)
    setDetectorError('')
    setCaptureNote('')
    setAutoHoldStartTs(null)
    autoStateRef.current = newAutoState()
    motionLastGrayRef.current = null
    motionScoreRef.current = Infinity
    liveParkedRef.current = false
    lastDetectionAtRef.current = null
    lastModelFrameAtRef.current = null
    lastUsableAtRef.current = performance.now()
    window.clearInterval(motionTimerRef.current)
    motionTimerRef.current = window.setInterval(sampleMotion, MOTION_SAMPLE_INTERVAL_MS)
    startDiagRecorder()
    liveScheduleRef.current?.(0)
  }

  const setAutoCaptureEnabled = enabled => {
    autoCaptureRef.current = enabled
    setAutoCapture(enabled)
    try {
      window.localStorage.setItem('capture-lab-auto-capture', enabled ? '1' : '0')
    } catch {
      // A blocked localStorage only costs the preference, never the capture.
    }
    setAutoHoldStartTs(null)
    stopAutoFireTimer()
    autoStateRef.current = newAutoState()
    if (!enabled) {
      setAutoDisarmed(false)
      setCaptureNote('')
    } else {
      // Hunting starts now; never leave auto mode parked.
      liveParkedRef.current = false
      liveScheduleRef.current?.(0)
    }
  }

  const setCapturePolicy = policy => {
    const next = policy === 'framing' ? 'framing' : 'quad'
    capturePolicyRef.current = next
    setCapturePolicyState(next)
    try {
      window.localStorage.setItem(CAPTURE_POLICY_STORAGE_KEY, next)
    } catch {
      // A blocked localStorage only costs the preference, never the capture.
    }
    // A hold window started under one policy must not fire under another, and
    // a refusal named by the old gates no longer applies.
    setAutoHoldStartTs(null)
    stopAutoFireTimer()
    autoStateRef.current = newAutoState()
    setAutoDisarmed(false)
    setCaptureRefusal(null)
    if (autoCaptureRef.current) {
      liveParkedRef.current = false
      liveScheduleRef.current?.(0)
    }
  }

  const verifyWebgpuNow = () => {
    const worker = detectorWorkerRef.current
    if (!worker || detectorRuntimeActive !== 'webgpu' || webgpuVerifying) return
    setWebgpuVerifying(true)
    setWebgpuVerification(null)
    worker.postMessage({ type: 'verify' })
  }

  // Main-thread reachability probe for the support question: chrome://gpu says
  // accelerated, but workers have reported navigator.gpu as undefined.
  const checkWebgpu = async () => {
    setWebgpuProbe('checking…')
    const parts = [
      `typeof navigator.gpu=${typeof navigator.gpu}`,
      `secure=${Boolean(window.isSecureContext)}`,
    ]
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter()
        parts.push(adapter ? 'adapter ok' : 'no adapter')
        if (adapter) {
          let info = adapter.info
          if (!info && typeof adapter.requestAdapterInfo === 'function') {
            info = await adapter.requestAdapterInfo()
          }
          if (info) {
            const fields = ['vendor', 'architecture', 'description']
              .filter(key => typeof info[key] === 'string' && info[key])
              .map(key => `${key}=${info[key]}`)
            if (fields.length) parts.push(fields.join(' '))
          }
        }
      }
    } catch (error) {
      parts.push(`error=${error?.message || String(error)}`)
    }
    setWebgpuProbe(parts.join(' · '))
  }

  const updatePending = (id, patch) => {
    setPending(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }

  // Removal is shared by the pending list and the inspection sheet. The sheet
  // keeps the item alive for "Removed #4 · Undo" with its sequence, position
  // and rotation intact; the preview URL is revoked only when that offer
  // expires or is replaced.
  const dismissRemovedNotice = useCallback(() => {
    window.clearTimeout(removedTimerRef.current)
    removedTimerRef.current = null
    const current = removedNoticeRef.current
    if (current?.item?.previewUrl) URL.revokeObjectURL(current.item.previewUrl)
    removedNoticeRef.current = null
    setRemovedNotice(null)
  }, [])

  const removePending = useCallback((id, { undoable = false } = {}) => {
    const current = pendingRef.current
    const index = current.findIndex(item => item.id === id)
    if (index < 0) return
    const target = current[index]
    setPending(prev => prev.filter(item => item.id !== id))
    if (!undoable) {
      if (target.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return
    }
    dismissRemovedNotice()
    const notice = { item: target, index }
    removedNoticeRef.current = notice
    setRemovedNotice(notice)
    setDockAnnouncement(`Removed #${target.sequence}`)
    removedTimerRef.current = window.setTimeout(() => dismissRemovedNotice(), 8000)
  }, [dismissRemovedNotice])

  const undoRemoved = () => {
    const notice = removedNoticeRef.current
    if (!notice) return
    const { item, index } = notice
    removedNoticeRef.current = null
    window.clearTimeout(removedTimerRef.current)
    removedTimerRef.current = null
    setRemovedNotice(null)
    setPending(prev => {
      if (prev.some(entry => entry.id === item.id)) return prev
      const next = [...prev]
      next.splice(Math.min(index, next.length), 0, item)
      return next
    })
    setDockAnnouncement(`Restored #${item.sequence} · ${pendingRef.current.length + 1} in tray`)
  }

  const openInspector = id => {
    // Set synchronously: the fire timer ticks every 100 ms and must not squeeze
    // a capture in between the tap and the effect that pauses it.
    sheetOpenRef.current = true
    setInspectedId(id)
  }

  const closeInspector = () => {
    sheetOpenRef.current = false
    setInspectedId(null)
  }

  const rotateInspected = () => {
    if (!inspectedItem) return
    updatePending(inspectedItem.id, {
      rotationCW: nextRotationCW(inspectedItem.rotationCW),
    })
  }

  const useInspectedRotation = () => {
    if (!inspectedItem) return
    setSessionRotation(normalizeRotation(inspectedItem.rotationCW) ?? 0)
  }

  // A click only queues a scan job; adding to the collection still requires the normal review step.
  const submitSingleFileScan = (file, onProgress, rotationCW = null, geometry = null) =>
    enqueueScanJob([file], [], null, {
      onProgress,
      rotations: [rotationCW],
      geometries: [geometry],
    })

  const scanPending = async item => {
    updatePending(item.id, {
      scanStatus: 'uploading',
      scanProgress: 0,
      scanError: '',
      scanJobId: '',
    })
    try {
      const job = await submitSingleFileScan(item.file, progress => {
        updatePending(item.id, { scanProgress: scanUploadPercent(progress) })
      }, item.rotationCW, item.geometry)
      if (!mountedRef.current) return
      updatePending(item.id, { scanStatus: 'done', scanProgress: 100, scanJobId: job.id })
    } catch (error) {
      if (!mountedRef.current) return
      updatePending(item.id, { scanStatus: 'error', scanError: scanErrorMessage(error) })
    }
  }

  // One batch job for captures that have not been sent yet, each image its own
  // card. The list stays in place so the user can see what was sent and remove
  // it themselves; already-sent items are excluded so a second press cannot
  // submit the same images again.
  //
  // Files, rotations and ids all come from one frozen snapshot in sequence
  // order. Nothing here derives from the rail's visible order.
  const scanAllPending = async () => {
    if (batchScanRef.current) return
    const submission = buildTraySubmission(pending.filter(item => (
      item.scanStatus !== 'done' && item.scanStatus !== 'uploading'
    )))
    const { items, files } = submission
    if (items.length === 0) {
      setBatchScanMessage('All pending captures have already been scanned.')
      setBatchScanError('')
      return
    }
    batchScanRef.current = true
    setBatchScanning(true)
    setBatchScanMessage('')
    setBatchScanError('')
    items.forEach(item => updatePending(item.id, {
      scanStatus: 'uploading',
      scanProgress: 0,
      scanError: '',
      scanJobId: '',
    }))
    try {
      const job = await enqueueScanJob(
        files,
        files.map((_, index) => index),
        null,
        {
          // Omitted by the client when every item is "no choice".
          rotations: submission.rotations,
          // Same snapshot and order; omitted when no item has a frozen crop.
          geometries: submission.geometries,
          onProgress: progress => {
            if (progress.phase === 'prepare') {
              setBatchScanMessage(`Preparing ${progress.done} of ${progress.total}…`)
              return
            }
            if (progress.phase !== 'upload' || !progress.total) return
            const percent = scanUploadPercent(progress)
            items.forEach(item => updatePending(item.id, { scanProgress: percent }))
            const done = Math.min(
              items.length,
              Math.max(1, Math.ceil((percent / 100) * items.length)),
            )
            setBatchScanMessage(`Uploading ${done} of ${items.length}…`)
          },
        },
      )
      if (!mountedRef.current) return
      items.forEach(item => updatePending(item.id, {
        scanStatus: 'done',
        scanProgress: 100,
        scanJobId: job.id,
      }))
      setBatchScanMessage(
        `Sent ${items.length} capture${items.length === 1 ? '' : 's'} as job ${job.id}.`,
      )
    } catch (error) {
      if (!mountedRef.current) return
      const message = scanErrorMessage(error)
      items.forEach(item => updatePending(item.id, {
        scanStatus: 'error',
        scanError: message,
      }))
      setBatchScanError(`Batch scan failed: ${message}`)
    } finally {
      batchScanRef.current = false
      if (mountedRef.current) setBatchScanning(false)
    }
  }

  const updateStoredScan = (name, patch) => {
    setStoredScans(prev => ({
      ...prev,
      [name]: { ...(prev[name] || {}), ...patch },
    }))
  }

  const scanStoredCapture = async entry => {
    updateStoredScan(entry.name, { status: 'uploading', progress: 0, error: '', jobId: '' })
    try {
      const blob = await fetchCaptureLabFileBlob(entry.name)
      const file = new File([blob], entry.name, { type: blob.type || 'image/jpeg' })
      const job = await submitSingleFileScan(file, progress => {
        updateStoredScan(entry.name, { progress: scanUploadPercent(progress) })
      })
      if (!mountedRef.current) return
      updateStoredScan(entry.name, { status: 'done', progress: 100, jobId: job.id })
    } catch (error) {
      if (!mountedRef.current) return
      updateStoredScan(entry.name, { status: 'error', error: scanErrorMessage(error) })
    }
  }

  const saveItem = async item => {
    if (inFlightRef.current.has(item.id)) return
    inFlightRef.current.add(item.id)
    updatePending(item.id, { status: 'uploading', progress: 0, error: '' })
    // Link this upload back to the capture attempt that staged the file, so the
    // outcome log can report whether it reached the server.
    const attemptRecord = attemptByItemIdRef.current.get(item.id)
    if (attemptRecord) {
      attemptRecord.upload = { ok: null, status: 'uploading' }
      setAttempts([...attemptLogRef.current])
      recordDiagEvent('capture-upload', {
        attemptedAt: attemptRecord.attemptedAt,
        policy: attemptRecord.policy,
        trigger: attemptRecord.trigger,
        outcome: attemptRecord.outcome,
        upload: attemptRecord.upload,
      })
    }
    const trackSettings = trackInfo
      ? JSON.stringify({ settings: trackInfo.settings, capabilities: trackInfo.capabilities })
      : ''
    try {
      const created = await uploadCaptureLabImage(
        item.file,
        {
          condition: item.condition,
          card_label: item.card_label,
          route: item.route,
          note: item.note,
          track_settings: trackSettings,
        },
        { onProgress: progress => updatePending(item.id, { progress }) },
      )
      if (!mountedRef.current) return
      updatePending(item.id, { status: 'saved', progress: 100, savedName: created.name })
      if (attemptRecord) {
        attemptRecord.upload = { ok: true, status: 'saved' }
        setAttempts([...attemptLogRef.current])
        recordDiagEvent('capture-upload', {
          attemptedAt: attemptRecord.attemptedAt,
          policy: attemptRecord.policy,
          trigger: attemptRecord.trigger,
          outcome: attemptRecord.outcome,
          upload: attemptRecord.upload,
        })
      }
      queryClient.invalidateQueries({ queryKey: CAPTURE_LAB_QUERY_KEY })
    } catch (error) {
      if (!mountedRef.current) return
      updatePending(item.id, { status: 'error', error: errorMessage(error) })
      if (attemptRecord) {
        attemptRecord.upload = { ok: false, status: 'error' }
        setAttempts([...attemptLogRef.current])
        recordDiagEvent('capture-upload', {
          attemptedAt: attemptRecord.attemptedAt,
          policy: attemptRecord.policy,
          trigger: attemptRecord.trigger,
          outcome: attemptRecord.outcome,
          upload: attemptRecord.upload,
        })
      }
    } finally {
      inFlightRef.current.delete(item.id)
    }
  }

  const saveAll = async () => {
    const queue = pending.filter(item => item.status !== 'saved' && item.status !== 'uploading')
    for (const item of queue) {
      // Sequential so a phone uplink is not split across parallel uploads.
      // eslint-disable-next-line no-await-in-loop
      await saveItem(item)
    }
  }

  const downloadEntry = async entry => {
    setLibraryError('')
    try {
      const blob = await fetchCaptureLabFileBlob(entry.name)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = entry.name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      setLibraryError(`Download failed: ${errorMessage(error)}`)
    }
  }

  const deleteEntry = async entry => {
    const confirmed = await confirm({
      title: 'Delete capture',
      message: `Delete ${entry.name} from the Dev server? This removes the file and its metadata.`,
      confirmLabel: 'Delete',
    })
    if (!confirmed) return
    setLibraryError('')
    try {
      await deleteCaptureLabEntry(entry.name)
      queryClient.invalidateQueries({ queryKey: CAPTURE_LAB_QUERY_KEY })
    } catch (error) {
      setLibraryError(`Delete failed: ${errorMessage(error)}`)
    }
  }

  const cameraStatusMessage = {
    requesting: 'Requesting camera…',
    denied: 'Camera permission was denied. Allow camera access in the browser and retry.',
    'no-camera': 'No camera was found. Open this page on the phone that has one.',
    error: `The camera could not start${cameraError ? `: ${cameraError}` : '.'}`,
  }[status]

  const captures = data?.captures || []
  const scannablePending = pending.filter(item => (
    item.scanStatus !== 'done' && item.scanStatus !== 'uploading'
  ))
  const listDisabled = listError?.response?.status === 404

  // Session outcome summary for the compact panel and the POSTed report. The
  // median is over staged attempts only; a refused attempt has no stage time.
  const attemptSummary = useMemo(() => {
    const staged = attempts.filter(entry => entry.outcome === 'staged')
    const refused = attempts.filter(entry => entry.outcome === 'refused')
    const refusedByReason = {}
    for (const entry of refused) {
      const reason = entry.refusalReason || 'unknown'
      refusedByReason[reason] = (refusedByReason[reason] || 0) + 1
    }
    const times = staged
      .map(entry => entry.timeToStageMs)
      .filter(value => Number.isFinite(value))
      .sort((a, b) => a - b)
    let medianTimeToStageMs = null
    if (times.length) {
      const middle = Math.floor(times.length / 2)
      medianTimeToStageMs = times.length % 2
        ? times[middle]
        : Math.round((times[middle - 1] + times[middle]) / 2)
    }
    return {
      attempts: attempts.length,
      staged: staged.length,
      refused: refused.length,
      refusedByReason,
      medianTimeToStageMs,
      duplicatesSuspected: attempts.filter(entry => entry.duplicateSuspected === true).length,
      policy: capturePolicy,
    }
  }, [attempts, capturePolicy])

  const sendSessionReport = async () => {
    if (reportSend.status === 'sending') return
    setReportSend({ status: 'sending', message: '', error: '', id: null })
    const payload = {
      page: 'capture-lab',
      mode: 'session',
      device: {
        ua: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      },
      settings: {
        policy: capturePolicyRef.current,
        autoCapture: autoCaptureRef.current,
      },
      summary: attemptSummary,
      attempts: attempts.slice(-ATTEMPT_LOG_LIMIT).map(entry => ({ ...entry })),
    }
    try {
      const response = await api.post('/capture-lab/experiments', payload, { timeout: 120000 })
      setReportSend({
        status: 'sent',
        message: '',
        error: '',
        id: response?.data?.id ?? null,
      })
    } catch (error) {
      setReportSend({
        status: 'error',
        message: '',
        error: scanErrorMessage(error),
        id: null,
      })
    }
  }

  // What the overlay is showing. The lifecycle phases come from the auto-capture
  // window, including the brief 'locked' phase each accepted detection earns;
  // the overlay turns those into one eased lock strength rather than a
  // solid/dashed switch, so the 300 ms pulse does not flicker the ring.
  const overlayCardArea = liveResult?.usable ? liveResult.area : undefined
  const trackedArea = trackedQuadRef.current ? quadAreaFraction(trackedQuadRef.current) : null
  const overlayTooSmall = Boolean(
    liveResult?.usable
      ? liveResult.area < MIN_CARD_AREA
      : trackedArea != null && trackedArea < MIN_CARD_AREA,
  )
  const overlayHolding = Boolean(autoCapture && !autoDisarmed && autoHoldStartTs != null)
  // A recently successful tracked quad still owns the overlay even when the
  // latest model result is unusable or missing; only the absence of any quad
  // is 'none'. Area still wins when it is actionable.
  const trackerFresh = trackedQuadRef.current != null
    && trackerLastTsRef.current != null
    && performance.now() - trackerLastTsRef.current <= TRACK_PHASE_MAX_AGE_MS
  const phaseState = derivePhase({
    captureBeat: captureBeatAt != null,
    trackedFresh: trackerFresh,
    trackedTooSmall: overlayTooSmall,
    modelUsable: Boolean(liveResult?.usable),
    trackMisses: trackerFailuresRef.current,
    autoDisarmed,
    holding: overlayHolding,
    hasModel: liveResult != null,
    modelUnusableReason: liveResult?.unusableReason ?? null,
    confirmedPulse: performance.now() < confirmPulseUntil,
  })
  const overlayPhase = phaseState.phase
  const phaseReason = phaseState.reason
  diagPhaseRef.current = overlayPhase || 'none'
  phaseReasonRef.current = phaseReason

  // Phase transitions are events, not samples: record only when either the
  // phase or its reason changes, so the recording explains every 'none'.
  useEffect(() => {
    if (!liveDetectionRef.current) return
    const phaseKey = `${overlayPhase || 'none'}|${phaseReason}`
    if (lastPhaseRef.current === phaseKey) return
    lastPhaseRef.current = phaseKey
    recordDiagEvent('phase', { phase: overlayPhase || 'none', reason: phaseReason })
  }, [phaseReason, overlayPhase])

  // A refusal cause only means something while the gate is still judging a
  // card. Once the overlay moves to a state with its own copy (nothing seen,
  // lost, too small, captured) the old cause must not win the pill.
  useEffect(() => {
    if (overlayPhase === 'tracking' || overlayPhase === 'locked' || overlayPhase === 'holding') return
    setCaptureRefusal(null)
  }, [overlayPhase])

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Capture Lab</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Dev-only: photograph cards on the phone, then compare the exact JPEGs and camera
          metadata here. Nothing is scanned, recognised or added to the collection.
        </p>
      </div>

      {!window.isSecureContext ? (
        <div className="rounded-lg border border-yellow/40 bg-yellow/10 p-3 text-sm text-text-primary">
          This page is not a secure context, so the browser will not grant camera access over
          plain HTTP. Use HTTPS, or add the origin as a trusted secure context, before starting
          the camera. Gallery uploads still work.
        </div>
      ) : null}

      <section className="rounded-lg border border-border bg-bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-text-primary">Camera</h2>
          {status === 'live' ? (
            <>
              <button type="button" className="btn-primary-sm" onClick={captureFrame}>
                <Camera size={15} aria-hidden />
                Capture
              </button>
              <button type="button" className="btn-ghost-sm" onClick={stopCamera}>
                <VideoOff size={15} aria-hidden />
                Stop camera
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-primary-sm"
              disabled={status === 'requesting'}
              onClick={startCamera}
            >
              <Camera size={15} aria-hidden />
              Start camera
            </button>
          )}
          {['denied', 'no-camera', 'error'].includes(status) ? (
            <button type="button" className="btn-ghost-sm" onClick={startCamera}>
              <RefreshCw size={15} aria-hidden />
              {t('common.retry')}
            </button>
          ) : null}
        </div>

        {cameraStatusMessage ? (
          <p className="mt-2 text-xs text-text-secondary">{cameraStatusMessage}</p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="text-xs text-text-muted">
            Resolution
            <select
              className="select mt-1"
              value={resolutionPreset}
              onChange={event => setResolutionPreset(event.target.value)}
            >
              {RESOLUTION_PRESETS.map(preset => (
                <option key={preset.id} value={preset.id}>{preset.id === 'default'
                  ? `Camera maximum${cameraMaximum ? ` (${cameraMaximum.width}×${cameraMaximum.height})` : ''}`
                  : preset.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-ghost-sm"
            disabled={status !== 'live' || applyingResolution}
            onClick={applyResolution}
          >
            <RefreshCw size={15} aria-hidden />
            {applyingResolution ? 'Applying…' : 'Apply resolution'}
          </button>
          {trackInfo?.settings?.width ? (
            <p className="pb-1 text-xs text-text-secondary">
              Capture size: {trackInfo.settings.width}×{trackInfo.settings.height}
            </p>
          ) : null}
          {requestedResolution ? (
            <p className="pb-1 text-xs text-text-muted">
              requested {requestedResolution.width}×{requestedResolution.height}, got{' '}
              {trackInfo?.settings?.width ?? '?'}×{trackInfo?.settings?.height ?? '?'}
            </p>
          ) : null}
        </div>
        {resolutionError ? <p className="mt-1 text-xs text-brand-red">{resolutionError}</p> : null}

        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-border pt-3 text-xs text-text-secondary">
          <label className={`flex items-center gap-2 ${status === 'live' && detectorStatus === 'ready' ? '' : 'opacity-50'}`}>
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-red"
              checked={liveDetection}
              disabled={status !== 'live' || detectorStatus !== 'ready'}
              onChange={event => setLiveDetectionEnabled(event.target.checked)}
            />
            Live detection
          </label>
          <label className={`flex items-center gap-2 ${liveDetection ? '' : 'opacity-50'}`}>
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-red"
              checked={autoCapture}
              disabled={!liveDetection}
              onChange={event => setAutoCaptureEnabled(event.target.checked)}
            />
            Auto-capture when ready
          </label>
          <label className="flex items-center gap-2">
            <span>Policy</span>
            <select
              className="select-sm w-auto"
              aria-label="Capture policy"
              value={capturePolicy}
              onChange={event => setCapturePolicy(event.target.value)}
            >
              <option value="quad">Quad-driven</option>
              <option value="framing">Framing only</option>
            </select>
          </label>
          {liveDetection ? (
            <span className="text-text-muted">detector running</span>
          ) : null}
          <span
            className="text-text-muted"
            aria-label={`Capture policy: ${capturePolicy === 'framing' ? 'framing only' : 'quad'}`}
          >
            {capturePolicy === 'framing' ? 'framing only' : 'quad'}
          </span>
        </div>

        <div className="relative mt-3 flex justify-center overflow-hidden rounded">
          <div className="relative inline-block max-w-full">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`block h-auto w-auto max-h-[38vh] max-w-full rounded bg-black object-contain ${status === 'live' ? '' : 'invisible'}`}
            />
            {status === 'live' && liveDetection ? (
              <CaptureOverlay
                ref={overlayRef}
                phase={overlayPhase}
                tracked={quadSource === 'tracked'}
                confirmed={quadSource === 'model'}
                holdStartedAt={autoHoldStartTs}
                holdDurationMs={AUTO_STABLE_MS}
                tooSmall={overlayTooSmall}
                cardArea={overlayCardArea}
                pendingCount={pending.length}
                trayFull={trayUnsentCount() >= TRAY_CAPACITY}
                softFocus={softFocus}
                reason={phaseReason}
                refusal={captureRefusal}
                rechecking={captureRechecking}
                receiptCorners={receiptCorners}
              />
            ) : null}
          </div>
        </div>

        <CaptureDock
          items={sortTrayItems(pending)}
          count={pending.length}
          full={scannablePending.length >= TRAY_CAPACITY}
          canUndo={Boolean(latestUnsentItem(pending))}
          canReview={scannablePending.length > 0}
          reviewBusy={batchScanning}
          onUndo={undoLastCapture}
          onReview={scanAllPending}
          onInspect={openInspector}
          sessionRotation={sessionRotation}
          onResetSessionRotation={() => setSessionRotation(null)}
          removedNotice={removedNotice ? {
            sequence: removedNotice.item.sequence,
            onUndo: undoRemoved,
          } : null}
          flight={flight}
          onFlightDone={token => {
            setFlight(current => (current && current.token === token ? null : current))
          }}
          videoRef={videoRef}
          announcement={dockAnnouncement}
        />

        {inspectedItem ? (
          <TrayItemSheet
            item={inspectedItem}
            sessionRotation={sessionRotation}
            onClose={closeInspector}
            onRotate={rotateInspected}
            onUseRotation={useInspectedRotation}
            onRemove={() => {
              closeInspector()
              removePending(inspectedItem.id, { undoable: true })
            }}
          />
        ) : null}

        {/* Kept directly under the preview so both marks and the sound toggle
            stay in thumb reach while the phone is held in one hand with the
            camera running. */}
        <div className="mt-2 flex items-center gap-3 sm:max-w-sm">
          <div
            role="group"
            aria-label="Mark the current live detection"
            className="grid flex-1 grid-cols-2 gap-3"
          >
            <button
              type="button"
              className="btn-ghost-sm min-h-12 gap-1.5 text-sm"
              disabled={!liveDetection}
              onClick={() => markDiagnostics('good')}
            >
              <Check size={18} aria-hidden />
              Mark: good
              <span className="sr-only"> (live detection is correct)</span>
            </button>
            <button
              type="button"
              className="btn-ghost-sm min-h-12 gap-1.5 text-sm"
              disabled={!liveDetection}
              onClick={() => markDiagnostics('wrong')}
            >
              <X size={18} aria-hidden />
              Mark: wrong
              <span className="sr-only"> (live detection is wrong)</span>
            </button>
          </div>
          <button
            type="button"
            className="btn-ghost-sm h-12 w-12 shrink-0 p-0"
            aria-label={soundOn ? 'Sound on' : 'Sound off'}
            aria-pressed={soundOn}
            title={soundOn ? 'Sound on' : 'Sound off'}
            onClick={toggleCaptureSound}
          >
            {soundOn ? <Volume2 size={18} aria-hidden /> : <VolumeX size={18} aria-hidden />}
          </button>
          <button
            type="button"
            className="btn-ghost-sm h-12 w-12 shrink-0 p-0"
            aria-label={softFocus ? 'Soft focus on' : 'Soft focus off'}
            aria-pressed={softFocus}
            title={softFocus ? 'Soft focus on' : 'Soft focus off'}
            onClick={toggleSoftFocus}
          >
            {softFocus ? <Eye size={18} aria-hidden /> : <EyeOff size={18} aria-hidden />}
          </button>
        </div>

        {liveDetection ? (
          <div className="mt-2 text-xs">
            {liveResult ? (
              <p className="text-text-secondary">
                {LIVE_STATE_LABELS[liveState] || 'idle — no card'}
                {' · '}
                sharpness{' '}
                {Number.isFinite(liveResult.sharpness) ? liveResult.sharpness.toFixed(3) : 'n/a'}
                {' · '}
                Card fills {Math.round((liveResult.area || 0) * 100)}%
                {' · '}
                {liveResult.ms}ms
                {' · '}
                {liveFps}fps
              </p>
            ) : (
              <p className="text-text-muted">Waiting for the first live detection…</p>
            )}
            {liveResult ? (
              <>
                <p className="mt-1 text-xs text-text-muted">
                  box {trackerFps}fps · detect{' '}
                  {detectAgeMs == null ? '—' : `${(detectAgeMs / 1000).toFixed(1)}s ago`}
                </p>
                {trackerStats.attempts > 0 ? (
                  <p className="mt-0.5 font-mono text-[10px] text-text-muted">
                    track {trackerStats.hits}/{trackerStats.attempts} · r{trackerStats.reason}
                  </p>
                ) : null}
              </>
            ) : null}
            {captureNote ? <p className="mt-1 text-text-muted">{captureNote}</p> : null}
          </div>
        ) : null}

        {trackInfo ? (
          <div className="mt-3">
            <p className="text-xs font-medium text-text-secondary">Resolved track</p>
            <pre className="mt-1 max-h-56 overflow-auto rounded bg-bg p-2 text-[11px] leading-relaxed text-text-secondary">
              {JSON.stringify(trackInfo, null, 2)}
            </pre>
          </div>
        ) : null}

        {typeof window !== 'undefined' && typeof window.ImageCapture === 'function' && status === 'live' ? (
          <div className="mt-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-xs font-medium text-text-secondary">Still capture</p>
              <button
                type="button"
                className="btn-ghost-sm"
                disabled={stillProbe?.status === 'running'}
                onClick={probeStill}
              >
                <Camera size={14} aria-hidden />
                {stillProbe?.status === 'running' ? 'Probing…' : 'Probe still'}
              </button>
            </div>
            {stillProbe?.capabilities ? (
              <>
                <p className="mt-2 text-xs font-medium text-text-secondary">Photo capabilities</p>
                <pre className="mt-1 max-h-56 overflow-auto rounded bg-bg p-2 text-[11px] leading-relaxed text-text-secondary">
                  {JSON.stringify(stillProbe.capabilities, null, 2)}
                </pre>
              </>
            ) : null}
            {stillProbe?.status === 'done' ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p className="mr-auto text-xs text-text-secondary">
                  Bitmap {stillProbe.width}×{stillProbe.height}px
                  {' · '}
                  {formatBytes(stillProbe.bytes)} {stillProbe.type}
                  {' · '}
                  {stillProbe.elapsedMs}ms
                </p>
                {stillProbe.blob ? (
                  // Same still in the normal save path, so a high-resolution
                  // takePhoto frame can be compared with a video-frame capture.
                  <button
                    type="button"
                    className="btn-ghost-sm"
                    onClick={() => {
                      const blob = stillProbe.blob
                      addFiles(
                        [new File([blob], `still-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' })],
                        'Phone browser',
                      )
                    }}
                  >
                    <ImagePlus size={14} aria-hidden />
                    Add still to pending
                  </button>
                ) : null}
              </div>
            ) : null}
            {stillProbe?.status === 'error' ? (
              <p className="mt-2 text-xs text-brand-red">{stillProbe.error}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-text-primary">Card detection</h2>
          <select
            className="select-sm w-auto"
            aria-label="Detector runtime"
            value={detectorRuntime}
            disabled={detectorStatus === 'loading'}
            onChange={event => {
              const runtime = event.target.value
              setDetectorRuntime(runtime)
              loadDetector(runtime)
            }}
          >
            <option value="asyncify">Runtime: asyncify (default)</option>
            <option value="wasm">Runtime: plain simd</option>
            <option value="webgpu">Runtime: webgpu (experimental)</option>
          </select>
          <button type="button" className="btn-ghost-sm" onClick={checkWebgpu}>
            Check WebGPU
          </button>
          <button
            type="button"
            className="btn-ghost-sm"
            disabled={detectorStatus === 'loading'}
            onClick={() => loadDetector()}
          >
            <ScanLine size={15} aria-hidden />
            Load detector
          </button>
          <label className={`btn-primary-sm ${detectorStatus === 'ready' && !detectorBusy ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <ImagePlus size={15} aria-hidden />
            Detect a file…
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={detectorStatus !== 'ready' || detectorBusy}
              onChange={detectFile}
            />
          </label>
        </div>
        {webgpuProbe ? (
          <p className="mt-1 break-all text-xs text-text-muted">WebGPU: {webgpuProbe}</p>
        ) : null}
        <p className="mt-1 text-xs text-text-muted">
          File probe for checking a photo, plus a live overlay with the card-size gate and
          rectified capture.
        </p>

        {detectorStatus === 'loading' ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            Loading the detector runtime and model…
          </p>
        ) : null}
        {detectorStatus === 'idle' ? (
          <p className="mt-2 text-xs text-text-secondary">
            Load the detector to enable file detection.
          </p>
        ) : null}
        {detectorStatus === 'ready' && !detectorBusy ? (
          <p className="mt-2 text-xs text-text-secondary">
            Detector ready ({DETECTOR_RUNTIME_LABELS[detectorRuntimeActive] || 'unknown'} runtime).
            Pick a still image to test.
          </p>
        ) : null}

        {detectorRuntimeActive === 'webgpu' ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              className="btn-ghost-sm"
              disabled={webgpuVerifying}
              onClick={verifyWebgpuNow}
            >
              <RefreshCw size={14} aria-hidden />
              {webgpuVerifying ? 'Verifying…' : 'Verify webgpu'}
            </button>
            {webgpuVerification ? (
              webgpuVerification.unverified ? (
                <span className="text-yellow">
                  webgpu: unverified ({webgpuVerification.reason})
                </span>
              ) : (
                <span className={verificationTone(webgpuVerification.maxCornerDelta)}>
                  webgpu vs wasm: corners differ by{' '}
                  {(webgpuVerification.maxCornerDelta * 100).toFixed(2)}% of frame
                  {webgpuVerification.maxCornerDelta > 0.02
                    ? ' — do not trust this runtime on this device'
                    : ''}
                </span>
              )
            ) : (
              <span className="text-text-muted">
                Not verified yet — run a detection or press Verify webgpu.
              </span>
            )}
          </div>
        ) : null}
        {detectorBusy ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            Detecting…
          </p>
        ) : null}
        {detectorError ? <p className="mt-2 text-xs text-brand-red">{detectorError}</p> : null}

        {detectorImage ? (
          <div className="relative mt-3 inline-block max-w-full">
            <img
              src={detectorImage.url}
              alt="Still selected for card detection"
              className="block max-h-96 w-auto max-w-full rounded border border-border"
            />
            {detectorResult?.corners?.length === 4 ? (
              <svg
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                className={`pointer-events-none absolute inset-0 h-full w-full ${detectorResult.usable ? 'text-green' : 'text-yellow'}`}
                aria-hidden
              >
                <polygon
                  points={detectorResult.corners.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : null}
          </div>
        ) : null}

        {detectorResult ? (
          <p className="mt-2 text-xs text-text-secondary">
            Sharpness{' '}
            {Number.isFinite(detectorResult.sharpness) ? detectorResult.sharpness.toFixed(3) : 'n/a'}
            {' · '}
            usable {String(detectorResult.usable)}
            {' · '}
            {detectorResult.ms}ms
            {detectorImage ? ` · ${detectorImage.width}×${detectorImage.height}px source` : ''}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs">
          <button
            type="button"
            className="btn-ghost-sm"
            disabled={diagCount.samples === 0 || diagSend.status === 'sending'}
            onClick={sendDiagnostics}
          >
            <Save size={14} aria-hidden />
            {diagSend.status === 'sending' ? 'Sending…' : 'Send diagnostics'}
          </button>
          <button
            type="button"
            className="btn-ghost-sm"
            disabled={diagCount.samples === 0 || diagSend.status === 'sending'}
            onClick={clearDiagnostics}
          >
            Clear
          </button>
          <span className="text-text-muted">
            recording: {diagCount.samples} samples · {diagCount.frames} frames · {diagCount.events} events
          </span>
        </div>
        {diagSend.status === 'sent' ? (
          <p className="mt-1 text-xs text-green">{diagSend.message}</p>
        ) : null}
        {diagSend.status === 'error' ? (
          <p className="mt-1 text-xs text-brand-red">{diagSend.error}</p>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-text-primary">
            Capture outcomes
          </h2>
          <button
            type="button"
            className="btn-ghost-sm"
            disabled={attempts.length === 0 || reportSend.status === 'sending'}
            onClick={sendSessionReport}
          >
            <Save size={14} aria-hidden />
            {reportSend.status === 'sending'
              ? 'Sending…'
              : reportSend.status === 'error'
                ? 'Retry session report'
                : 'Send session report'}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-5">
          <p className="text-text-secondary">
            Attempts{' '}
            <span className="font-mono text-text-primary">{attemptSummary.attempts}</span>
          </p>
          <p className="text-text-secondary">
            Staged{' '}
            <span className="font-mono text-text-primary">{attemptSummary.staged}</span>
          </p>
          <p className="text-text-secondary">
            Refused{' '}
            <span className="font-mono text-text-primary">{attemptSummary.refused}</span>
          </p>
          <p className="text-text-secondary">
            Median to stage{' '}
            <span className="font-mono text-text-primary">
              {attemptSummary.medianTimeToStageMs == null
                ? '—'
                : `${(attemptSummary.medianTimeToStageMs / 1000).toFixed(2)} s`}
            </span>
          </p>
          <p className="text-text-secondary">
            Duplicates suspected{' '}
            <span className="font-mono text-text-primary">
              {attemptSummary.duplicatesSuspected}
            </span>
          </p>
          <p className="text-text-secondary">
            Policy{' '}
            <span className="font-mono text-text-primary">
              {capturePolicy === 'framing' ? 'framing' : 'quad'}
            </span>
          </p>
        </div>
        {attemptSummary.refused > 0 ? (
          <div className="mt-2 text-xs text-text-secondary">
            <span className="text-text-muted">Refused by reason: </span>
            {Object.entries(attemptSummary.refusedByReason).map(([reason, count]) => (
              <span key={reason} className="mr-3 font-mono text-text-primary">
                {reason} ×{count}
              </span>
            ))}
          </div>
        ) : null}
        {reportSend.status === 'sent' ? (
          <p className="mt-2 break-all text-xs text-green">
            Session report stored{reportSend.id ? ` as ${reportSend.id}` : ''}.
          </p>
        ) : null}
        {reportSend.status === 'error' ? (
          <p className="mt-2 text-xs text-brand-red">
            {reportSend.error} The attempts are kept; retry when ready.
          </p>
        ) : null}
      </section>

      <section ref={trayRef} className="rounded-lg border border-border bg-bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-sm font-semibold text-text-primary">
            Pending ({pending.length})
          </h2>
          <label className="btn-ghost-sm cursor-pointer">
            <ImagePlus size={15} aria-hidden />
            Add from gallery
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={event => {
                addFiles(event.target.files || [], 'Phone native')
                event.target.value = ''
              }}
            />
          </label>
          <button
            type="button"
            className="btn-primary-sm"
            disabled={!pending.some(item => item.status !== 'saved' && item.status !== 'uploading')}
            onClick={saveAll}
          >
            <Save size={15} aria-hidden />
            Save all to Dev
          </button>
          <button
            type="button"
            className="btn-ghost-sm"
            disabled={pending.length === 0 || batchScanning}
            onClick={scanAllPending}
          >
            <ScanLine size={15} aria-hidden />
            {batchScanning ? 'Scanning…' : `Scan all (${scannablePending.length})`}
          </button>
        </div>
        {batchScanMessage ? (
          <p className="mt-2 text-xs text-text-secondary">{batchScanMessage}</p>
        ) : null}
        {batchScanError ? (
          <p className="mt-2 text-xs text-brand-red">{batchScanError}</p>
        ) : null}

        {pending.length === 0 ? (
          <p className="mt-3 text-xs text-text-secondary">
            Nothing pending. Capture a frame or add photos from the phone gallery.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {pending.map(item => (
              <PendingCard
                key={item.id}
                item={item}
                onChange={patch => updatePending(item.id, patch)}
                onRemove={() => removePending(item.id)}
                onSave={() => saveItem(item)}
                onScan={() => scanPending(item)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-bg-card p-4">
        <h2 className="text-sm font-semibold text-text-primary">
          Stored captures ({captures.length})
        </h2>

        {listDisabled ? (
          <p className="mt-2 text-xs text-brand-red">
            The capture lab is disabled on this instance. Set CAPTURE_LAB_ENABLED=1 and restart
            the Dev backend.
          </p>
        ) : null}
        {listError && !listDisabled ? (
          <p className="mt-2 text-xs text-brand-red">Could not list captures: {errorMessage(listError)}</p>
        ) : null}
        {libraryError ? <p className="mt-2 text-xs text-brand-red">{libraryError}</p> : null}

        {isLoading ? (
          <p className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            Loading captures…
          </p>
        ) : null}

        {!isLoading && !listError && captures.length === 0 ? (
          <p className="mt-2 text-xs text-text-secondary">No captures stored yet.</p>
        ) : null}

        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {captures.map(entry => {
            const scan = storedScans[entry.name]
            return (
            <div key={entry.name} className="rounded-lg border border-border bg-bg p-3">
              {entry.thumbnail ? (
                <img
                  src={entry.thumbnail}
                  alt={entry.card_label || entry.name}
                  className="h-40 w-full rounded bg-black object-contain"
                />
              ) : (
                <div className="grid h-40 w-full place-items-center rounded bg-bg-card text-xs text-text-muted">
                  No preview
                </div>
              )}
              <p className="mt-2 break-all font-mono text-[11px] text-text-primary">{entry.name}</p>
              <p className="mt-1 text-xs text-text-secondary">
                {entry.condition || 'No condition'}
                {' · '}
                {entry.card_label || 'No label'}
                {' · '}
                {entry.route || 'No route'}
              </p>
              <p className="text-xs text-text-muted">
                {entry.width && entry.height ? `${entry.width} × ${entry.height}px` : 'dimensions unknown'}
                {' · '}
                {formatBytes(entry.bytes)}
                {' · '}
                {entry.created_at ? new Date(entry.created_at).toLocaleString() : 'unknown time'}
              </p>
              {entry.note ? <p className="mt-1 text-xs text-text-secondary">{entry.note}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-ghost-sm"
                  disabled={scan?.status === 'uploading'}
                  onClick={() => scanStoredCapture(entry)}
                >
                  <ScanLine size={14} aria-hidden />
                  {scan?.status === 'uploading' ? 'Sending…' : 'Send to scanner'}
                </button>
                <button type="button" className="btn-ghost-sm" onClick={() => downloadEntry(entry)}>
                  <Download size={14} aria-hidden />
                  {t('common.download')}
                </button>
                <button
                  type="button"
                  className="btn-ghost-sm text-brand-red"
                  onClick={() => deleteEntry(entry)}
                >
                  <Trash2 size={14} aria-hidden />
                  {t('common.delete')}
                </button>
              </div>
              {scan?.status === 'uploading' ? (
                <p className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
                  <Loader2 size={13} className="animate-spin" aria-hidden />
                  Submitting scan{scan.progress ? ` ${scan.progress}%` : '…'}
                </p>
              ) : null}
              {scan?.status === 'done' && scan.jobId ? (
                <p className="mt-2 text-xs text-text-secondary">
                  Scan job queued.{' '}
                  <Link className="text-brand-red underline" to={`/scans/${scan.jobId}`}>
                    Open job {scan.jobId}
                  </Link>
                </p>
              ) : null}
              {scan?.status === 'error' ? (
                <p className="mt-2 text-xs text-brand-red">{scan.error}</p>
              ) : null}
            </div>
            )
          })}
        </div>

        <p className="mt-4 break-all border-t border-border pt-3 font-mono text-[11px] text-text-muted">
          Server directory: {data?.directory || 'unknown — enable the lab to read it'}
        </p>
      </section>
    </div>
  )
}
