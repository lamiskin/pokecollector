import { describe, expect, it } from 'vitest'
import { buildPublicProfileUpdate } from './publicProfileSettings'

describe('public profile settings payload', () => {
  it('persists the preference even when the profile is private', () => {
    expect(buildPublicProfileUpdate({ profilePublic: false, showValues: true, defaultNewBinders: true, showAllOwnedCards: true, wishlistVisibility: 'trade_matches' })).toEqual({
      is_profile_public: false,
      public_show_values: true,
      public_default_new_binders: true,
      public_show_all_owned_cards: true,
      wishlist_visibility: 'trade_matches',
    })
  })

  it('keeps new-binder sharing opt-in and emits false when disabled', () => {
    expect(buildPublicProfileUpdate({ profilePublic: true, showValues: false, defaultNewBinders: false, showAllOwnedCards: false })).toEqual({
      is_profile_public: true,
      public_show_values: false,
      public_default_new_binders: false,
      public_show_all_owned_cards: false,
    })
  })
})
