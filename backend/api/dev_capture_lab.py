"""Dev-only capture lab: keep exact phone-camera captures for comparison.

Nothing here scans, recognises or files cards. Uploaded bytes are written
verbatim beside a JSON sidecar so a desktop browser can compare capture quality
against the phone that produced them. Every route is disabled unless
CAPTURE_LAB_ENABLED is explicitly set on the instance.
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import io
import json
import os
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

from api.auth import get_current_user
from models import User
from services.rate_limit import limiter

try:  # Pillow alone still reads JPEG/PNG/WebP
    from pillow_heif import register_heif_opener

    register_heif_opener(thumbnails=False)
except Exception:
    pass

MAX_CAPTURE_BYTES = 20 * 1024 * 1024
MAX_DIAGNOSTICS_BYTES = 8 * 1024 * 1024
ENABLED_VALUES = {"1", "true", "yes"}


def _require_enabled() -> None:
    """404 unless this instance opted into the capture lab."""
    if os.getenv("CAPTURE_LAB_ENABLED", "").strip().lower() not in ENABLED_VALUES:
        raise HTTPException(status_code=404, detail="Not found")


# The gate is a router dependency, so it runs before authentication: a disabled
# instance answers 404 instead of turning a probe into a 401.
router = APIRouter(dependencies=[Depends(_require_enabled)])

CONTENT_TYPE_EXTENSIONS = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heic",
}
EXTENSION_MEDIA_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".heic": "image/heic",
}


def _storage_dir() -> Path:
    return Path(os.getenv("CAPTURE_LAB_DIR", "/app/data/capture-lab"))


def _safe_slug(label: str | None) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (label or "").lower()).strip("-")
    return (slug[:40].strip("-") or "capture")


def _extension_for(upload: UploadFile) -> str:
    content_type = (upload.content_type or "").split(";")[0].strip().lower()
    if content_type in CONTENT_TYPE_EXTENSIONS:
        return CONTENT_TYPE_EXTENSIONS[content_type]
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix in EXTENSION_MEDIA_TYPES:
        return suffix
    raise HTTPException(
        status_code=400,
        detail="Unsupported image type; expected JPEG, PNG, WebP or HEIC.",
    )


def _image_size(data: bytes) -> tuple[int | None, int | None]:
    """Best-effort pixel size; unreadable or unsupported images record nulls."""
    try:
        with Image.open(io.BytesIO(data)) as image:
            return image.size
    except Exception:
        return None, None


def _thumbnail_data_url(path: Path) -> str | None:
    """A small JPEG data URL for the browser grid, or None if unreadable."""
    try:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((360, 360))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=70)
        encoded = base64.b64encode(output.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"
    except Exception:
        return None


def _media_path(directory: Path, name: str) -> Path:
    """Resolve a stored name without allowing it to escape the directory."""
    if not name or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid capture name")
    path = directory / name
    return path


@limiter.exempt
@router.post("/capture")
async def upload_capture(
    user: User = Depends(get_current_user),
    file: UploadFile = File(...),
    condition: str | None = Form(None),
    card_label: str | None = Form(None),
    route: str | None = Form(None),
    track_settings: str | None = Form(None),
    note: str | None = Form(None),
):
    """Store one upload byte-for-byte with its capture metadata."""
    extension = _extension_for(file)
    data = await file.read(MAX_CAPTURE_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > MAX_CAPTURE_BYTES:
        raise HTTPException(400, "Capture is larger than the 20 MiB limit.")

    directory = _storage_dir()
    directory.mkdir(parents=True, exist_ok=True)

    created_at = datetime.datetime.now(datetime.timezone.utc)
    stem = (
        f"{created_at.strftime('%Y%m%dT%H%M%S%fZ')}-"
        f"{secrets.token_hex(3)}-{_safe_slug(card_label)}"
    )
    name = f"{stem}{extension}"
    path = directory / name
    path.write_bytes(data)

    width, height = _image_size(data)
    sidecar = {
        "name": name,
        "original_filename": file.filename,
        "content_type": file.content_type,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "width": width,
        "height": height,
        "created_at": created_at.isoformat(),
        "user_id": user.id,
        "condition": condition,
        "card_label": card_label,
        "route": route,
        "track_settings": track_settings,
        "note": note,
    }
    path.with_name(f"{name}.json").write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    return {**sidecar, "url": f"/api/dev/capture-lab/captures/{name}"}


@limiter.exempt
@router.get("/captures")
def list_captures(user: User = Depends(get_current_user)):
    """Newest first, at most 200 entries, with a JPEG thumbnail data URL."""
    directory = _storage_dir()
    entries = []
    if directory.is_dir():
        sidecars = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for sidecar_path in sidecars[:200]:
            try:
                sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            media_name = sidecar_path.name[: -len(".json")]
            media_path = directory / media_name
            if not media_path.is_file():
                continue
            sidecar["thumbnail"] = _thumbnail_data_url(media_path)
            entries.append(sidecar)
    return {"directory": str(directory.resolve()), "captures": entries}


@limiter.exempt
@router.get("/captures/{name}")
def download_capture(name: str, user: User = Depends(get_current_user)):
    """Serve the stored media type without re-encoding."""
    path = _media_path(_storage_dir(), name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Capture not found")
    media_type = EXTENSION_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media_type, filename=name)


@limiter.exempt
@router.delete("/captures/{name}")
def delete_capture(name: str, user: User = Depends(get_current_user)):
    """Delete a capture and its sidecar."""
    directory = _storage_dir()
    path = _media_path(directory, name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Capture not found")
    path.unlink()
    path.with_name(f"{name}.json").unlink(missing_ok=True)
    return {"deleted": name}


@limiter.exempt
@router.post("/captures/{name}/rotate")
def rotate_capture(name: str, user: User = Depends(get_current_user)):
    """Rotate a stored capture 180° in place, re-encoding it as JPEG."""
    directory = _storage_dir()
    path = _media_path(directory, name)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Capture not found")

    # The lab stores exact capture bytes; rotation is an explicit edit, so this
    # deliberately re-encodes and accepts a small fidelity loss.
    try:
        with Image.open(path) as image:
            rotated = image.transpose(Image.ROTATE_180)
            if rotated.mode not in ("RGB", "L"):
                rotated = rotated.convert("RGB")
            width, height = rotated.size
            output = io.BytesIO()
            rotated.save(output, format="JPEG", quality=92)
    except Exception:
        raise HTTPException(status_code=400, detail="The stored image could not be read.")
    data = output.getvalue()
    path.write_bytes(data)

    sidecar_path = path.with_name(f"{name}.json")
    try:
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        sidecar = {}
    sidecar.update({
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "width": width,
        "height": height,
        "rotated": True,
        "rotated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    if path.suffix.lower() not in {".jpg", ".jpeg"}:
        sidecar["rotated_note"] = "Re-encoded as JPEG; the filename keeps its original extension."
    sidecar_path.write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    return sidecar


def _diagnostics_dir() -> Path:
    return _storage_dir() / "diagnostics"


@limiter.exempt
@router.post("/diagnostics")
async def upload_diagnostics(request: Request, user: User = Depends(get_current_user)):
    """Store one client-side live-detection recording for offline reading."""
    raw = await request.body()
    if len(raw) > MAX_DIAGNOSTICS_BYTES:
        raise HTTPException(413, "Diagnostics payload is larger than the 8 MiB limit.")
    if not raw:
        raise HTTPException(400, "The diagnostics payload is empty.")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "The diagnostics payload is not valid JSON.")
    if not isinstance(payload, dict) or not isinstance(payload.get("samples"), list):
        raise HTTPException(400, "The diagnostics payload must contain a samples array.")

    directory = _diagnostics_dir()
    directory.mkdir(parents=True, exist_ok=True)
    created_at = datetime.datetime.now(datetime.timezone.utc)
    name = f"diag-{created_at.strftime('%Y%m%dT%H%M%S%fZ')}.json"
    path = directory / name
    text = json.dumps(payload, indent=2)
    path.write_text(text, encoding="utf-8")
    frames = sum(1 for sample in payload["samples"] if isinstance(sample, dict) and sample.get("frame"))
    return {
        "name": name,
        "bytes": len(text.encode("utf-8")),
        "samples": len(payload["samples"]),
        "frames": frames,
    }


@limiter.exempt
@router.get("/diagnostics")
def list_diagnostics(user: User = Depends(get_current_user)):
    """Newest first, at most 50 recordings."""
    directory = _diagnostics_dir()
    entries = []
    if directory.is_dir():
        paths = sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in paths[:50]:
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                samples = len(payload.get("samples", [])) if isinstance(payload, dict) else 0
                stat = path.stat()
            except (OSError, ValueError):
                continue
            entries.append({
                "name": path.name,
                "bytes": stat.st_size,
                "created_at": datetime.datetime.fromtimestamp(
                    stat.st_mtime, datetime.timezone.utc
                ).isoformat(),
                "samples": samples,
            })
    return {"diagnostics": entries}


@limiter.exempt
@router.get("/diagnostics/{name}")
def download_diagnostics(name: str, user: User = Depends(get_current_user)):
    """Serve one stored recording as JSON."""
    if not name.lower().endswith(".json"):
        raise HTTPException(400, "Invalid diagnostics name")
    path = _media_path(_diagnostics_dir(), name)
    if not path.is_file():
        raise HTTPException(404, "Diagnostics file not found")
    return FileResponse(path, media_type="application/json", filename=name)
