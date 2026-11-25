import io
import datetime
import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from PIL import Image
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from api.scan_jobs import router
    from api.auth import get_current_user
    from database import Base, get_db
    from models import Binder, BinderCard, Card, CollectionItem, ImageCache, ScanJob, ScanJobItem, User, UserSetting
    from services.scan_candidate_images import cache_key_for
    from services.scan_providers import scanner_capability_proof
    from services.scan_storage import resolve_scan_path

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _jpeg_bytes():
    image = Image.new("RGB", (80, 112), "#d92828")
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


def _marker_jpeg_bytes(size=(90, 130)):
    """JPEG whose left half is red and right half blue, for rotation checks."""
    width, height = size
    image = Image.new("RGB", size, "#2828d9")
    image.paste("#d92828", (0, 0, width // 2, height))
    output = io.BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


def _decoded(data):
    return Image.open(io.BytesIO(data)).convert("RGB")


def _geometry(**overrides):
    """A client geometry object matching the capture contract."""
    geometry = {
        "v": 1,
        "space": "crop-normalized",
        "width": 80,
        "height": 112,
        "quad": [[0.1, 0.05], [0.9, 0.06], [0.92, 0.95], [0.08, 0.94]],
        "source": "same-frame-model",
        "modelScore": 0.061,
        "modelAgeMs": 12,
        "agreement": 0.02,
        "pendingReanchor": False,
        "frameEdgeMargin": 0.18,
        "quadAspect": 0.716,
        "paddingClipped": False,
    }
    geometry.update(overrides)
    return geometry


def _geometry_field(*entries):
    return json.dumps(list(entries))


@unittest.skipUnless(DEPS_AVAILABLE, "Scanner API dependencies are not installed")
class ScanJobsApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.env = patch.dict(
            os.environ,
            {"SCAN_UPLOAD_DIR": self.temp_dir.name, "SCAN_STRAIGHTEN": "off"},
        )
        self.env.start()
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine)
        self.db = self.Session()
        self.user = User(username="scan-api-owner", hashed_password="x", is_active=True)
        self.other_user = User(username="scan-api-other", hashed_password="x", is_active=True)
        self.db.add_all([self.user, self.other_user])
        self.db.commit()

        app = FastAPI()
        app.include_router(router, prefix="/api/cards")

        def override_db():
            yield self.db

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.app = app
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    def _post_job(self, binder_id=None, data=None, files=None, headers=None):
        payload = dict(data or {})
        if binder_id is not None:
            payload["binder_id"] = str(binder_id)
        with patch("api.recognize.get_gemini_key", return_value="secret-key"), \
                patch("api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)):
            return self.client.post(
                "/api/cards/recognize/jobs",
                data=payload or None,
                files=files or {"files": ("private-name.jpg", _jpeg_bytes(), "image/jpeg")},
                headers=headers,
            )

    def _enqueue(self, binder_id=None):
        response = self._post_job(binder_id)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def _add_catalogue_card(self, card_id="card-1"):
        self.db.add(Card(
            id=f"{card_id}_en",
            tcg_card_id=card_id,
            name="Pikachu",
            number="1",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()

    def _create_binder(self, binder_type="collection", name="Scan Target", owner=None):
        binder = Binder(
            name=name,
            user_id=(owner or self.user).id,
            binder_type=binder_type,
        )
        self.db.add(binder)
        self.db.commit()
        return binder

    def _mark_ready(self, item, card_id="card-1"):
        item.status = "done"
        item.matches = [{"id": f"{card_id}_en", "tcg_card_id": card_id}]
        self.db.commit()

    def _add_scan_item(self, job_id, position, card_id="card-1"):
        item = ScanJobItem(
            job_id=job_id,
            user_id=self.user.id,
            position=position,
            byte_size=0,
            status="done",
            matches=[{"id": f"{card_id}_en", "tcg_card_id": card_id}],
        )
        self.db.add(item)
        self.db.commit()
        return item

    def _scan_add_payload(self, quantity=1):
        return {
            "confirmed_card_id": "card-1",
            "card_id": "card-1_en",
            "quantity": quantity,
            "condition": "NM",
            "variant": "Normal",
            "lang": "en",
            "purchase_price": None,
        }

    def _resolve_and_add(self, job_id, item_id, quantity=1):
        with patch("services.scan_trace.record_ground_truth", return_value=1):
            return self.client.post(
                f"/api/cards/recognize/jobs/{job_id}/items/{item_id}/resolve-and-add",
                json=self._scan_add_payload(quantity),
            )

    def test_enqueue_list_detail_and_authenticated_image(self):
        created = self._enqueue()
        job_id = created["id"]

        listed = self.client.get("/api/cards/recognize/jobs")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual([job["id"] for job in listed.json()["jobs"]], [job_id])
        self.assertEqual(listed.json()["jobs"][0]["active"], 1)
        self.assertEqual(listed.json()["jobs"][0]["attention"], 0)

        detail = self.client.get(f"/api/cards/recognize/jobs/{job_id}")
        self.assertEqual(detail.status_code, 200)
        item = detail.json()["items"][0]
        self.assertTrue(item["has_image"])
        self.assertNotIn("private-name", self.db.get(ScanJobItem, item["id"]).image_path)

        image = self.client.get(
            f"/api/cards/recognize/jobs/{job_id}/items/{item['id']}/image"
        )
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.content[:2], b"\xff\xd8")

    def test_retry_schedule_is_exposed_in_list_and_detail_payloads(self):
        created = self._enqueue()
        retry_at = datetime.datetime.utcnow() + datetime.timedelta(minutes=30)
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.status = "retrying"
        item.next_attempt_at = retry_at
        item.retry_reason = "daily_quota"
        self.db.commit()

        listed_job = self.client.get("/api/cards/recognize/jobs").json()["jobs"][0]
        detail_item = self.client.get(
            f"/api/cards/recognize/jobs/{created['id']}"
        ).json()["items"][0]

        self.assertEqual(listed_job["next_retry_at"], retry_at.isoformat())
        self.assertEqual(listed_job["retry_reason"], "daily_quota")
        self.assertEqual(detail_item["next_attempt_at"], retry_at.isoformat())
        self.assertEqual(detail_item["retry_reason"], "daily_quota")

    def test_item_payload_exposes_no_candidate_recovery_signal(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.status = "done"
        item.matches = []
        item.no_candidates = True
        item.recovery_hint = "manual_review"
        self.db.commit()

        detail_item = self.client.get(
            f"/api/cards/recognize/jobs/{created['id']}"
        ).json()["items"][0]

        self.assertTrue(detail_item["no_candidates"])
        self.assertEqual(detail_item["recovery_hint"], "manual_review")

    def test_other_user_cannot_access_job_or_photo(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        self.app.dependency_overrides[get_current_user] = lambda: self.other_user

        self.assertEqual(
            self.client.get(f"/api/cards/recognize/jobs/{created['id']}").status_code,
            404,
        )
        self.assertEqual(
            self.client.get(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/image"
            ).status_code,
            404,
        )

    def test_enqueue_preserves_order_and_individual_choices(self):
        with patch("api.recognize.get_gemini_key", return_value="secret-key"), \
                patch("api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)):
            response = self.client.post(
                "/api/cards/recognize/jobs",
                data={"individual_positions": "[1]"},
                files=[
                    ("files", ("first.jpg", _jpeg_bytes(), "image/jpeg")),
                    ("files", ("second.jpg", _jpeg_bytes(), "image/jpeg")),
                    ("files", ("third.jpg", _jpeg_bytes(), "image/jpeg")),
                ],
            )

        self.assertEqual(response.status_code, 200, response.text)
        items = self.db.query(ScanJobItem).order_by(ScanJobItem.position).all()
        self.assertEqual([item.position for item in items], [0, 1, 2])
        self.assertEqual([item.batch_mode for item in items], [True, False, True])

    def test_single_photo_is_always_individual(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        self.assertFalse(item.batch_mode)

    def test_rotations_must_align_with_the_uploaded_photos(self):
        too_few = self._post_job(data={"rotations": "[]"})
        too_many = self._post_job(data={"rotations": "[90, 180]"})

        self.assertEqual(too_few.status_code, 422)
        self.assertEqual(too_many.status_code, 422)
        self.assertEqual(self.db.query(ScanJob).count(), 0)
        self.assertEqual(os.listdir(self.temp_dir.name), [])

    def test_rotations_must_be_null_or_a_quarter_turn(self):
        for raw in ('"90"', "[45]", "[true]", "not-json", "null"):
            with self.subTest(rotations=raw):
                response = self._post_job(data={"rotations": raw})
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.db.query(ScanJob).count(), 0)

    def test_absent_rotations_leave_the_stored_photo_unchanged(self):
        raw = _marker_jpeg_bytes((90, 130))
        response = self._post_job(
            files={"files": ("photo.jpg", raw, "image/jpeg")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        created = response.json()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()

        stored = resolve_scan_path(item.image_path).read_bytes()
        with _decoded(stored) as result, _decoded(raw) as source:
            self.assertEqual(result.size, source.size)
            self.assertTrue(result.getpixel((5, 5))[0] > 150)
            self.assertTrue(result.getpixel((85, 5))[2] > 150)

    def test_rotation_90_is_applied_to_the_stored_photo(self):
        raw = _marker_jpeg_bytes((90, 130))
        created = self._post_job(
            data={"rotations": "[90]"},
            files={"files": ("photo.jpg", raw, "image/jpeg")},
        ).json()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()

        stored = resolve_scan_path(item.image_path).read_bytes()
        with _decoded(stored) as result:
            self.assertEqual(result.size, (130, 90))
            # Clockwise: the original left (red) half becomes the top half.
            self.assertTrue(result.getpixel((5, 5))[0] > 150)
            self.assertTrue(result.getpixel((5, 85))[2] > 150)

    def test_absent_capture_geometry_leaves_the_stored_photo_alone(self):
        response = self._post_job()
        self.assertEqual(response.status_code, 200, response.text)
        created = response.json()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        image_path = resolve_scan_path(item.image_path)

        self.assertTrue(image_path.is_file())
        self.assertEqual(
            list(image_path.parent.glob("*.geometry.json")),
            [],
        )

    def test_capture_geometry_is_stored_as_a_sidecar(self):
        response = self._post_job(
            data={"capture_geometry": _geometry_field(_geometry(), None)},
            files=[
                ("files", ("first.jpg", _jpeg_bytes(), "image/jpeg")),
                ("files", ("second.jpg", _jpeg_bytes(), "image/jpeg")),
            ],
        )
        self.assertEqual(response.status_code, 200, response.text)
        created = response.json()
        items = (
            self.db.query(ScanJobItem)
            .filter(ScanJobItem.job_id == created["id"])
            .order_by(ScanJobItem.position)
            .all()
        )

        image_path = resolve_scan_path(items[0].image_path)
        sidecar = image_path.with_name(f"{image_path.stem}.geometry.json")
        self.assertTrue(sidecar.is_file())
        with _decoded(image_path.read_bytes()) as stored:
            expected_size = stored.size
        self.assertEqual(
            json.loads(sidecar.read_text()),
            {
                **_geometry(),
                "storedWidth": expected_size[0],
                "storedHeight": expected_size[1],
                "storedRotationCw": 0,
            },
        )
        # The second photo abstained, so it has no sidecar of its own.
        second_path = resolve_scan_path(items[1].image_path)
        self.assertFalse(
            second_path.with_name(f"{second_path.stem}.geometry.json").exists()
        )

    def test_capture_geometry_must_align_with_the_uploaded_photos(self):
        for raw in ("[]", "[null, null]", "{}", "null", "not-json"):
            with self.subTest(capture_geometry=raw):
                response = self._post_job(data={"capture_geometry": raw})
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.db.query(ScanJob).count(), 0)
        self.assertEqual(os.listdir(self.temp_dir.name), [])

    def test_invalid_capture_geometry_entries_abstain_for_their_photo_only(self):
        bad_quads = dict(quad=[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]])
        bad_source = dict(source="batch-model")
        with self.assertLogs("api.scan_jobs", level="INFO") as logs:
            response = self._post_job(
                data={
                    "capture_geometry": _geometry_field(
                        _geometry(**bad_quads), _geometry(**bad_source)
                    )
                },
                files=[
                    ("files", ("first.jpg", _jpeg_bytes(), "image/jpeg")),
                    ("files", ("second.jpg", _jpeg_bytes(), "image/jpeg")),
                ],
            )

        self.assertEqual(response.status_code, 200, response.text)
        created = response.json()
        items = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).all()
        self.assertEqual(len(items), 2)
        for item in items:
            image_path = resolve_scan_path(item.image_path)
            self.assertTrue(image_path.is_file())
            self.assertFalse(
                image_path.with_name(f"{image_path.stem}.geometry.json").exists()
            )
        logged = "\n".join(logs.output)
        self.assertIn("position=0", logged)
        self.assertIn("quad does not have four points", logged)
        self.assertIn("position=1", logged)
        self.assertIn("unsupported source", logged)

    def test_capture_geometry_entries_must_be_in_range_and_finite(self):
        invalid_entries = {
            "non-finite": dict(quad=[[0.1, 0.1], [float("nan"), 0.1], [0.9, 0.9], [0.1, 0.9]]),
            "out-of-range": dict(quad=[[0.1, 0.1], [1.5, 0.1], [0.9, 0.9], [0.1, 0.9]]),
            "bad-version": dict(v=2),
            "bad-space": dict(space="pixels"),
            "bad-width": dict(width=0),
            "bad-height": dict(height="1100"),
        }
        for reason, overrides in invalid_entries.items():
            with self.subTest(reason=reason):
                response = self._post_job(
                    data={"capture_geometry": _geometry_field(_geometry(**overrides))}
                )
                self.assertEqual(response.status_code, 200, response.text)
                created = response.json()
                item = (
                    self.db.query(ScanJobItem)
                    .filter(ScanJobItem.job_id == created["id"])
                    .one()
                )
                image_path = resolve_scan_path(item.image_path)
                self.assertFalse(
                    image_path.with_name(f"{image_path.stem}.geometry.json").exists()
                )

    def test_deleting_the_job_removes_geometry_sidecars(self):
        created = self._post_job(
            data={"capture_geometry": _geometry_field(_geometry())}
        ).json()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        image_path = resolve_scan_path(item.image_path)
        sidecar = image_path.with_name(f"{image_path.stem}.geometry.json")
        self.assertTrue(sidecar.is_file())

        deleted = self.client.delete(f"/api/cards/recognize/jobs/{created['id']}")

        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertFalse(image_path.exists())
        self.assertFalse(sidecar.exists())
        self.assertFalse(image_path.parent.exists())

    def test_capture_geometry_is_part_of_the_idempotency_fingerprint(self):
        key = "capture-geometry-key-01"
        first = self._post_job(
            data={"capture_geometry": _geometry_field(_geometry())},
            headers={"Idempotency-Key": key},
        )
        self.assertEqual(first.status_code, 200, first.text)

        replay = self._post_job(
            data={"capture_geometry": _geometry_field(_geometry())},
            headers={"Idempotency-Key": key},
        )
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.headers["Idempotent-Replayed"], "true")

        moved = _geometry(
            quad=[[0.2, 0.05], [0.9, 0.06], [0.92, 0.95], [0.08, 0.94]]
        )
        changed = self._post_job(
            data={"capture_geometry": _geometry_field(moved)},
            headers={"Idempotency-Key": key},
        )
        self.assertEqual(changed.status_code, 422, changed.text)
        self.assertEqual(changed.json()["detail"]["code"], "idempotency_key_reused")
        self.assertEqual(self.db.query(ScanJob).count(), 1)

    def test_omitted_capture_geometry_leaves_the_fingerprint_unchanged(self):
        key = "capture-geometry-key-02"
        first = self._post_job(headers={"Idempotency-Key": key})
        self.assertEqual(first.status_code, 200, first.text)

        blank = self._post_job(
            data={"capture_geometry": ""}, headers={"Idempotency-Key": key}
        )
        self.assertEqual(blank.status_code, 200, blank.text)
        self.assertEqual(blank.headers["Idempotent-Replayed"], "true")
        self.assertEqual(self.db.query(ScanJob).count(), 1)

    def test_degraded_capability_forces_every_photo_individual(self):
        # A composite needs the same multi-image capability visual
        # verification does. A provider proven only single-image-capable
        # cannot read several cards out of one grid reliably either, so the
        # server must not composite for it even when the client asks to.
        model = "vision-model"
        env = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": model,
            "OPENAI_BASE_URL": "http://endpoint:11434/v1",
            "OPENAI_API_KEY_REQUIRED": "false",
        }
        with patch.dict(os.environ, env):
            proof = scanner_capability_proof("openai", model, "degraded")
        self.db.add_all([
            UserSetting(user_id=self.user.id, key="scanner_provider", value="openai"),
            UserSetting(user_id=self.user.id, key="scanner_model_openai", value=model),
            UserSetting(
                user_id=self.user.id,
                key="scanner_capability_openai",
                value=proof,
            ),
        ])
        self.db.commit()

        with patch.dict(os.environ, env), patch(
            "api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)
        ):
            response = self.client.post(
                "/api/cards/recognize/jobs",
                # Client claims nothing is individual — the server must
                # override this, not trust it.
                data={"individual_positions": "[]"},
                files=[
                    ("files", ("first.jpg", _jpeg_bytes(), "image/jpeg")),
                    ("files", ("second.jpg", _jpeg_bytes(), "image/jpeg")),
                    ("files", ("third.jpg", _jpeg_bytes(), "image/jpeg")),
                ],
            )

        self.assertEqual(response.status_code, 200, response.text)
        items = self.db.query(ScanJobItem).order_by(ScanJobItem.position).all()
        self.assertEqual([item.batch_mode for item in items], [False, False, False])

    def test_endpoint_change_blocks_enqueue_before_upload_is_persisted(self):
        model = "vision-model"
        first = {
            "OPENAI_SCANNER_ENABLED": "true",
            "OPENAI_MODEL": model,
            "OPENAI_BASE_URL": "http://endpoint-a:11434/v1",
        }
        second = {**first, "OPENAI_BASE_URL": "http://endpoint-b:11434/v1"}
        with patch.dict(os.environ, first):
            proof = scanner_capability_proof("openai", model, "full")
        self.db.add_all([
            UserSetting(user_id=self.user.id, key="scanner_provider", value="openai"),
            UserSetting(user_id=self.user.id, key="scanner_model_openai", value=model),
            UserSetting(
                user_id=self.user.id,
                key="scanner_capability_openai",
                value=proof,
            ),
        ])
        self.db.commit()

        with patch.dict(os.environ, second), patch(
            "api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)
        ) as drain:
            response = self.client.post(
                "/api/cards/recognize/jobs",
                files={"files": ("card.jpg", _jpeg_bytes(), "image/jpeg")},
            )

        self.assertEqual(response.status_code, 409)
        self.assertIn("Test and save", response.json()["detail"])
        self.assertEqual(self.db.query(ScanJob).count(), 0)
        drain.assert_not_awaited()

    def test_disabled_selected_provider_blocks_enqueue_before_upload_is_persisted(self):
        self.db.add(
            UserSetting(
                user_id=self.user.id,
                key="scanner_provider",
                value="openai",
            )
        )
        self.db.commit()

        with patch.dict(os.environ, {"OPENAI_SCANNER_ENABLED": "false"}), patch(
            "api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)
        ) as drain:
            response = self.client.post(
                "/api/cards/recognize/jobs",
                files={"files": ("card.jpg", _jpeg_bytes(), "image/jpeg")},
            )

        self.assertEqual(response.status_code, 409)
        self.assertIn("no longer enabled", response.json()["detail"])
        self.assertEqual(self.db.query(ScanJob).count(), 0)
        drain.assert_not_awaited()

    def test_resolve_deletes_photo_and_removes_fully_handled_job_from_inbox(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        stored = resolve_scan_path(item.image_path)
        item.status = "done"
        item.matches = [{"id": "card-1"}]
        self.db.commit()

        response = self.client.post(
            f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/resolve"
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["resolved"])
        self.assertFalse(stored.exists())
        self.assertEqual(self.client.get("/api/cards/recognize/jobs").json()["jobs"], [])

    def test_resolve_labels_diagnostics_only_with_a_returned_candidate(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.status = "done"
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1"}]
        self.db.commit()

        with patch("services.scan_trace.record_ground_truth", return_value=1) as label:
            response = self.client.post(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/resolve",
                json={"card_id": "card-1"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        label.assert_called_once_with(self.user.id, created["id"], item.id, "card-1")

    def test_resolve_rejects_an_already_handled_item(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.status = "done"
        item.resolved = True
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1"}]
        self.db.commit()

        with patch("services.scan_trace.record_ground_truth") as label:
            response = self.client.post(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/resolve",
                json={"card_id": "card-1"},
            )

        self.assertEqual(response.status_code, 409)
        self.assertIn("already", response.json()["detail"])
        label.assert_not_called()

    def test_atomic_add_and_resolve_cannot_increment_twice(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        stored = resolve_scan_path(item.image_path)
        item.status = "done"
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1"}]
        self.db.add(Card(
            id="card-1_en",
            tcg_card_id="card-1",
            name="Pikachu",
            number="1",
            lang="en",
            is_custom=False,
        ))
        self.db.commit()
        payload = {
            "confirmed_card_id": "card-1",
            "card_id": "card-1_en",
            "quantity": 2,
            "condition": "NM",
            "variant": "Normal",
            "lang": "en",
            "purchase_price": None,
        }

        with patch("services.scan_trace.record_ground_truth", return_value=1) as label:
            first = self.client.post(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/resolve-and-add",
                json=payload,
            )
            duplicate = self.client.post(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/resolve-and-add",
                json=payload,
            )

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["collection_item"]["quantity"], 2)
        self.assertTrue(first.json()["item"]["resolved"])
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        self.assertEqual(self.db.query(CollectionItem).one().quantity, 2)
        self.assertFalse(stored.exists())
        label.assert_called_once_with(self.user.id, created["id"], item.id, "card-1")

    def test_resolve_rejects_ground_truth_outside_the_returned_candidates(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.status = "done"
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1"}]
        self.db.commit()

        response = self.client.post(
            f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/resolve",
            json={"card_id": "different-card"},
        )

        self.assertEqual(response.status_code, 422)
        self.assertFalse(self.db.get(ScanJobItem, item.id).resolved)

    def test_failed_photo_is_retained_and_retry_resets_it(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        stored = resolve_scan_path(item.image_path)
        item.status = "failed"
        item.attempts = 3
        item.error = "unreadable"
        self.db.commit()

        with patch("api.scan_jobs.drain_scan_queue", new=AsyncMock(return_value=0)):
            response = self.client.post(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/retry"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "pending")
        self.assertEqual(response.json()["attempts"], 0)
        self.assertTrue(stored.exists())

    def test_deleting_job_removes_database_rows_and_photo_directory(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        job_dir = resolve_scan_path(item.image_path).parent

        response = self.client.delete(f"/api/cards/recognize/jobs/{created['id']}")

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.db.get(ScanJob, created["id"]))
        self.assertFalse(job_dir.exists())

    def test_resolved_items_remain_in_detail_payload_for_the_collapsed_row(self):
        # The review page collapses a resolved item to a compact row instead
        # of it disappearing; that only works if the detail endpoint still
        # returns it. The separate jobs *list* endpoint is unaffected and
        # keeps filtering fully-resolved jobs out of the inbox.
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.status = "done"
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1"}]
        self.db.commit()

        self.client.post(f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/resolve")

        detail = self.client.get(f"/api/cards/recognize/jobs/{created['id']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual([row["id"] for row in detail.json()["items"]], [item.id])
        self.assertTrue(detail.json()["items"][0]["resolved"])

    def test_candidate_image_serves_from_cache_without_fetching(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1", "image_hd": "https://assets.tcgdex.net/en/x/1/1/high.webp"}]
        self.db.commit()
        self.db.add(ImageCache(
            image_key=cache_key_for("https://assets.tcgdex.net/en/x/1/1/high.webp"),
            data=b"cached-bytes",
            content_type="image/webp",
        ))
        self.db.commit()

        # No network mocking here on purpose: a cache hit must resolve without
        # ever reaching out over the network, so if this test needed an httpx
        # mock to pass it would mean the endpoint fetched instead of reading
        # the cache.
        response = self.client.get(
            f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/candidates/0/image"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"cached-bytes")
        self.assertEqual(response.headers["content-type"], "image/webp")

    def test_candidate_image_fetches_and_caches_on_a_cold_miss(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1", "image": "https://assets.tcgdex.net/en/x/1/1/low.webp"}]
        self.db.commit()

        with patch(
            "api.scan_jobs.fetch_and_cache_candidate_image",
            new=AsyncMock(return_value=(b"fresh-bytes", "image/webp")),
        ) as fetch:
            response = self.client.get(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/candidates/0/image"
            )
            fetch.assert_awaited_once()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"fresh-bytes")

    def test_candidate_image_out_of_range_index_is_404(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1", "image": "https://assets.tcgdex.net/en/x/1/1/low.webp"}]
        self.db.commit()

        response = self.client.get(
            f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/candidates/5/image"
        )
        self.assertEqual(response.status_code, 404)

    def test_other_user_cannot_fetch_candidate_image(self):
        created = self._enqueue()
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        item.matches = [{"id": "card-1_en", "tcg_card_id": "card-1", "image": "https://assets.tcgdex.net/en/x/1/1/low.webp"}]
        self.db.commit()
        self.app.dependency_overrides[get_current_user] = lambda: self.other_user

        self.assertEqual(
            self.client.get(
                f"/api/cards/recognize/jobs/{created['id']}/items/{item.id}/candidates/0/image"
            ).status_code,
            404,
        )
    def test_enqueue_stores_owned_destination_and_detail_returns_it(self):
        binder = self._create_binder("collection", "Trade Binder")
        created = self._enqueue(binder_id=binder.id)
        self.assertEqual(self.db.get(ScanJob, created["id"]).binder_id, binder.id)

        detail = self.client.get(f"/api/cards/recognize/jobs/{created['id']}").json()
        self.assertEqual(
            detail["binder"],
            {"id": binder.id, "name": "Trade Binder", "binder_type": "collection"},
        )

        deck = self._create_binder("physical_deck", "Real Deck")
        deck_job = self._enqueue(binder_id=deck.id)
        deck_detail = self.client.get(f"/api/cards/recognize/jobs/{deck_job['id']}").json()
        self.assertEqual(
            deck_detail["binder"],
            {"id": deck.id, "name": "Real Deck", "binder_type": "physical_deck"},
        )

        plain_job = self._enqueue()
        listed = {
            job["id"]: job
            for job in self.client.get("/api/cards/recognize/jobs").json()["jobs"]
        }
        self.assertEqual(
            listed[created["id"]]["binder"],
            {"id": binder.id, "name": "Trade Binder", "binder_type": "collection"},
        )
        self.assertEqual(
            listed[deck_job["id"]]["binder"],
            {"id": deck.id, "name": "Real Deck", "binder_type": "physical_deck"},
        )
        self.assertIsNone(listed[plain_job["id"]]["binder"])
        self.assertIsNone(
            self.client.get(f"/api/cards/recognize/jobs/{plain_job['id']}").json()["binder"]
        )

    def test_enqueue_rejects_planned_and_foreign_destinations(self):
        for binder_type in ("wishlist", "deck"):
            planned = self._create_binder(binder_type, f"Planned {binder_type}")
            self.assertEqual(self._post_job(planned.id).status_code, 422)

        foreign = self._create_binder("collection", "Other", owner=self.other_user)
        response = self._post_job(foreign.id)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Card list not found.")

        self.assertEqual(self.db.query(ScanJob).count(), 0)
        self.assertEqual(os.listdir(self.temp_dir.name), [])

    def test_resolve_and_add_files_copies_and_reuses_the_allocation_row(self):
        self._add_catalogue_card()
        binder = self._create_binder("collection", "Trade Binder")
        created = self._enqueue(binder_id=binder.id)
        first = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        self._mark_ready(first)
        second = self._add_scan_item(created["id"], 1)

        first_response = self._resolve_and_add(created["id"], first.id)
        second_response = self._resolve_and_add(created["id"], second.id)

        self.assertEqual(first_response.status_code, 200, first_response.text)
        self.assertEqual(second_response.status_code, 200, second_response.text)
        self.assertEqual(
            second_response.json()["binder_allocation"],
            {
                "binder_id": binder.id,
                "binder_name": "Trade Binder",
                "requested": 1,
                "allocated": 1,
                "reason": None,
            },
        )
        collection_item = self.db.query(CollectionItem).one()
        self.assertEqual(collection_item.quantity, 2)
        rows = self.db.query(BinderCard).filter(
            BinderCard.binder_id == binder.id,
            BinderCard.collection_item_id.isnot(None),
        ).all()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].collection_item_id, collection_item.id)
        self.assertEqual(rows[0].card_id, collection_item.card_id)
        self.assertEqual(rows[0].required_quantity, 2)

    def test_partial_allocation_keeps_the_add_and_reports_partial(self):
        self._add_catalogue_card()
        target = self._create_binder("collection", "Target")
        other = self._create_binder("collection", "Other")
        # A prior quantity reduction can leave more copies allocated than owned.
        # The scan add must still succeed and only give the list what is free.
        collection_item = CollectionItem(
            card_id="card-1_en",
            user_id=self.user.id,
            quantity=2,
            condition="NM",
            variant="Normal",
            lang="en",
        )
        self.db.add(collection_item)
        self.db.commit()
        self.db.add(BinderCard(
            binder_id=other.id,
            card_id="card-1_en",
            collection_item_id=collection_item.id,
            required_quantity=3,
        ))
        self.db.commit()

        created = self._enqueue(binder_id=target.id)
        scan_item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        self._mark_ready(scan_item)

        response = self._resolve_and_add(created["id"], scan_item.id, quantity=2)

        self.assertEqual(response.status_code, 200, response.text)
        allocation = response.json()["binder_allocation"]
        self.assertEqual(allocation["requested"], 2)
        self.assertEqual(allocation["allocated"], 1)
        self.assertEqual(allocation["reason"], "partial")

        self.db.refresh(collection_item)
        self.assertEqual(collection_item.quantity, 4)
        target_row = self.db.query(BinderCard).filter(
            BinderCard.binder_id == target.id,
            BinderCard.collection_item_id == collection_item.id,
        ).one()
        self.assertEqual(target_row.required_quantity, 1)
        # The binder never exceeds the owned quantity across all lists.
        allocated_total = sum(
            row.required_quantity
            for row in self.db.query(BinderCard).filter(
                BinderCard.collection_item_id == collection_item.id
            )
        )
        self.assertEqual(allocated_total, collection_item.quantity)

    def test_real_deck_scan_add_creates_plan_and_exact_allocation(self):
        self._add_catalogue_card()
        deck = self._create_binder("physical_deck", "Real Deck")
        created = self._enqueue(binder_id=deck.id)
        scan_item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        self._mark_ready(scan_item)

        response = self._resolve_and_add(created["id"], scan_item.id, quantity=2)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["binder_allocation"]["allocated"], 2)
        self.assertIsNone(response.json()["binder_allocation"]["reason"])

        plan = self.db.query(BinderCard).filter(
            BinderCard.binder_id == deck.id,
            BinderCard.collection_item_id.is_(None),
        ).one()
        allocation = self.db.query(BinderCard).filter(
            BinderCard.binder_id == deck.id,
            BinderCard.collection_item_id.isnot(None),
        ).one()
        self.assertEqual(plan.card_id, "card-1_en")
        self.assertEqual(plan.required_quantity, 2)
        self.assertEqual(allocation.collection_item_id, self.db.query(CollectionItem).one().id)
        self.assertEqual(allocation.required_quantity, 2)

    def test_missing_destination_reports_list_unavailable_and_still_adds(self):
        self._add_catalogue_card()
        binder = self._create_binder("collection", "Gone")
        binder_id = binder.id
        created = self._enqueue(binder_id=binder_id)
        scan_item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == created["id"]).one()
        self._mark_ready(scan_item)
        self.db.delete(binder)
        self.db.commit()

        response = self._resolve_and_add(created["id"], scan_item.id)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json()["binder_allocation"],
            {
                "binder_id": binder_id,
                "binder_name": None,
                "requested": 1,
                "allocated": 0,
                "reason": "list_unavailable",
            },
        )
        self.assertEqual(self.db.query(CollectionItem).one().quantity, 1)
        self.assertEqual(self.db.query(BinderCard).count(), 0)


if __name__ == "__main__":
    unittest.main()
