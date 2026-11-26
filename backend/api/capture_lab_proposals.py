"""Read-only straightening proposals for the capture lab.

The collector reviews proposals on a phone. Nothing here trusts the stored
``.straighten.json`` manifest: every crop is recomputed from the stored padded
JPEG and its ``.geometry.json`` sidecar with the rules that are live *now*, so a
threshold change is visible immediately instead of being masked by an old
artifact. The routes are mounted beside the capture lab and share its
``CAPTURE_LAB_ENABLED`` guard and login dependency.

Read-only: no file is written, no manifest is updated, and generated crops live
only in the bounded in-process cache below.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image

from api.auth import get_current_user
from api.dev_capture_lab import _require_enabled
from models import User
from services import cv_crop
from services.rate_limit import limiter
from services.scan_storage import (
    GEOMETRY_SIDECAR_SUFFIX,
    STRAIGHTEN_JPEG_QUALITY,
)
from services.scan_straighten import (
    Abstained,
    STRAIGHTEN_VERSION,
    straighten_config_digest,
    transform_quad_for_storage,
    try_straighten,
)

# Same opt-in guard as the capture lab: disabled instances answer 404 before
# authentication runs, so a probe cannot tell a missing account from a hidden
# feature.
router = APIRouter(dependencies=[Depends(_require_enabled)])

# A stored scan stem is a UUID4 hex; anything else is rejected rather than
# resolved, which rules out traversal and globbing.
_STEM_PATTERN = re.compile(r"[0-9a-fA-F]{32}")
PROPOSAL_LABEL = "Unverified crop"
NO_STORE = {"Cache-Control": "no-store"}
CACHE_LIMIT = 64
# ``auto`` follows ``SCAN_CROP_SOURCE``; ``phone`` forces the geometry-only
# path so the review page can show what the fallback would have produced.
CROP_SOURCES = ("auto", "phone")

# Detection-only comparison with CollectorVision. The image is bounded before
# decoding (bytes) and before ``load`` (pixels); the detector's own frame is
# capped at ``DETECTION_MAX_EDGE`` so a phone photo stays inside a live-request
# latency budget. These are the capture lab's limits, not the scanner's.
DETECT_MAX_BYTES = 8 * 1024 * 1024
DETECT_MAX_PIXELS = 20_000_000
DETECT_FORMATS = ("JPEG", "PNG")


@dataclass(frozen=True)
class _Proposal:
    crop: bytes
    turned: bytes
    output_width: int
    output_height: int
    # Which path produced this proposal. ``phone`` keeps the existing
    # geometry-only warp; ``collectorvision`` carries its identification.
    source: str = "phone"
    identification: dict | None = None
    turned_cw: int = 0
    # Which pixels produced a CollectorVision proposal: ``native`` (original
    # raster warped with the detected corners) or ``embedder`` (its dewarp
    # raster). ``None`` on the phone path.
    crop_raster: str | None = None
    # CollectorVision's artefact identity and its digest. Both are None on the
    # phone path, which has its own ``STRAIGHTEN_VERSION``/config digest.
    cv_identity: dict | None = None
    config_digest: str | None = None


# Keyed by (stem, sidecar/image mtime, algorithm version, config digest), so a
# changed rule or rewritten source can never be served from a stale entry. The
# value holds both encodings because the phone toggles between them.
_cache: "OrderedDict[tuple, _Proposal]" = OrderedDict()
_cache_lock = threading.Lock()


def _cache_get(key: tuple) -> _Proposal | None:
    with _cache_lock:
        value = _cache.get(key)
        if value is not None:
            _cache.move_to_end(key)
        return value


def _cache_put(key: tuple, value: _Proposal) -> None:
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > CACHE_LIMIT:
            _cache.popitem(last=False)


def _clear_cache() -> None:
    """Test hook; also the way an operator would drop every cached value."""
    with _cache_lock:
        _cache.clear()
    _clear_cv_index()


def _upload_root() -> Path:
    """Resolve the scan-upload root without creating it.

    ``scan_storage.scan_upload_root`` mkdirs as a side effect of uploads; this
    API is read-only, so a missing directory must simply list as empty.
    """
    configured = os.environ.get("SCAN_UPLOAD_DIR", "").strip()
    root = (
        Path(configured)
        if configured
        else Path(__file__).resolve().parent.parent / "data" / "scan-uploads"
    )
    return root.resolve()


def _cv_compare_dir() -> Path:
    """The offline CollectorVision comparison directory, a sibling of uploads.

    The comparison job writes ``<stem>.jpg`` plus ``index.json`` there. This is
    read-only: a missing directory is simply treated as "no comparisons".
    """
    return _upload_root().parent / "cv-compare"


# Parsed ``index.json`` keyed on its resolved path and mtime so the listing
# never re-reads it per request. ``None`` means "not loaded (or file gone)".
_cv_index_cache: tuple[str, int, dict] | None = None
_cv_index_lock = threading.Lock()


def _clear_cv_index() -> None:
    global _cv_index_cache
    with _cv_index_lock:
        _cv_index_cache = None


def _read_cv_index(path: Path) -> dict:
    """Parse one ``index.json``; anything unusable reads as empty."""
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _cv_index() -> dict:
    """The comparison index, re-parsed only when its mtime changes."""
    global _cv_index_cache
    path = _cv_compare_dir() / "index.json"
    try:
        mtime_ns = path.stat().st_mtime_ns
    except OSError:
        _clear_cv_index()
        return {}
    signature = (str(path), mtime_ns)
    with _cv_index_lock:
        cached = _cv_index_cache
        if cached is not None and cached[:2] == signature:
            return cached[2]
    index = _read_cv_index(path)
    with _cv_index_lock:
        _cv_index_cache = (*signature, index)
    return index


def _cv_entry(stem: str, index: dict) -> dict | None:
    """One index entry trimmed to the review-relevant fields."""
    entry = index.get(stem)
    if not isinstance(entry, dict):
        return None
    return {
        "score": entry.get("score"),
        "top1": entry.get("top1"),
        "detection": entry.get("detection"),
        "turnedCw": entry.get("turnedCw"),
    }


def _job_directories() -> list[Path]:
    """Numeric job directories, newest (highest id) first."""
    root = _upload_root()
    try:
        children = list(root.iterdir())
    except OSError:
        return []
    directories: list[tuple[int, Path]] = []
    for child in children:
        try:
            if not child.is_dir():
                continue
            job_id = int(child.name)
        except (OSError, ValueError):
            continue
        directories.append((job_id, child))
    return [path for _, path in sorted(directories, key=lambda item: -item[0])]


def _check_stem(stem: str) -> None:
    if not _STEM_PATTERN.fullmatch(stem):
        raise HTTPException(status_code=400, detail="Invalid proposal stem", headers=NO_STORE)


def _locate(stem: str) -> tuple[Path, Path, Path] | None:
    """Find the stored JPEG and geometry sidecar for one validated stem."""
    for job_dir in _job_directories():
        geometry_path = job_dir / f"{stem}{GEOMETRY_SIDECAR_SUFFIX}"
        image_path = job_dir / f"{stem}.jpg"
        if geometry_path.is_file() and image_path.is_file():
            return job_dir, image_path, geometry_path
    return None


def _parse_quad(geometry: dict) -> list[tuple[float, float]] | None:
    """The sidecar's normalized client quad, or None when unusable."""
    raw_quad = geometry.get("quad")
    if not isinstance(raw_quad, (list, tuple)) or len(raw_quad) != 4:
        return None
    try:
        points = [(float(point[0]), float(point[1])) for point in raw_quad]
    except (TypeError, ValueError, IndexError):
        return None
    if not all(
        math.isfinite(u) and math.isfinite(v) and 0.0 <= u <= 1.0 and 0.0 <= v <= 1.0
        for u, v in points
    ):
        return None
    return points


