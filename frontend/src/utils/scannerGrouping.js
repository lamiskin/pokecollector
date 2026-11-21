// The card scanner derives its default grouping from the configured provider
// instead of storing a preference. A local/self-hosted model handles one card
// per photo reliably, so those scans default to individual photos, while
// hosted providers default to reading several cards out of one photo.
//
// A staged photo carries a tri-state `individual`: `null` follows the scanner's
// default, `true`/`false` is a choice the user made. Resolving here — at render
// and submit time, never when the photo is staged — lets photos added while the
// scanner configuration is still loading adopt the real default once it
// arrives, while any photo the user already toggled keeps their choice.

const INDIVIDUAL = 'individual'

export const scannerGroupsIndividuallyByDefault = configuration =>
  configuration?.default_grouping === INDIVIDUAL

export const resolveIndividual = (individual, configuration) => {
  if (individual === true || individual === false) return individual
  return scannerGroupsIndividuallyByDefault(configuration)
}

// Toggling a photo flips it away from the default when it still follows the
// default, and returns it to the default when it is an override — on a local
// provider that reads "group this photo", then "back to scanning it alone"; on
// a hosted one, "scan this photo alone", then back to automatic grouping.
// `null` is not a choice, it is "follow the scanner".
export const nextIndividualChoice = (individual, configuration) => {
  const byDefault = scannerGroupsIndividuallyByDefault(configuration)
  return resolveIndividual(individual, configuration) === byDefault ? !byDefault : null
}

export const individualPositions = (items, configuration) => (
  (Array.isArray(items) ? items : []).reduce((positions, item, position) => {
    if (resolveIndividual(item?.individual, configuration)) positions.push(position)
    return positions
  }, [])
)
