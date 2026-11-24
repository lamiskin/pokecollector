"""Physical pockets overlay reserved binder quantities; the tray is a subtraction.

All writes take the existing user-allocation lock first. Revisions combine a
monotonic layout counter and the membership/inventory snapshot, so gallery edits
also invalidate pending moves and undo without requiring a second inventory model.
"""
import datetime
import hashlib
import json
import uuid
from collections import Counter

from fastapi import HTTPException
from sqlalchemy.orm import joinedload

from models import Binder, BinderCard, BinderPlacement, CollectionCardPhoto, CollectionItem, User
from services.binder_allocations import (
    collection_binder_allocation_counts, lock_user_card_allocations, stored_binder_quantity,
)
from services.product_sources import product_sources_by_collection_item


def owned_binder(db, user_id, binder_id, *, write=False):
    if write:
        lock_user_card_allocations(db, user_id)
    query = db.query(Binder).filter(Binder.id == binder_id, Binder.user_id == user_id)
    if write:
        query = query.populate_existing().with_for_update(of=Binder)
    binder = query.first()
    if not binder:
        raise HTTPException(404, "Binder not found")
    if (binder.binder_type or "collection") != "collection":
        raise HTTPException(409, "Physical layouts are available only for collection binders")
    return binder


def layout_metadata(binder):
    return ({"page_count": binder.layout_pages, "rows": binder.layout_rows, "columns": binder.layout_columns,
             "first_page_single": bool(binder.layout_first_page_single)}
            if binder.layout_pages is not None else None)


def _entries(db, binder):
    return db.query(BinderCard).options(
        joinedload(BinderCard.card), joinedload(BinderCard.collection_item),
    ).filter(BinderCard.binder_id == binder.id).order_by(BinderCard.id).populate_existing().all()


def _placements(db, binder):
    return db.query(BinderPlacement).filter(BinderPlacement.binder_id == binder.id).order_by(
        BinderPlacement.page, BinderPlacement.slot,
    ).populate_existing().all()


def _placement_dict(p, entries):
    return {"id": p.id, "binder_card_id": p.binder_card_id,
            "card_id": entries[p.binder_card_id].card_id, "page": p.page, "slot": p.slot}


def _snapshot(binder, entries, placements):
    by_id = {entry.id: entry for entry in entries}
    return {
        "layout": layout_metadata(binder),
        "placements": [_placement_dict(p, by_id) for p in placements],
        "memberships": [{"id": e.id, "card_id": e.card_id, "collection_item_id": e.collection_item_id,
                         "quantity": stored_binder_quantity(e.required_quantity),
                         "owned_quantity": e.collection_item.quantity if e.collection_item else None,
                         "owned_card_id": e.collection_item.card_id if e.collection_item else None,
                         "owned_user_id": e.collection_item.user_id if e.collection_item else None}
                        for e in entries],
    }


def _revision(binder, snapshot):
    value = {"counter": binder.layout_revision or 0, **snapshot}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _owner_scan_photo_card_ids(db, user_id, card_ids):
    """Owner photo presence per card, selecting only the key to avoid loading bytes."""
    values = [card_id for card_id in card_ids if card_id]
    if not values:
        return set()
    with_photos = set()
    for start in range(0, len(values), 500):
        rows = db.query(CollectionCardPhoto.card_id).filter(
            CollectionCardPhoto.user_id == user_id,
            CollectionCardPhoto.card_id.in_(values[start:start + 500]),
        ).all()
        with_photos.update(row[0] for row in rows)
    return with_photos


