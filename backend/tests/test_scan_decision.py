"""Feature extraction for the decision layer.

The fitted weights in services.scan_decision are provisional and NOT wired into the
scan path; these tests pin the feature semantics, which is what later calibration
depends on.
"""

import unittest

from services.scan_decision import build_features


class DecisionFeatureTests(unittest.TestCase):
    def test_number_match_is_detected_across_zero_padding(self):
        features = build_features(
            read={"name": "Powerglass", "number_local": "97"},
            candidates=[{"name": "Powerglass", "number": "097", "printed_total": "064"}],
        )
        self.assertEqual(features["number_matches"], 1.0)
        self.assertEqual(features["name_exact"], 1.0)

    def test_number_above_printed_total_is_out_of_set(self):
        features = build_features(
            read={"number_local": "182"},
            candidates=[{"name": "X", "number": "182", "printed_total": "088"}],
        )
        self.assertEqual(features["number_in_set"], 0.0)

    def test_extra_word_in_catalogue_name_counts_as_subset(self):
        features = build_features(
            read={"name": "Growing Energy"},
            candidates=[{"name": "Growing Grass Energy", "number": "086"}],
        )
        self.assertEqual(features["name_subset"], 1.0)
        self.assertEqual(features["name_exact"], 0.0)
        self.assertEqual(features["glyph_energy"], 1.0)

    def test_accents_and_case_are_normalised(self):
        features = build_features(
            read={"name": "Látios"},
            candidates=[{"name": "Latios", "number": "194"}],
        )
        self.assertEqual(features["name_exact"], 1.0)
        self.assertEqual(features["name_lev"], 0.0)

    def test_set_code_validity_uses_the_supplied_codes(self):
        features = build_features(
            read={"set_code": "FUSN"},
            candidates=[{"name": "Latios", "number": "194"}],
            known_set_codes={"FUS", "PAL"},
        )
        self.assertEqual(features["set_valid"], 0.0)
        self.assertEqual(features["set_edit1"], 1.0)

    def test_no_candidates_yields_a_neutral_feature_vector(self):
        features = build_features(read={"name": "Zorua", "number_local": "112"}, candidates=[])
        self.assertEqual(features["has_top1"], 0.0)
        self.assertEqual(features["name_lev"], 1.0)
        self.assertEqual(features["number_matches"], 0.0)


if __name__ == "__main__":
    unittest.main()
