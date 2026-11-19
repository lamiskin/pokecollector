import { beforeEach, describe, expect, test, vi } from 'vitest'

const post = vi.fn(() => Promise.resolve({ data: { id: 11 } }))

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post,
      delete: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    }),
  },
}))

const { enqueueScanJob } = await import('./client')

const photo = () => new File(['image'], 'card.jpg', { type: 'image/jpeg' })

function submittedForm(callIndex = 0) {
  const [url, body, config] = post.mock.calls[callIndex]
  return { url, body, config }
}

describe('enqueueScanJob destination card list', () => {
  beforeEach(() => post.mockClear())

  test('sends binder_id when a destination is chosen', async () => {
    await enqueueScanJob([photo()], [], 42)

    const { url, body, config } = submittedForm()
    expect(url).toBe('/cards/recognize/jobs')
    expect(body.get('binder_id')).toBe('42')
    expect(body.get('individual_positions')).toBe('[]')
    expect(config.headers['Content-Type']).toBe('multipart/form-data')
  })

  test('omits binder_id when no destination is chosen', async () => {
    await enqueueScanJob([photo()], [0])

    const { body } = submittedForm()
    expect(body.has('binder_id')).toBe(false)
    expect(body.get('individual_positions')).toBe('[0]')
  })

  test('omits binder_id when the destination is explicitly null', async () => {
    await enqueueScanJob([photo()], [], null)

    expect(submittedForm().body.has('binder_id')).toBe(false)
  })

  test('keeps the existing two-argument call working', async () => {
    await enqueueScanJob([photo()], [1, 2])

    expect(submittedForm().body.has('binder_id')).toBe(false)
  })
})
