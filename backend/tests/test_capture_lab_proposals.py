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


def _write_cv(root: Path, stem: str, *, entry=None, data=None):
    """Write one comparison crop and merge its row into ``index.json``.

    The comparison directory is a sibling of the scan-upload root, matching
    what the offline job writes on the host.
    """
    cv_dir = root.parent / "cv-compare"
    cv_dir.mkdir(parents=True, exist_ok=True)
    payload = data if data is not None else _card_jpeg((120, 160))
    image_path = cv_dir / f"{stem}.jpg"
    image_path.write_bytes(payload)
    index_path = cv_dir / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {}
    if not isinstance(index, dict):
        index = {}
    if entry is not None:
        index[stem] = entry
    index_path.write_text(json.dumps(index), encoding="utf-8")
    return image_path, payload


CV_ENTRY = {
    "ok": True,
    "score": 0.91,
    "top1": {"id": "sv1", "name": "Charizard", "score": 0.88},
    "top3": [
        {"id": "sv1", "name": "Charizard", "score": 0.88},
        {"id": "sv2", "name": "Charmeleon", "score": 0.07},
    ],
    "detection": "auto",
    "turnedCw": 90,
    "ms": 321,
}
CV_ENTRY_TRIMMED = {
    "score": 0.91,
    "top1": {"id": "sv1", "name": "Charizard", "score": 0.88},
    "detection": "auto",
    "turnedCw": 90,
}


