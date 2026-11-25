"""Tests for the read-only capture-lab straightening proposal API."""

import io
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    import numpy as np
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from PIL import Image, ImageDraw

    from api import capture_lab_proposals
    from api.auth import get_current_user
    from api.capture_lab_proposals import router
    from services.scan_straighten import (
        Straightened,
        transform_quad_for_storage,
        try_straighten,
    )

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

STEM_A = "a" * 32
STEM_B = "b" * 32
STEM_C = "c" * 32
SOURCE_SIZE = (240, 300)
# A full-frame portrait card claim, inset from the padded raster's edge.
QUAD_PIXELS = [(10.0, 10.0), (230.0, 10.0), (230.0, 290.0), (10.0, 290.0)]


def _card_jpeg(size=SOURCE_SIZE):
    image = Image.new("RGB", size, (246, 246, 242))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, size[0] - 1, size[1] - 1), outline=(4, 4, 4), width=7)
    for top in (70, 132, 194):
        draw.rectangle((18, top, size[0] - 18, top + 26), fill=(150, 152, 158))
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=92)
    return output.getvalue()


def _normalised_quad(pixels=QUAD_PIXELS, size=SOURCE_SIZE):
    width, height = size
    return [[round(x / width, 6), round(y / height, 6)] for x, y in pixels]