def _stored_quad(geometry: dict) -> list[tuple[float, float]] | None:
    """Map the client quad through the baked-in stored rotation.

    Unit dimensions give the crop-relative quad in 0..1 of the stored image,
    which is what the phone overlays on the original.
    """
    points = _parse_quad(geometry)
    if points is None:
        return None
    try:
        return transform_quad_for_storage(
            points, int(geometry.get("storedRotationCw", 0) or 0), 1, 1
        )
    except (TypeError, ValueError):
        return None


def _quad_metrics(quad: list[tuple[float, float]]) -> tuple[float, float]:
    """Measured aspect and in-plane tilt of the stored-space quad."""
    sides = [
        math.hypot(
            quad[(index + 1) % 4][0] - quad[index][0],
            quad[(index + 1) % 4][1] - quad[index][1],
        )
        for index in range(4)
    ]
    measured_width = min(sides[0], sides[2])
    measured_height = min(sides[1], sides[3])
    aspect = measured_width / max(measured_height, 1e-9)
    tilt = (math.degrees(math.atan2(
        quad[1][1] - quad[0][1], quad[1][0] - quad[0][0],
    )) + 90.0) % 180.0 - 90.0
    return aspect, tilt


def _jpeg_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(
        output,
        format="JPEG",
        quality=STRAIGHTEN_JPEG_QUALITY,
        optimize=True,
        progressive=True,
    )
    return output.getvalue()


