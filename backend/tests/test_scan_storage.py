import datetime
import hashlib
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

try:
    from fastapi import UploadFile
    from PIL import Image, ImageDraw
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from starlette.datastructures import Headers

    from database import Base
    from models import ScanJobItem, User
    from services import scan_storage
    from services.scan_storage import ScanUploadError, create_scan_job, sanitize_image_bytes

    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


def _image_bytes(image_format="JPEG", *, size=(800, 1100), exif=False):
    image = Image.new("RGB", size, "#d92828")
    output = io.BytesIO()
    kwargs = {}
    if exif:
        metadata = Image.Exif()
        metadata[274] = 6
        metadata[270] = "private scan metadata"
        kwargs["exif"] = metadata
    image.save(output, format=image_format, **kwargs)
    return output.getvalue()


def _upload(data, content_type="image/jpeg"):
    return UploadFile(
        file=io.BytesIO(data),
        filename="private-original-name.jpg",
        headers=Headers({"content-type": content_type}),
    )


def _marker_image_bytes(size=(90, 130)):
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
        "width": 800,
        "height": 1100,
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


CARD_BACKGROUND = (26, 28, 34)
CARD_STOCK = (246, 246, 242)
CARD_RECT = (20, 20, 399, 579)
CARD_CANVAS = (420, 600)


def _card_canvas_bytes(size=CARD_CANVAS, rect=CARD_RECT):
    """A bright card on a dark background: every claimed side has a real edge."""
    canvas = Image.new("RGB", size, CARD_BACKGROUND)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle(rect, fill=CARD_STOCK, outline=(4, 4, 4), width=6)
    output = io.BytesIO()
    canvas.save(output, format="JPEG", quality=95)
    return output.getvalue()


def _card_geometry(size=CARD_CANVAS, rect=CARD_RECT):
    width, height = size
    left, top, right, bottom = rect
    return _geometry(
        width=width,
        height=height,
        quad=[
            [left / width, top / height],
            [right / width, top / height],
            [right / width, bottom / height],
            [left / width, bottom / height],
        ],
    )


def _shrink_geometry(geometry, fraction=0.6):
    quad = geometry["quad"]
    cx = sum(point[0] for point in quad) / 4.0
    cy = sum(point[1] for point in quad) / 4.0
    return {
        **geometry,
        "quad": [
            [cx + (u - cx) * fraction, cy + (v - cy) * fraction]
            for u, v in quad
        ],
    }


def _is_red(pixel):
    return pixel[0] > 150 and pixel[0] > pixel[2]


def _is_blue(pixel):
    return pixel[2] > 150 and pixel[2] > pixel[0]


