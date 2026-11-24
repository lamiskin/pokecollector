export const cardImageUrl = (cardId, size = 'small') =>
  cardId ? `/api/images/card/${encodeURIComponent(cardId)}/${size}` : null

export const setImageUrl = (setId, imageType) =>
  setId ? `/api/images/set/${encodeURIComponent(setId)}/${imageType}` : null

export const productImageUrl = (product) =>
  product?.image_url && product?.image_proxy_url ? product.image_proxy_url : '/cardback.jpg'

// Whether TCGdex actually has a scan of this card.
//
// Cannot be inferred from resolveCardImageUrl: that returns an /api/images URL
// for any card with an id, and the backend quietly redirects to the card back
// when it has nothing to serve. So the only honest test is on the card record,
// and callers that need to know — offering a custom image URL, or showing the
// owner's own photo instead — have to ask here.
export const hasCatalogueImage = (card) => Boolean(
  card?.images?.large || card?.images_large
  || card?.images?.small || card?.images_small
  || card?.image
)

export const resolveCardImageUrl = (card, size = 'small') => {
  // card_id is the actual card identifier (e.g. "sv1-1_de")
  // id might be a collection item integer ID, so prefer card_id or string id
  const cid = card?.card_id || (typeof card?.id === 'string' ? card.id : null)
  if (cid) return cardImageUrl(cid, size)

  if (size === 'large') {
    return card?.images?.large
      || card?.images_large
      || (card?.image ? `${card.image}/high.webp` : null)
      || card?.images?.small
      || card?.images_small
      || card?.custom_image_url
      || card?.image_url
      || null
  }

  return card?.images?.small
    || card?.images_small
    || (card?.image ? `${card.image}/low.webp` : null)
    || card?.custom_image_url
    || card?.image_url
    || null
}

// The small catalogue scan to stand behind the large one while it loads.
//
// Only the catalogue proxy pair is guaranteed to show the same printing: the
// small endpoint serves this card's own small scan, while an upstream asset
// URL, a manual image URL or the owner's photo has no cached small twin. The
// small endpoint also falls back to the large scan (and then the card back) when
// a card records no small scan, so require one on the record: an underlay of the
// card back would be a second flash instead of a shortcut.
//
// `displayedImage` is what the frame is actually showing, not a re-resolution:
// callers such as the collection dialog add cache-busting or pick the owner's
// photo, and neither should get an underlay.
export const resolveCardArtworkUnderlay = (card, displayedImage) => {
  if (!card || !displayedImage || card.is_custom) return null

  const cardId = card.card_id || (typeof card.id === 'string' ? card.id : null)
  if (!cardId) return null
  if (displayedImage !== cardImageUrl(cardId, 'large')) return null

  // The small endpoint serves images_small (falling back to the large scan,
  // then the card back), so only a recorded small scan proves the underlay is
  // this card's artwork rather than a second flash of the card back.
  const hasSmallScan = Boolean(card.images?.small || card.images_small)
  if (!hasSmallScan) return null

  const small = cardImageUrl(cardId, 'small')
  return small === displayedImage ? null : small
}

export const resolveSetImageUrl = (set, imageType) => {
  if (set?.id) return setImageUrl(set.id, imageType)
  return imageType === 'logo' ? (set?.images_logo || null) : (set?.images_symbol || null)
}
