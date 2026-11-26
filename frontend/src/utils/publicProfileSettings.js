export function buildPublicProfileUpdate({ profilePublic, showValues, defaultNewBinders, showAllOwnedCards, wishlistVisibility }) {
  const payload = {
    is_profile_public: Boolean(profilePublic),
    public_show_values: Boolean(showValues),
    // Save the opt-in regardless of current profile visibility. The server only
    // applies it when public profiles and this profile are enabled.
    public_default_new_binders: Boolean(defaultNewBinders),
    public_show_all_owned_cards: Boolean(showAllOwnedCards),
  }
  if (wishlistVisibility !== undefined) payload.wishlist_visibility = wishlistVisibility
  return payload
}