@unittest.skipUnless(DEPS_AVAILABLE, "Proposal API dependencies are not installed")
class CaptureLabProposalTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base = Path(self.temp_dir.name)
        # The API treats the comparison directory as a sibling of the upload
        # root, so keep both inside the temporary directory.
        self.root = self.base / "scan-uploads"
        self.root.mkdir()
        self.cv_dir = self.base / "cv-compare"
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
            self.assertEqual(
                self.client.get(
                    f"/api/capture-lab/proposals/{STEM_A}/cv"
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
                cv_response = self.client.get(
                    f"/api/capture-lab/proposals/{bad}/cv"
                )
                self.assertEqual(cv_response.status_code, 400, bad)
                self.assertEqual(
                    cv_response.headers["cache-control"], "no-store"
                )

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

    def test_listing_includes_cv_url_and_trimmed_row_when_present(self):
        _write_proposal(self.root, 320, STEM_A)
        _write_proposal(self.root, 321, STEM_B)
        _write_cv(self.root, STEM_A, entry=CV_ENTRY)
        with self._enabled_env():
            body = self.client.get("/api/capture-lab/proposals").json()

        by_stem = {item["stem"]: item for item in body["items"]}
        compared = by_stem[STEM_A]
        self.assertEqual(
            compared["cvUrl"], f"/api/capture-lab/proposals/{STEM_A}/cv"
        )
        self.assertEqual(compared["cv"], CV_ENTRY_TRIMMED)
        self.assertEqual(
            set(compared["cv"]), {"score", "top1", "detection", "turnedCw"}
        )

        # A proposal without a comparison keeps the same item shape minus
        # ``cvUrl``, with ``cv`` explicitly null.
        plain = by_stem[STEM_B]
        self.assertNotIn("cvUrl", plain)
        self.assertIsNone(plain["cv"])

    def test_cv_serves_the_comparison_jpeg_or_409_when_missing(self):
        _write_proposal(self.root, 320, STEM_A)
        image_path, payload = _write_cv(self.root, STEM_A, entry=CV_ENTRY)
        with self._enabled_env():
            found = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/cv"
            )
            missing = self.client.get(
                f"/api/capture-lab/proposals/{STEM_B}/cv"
            )

        self.assertEqual(found.status_code, 200)
        self.assertEqual(found.headers["content-type"], "image/jpeg")
        self.assertEqual(found.headers["cache-control"], "no-store")
        self.assertEqual(found.content, payload)
        self.assertEqual(found.content, image_path.read_bytes())

        self.assertEqual(missing.status_code, 409)
        self.assertEqual(missing.headers["cache-control"], "no-store")
        self.assertEqual(missing.json(), {"detail": "no comparison"})

    def test_missing_comparison_directory_still_lists_normally(self):
        _write_proposal(self.root, 320, STEM_A)
        self.assertFalse(self.cv_dir.exists())
        with self._enabled_env():
            response = self.client.get("/api/capture-lab/proposals")
            missing = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/cv"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        body = response.json()
        self.assertEqual(body["total"], 1)
        self.assertNotIn("cvUrl", body["items"][0])
        self.assertIsNone(body["items"][0]["cv"])
        self.assertEqual(missing.status_code, 409)

    def _cv_proposal(self, *, turned_cw=180):
        image = Image.open(io.BytesIO(_card_jpeg((120, 168)))).convert("RGB")
        return capture_lab_proposals.cv_crop.ProposalCrop(
            image=image,
            width=120,
            height=168,
            identification=capture_lab_proposals.cv_crop.CvIdentification(
                id="sv1", name="Charizard", score=0.93
            ),
            turned_cw=turned_cw,
            detection="retry_border_replicate",
        )

    def test_collectorvision_crop_and_listing_when_selected(self):
        _write_proposal(self.root, 320, STEM_A)
        env = {"SCAN_CROP_SOURCE": "collectorvision"}
        identity = {
            "algorithmVersion": "cv1",
            "libraryCommit": "8b295ab80a997766afc00c640a616c1f2716df21",
            "detectorFile": "cornelius-2.12.onnx",
            "detectorSha256": "d" * 64,
            "embedderFile": "model.onnx",
            "embedderSha256": "e" * 64,
            "catalogKey": "milo1/tcgplayer/pokemon",
            "catalogVersion": 75,
            "cropAspect": [63, 88],
        }
        with self._enabled_env(), patch.dict(os.environ, env), patch.object(
            capture_lab_proposals.cv_crop,
            "propose_with_collectorvision",
            return_value=self._cv_proposal(),
        ), patch.object(
            capture_lab_proposals.cv_crop, "cv_identity", return_value=identity
        ):
            crop = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/crop"
            )
            listing = self.client.get("/api/capture-lab/proposals").json()

        self.assertEqual(crop.status_code, 200)
        with Image.open(io.BytesIO(crop.content)) as image:
            self.assertEqual(image.size, (120, 168))
            self.assertNotEqual(image.width, image.height)
        item = listing["items"][0]
        self.assertEqual(item["source"], "collectorvision")
        self.assertEqual(item["turnedCw"], 180)
        self.assertEqual(item["cvIdentity"], identity)
        self.assertEqual(
            item["configDigest"],
            capture_lab_proposals.cv_crop.cv_identity_digest(identity),
        )
        self.assertEqual(
            item["identification"],
            {
                "id": "sv1",
                "name": "Charizard",
                "score": 0.93,
                "detection": "retry_border_replicate",
                "turnedCw": 180,
            },
        )
        self.assertEqual((item["outputWidth"], item["outputHeight"]), (120, 168))

    def test_collectorvision_keeps_the_crop_when_identification_fails(self):
        _write_proposal(self.root, 320, STEM_A)
        identity = {
            "algorithmVersion": "cv1",
            "libraryCommit": "8b295ab80a997766afc00c640a616c1f2716df21",
            "detectorFile": "cornelius-2.12.onnx",
            "detectorSha256": "d" * 64,
            "embedderFile": "model.onnx",
            "embedderSha256": "e" * 64,
            "catalogKey": "milo1/tcgplayer/pokemon",
            "catalogVersion": 75,
            "cropAspect": [63, 88],
        }
        proposal = capture_lab_proposals.cv_crop.ProposalCrop(
            image=Image.open(io.BytesIO(_card_jpeg((120, 168)))).convert("RGB"),
            width=120,
            height=168,
            identification=None,
            turned_cw=0,
            detection="auto",
        )
        env = {"SCAN_CROP_SOURCE": "collectorvision"}
        with self._enabled_env(), patch.dict(os.environ, env), patch.object(
            capture_lab_proposals.cv_crop,
            "propose_with_collectorvision",
            return_value=proposal,
        ), patch.object(
            capture_lab_proposals.cv_crop, "cv_identity", return_value=identity
        ):
            crop = self.client.get(
                f"/api/capture-lab/proposals/{STEM_A}/crop"
            )
            listing = self.client.get("/api/capture-lab/proposals").json()

        self.assertEqual(crop.status_code, 200)
        item = listing["items"][0]
        self.assertEqual(item["source"], "collectorvision")
        self.assertIsNone(item["identification"])
        self.assertEqual(item["turnedCw"], 0)
        self.assertEqual(item["cvIdentity"], identity)
        self.assertEqual(
            item["configDigest"],
            capture_lab_proposals.cv_crop.cv_identity_digest(identity),
        )

    def test_listing_falls_back_to_phone_when_collectorvision_returns_none(self):
        _write_proposal(self.root, 320, STEM_A)
        env = {"SCAN_CROP_SOURCE": "collectorvision"}
        with self._enabled_env(), patch.dict(os.environ, env), patch.object(
            capture_lab_proposals.cv_crop,
            "propose_with_collectorvision",
            return_value=None,
        ):
            listing = self.client.get("/api/capture-lab/proposals").json()

        item = listing["items"][0]
        self.assertEqual(item["source"], "phone")
        self.assertIsNone(item["identification"])
        self.assertIsNone(item["cvIdentity"])
        self.assertIsNone(item["configDigest"])
        self.assertEqual(item["turnedCw"], 0)
        self.assertGreater(item["outputWidth"], 0)
        self.assertGreater(item["outputHeight"], 0)

    def test_cv_index_is_cached_by_mtime_and_reread_after_a_change(self):
        _write_proposal(self.root, 320, STEM_A)
        _write_cv(self.root, STEM_A, entry=CV_ENTRY)
        index_path = self.cv_dir / "index.json"
        real_read = capture_lab_proposals._read_cv_index
        with self._enabled_env(), patch.object(
            capture_lab_proposals, "_read_cv_index", wraps=real_read
        ) as reader:
            first = self.client.get("/api/capture-lab/proposals").json()
            second = self.client.get("/api/capture-lab/proposals").json()
            self.assertEqual(reader.call_count, 1)
            self.assertEqual(
                first["items"][0]["cv"], second["items"][0]["cv"]
            )

            updated = dict(CV_ENTRY, score=0.42)
            index_path.write_text(
                json.dumps({STEM_A: updated}), encoding="utf-8"
            )
            stat = index_path.stat()
            os.utime(
                index_path,
                ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000),
            )
            third = self.client.get("/api/capture-lab/proposals").json()

        self.assertGreaterEqual(reader.call_count, 2)
        self.assertEqual(third["items"][0]["cv"]["score"], 0.42)


if __name__ == "__main__":
    unittest.main()