def _write_proposal(
    root: Path,
    job_id: int,
    stem: str,
    *,
    quad=None,
    rotation_cw: int = 0,
    data=None,
    size=SOURCE_SIZE,
):
    job_dir = root / str(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    image_path = job_dir / f"{stem}.jpg"
    image_path.write_bytes(data if data is not None else _card_jpeg(size))
    geometry = {
        "v": 1,
        "space": "crop-normalized",
        "width": size[0],
        "height": size[1],
        "quad": quad if quad is not None else _normalised_quad(size=size),
        "source": "same-frame-model",
        "storedWidth": size[0],
        "storedHeight": size[1],
        "storedRotationCw": rotation_cw,
    }
    (job_dir / f"{stem}.geometry.json").write_text(
        json.dumps(geometry), encoding="utf-8"
    )
    return image_path, geometry


@unittest.skipUnless(DEPS_AVAILABLE, "Proposal API dependencies are not installed")
class CaptureLabProposalTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.user = types.SimpleNamespace(id=11, username="collector")

        app = FastAPI()
        app.include_router(router, prefix="/api/capture-lab")
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)
        capture_lab_proposals._clear_cache()

    def tearDown(self):
        self.client.close()
        capture_lab_proposals._clear_cache()
        self.temp_dir.cleanup()

    def _enabled_env(self):
        return patch.dict(
            os.environ,
            {
                "CAPTURE_LAB_ENABLED": "true",
                "SCAN_UPLOAD_DIR": str(self.root),
            },
        )

    def test_routes_are_404_when_the_lab_flag_is_unset(self):
        _write_proposal(self.root, 320, STEM_A)
        with patch.dict(os.environ, {"SCAN_UPLOAD_DIR": str(self.root)}, clear=False):
            os.environ.pop("CAPTURE_LAB_ENABLED", None)
            self.assertEqual(
                self.client.get("/api/capture-lab/proposals").status_code, 404
            )
            self.assertEqual(
                self.client.get(
                    f"/api/capture-lab/proposals/{STEM_A}/crop"
                ).status_code,
                404,
            )

    def test_bad_stem_is_rejected(self):
        with self._enabled_env():
            for bad in ("not-a-stem", "a" * 31, "g" * 32, "a" * 33):
                response = self.client.get(
                    f"/api/capture-lab/proposals/{bad}/original"
                )
                self.assertEqual(response.status_code, 400, bad)
                self.assertEqual(response.headers["cache-control"], "no-store")

    def test_listing_finds_geometry_sidecars_newest_job_first(self):
        _write_proposal(self.root, 320, STEM_A)
        _write_proposal(self.root, 321, STEM_B)
        with self._enabled_env():
            response = self.client.get("/api/capture-lab/proposals")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["cache-control"], "no-store")
            body = response.json()
            self.assertEqual(body["total"], 2)
            self.assertEqual(
                [(item["jobId"], item["stem"]) for item in body["items"]],
                [(321, STEM_B), (320, STEM_A)],
            )
            item = body["items"][0]
            self.assertEqual(item["label"], "Unverified crop")
            self.assertEqual((item["width"], item["height"]), SOURCE_SIZE)
            self.assertGreater(item["outputWidth"], 0)
            self.assertGreater(item["outputHeight"], 0)
            self.assertEqual(
                item["originalUrl"],
                f"/api/capture-lab/proposals/{STEM_B}/original",
            )
            self.assertEqual(
                item["cropUrl"], f"/api/capture-lab/proposals/{STEM_B}/crop"
            )
            self.assertEqual(
                item["rotatedUrl"],
                f"/api/capture-lab/proposals/{STEM_B}/turned",
            )
            self.assertEqual(len(item["quad"]), 4)
            for u, v in item["quad"]:
                self.assertTrue(0.0 <= u <= 1.0 and 0.0 <= v <= 1.0)

    def test_original_serves_the_stored_jpeg_and_the_quad_is_stored_space(self):
        image_path, _ = _write_proposal(
            self.root, 320, STEM_A, rotation_cw=90
        )
        with self._enabled_env():
            original = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/original"
            )
            self.assertEqual(original.status_code, 200)
            self.assertEqual(original.headers["content-type"], "image/jpeg")
            self.assertEqual(original.headers["cache-control"], "no-store")
            self.assertEqual(original.content, image_path.read_bytes())
            with Image.open(io.BytesIO(original.content)) as stored:
                self.assertEqual(stored.size, SOURCE_SIZE)

            item = self.client.get("/api/capture-lab/proposals").json()["items"][0]
            expected = transform_quad_for_storage(
                _normalised_quad(), 90, 1.0, 1.0
            )
            for actual, wanted in zip(item["quad"], expected):
                self.assertAlmostEqual(actual[0], wanted[0], places=4)
                self.assertAlmostEqual(actual[1], wanted[1], places=4)

    def test_crop_matches_try_straighten_on_the_same_source(self):
        image_path, _ = _write_proposal(self.root, 320, STEM_A)
        with self._enabled_env():
            response = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/crop"
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "image/jpeg")
            self.assertEqual(response.headers["cache-control"], "no-store")

        with Image.open(image_path) as stored:
            stored.load()
            rgb = stored.convert("RGB")
        quad = transform_quad_for_storage(
            _normalised_quad(), 0, rgb.width, rgb.height
        )
        expected = try_straighten(rgb, quad)
        self.assertIsInstance(expected, Straightened)
        with Image.open(io.BytesIO(response.content)) as crop:
            self.assertEqual(crop.size, (expected.width, expected.height))

    def test_turned_is_the_crop_rotated_180_degrees(self):
        _write_proposal(self.root, 320, STEM_A)
        with self._enabled_env():
            crop = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/crop"
            )
            turned = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/turned"
            )
        self.assertEqual(turned.status_code, 200)
        self.assertEqual(turned.headers["cache-control"], "no-store")
        with Image.open(io.BytesIO(crop.content)) as crop_image:
            crop_array = np.asarray(crop_image.convert("RGB"), dtype=np.float64)
        with Image.open(io.BytesIO(turned.content)) as turned_image:
            turned_array = np.asarray(
                turned_image.convert("RGB"), dtype=np.float64
            )
        expected = crop_array[::-1, ::-1, :]
        self.assertEqual(turned_array.shape, expected.shape)
        self.assertLess(
            float(np.abs(turned_array - expected).mean()), 8.0
        )

    def test_invalid_geometry_returns_409_without_a_placeholder(self):
        _write_proposal(
            self.root,
            320,
            STEM_C,
            quad=[[0.2, 0.2], [0.2, 0.2], [0.8, 0.8], [0.8, 0.8]],
        )
        with self._enabled_env():
            response = self.client.get(
                f"/api/capture-lab/proposals/{STEM_C}/crop"
            )
            listing = self.client.get("/api/capture-lab/proposals").json()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertIn("detail", response.json())
        self.assertEqual(listing, {"total": 0, "items": []})

    def test_cache_reuses_bytes_and_a_new_config_digest_invalidates(self):
        _write_proposal(self.root, 320, STEM_A)
        digest = {"value": "digest-a"}
        real_build = capture_lab_proposals._build_proposal
        with self._enabled_env(), patch.object(
            capture_lab_proposals,
            "straighten_config_digest",
            side_effect=lambda: digest["value"],
        ), patch.object(
            capture_lab_proposals, "_build_proposal", wraps=real_build
        ) as builder:
            first = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/crop"
            )
            second = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/crop"
            )
            self.assertEqual(first.content, second.content)
            self.assertEqual(builder.call_count, 1)

            digest["value"] = "digest-b"
            third = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/crop"
            )
            self.assertEqual(third.status_code, 200)
            self.assertEqual(builder.call_count, 2)


if __name__ == "__main__":
    unittest.main()
