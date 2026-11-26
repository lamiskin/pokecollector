"""Tests for the capture-lab CollectorVision detection-only endpoint."""

import io
import os
import types
import unittest
from unittest.mock import patch

try:
    import numpy as np
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from PIL import Image

    from api import capture_lab_proposals
    from api.auth import get_current_user
    from api.capture_lab_proposals import router
    from services import cv_crop

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


MAX_BYTES = 8 * 1024 * 1024


class _Result:
    """A minimal stand-in for ``collector_vision``'s DetectionResult."""

    def __init__(
        self,
        corners=None,
        *,
        present=True,
        confidence=0.9,
        sharpness=0.05,
    ):
        self.card_present = present
        self.corners = (
            None if corners is None else np.asarray(corners, dtype=np.float32)
        )
        self.confidence = confidence
        self.sharpness = sharpness


class _Detector:
    """Queues detections and records every frame it is asked to inspect."""

    def __init__(self, results):
        self.results = list(results)
        self.seen = []

    def detect(self, frame):
        self.seen.append(frame)
        index = min(len(self.seen) - 1, len(self.results) - 1)
        return self.results[index]


def _image_bytes(size=(400, 300), fmt="JPEG"):
    image = Image.new("RGB", size, (240, 240, 236))
    output = io.BytesIO()
    image.save(output, format=fmt)
    return output.getvalue()


def _quad(left, top, right, bottom):
    return [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
    ]