def layout_state(db, binder, *, public=False):
    entries = _entries(db, binder)
    placements = _placements(db, binder)
    counts = Counter(p.binder_card_id for p in placements)
    by_id = {entry.id: entry for entry in entries}
    scan_photos = (set() if public
                   else _owner_scan_photo_card_ids(db, binder.user_id, [entry.card_id for entry in entries]))
    payload = {"binder_id": binder.id, "layout": layout_metadata(binder),
               "placements": [_placement_dict(p, by_id) for p in placements], "entries": []}
    for entry in entries:
        card, item = entry.card, entry.collection_item
        resolved = bool(item and item.user_id == binder.user_id and item.card_id == entry.card_id)
        quantity = stored_binder_quantity(entry.required_quantity)
        row = {"binder_card_id": entry.id, "card_id": entry.card_id,
               "name": card.name if card else entry.card_id,
               "quantity": quantity, "unplaced_quantity": quantity - counts[entry.id],
               # Catalogue identity only (already visible in public image URLs); the
               # pocket needs it to resolve the same foil/effect map as elsewhere.
               "tcg_card_id": card.tcg_card_id if card else None,
               "lang": card.lang if card else None, "unresolved": not resolved}
        if public:
            # Never serialize collection ids, conditions, purchase data, scan
            # photos, or raw private/custom image URLs into the shared surface.
            from services.public_profile import _public_card_image_url
            image = _public_card_image_url(entry.card_id)
            row.update(images_small=image, images_large=image)
        else:
            row.update(images_small=card.images_small if card else None,
                       images_large=card.images_large if card else None,
                       collection_item_id=item.id if resolved else None,
                       # Private only: what the owner still owns, so the workspace can
                       # offer "remove this copy from the collection too".
                       owned_quantity=int(item.quantity or 0) if resolved else None,
                       variant=item.variant if resolved else None,
                       condition=item.condition if resolved else None,
                       has_scan_photo=entry.card_id in scan_photos)
        payload["entries"].append(row)
    payload["placed_count"] = len(placements)
    payload["unplaced_count"] = sum(e["unplaced_quantity"] for e in payload["entries"])
    if not public:
        revision = _revision(binder, _snapshot(binder, entries, placements))
        payload.update(revision=revision, can_undo=bool(binder.layout_undo and binder.layout_undo.get("expected") == revision))
    return payload


def _check_revision(binder, snapshot, expected):
    if expected != _revision(binder, snapshot):
        raise HTTPException(409, "The binder changed. Refresh its locations and review the move before trying again.")


def _start_write(db, user_id, binder_id, expected):
    binder = owned_binder(db, user_id, binder_id, write=True)
    entries, placements = _entries(db, binder), _placements(db, binder)
    before = _snapshot(binder, entries, placements)
    _check_revision(binder, before, expected)
    return binder, entries, placements, before


def _finish(db, binder, before):
    binder.layout_revision = (binder.layout_revision or 0) + 1
    binder.updated_at = datetime.datetime.utcnow()
    db.flush()
    # PostgreSQL also advances the counter for direct membership/placement
    # writes. Read the final trigger-updated value before issuing an undo token.
    db.refresh(binder)
    payload = layout_state(db, binder)
    binder.layout_undo = {"before": before, "expected": payload["revision"]}
    payload["can_undo"] = True
    db.commit()
    return payload


def _new_layout(request):
    return ({"page_count": request.page_count, "rows": request.rows, "columns": request.columns,
             "first_page_single": bool(request.first_page_single)}
            if request.page_count is not None else None)


def _affected(binder, placements, layout):
    geometry_changed = layout and (layout["rows"] != binder.layout_rows or layout["columns"] != binder.layout_columns)
    # Changing geometry returns every placed copy to the tray, even if its old
    # numeric slot would fit. Interpreting it under a new grid would renumber it.
    return [p for p in placements if not layout or geometry_changed or p.page > layout["page_count"]]


def preview_layout(db, binder, request):
    entries, placements = _entries(db, binder), _placements(db, binder)
    by_id = {e.id: e for e in entries}
    layout = _new_layout(request)
    affected = [{**_placement_dict(p, by_id), "name": by_id[p.binder_card_id].card.name}
                for p in _affected(binder, placements, layout)]
    return {"revision": _revision(binder, _snapshot(binder, entries, placements)), "layout": layout, "affected": affected}


def configure_layout(db, user_id, binder_id, request):
    binder, entries, placements, before = _start_write(db, user_id, binder_id, request.expected_revision)
    layout = _new_layout(request)
    affected = _affected(binder, placements, layout)
    if sorted(request.confirmed_unplace_ids) != sorted(p.id for p in affected):
        raise HTTPException(409, "Review the layout preview and confirm the exact copies returning to Not placed.")
    for p in affected:
        db.delete(p)
    binder.layout_pages = layout["page_count"] if layout else None
    binder.layout_rows = layout["rows"] if layout else None
    binder.layout_columns = layout["columns"] if layout else None
    binder.layout_first_page_single = layout["first_page_single"] if layout else False
    return _finish(db, binder, before)


