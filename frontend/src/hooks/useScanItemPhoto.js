import { useEffect, useState } from 'react'
import { fetchScanJobItemImage } from '../api/client'

// The stored photo for a queued item, as an object URL.
//
// Fetched as a blob because the endpoint is authenticated (an <img src>
// cannot send the bearer token), which also means it survives a reload where
// a local blob: URL would not. Lives in its own module so the review panels,
// the full-screen comparison and the manual-card dialog can share it without
// importing each other.
export function useScanItemPhoto(jobId, item) {
  const [url, setUrl] = useState(null)

  // `item` can be null — ScanQueue's review session calls this before a
  // photo is chosen, and hooks cannot sit behind a conditional.
  useEffect(() => {
    if (!item?.has_image) {
      setUrl(null)
      return undefined
    }
    let disposed = false
    let objectUrl = null
    fetchScanJobItemImage(jobId, item.id)
      .then(nextUrl => {
        if (disposed) {
          URL.revokeObjectURL(nextUrl)
          return
        }
        objectUrl = nextUrl
        setUrl(nextUrl)
      })
      .catch(() => setUrl(null))
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [jobId, item?.id, item?.has_image])

  return url
}
