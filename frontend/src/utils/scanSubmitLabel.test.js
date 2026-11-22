import { describe, expect, it, vi } from 'vitest'

import { scanSubmitLabel } from './scanSubmitLabel'

const t = vi.fn(key => ({
  'scanner.startScanning': 'Start scanning',
  'scanner.submittingBatch': 'Uploading photos…',
  'scanner.preparingPhotos': 'Preparing photos…',
}[key] ?? key))

describe('scanSubmitLabel', () => {
  it('offers the action when nothing is happening', () => {
    expect(scanSubmitLabel(t, { submitting: false })).toBe('Start scanning')
  })

  it('says photos are being prepared, with a count, before any upload starts', () => {
    expect(scanSubmitLabel(t, {
      submitting: true,
      progress: { phase: 'prepare', done: 12, total: 48 },
    })).toBe('Preparing photos… 12/48')
  })

  it('says the upload is running, with a percentage', () => {
    expect(scanSubmitLabel(t, {
      submitting: true,
      progress: { phase: 'upload', loaded: 25, total: 100 },
    })).toBe('Uploading photos… 25%')
  })

  it('never claims 100% before the response arrives', () => {
    expect(scanSubmitLabel(t, {
      submitting: true,
      progress: { phase: 'upload', loaded: 100, total: 100 },
    })).toBe('Uploading photos… 99%')
  })

  it('falls back to the generic label without a usable total', () => {
    expect(scanSubmitLabel(t, {
      submitting: true,
      progress: { phase: 'upload', loaded: 900, total: 0 },
    })).toBe('Uploading photos…')
    expect(scanSubmitLabel(t, { submitting: true })).toBe('Uploading photos…')
  })
})
