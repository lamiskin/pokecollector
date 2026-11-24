"""Language-aware resolution of a custom card's free-text set."""

import unittest

try:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from database import Base
    from models import Set, User, UserSetting
    from services.custom_cards import find_set_for_free_text_id, stage_custom_card

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "SQLAlchemy is not installed")
class CustomCardSetLanguageTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="custom-lang", hashed_password="x", is_active=True)
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)
        # The same set exists once per language, as the catalogue stores it.
        self.db.add_all([
            Set(id="sv1_en", tcg_set_id="sv1", name="Scarlet & Violet", lang="en", total=198),
            Set(id="sv1_de", tcg_set_id="sv1", name="Karmesin & Purpur", lang="de", total=198),
            Set(id="sv1_ja", tcg_set_id="sv1", name="Scarlet ex", lang="ja", total=198),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _set_user_language(self, value):
        self.db.add(UserSetting(user_id=self.user.id, key="language", value=value))
        self.db.commit()

    def _create(self, set_id="sv1", set_name=None):
        return stage_custom_card(
            self.db,
            self.user,
            name="Manual Karte",
            set_id=set_id,
            set_name=set_name,
        )

    def test_user_language_picks_that_printing(self):
        self._set_user_language("de")

        card = self._create()

        self.assertEqual(card.lang, "de")
        self.assertEqual(
            find_set_for_free_text_id(self.db, "sv1", user_id=self.user.id).lang,
            "de",
        )

    def test_user_without_a_language_setting_gets_english(self):
        card = self._create()

        self.assertEqual(card.lang, "en")

    def test_unsupported_language_setting_falls_back_to_english(self):
        self._set_user_language("xx")

        card = self._create()

        self.assertEqual(card.lang, "en")

    def test_unknown_set_still_creates_a_stub(self):
        card = self._create(set_id="mystery-set", set_name="Mystery Set")

        self.assertEqual(card.lang, "en")
        stub = self.db.query(Set).filter(Set.id == "mystery-set").one()
        self.assertEqual(stub.name, "Mystery Set")
        self.assertEqual(stub.tcg_set_id, "mystery-set")
        self.assertEqual(stub.lang, "en")


if __name__ == "__main__":
    unittest.main()
