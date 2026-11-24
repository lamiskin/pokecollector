"""Authenticated API for persistent background card-scan jobs."""

from __future__ import annotations

import datetime
import json
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.auth import get_current_user
from database import get_db
from models import Binder, BinderCard, CollectionItem, ScanJob, ScanJobItem, User
from schemas import CollectionItemCreate, CollectionItemResponse
from services.binder_allocations import (
    collection_item_available_quantity,
    lock_user_card_allocations,
    stored_binder_quantity,
)
from services.idempotency import (
    SCOPE_SCAN_ENQUEUE,
    begin_idempotent,
    check_expected_user,
    digest_uploads,
    fingerprint_json,
    has_idempotency_key,
    replay_response,
)
from services.scan_candidate_images import fetch_and_cache_candidate_image
from services.scan_queue import (
    drain_scan_queue,
    job_progress,
    resolve_scan_item,
    retry_scan_item,
)
from services.scan_storage import (
    ScanUploadError,
    create_scan_job,
    delete_scan_image,
    delete_job_directory,
    resolve_scan_path,
)

router = APIRouter()

# Card List types that hold exact owned copies and can be fed by a scan.
ALLOCATABLE_SCAN_BINDER_TYPES = frozenset({"collection", "physical_deck"})


class ResolveScanItemRequest(BaseModel):
    card_id: str | None = None


class ResolveAndAddScanItemRequest(CollectionItemCreate):
    confirmed_card_id: str


class ResolveAndAddScanItemResponse(BaseModel):
    item: dict
    collection_item: CollectionItemResponse
    binder_allocation: dict | None = None


class CreateCustomScanItemRequest(BaseModel):
    """Manual card details for a scan that matched nothing."""

    name: str
    set_id: str
    number: str | None = None
    set_name: str | None = None
    rarity: str | None = None
    image_url: str | None = None


class CreateCustomScanItemResponse(BaseModel):
    card: dict
    collection_item: CollectionItemResponse


def _binder_type(binder: Binder) -> str:
    # Legacy rows predate the column default and represent physical Binders.
    return binder.binder_type or "collection"


def _binder_payload(binder: Binder) -> dict:
    return {"id": binder.id, "name": binder.name, "binder_type": _binder_type(binder)}


def _job_payload(db: Session, job: ScanJob) -> dict:
    """Progress payload with the optional destination Card List attached."""
    binder = None
    if job.binder_id is not None:
        binder_row = db.query(Binder).filter(Binder.id == job.binder_id).first()
        if binder_row is not None:
            binder = _binder_payload(binder_row)
    return {**job_progress(db, job), "binder": binder}


def _get_scan_destination(db: Session, user: User, binder_id: int) -> Binder:
    """Validate the optional destination Card List chosen at enqueue time."""
    binder = (
        db.query(Binder)
        .filter(Binder.id == binder_id, Binder.user_id == user.id)
        .first()
    )
    if binder is None:
        raise HTTPException(status_code=404, detail="Card list not found.")
    if _binder_type(binder) not in ALLOCATABLE_SCAN_BINDER_TYPES:
        raise HTTPException(
            status_code=422,
            detail="Scanned cards can only be filed into a Binder or Real Deck.",
        )
    return binder


def _allocate_scan_item_to_binder(
    db: Session,
    user: User,
    binder_id: int | None,
    collection_item: CollectionItem,
    requested: int,
) -> dict | None:
    """Best-effort allocation of the copies just added into the job's list.

    Runs inside the caller's transaction, so the collection add still commits
    when the list was deleted or has no free copies. Capacity is capped by the
    item's remaining unallocated quantity and by the binder-card 1..99 range.
    """
    if binder_id is None:
        return None

    binder = (
        db.query(Binder)
        .filter(Binder.id == binder_id, Binder.user_id == user.id)
        .first()
    )
    allocation = {
        "binder_id": binder_id,
        "binder_name": None,
        "requested": requested,
        "allocated": 0,
        "reason": "list_unavailable",
    }
    if binder is None or _binder_type(binder) not in ALLOCATABLE_SCAN_BINDER_TYPES:
        return allocation

    allocation["binder_name"] = binder.name
    available = collection_item_available_quantity(db, user.id, collection_item)
    existing = db.query(BinderCard).filter(
        BinderCard.binder_id == binder.id,
        BinderCard.collection_item_id == collection_item.id,
    ).first()
    current_quantity = stored_binder_quantity(existing.required_quantity) if existing else 0
    allocated = max(min(requested, available, 99 - current_quantity), 0)

    if allocated > 0:
        if existing is not None:
            existing.required_quantity = current_quantity + allocated
        else:
            db.add(
                BinderCard(
                    binder_id=binder.id,
                    card_id=collection_item.card_id,
                    collection_item_id=collection_item.id,
                    required_quantity=allocated,
                    added_at=datetime.datetime.utcnow(),
                )
            )
        # A Real Deck keeps its planned requirement in step with the exact
        # copies it now owns, so it never reports unallocated demand.
        if _binder_type(binder) == "physical_deck":
            plan_entry = db.query(BinderCard).filter(
                BinderCard.binder_id == binder.id,
                BinderCard.card_id == collection_item.card_id,
                BinderCard.collection_item_id.is_(None),
            ).first()
            if plan_entry is not None:
                plan_entry.required_quantity = min(
                    stored_binder_quantity(plan_entry.required_quantity) + allocated,
                    99,
                )
            else:
                db.add(
                    BinderCard(
                        binder_id=binder.id,
                        card_id=collection_item.card_id,
                        collection_item_id=None,
                        required_quantity=min(allocated, 99),
                        added_at=datetime.datetime.utcnow(),
                    )
                )

    allocation["allocated"] = allocated
    if allocated >= requested:
        allocation["reason"] = None
    elif allocated > 0:
        allocation["reason"] = "partial"
    else:
        allocation["reason"] = "no_unallocated_copies"
    return allocation


