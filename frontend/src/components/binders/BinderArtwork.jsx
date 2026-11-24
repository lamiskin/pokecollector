import { CardDisplay } from '../card-system'
import { CollectionCardDisplay } from '../CollectionCardImage'
import { resolveCardImageUrl } from '../../utils/imageUrl'

// One pocket is one copy: the variant pill names that printing without
// inventing a quantity, the frame carries the same holo effect as everywhere
// else, and the owner's photo follows the normal preference rules. Shared by
// the pages, the Not placed tray, the chooser and the remove dialog so every
// surface shows the same copy.
export default function Artwork({ entry, readOnly }) {
  const card = { ...entry, id: entry.card_id }
  const stateIndicatorProps = {
    card: { owned_variants: entry.variant ? [{ variant: entry.variant, quantity: 1 }] : [] },
    showQuantity: false,
    showWishlist: false,
  }
  const props = {
    variant: 'artwork',
    card,
    image: resolveCardImageUrl(card),
    alt: entry.name,
    interactive: false,
    variantEffectSource: entry.variant,
    showStateIndicators: Boolean(entry.variant),
    stateIndicatorProps,
  }
  return readOnly ? <CardDisplay {...props} /> : <CollectionCardDisplay {...props} item={{ id: entry.collection_item_id, card, has_scan_photo: entry.has_scan_photo }} />
}