@unittest.skipUnless(DEPS_AVAILABLE, "Scanner image dependencies are not installed")
class ScanSanitizationTests(unittest.TestCase):
    def test_reencodes_orients_resizes_and_strips_metadata(self):
        sanitized = sanitize_image_bytes(_image_bytes(size=(3000, 4000), exif=True))

        with Image.open(io.BytesIO(sanitized.data)) as result:
            self.assertEqual(result.format, "JPEG")
            self.assertLessEqual(max(result.size), 2048)
            self.assertFalse(result.getexif())
        self.assertEqual(sanitized.content_type, "image/jpeg")

    def test_accepts_png_and_webp_but_always_outputs_safe_jpeg(self):
        for image_format in ("PNG", "WEBP"):
            with self.subTest(image_format=image_format):
                sanitized = sanitize_image_bytes(_image_bytes(image_format))
                with Image.open(io.BytesIO(sanitized.data)) as result:
                    self.assertEqual(result.format, "JPEG")

    def test_rejects_non_images_and_unsupported_formats(self):
        with self.assertRaises(ScanUploadError):
            sanitize_image_bytes(b"not an image")

        animated = io.BytesIO()
        frames = [Image.new("RGB", (8, 8), color) for color in ("red", "blue")]
        frames[0].save(animated, format="GIF", save_all=True, append_images=frames[1:])
        with self.assertRaises(ScanUploadError):
            sanitize_image_bytes(animated.getvalue())

    @unittest.skipUnless(getattr(scan_storage, "HEIC_AVAILABLE", False), "pillow-heif is unavailable")
    def test_accepts_heic_and_normalizes_it_to_jpeg(self):
        raw = _image_bytes("HEIF")
        sanitized = sanitize_image_bytes(raw)
        with Image.open(io.BytesIO(sanitized.data)) as result:
            self.assertEqual(result.format, "JPEG")

    def test_sanitized_result_exposes_the_pre_encode_rgb(self):
        sanitized = sanitize_image_bytes(_marker_image_bytes((90, 130)))

        self.assertIsNotNone(sanitized.rgb)
        self.assertEqual(sanitized.rgb.mode, "RGB")
        self.assertEqual(sanitized.rgb.size, (90, 130))
        # The bytes are encoded from the same raster, not a decode of them.
        with Image.open(io.BytesIO(sanitized.data)) as stored:
            self.assertEqual(stored.size, sanitized.rgb.size)

    def test_rotation_90_is_a_clockwise_quarter_turn_of_the_stored_pixels(self):
        sanitized = sanitize_image_bytes(_marker_image_bytes((90, 130)), rotation_cw=90)

        self.assertEqual(sanitized.rotation_cw, 90)
        with _decoded(sanitized.data) as result:
            self.assertEqual(result.size, (130, 90))
            # Clockwise: the original left (red) half becomes the top half.
            self.assertTrue(_is_red(result.getpixel((5, 5))))
            self.assertTrue(_is_blue(result.getpixel((5, 85))))

    def test_rotation_180_and_270_are_baked_into_the_stored_pixels(self):
        raw = _marker_image_bytes((90, 130))

        turned = sanitize_image_bytes(raw, rotation_cw=180)
        with _decoded(turned.data) as result:
            self.assertEqual(result.size, (90, 130))
            # Half a turn: red moves from the left half to the right half.
            self.assertTrue(_is_blue(result.getpixel((5, 5))))
            self.assertTrue(_is_red(result.getpixel((85, 5))))

        turned = sanitize_image_bytes(raw, rotation_cw=270)
        with _decoded(turned.data) as result:
            self.assertEqual(result.size, (130, 90))
            # Three-quarter turn: red moves from the left half to the bottom.
            self.assertTrue(_is_blue(result.getpixel((5, 5))))
            self.assertTrue(_is_red(result.getpixel((5, 85))))

    def test_no_rotation_is_unchanged_where_pillow_reencoding_allows(self):
        raw = _marker_image_bytes((90, 130))
        plain = sanitize_image_bytes(raw)
        explicit_zero = sanitize_image_bytes(raw, rotation_cw=0)

        self.assertEqual(plain.rotation_cw, 0)
        self.assertEqual(explicit_zero.rotation_cw, 0)
        with _decoded(plain.data) as expected, _decoded(explicit_zero.data) as result:
            self.assertEqual(result.size, expected.size)
            self.assertEqual(result.getpixel((5, 5)), expected.getpixel((5, 5)))

    def test_rejects_an_unsupported_rotation(self):
        with self.assertRaises(ScanUploadError):
            sanitize_image_bytes(_marker_image_bytes(), rotation_cw=45)



