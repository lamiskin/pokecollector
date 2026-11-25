"""Tests for the CollectorVision proposal source and its fallback contract."""

import os
import types
import unittest
from unittest.mock import patch

try:
    import numpy as np
    from PIL import Image

    from services import cv_crop

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


RED = (255, 0, 0)
BLUE = (0, 0, 255)


def _square(top, bottom, size=(448, 448)):
    image = Image.new("RGB", size, bottom)
    image.paste(top, (0, 0, size[0], size[1] // 2))
    return image


class _Detection:
    def __init__(self, crop, *, present=True):
        self.crop = crop
        self.card_present = present
        self.corners = None if not present else np.zeros((4, 2), dtype=np.float32)
        self.dewarped_with = None

    def dewarp(self, frame):
        self.dewarped_with = frame
        return self.crop


class _Detector:
    """Returns queued detections and records every frame it was given."""

    def __init__(self, results):
        self.results = list(results)
        self.seen = []

    def detect(self, frame):
        self.seen.append(frame)
        index = min(len(self.seen) - 1, len(self.results) - 1)
        return self.results[index]


class _Embedder:
    """Scores the crop by its top colour: red=1, blue=2."""

    def __init__(self):
        self.calls = 0

    def embed(self, image):
        self.calls += 1
        red, _green, blue = image.getpixel((1, 1))
        return np.asarray([1.0 if red > blue else 2.0], dtype=np.float32)


class _Catalog:
    def search_records(self, embedding, top_k=1):
        score = float(embedding[0])
        return [
            {
                "id": f"id-{score:.0f}",
                "name": f"Card {score:.0f}",
                "score": score,
            }
        ]


def _engine(results=None, *, top=BLUE, bottom=RED, embedder=None, catalog=None):
    """Build a fake engine plus the exact detection queue it will return."""
    if results is None:
        results = [_Detection(_square(top, bottom))]
    detector = _Detector(results)
    detection = next(
        (result for result in results if result.card_present), results[-1]
    )
    return cv_crop._Engine(
        detector=detector,
        embedder=embedder or _Embedder(),
        catalog=catalog or _Catalog(),
        rotate_180=lambda image: image.transpose(Image.Transpose.ROTATE_180),
        catalog_key="milo1/tcgplayer/pokemon",
        catalog_version=75,
    ), detector, detection


@unittest.skipUnless(DEPS_AVAILABLE, "Proposal dependencies are not installed")
class CvCropTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {})
        self.env.start()
        cv_crop.reset_state()

    def tearDown(self):
        cv_crop.reset_state()
        self.env.stop()

    def _propose(self, engine):
        with patch.object(cv_crop, "_load_engine", return_value=engine), patch.object(
            cv_crop, "_to_bgr", side_effect=lambda image: image
        ), patch.object(
            cv_crop, "_pad_border", side_effect=lambda frame: ("padded", frame)
        ):
            return cv_crop.propose_with_collectorvision(
                Image.new("RGB", (300, 400), (10, 10, 10))
            )

    def test_default_crop_source_is_phone(self):
        self.assertEqual(cv_crop.crop_source(), "phone")

    def test_known_crop_source_is_read_from_the_environment(self):
        with patch.dict(os.environ, {"SCAN_CROP_SOURCE": "collectorvision"}):
            self.assertEqual(cv_crop.crop_source(), "collectorvision")

    def test_unknown_crop_source_warns_once_and_stays_phone(self):
        with patch.dict(os.environ, {"SCAN_CROP_SOURCE": "magic"}), self.assertLogs(
            "services.cv_crop", level="WARNING"
        ) as logs:
            self.assertEqual(cv_crop.crop_source(), "phone")
            self.assertEqual(cv_crop.crop_source(), "phone")
        self.assertEqual(len(logs.output), 1)

    def test_crop_is_restored_to_the_card_frame_not_the_square(self):
        engine, _detector, _detection = _engine()
        proposal = self._propose(engine)

        self.assertIsNotNone(proposal)
        self.assertEqual(proposal.image.mode, "RGB")
        self.assertEqual((proposal.width, proposal.height), (448, 626))
        self.assertEqual((proposal.width, proposal.height), proposal.image.size)
        self.assertNotEqual(proposal.width, proposal.height)
        self.assertAlmostEqual(
            proposal.width / proposal.height, 63 / 88, places=3
        )

    def test_upright_choice_keeps_the_pixels_unmoved(self):
        # Blue on top scores 2 upright; the half turn would score 1.
        engine, _detector, _detection = _engine(top=BLUE, bottom=RED)
        proposal = self._propose(engine)

        self.assertEqual(proposal.turned_cw, 0)
        red, _green, blue = proposal.image.getpixel((proposal.width // 2, 4))
        self.assertGreater(blue, red)

    def test_half_turn_choice_is_applied_to_the_returned_pixels(self):
        # Red on top scores 1 upright; the half turn puts blue on top and wins.
        engine, _detector, _detection = _engine(top=RED, bottom=BLUE)
        proposal = self._propose(engine)

        self.assertEqual(proposal.turned_cw, 180)
        red, _green, blue = proposal.image.getpixel((proposal.width // 2, 4))
        self.assertGreater(blue, red)
        self.assertEqual(proposal.identification.id, "id-2")
        self.assertEqual(proposal.identification.name, "Card 2")
        self.assertEqual(proposal.identification.score, 2.0)

    def test_first_detection_failure_retries_on_a_replicated_border(self):
        engine, detector, detection = _engine(
            [
                _Detection(None, present=False),
                _Detection(_square(BLUE, RED)),
            ]
        )
        with patch.object(cv_crop, "_load_engine", return_value=engine), patch.object(
            cv_crop, "_to_bgr", side_effect=lambda image: image
        ), patch.object(
            cv_crop, "_pad_border", side_effect=lambda frame: ("padded", frame)
        ) as padder:
            proposal = cv_crop.propose_with_collectorvision(
                Image.new("RGB", (300, 400), (10, 10, 10))
            )

        self.assertIsNotNone(proposal)
        self.assertEqual(proposal.detection, cv_crop.DETECTION_RETRY)
        padder.assert_called_once()
        self.assertEqual(len(detector.seen), 2)
        self.assertEqual(detector.seen[1][0], "padded")
        self.assertEqual(detection.dewarped_with[0], "padded")

    def test_no_card_in_either_attempt_returns_none(self):
        engine, _detector, _detection = _engine(
            [_Detection(None, present=False)]
        )
        self.assertIsNone(self._propose(engine))

    def test_engine_failure_in_identification_still_returns_the_crop(self):
        engine, _detector, _detection = _engine(
            embedder=types.SimpleNamespace(embed=lambda image: 1 / 0)
        )
        with self.assertLogs("services.cv_crop", level="WARNING") as logs:
            proposal = self._propose(engine)
        self.assertIsNotNone(proposal)
        self.assertIsNone(proposal.identification)
        self.assertEqual(proposal.turned_cw, 0)
        self.assertIn("identification failed", "\n".join(logs.output))

    def test_catalogue_failure_still_returns_the_crop(self):
        class BrokenCatalog:
            def search_records(self, embedding, top_k=1):
                raise RuntimeError("catalogue offline")

        engine, _detector, _detection = _engine(catalog=BrokenCatalog())
        with self.assertLogs("services.cv_crop", level="WARNING") as logs:
            proposal = self._propose(engine)

        self.assertIsNotNone(proposal)
        self.assertIsNone(proposal.identification)
        self.assertEqual(proposal.turned_cw, 0)
        self.assertEqual(proposal.detection, cv_crop.DETECTION_AUTO)
        self.assertEqual((proposal.width, proposal.height), (448, 626))
        self.assertIn("identification failed", "\n".join(logs.output))

    def test_orientation_failure_returns_the_crop_unturned(self):
        engine, _detector, _detection = _engine(top=RED, bottom=BLUE)

        def broken_rotate(image):
            raise RuntimeError("rotation broke")

        engine.rotate_180 = broken_rotate
        with self.assertLogs("services.cv_crop", level="WARNING") as logs:
            proposal = self._propose(engine)

        self.assertIsNotNone(proposal)
        self.assertIsNone(proposal.identification)
        self.assertEqual(proposal.turned_cw, 0)
        self.assertEqual(proposal.detection, cv_crop.DETECTION_AUTO)
        # The pixels are the upright crop: red stayed on top.
        red, _green, blue = proposal.image.getpixel((proposal.width // 2, 4))
        self.assertGreater(red, blue)
        self.assertIn("identification failed", "\n".join(logs.output))

    def test_identification_is_present_when_the_catalogue_answers(self):
        engine, _detector, _detection = _engine()
        proposal = self._propose(engine)
        self.assertIsNotNone(proposal.identification)
        self.assertEqual(proposal.identification.id, "id-2")

    def test_cv_identity_records_the_artefacts_and_crop_aspect(self):
        engine, _detector, _detection = _engine()
        identity = cv_crop.cv_identity(engine)

        self.assertEqual(set(identity), set(cv_crop.IDENTITY_KEYS))
        self.assertEqual(identity["algorithmVersion"], cv_crop.CV_ALGORITHM_VERSION)
        self.assertEqual(identity["catalogKey"], "milo1/tcgplayer/pokemon")
        self.assertEqual(identity["catalogVersion"], 75)
        self.assertEqual(
            identity["cropAspect"],
            [cv_crop.CARD_ASPECT_WIDTH, cv_crop.CARD_ASPECT_HEIGHT],
        )
        self.assertEqual(len(cv_crop.cv_identity_digest(identity)), 64)

    def test_changing_any_identity_field_changes_the_digest(self):
        baseline = {
            "algorithmVersion": "cv1",
            "libraryCommit": "a" * 40,
            "detectorFile": "cornelius-2.12.onnx",
            "detectorSha256": "b" * 64,
            "embedderFile": "model.onnx",
            "embedderSha256": "c" * 64,
            "catalogKey": "milo1/tcgplayer/pokemon",
            "catalogVersion": 75,
            "cropAspect": [63, 88],
        }
        digest = cv_crop.cv_identity_digest(baseline)
        self.assertEqual(set(baseline), set(cv_crop.IDENTITY_KEYS))

        for key in baseline:
            mutated = dict(baseline)
            if key == "catalogVersion":
                mutated[key] = baseline[key] + 1
            elif key == "cropAspect":
                mutated[key] = [1, 1]
            else:
                mutated[key] = f"changed-{baseline[key]}"
            self.assertNotEqual(
                cv_crop.cv_identity_digest(mutated),
                digest,
                f"changing {key} left the digest unchanged",
            )
        with patch.object(
            cv_crop, "_import_library", side_effect=ImportError("no collector_vision")
        ), self.assertLogs("services.cv_crop", level="WARNING") as logs:
            self.assertIsNone(cv_crop.propose_with_collectorvision(Image.new("RGB", (8, 8))))
            self.assertIsNone(cv_crop.propose_with_collectorvision(Image.new("RGB", (8, 8))))
        unavailable = [line for line in logs.output if "unavailable" in line]
        self.assertEqual(len(unavailable), 1)

    def test_engine_is_initialised_once_and_its_cost_is_logged(self):
        catalog = types.SimpleNamespace(
            catalog_key="milo1/tcgplayer/pokemon",
            version=75,
            card_ids=["a", "b"],
        )
        fake_module = types.SimpleNamespace(
            Catalog=types.SimpleNamespace(load=lambda *args, **kwargs: catalog),
            NeuralCornerDetector=lambda **kwargs: object(),
            rotate_card_180=lambda image: image,
        )
        with patch.object(
            cv_crop, "_import_library", side_effect=lambda: fake_module
        ) as importer, patch.object(
            cv_crop, "_resolve_embedder", return_value=(object(), None)
        ), self.assertLogs(
            "services.cv_crop", level="INFO"
        ) as logs:
            first = cv_crop._load_engine()
            second = cv_crop._load_engine()

        self.assertIs(first, second)
        self.assertEqual(importer.call_count, 1)
        self.assertIn("initialised in", "\n".join(logs.output))

    def test_reset_state_allows_a_fresh_initialisation(self):
        with patch.object(
            cv_crop, "_import_library", side_effect=ImportError("missing")
        ):
            cv_crop.propose_with_collectorvision(Image.new("RGB", (8, 8)))
        self.assertIsNotNone(cv_crop._unavailable_reason)
        cv_crop.reset_state()
        self.assertIsNone(cv_crop._unavailable_reason)
        self.assertIsNone(cv_crop._engine)


if __name__ == "__main__":
    unittest.main()
