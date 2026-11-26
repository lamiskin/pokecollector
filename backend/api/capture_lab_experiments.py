"""Capture-lab measurement experiments.

The collector runs measurement sweeps on a phone (thread caps, resolutions,
detector inputs, CV round trips) and posts each finished run here so it can be
read from the host-mounted capture-lab directory. Each request body is stored
verbatim as one JSON document beside the captures it describes.

Writes are bounded to 1 MiB, atomic (unique temp file plus rename) and mode
``0600``; the experiments directory is only created by the first write. Nothing
here serves a stored file back as a download, and nothing is rotated or
deleted automatically.

The routes share the capture lab's ``CAPTURE_LAB_ENABLED`` guard and login
dependency: a disabled instance answers 404 before authentication runs, so a
probe cannot tell a missing account from a hidden feature.
"""

from __future__ import annotations

import datetime
import json
import os
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from api.auth import get_current_user
from api.dev_capture_lab import _require_enabled, _storage_dir
from models import User
from services.rate_limit import limiter

router = APIRouter(dependencies=[Depends(_require_enabled)])

MAX_EXPERIMENT_BYTES = 1024 * 1024
NO_STORE = {"Cache-Control": "no-store"}


def _experiments_dir() -> Path:
    return _storage_dir() / "experiments"


def _write_atomically(path: Path, data: bytes) -> None:
    """Write one file through a unique mode-0600 temp file, then rename it."""
    temp = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        # ``os.open``'s mode is filtered by the umask; fchmod makes 0600 exact.
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temp.unlink()
        except OSError:
            pass
        raise


async def _read_bounded_body(request: Request) -> bytes:
    """Read the request body without buffering more than the size limit."""
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > MAX_EXPERIMENT_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="Experiment is larger than the 1 MiB limit.",
                    headers=NO_STORE,
                )
        except ValueError:
            pass

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_EXPERIMENT_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Experiment is larger than the 1 MiB limit.",
                headers=NO_STORE,
            )
    return bytes(body)


@limiter.exempt
@router.post("/experiments")
async def create_experiment(
    request: Request,
    user: User = Depends(get_current_user),
):
    """Store one posted experiment body as ``<UTC timestamp>-<8 hex>.json``.

    The posted object's keys and values are kept unchanged; the server adds
    ``receivedAt`` and the authenticated ``username`` (and is authoritative if
    the body used either key). The response is the filename stem.
    """
    raw = await _read_bounded_body(request)
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="The experiment body is not valid JSON.",
            headers=NO_STORE,
        )
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=422,
            detail="The experiment body must be a JSON object.",
            headers=NO_STORE,
        )

    received_at = datetime.datetime.now(datetime.timezone.utc)
    record = dict(payload)
    record["receivedAt"] = received_at.isoformat()
    record["username"] = user.username

    directory = _experiments_dir()
    directory.mkdir(parents=True, exist_ok=True)
    stem = f"{received_at.strftime('%Y%m%dT%H%M%S%fZ')}-{secrets.token_hex(4)}"
    path = directory / f"{stem}.json"
    _write_atomically(
        path, json.dumps(record, ensure_ascii=False, indent=2).encode("utf-8")
    )
    return {"id": stem}


@limiter.exempt
@router.get("/experiments")
def list_experiments(user: User = Depends(get_current_user)):
    """Metadata for every stored experiment, newest first.

    Only the fields the review needs are returned: ``page``, ``label`` and
    ``runs`` are read from the stored body when present and are null
    otherwise, so a partial sweep still lists without failing.
    """
    directory = _experiments_dir()
    entries = []
    if directory.is_dir():
        # The stem starts with the UTC receive time, so descending names are
        # newest first and stay stable when files are written in one burst.
        paths = sorted(directory.glob("*.json"), key=lambda path: path.name, reverse=True)
        for path in paths:
            try:
                stat = path.stat()
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(payload, dict):
                continue
            entries.append({
                "id": path.stem,
                "receivedAt": payload.get("receivedAt"),
                "page": payload.get("page"),
                "label": payload.get("label"),
                "runs": payload.get("runs"),
                "size": stat.st_size,
            })
    return JSONResponse(
        content={"total": len(entries), "experiments": entries},
        headers=NO_STORE,
    )
