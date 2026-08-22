import unittest

try:
    from services.card_field_cleanup import (
        clean_card_info, clean_number_local, clean_set_code, energy_search_name,
        energy_type_name, is_generic_energy_name, set_code_candidates,
    )
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class EnergyCardTests(unittest.TestCase):
    """A basic Energy card prints "Basic Energy"; TCGdex calls it "Water Energy".

    On a real 72-card set every wrongly-matched card was a basic Energy, and this
    name gap was the whole cause: the printed name matched nothing, and the prefix
    fallback then trimmed it to "Basic" and matched an unrelated pool.
    """

    def test_builds_the_catalogue_name_from_the_symbol(self):
        card = {"card_type": "Energy", "name_en": "Basic Energy", "energy_type": "Water"}
        self.assertEqual(energy_search_name(card), "Water Energy")

    def test_covers_the_bare_energy_spelling_too(self):
        # Vintage Base Set energies print only "ENERGY".
        card = {"card_type": "Energy", "name_en": "ENERGY", "energy_type": "fighting"}
        self.assertEqual(energy_search_name(card), "Fighting Energy")

    def test_leaves_a_special_energy_alone(self):
        # "Double Turbo Energy" is its real catalogue name — searching it works,
        # and replacing it with "Colorless Energy" would lose the card.
        card = {"card_type": "Energy", "name_en": "Double Turbo Energy",
                "energy_type": "Colorless"}
        self.assertIsNone(energy_search_name(card))

    def test_leaves_a_name_that_already_carries_its_type(self):
        card = {"card_type": "Energy", "name_en": "Basic Water Energy", "energy_type": "Water"}
        self.assertIsNone(energy_search_name(card))

    def test_no_substitution_without_a_type(self):
        card = {"card_type": "Energy", "name_en": "Basic Energy", "energy_type": None}
        self.assertIsNone(energy_search_name(card))

    def test_never_applies_to_a_pokemon(self):
        # A Pokemon named "...Energy" must not be rewritten.
        card = {"card_type": "Pokemon", "name_en": "Energy", "energy_type": "Water"}
        self.assertIsNone(energy_search_name(card))

    def test_rejects_a_type_that_does_not_exist(self):
        card = {"card_type": "Energy", "name_en": "Basic Energy", "energy_type": "Shadow"}
        self.assertIsNone(energy_search_name(card))

    def test_canonicalises_capitalisation(self):
        self.assertEqual(energy_type_name("water"), "Water")
        self.assertEqual(energy_type_name("  METAL "), "Metal")
        self.assertIsNone(energy_type_name("Shadow"))
        self.assertIsNone(energy_type_name(None))

    def test_cleanup_drops_an_invented_type(self):
        self.assertIsNone(clean_card_info({"energy_type": "Sparkle"})["energy_type"])
        self.assertEqual(clean_card_info({"energy_type": "psychic"})["energy_type"], "Psychic")

    def test_generic_names_are_flagged_so_the_prefix_trim_is_skipped(self):
        for name in ("Basic Energy", "ENERGY", "basic  energy"):
            self.assertTrue(is_generic_energy_name(name), name)

    def test_a_real_card_name_is_not_flagged_as_generic(self):
        for name in ("Double Turbo Energy", "Exeggcute", "", None):
            self.assertFalse(is_generic_energy_name(name), name)


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class SetCodeCleanupTests(unittest.TestCase):
    """Cards print the set code and language as one block ("SVI EN"); matching
    wants only the code, and a single leftover character is really the
    regulation mark landing in the wrong field."""

    def test_strips_a_trailing_language_block(self):
        self.assertEqual(clean_set_code("SVI EN"), "SVI")
        self.assertEqual(clean_set_code("sv1-de"), "SV1")

    def test_keeps_a_bare_code_unchanged(self):
        self.assertEqual(clean_set_code("MEE"), "MEE")

    def test_rejects_a_single_leftover_character(self):
        # "F EN" reduces to "F" once the language block is stripped — too short
        # to be a code, and really the regulation mark misread into this field.
        self.assertIsNone(clean_set_code("F EN"))

    def test_blank_values_return_none(self):
        for value in (None, "", "null", "  "):
            self.assertIsNone(clean_set_code(value))


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class SetCodeCandidateTests(unittest.TestCase):
    def test_includes_the_original_and_cleaned_forms(self):
        candidates = set_code_candidates("svi en")
        self.assertIn("SVI EN", candidates)
        self.assertIn("SVI", candidates)

    def test_includes_confusable_glyph_forms(self):
        # An OCR pass confuses 1<->I and 0<->O; both directions must be offered
        # so a misread code still matches Set.abbreviation.
        candidates = set_code_candidates("SV01")
        self.assertIn("SVOI", candidates)

    def test_blank_value_yields_no_candidates(self):
        self.assertEqual(set_code_candidates(None), set())
        self.assertEqual(set_code_candidates(""), set())


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class NumberLocalCleanupTests(unittest.TestCase):
    """A Pokedex species entry ("No. 039") printed under the artwork is never the
    card's own collector number, but a local model sometimes reads it as one."""

    def test_drops_a_pokedex_number(self):
        self.assertIsNone(clean_number_local("No. 039"))
        self.assertIsNone(clean_number_local("NO. 0094"))

    def test_keeps_a_real_collector_number(self):
        self.assertEqual(clean_number_local("063"), "063")
        self.assertEqual(clean_number_local("TG01"), "TG01")

    def test_blank_values_return_none(self):
        for value in (None, "", "null"):
            self.assertIsNone(clean_number_local(value))


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class CleanCardInfoWiringTests(unittest.TestCase):
    """clean_card_info is the single pipeline both fields are normalized through,
    called from api.recognize.normalize_recognized_card_info."""

    def test_set_code_and_number_local_are_cleaned_in_place(self):
        cleaned = clean_card_info({
            "set_code": "SVI EN",
            "number_local": "No. 039",
        })
        self.assertEqual(cleaned["set_code"], "SVI")
        self.assertIsNone(cleaned["number_local"])

    def test_absent_fields_are_left_untouched(self):
        # Only normalizes keys that are actually present, so a caller who never
        # set these fields does not get them injected as None.
        cleaned = clean_card_info({"name": "Pikachu"})
        self.assertNotIn("set_code", cleaned)
        self.assertNotIn("number_local", cleaned)


if __name__ == "__main__":
    unittest.main()