def move_copy(db, user_id, binder_id, request):
    binder, entries, placements, before = _start_write(db, user_id, binder_id, request.expected_revision)
    if binder.layout_pages is None:
        raise HTTPException(409, "Enable a physical layout before placing copies")
    by_id = {e.id: e for e in entries}
    entry = by_id.get(request.binder_card_id)
    if not entry:
        raise HTTPException(404, "Binder entry not found")
    item = entry.collection_item
    if not item or item.user_id != user_id or item.card_id != entry.card_id:
        raise HTTPException(409, "Resolve this legacy entry: remove it from the binder, then add an exact owned collection item before placing it.")
    allocated = collection_binder_allocation_counts(db, user_id, [item.id]).get(item.id, 0)
    if allocated > int(item.quantity or 0):
        raise HTTPException(409, "This collection row is overallocated. Resolve its binder/deck quantities before placing copies.")
    source = next((p for p in placements if p.id == request.placement_id), None)
    if request.placement_id and (not source or source.binder_card_id != entry.id):
        raise HTTPException(409, "The selected copy moved or was removed. Refresh its location.")
    if source is None and sum(p.binder_card_id == entry.id for p in placements) >= stored_binder_quantity(entry.required_quantity):
        raise HTTPException(409, "No unplaced copy of this entry is available")
    returning = request.page is None and request.slot is None
    if (request.page is None) != (request.slot is None):
        raise HTTPException(422, "Page and slot must both be supplied, or both be null for Not placed")
    if returning:
        if not source:
            raise HTTPException(422, "Select a placed copy to return to Not placed")
        db.delete(source)
        return _finish(db, binder, before)
    if request.page is None or request.slot is None:
        raise HTTPException(422, "Choose a destination page and slot")
    if not (1 <= request.page <= binder.layout_pages and 1 <= request.slot <= binder.layout_rows * binder.layout_columns):
        raise HTTPException(422, "Destination is outside this binder's layout")
    occupant = next((p for p in placements if p.page == request.page and p.slot == request.slot), None)
    if source is not None and occupant is source:
        return layout_state(db, binder)
    if occupant and not request.confirm_occupied:
        raise HTTPException(409, "Confirm the occupied destination before swapping or returning its copy to Not placed")
    source_position = (source.page, source.slot) if source else None
    source_id = source.id if source else str(uuid.uuid4())
    displaced = (occupant.id, occupant.binder_card_id) if occupant else None
    # Delete+flush before recreating the two touched rows so swaps also work on
    # databases with immediate unique constraints. UUID identities remain stable.
    for p in (source, occupant):
        if p is not None:
            db.delete(p)
    db.flush()
    db.add(BinderPlacement(id=source_id, binder_id=binder.id, binder_card_id=entry.id,
                           page=request.page, slot=request.slot))
    if displaced and source_position:
        db.add(BinderPlacement(id=displaced[0], binder_id=binder.id, binder_card_id=displaced[1],
                               page=source_position[0], slot=source_position[1]))
    return _finish(db, binder, before)


def remove_copy(db, user_id, binder_id, request):
    """Remove one explicitly chosen copy from the binder, optionally with its owned copy.

    A removal deletes membership, which layout undo cannot restore (replaying the
    snapshot would reference a deleted binder_card_id), so the pending undo token
    is cleared instead of being replaced.
    """
    binder, entries, placements, _before = _start_write(db, user_id, binder_id, request.expected_revision)
    if binder.layout_pages is None:
        raise HTTPException(409, "Enable a physical layout before removing copies")
    entry = next((e for e in entries if e.id == request.binder_card_id), None)
    if not entry:
        raise HTTPException(404, "Binder entry not found")
    source = None
    if request.placement_id:
        source = next((p for p in placements if p.id == request.placement_id), None)
        if not source or source.binder_card_id != entry.id:
            raise HTTPException(409, "The selected copy moved or was removed. Refresh its location.")
    elif sum(p.binder_card_id == entry.id for p in placements) >= stored_binder_quantity(entry.required_quantity):
        raise HTTPException(409, "No unplaced copy of this entry is available")
    item = entry.collection_item
    resolved = bool(item and item.user_id == user_id and item.card_id == entry.card_id)
    quantity = stored_binder_quantity(entry.required_quantity)
    next_owned = None
    if request.remove_owned_copy:
        if not resolved:
            raise HTTPException(409, "Resolve this legacy entry: remove it from the binder, then add an exact owned collection item before placing it.")
        next_owned = int(item.quantity or 0) - 1
        if next_owned < 0:
            raise HTTPException(409, "This collection row has no copies left to remove. Nothing was changed.")
        if next_owned == 0:
            # The owned row can only go when this binder no longer reserves copies
            # of it; removing it under a surviving entry would orphan membership.
            if quantity > 1:
                raise HTTPException(409, "This binder reserves more copies than the collection row holds. Reduce the binder quantity first. Nothing was changed.")
            user = db.get(User, user_id)
            if product_sources_by_collection_item(db, user, [item.id]).get(item.id):
                raise HTTPException(409, "This collection copy is linked to a product. Sell or unlink it in the collection first. Nothing was changed.")
    if source is not None:
        db.delete(source)
        db.flush()
    if quantity <= 1:
        db.delete(entry)
        db.flush()
    else:
        entry.required_quantity = quantity - 1
    if request.remove_owned_copy:
        if next_owned:
            item.quantity = next_owned
        else:
            card_id = item.card_id
            db.delete(item)
            db.flush()
            # The photo is shared by every collection row for this owner and card;
            # drop it only when this was the final reference (see api.collection).
            remaining = db.query(CollectionItem.id).filter(
                CollectionItem.user_id == user_id, CollectionItem.card_id == card_id,
            ).first()
            if not remaining:
                db.query(CollectionCardPhoto).filter(
                    CollectionCardPhoto.user_id == user_id, CollectionCardPhoto.card_id == card_id,
                ).delete(synchronize_session=False)
    binder.layout_undo = None
    binder.layout_revision = (binder.layout_revision or 0) + 1
    binder.updated_at = datetime.datetime.utcnow()
    db.flush()
    db.refresh(binder)
    payload = layout_state(db, binder)
    db.commit()
    return payload


