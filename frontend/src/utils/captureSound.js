// Capture Lab earcons, synthesised with WebAudio so there is no asset to ship.
//
// Both cues are deliberately quiet and short: the phone is held a hand's width
// from the user's face, so a bright notification chime would be startling and
// would read as a system alert rather than as feedback for their own action.
//
// Success: a soft triangle-wave rise of a perfect fifth (F4 349.23 Hz for 85 ms,
// then C5 523.25 Hz for 120 ms, starting 70 ms in). Triangle's odd harmonics
// only carry the fundamental through a small phone speaker — sine alone gets
// lost over a room's noise floor — and the ~1.5 kHz lowpass keeps the upper
// partials from turning shrill. Both notes decay to near silence instead of
// being cut, so the capture feels finished rather than clipped.
//
// Refusal: one low triangle note (E3 164.81 Hz) gliding down to C3 130.81 Hz
// over 140 ms, lowpassed at 480 Hz and peaking at roughly half the success
// gain. Lower and duller, so it reads as "nothing happened" without sounding
// like an error.
//
// The AudioContext is only ever created or resumed from a user gesture. If the
// browser has no WebAudio, or denies it, every cue is a silent no-op.

const STORAGE_KEY = 'capture-lab-sound'
const REFUSAL_GAP_MS = 1000

let context = null
let enabled = null
let lastRefusalAt = -Infinity

function clockNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function soundEnabled() {
  if (enabled == null) {
    try {
      enabled = typeof window === 'undefined'
        ? true
        : window.localStorage.getItem(STORAGE_KEY) !== 'off'
    } catch {
      // Storage can be unavailable (private mode, blocked cookies): default on.
      enabled = true
    }
  }
  return enabled
}

export function isCaptureSoundEnabled() {
  return soundEnabled()
}

export function setCaptureSoundEnabled(value) {
  enabled = Boolean(value)
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    // The choice still holds for this page even if it cannot be persisted.
  }
}

function audioContext() {
  // The browser can close the context after an audio interruption; a closed
  // context cannot be reused, but the next gesture can unlock a new one.
  if (context && context.state !== 'closed') return context
  context = null
  const Ctor = typeof window === 'undefined'
    ? null
    : (window.AudioContext || window.webkitAudioContext)
  if (!Ctor) return null
  try {
    context = new Ctor()
  } catch {
    context = null
  }
  return context
}

// Call from a click handler (starting the camera counts). Creating an
// AudioContext outside a gesture leaves it suspended, and a suspended context
// cannot be resumed later from the capture path's async callback.
export function primeCaptureAudio() {
  const ctx = audioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
}

function playTone(ctx, {
  at,
  frequency,
  toFrequency = frequency,
  duration,
  peak,
  cutoff,
  attack,
}) {
  const start = ctx.currentTime + at
  const end = start + duration
  const oscillator = ctx.createOscillator()
  const filter = ctx.createBiquadFilter()
  const gain = ctx.createGain()

  oscillator.type = 'triangle'
  oscillator.frequency.setValueAtTime(frequency, start)
  if (toFrequency !== frequency) {
    oscillator.frequency.exponentialRampToValueAtTime(toFrequency, end)
  }

  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(cutoff, start)
  filter.Q.setValueAtTime(0.7, start)

  // Exponential ramps cannot touch zero, so the envelope runs between tiny
  // positive values; starting at -80 dB and fading back to it avoids clicks.
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, end)

  oscillator.connect(filter)
  filter.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(end + 0.03)
}

export function playCaptureSuccess() {
  if (!soundEnabled()) return
  const ctx = audioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  try {
    // F4 → C5, a perfect fifth: consonant and low enough to stay warm.
    playTone(ctx, {
      at: 0,
      frequency: 349.23,
      duration: 0.085,
      peak: 0.08,
      cutoff: 1500,
      attack: 0.012,
    })
    playTone(ctx, {
      at: 0.07,
      frequency: 523.25,
      duration: 0.12,
      peak: 0.065,
      cutoff: 1600,
      attack: 0.012,
    })
  } catch {
    // Audio is feedback, never a prerequisite for a capture.
  }
}

export function playCaptureRefusal() {
  if (!soundEnabled()) return
  const now = clockNow()
  if (now - lastRefusalAt < REFUSAL_GAP_MS) return
  const ctx = audioContext()
  if (!ctx) return
  lastRefusalAt = now
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  try {
    playTone(ctx, {
      at: 0,
      frequency: 164.81,
      toFrequency: 130.81,
      duration: 0.14,
      peak: 0.04,
      cutoff: 480,
      attack: 0.01,
    })
  } catch {
    // See above: a refused capture must still follow its normal path.
  }
}
