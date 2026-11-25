"""Validated temporary storage for background card scans."""

from __future__ import annotations

import datetime
import hashlib
import io
import json
import logging
import math
import os
import shutil
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import text
from sqlalchemy.orm import Session

from models import ScanJob, ScanJobItem
from services import cv_crop

logger = logging.getLogger(__name__)

try:
    from pillow_heif import register_heif_opener

    register_heif_opener(thumbnails=False)
    HEIC_AVAILABLE = True
except ImportError:  # pragma: no cover - production installs the dependency
    HEIC_AVAILABLE = False


MAX_FILES_PER_JOB = 50
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_JOB_BYTES = 200 * 1024 * 1024
MAX_IMAGE_PIXELS = 50_000_000
MAX_IMAGE_EDGE = 2048
JPEG_QUALITY = 90
GEOMETRY_SIDECAR_SUFFIX = ".geometry.json"
STRAIGHTEN_JPEG_QUALITY = 92
STRAIGHTEN_MANIFEST_SUFFIX = ".straighten.json"
# Artifact names are content-addressed and carry the algorithm version, so a
# later rule set writes a new name beside the old one and deletion can remove
# every generation with one glob.
STRAIGHTEN_ARTIFACT_PREFIX = ".straight-"
STRAIGHTEN_ARTIFACT_DIGEST_CHARS = 16
STRAIGHTEN_MODES = ("off", "shadow", "on")
STRAIGHTEN_DEFAULT_MODE = "off"
SCAN_RETENTION_DAYS = 14
ALLOWED_IMAGE_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "HEIF", "HEIC"})
# Pillow's ROTATE_* constants are counter-clockwise, so a clockwise quarter
# turn maps to the opposite constant.
CLOCKWISE_ROTATIONS = {
    90: Image.Transpose.ROTATE_270,
    180: Image.Transpose.ROTATE_180,
    270: Image.Transpose.ROTATE_90,
}


class ScanUploadError(ValueError):
    """An uploaded file is unsafe or outside the scanner limits."""


@dataclass(frozen=True)
class SanitizedScanImage:
    data: bytes
    content_type: str = "image/jpeg"
    rotation_cw: int = 0
    # Dimensions of the stored JPEG, after EXIF orientation, the collector's
    # explicit rotation and the resize. Recorded for the geometry sidecar so a
    # later consumer can map client coordinates onto the stored pixels.
    width: int | None = None
    height: int | None = None
    # The pre-encode RGB raster. A shadow derivative is encoded from these
    # pixels directly instead of decoding the stored JPEG again; callers that
    # only need the bytes can ignore it.
    rgb: Image.Image | None = None


_straighten_on_warned = False
_straighten_unknown_warned: set[str] = set()


def straighten_mode() -> str:
    """Resolve ``SCAN_STRAIGHTEN`` to ``off``, ``shadow`` or ``on``.

    ``on`` is accepted by the contract but not implemented in this change: it
    would rewrite the stored image, which would ripple into recognition and
    review. It therefore runs as ``shadow`` (non-destructive and still
    observable) and warns once, so an operator who selected it is not silently
    left with no diagnostics. Unknown values fall back to ``off``.
    """
    global _straighten_on_warned
    raw = os.environ.get("SCAN_STRAIGHTEN", "").strip().lower()
    if not raw:
        return STRAIGHTEN_DEFAULT_MODE
    if raw in ("off", "shadow"):
        return raw
    if raw == "on":
        if not _straighten_on_warned:
            _straighten_on_warned = True
            logger.warning(
                "SCAN_STRAIGHTEN=on is not implemented yet; running as shadow"
            )
        return "shadow"
    if raw not in _straighten_unknown_warned:
        _straighten_unknown_warned.add(raw)
        logger.warning(
            "SCAN_STRAIGHTEN=%s is not a known mode; straightening stays off", raw
        )
    return "off"


def scan_upload_root() -> Path:
    configured = os.environ.get("SCAN_UPLOAD_DIR", "").strip()
    root = Path(configured) if configured else Path(__file__).resolve().parent.parent / "data" / "scan-uploads"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root.resolve()