def undo_layout(db, user_id, binder_id, expected_revision):
    binder, entries, placements, current = _start_write(db, user_id, binder_id, expected_revision)
    undo = binder.layout_undo
    if not undo or undo.get("expected") != expected_revision:
        raise HTTPException(409, "Undo is no longer available because the binder changed. Nothing was overwritten.")
    before = undo["before"]
    layout = before["layout"]
    for p in placements:
        db.delete(p)
    db.flush()
    binder.layout_pages = layout["page_count"] if layout else None
    binder.layout_rows = layout["rows"] if layout else None
    binder.layout_columns = layout["columns"] if layout else None
    binder.layout_first_page_single = layout.get("first_page_single", False) if layout else False
    for p in before["placements"]:
        db.add(BinderPlacement(id=p["id"], binder_id=binder.id, binder_card_id=p["binder_card_id"], page=p["page"], slot=p["slot"]))
    binder.layout_revision = (binder.layout_revision or 0) + 1
    binder.layout_undo = None
    db.commit()
    return layout_state(db, binder)


def require_unplaced(db, entry_ids, *, retained_quantity=0):
    """Guard legacy membership edits: owner must choose copies to unplace first.

    No endpoint arbitrarily chooses physical copies on a quantity reduction,
    deletion, merge, printing switch or conversion. The workspace provides the
    explicit return-to-tray operation, after which the existing action can retry.
    """
    if not entry_ids:
        return
    rows = db.query(BinderPlacement).filter(BinderPlacement.binder_card_id.in_(list(entry_ids))).order_by(
        BinderPlacement.binder_id, BinderPlacement.page, BinderPlacement.slot,
    ).all()
    if len(rows) <= retained_quantity:
        return
    locations = "; ".join(f"binder {p.binder_id}, page {p.page}, slot {p.slot}" for p in rows)
    raise HTTPException(409, f"Placed copies would be affected: {locations}. Return the chosen copies to Not placed in the binder workspace first, then retry. Nothing was changed.")


def card_locations(db, user_id, card_id, *, collection_item_id=None, public=False):
    query = db.query(BinderCard, Binder).join(Binder, Binder.id == BinderCard.binder_id).filter(
        Binder.user_id == user_id, BinderCard.card_id == card_id,
        (Binder.binder_type == "collection") | Binder.binder_type.is_(None),
    )
    if collection_item_id is not None:
        query = query.filter(BinderCard.collection_item_id == collection_item_id)
    if public:
        query = query.filter(Binder.is_public.is_(True), Binder.binder_type == "collection")
    memberships = query.order_by(Binder.id, BinderCard.id).all()
    ids = [entry.id for entry, _binder in memberships]
    placements = db.query(BinderPlacement).filter(BinderPlacement.binder_card_id.in_(ids)).order_by(
        BinderPlacement.page, BinderPlacement.slot,
    ).all() if ids else []
    result = []
    for entry, binder in memberships:
        common = {"binder_id": binder.id, "binder_name": binder.name, "binder_card_id": entry.id, "card_id": entry.card_id}
        occupied = [p for p in placements if p.binder_card_id == entry.id]
        for p in occupied:
            result.append({**common, "placement_id": p.id, "page": p.page, "slot": p.slot, "quantity": 1})
        unplaced = stored_binder_quantity(entry.required_quantity) - len(occupied)
        if unplaced:
            result.append({**common, "placement_id": None, "page": None, "slot": None, "quantity": unplaced})
    return {"locations": result}
