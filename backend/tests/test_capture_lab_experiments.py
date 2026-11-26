"""Tests for the capture-lab experiment upload and listing API."""

import json
import os
import stat
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.auth import get_current_user
    from api.capture_lab_experiments import MAX_EXPERIMENT_BYTES, router

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "Capture lab dependencies are not installed")
class CaptureLabExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.user = types.SimpleNamespace(id=21, username="collector")
        self.url = "/api/capture-lab/experiments"

        app = FastAPI()
        app.include_router(router, prefix="/api/capture-lab")
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

    def _experiments_dir(self):
        return Path(self.temp_dir.name) / "experiments"

    def _stored(self, experiment_id):
        return self._experiments_dir() / f"{experiment_id}.json"

    def test_routes_are_404_and_write_nothing_when_the_flag_is_unset(self):
        with patch.dict(os.environ, {"CAPTURE_LAB_DIR": self.temp_dir.name}, clear=False):
            os.environ.pop("CAPTURE_LAB_ENABLED", None)
            self.assertEqual(
                self.client.post(self.url, json={"page": "sweep"}).status_code, 404
            )
            self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertFalse(self._experiments_dir().exists())

    def test_oversized_body_is_rejected_without_writing(self):
        oversized = b'{"pad":"' + b"a" * MAX_EXPERIMENT_BYTES + b'"}'
        with self._enabled_env():
            response = self.client.post(
                self.url,
                content=oversized,
                headers={"content-type": "application/json"},
            )
        self.assertEqual(response.status_code, 413)
        self.assertFalse(self._experiments_dir().exists())

    def test_non_object_body_is_rejected(self):
        with self._enabled_env():
            for body in (b"[1, 2, 3]", b'"text"', b"null", b"42"):
                response = self.client.post(
                    self.url,
                    content=body,
                    headers={"content-type": "application/json"},
                )
                self.assertEqual(response.status_code, 422, body)
        self.assertFalse(self._experiments_dir().exists())

    def test_valid_post_stores_the_body_with_server_fields(self):
        payload = {
            "page": "sweep-2026-11",
            "label": "thread cap 4",
            "runs": [{"threads": 4, "ms": 812.5}, {"threads": 8, "ms": 690.0}],
            "settings": {
                "resolution": "1080p",
                "detector": "phone",
                "cvRoundTrip": True,
            },
        }
        with self._enabled_env():
            response = self.client.post(self.url, json=payload)
        self.assertEqual(response.status_code, 200)
        experiment_id = response.json()["id"]
        self.assertRegex(experiment_id, r"^\d{8}T\d{6}\d{6}Z-[0-9a-f]{8}$")

        path = self._stored(experiment_id)
        self.assertTrue(path.is_file())
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        stored = json.loads(path.read_text(encoding="utf-8"))
        for key, value in payload.items():
            self.assertEqual(stored[key], value)
        self.assertEqual(stored["username"], self.user.username)
        self.assertIn("receivedAt", stored)

        # The atomic write leaves only the final file behind.
        self.assertEqual(
            sorted(child.name for child in self._experiments_dir().iterdir()),
            [path.name],
        )

    def test_listing_is_newest_first_and_tolerates_missing_fields(self):
        first = {"page": "p1", "label": "first", "runs": 3}
        second = {"page": "p2"}
        with self._enabled_env():
            first_id = self.client.post(self.url, json=first).json()["id"]
            second_id = self.client.post(self.url, json=second).json()["id"]
            response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["total"], 2)
        entries = body["experiments"]
        self.assertEqual([entry["id"] for entry in entries], [second_id, first_id])

        newest, oldest = entries
        self.assertEqual(newest["page"], "p2")
        self.assertIsNone(newest["label"])
        self.assertIsNone(newest["runs"])
        self.assertEqual(oldest["page"], "p1")
        self.assertEqual(oldest["label"], "first")
        self.assertEqual(oldest["runs"], 3)
        self.assertIsNotNone(oldest["receivedAt"])
        self.assertEqual(oldest["size"], self._stored(first_id).stat().st_size)

    def test_two_posts_get_distinct_ids(self):
        with self._enabled_env():
            ids = {
                self.client.post(self.url, json={"page": f"p{index}"}).json()["id"]
                for index in range(2)
            }
        self.assertEqual(len(ids), 2)
        self.assertEqual(len(list(self._experiments_dir().glob("*.json"))), 2)

    def test_listing_does_not_create_the_directory(self):
        with self._enabled_env():
            response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["experiments"], [])
        self.assertFalse(self._experiments_dir().exists())
