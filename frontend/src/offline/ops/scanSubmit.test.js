import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chunkPhotos, ScanSubmitError, submitScanBatch } from './scanSubmit.js'
import { scanUpload } from '../outbox/ops/scanUpload.js'

const MIB = 1024 * 1024

const photo = (size = 1000, type = 'image/jpeg') => ({
  name: `p${Math.random()}.jpg`,
  type,
  size,
  arrayBuffer: async () => new ArrayBuffer(size),
})

function fakeOutbox({ sendNow } = {}) {
  let n = 0
  return {
    enqueue: vi.fn(async () => ({ id: `item-${++n}` })),
    sendNow: sendNow || vi.fn(async ids => ids.map((id, index) => ({ id, outcome: 'sent', json: { id: 100 + index } }))),
  }
}

describe('chunkPhotos', () => {
  it('splits at 12 photos', () => {
    const chunks = chunkPhotos(Array.from({ length: 25 }, () => photo(10)))
    expect(chunks.map(c => [c.start, c.files.length])).toEqual([[0, 12], [12, 12], [24, 1]])
  })

  it('splits at 10 MiB and gives an oversize photo its own chunk', () => {
    const chunks = chunkPhotos([photo(6 * MIB), photo(5 * MIB), photo(14 * MIB), photo(1 * MIB)])
    expect(chunks.map(c => [c.start, c.files.length])).toEqual([[0, 1], [1, 1], [2, 1], [3, 1]])
    expect(chunkPhotos([photo(5 * MIB), photo(5 * MIB), photo(1)]).map(c => c.files.length)).toEqual([2, 1])
  })
})

describe('submitScanBatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('enqueues but does not send, and returns queued at once, when not reachable', async () => {
    for (const reachability of ['unknown', 'unreachable', 'captive']) {
      const outbox = fakeOutbox()
      const result = await submitScanBatch({ files: [photo(), photo()], outbox, reachability })
      expect(result).toEqual({ mode: 'queued', jobIds: [], queuedCount: 1 })
      expect(outbox.enqueue).toHaveBeenCalledTimes(1)
      expect(outbox.sendNow).not.toHaveBeenCalled()
    }
  })

  it('remaps individual positions per chunk', async () => {
    const outbox = fakeOutbox()
    await submitScanBatch({ files: Array.from({ length: 14 }, () => photo(10)), individualPositions: [1, 12, 13], outbox })
    const payloads = outbox.enqueue.mock.calls.map(([arg]) => arg.payload.individualPositions)
    expect(payloads).toEqual([[1], [0, 1]])
    expect(outbox.enqueue.mock.calls[0][0].type).toBe('scan.upload')
    expect(outbox.enqueue.mock.calls[0][0].photos).toHaveLength(12)
  })

  it('sends when reachable and reports sent with job ids', async () => {
    const outbox = fakeOutbox()
    const result = await submitScanBatch({ files: [photo()], outbox, reachability: 'reachable' })
    expect(outbox.sendNow).toHaveBeenCalledWith(['item-1'])
    expect(result).toEqual({ mode: 'sent', jobIds: [100], queuedCount: 0 })
  })

  it('reports partial when only some items were sent', async () => {
    const outbox = fakeOutbox({
      sendNow: vi.fn(async ids => [{ id: ids[0], outcome: 'sent', json: { id: 7 } }, { id: ids[1], outcome: 'retry_wait' }]),
    })
    const result = await submitScanBatch({ files: Array.from({ length: 13 }, () => photo(10)), outbox, reachability: 'reachable' })
    expect(result).toEqual({ mode: 'partial', jobIds: [7], queuedCount: 1 })
  })

  it('returns queued after the cap when the send is slow, and lets the send finish', async () => {
    let finish
    const outbox = fakeOutbox({ sendNow: vi.fn(() => new Promise(resolve => { finish = resolve })) })
    const pending = submitScanBatch({ files: [photo()], outbox, reachability: 'reachable', sendCapMs: 5000 })
    await vi.advanceTimersByTimeAsync(4999)
    let settled = false
    pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ mode: 'queued', jobIds: [], queuedCount: 1 })
    expect(() => finish([{ id: 'item-1', outcome: 'sent', json: { id: 1 } }])).not.toThrow()
  })

  it('treats a rejected send as queued', async () => {
    const outbox = fakeOutbox({ sendNow: vi.fn(async () => { throw new Error('boom') }) })
    await expect(submitScanBatch({ files: [photo()], outbox, reachability: 'reachable' }))
      .resolves.toEqual({ mode: 'queued', jobIds: [], queuedCount: 1 })
  })

  it('keeps earlier chunks queued when a later enqueue fails with quota', async () => {
    const outbox = fakeOutbox()
    outbox.enqueue.mockImplementationOnce(async () => ({ id: 'item-1' }))
      .mockImplementationOnce(async () => { throw Object.assign(new Error('full'), { code: 'quota' }) })
    const error = await submitScanBatch({ files: Array.from({ length: 13 }, () => photo(10)), outbox, reachability: 'reachable' })
      .catch(e => e)
    expect(error.code).toBe('quota')
    expect(error.queuedCount).toBe(1)
    expect(outbox.sendNow).not.toHaveBeenCalled()
  })

  it('reports exactly the durable photo prefix so retry never duplicates an earlier chunk', async () => {
    const files = Array.from({ length: 13 }, () => photo(10))
    const saved = []
    let fail = true
    const outbox = fakeOutbox()
    outbox.enqueue.mockImplementation(async item => {
      if (saved.length === 1 && fail) throw Object.assign(new Error('full'), { code: 'quota' })
      saved.push(item)
      return { id: `saved-${saved.length}` }
    })
    const error = await submitScanBatch({ files, individualPositions: [1, 12], outbox }).catch(e => e)
    expect(error.savedPhotoCount).toBe(12)
    expect(error.queuedCount).toBe(1)
    fail = false
    await submitScanBatch({ files: files.slice(error.savedPhotoCount), individualPositions: [0], outbox })
    expect(saved.map(item => item.photos.length)).toEqual([12, 1])
    expect(saved.map(item => item.payload.individualPositions)).toEqual([[1], [0]])
  })

  it('validates before saving anything', async () => {
    const outbox = fakeOutbox()
    await expect(submitScanBatch({ files: [photo(16 * MIB)], outbox })).rejects.toMatchObject({ code: 'too_large' })
    await expect(submitScanBatch({ files: [photo(10, 'text/plain')], outbox })).rejects.toBeInstanceOf(ScanSubmitError)
    await expect(submitScanBatch({ files: Array.from({ length: 51 }, () => photo(1)), outbox })).rejects.toMatchObject({ code: 'too_many' })
    expect(outbox.enqueue).not.toHaveBeenCalled()
  })
})

