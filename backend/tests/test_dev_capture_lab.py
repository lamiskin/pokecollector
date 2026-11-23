import hashlib
import io
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from PIL import Image

    from api.auth import get_current_user
    from api.dev_capture_lab import MAX_CAPTURE_BYTES, router

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _png_bytes(size=(3, 2)):
    image = Image.new("RGB", size, "#d92828")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _asymmetric_png_bytes():
    image = Image.new("RGB", (16, 16), "#d92828")
    for y in range(8):
        for x in range(8):
            image.putpixel((x, y), (255, 255, 255))
    for y in range(8, 16):
        for x in range(8, 16):
            image.putpixel((x, y), (0, 0, 0))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


@unittest.skipUnless(DEPS_AVAILABLE, "Capture lab dependencies are not installed")
class DevCaptureLabTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.user = types.SimpleNamespace(id=7, username="capture-lab-owner")

        app = FastAPI()
        app.include_router(router, prefix="/api/dev/capture-lab")
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temp_dir.cleanup()

    def _enabled_env(self):
        return patch.dict(
            os.environ,
            {
                "CAPTURE_LAB_ENABLED": "true",
                "CAPTURE_LAB_DIR": self.temp_dir.name,
            },
        )

    def test_routes_are_404_when_the_flag_is_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CAPTURE_LAB_ENABLED", None)
            self.assertEqual(self.client.get("/api/dev/capture-lab/captures").status_code, 404)
            response = self.client.post(
                "/api/dev/capture-lab/capture",
                files={"file": ("shot.png", _png_bytes(), "image/png")},
            )
            self.assertEqual(response.status_code, 404)

    def test_upload_round_trip_preserves_bytes_and_metadata(self):
        data = _png_bytes(size=(3, 2))
        with self._enabled_env():
            response = self.client.post(
                "/api/dev/capture-lab/capture",
                files={"file": ("phone-shot.png", data, "image/png")},
                data={
                    "condition": "Top loader",
                    "card_label": "Charizard Base",
                    "route": "Phone browser",
                    "track_settings": '{"width":1920}',
                    "note": "direct afternoon sun",
                },
            )
            self.assertEqual(response.status_code, 200)
            created = response.json()
            self.assertEqual(created["bytes"], len(data))
            self.assertEqual(created["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual((created["width"], created["height"]), (3, 2))
            self.assertEqual(created["card_label"], "Charizard Base")
            self.assertEqual(
                created["url"],
                f"/api/dev/capture-lab/captures/{created['name']}",
            )
            self.assertIn("charizard-base", created["name"])

            stored = os.path.join(self.temp_dir.name, created["name"])
            with open(stored, "rb") as handle:
                self.assertEqual(handle.read(), data)
            with open(stored + ".json", encoding="utf-8") as handle:
                sidecar = json.load(handle)
            self.assertEqual(sidecar["original_filename"], "phone-shot.png")
            self.assertEqual(sidecar["content_type"], "image/png")
            self.assertEqual(sidecar["user_id"], self.user.id)
            self.assertEqual(sidecar["track_settings"], '{"width":1920}')

            listing = self.client.get("/api/dev/capture-lab/captures")
            self.assertEqual(listing.status_code, 200)
            body = listing.json()
            self.assertEqual(body["directory"], str(Path(self.temp_dir.name).resolve()))
            self.assertEqual(len(body["captures"]), 1)
            self.assertTrue(body["captures"][0]["thumbnail"].startswith("data:image/jpeg;base64,"))

            media = self.client.get(f"/api/dev/capture-lab/captures/{created['name']}")
            self.assertEqual(media.status_code, 200)
            self.assertEqual(media.content, data)
            self.assertEqual(media.headers["content-type"], "image/png")

            deleted = self.client.delete(f"/api/dev/capture-lab/captures/{created['name']}")
            self.assertEqual(deleted.status_code, 200)
            self.assertFalse(os.path.exists(stored))
            self.assertEqual(
                self.client.get(f"/api/dev/capture-lab/captures/{created['name']}").status_code,
                404,
            )

    def test_rotate_capture_rewrites_image_and_sidecar(self):
        data = _asymmetric_png_bytes()
        with self._enabled_env():
            created = self.client.post(
                "/api/dev/capture-lab/capture",
                files={"file": ("turned.png", data, "image/png")},
            ).json()
            stored = os.path.join(self.temp_dir.name, created["name"])

            response = self.client.post(
                f"/api/dev/capture-lab/captures/{created['name']}/rotate"
            )
            self.assertEqual(response.status_code, 200)
            sidecar = response.json()
            self.assertTrue(sidecar["rotated"])
            self.assertIn("rotated_at", sidecar)
            self.assertEqual((sidecar["width"], sidecar["height"]), (16, 16))
            self.assertNotEqual(sidecar["sha256"], created["sha256"])
            self.assertIn("rotated_note", sidecar)

            with Image.open(stored) as rotated:
                self.assertEqual(rotated.format, "JPEG")
                # White was top-left, black bottom-right; after 180° the
                # diagonals swap. Sample well inside each block for JPEG loss.
                self.assertGreater(sum(rotated.getpixel((11, 11))), 700)
                self.assertLess(sum(rotated.getpixel((4, 4))), 160)

            with open(stored + ".json", encoding="utf-8") as handle:
                saved = json.load(handle)
            self.assertTrue(saved["rotated"])
            self.assertEqual(saved["sha256"], sidecar["sha256"])

    def test_diagnostics_round_trip(self):
        frame = "data:image/jpeg;base64,AAAA"
        payload = {
            "meta": {"user_agent": "capture-lab-test"},
            "samples": [
                {"t": 0, "phase": "tracking", "quad": None},
                {"t": 2000, "phase": "holding", "frame": frame},
            ],
        }
        with self._enabled_env():
            response = self.client.post("/api/dev/capture-lab/diagnostics", json=payload)
            self.assertEqual(response.status_code, 200)
            created = response.json()
            self.assertEqual(created["samples"], 2)
            self.assertEqual(created["frames"], 1)

            path = Path(self.temp_dir.name) / "diagnostics" / created["name"]
            self.assertTrue(path.is_file())
            stored = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(stored["meta"]["user_agent"], "capture-lab-test")
            self.assertEqual(len(stored["samples"]), 2)
            self.assertEqual(stored["samples"][1]["frame"], frame)

            listing = self.client.get("/api/dev/capture-lab/diagnostics")
            self.assertEqual(listing.status_code, 200)
            entries = listing.json()["diagnostics"]
            self.assertEqual([entry["name"] for entry in entries], [created["name"]])
            self.assertEqual(entries[0]["samples"], 2)

            fetched = self.client.get(
                f"/api/dev/capture-lab/diagnostics/{created['name']}"
            )
            self.assertEqual(fetched.status_code, 200)
            self.assertEqual(fetched.json()["samples"][1]["frame"], frame)

    def test_oversized_upload_is_rejected(self):
        oversized = b"\xff" * (MAX_CAPTURE_BYTES + 1)
        with self._enabled_env():
            response = self.client.post(
                "/api/dev/capture-lab/capture",
                files={"file": ("huge.jpg", oversized, "image/jpeg")},
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("20 MiB", response.json()["detail"])