def _get_own_job(db: Session, job_id: int, current_user: User) -> ScanJob:
    job = (
        db.query(ScanJob)
        .filter(ScanJob.id == job_id, ScanJob.user_id == current_user.id)
        .first()
    )
    if job is None:
        raise HTTPException(status_code=404, detail="Scan job not found.")
    return job


def _get_own_item(
    db: Session,
    job_id: int,
    item_id: int,
    current_user: User,
    *,
    for_update: bool = False,
) -> ScanJobItem:
    _get_own_job(db, job_id, current_user)
    query = (
        db.query(ScanJobItem)
        .filter(ScanJobItem.id == item_id, ScanJobItem.job_id == job_id)
    )
    if for_update:
        # A caller may have loaded this row for an authorization/integrity
        # precheck before waiting on the lock. Force the database's current
        # values back into SQLAlchemy's identity-map instance after the wait.
        query = query.with_for_update().populate_existing()
    item = query.first()
    if item is None:
        raise HTTPException(status_code=404, detail="Scan item not found.")
    return item


def _item_payload(item: ScanJobItem) -> dict:
    return {
        "id": item.id,
        "position": item.position,
        "batch_mode": item.batch_mode,
        "status": item.status,
        "resolved": item.resolved,
        "attempts": item.attempts,
        "transient_failures": item.transient_failures,
        "recognized": item.recognized,
        "matches": item.matches,
        "no_candidates": item.no_candidates,
        "recovery_hint": item.recovery_hint,
        "error": item.error,
        "has_image": bool(item.image_path),
        "next_attempt_at": (
            item.next_attempt_at.isoformat() if item.next_attempt_at else None
        ),
        "retry_reason": item.retry_reason,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


def _requested_individual_positions(raw: str | None, file_count: int) -> list[int]:
    """Parse and validate the client's "scan this photo on its own" selection."""
    try:
        requested_individual = json.loads(raw or "[]")
        if (
            not isinstance(requested_individual, list)
            or any(type(position) is not int for position in requested_individual)
            or len(set(requested_individual)) != len(requested_individual)
            or any(position < 0 or position >= file_count for position in requested_individual)
        ):
            raise ValueError
    except (TypeError, ValueError, json.JSONDecodeError):
        raise HTTPException(status_code=400, detail="Invalid individual scan selection.")
    return requested_individual


@router.post("/recognize/jobs")
async def enqueue_scan_job(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    individual_positions: str | None = Form(None),
    binder_id: str | None = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    request: Request = None,
):
    """Sanitize a batch, persist it, and return without waiting for its provider."""
    from services.scan_providers import (
        SCANNER_CAPABILITY_DEGRADED,
        get_provider,
        require_scanner_capability_mode,
    )

    headers = request.headers if request is not None else None
    check_expected_user(current_user, headers)
    # Validate the optional destination before any upload bytes are read or a
    # job row exists, so a rejected list leaves no trace.
    destination_id: int | None = None
    raw_binder_id = (binder_id or "").strip()
    if raw_binder_id:
        try:
            destination_id = int(raw_binder_id)
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid card list.")
        _get_scan_destination(db, current_user, destination_id)

    idem = None
    if has_idempotency_key(headers):
        # Keyed path: validate the selection, fingerprint the photos, and replay
        # before any provider/credential check so a retry after success never
        # fails because the user removed a key in the meantime.
        requested_individual = _requested_individual_positions(individual_positions, len(files))
        digests = await digest_uploads(files)
        idem = begin_idempotent(
            db, current_user, headers,
            scope=SCOPE_SCAN_ENQUEUE,
            # The destination Card List is part of this fork's request
            # identity: a retry must not replay a job created for another list.
            fingerprint=fingerprint_json(
                SCOPE_SCAN_ENQUEUE,
                {
                    "individual_positions": sorted(requested_individual),
                    "files": list(digests),
                    "binder_id": destination_id,
                },
            ),
        )
        if idem.replay is not None:
            return replay_response(idem.replay)

    provider = get_provider(db, current_user.id)
    capability_mode = require_scanner_capability_mode(
        db, current_user.id, provider.name, provider.model()
    )
    if provider.requires_credential() and not provider.credential(db, current_user.id):
        raise HTTPException(
            status_code=400,
            detail=provider.missing_credential_message(),
        )
    if idem is None:
        requested_individual = _requested_individual_positions(individual_positions, len(files))

    # A composite asks the model to read several cards out of one image, which
    # needs the same multi-image capability visual verification does. A model
    # that already failed that probe (or was saved in acknowledged limited
    # mode) cannot do this reliably either, so every photo goes through
    # individually regardless of what the client requested — the client's own
    # UI hides the toggle for the same reason, but the server does not trust
    # that alone.
    individual_set = set(requested_individual)
    batch_modes = [
        len(files) > 1
        and position not in individual_set
        and capability_mode != SCANNER_CAPABILITY_DEGRADED
        for position in range(len(files))
    ]
    before_commit = None
    if idem is not None and idem.active:
        def before_commit(job):
            # Record the same payload the caller returns, including the fork's
            # destination Card List, so a replay is indistinguishable.
            idem.record(db, 200, jsonable_encoder(_job_payload(db, job)))

    try:
        job = await create_scan_job(
            db,
            current_user.id,
            files,
            batch_modes=batch_modes,
            binder_id=destination_id,
            before_commit=before_commit,
        )
    except ScanUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    background_tasks.add_task(drain_scan_queue, max_items=len(files))
    return _job_payload(db, job)


@router.get("/recognize/jobs")
def list_scan_jobs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return active or actionable jobs for the current user's scan inbox."""
    jobs = (
        db.query(ScanJob)
        .join(ScanJobItem, ScanJobItem.job_id == ScanJob.id)
        .filter(
            ScanJob.user_id == current_user.id,
            ScanJobItem.resolved.is_(False),
        )
        .distinct()
        .order_by(ScanJob.created_at.desc())
        .limit(50)
        .all()
    )
    return {"jobs": [_job_payload(db, job) for job in jobs]}


@router.get("/recognize/jobs/{job_id}")
def get_scan_job(
    job_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Poll progress and read every item for review, resolved ones included.

    Resolved items are kept (not filtered out) so the review page can render
    them as a collapsed, already-handled row instead of them simply vanishing
    once the list refetches — the point of collapsing rather than removing is
    that a reviewer working through a long batch can still see what they just
    confirmed. `GET /recognize/jobs` is the separate "still needs attention"
    inbox listing and keeps filtering resolved items out of *that* count.
    """
    job = _get_own_job(db, job_id, current_user)
    items = (
        db.query(ScanJobItem)
        .filter(ScanJobItem.job_id == job.id)
        .order_by(ScanJobItem.position.asc())
        .all()
    )
    return {
        **_job_payload(db, job),
        "items": [_item_payload(item) for item in items],
    }


@router.get("/recognize/jobs/{job_id}/items/{item_id}/image")
def get_scan_job_item_image(
    job_id: int,
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _get_own_item(db, job_id, item_id, current_user)
    if not item.image_path:
        raise HTTPException(status_code=404, detail="Scan photo not found.")
    try:
        path = resolve_scan_path(item.image_path)
    except ScanUploadError:
        raise HTTPException(status_code=404, detail="Scan photo not found.")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Scan photo not found.")
    return FileResponse(path, media_type="image/jpeg", filename="scan.jpg")


@router.get("/recognize/jobs/{job_id}/items/{item_id}/candidates/{index}/image")
async def get_scan_candidate_image(
    job_id: int,
    item_id: int,
    index: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """A candidate's full-resolution scan, served from our own cache.

    Reviewing means comparing the photo against a candidate at full size, and
    proxying straight to the TCGdex asset CDN on every expand is slow enough
    to read as broken. `services.scan_candidate_images` pre-warms the top
    candidates during recognition, so this is usually a local cache read; a
    miss falls back to fetching (and caching) here.

    The URL is looked up from the item's own stored `matches`, never accepted
    from the caller — taking a client-supplied URL here would make this an
    open image-fetch proxy.
    """
    item = _get_own_item(db, job_id, item_id, current_user)
    matches = item.matches or []
    if not 0 <= index < len(matches):
        raise HTTPException(status_code=404, detail="Candidate image not found.")

    match = matches[index] if isinstance(matches[index], dict) else {}
    url = match.get("image_hd") or match.get("image")
    if not url:
        raise HTTPException(status_code=404, detail="Candidate image not found.")

    result = await fetch_and_cache_candidate_image(db, url)
    if result is None:
        raise HTTPException(status_code=502, detail="Could not load the candidate image.")
    data, content_type = result
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.post("/recognize/jobs/{job_id}/items/{item_id}/resolve")
def resolve_scan_job_item(
    job_id: int,
    item_id: int,
    data: ResolveScanItemRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _get_own_item(db, job_id, item_id, current_user, for_update=True)
    if item.resolved:
        raise HTTPException(status_code=409, detail="This scan has already been handled.")
    if item.status not in {"done", "failed"}:
        raise HTTPException(status_code=409, detail="This scan is still being processed.")
    card_id = str((data.card_id if data else "") or "").strip() or None
    if card_id:
        allowed_ids = {
            str(match.get("tcg_card_id") or "")
            for match in (item.matches or [])
            if isinstance(match, dict)
        }
        if card_id not in allowed_ids:
            raise HTTPException(status_code=422, detail="Confirmed card is not a scan candidate.")
        from services.scan_trace import record_ground_truth

        record_ground_truth(current_user.id, job_id, item_id, card_id)
    return _item_payload(resolve_scan_item(db, item))


@router.post(
    "/recognize/jobs/{job_id}/items/{item_id}/resolve-and-add",
    response_model=ResolveAndAddScanItemResponse,
)
def resolve_and_add_scan_job_item(
    job_id: int,
    item_id: int,
    data: ResolveAndAddScanItemRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Atomically add a reviewed card and mark its scan handled.

    Locking the scan row makes retries and concurrent tabs idempotent: only
    the first request can increment the collection quantity.
    """
    from api.collection import (
        _annotate_collection_item,
        _collection_item_language,
        _upsert_collection_item,
        ensure_card_exists,
    )
    from services import pokemon_api
    from services.scan_trace import record_ground_truth

    collection_data = CollectionItemCreate(**data.model_dump(exclude={"confirmed_card_id"}))
    confirmed_card_id = str(data.confirmed_card_id or "").strip()
    submitted_tcg_card_id, _ = pokemon_api.strip_lang_suffix(collection_data.card_id)

    def validate_review(row: ScanJobItem) -> None:
        if row.resolved:
            raise HTTPException(status_code=409, detail="This scan has already been handled.")
        if row.status != "done":
            raise HTTPException(status_code=409, detail="This scan is not ready to add.")
        allowed_ids = {
            str(match.get("tcg_card_id") or "")
            for match in (row.matches or [])
            if isinstance(match, dict)
        }
        if not confirmed_card_id or confirmed_card_id not in allowed_ids:
            raise HTTPException(status_code=422, detail="Confirmed card is not a scan candidate.")
        if submitted_tcg_card_id != confirmed_card_id:
            raise HTTPException(status_code=422, detail="Collection card does not match the confirmed candidate.")

    # Check authorization and request integrity before a missing catalogue
    # card is fetched or written.
    validate_review(_get_own_item(db, job_id, item_id, current_user))
    # A candidate normally already exists locally. If it does not, perform
    # the potentially committing catalogue import before taking the scan-row
    # lock; no commit may occur between that lock and the atomic final commit.
    if not collection_data.card_id.startswith("custom-"):
        item_lang = _collection_item_language(collection_data.card_id, collection_data.lang)
        tcg_card_id, _ = pokemon_api.strip_lang_suffix(collection_data.card_id)
        ensure_card_exists(db, f"{tcg_card_id}_{item_lang}", lang=item_lang)

    item = _get_own_item(db, job_id, item_id, current_user, for_update=True)
    # Revalidate under the row lock: another tab may have resolved it between
    # the harmless precheck and this transaction.
    validate_review(item)

    _status, collection_item = _upsert_collection_item(
        db,
        current_user,
        collection_data,
        ensure_catalogue_card=False,
    )
    # The upsert stages the collection change. Take the user allocation lock
    # before flushing, so the collection row is never locked ahead of it (the
    # documented ordering for every physical-list allocation), then flush and
    # re-read the current owned count.
    with db.no_autoflush:
        lock_user_card_allocations(db, current_user.id)
    db.flush()
    collection_item = (
        db.query(CollectionItem)
        .filter(
            CollectionItem.id == collection_item.id,
            CollectionItem.user_id == current_user.id,
        )
        .with_for_update()
        .populate_existing()
        .one()
    )
    binder_allocation = _allocate_scan_item_to_binder(
        db,
        current_user,
        item.job.binder_id,
        collection_item,
        int(collection_data.quantity or 1),
    )
    relative_path = item.image_path
    item.resolved = True
    item.image_path = None
    item.updated_at = datetime.datetime.utcnow()
    record_ground_truth(current_user.id, job_id, item_id, confirmed_card_id)
    db.commit()
    db.refresh(item)
    db.refresh(collection_item)
    delete_scan_image(relative_path)
    return {
        "item": _item_payload(item),
        "collection_item": _annotate_collection_item(db, current_user, collection_item),
        "binder_allocation": binder_allocation,
    }


@router.post(
    "/recognize/jobs/{job_id}/items/{item_id}/create-custom",
    response_model=CreateCustomScanItemResponse,
)
def create_custom_card_from_scan_item(
    job_id: int,
    item_id: int,
    data: CreateCustomScanItemRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a manual card from a scan that matched nothing and file one copy.

    The reviewer could otherwise only retry or search externally, so this turns
    the dead end into a one-step add. The scan photo is deliberately kept: the
    client attaches it to the collection as the owner's private photo.
    """
    from api.cards import _card_to_dict
    from api.collection import _annotate_collection_item, _upsert_collection_item
    from services.custom_cards import stage_custom_card

    def validate_review(row: ScanJobItem) -> None:
        if row.resolved:
            raise HTTPException(status_code=409, detail="This scan has already been handled.")
        if row.status not in {"done", "failed"}:
            raise HTTPException(status_code=409, detail="This scan is still being processed.")

    # Check authorization before the row lock is taken, then revalidate under
    # it so a concurrent tab cannot resolve the item twice.
    validate_review(_get_own_item(db, job_id, item_id, current_user))
    item = _get_own_item(db, job_id, item_id, current_user, for_update=True)
    validate_review(item)

    try:
        card = stage_custom_card(
            db,
            current_user,
            name=data.name,
            set_id=data.set_id,
            set_name=data.set_name,
            number=data.number,
            rarity=data.rarity,
            image_url=data.image_url,
        )
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    _status, collection_item = _upsert_collection_item(
        db,
        current_user,
        CollectionItemCreate(card_id=card.id),
        ensure_catalogue_card=False,
    )
    # The upsert stages the collection change. Take the user allocation lock
    # before flushing, so the collection row is never locked ahead of it (the
    # documented ordering for every physical-list allocation), then flush and
    # re-read the current owned count.
    with db.no_autoflush:
        lock_user_card_allocations(db, current_user.id)
    db.flush()
    collection_item = (
        db.query(CollectionItem)
        .filter(
            CollectionItem.id == collection_item.id,
            CollectionItem.user_id == current_user.id,
        )
        .with_for_update()
        .populate_existing()
        .one()
    )
    # File the copy into the job's destination list the same way a reviewed
    # resolve-and-add does, so a scan into a binder never needs a second add.
    # The allocation result is not part of this route's response shape.
    _allocate_scan_item_to_binder(
        db,
        current_user,
        item.job.binder_id,
        collection_item,
        1,
    )
    # There is no TCGdex id to record as ground truth, and the stored scan
    # photo stays available for the client's private-photo upload.
    item.resolved = True
    item.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(item)
    db.refresh(collection_item)
    db.refresh(card)
    return {
        "card": _card_to_dict(card, current_user.id),
        "collection_item": _annotate_collection_item(db, current_user, collection_item),
    }


@router.post("/recognize/jobs/{job_id}/items/{item_id}/retry")
async def retry_scan_job_item(
    job_id: int,
    item_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    item = _get_own_item(db, job_id, item_id, current_user)
    try:
        retry_scan_item(db, item)
    except (ValueError, ScanUploadError) as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    background_tasks.add_task(drain_scan_queue, max_items=1)
    return _item_payload(item)


@router.delete("/recognize/jobs/{job_id}")
def delete_scan_job(
    job_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = _get_own_job(db, job_id, current_user)
    db.delete(job)
    db.commit()
    delete_job_directory(job_id)
    return {"deleted": job_id}
