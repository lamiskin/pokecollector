"""Migrating a custom card must not silently lose its manual artwork."""

import unittest
from unittest.mock import patch

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.cards import migrate_custom_card
    from database import Base
    from models import Card, CustomCardMatch, User

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed")
class CustomCardMigrationArtworkTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="migrate-art-owner", hashed_password="x", is_active=True)
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _api_card(self, images_small=None, images_large=None):
        card = Card(
            id="sv9-1_en",
            tcg_card_id="sv9-1",
            name="Sprigatito",
            set_id="sv9",
            number="1",
            lang="en",
            images_small=images_small,
            images_large=images_large,
        )
        self.db.add(card)
        self.db.commit()
        return card

    def _custom_card(self, images_small=None, images_large=None):
        card = Card(
            id="custom-manual",
            name="Manual Sprigatito",
            lang="en",
            is_custom=True,
            custom_owner_id=self.user.id,
            images_small=images_small,
            images_large=images_large,
        )
        self.db.add(card)
        self.db.commit()
        return card

    def _migrate(self, api_card, custom_card):
        match = CustomCardMatch(
            custom_card_id=custom_card.id,
            api_card_id=api_card.tcg_card_id,
            status="pending",
        )
        self.db.add(match)
        self.db.commit()
        self.db.refresh(match)

        parsed = {
            "id": api_card.id,
            "tcg_card_id": api_card.tcg_card_id,
            "name": "Sprigatito",
            "set_id": "sv9",
            "number": "1",
            "lang": "en",
            "images_small": api_card.images_small,
            "images_large": api_card.images_large,
        }
        with patch("api.cards.pokemon_api.get_card", return_value={"id": "sv9-1", "name": "Sprigatito"}), \
             patch("api.cards.pokemon_api.parse_card_for_db", return_value=parsed), \
             patch("api.cards.apply_cross_language_fallbacks", side_effect=lambda _db, value: value):
            result = migrate_custom_card(match.id, db=self.db, current_user=self.user)

        self.assertEqual(result["status"], "migrated")
        self.db.expire_all()
        return self.db.get(Card, api_card.id)

    def test_keeps_manual_artwork_when_the_api_card_has_none(self):
        api_card = self._api_card()
        custom_card = self._custom_card(
            images_small="https://8.8.8.8/scan.jpg",
            images_large="https://8.8.8.8/scan.jpg",
        )

        migrated = self._migrate(api_card, custom_card)

        self.assertEqual(migrated.custom_image_url, "https://8.8.8.8/scan.jpg")
        # The fallback must not masquerade as real TCGdex artwork.
        self.assertIsNone(migrated.images_small)
        self.assertIsNone(migrated.images_large)
        self.assertIsNone(self.db.get(Card, custom_card.id))

    def test_leaves_the_api_cards_own_artwork_untouched(self):
        api_card = self._api_card(
            images_small="https://api.example/sv9-1/low.webp",
            images_large="https://api.example/sv9-1/high.webp",
        )
        custom_card = self._custom_card(
            images_small="https://8.8.8.8/scan.jpg",
            images_large="https://8.8.8.8/scan.jpg",
        )

        migrated = self._migrate(api_card, custom_card)

        self.assertIsNone(migrated.custom_image_url)
        self.assertEqual(migrated.images_small, "https://api.example/sv9-1/low.webp")
        self.assertEqual(migrated.images_large, "https://api.example/sv9-1/high.webp")

    def test_does_not_replace_an_existing_manual_fallback(self):
        api_card = self._api_card()
        api_card.custom_image_url = "https://8.8.8.8/older-fallback.jpg"
        self.db.commit()
        custom_card = self._custom_card(
            images_small="https://8.8.8.8/scan.jpg",
            images_large="https://8.8.8.8/scan.jpg",
        )

        migrated = self._migrate(api_card, custom_card)

        self.assertEqual(migrated.custom_image_url, "https://8.8.8.8/older-fallback.jpg")

    def test_skips_manual_art_that_is_not_public_https(self):
        api_card = self._api_card()
        custom_card = self._custom_card(
            images_small="http://8.8.8.8/scan.jpg",
            images_large="http://8.8.8.8/scan.jpg",
        )

        migrated = self._migrate(api_card, custom_card)

        self.assertIsNone(migrated.custom_image_url)

    def test_skips_when_the_custom_card_had_no_image(self):
        api_card = self._api_card()
        custom_card = self._custom_card()

        migrated = self._migrate(api_card, custom_card)

        self.assertIsNone(migrated.custom_image_url)


if __name__ == "__main__":
    unittest.main()