@unittest.skipUnless(DEPS_AVAILABLE, "Scanner image dependencies are not installed")
class ScanJobStorageTests(unittest.IsolatedAsyncioTestCase):
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
        self.user = User(username="scan-owner", hashed_password="x")
        self.db.add(self.user)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.env.stop()
        self.temp_dir.cleanup()

    async def test_job_stores_only_sanitized_randomly_named_files(self):
        before = datetime.datetime.utcnow()
        job = await create_scan_job(self.db, self.user.id, [_upload(_image_bytes())])
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()

        self.assertNotIn("private-original-name", item.image_path)
        stored = scan_storage.resolve_scan_path(item.image_path)
        self.assertTrue(stored.is_file())
        self.assertEqual(stored.read_bytes()[:2], b"\xff\xd8")
        self.assertEqual(item.content_type, "image/jpeg")
        self.assertGreaterEqual(job.expires_at, before + datetime.timedelta(days=13, hours=23))

    async def test_job_applies_per_photo_rotation_to_the_stored_file(self):
        job = await create_scan_job(
            self.db,
            self.user.id,
            [_upload(_marker_image_bytes((90, 130)))],
            rotations=[90],
        )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        stored = scan_storage.resolve_scan_path(item.image_path).read_bytes()

        with _decoded(stored) as result:
            self.assertEqual(result.size, (130, 90))
            self.assertTrue(_is_red(result.getpixel((5, 5))))
            self.assertTrue(_is_blue(result.getpixel((5, 85))))

    async def test_job_rejects_rotations_that_do_not_match_the_photos(self):
        with self.assertRaises(ScanUploadError):
            await create_scan_job(
                self.db,
                self.user.id,
                [_upload(_image_bytes(size=(8, 8)))],
                rotations=[90, 180],
            )
        self.assertEqual(list(scan_storage.scan_upload_root().iterdir()), [])

    async def test_job_writes_the_client_geometry_beside_the_stored_image(self):
        job = await create_scan_job(
            self.db,
            self.user.id,
            [_upload(_image_bytes())],
            capture_geometry=[_geometry()],
        )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        sidecar = scan_storage.geometry_sidecar_path(image_path)

        self.assertEqual(sidecar.name, f"{image_path.stem}.geometry.json")
        self.assertEqual(sidecar.parent, image_path.parent)
        self.assertTrue(sidecar.is_file())
        self.assertEqual(sidecar.stat().st_mode & 0o777, 0o600)
        payload = json.loads(sidecar.read_text())
        with Image.open(image_path) as stored:
            expected_size = stored.size
        self.assertEqual(
            payload,
            {
                **_geometry(),
                "storedWidth": expected_size[0],
                "storedHeight": expected_size[1],
                "storedRotationCw": 0,
            },
        )

    async def test_geometry_sidecar_records_stored_dimensions_after_rotation(self):
        job = await create_scan_job(
            self.db,
            self.user.id,
            [_upload(_image_bytes())],
            rotations=[90],
            capture_geometry=[_geometry()],
        )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        payload = json.loads(scan_storage.geometry_sidecar_path(image_path).read_text())

        with Image.open(image_path) as stored:
            self.assertEqual((payload["storedWidth"], payload["storedHeight"]), stored.size)
        # The encoded upload's own dimensions are untouched by the rotation
        # baked into the stored pixels.
        self.assertEqual((payload["width"], payload["height"]), (800, 1100))
        self.assertEqual(payload["storedRotationCw"], 90)

    async def test_absent_or_abstained_geometry_writes_no_sidecar(self):
        for geometry in (None, [None]):
            with self.subTest(geometry=geometry):
                kwargs = {} if geometry is None else {"capture_geometry": geometry}
                job = await create_scan_job(
                    self.db, self.user.id, [_upload(_image_bytes())], **kwargs
                )
                item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
                image_path = scan_storage.resolve_scan_path(item.image_path)
                self.assertEqual(
                    list(image_path.parent.glob(f"*{scan_storage.GEOMETRY_SIDECAR_SUFFIX}")),
                    [],
                )

    async def test_sidecar_failure_never_fails_the_scan(self):
        class _FailingJson:
            @staticmethod
            def dump(*_args, **_kwargs):
                raise OSError("disk full")

        with patch.object(scan_storage, "json", _FailingJson()), self.assertLogs(
            "services.scan_storage", level="WARNING"
        ) as logs:
            job = await create_scan_job(
                self.db,
                self.user.id,
                [_upload(_image_bytes())],
                capture_geometry=[_geometry()],
            )

        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        self.assertTrue(image_path.is_file())
        self.assertFalse(scan_storage.geometry_sidecar_path(image_path).exists())
        self.assertIn("scan geometry sidecar not written", "\n".join(logs.output))

    async def test_deleting_the_image_removes_its_geometry_sidecar(self):
        job = await create_scan_job(
            self.db,
            self.user.id,
            [_upload(_image_bytes())],
            capture_geometry=[_geometry()],
        )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        sidecar = scan_storage.geometry_sidecar_path(image_path)
        self.assertTrue(sidecar.is_file())

        scan_storage.delete_scan_image(item.image_path)

        self.assertFalse(image_path.exists())
        self.assertFalse(sidecar.exists())
        self.assertFalse(image_path.parent.exists())

    async def test_job_rejects_geometry_that_does_not_match_the_photos(self):
        with self.assertRaises(ScanUploadError):
            await create_scan_job(
                self.db,
                self.user.id,
                [_upload(_image_bytes(size=(8, 8)))],
                capture_geometry=[_geometry(), None],
            )
        self.assertEqual(list(scan_storage.scan_upload_root().iterdir()), [])

    async def test_rejects_more_than_fifty_photos_before_writing(self):
        uploads = [_upload(_image_bytes(size=(8, 8))) for _ in range(51)]
        with self.assertRaises(ScanUploadError):
            await create_scan_job(self.db, self.user.id, uploads)
        self.assertEqual(list(scan_storage.scan_upload_root().iterdir()), [])

    async def test_rejects_per_file_and_total_limits_and_cleans_partial_job(self):
        small = _image_bytes(size=(8, 8))
        with patch.object(scan_storage, "MAX_FILE_BYTES", len(small) - 1):
            with self.assertRaises(ScanUploadError):
                await create_scan_job(self.db, self.user.id, [_upload(small)])

        with patch.object(scan_storage, "MAX_JOB_BYTES", len(small) + 10):
            with self.assertRaises(ScanUploadError):
                await create_scan_job(
                    self.db,
                    self.user.id,
                    [_upload(small), _upload(small)],
                )
        self.assertEqual(list(scan_storage.scan_upload_root().iterdir()), [])

    async def _shadow_job(self, geometry):
        with patch.dict(os.environ, {"SCAN_STRAIGHTEN": "shadow"}):
            job = await create_scan_job(
                self.db,
                self.user.id,
                [_upload(_card_canvas_bytes())],
                capture_geometry=[geometry],
            )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        return item, image_path

    async def test_straighten_off_writes_no_artifact_or_manifest(self):
        job = await create_scan_job(
            self.db,
            self.user.id,
            [_upload(_card_canvas_bytes())],
            capture_geometry=[_card_geometry()],
        )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)

        self.assertFalse(scan_storage.straighten_manifest_path(image_path).exists())
        self.assertEqual(scan_storage.straighten_artifact_paths(image_path), [])

    async def test_shadow_mode_writes_artifact_and_manifest(self):
        raw = _card_canvas_bytes()
        geometry = _card_geometry()
        with patch.dict(os.environ, {"SCAN_STRAIGHTEN": "shadow"}), self.assertLogs(
            "services.scan_storage", level="INFO"
        ) as logs:
            job = await create_scan_job(
                self.db,
                self.user.id,
                [_upload(raw)],
                capture_geometry=[geometry],
            )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        manifest_path = scan_storage.straighten_manifest_path(image_path)

        self.assertEqual(
            manifest_path.name, f"{image_path.stem}.straighten.json"
        )
        payload = json.loads(manifest_path.read_text())
        self.assertEqual(payload["state"], "ready", payload)
        self.assertIsNone(payload["reason"])
        self.assertEqual(payload["helperVersion"], "v1")
        self.assertEqual(
            payload["sourceSha256"],
            hashlib.sha256(image_path.read_bytes()).hexdigest(),
        )
        self.assertEqual(payload["geometry"], geometry)
        self.assertEqual(payload["rotationCw"], 0)
        self.assertIsInstance(payload["createdAt"], str)

        artifacts = scan_storage.straighten_artifact_paths(image_path)
        self.assertEqual(len(artifacts), 1)
        artifact = artifacts[0]
        self.assertEqual(
            artifact.name,
            payload["artifact"],
        )
        self.assertTrue(
            artifact.name.startswith(f"{image_path.stem}.straight-v1-")
        )
        self.assertTrue(artifact.is_file())
        self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)
        self.assertEqual(manifest_path.stat().st_mode & 0o777, 0o600)
        with Image.open(artifact) as output:
            self.assertEqual(
                (payload["outputWidth"], payload["outputHeight"]), output.size
            )
        self.assertEqual(payload["outputBytes"], artifact.stat().st_size)
        self.assertIn("straighten mode=shadow state=ready", "\n".join(logs.output))

    async def test_shadow_geometry_follows_the_collector_rotation(self):
        geometry = _card_geometry()
        with patch.dict(os.environ, {"SCAN_STRAIGHTEN": "shadow"}):
            job = await create_scan_job(
                self.db,
                self.user.id,
                [_upload(_card_canvas_bytes())],
                rotations=[90],
                capture_geometry=[geometry],
            )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        payload = json.loads(
            scan_storage.straighten_manifest_path(image_path).read_text()
        )

        with Image.open(image_path) as stored:
            self.assertEqual(stored.size, (600, 420))
        self.assertEqual(payload["state"], "ready", payload)
        self.assertEqual(payload["rotationCw"], 90)
        artifact = image_path.with_name(payload["artifact"])
        with Image.open(artifact) as output:
            self.assertEqual(
                (payload["outputWidth"], payload["outputHeight"]), output.size
            )

    async def test_shadow_abstention_writes_manifest_without_artifact(self):
        geometry = _shrink_geometry(_card_geometry())
        _, image_path = await self._shadow_job(geometry)
        manifest_path = scan_storage.straighten_manifest_path(image_path)

        payload = json.loads(manifest_path.read_text())
        self.assertEqual(payload["state"], "abstained", payload)
        self.assertIn(payload["reason"], {"boundary_unsupported", "boundary_competing"})
        self.assertIsNone(payload["artifact"])
        self.assertIsNone(payload["outputWidth"])
        self.assertEqual(scan_storage.straighten_artifact_paths(image_path), [])

    async def test_shadow_helper_failure_is_logged_and_the_scan_succeeds(self):
        with patch.dict(os.environ, {"SCAN_STRAIGHTEN": "shadow"}), patch(
            "services.scan_straighten.try_straighten",
            side_effect=RuntimeError("boom"),
        ), self.assertLogs("services.scan_storage", level="WARNING") as logs:
            job = await create_scan_job(
                self.db,
                self.user.id,
                [_upload(_card_canvas_bytes())],
                capture_geometry=[_card_geometry()],
            )

        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        payload = json.loads(
            scan_storage.straighten_manifest_path(image_path).read_text()
        )

        self.assertTrue(image_path.is_file())
        self.assertEqual(item.status, "pending")
        self.assertEqual(payload["state"], "error", payload)
        self.assertIn("RuntimeError", payload["reason"])
        self.assertEqual(scan_storage.straighten_artifact_paths(image_path), [])
        self.assertIn("scan straighten failed", "\n".join(logs.output))

    async def test_deleting_the_image_removes_straight_files(self):
        _, image_path = await self._shadow_job(_card_geometry())
        manifest_path = scan_storage.straighten_manifest_path(image_path)
        artifacts = scan_storage.straighten_artifact_paths(image_path)
        self.assertEqual(len(artifacts), 1)
        self.assertTrue(manifest_path.is_file())

        scan_storage.delete_scan_image(
            self.db.query(ScanJobItem).one().image_path
        )

        self.assertFalse(image_path.exists())
        self.assertFalse(manifest_path.exists())
        for artifact in artifacts:
            self.assertFalse(artifact.exists())
        self.assertFalse(image_path.parent.exists())

    async def test_on_mode_warns_once_and_runs_as_shadow(self):
        scan_storage._straighten_on_warned = False
        with patch.dict(os.environ, {"SCAN_STRAIGHTEN": "on"}), self.assertLogs(
            "services.scan_storage", level="WARNING"
        ) as logs:
            job = await create_scan_job(
                self.db,
                self.user.id,
                [_upload(_card_canvas_bytes())],
                capture_geometry=[_card_geometry()],
            )
        item = self.db.query(ScanJobItem).filter(ScanJobItem.job_id == job.id).one()
        image_path = scan_storage.resolve_scan_path(item.image_path)
        payload = json.loads(
            scan_storage.straighten_manifest_path(image_path).read_text()
        )

        self.assertEqual(payload["state"], "ready", payload)
        self.assertIn("not implemented yet", "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
