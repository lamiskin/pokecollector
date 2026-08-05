/**
 * CollectionCardImage — a collection item's picture. Priority is: the owner's
 * own uploaded/kept photo, then the TCGdex catalogue scan, then the card back.
 *
 * The photo wins over the catalogue whenever one exists, not just when the
 * catalogue has nothing — it is a photo of the card the owner actually has,
 * where a catalogue scan is only ever a reference image of the printing. The
 * catalogue is still there as the fallback for the common case: most cards
 * have no owner photo at all.
 *
 * The photo is always badged. A phone photo and a catalogue scan are not the
 * same kind of thing, and a collection is much less useful if you cannot tell
 * at a glance which you are looking at.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Camera } from 'lucide-react'
import CardImage from './CardImage'
import { fetchCollectionItemPhoto } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'

// Should this item show the owner's photo rather than the catalogue? Just the
// flag — the photo wins whenever it exists, catalogue or not. See the module
// comment above for why that ordering is deliberate.
export const showsOwnPhoto = (item) => Boolean(item?.has_scan_photo)

/**
 * Object URL for this item's own photo, or null when it has none (or has a
 * catalogue scan, which is preferred). Safe to call for any item — it fetches
 * nothing when there is no photo to fetch.
 */
export function useCollectionPhotoUrl(item) {
  const ownPhoto = showsOwnPhoto(item)

  // The Blob is cached, not the object URL: object URLs belong to the component
  // instance that created them and are revoked on unmount, so caching one would
  // hand later renders a URL that has already been released. The same photo can
  // appear in the grid, the list and the detail modal at once.
  const { data: blob } = useQuery({
    queryKey: ['collection-photo', item?.id],
    queryFn: () => fetchCollectionItemPhoto(item.id),
    enabled: ownPhoto && Boolean(item?.id),
    staleTime: Infinity,
    retry: false,
  })

  const [photoUrl, setPhotoUrl] = useState(null)
  useEffect(() => {
    if (!blob) {
      setPhotoUrl(null)
      return
    }
    const url = URL.createObjectURL(blob)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [blob])

  return photoUrl
}

export default function CollectionCardImage({
  item,
  alt,
  className,
  size = 'small',
  badgeSize = 12,
  showName = false,
}) {
  const { t } = useSettings()
  const card = item?.card
  const ownPhoto = showsOwnPhoto(item)
  const photoUrl = useCollectionPhotoUrl(item)

  const catalogueSrc = resolveCardImageUrl(card, size)
  if (!ownPhoto) {
    return <CardImage src={catalogueSrc} alt={alt} className={className} showName={showName} />
  }

  // The catalogue image, when there is one, is the placeholder while the photo
  // blob is still in flight — an instant picture of the right card beats a card
  // back flash, and it's what this item showed before it had its own photo.
  // Falls through to CardImage's own card-back fallback when there is neither.
  return (
    <div className="relative h-full">
      <CardImage src={photoUrl || catalogueSrc} alt={alt} className={className} showName={showName} />
      {photoUrl && (
        <span
          className="absolute bottom-1 right-1 z-10 inline-flex items-center justify-center rounded-md bg-black/70 text-white/90 border border-white/20 p-1 pointer-events-none"
          title={t('collection.ownPhoto')}
        >
          <Camera size={badgeSize} />
        </span>
      )}
    </div>
  )
}
