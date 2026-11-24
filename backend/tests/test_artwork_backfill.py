import datetime
import unittest
from unittest import mock

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Card, CollectionItem, ImageCache, Set
    from services import artwork_backfill, pokemon_api

    DEPS = True
except ModuleNotFoundError:
    DEPS = False


def _days_ago(days: int) -> datetime.datetime:
    return datetime.datetime.utcnow() - datetime.timedelta(days=days)


def _brief(tcg_card_id: str, image: str | None = "https://assets.example.test/sv/1") -> dict:
    payload = {"id": tcg_card_id, "localId": tcg_card_id.rsplit("-", 1)[-1], "name": "Card"}
    if image:
        payload["image"] = image
    return payload


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class ArtworkSweepTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine, autoflush=False)
        self.db = Session()

    def tearDown(self):
        self.db.close()

    # -- fixtures ---------------------------------------------------------

    def _add_set(self, set_id: str, *, lang: str = "en", attempts: int = 0,
                 checked_at: datetime.datetime | None = None) -> Set:
        set_obj = Set(
            id=f"{set_id}_{lang}",
            tcg_set_id=set_id,
            name=set_id,
            total=1,
            lang=lang,
            is_digital=False,
            artwork_checked_at=checked_at,
            artwork_check_attempts=attempts,
        )
        self.db.add(set_obj)
        self.db.flush()
        return set_obj

    def _add_card(self, set_id: str, number: str, *, lang: str = "en",
                  tcg_card_id: str | None = None, **kwargs) -> Card:
        card = Card(
            id=f"{set_id}-{number}_{lang}",
            tcg_card_id=tcg_card_id if tcg_card_id is not None else f"{set_id}-{number}",
            name=f"Card {number}",
            set_id=set_id,
            number=str(number),
            lang=lang,
            is_custom=False,
            **kwargs,
        )
        self.db.add(card)
        self.db.flush()
        return card

    def _sweep(self, set_obj: Set):
        briefs = [_brief(f"{set_obj.tcg_set_id}-1")]
        with mock.patch.object(
            pokemon_api, "get_set_card_briefs", return_value=briefs
        ) as fetch:
            result = artwork_backfill.sweep_set(self.db, set_obj)
        return result, fetch

    # -- filling artwork --------------------------------------------------

    def test_fills_only_cards_with_missing_artwork(self):
        set_obj = self._add_set("sv1")
        missing = self._add_card("sv1", "1")
        existing = self._add_card(
            "sv1", "2",
            images_small="https://old.example.test/2/low.webp",
            images_large="https://old.example.test/2/high.webp",
        )
        self.db.commit()

        briefs = [
            _brief("sv1-1", "https://assets.example.test/sv1/1"),
            _brief("sv1-2", "https://assets.example.test/sv1/2"),
        ]
        with mock.patch.object(pokemon_api, "get_set_card_briefs", return_value=briefs):
            result = artwork_backfill.sweep_set(self.db, set_obj)

        self.assertFalse(result["failed"])
        self.assertEqual(result["cards_updated"], 1)
        self.assertEqual(missing.images_small, "https://assets.example.test/sv1/1/low.webp")
        self.assertEqual(missing.images_large, "https://assets.example.test/sv1/1/high.webp")
        # Existing artwork is never rewritten.
        self.assertEqual(existing.images_small, "https://old.example.test/2/low.webp")
        self.assertEqual(existing.images_large, "https://old.example.test/2/high.webp")

    def test_clears_manual_artwork_and_custom_cache_when_real_art_lands(self):
        set_obj = self._add_set("sv1")
        card = self._add_card(
            "sv1", "1",
            custom_image_url="https://example.test/manual.webp",
            image_source_lang="de",
        )
        self.db.add_all([
            ImageCache(image_key=f"card:{card.id}:small:custom", data=b"small"),
            ImageCache(image_key=f"card:{card.id}:large:custom", data=b"large"),
            ImageCache(image_key=f"card:{card.id}:large:abcdef", data=b"official"),
        ])
        self.db.commit()

        self._sweep(set_obj)

        self.assertIsNone(card.custom_image_url)
        self.assertIsNone(card.image_source_lang)
        keys = {row.image_key for row in self.db.query(ImageCache).all()}
        self.assertEqual(keys, {f"card:{card.id}:large:abcdef"})

    def test_ignores_briefs_without_image(self):
        set_obj = self._add_set("sv1")
        card = self._add_card("sv1", "1")
        self.db.commit()

        with mock.patch.object(
            pokemon_api, "get_set_card_briefs", return_value=[_brief("sv1-1", image=None)]
        ):
            result = artwork_backfill.sweep_set(self.db, set_obj)

        self.assertEqual(result["cards_updated"], 0)
        self.assertIsNone(card.images_small)
        self.assertIsNone(card.images_large)
        # The set was still checked, so it backoffs instead of being retried now.
        self.assertIsNotNone(set_obj.artwork_checked_at)
        self.assertEqual(set_obj.artwork_check_attempts, 1)

    def test_ignores_cards_missing_from_the_local_catalogue(self):
        set_obj = self._add_set("sv1")
        self._add_card("sv1", "1")
        custom = Card(
            id="custom-1_en",
            tcg_card_id="sv1-1",
            name="Custom",
            set_id="sv1",
            lang="en",
            is_custom=True,
        )
        self.db.add(custom)
        self.db.commit()

        with mock.patch.object(
            pokemon_api, "get_set_card_briefs", return_value=[_brief("sv1-404")]
        ):
            result = artwork_backfill.sweep_set(self.db, set_obj)

        self.assertEqual(result["cards_updated"], 0)
        self.assertIsNone(custom.images_large)

    def test_other_language_cards_are_not_filled(self):
        set_obj = self._add_set("sv1", lang="de")
        de_card = self._add_card("sv1", "1", lang="de")
        en_card = self._add_card("sv1", "1", lang="en")
        self.db.commit()

        with mock.patch.object(
            pokemon_api, "get_set_card_briefs", return_value=[_brief("sv1-1")]
        ):
            result = artwork_backfill.sweep_set(self.db, set_obj)

        self.assertEqual(result["cards_updated"], 1)
        self.assertIsNotNone(de_card.images_large)
        self.assertIsNone(en_card.images_large)

    # -- backoff schedule -------------------------------------------------

    def test_not_yet_due_set_is_skipped_unless_forced(self):
        set_obj = self._add_set("sv1", attempts=0, checked_at=_days_ago(1))
        self._add_card("sv1", "1")
        self.db.commit()

        with mock.patch.object(
            pokemon_api, "get_set_card_briefs", return_value=[_brief("sv1-1")]
        ) as fetch:
            skipped = artwork_backfill.run_artwork_sweep(self.db)

        self.assertEqual(skipped["sets_checked"], 0)
        self.assertEqual(skipped["remaining"], 0)
        fetch.assert_not_called()

        with mock.patch.object(
            pokemon_api, "get_set_card_briefs", return_value=[_brief("sv1-1")]
        ):
            forced = artwork_backfill.run_artwork_sweep(self.db, force=True)

        self.assertEqual(forced["sets_checked"], 1)
        self.assertEqual(forced["cards_updated"], 1)

    def test_backoff_is_capped_at_ninety_days(self):
        set_obj = self._add_set("sv1", attempts=99, checked_at=_days_ago(89))
        self.assertFalse(artwork_backfill.is_set_due(set_obj))
        set_obj.artwork_checked_at = _days_ago(91)
        self.assertTrue(artwork_backfill.is_set_due(set_obj))
        self.assertEqual(artwork_backfill.backoff_days(99), 90)

    def test_successful_fill_resets_attempts(self):
        set_obj = self._add_set("sv1", attempts=5, checked_at=_days_ago(91))
        self._add_card("sv1", "1")
        self.db.commit()
        self.assertTrue(artwork_backfill.is_set_due(set_obj))

        result, _ = self._sweep(set_obj)

        self.assertEqual(result["cards_updated"], 1)
        self.assertEqual(set_obj.artwork_check_attempts, 0)

    def test_unsuccessful_check_increments_attempts(self):
        set_obj = self._add_set("sv1", attempts=2, checked_at=_days_ago(91))
        self._add_card("sv1", "1")
        self.db.commit()

        with mock.patch.object(
            pokemon_api, "get_set_card_briefs", return_value=[_brief("sv1-1", image=None)]
        ):
            artwork_backfill.sweep_set(self.db, set_obj)

        self.assertEqual(set_obj.artwork_check_attempts, 3)

    # -- whole-sweep behaviour -------------------------------------------

    def test_sweep_continues_past_a_failing_set(self):
        bad = self._add_set("aaa")
        good = self._add_set("bbb")
        self._add_card("aaa", "1")
        good_card = self._add_card("bbb", "1")
        self.db.commit()

        def fake_briefs(tcg_id, lang="en"):
            if tcg_id == "aaa":
                raise RuntimeError("tcgdex unavailable")
            return [_brief("bbb-1")]

        with mock.patch.object(pokemon_api, "get_set_card_briefs", side_effect=fake_briefs):
            stats = artwork_backfill.run_artwork_sweep(self.db)

        self.assertEqual(stats, {
            "sets_checked": 2,
            "sets_failed": 1,
            "cards_updated": 1,
            "remaining": 0,
        })
        self.assertIsNotNone(good_card.images_large)
        self.assertEqual(bad.artwork_check_attempts, 1)
        self.assertIsNotNone(bad.artwork_checked_at)

    def test_sweep_respects_limit_and_reports_remaining(self):
        for set_id in ("sv1", "sv2", "sv3"):
            self._add_set(set_id)
            self._add_card(set_id, "1")
        self.db.commit()

        with mock.patch.object(
            pokemon_api, "get_set_card_briefs", return_value=[]
        ) as fetch:
            stats = artwork_backfill.run_artwork_sweep(self.db, limit=2)

        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(stats["sets_checked"], 2)
        self.assertEqual(stats["remaining"], 1)

    def test_collection_and_wishlist_sets_are_swept_first(self):
        plain = self._add_set("aaa")
        owned = self._add_set("zzz")
        plain_card = self._add_card("aaa", "1")
        owned_card = self._add_card("zzz", "1")
        self.db.add(CollectionItem(card_id=owned_card.id, quantity=1, variant="Normal"))
        self.db.commit()

        order = [row.id for row in artwork_backfill._candidate_sets(self.db)]

        self.assertEqual(order, [owned.id, plain.id])
        self.assertIsNotNone(plain_card)
        self.assertIsNotNone(owned_card)

    def test_status_reports_artwork_gaps_and_last_sweep(self):
        set_obj = self._add_set("sv1")
        self._add_card("sv1", "1")
        self._add_card("sv1", "2", images_small="a", images_large="b")
        self.db.commit()

        before = artwork_backfill.artwork_status(self.db)
        self.assertEqual(before["imagelessCards"], 1)
        self.assertEqual(before["imagelessSets"], 1)
        self.assertEqual(before["dueSets"], 1)
        self.assertEqual(before["pendingSets"], 0)
        self.assertFalse(before["running"])

        self._sweep(set_obj)

        after = artwork_backfill.artwork_status(self.db)
        self.assertEqual(after["imagelessCards"], 0)
        self.assertEqual(after["imagelessSets"], 0)
        self.assertIsNotNone(after["lastSweepAt"])
        self.assertTrue(after["lastSweepAt"].endswith("Z"))


@unittest.skipUnless(DEPS, "Backend sync dependencies are not installed")
class SetCardBriefsTests(unittest.TestCase):
    def test_returns_list_payload(self):
        payload = [_brief("sv1-1")]
        client = mock.MagicMock()
        client.__enter__.return_value = client
        client.get.return_value.json.return_value = payload
        with mock.patch.object(pokemon_api.httpx, "Client", return_value=client):
            self.assertEqual(pokemon_api.get_set_card_briefs("sv1", "de"), payload)

        args, kwargs = client.get.call_args
        self.assertTrue(args[0].endswith("/de/cards"))
        self.assertEqual(kwargs["params"], {"set": "sv1"})

    def test_returns_empty_list_for_non_list_payload(self):
        client = mock.MagicMock()
        client.__enter__.return_value = client
        client.get.return_value.json.return_value = {"message": "not a list"}
        with mock.patch.object(pokemon_api.httpx, "Client", return_value=client):
            self.assertEqual(pokemon_api.get_set_card_briefs("sv1"), [])


if __name__ == "__main__":
    unittest.main()
