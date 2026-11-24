import hashlib
import unittest
from unittest.mock import MagicMock, patch

try:
    from fastapi import BackgroundTasks
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from api.collection import add_to_collection
    from database import Base
    from models import Card, ImageCache, Setting, User
    from schemas import CollectionItemCreate
    from services.card_artwork import card_image_cache_key, warm_card_artwork

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


@unittest.skipUnless(DEPS, "FastAPI/SQLAlchemy not installed in this environment")
class CardArtworkWarmTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.db.add(Setting(key="tcgdex_sync_languages", value="en"))
        self.user = User(username="warmer", hashed_password="x", role="trainer", is_active=True)
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)
        self.image_url = "https://assets.example.test/sv1-1_large.webp"

    def tearDown(self):
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _card(self, **overrides):
        values = {
            "id": "sv1-1_en",
            "name": "Bulbasaur",
            "lang": "en",
            "images_large": self.image_url,
        }
        values.update(overrides)
        card = Card(**values)
        self.db.add(card)
        self.db.commit()
        return card

    def test_cache_key_matches_the_documented_format(self):
        expected_hash = hashlib.sha1(self.image_url.encode()).hexdigest()
        self.assertEqual(
            card_image_cache_key("sv1-1_en", "large", self.image_url),
            f"card:sv1-1_en:large:{expected_hash}",
        )

    @patch("services.card_artwork._client.get")
    def test_warm_skips_keys_that_are_already_cached(self, get):
        self._card()
        key = card_image_cache_key("sv1-1_en", "large", self.image_url)
        self.db.add(ImageCache(image_key=key, data=b"cached", content_type="image/webp"))
        self.db.commit()

        self.assertFalse(warm_card_artwork("sv1-1_en", db=self.db))
        get.assert_not_called()

    @patch("services.card_artwork._client.get")
    def test_warm_skips_custom_cards(self, get):
        self._card(is_custom=True)

        self.assertFalse(warm_card_artwork("sv1-1_en", db=self.db))
        get.assert_not_called()

    @patch("services.card_artwork._client.get")
    def test_warm_skips_cards_without_large_artwork(self, get):
        self._card(images_large=None, images_small="https://assets.example.test/sv1-1_small.webp")

        self.assertFalse(warm_card_artwork("sv1-1_en", db=self.db))
        get.assert_not_called()

    @patch("services.card_artwork._client.get")
    def test_warm_stores_artwork_on_a_miss(self, get):
        self._card()
        response = MagicMock()
        response.headers = {"content-type": "image/webp"}
        response.content = b"fresh-artwork"
        get.return_value = response

        self.assertTrue(warm_card_artwork("sv1-1_en", db=self.db))

        get.assert_called_once_with(self.image_url)
        key = card_image_cache_key("sv1-1_en", "large", self.image_url)
        entry = self.db.query(ImageCache).filter(ImageCache.image_key == key).one()
        self.assertEqual(entry.data, b"fresh-artwork")
        self.assertEqual(entry.content_type, "image/webp")

    @patch("services.card_artwork._client.get")
    def test_warm_swallows_upstream_failures(self, get):
        self._card()
        get.side_effect = RuntimeError("upstream unavailable")

        self.assertFalse(warm_card_artwork("sv1-1_en", db=self.db))

        self.assertEqual(self.db.query(ImageCache).count(), 0)

    def test_add_to_collection_enqueues_one_warm_task_for_the_added_card(self):
        self._card()
        background = BackgroundTasks()

        with (
            patch("api.collection.ensure_card_exists"),
            patch("api.collection._annotate_collection_item", side_effect=lambda db, user, item: item),
        ):
            add_to_collection(
                CollectionItemCreate(card_id="sv1-1_en", quantity=1, lang="en"),
                current_user=self.user,
                db=self.db,
                background=background,
            )

        self.assertEqual(len(background.tasks), 1)
        task = background.tasks[0]
        self.assertIs(task.func, warm_card_artwork)
        self.assertEqual(task.args, ("sv1-1_en",))


if __name__ == "__main__":
    unittest.main()