def _build_proposal(
    image_path: Path, geometry: dict, source: str = "auto"
) -> _Proposal:
    """Recompute the crop from the stored JPEG with the current rules.

    The selected crop source decides the first attempt. CollectorVision does
    not need the phone's quad, so it runs before the geometry is parsed; when
    it produces nothing the unchanged phone path runs, and only that path's
    technical failures become a 409. A placeholder is never substituted.

    ``source`` is the request's override: ``auto`` follows
    ``SCAN_CROP_SOURCE``; ``phone`` skips CollectorVision entirely so the
    review page can render the fallback for comparison.
    """
    rotation = geometry.get("storedRotationCw", 0) or 0
    try:
        with Image.open(image_path) as stored:
            stored.load()
            rgb = stored.convert("RGB")
    except Exception:  # noqa: BLE001 - an unreadable source is a technical failure
        raise HTTPException(status_code=409, detail="stored image unreadable", headers=NO_STORE)

    if source == "auto" and cv_crop.crop_source() == "collectorvision":
        proposal = cv_crop.propose_with_collectorvision(rgb)
        if proposal is not None:
            identity = cv_crop.cv_identity()
            return _Proposal(
                crop=_jpeg_bytes(proposal.image),
                turned=_jpeg_bytes(
                    proposal.image.transpose(Image.Transpose.ROTATE_180)
                ),
                output_width=proposal.width,
                output_height=proposal.height,
                source="collectorvision",
                identification=(
                    {
                        **proposal.identification.as_dict(),
                        "detection": proposal.detection,
                        "turnedCw": int(proposal.turned_cw or 0),
                    }
                    if proposal.identification is not None
                    else None
                ),
                turned_cw=int(proposal.turned_cw or 0),
                crop_raster=proposal.crop_raster,
                cv_identity=identity,
                config_digest=cv_crop.cv_identity_digest(identity),
            )

    points = _parse_quad(geometry)
    if points is None:
        raise HTTPException(status_code=409, detail="geometry quad unusable", headers=NO_STORE)

    width, height = rgb.size
    try:
        quad = transform_quad_for_storage(points, int(rotation), width, height)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=409,
            detail=f"unsupported stored rotation {rotation!r}",
            headers=NO_STORE,
        )

    result = try_straighten(rgb, quad)
    if isinstance(result, Abstained):
        raise HTTPException(status_code=409, detail=result.reason, headers=NO_STORE)

    return _Proposal(
        crop=_jpeg_bytes(result.image),
        turned=_jpeg_bytes(result.image.transpose(Image.Transpose.ROTATE_180)),
        output_width=result.width,
        output_height=result.height,
        source="phone",
        identification=None,
        turned_cw=int(getattr(result, "turned_cw", 0) or 0),
    )


def _proposal_for(
    stem: str,
    image_path: Path,
    geometry_path: Path,
    geometry: dict,
    source: str = "auto",
) -> _Proposal:
    try:
        mtime_ns = max(
            image_path.stat().st_mtime_ns, geometry_path.stat().st_mtime_ns
        )
    except OSError:
        raise HTTPException(status_code=409, detail="stored proposal unreadable", headers=NO_STORE)

    # The crop source is part of the identity: flipping the flag, or asking for
    # the phone fallback explicitly, must never serve a cached proposal from
    # the other path.
    key = (
        stem,
        mtime_ns,
        STRAIGHTEN_VERSION,
        straighten_config_digest(),
        cv_crop.crop_source(),
        source,
    )
    cached = _cache_get(key)
    if cached is not None:
        return cached

    proposal = _build_proposal(image_path, geometry, source=source)
    _cache_put(key, proposal)
    return proposal


