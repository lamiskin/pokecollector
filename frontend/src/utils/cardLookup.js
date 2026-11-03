// Outbound "go and look at this card" links, for candidates TCGdex has no scan of.
//
// Roughly one match in fourteen has no catalogue image, concentrated in trainer
// kits, Japanese printings and the newest energy subsets. Those are exactly the
// cards a reviewer most wants to eyeball, and the comparison view has nothing to
// show. Rather than pull images from somewhere else — every candidate source is
// either incomplete, fuzzy to search, or of uncertain licence — this hands the
// question to a search the user can judge for themselves.
//
// Links only: nothing is fetched, stored or reproduced, so there is no licensing
// question and no source to keep working.

// The set name matters more than its code here. "XY Trainer Kit (Bisharp)" is
// what a listing or a caption actually says; "TK7A" is an identifier TCGdex uses
// and almost nothing else does. Both go in — the code costs little and does
// occasionally appear on the card itself.
function query(match) {
  const setCode = (match?.set_abbreviation || '').toUpperCase()
  return [match?.name, match?.set, setCode, match?.number, 'pokemon card']
    .filter(Boolean).join(' ')
}

// Cardmarket's own search. Kept independent of any card-detail search-URL
// helper elsewhere in the app: a scan candidate is a much thinner object than a
// synced card — no set_ref, no product ids — so there is nothing to reuse but
// the URL shape and query parameters. The set code still needs to go in the
// search string, though: a common name+number pair like "Pikachu 25" is
// ambiguous across sets without it.
function cardmarketUrl(match) {
  const setCode = (match?.set_abbreviation || '').toUpperCase()
  const params = new URLSearchParams({
    searchMode: 'v2',
    idCategory: '51',
    idExpansion: '0',
    idRarity: '0',
    searchString: [match?.name, setCode, match?.number].filter(Boolean).join(' '),
  })
  return `https://www.cardmarket.com/en/Pokemon/Products/Singles?${params.toString()}`
}

// Pokellector's search matches card names, so the verbose query above returns
// "No Matches Found" — it needs a narrow one, as Cardmarket does. Its Japanese
// subdomain is the reason it is here at all: image search and listings are both
// weak on Japanese-language printings, and those are one of the three kinds of
// card TCGdex has no scan of. English trainer kits it will likely miss, which is
// why it complements the others rather than replacing them.
function pokellectorUrl(match, nameEn) {
  const host = (match?.lang || match?._lang) === 'ja' ? 'jp' : 'www'
  // Indexed by English name even on the Japanese subdomain — a search for
  // "プリン 035" finds nothing where "Jigglypuff 35" returns the card. So the
  // model's English reading is preferred over the catalogue's localised name,
  // which is the whole reason it is carried down here.
  const name = nameEn || match?.name
  // And by bare number: card pages are .../Jigglypuff-Card-35, not Card-035.
  const number = String(match?.number || '').replace(/^0+(?=\d)/, '')
  return `https://${host}.pokellector.com/search?criteria=${encodeURIComponent([name, number].filter(Boolean).join(' '))}`
}

export function cardLookupLinks(match, nameEn) {
  const q = encodeURIComponent(query(match))
  return [
    // Images first: the point is to see the card, not read about it.
    { key: 'images', url: `https://www.google.com/search?tbm=isch&q=${q}` },
    // Listings carry photographs of the actual printing, which is often the only
    // place an obscure trainer-kit or Japanese card appears at all.
    { key: 'ebay', url: `https://www.ebay.com/sch/i.html?_nkw=${q}` },
    // Cardmarket pages carry a catalogue scan rather than a seller photograph,
    // which is the closer comparison when the card is listed at all.
    { key: 'cardmarket', url: cardmarketUrl(match) },
    // Catalogue scans including Japanese sets, which the others handle poorly.
    { key: 'pokellector', url: pokellectorUrl(match, nameEn) },
  ]
}

// Not a link, and cannot be. Google Lens and searchbyimage both fetch the image
// themselves, so they need a publicly reachable URL — and a scan photo lives in
// Postgres behind a bearer token on a host usually not on the internet at all.
// Uploading it somewhere public to work around that would be sending the user's
// photo to a third party without asking, which is not ours to decide.
const LENS_URL = 'https://lens.google.com/'

// Reverse image search on the user's own photo — the most direct route to a card
// no catalogue has a scan of, since that photo is the one image we certainly
// have.
//
// The stored JPEG is handed over untouched, deliberately not re-encoded through
// a canvas first: a canvas → toBlob round trip on this asset has produced
// corrupted images (flat colour bands, diagonal hatching) in earlier testing,
// while the same blob renders correctly everywhere else in the review. The
// photo is already a JPEG and needs nothing done to it before handing it off.
export function searchGoogleByPhoto(objectUrl, filename) {
  window.open(LENS_URL, '_blank', 'noopener,noreferrer')

  const link = document.createElement('a')
  link.href = objectUrl
  link.download = (filename || 'scan').replace(/\.[^.]*$/, '') + '.jpg'
  document.body.appendChild(link)
  link.click()
  link.remove()
}