@unittest.skipUnless(DEPS_AVAILABLE, "Capture-lab API dependencies are not installed")
class CaptureLabCvDetectTests(unittest.TestCase):
    def setUp(self):
        self.user = types.SimpleNamespace(id=11, username="collector")
        app = FastAPI()
        app.include_router(router, prefix="/api/capture-lab")
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)
        cv_crop.reset_state()

    def tearDown(self):
        self.client.close()
        cv_crop.reset_state()

    def _enabled(self):
        return patch.dict(os.environ, {"CAPTURE_LAB_ENABLED": "true"})

    def _post(self, data, content_type="image/jpeg"):
        return self.client.post(
            "/api/capture-lab/cv-detect",
            files={"image": ("frame.jpg", data, content_type)},
        )

    def _post_with_detector(self, detector, data=None, **kwargs):
        """Call the endpoint with the real ``detect_card`` and a fake detector."""
        with self._enabled(), patch.object(
            cv_crop, "load_detector", return_value=(detector, None)
        ), patch.object(
            cv_crop, "_to_bgr", side_effect=lambda image: image
        ), patch.object(
            cv_crop, "_pad_border", side_effect=lambda frame: ("padded", frame)
        ):
            return self._post(data or _image_bytes(), **kwargs)

    def test_route_is_404_when_the_lab_flag_is_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CAPTURE_LAB_ENABLED", None)
            response = self._post(_image_bytes())
        self.assertEqual(response.status_code, 404)

    def test_oversize_upload_is_413(self):
        with self._enabled():
            response = self._post(b"0" * (MAX_BYTES + 1))
        self.assertEqual(response.status_code, 413)

    def test_more_than_20_megapixels_is_422(self):
        # 5000 x 4500 = 22.5 MP. A 1-bit image keeps the fixture small; the
        # endpoint rejects it from the header, before decoding pixels.
        oversized = Image.new("1", (5000, 4500))
        output = io.BytesIO()
        oversized.save(output, format="PNG")
        with self._enabled():
            response = self._post(output.getvalue(), content_type="image/png")
        self.assertEqual(response.status_code, 422)

    def test_mocked_detector_returns_normalised_corners_and_timings(self):
        corners = _quad(0.1, 0.15, 0.9, 0.85)
        detector = _Detector([_Result(corners, confidence=0.9, sharpness=0.05)])
        response = self._post_with_detector(detector)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        body = response.json()
        self.assertTrue(body["detected"])
        self.assertEqual(body["detection"], "auto")
        self.assertFalse(body["resized"])
        self.assertAlmostEqual(body["confidence"], 0.9, places=6)
        self.assertAlmostEqual(body["sharpness"], 0.05, places=6)
        self.assertEqual(len(body["corners"]), 4)
        for actual, wanted in zip(body["corners"], corners):
            self.assertAlmostEqual(actual[0], wanted[0], places=6)
            self.assertAlmostEqual(actual[1], wanted[1], places=6)
        self.assertGreaterEqual(body["ms"]["detect"], 0.0)
        self.assertGreaterEqual(body["ms"]["total"], body["ms"]["detect"])
        self.assertEqual(len(detector.seen), 1)

    def test_downscaled_input_reports_resized_and_keeps_original_coordinates(self):
        corners = _quad(0.25, 0.25, 0.75, 0.75)
        detector = _Detector([_Result(corners)])
        response = self._post_with_detector(
            detector, data=_image_bytes((3200, 2400))
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["detected"])
        self.assertTrue(body["resized"])
        # The detector saw the 1600px long edge, not the supplied 3200px.
        self.assertEqual(detector.seen[0].size, (1600, 1200))
        # Normalised corners are already in the supplied image's space.
        for actual, wanted in zip(body["corners"], corners):
            self.assertAlmostEqual(actual[0], wanted[0], places=6)
            self.assertAlmostEqual(actual[1], wanted[1], places=6)

    def test_retry_path_is_reported_and_maps_padded_corners_back(self):
        # 400x300 frame padded by 12% of the long edge (48 px each side):
        # 496x396. A card at [100, 75, 300, 225] in the original is at
        # [148, 123, 348, 273] in the padded frame.
        padded = _quad(148 / 496, 123 / 396, 348 / 496, 273 / 396)
        detector = _Detector(
            [_Result(present=False), _Result(padded)]
        )
        response = self._post_with_detector(detector)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["detected"])
        self.assertEqual(body["detection"], "retry_border_replicate")
        self.assertEqual(len(detector.seen), 2)
        expected = _quad(0.25, 0.25, 0.75, 0.75)
        for actual, wanted in zip(body["corners"], expected):
            self.assertAlmostEqual(actual[0], wanted[0], places=5)
            self.assertAlmostEqual(actual[1], wanted[1], places=5)

    def test_no_card_in_either_attempt_is_a_200_with_detected_false(self):
        detector = _Detector([_Result(present=False)])
        response = self._post_with_detector(detector)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["detected"])
        self.assertIsNone(body["corners"])
        self.assertEqual(body["detection"], "none")

    def test_unavailable_engine_is_503_with_the_reason(self):
        with self._enabled(), patch.object(
            cv_crop,
            "load_detector",
            return_value=(None, "ImportError: no collector_vision"),
        ):
            response = self._post(_image_bytes())

        self.assertEqual(response.status_code, 503)
        self.assertIn("no collector_vision", response.json()["detail"])

    def test_detection_does_not_need_the_catalogue(self):
        # Detection needs only the library's corner detector. A module without
        # ``Catalog`` or an embedder must still serve the endpoint.
        detector = _Detector([_Result(_quad(0.1, 0.1, 0.9, 0.9))])
        fake_library = types.SimpleNamespace(
            NeuralCornerDetector=lambda **kwargs: detector
        )
        with self._enabled(), patch.object(
            cv_crop, "_import_library", return_value=fake_library
        ), patch.object(
            cv_crop, "_to_bgr", side_effect=lambda image: image
        ):
            response = self._post(_image_bytes())

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["detected"])

    def test_unsupported_image_format_is_422(self):
        image = Image.new("RGB", (64, 64), (1, 2, 3))
        output = io.BytesIO()
        image.save(output, format="GIF")
        with self._enabled():
            response = self._post(output.getvalue(), content_type="image/gif")
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
