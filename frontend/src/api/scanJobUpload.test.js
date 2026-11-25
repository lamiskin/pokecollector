/**
 * Guards the two things a phone batch upload needs from the API layer: a
 * timeout long enough for mobile uplink, and progress while the browser
 * downscales then sends the photos.
 *
 * The regression this replaces: the client-wide 30 s timeout aborted a
 * multi-photo batch mid-body, the proxy answered 400 with an empty response,
 * and the UI could only say "The scan batch could not be submitted." Nothing
 * in the UI or the logs said "timeout".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn(() => Promise.resolve({ data: { id: 7 } }))

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post,
      delete: vi.fn(() => Promise.resolve({ data: {} })),
      get: vi.fn(() => Promise.resolve({ data: {} })),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    }),
  },
}))

const { enqueueScanJob } = await import('./client')

function photo(name) {
  return new File(['x'], name, { type: 'image/jpeg' })
}

describe('enqueueScanJob', () => {
  beforeEach(() => post.mockClear())

  it('does not use the 30 s default that aborted a mobile batch', async () => {
    await enqueueScanJob([photo('a.jpg')], [])
    const [, , config] = post.mock.calls[0]
    expect(config.timeout).toBeGreaterThanOrEqual(10 * 60 * 1000)
  })

  it('still posts every photo and the positions under the server field names', async () => {
    const files = [photo('a.jpg'), photo('b.jpg')]
    await enqueueScanJob(files, [1], 12)
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('/cards/recognize/jobs')
    expect(body).toBeInstanceOf(FormData)
    expect(body.getAll('files')).toHaveLength(2)
    expect(body.get('individual_positions')).toBe('[1]')
    expect(body.get('binder_id')).toBe('12')
  })

  it('reports preparation progress once per photo', async () => {
    const progress = []
    await enqueueScanJob([photo('a.jpg'), photo('b.jpg')], [], null, {
      onProgress: event => progress.push(event),
    })
    const prepared = progress.filter(event => event.phase === 'prepare')
    expect(prepared.map(event => event.total)).toEqual([2, 2])
    expect(prepared.map(event => event.done).sort()).toEqual([1, 2])
  })

  it('reports upload progress from the request itself', async () => {
    const progress = []
    post.mockImplementationOnce((url, body, config) => {
      config.onUploadProgress({ loaded: 25, total: 100 })
      return Promise.resolve({ data: { id: 7 } })
    })

    await enqueueScanJob([photo('a.jpg')], [], null, {
      onProgress: event => progress.push(event),
    })

    expect(progress).toContainEqual({ phase: 'upload', loaded: 25, total: 100 })
  })

  it('omits rotations when no capture has a choice', async () => {
    await enqueueScanJob([photo('a.jpg'), photo('b.jpg')], [], null, {
      rotations: [null, null],
    })
    const [, body] = post.mock.calls[0]
    expect(body.get('rotations')).toBeNull()
  })

  it('sends rotations aligned with the files, keeping an explicit 0', async () => {
    await enqueueScanJob([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')], [], null, {
      rotations: [0, null, 270],
    })
    const [, body] = post.mock.calls[0]
    expect(body.getAll('files')).toHaveLength(3)
    expect(body.get('rotations')).toBe('[0,null,270]')
  })

  it('drops a rotation array that does not line up with the files', async () => {
    await enqueueScanJob([photo('a.jpg')], [], null, { rotations: [90, 180] })
    const [, body] = post.mock.calls[0]
    expect(body.get('rotations')).toBeNull()
  })
})
