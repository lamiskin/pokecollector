import unittest

try:
    from services.card_upsert import _apply_known_name_override

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "Card upsert dependencies are not installed")
class KnownNameOverrideTests(unittest.TestCase):
    def test_corrects_the_known_garbled_vs1_name(self):
        card_data = {"id": "VS1-041_ja", "name": "プライスのラプラス"}
        _apply_known_name_override(card_data)
        self.assertEqual(card_data["name"], "ヤナギのラプラス")

    def test_leaves_other_cards_untouched(self):
        card_data = {"id": "PMCG1-001_ja", "name": "フシギダネ"}
        _apply_known_name_override(card_data)
        self.assertEqual(card_data["name"], "フシギダネ")

    def test_survives_a_resync_that_reintroduces_the_bad_name(self):
        # Simulates upsert_card() being called again on a future full sync
        # with TCGdex's still-garbled upstream name — the override must win
        # every time, not just on first insert.
        card_data = {"id": "VS1-041_ja", "name": "プライスのラプラス"}
        _apply_known_name_override(card_data)
        card_data = {"id": "VS1-041_ja", "name": "プライスのラプラス"}
        _apply_known_name_override(card_data)
        self.assertEqual(card_data["name"], "ヤナギのラプラス")


if __name__ == "__main__":
    unittest.main()
