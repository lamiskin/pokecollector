"""Artwork candidates are appended only when enabled and available."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

from api import recognize


def _row(card_id="c1", tcg="swsh8-194"):
    return SimpleNamespace(
        id=card_id, tcg_card_id=tcg, name="Latios", supertype="Pokemon",
        number="194", images_small="s", images_large="l", rarity="Rare", lang="en",
    )


class ArtworkCandidateTests(unittest.TestCase):
    def test_disabled_flag_returns_zero_without_touching_the_index(self):
        with mock.patch.object(recognize, "_artwork_candidates_enabled", return_value=False):
            added = asyncio.run(
                recognize._append_artwork_candidates(None, [], b"photo", {})
            )
        self.assertEqual(added, 0)

    def test_no_photo_bytes_returns_zero(self):
        with mock.patch.object(recognize, "_artwork_candidates_enabled", return_value=True), \
             mock.patch.object(recognize, "artwork_index_available", return_value=True):
            added = asyncio.run(
                recognize._append_artwork_candidates(mock.MagicMock(), [], None, {})
            )
        self.assertEqual(added, 0)

    def test_unavailable_index_returns_zero(self):
        with mock.patch.object(recognize, "_artwork_candidates_enabled", return_value=True), \
             mock.patch.object(recognize, "artwork_index_available", return_value=False):
            added = asyncio.run(
                recognize._append_artwork_candidates(mock.MagicMock(), [], b"photo", {})
            )
        self.assertEqual(added, 0)

    def test_hits_are_appended_once_and_flagged(self):
        db = mock.MagicMock()
        db.query.return_value.filter.return_value.with_entities.return_value.all.return_value = [_row()]
        candidates = []
        with mock.patch.object(recognize, "_artwork_candidates_enabled", return_value=True), \
             mock.patch.object(recognize, "artwork_index_available", return_value=True), \
             mock.patch.object(recognize, "artwork_search", return_value=[("swsh8-194", 0.91)]), \
             mock.patch.object(recognize, "_fill_candidate_details", new=mock.AsyncMock()):
            added = asyncio.run(
                recognize._append_artwork_candidates(db, candidates, b"photo", {"name": "Latos"})
            )
        self.assertEqual(added, 1)
        self.assertEqual(candidates[0]["tcg_card_id"], "swsh8-194")
        self.assertTrue(candidates[0]["_artwork_candidate"])

    def test_already_retrieved_cards_are_not_duplicated(self):
        db = mock.MagicMock()
        db.query.return_value.filter.return_value.with_entities.return_value.all.return_value = [_row()]
        candidates = [{"id": "c1", "tcg_card_id": "swsh8-194"}]
        with mock.patch.object(recognize, "_artwork_candidates_enabled", return_value=True), \
             mock.patch.object(recognize, "artwork_index_available", return_value=True), \
             mock.patch.object(recognize, "artwork_search", return_value=[("swsh8-194", 0.91)]), \
             mock.patch.object(recognize, "_fill_candidate_details", new=mock.AsyncMock()):
            added = asyncio.run(
                recognize._append_artwork_candidates(db, candidates, b"photo", {})
            )
        self.assertEqual(added, 0)
        self.assertEqual(len(candidates), 1)


if __name__ == "__main__":
    unittest.main()