def _load_geometry(stem: str) -> tuple[Path, Path, dict]:
    _check_stem(stem)
    located = _locate(stem)
    if located is None:
        raise HTTPException(status_code=404, detail="Proposal not found", headers=NO_STORE)
    _, image_path, geometry_path = located
    try:
        geometry = json.loads(geometry_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(status_code=409, detail="geometry sidecar unreadable", headers=NO_STORE)
    if not isinstance(geometry, dict):
        raise HTTPException(status_code=409, detail="geometry sidecar unreadable", headers=NO_STORE)
    return image_path, geometry_path, geometry


@limiter.exempt
@router.get("/proposals")
def list_proposals(user: User = Depends(get_current_user)):
    """Proposals the current rules can produce, newest job first.

    A geometry sidecar whose quad is unusable, or whose transform is
    technically invalid, has no proposal to review and is omitted; asking for
    its crop directly still answers 409 with the reason.
    """
    cv_dir = _cv_compare_dir()
    cv_index = _cv_index()
    items = []
    for job_dir in _job_directories():
        try:
            job_id = int(job_dir.name)
        except ValueError:
            continue
        try:
            geometry_paths = sorted(
                job_dir.glob(f"*{GEOMETRY_SIDECAR_SUFFIX}")
            )
        except OSError:
            continue
        for geometry_path in geometry_paths:
            stem = geometry_path.name[: -len(GEOMETRY_SIDECAR_SUFFIX)]
            if not _STEM_PATTERN.fullmatch(stem):
                continue
            image_path = job_dir / f"{stem}.jpg"
            if not image_path.is_file():
                continue
            try:
                geometry = json.loads(geometry_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(geometry, dict):
                continue

            quad = _stored_quad(geometry)
            if quad is None:
                continue
            try:
                with Image.open(image_path) as stored:
                    width, height = stored.size
            except Exception:  # noqa: BLE001 - unreadable rows cannot be reviewed
                continue

            aspect, tilt = _quad_metrics(quad)
            try:
                proposal = _proposal_for(
                    stem, image_path, geometry_path, geometry
                )
            except HTTPException as exc:
                # A technically invalid proposal is not a proposal; the direct
                # crop route still answers 409 with the reason.
                if exc.status_code != 409:
                    raise
                continue

            item = {
                "stem": stem,
                "jobId": job_id,
                "label": PROPOSAL_LABEL,
                "width": width,
                "height": height,
                "outputWidth": proposal.output_width,
                "outputHeight": proposal.output_height,
                "measuredAspect": round(aspect, 4),
                "tiltDegrees": round(tilt, 4),
                "quad": [[round(u, 4), round(v, 4)] for u, v in quad],
                "originalUrl": f"/api/capture-lab/proposals/{stem}/original",
                "cropUrl": f"/api/capture-lab/proposals/{stem}/crop",
                "rotatedUrl": f"/api/capture-lab/proposals/{stem}/turned",
                "source": proposal.source,
                "identification": proposal.identification,
                "turnedCw": proposal.turned_cw,
                "cropRaster": proposal.crop_raster,
                "cvIdentity": proposal.cv_identity,
                "configDigest": proposal.config_digest,
                "cv": _cv_entry(stem, cv_index),
            }
            if (cv_dir / f"{stem}.jpg").is_file():
                item["cvUrl"] = f"/api/capture-lab/proposals/{stem}/cv"
            # Only CollectorVision proposals have a phone fallback worth
            # comparing; when the phone path made the crop there is none.
            if proposal.source == "collectorvision":
                item["phoneUrl"] = (
                    f"/api/capture-lab/proposals/{stem}/crop?source=phone"
                )
            items.append(item)
    return JSONResponse(
        content={"total": len(items), "items": items}, headers=NO_STORE
    )


@limiter.exempt
@router.get("/proposals/{stem}/original")
def proposal_original(stem: str, user: User = Depends(get_current_user)):
    """Serve the stored padded JPEG unchanged."""
    _check_stem(stem)
    located = _locate(stem)
    if located is None:
        raise HTTPException(status_code=404, detail="Proposal not found", headers=NO_STORE)
    _, image_path, _ = located
    return FileResponse(
        image_path,
        media_type="image/jpeg",
        headers=NO_STORE,
    )


@limiter.exempt
@router.get("/proposals/{stem}/crop")
def proposal_crop(
    stem: str,
    source: str = "auto",
    user: User = Depends(get_current_user),
):
    """The proposal computed now from the stored image and current rules.

    ``source=phone`` forces the geometry-only fallback even when CollectorVision
    is selected, so the page can compare the two; an abstention is still 409.
    """
    if source not in CROP_SOURCES:
        raise HTTPException(
            status_code=400, detail="Invalid crop source", headers=NO_STORE
        )
    image_path, geometry_path, geometry = _load_geometry(stem)
    proposal = _proposal_for(
        stem, image_path, geometry_path, geometry, source=source
    )
    return Response(
        content=proposal.crop, media_type="image/jpeg", headers=NO_STORE
    )


@limiter.exempt
@router.get("/proposals/{stem}/cv")
def proposal_cv(stem: str, user: User = Depends(get_current_user)):
    """The offline CollectorVision comparison crop for one proposal, if any."""
    _check_stem(stem)
    path = _cv_compare_dir() / f"{stem}.jpg"
    if not path.is_file():
        raise HTTPException(status_code=409, detail="no comparison", headers=NO_STORE)
    return FileResponse(path, media_type="image/jpeg", headers=NO_STORE)


@limiter.exempt
@router.get("/proposals/{stem}/turned")
def proposal_turned(stem: str, user: User = Depends(get_current_user)):
    """The same crop rotated 180°, for the orientation ambiguity."""
    image_path, geometry_path, geometry = _load_geometry(stem)
    proposal = _proposal_for(stem, image_path, geometry_path, geometry)
    return Response(
        content=proposal.turned, media_type="image/jpeg", headers=NO_STORE
    )


@limiter.exempt
@router.post("/cv-detect")
async def cv_detect(
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """CollectorVision's card boundary for one uploaded image.

    Detection only: no dewarp, embedder, catalogue lookup or disk write. The
    page draws these corners beside the phone's own overlay so the two
    detectors can be compared on a real capture. An unavailable library or
    detector is a 503 the page shows; a frame with no card is a normal 200 with
    ``detected: false``.

    Bounds: the upload is capped at 8 MiB before decoding and 20 MP before
    ``load``; the long edge is reduced to ``DETECTION_MAX_EDGE`` (1600 px) for
    detection latency and the returned corners are normalised to the supplied
    image, so the page can draw them without knowing about the downscale.
    """
    started = time.perf_counter()
    data = await image.read(DETECT_MAX_BYTES + 1)
    if not data:
        raise HTTPException(
            status_code=422, detail="The image is empty.", headers=NO_STORE
        )
    if len(data) > DETECT_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Image is larger than the 8 MiB limit.",
            headers=NO_STORE,
        )

    try:
        with Image.open(io.BytesIO(data)) as opened:
            if opened.format not in DETECT_FORMATS:
                raise HTTPException(
                    status_code=422,
                    detail="Expected a JPEG or PNG image.",
                    headers=NO_STORE,
                )
            width, height = opened.size
            if width * height > DETECT_MAX_PIXELS:
                raise HTTPException(
                    status_code=422,
                    detail="Image is larger than the 20 MP limit.",
                    headers=NO_STORE,
                )
            opened.load()
            rgb = opened.convert("RGB")
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 - an unreadable upload is a client error
        raise HTTPException(
            status_code=422,
            detail="The image could not be read.",
            headers=NO_STORE,
        )

    try:
        probe = cv_crop.detect_card(rgb)
    except cv_crop.DetectionUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail=f"CollectorVision unavailable: {exc}",
            headers=NO_STORE,
        )

    total_ms = (time.perf_counter() - started) * 1000.0
    return JSONResponse(
        content={
            "detected": probe.detected,
            "corners": probe.corners,
            "confidence": probe.confidence,
            "sharpness": probe.sharpness,
            "detection": probe.detection,
            "ms": {
                "detect": round(probe.detect_ms, 2),
                "total": round(total_ms, 2),
            },
            "resized": probe.resized,
        },
        headers=NO_STORE,
    )
