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
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image

from api.auth import get_current_user
from api.dev_capture_lab import _require_enabled
from models import User
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


@dataclass(frozen=True)
class _Proposal:
    crop: bytes
    turned: bytes
    output_width: int
    output_height: int


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
    image_path: Path, geometry: dict
) -> _Proposal:
    """Recompute the crop from the stored JPEG with the current rules.

    Raises HTTPException(409) with the technical reason when the proposal
    cannot be produced; a placeholder is never substituted.
    """
    points = _parse_quad(geometry)
    if points is None:
        raise HTTPException(status_code=409, detail="geometry quad unusable", headers=NO_STORE)

    rotation = geometry.get("storedRotationCw", 0) or 0
    try:
        with Image.open(image_path) as source:
            source.load()
            rgb = source.convert("RGB")
    except Exception:  # noqa: BLE001 - an unreadable source is a technical failure
        raise HTTPException(status_code=409, detail="stored image unreadable", headers=NO_STORE)

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
    )


def _proposal_for(
    stem: str,
    image_path: Path,
    geometry_path: Path,
    geometry: dict,
) -> _Proposal:
    try:
        mtime_ns = max(
            image_path.stat().st_mtime_ns, geometry_path.stat().st_mtime_ns
        )
    except OSError:
        raise HTTPException(status_code=409, detail="stored proposal unreadable", headers=NO_STORE)

    key = (stem, mtime_ns, STRAIGHTEN_VERSION, straighten_config_digest())
    cached = _cache_get(key)
    if cached is not None:
        return cached

    proposal = _build_proposal(image_path, geometry)
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
                "cv": _cv_entry(stem, cv_index),
            }
            if (cv_dir / f"{stem}.jpg").is_file():
                item["cvUrl"] = f"/api/capture-lab/proposals/{stem}/cv"
            items.append(item)
    return JSONResponse(
        content={"total": len(items), "items": items}, headers=NO_STORE
    )


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


@router.get("/proposals/{stem}/crop")
def proposal_crop(stem: str, user: User = Depends(get_current_user)):
    """The proposal computed now from the stored image and current rules."""
    image_path, geometry_path, geometry = _load_geometry(stem)
    proposal = _proposal_for(stem, image_path, geometry_path, geometry)
    return Response(
        content=proposal.crop, media_type="image/jpeg", headers=NO_STORE
    )


@router.get("/proposals/{stem}/cv")
def proposal_cv(stem: str, user: User = Depends(get_current_user)):
    """The offline CollectorVision comparison crop for one proposal, if any."""
    _check_stem(stem)
    path = _cv_compare_dir() / f"{stem}.jpg"
    if not path.is_file():
        raise HTTPException(status_code=409, detail="no comparison", headers=NO_STORE)
    return FileResponse(path, media_type="image/jpeg", headers=NO_STORE)


@router.get("/proposals/{stem}/turned")
def proposal_turned(stem: str, user: User = Depends(get_current_user)):
    """The same crop rotated 180°, for the orientation ambiguity."""
    image_path, geometry_path, geometry = _load_geometry(stem)
    proposal = _proposal_for(stem, image_path, geometry_path, geometry)
    return Response(
        content=proposal.turned, media_type="image/jpeg", headers=NO_STORE
    )
