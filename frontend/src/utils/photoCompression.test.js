/**
 * Guards the browser-side photo shrink that runs before uploading a card photo.
 *
 * The behaviour that matters is not the encoding itself (canvas is the
 * browser's job) but the guard rails: never upscale, never re-encode a photo
 * that is already small, never lose the upload when decoding is unavailable,
 * and never keep an "optimized" file that came out larger than the original.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  UPLOAD_MAX_EDGE,
  prepareImageForUpload,
  prepareImagesForUpload,
  scaledUploadDimensions,
  shouldCompress,
} from './photoCompression'

function photoFile({ bytes = 2 * 1024 * 1024, name = 'IMG_0001.HEIC', type = 'image/heic' } = {}) {
  return new File([new Uint8Array(bytes)], name, { type, lastModified: 1234 })
}

function stubBrowser({ encodedBytes = 600_000, decode = true } = {}) {
  const drawImage = vi.fn()
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      fillStyle: '',
      fillRect: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: '',
      drawImage,
    })),
    toBlob: vi.fn(callback => callback(
      new Blob([new Uint8Array(encodedBytes)], { type: 'image/jpeg' }),
    )),
  }
  const close = vi.fn()
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
  vi.stubGlobal('HTMLCanvasElement', class HTMLCanvasElement {})
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    if (!decode) throw new Error('cannot decode')
    return { width: 4000, height: 3000, close }
  }))
  return { canvas, drawImage, close }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scaledUploadDimensions', () => {
  it('scales the long edge down and keeps the aspect ratio', () => {
    expect(scaledUploadDimensions(4000, 3000)).toEqual({ width: 2048, height: 1536 })
  })

  it('handles portrait photos', () => {
    expect(scaledUploadDimensions(3024, 4032)).toEqual({ width: 1536, height: 2048 })
  })

  it('leaves images at or below the target edge untouched', () => {
    expect(scaledUploadDimensions(1200, 1600)).toEqual({ width: 1200, height: 1600 })
    expect(scaledUploadDimensions(UPLOAD_MAX_EDGE, 1000)).toEqual({
      width: UPLOAD_MAX_EDGE,
      height: 1000,
    })
  })

  it('never scales a side below one pixel', () => {
    expect(scaledUploadDimensions(8000, 3)).toEqual({ width: 2048, height: 1 })
  })

  it('reports unusable sizes as unknown', () => {
    for (const [width, height] of [[0, 100], [-5, 100], [Number.NaN, 100], [100, Infinity]]) {
      expect(scaledUploadDimensions(width, height)).toBeNull()
    }
  })
})

describe('shouldCompress', () => {
  it('compresses large files even at modest dimensions', () => {
    expect(shouldCompress({ width: 1800, height: 1200, size: 4 * 1024 * 1024 })).toBe(true)
  })

  it('compresses oversized dimensions even in a small file', () => {
    expect(shouldCompress({ width: 6000, height: 4000, size: 900_000 })).toBe(true)
  })

  it('leaves a small, reasonably sized image alone', () => {
    expect(shouldCompress({ width: 1400, height: 1000, size: 400_000 })).toBe(false)
  })

  it('judges on bytes alone when dimensions are unknown', () => {
    expect(shouldCompress({ size: 3 * 1024 * 1024 })).toBe(true)
    expect(shouldCompress({ size: 200_000 })).toBe(false)
    expect(shouldCompress({ size: 0 })).toBe(false)
  })
})

describe('prepareImageForUpload', () => {
  it('returns the original when no canvas is available', async () => {
    const file = photoFile()
    expect(await prepareImageForUpload(file)).toBe(file)
  })

  it('downscales a large photo to the server edge and drops the original type', async () => {
    const { canvas, drawImage, close } = stubBrowser()
    const file = photoFile()

    const prepared = await prepareImageForUpload(file)

    expect(prepared).not.toBe(file)
    expect(prepared).toBeInstanceOf(File)
    expect(prepared.name).toBe('IMG_0001.jpg')
    expect(prepared.type).toBe('image/jpeg')
    expect(prepared.lastModified).toBe(1234)
    expect(canvas.width).toBe(2048)
    expect(canvas.height).toBe(1536)
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 1536)
    expect(close).toHaveBeenCalled()
  })

  it('does not decode a photo that is already small', async () => {
    stubBrowser()
    const file = photoFile({ bytes: 400_000, name: 'card.jpg', type: 'image/jpeg' })

    expect(await prepareImageForUpload(file)).toBe(file)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('keeps the original when re-encoding would not save anything', async () => {
    stubBrowser({ encodedBytes: 2 * 1024 * 1024 + 1_000_000 })
    const file = photoFile()

    expect(await prepareImageForUpload(file)).toBe(file)
  })

  it('keeps the original when the browser cannot decode the photo', async () => {
    stubBrowser({ decode: false })
    const file = photoFile()

    expect(await prepareImageForUpload(file)).toBe(file)
  })

  it('ignores files that are not images', async () => {
    stubBrowser()
    const file = photoFile({ name: 'notes.pdf', type: 'application/pdf' })

    expect(await prepareImageForUpload(file)).toBe(file)
  })
})

describe('prepareImagesForUpload', () => {
  it('prepares a batch in the order the photos were staged', async () => {
    stubBrowser()
    const small = photoFile({ bytes: 100_000, name: 'small.jpg', type: 'image/jpeg' })
    const largeOne = photoFile({ name: 'large-one.jpg', type: 'image/jpeg' })
    const largeTwo = photoFile({ name: 'large-two.jpg', type: 'image/jpeg' })

    const prepared = await prepareImagesForUpload([small, largeOne, largeTwo])

    expect(prepared).toHaveLength(3)
    expect(prepared[0]).toBe(small)
    expect(prepared[1].name).toBe('large-one.jpg')
    expect(prepared[2].name).toBe('large-two.jpg')
  })

  it('reports how far a batch has got', async () => {
    stubBrowser()
    const calls = []
    await prepareImagesForUpload(
      [photoFile(), photoFile()],
      { onProgress: (done, total) => calls.push([done, total]) },
    )
    expect(calls.map(([done]) => done).sort()).toEqual([1, 2])
    expect(calls.every(([, total]) => total === 2)).toBe(true)
  })
})