describe('scan destination (binderId)', () => {
  const item = overrides => ({ id: 'item-1', userId: 1, photoCount: 1, payload: {}, display: {}, ...overrides })
  const onePhoto = async function* read() {
    yield { index: 0, name: 'a.jpg', type: 'image/jpeg', bytes: new Uint8Array([1]).buffer }
  }

  it('persists the destination on every chunk of the queued batch', async () => {
    const outbox = fakeOutbox()
    await submitScanBatch({ files: Array.from({ length: 13 }, () => photo(10)), binderId: 42, outbox })
    expect(outbox.enqueue.mock.calls.map(([arg]) => arg.payload.binderId)).toEqual([42, 42])
    expect(outbox.enqueue.mock.calls.map(([arg]) => arg.payload.individualPositions)).toEqual([[], []])
  })

  it('accepts a numeric string from a select element as the same destination', async () => {
    const outbox = fakeOutbox()
    await submitScanBatch({ files: [photo()], binderId: '7', outbox })
    expect(outbox.enqueue.mock.calls[0][0].payload.binderId).toBe(7)
  })

  it('sends binder_id on replay once the entry carries a destination', async () => {
    const req = await scanUpload.buildRequest(item({ payload: { individualPositions: [0], binderId: 42 } }), onePhoto)
    expect(req.body.get('binder_id')).toBe('42')
    expect(req.body.get('individual_positions')).toBe('[0]')
  })

  it('replays a legacy entry without binderId and posts no destination', async () => {
    const req = await scanUpload.buildRequest(item({ payload: { individualPositions: [0] } }), onePhoto)
    expect(req.body.has('binder_id')).toBe(false)
    expect(req.body.get('individual_positions')).toBe('[0]')
  })

  it('replays an entry with an empty destination and posts no destination', async () => {
    for (const binderId of ['', null, undefined, 0]) {
      const req = await scanUpload.buildRequest(item({ payload: { individualPositions: [], binderId } }), onePhoto)
      expect(req.body.has('binder_id')).toBe(false)
    }
  })

  it('stores no destination for an empty or undefined binderId', async () => {
    for (const binderId of [undefined, null, '', 0, 'abc']) {
      const outbox = fakeOutbox()
      await submitScanBatch({ files: [photo()], binderId, outbox })
      expect('binderId' in outbox.enqueue.mock.calls[0][0].payload).toBe(false)
    }
  })
})
