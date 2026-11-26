/**
 * Shrinks large photos in the browser before they are uploaded.
 *
 * Every photo the app uploads is re-encoded server-side anyway — scan photos to
 * a 3200px JPEG and collection photos to a 1400px JPEG (see
 * backend/services/scan_storage.py and collection_photos.py). What the server
 * cannot fix is the upload itself: a modern phone produces 3–15 MB files, and
 * sending fifty of those over mobile data is slow, costly, and can exceed the
 * per-file and per-job limits. Downscaling to the same edge the server would
 * use loses nothing the recognizer ever sees, so doing it first is pure saving.
 *
 * This is deliberately best-effort. HEIC is decodable in Safari but not in
 * Chrome, canvas support varies, and a browser that cannot decode an image can
 * still upload it — the server has pillow-heif. Any failure returns the
 * original file untouched.
 *
 * Compression is only applied when it is worth it: the file must be large
 * enough for the saving to pay for the decode. Smaller photos are passed
 * through byte-for-byte and never decoded, so the common clean catalogue-style
 * image does not take a second JPEG generation.
 */

// Matches the backend scan sanitizer, which is the more quality-sensitive of
// the two: the recognizer reads small print, so its input must not be shrunk
// further than the server itself would shrink it (it stores up to 3200px).
export const UPLOAD_MAX_EDGE = 3200
export const UPLOAD_JPEG_QUALITY = 0.9

// Below this, a phone photo is already close to what re-encoding would produce
// and the decode/encode round trip would cost more than it saves.
export const UPLOAD_MIN_BYTES = 1.5 * 1024 * 1024

// Keep the compressed result only when it is meaningfully smaller. Re-encoding
// a small, already-optimized image can produce a larger file for no benefit.
const REQUIRED_SAVING = 0.95

// Two at a time: decoding a 12 MP photo holds tens of megabytes, and a batch of
// 50 staged photos must not exhaust a phone's memory before the upload starts.
const MAX_PARALLEL_DECODES = 2

const COMPRESSIBLE_TYPES = /^image\/(?:jpeg|jpg|png|webp|heic|heif)$/i

/**
 * The dimensions the browser should encode to, or null when the input is not
 * a usable image size. Never upscales.
 */
export function scaledUploadDimensions(width, height, maxEdge = UPLOAD_MAX_EDGE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return null
  }
  const longest = Math.max(width, height)
  if (!Number.isFinite(maxEdge) || maxEdge < 1 || longest <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height) }
  }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Whether re-encoding this image is expected to pay off. Unknown dimensions are
 * judged on bytes alone; the decode still yields real dimensions before use.
 */
export function shouldCompress(
  { width, height, size },
  { maxEdge = UPLOAD_MAX_EDGE, minBytes = UPLOAD_MIN_BYTES } = {},
) {
  if (!Number.isFinite(size) || size <= 0) return false
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    if (maxEdge > 0 && Math.max(width, height) > maxEdge) return true
  }
  return size > minBytes
}

async function decodeForCanvas(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // `from-image` is the default in modern browsers but is spelled out so a
      // rotated phone photo is drawn upright rather than sideways.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close?.(),
      }
    } catch {
      // Older Safari rejects the options bag; HEIC outside Safari cannot decode
      // at all. The <img> path below is the fallback, then the original file.
    }
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null

  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    // Canvas draws the image as the element renders it, so this keeps EXIF
    // orientation applied when the browser honours the property.
    image.style.imageOrientation = 'from-image'
    image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('empty image')
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

function encodeJpeg(source, width, height) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      reject(new Error('2d canvas unavailable'))
      return
    }
    // PNG uploads may carry transparency, and a JPEG cannot. White is what the
    // server already composites transparency onto, so this matches it instead
    // of letting transparent areas turn black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0, 0, width, height)
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('canvas encoding failed'))),
      'image/jpeg',
      UPLOAD_JPEG_QUALITY,
    )
  })
}

function jpegName(name) {
  const base = String(name || '').replace(/\.[^./\\]+$/, '')
  return `${base || 'photo'}.jpg`
}

/**
 * Returns a File to upload: either the original (nothing to gain, unsupported
 * type, or anything went wrong) or a downscaled, metadata-free JPEG.
 */
export async function prepareImageForUpload(file, options = {}) {
  if (!file || typeof file !== 'object') return file
  if (typeof file.size !== 'number' || file.size <= 0) return file
  if (!COMPRESSIBLE_TYPES.test(String(file.type || ''))) return file
  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined') return file

  const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : UPLOAD_MIN_BYTES
  // The byte floor is checked before decoding: a photo this small uploads in
  // well under a second, and decoding every staged thumbnail would be the
  // slower half of the batch.
  if (file.size <= minBytes) return file

  const decoded = await decodeForCanvas(file)
  if (!decoded) return file

  try {
    if (!shouldCompress({ width: decoded.width, height: decoded.height, size: file.size }, options)) {
      return file
    }
    const dimensions = scaledUploadDimensions(decoded.width, decoded.height, options.maxEdge)
    if (!dimensions) return file

    const blob = await encodeJpeg(decoded.source, dimensions.width, dimensions.height)
    if (blob.size >= file.size * REQUIRED_SAVING) return file

    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } catch {
    return file
  } finally {
    decoded.release()
  }
}

/**
 * Prepares a batch in input order, with bounded parallelism so a long staged
 * batch does not decode every photo at once. `onProgress(done, total)` fires
 * after each photo, for callers that want to show the wait.
 */
export async function prepareImagesForUpload(files, { onProgress, ...options } = {}) {
  const list = Array.from(files || [])
  const prepared = new Array(list.length)
  const report = typeof onProgress === 'function' ? onProgress : null
  let next = 0
  let done = 0

  const worker = async () => {
    while (next < list.length) {
      const index = next
      next += 1
      prepared[index] = await prepareImageForUpload(list[index], options)
      done += 1
      report?.(done, list.length)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_DECODES, list.length) }, worker),
  )
  return prepared
}
