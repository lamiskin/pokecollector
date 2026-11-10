"""Artwork index behaviour: absent index is inert; a present index ranks by cosine."""

import io
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from services import artwork_index


class _FakeSession:
    def __init__(self, vector):
        self._vector = vector

    def run(self, _outputs, _feed):
        return [np.array([self._vector], dtype="float32")]


def _fake_state(vectors, ids):
    embeddings = np.array(vectors, dtype="float32")
    embeddings = embeddings / np.linalg.norm(embeddings, axis=1, keepdims=True)
    return {
        "embeddings": embeddings,
        "ids": list(ids),
        "session": _FakeSession([1.0, 0.0, 0.0, 0.0]),
        "np": np,
        "dir": "fake",
    }


class ArtworkIndexTests(unittest.TestCase):
    def setUp(self):
        artwork_index.reset_cache()

    def tearDown(self):
        artwork_index.reset_cache()

    def test_missing_index_is_unavailable_and_inert(self):
        missing = Path("/nonexistent/artwork-index")
        self.assertFalse(artwork_index.is_available(missing))
        self.assertEqual(artwork_index.search(b"anything", index_dir=missing), [])

    def test_search_returns_nearest_first(self):
        state = _fake_state(
            [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.7, 0.7, 0.0, 0.0]],
            ["exact", "orthogonal", "diagonal"],
        )
        with mock.patch.object(artwork_index, "_get_state", return_value=state), \
             mock.patch.object(artwork_index, "_prepare_pixels", return_value=np.zeros((1, 3, 224, 224))):
            results = artwork_index.search(b"image", limit=3)
        self.assertEqual([card for card, _ in results], ["exact", "diagonal", "orthogonal"])
        self.assertAlmostEqual(results[0][1], 1.0, places=5)

    def test_limit_is_respected(self):
        state = _fake_state(
            [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0]], ["a", "b"]
        )
        with mock.patch.object(artwork_index, "_get_state", return_value=state), \
             mock.patch.object(artwork_index, "_prepare_pixels", return_value=np.zeros((1, 3, 224, 224))):
            results = artwork_index.search(b"image", limit=1)
        self.assertEqual(len(results), 1)

    def test_undecodable_image_yields_no_candidates(self):
        state = _fake_state([[1.0, 0.0, 0.0, 0.0]], ["a"])
        with mock.patch.object(artwork_index, "_get_state", return_value=state):
            self.assertEqual(artwork_index.search(b"not an image", limit=3), [])

    def test_prepare_pixels_shape_and_normalisation(self):
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (32, 48), (255, 255, 255)).save(buffer, format="PNG")
        pixels = artwork_index._prepare_pixels(buffer.getvalue(), np)
        self.assertEqual(pixels.shape, (1, 3, 224, 224))
        expected = (1.0 - 0.485) / 0.229
        self.assertAlmostEqual(float(pixels[0, 0, 0, 0]), expected, places=4)


if __name__ == "__main__":
    unittest.main()