async def read_limited_upload(upload, *, remaining_job_bytes: int) -> bytes:
    """Read one UploadFile without allowing it or the whole job to grow unbounded."""
    if remaining_job_bytes <= 0:
        raise ScanUploadError("The scan job exceeds the 200 MB upload limit.")

    limit = min(MAX_FILE_BYTES, remaining_job_bytes)
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await upload.read(min(1024 * 1024, limit + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_FILE_BYTES:
            raise ScanUploadError("Each scan photo must be 15 MB or smaller.")
        if size > remaining_job_bytes:
            raise ScanUploadError("The scan job exceeds the 200 MB upload limit.")
        chunks.append(chunk)

    if not chunks:
        raise ScanUploadError("An uploaded scan photo is empty.")
    return b"".join(chunks)


def sanitize_image_bytes(raw: bytes, rotation_cw: int | None = None) -> SanitizedScanImage:
    """Decode, verify, orient, resize, and metadata-strip a scan photo.

    ``rotation_cw`` is the collector's explicit clockwise quarter-turn. It is
    applied after EXIF orientation and before the resize, so it is baked into
    the stored pixels and every later consumer (recognition, review, retained
    collection photo) sees the same image.
    """
    rotation = int(rotation_cw or 0)
    if rotation not in (0, *CLOCKWISE_ROTATIONS):
        raise ScanUploadError("Unsupported scan photo rotation.")
    if not raw:
        raise ScanUploadError("An uploaded scan photo is empty.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                image_format = str(source.format or "").upper()
                if image_format not in ALLOWED_IMAGE_FORMATS:
                    raise ScanUploadError("Only JPEG, PNG, WebP, and HEIC scan photos are supported.")
                if image_format in {"HEIF", "HEIC"} and not HEIC_AVAILABLE:
                    raise ScanUploadError("HEIC support is unavailable on this server.")
                if getattr(source, "n_frames", 1) != 1:
                    raise ScanUploadError("Animated images cannot be used as scan photos.")
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise ScanUploadError("The scan photo has unsupported dimensions.")
                source.load()
                oriented = ImageOps.exif_transpose(source)
                if rotation:
                    oriented = oriented.transpose(CLOCKWISE_ROTATIONS[rotation])
                if oriented.mode in {"RGBA", "LA"} or (
                    oriented.mode == "P" and "transparency" in oriented.info
                ):
                    rgba = oriented.convert("RGBA")
                    rgb = Image.new("RGB", rgba.size, "white")
                    rgb.paste(rgba, mask=rgba.getchannel("A"))
                    oriented = rgb
                else:
                    oriented = oriented.convert("RGB")
                oriented.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
                stored_width, stored_height = oriented.size
                output = io.BytesIO()
                oriented.save(
                    output,
                    format="JPEG",
                    quality=JPEG_QUALITY,
                    optimize=True,
                    progressive=True,
                )
    except ScanUploadError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ScanUploadError("The scan photo is too large to decode safely.")
    except (UnidentifiedImageError, OSError, ValueError):
        raise ScanUploadError("The uploaded file is not a valid supported image.")

    return SanitizedScanImage(
        output.getvalue(),
        rotation_cw=rotation,
        width=stored_width,
        height=stored_height,
        rgb=oriented,
    )


def _job_directory(job_id: int) -> Path:
    return scan_upload_root() / str(int(job_id))


def store_sanitized_image(job_id: int, image: SanitizedScanImage) -> tuple[str, int]:
    """Atomically persist an already-sanitized JPEG under a random name."""
    job_dir = _job_directory(job_id)
    job_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = f"{uuid.uuid4().hex}.jpg"
    final_path = job_dir / name
    temporary_path = job_dir / f".{name}.tmp"
    try:
        with temporary_path.open("xb") as handle:
            handle.write(image.data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, final_path)
        final_path.chmod(0o600)
    finally:
        temporary_path.unlink(missing_ok=True)
    relative_path = final_path.relative_to(scan_upload_root()).as_posix()
    return relative_path, len(image.data)


def geometry_sidecar_path(image_path: Path) -> Path:
    """The geometry sidecar stored next to a sanitized scan image."""
    return image_path.with_name(f"{image_path.stem}{GEOMETRY_SIDECAR_SUFFIX}")


def write_geometry_sidecar(
    relative_path: str | None,
    geometry: dict | None,
    *,
    stored_width: int | None,
    stored_height: int | None,
    rotation_cw: int = 0,
) -> None:
    """Persist the client's crop geometry beside an already-written image.

    Geometry is an optimisation for later cropping, never a reason to fail a
    scan, so every problem here is logged and swallowed. The sidecar repeats
    the stored JPEG's own dimensions (and the rotation baked into it) because
    the client's ``width``/``height`` describe the upload before sanitizing.
    """
    if not relative_path or geometry is None:
        return
    try:
        image_path = resolve_scan_path(relative_path)
        payload = dict(geometry)
        payload["storedWidth"] = stored_width
        payload["storedHeight"] = stored_height
        payload["storedRotationCw"] = int(rotation_cw or 0)
        sidecar_path = geometry_sidecar_path(image_path)
        temporary_path = sidecar_path.with_name(f".{sidecar_path.name}.tmp")
        try:
            with temporary_path.open("x", encoding="utf-8") as handle:
                json.dump(payload, handle, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, sidecar_path)
            sidecar_path.chmod(0o600)
        finally:
            temporary_path.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001 - geometry must never fail a scan
        logger.warning(
            "scan geometry sidecar not written path=%s", relative_path, exc_info=True
        )


def straighten_manifest_path(image_path: Path) -> Path:
    """The straighten manifest stored next to a sanitized scan image."""
    return image_path.with_name(f"{image_path.stem}{STRAIGHTEN_MANIFEST_SUFFIX}")


def cv_manifest_is_current(payload: dict | None) -> bool:
    """Whether a manifest's CollectorVision identity still matches itself.

    Older manifests record only ``algorithmVersion: cv1`` with a null config
    digest. They carry no artefact identity, so a consumer must treat the
    artifact as stale rather than trusting it: the absent digest is the signal,
    not a version string that happens to match. A current manifest stores both
    ``cvIdentity`` and the ``configDigest`` hashed from that exact dict, so the
    pair is verified before it can be believed.
    """
    if not isinstance(payload, dict):
        return False
    identity = payload.get("cvIdentity")
    digest = payload.get("configDigest")
    if not isinstance(identity, dict) or not isinstance(digest, str) or not digest:
        return False
    return digest == cv_crop.cv_identity_digest(identity)


def straighten_artifact_paths(image_path: Path) -> list[Path]:
    """Every derived straight crop written for one sanitized scan image.

    The glob spans helper versions, so deletion also removes artifacts left by
    an older rule set beside a newer one.
    """
    return sorted(
        image_path.parent.glob(f"{image_path.stem}{STRAIGHTEN_ARTIFACT_PREFIX}*.jpg")
    )


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write through a unique same-directory temporary file, then rename.

    A deterministic ``.<name>.tmp`` path lets two concurrent writers truncate
    each other's staging file and then race on the rename. Each call therefore
    gets its own randomized suffix, and a failed write removes it.
    """
    temporary_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary_path.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        path.chmod(0o600)
    finally:
        temporary_path.unlink(missing_ok=True)


def _straighten_quad_pixels(
    geometry: dict | None,
    rotation_cw: int,
    width: int,
    height: int,
) -> list[tuple[float, float]] | None:
    """Turn the client's normalized quad into sanitized-raster pixels."""
    if not isinstance(geometry, dict):
        return None
    raw_quad = geometry.get("quad")
    if not isinstance(raw_quad, (list, tuple)) or len(raw_quad) != 4:
        return None
    try:
        points = [(float(point[0]), float(point[1])) for point in raw_quad]
    except (TypeError, ValueError, IndexError):
        return None
    if not all(math.isfinite(u) and math.isfinite(v) for u, v in points):
        return None
    if not all(0.0 <= u <= 1.0 and 0.0 <= v <= 1.0 for u, v in points):
        return None
    from services.scan_straighten import transform_quad_for_storage

    return transform_quad_for_storage(points, rotation_cw, width, height)


def _write_straighten_manifest(image_path: Path, payload: dict) -> None:
    """Write the manifest atomically; a failure here must not fail the scan."""
    try:
        body = json.dumps(payload, separators=(",", ":")) + "\n"
        _atomic_write_bytes(straighten_manifest_path(image_path), body.encode("utf-8"))
    except Exception:  # noqa: BLE001 - diagnostics must never fail a scan
        logger.warning(
            "scan straighten manifest not written path=%s", image_path, exc_info=True
        )


def derive_straight_image(
    relative_path: str,
    geometry: dict | None,
    sanitized: SanitizedScanImage,
) -> None:
    """Shadow-only straight derivative; never raises and never touches the scan.

    Called after the stored JPEG is written. In ``shadow`` mode the selected
    crop source produces the proposal: ``collectorvision`` detects and
    identifies the card itself (see ``services.cv_crop``), and when that yields
    nothing the unchanged phone path transforms the client quad into the
    stored raster's pixels and hands it to ``try_straighten``. The result is
    written beside the original together with a manifest describing which path
    produced it. Recognition, the API payload and the stored image are
    unchanged. The padded original is always authoritative; the derivative is
    only an ``Unverified crop`` recorded with ``state: proposed``.

    A proposal is withheld only when the transform is technically unusable:
    invalid or self-crossing geometry, a degenerate or unstable transform,
    insufficient source pixels, or a failed decode. Boundary diagnostics live
    under ``diagnostics.boundary`` and the outward crop growth under
    ``diagnostics.expansion``; neither can approve or withhold anything.

    A manifest is written for **every** attempt, including a disabled pipeline
    or unusable geometry, so a stale ``proposed`` cannot outlive a later run.
    The artifact is published before its manifest, and the manifest is only
    written for the raster that is actually stored: if another writer replaced
    the image, this attempt's source is superseded and gets no manifest.
    """
    try:
        image_path = resolve_scan_path(relative_path)
    except ScanUploadError:
        return

    mode = straighten_mode()
    source_pref = cv_crop.crop_source()
    source_digest = hashlib.sha256(sanitized.data).hexdigest()
    try:
        stored_digest = hashlib.sha256(image_path.read_bytes()).hexdigest()
    except OSError:
        logger.warning(
            "scan straighten skipped: stored image unreadable path=%s",
            relative_path,
        )
        return
    if stored_digest != source_digest:
        logger.warning(
            "scan straighten skipped: stored image is a newer generation path=%s",
            relative_path,
        )
        return

    helper = None
    try:
        from services import scan_straighten as helper
    except Exception:  # noqa: BLE001 - an optional dependency must not fail a scan
        logger.warning(
            "scan straighten helper unavailable path=%s", relative_path, exc_info=True
        )

    algorithm_version = getattr(helper, "STRAIGHTEN_VERSION", None)
    config_digest = None
    if helper is not None:
        try:
            config_digest = helper.straighten_config_digest()
        except Exception:  # noqa: BLE001 - identity is diagnostic, not required
            logger.warning(
                "scan straighten config digest failed path=%s",
                relative_path,
                exc_info=True,
            )

    rotation = int(sanitized.rotation_cw or 0)
    manifest: dict = {
        "state": "error",
        "reason": None,
        "algorithmVersion": algorithm_version,
        "configDigest": config_digest,
        "sourceSha256": source_digest,
        "geometry": geometry,
        "rotationCw": rotation,
        "generation": {
            "sourceSha256": source_digest,
            "algorithmVersion": algorithm_version,
            "configDigest": config_digest,
            "rotationCw": rotation,
        },
        "description": None,
        # Which path produced the proposal, and CollectorVision's identification
        # when that path did. ``None`` when no proposal was produced.
        "source": None,
        "identification": None,
        # "native" when the crop came from warping the original pixels with the
        # detected corners, "embedder" when it was the library's dewarp raster.
        "cropRaster": None,
        # The CollectorVision artefact identity and its digest when that path
        # produced the proposal; both stay null on the phone path.
        "cvIdentity": None,
        "diagnostics": {"boundary": None, "expansion": None},
        "turnedCw": 0,
        "outputWidth": None,
        "outputHeight": None,
        "outputBytes": None,
        "artifact": None,
        "artifactSha256": None,
        "createdAt": datetime.datetime.utcnow().isoformat() + "Z",
    }
    out_width = out_height = 0
    try:
        if mode == "off":
            manifest.update(state="skipped_disabled", reason=None)
        else:
            # CollectorVision is the proposal source when selected. It locates
            # the card itself, so it does not need the phone's quad; only a
            # detection or dewarp failure falls through to the phone path. A
            # failed identification still returns the crop, so it does not.
            proposal = None
            if source_pref == "collectorvision" and sanitized.rgb is not None:
                proposal = cv_crop.propose_with_collectorvision(sanitized.rgb)
            if proposal is not None:
                manifest["source"] = "collectorvision"
                manifest["cropRaster"] = proposal.crop_raster
                # A successful crop with a failed identification is still a
                # proposal: the crop is the artefact, the identity is optional.
                manifest["identification"] = (
                    {
                        **proposal.identification.as_dict(),
                        "detection": proposal.detection,
                        "turnedCw": int(proposal.turned_cw or 0),
                    }
                    if proposal.identification is not None
                    else None
                )
                manifest["algorithmVersion"] = cv_crop.CV_ALGORITHM_VERSION
                # The identity of the artefacts, not just the rule version. A
                # failure to build it must not cost the crop, so it degrades to
                # nulls and the digest still describes that exact (unknown)
                # identity rather than silently matching a known one.
                try:
                    identity = cv_crop.cv_identity()
                    identity_digest = cv_crop.cv_identity_digest(identity)
                except Exception:  # noqa: BLE001 - identity is diagnostic
                    logger.warning(
                        "scan straighten collectorvision identity failed path=%s",
                        relative_path,
                        exc_info=True,
                    )
                    identity, identity_digest = None, None
                manifest["cvIdentity"] = identity
                manifest["configDigest"] = identity_digest
                # A different algorithm writes a different artifact name; the
                # deletion glob covers every generation alike.
                manifest["generation"] = {
                    "sourceSha256": source_digest,
                    "algorithmVersion": cv_crop.CV_ALGORITHM_VERSION,
                    "configDigest": identity_digest,
                    "rotationCw": rotation,
                }
                output = io.BytesIO()
                proposal.image.save(
                    output,
                    format="JPEG",
                    quality=STRAIGHTEN_JPEG_QUALITY,
                    optimize=True,
                    progressive=True,
                )
                data = output.getvalue()
                digest = hashlib.sha256(data).hexdigest()
                artifact_path = image_path.with_name(
                    f"{image_path.stem}{STRAIGHTEN_ARTIFACT_PREFIX}"
                    f"{cv_crop.CV_ALGORITHM_VERSION}-"
                    f"{digest[:STRAIGHTEN_ARTIFACT_DIGEST_CHARS]}.jpg"
                )
                # Artifact first, then the manifest that names it.
                _atomic_write_bytes(artifact_path, data)
                manifest.update(
                    state="proposed",
                    description="Unverified crop",
                    reason=None,
                    artifact=artifact_path.name,
                    artifactSha256=digest,
                    outputWidth=proposal.width,
                    outputHeight=proposal.height,
                    outputBytes=len(data),
                    turnedCw=int(proposal.turned_cw or 0),
                )
                out_width, out_height = proposal.width, proposal.height
            elif helper is None:
                manifest.update(
                    state="error", reason="straighten helper unavailable"
                )
            else:
                # The phone path is what runs now, so record it even when it
                # abstains: the crop source describes the producing path.
                manifest["source"] = "phone"
                quad = None
                if sanitized.width and sanitized.height:
                    quad = _straighten_quad_pixels(
                        geometry, rotation, sanitized.width, sanitized.height
                    )
                if quad is None:
                    manifest.update(
                        state="skipped_no_geometry",
                        reason="geometry absent or quad unusable",
                    )
                elif sanitized.rgb is None:
                    manifest.update(
                        state="error", reason="sanitized raster unavailable"
                    )
                else:
                    result = helper.try_straighten(sanitized.rgb, quad)
                    support = getattr(result, "support", None)
                    # Diagnostics only: no branch below consults the boundary
                    # verdict. Technical validity alone decides the proposal, so
                    # a failure to serialise diagnostics must not cost the
                    # artifact.
                    if support is not None:
                        try:
                            manifest["diagnostics"]["boundary"] = (
                                helper.boundary_diagnostics(support)
                            )
                        except Exception:  # noqa: BLE001 - diagnostics must not withhold
                            logger.warning(
                                "scan straighten diagnostics failed path=%s",
                                relative_path,
                                exc_info=True,
                            )
                    if isinstance(result, helper.Straightened):
                        # The outward expansion is developer diagnostics beside
                        # the claim's own numbers; it explains the crop's
                        # geometry and has no authority over state either.
                        expansion = getattr(result, "expansion", None)
                        if isinstance(expansion, dict):
                            manifest["diagnostics"]["expansion"] = expansion
                        output = io.BytesIO()
                        result.image.save(
                            output,
                            format="JPEG",
                            quality=STRAIGHTEN_JPEG_QUALITY,
                            optimize=True,
                            progressive=True,
                        )
                        data = output.getvalue()
                        digest = hashlib.sha256(data).hexdigest()
                        artifact_path = image_path.with_name(
                            f"{image_path.stem}{STRAIGHTEN_ARTIFACT_PREFIX}"
                            f"{helper.STRAIGHTEN_VERSION}-"
                            f"{digest[:STRAIGHTEN_ARTIFACT_DIGEST_CHARS]}.jpg"
                        )
                        # Artifact first: never publish a manifest that
                        # authorizes bytes which are not on disk yet.
                        _atomic_write_bytes(artifact_path, data)
                        manifest.update(
                            state="proposed",
                            description="Unverified crop",
                            reason=None,
                            artifact=artifact_path.name,
                            artifactSha256=digest,
                            outputWidth=result.width,
                            outputHeight=result.height,
                            outputBytes=len(data),
                            turnedCw=int(getattr(result, "turned_cw", 0) or 0),
                        )
                        out_width, out_height = result.width, result.height
                    else:
                        manifest.update(
                            state="abstained",
                            reason=str(getattr(result, "reason", "abstained")),
                        )
    except Exception as exc:  # noqa: BLE001 - shadow work must never fail a scan
        logger.warning(
            "scan straighten failed path=%s", relative_path, exc_info=True
        )
        manifest.update(
            state="error",
            reason=f"{type(exc).__name__}: {exc}"[:300],
            artifact=None,
            artifactSha256=None,
            outputWidth=None,
            outputHeight=None,
            outputBytes=None,
        )
    finally:
        _write_straighten_manifest(image_path, manifest)
        logger.info(
            "straighten mode=%s state=%s reason=%s out=%sx%s",
            mode,
            manifest["state"],
            manifest.get("reason") or "-",
            out_width,
            out_height,
        )



def resolve_scan_path(relative_path: str) -> Path:
    root = scan_upload_root()
    candidate = (root / str(relative_path or "")).resolve()
    if candidate == root or root not in candidate.parents:
        raise ScanUploadError("Invalid scan image path.")
    return candidate


def delete_scan_image(relative_path: str | None) -> None:
    if not relative_path:
        return
    try:
        path = resolve_scan_path(relative_path)
    except ScanUploadError:
        return
    path.unlink(missing_ok=True)
    try:
        geometry_sidecar_path(path).unlink(missing_ok=True)
    except OSError:
        logger.warning("scan geometry sidecar not deleted path=%s", relative_path)
    try:
        straighten_manifest_path(path).unlink(missing_ok=True)
        for artifact_path in straighten_artifact_paths(path):
            artifact_path.unlink(missing_ok=True)
    except OSError:
        logger.warning("scan straighten files not deleted path=%s", relative_path)
    try:
        path.parent.rmdir()
    except OSError:
        pass


def delete_job_directory(job_id: int) -> None:
    shutil.rmtree(_job_directory(job_id), ignore_errors=True)


def purge_orphaned_scan_directories(
    db: Session,
    *,
    now: datetime.datetime | None = None,
    grace_minutes: int = 60,
) -> int:
    """Remove crash leftovers that have no committed database job."""
    now = now or datetime.datetime.utcnow()
    cutoff = now.timestamp() - (grace_minutes * 60)
    known_ids = {str(row[0]) for row in db.query(ScanJob.id).all()}
    removed = 0
    for child in scan_upload_root().iterdir():
        if not child.is_dir() or child.name in known_ids:
            continue
        try:
            if child.stat().st_mtime > cutoff:
                continue
        except OSError:
            continue
        shutil.rmtree(child, ignore_errors=True)
        removed += 1
    return removed


async def create_scan_job(
    db: Session,
    user_id: int,
    uploads: list,
    *,
    batch_modes: list[bool] | None = None,
    rotations: list[int | None] | None = None,
    capture_geometry: list[dict | None] | None = None,
    binder_id: int | None = None,
    before_commit: Callable[[ScanJob], None] | None = None,
) -> ScanJob:
    """Validate and persist a job without retaining any original upload bytes."""
    if not uploads:
        raise ScanUploadError("At least one scan photo is required.")
    if len(uploads) > MAX_FILES_PER_JOB:
        raise ScanUploadError("A scan job can contain at most 50 photos.")
    if batch_modes is None:
        batch_modes = [len(uploads) > 1] * len(uploads)
    if len(batch_modes) != len(uploads):
        raise ScanUploadError("Scan processing choices do not match the uploaded photos.")
    if rotations is not None and len(rotations) != len(uploads):
        raise ScanUploadError("Photo rotations do not match the uploaded photos.")
    if capture_geometry is not None and len(capture_geometry) != len(uploads):
        raise ScanUploadError("Photo geometry does not match the uploaded photos.")

    now = datetime.datetime.utcnow()
    job = ScanJob(
        user_id=user_id,
        binder_id=binder_id,
        status="pending",
        created_at=now,
        updated_at=now,
        expires_at=now + datetime.timedelta(days=SCAN_RETENTION_DAYS),
    )
    db.add(job)
    db.flush()
    # Creating two jobs for the same user at once must not race on the
    # round-robin cursor's primary key. PostgreSQL and the SQLite test suite
    # both support this conflict-safe insert.
    db.execute(
        text(
            "INSERT INTO scan_queue_user_state (user_id, last_dispatched_at) "
            "VALUES (:user_id, NULL) ON CONFLICT (user_id) DO NOTHING"
        ),
        {"user_id": user_id},
    )

    raw_total = 0
    try:
        for position, upload in enumerate(uploads):
            raw = await read_limited_upload(
                upload,
                remaining_job_bytes=MAX_JOB_BYTES - raw_total,
            )
            raw_total += len(raw)
            rotation = rotations[position] if rotations is not None else None
            sanitized = sanitize_image_bytes(raw, rotation_cw=rotation)
            logger.info(
                "scan item sanitized job_id=%s position=%s rotation_cw=%s",
                job.id,
                position,
                sanitized.rotation_cw,
            )
            relative_path, byte_size = store_sanitized_image(job.id, sanitized)
            # Only after the image exists, and never fatal: the sidecar is a
            # recording of the client's crop geometry, not scan data.
            write_geometry_sidecar(
                relative_path,
                capture_geometry[position] if capture_geometry is not None else None,
                stored_width=sanitized.width,
                stored_height=sanitized.height,
                rotation_cw=sanitized.rotation_cw,
            )
            # Shadow-only derivative: nothing downstream reads it in this step.
            derive_straight_image(
                relative_path,
                capture_geometry[position] if capture_geometry is not None else None,
                sanitized,
            )
            db.add(
                ScanJobItem(
                    job_id=job.id,
                    user_id=user_id,
                    position=position,
                    image_path=relative_path,
                    content_type=sanitized.content_type,
                    byte_size=byte_size,
                    batch_mode=bool(batch_modes[position]) and len(uploads) > 1,
                    status="pending",
                    resolved=False,
                    attempts=0,
                    transient_failures=0,
                    next_attempt_at=now,
                    created_at=now,
                    updated_at=now,
                )
            )
        if before_commit is not None:
            # Lets a caller stage rows (e.g. an idempotency record) in the same
            # transaction as the job. Items must be visible to its queries.
            db.flush()
            before_commit(job)
        db.commit()
        db.refresh(job)
        return job
    except Exception:
        db.rollback()
        delete_job_directory(job.id)
        raise
