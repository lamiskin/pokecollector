"""Set-level sweep for card artwork TCGdex publishes after a card was synced.

A full sync can only write the artwork that existed when it ran: a set's card
briefs carry no image URL (``/sets/{id}``), and the card catalogue refresh only
sees cards TCGdex already had. Art added later to an existing card therefore
never reached the database.

This module asks TCGdex for one set's full card list (``/cards?set=...``, one
request, image base URLs included) and fills only the cards whose artwork is
still missing locally. It never overwrites artwork that already exists, so it is
safe to run repeatedly alongside a normal sync. Sets are revisited on a backoff
schedule because most of them genuinely have no art to publish.
"""

from __future__ import annotations

import datetime
import logging
from typing import Iterable, Optional

from sqlalchemy import case, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import Card, CollectionItem, ImageCache, Set, Setting, WishlistItem
from services import pokemon_api
from services.card_visibility import sync_set_filter

logger = logging.getLogger(__name__)

# Days until a set is checked again, indexed by consecutive unsuccessful checks.
# A set that gains artwork is reset to the front of this schedule.
ARTWORK_BACKOFF_DAYS = (3, 7, 14, 30, 90)

DEFAULT_SWEEP_BATCH_SIZE = 40
SETTING_BATCH_SIZE = "artwork_sweep_batch_size"
SETTING_LAST_SWEEP_AT = "artwork_sweep_last_run_at"

_running = False


def _as_utc_naive(value: Optional[datetime.datetime]) -> Optional[datetime.datetime]:
    """Normalize a DB datetime to naive UTC so comparisons are portable."""
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return value


def _iso_z(value: Optional[datetime.datetime]) -> Optional[str]:
    value = _as_utc_naive(value)
    if value is None:
        return None
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _not_custom_card_filter():
    """Match catalogue cards only; legacy rows may have a NULL flag."""
    return or_(Card.is_custom.is_(None), Card.is_custom.is_(False))


def _missing_art_filter():
    return or_(Card.images_large.is_(None), Card.images_large == "")


def _tracked_card_filter():
    """Cards the user actually owns or wants; their sets are swept first."""
    collection_ids = select(CollectionItem.card_id).where(CollectionItem.card_id.isnot(None))
    wishlist_ids = select(WishlistItem.card_id).where(WishlistItem.card_id.isnot(None))
    return or_(Card.id.in_(collection_ids), Card.id.in_(wishlist_ids))


def _set_has_missing_art():
    """Correlated EXISTS: this set still has a catalogue card without art."""
    return (
        select(Card.id)
        .where(
            Card.set_id == Set.tcg_set_id,
            Card.lang == Set.lang,
            Card.tcg_card_id.isnot(None),
            _not_custom_card_filter(),
            _missing_art_filter(),
        )
        .exists()
    )


def _set_is_tracked():
    """Correlated EXISTS: a card of this set is in the collection or wishlist."""
    return (
        select(Card.id)
        .where(
            Card.set_id == Set.tcg_set_id,
            Card.lang == Set.lang,
            _tracked_card_filter(),
        )
        .exists()
    )


def _candidate_sets(db: Session, *, set_ids: Optional[Iterable[str]] = None) -> list[Set]:
    """Syncable sets that still have a card without artwork, in sweep order."""
    query = db.query(Set).filter(sync_set_filter(db), _set_has_missing_art())
    if set_ids:
        query = query.filter(Set.id.in_(list(set_ids)))
    return query.order_by(
        # Owned/wanted sets first, then never-checked sets, then oldest check.
        case((_set_is_tracked(), 0), else_=1),
        case((Set.artwork_checked_at.is_(None), 0), else_=1),
        Set.artwork_checked_at.asc(),
        Set.id.asc(),
    ).all()


def backoff_days(attempts: Optional[int]) -> int:
    """Days to wait after ``attempts`` consecutive unsuccessful checks."""
    try:
        index = int(attempts or 0)
    except (TypeError, ValueError):
        index = 0
    index = max(0, min(index, len(ARTWORK_BACKOFF_DAYS) - 1))
    return ARTWORK_BACKOFF_DAYS[index]


def is_set_due(set_obj: Set, *, now: Optional[datetime.datetime] = None) -> bool:
    """Whether a set's backoff has elapsed (never-checked sets are always due)."""
    checked_at = _as_utc_naive(set_obj.artwork_checked_at)
    if checked_at is None:
        return True
    current = _as_utc_naive(now) or datetime.datetime.utcnow()
    return checked_at + datetime.timedelta(days=backoff_days(set_obj.artwork_check_attempts)) <= current


def _apply_briefs(db: Session, set_obj: Set, briefs: list) -> int:
    """Write artwork for cards that have none. Returns how many were filled."""
    lang = set_obj.lang or "en"
    missing = (
        db.query(Card)
        .filter(
            Card.set_id == set_obj.tcg_set_id,
            Card.lang == lang,
            Card.tcg_card_id.isnot(None),
            _not_custom_card_filter(),
            # Artwork is written as a pair from one base URL, so only cards with
            # no artwork at all are filled. A card that already has either URL
            # is never rewritten.
            or_(Card.images_small.is_(None), Card.images_small == ""),
            _missing_art_filter(),
        )
        .all()
    )
    by_tcg_id = {card.tcg_card_id: card for card in missing}
    if not by_tcg_id:
        return 0

    updated = 0
    now = datetime.datetime.utcnow()
    for brief in briefs:
        if not isinstance(brief, dict):
            continue
        image = brief.get("image")
        tcg_card_id = brief.get("id")
        if not image or not tcg_card_id:
            continue
        card = by_tcg_id.get(tcg_card_id)
        if card is None:
            continue
        if card.images_small or card.images_large:
            continue

        card.images_small = f"{image}/low.webp"
        card.images_large = f"{image}/high.webp"
        card.image_source_lang = None
        card.custom_image_url = None
        card.updated_at = now
        db.query(ImageCache).filter(ImageCache.image_key.in_([
            f"card:{card.id}:small:custom",
            f"card:{card.id}:large:custom",
        ])).delete(synchronize_session=False)
        updated += 1
    return updated


def _record_check(db: Session, set_obj: Set, *, filled: bool) -> None:
    """Stamp the set's sweep bookkeeping; a successful fill resets the backoff."""
    attempts = set_obj.artwork_check_attempts or 0
    if filled:
        set_obj.artwork_check_attempts = 0
    else:
        try:
            set_obj.artwork_check_attempts = max(0, int(attempts)) + 1
        except (TypeError, ValueError):
            set_obj.artwork_check_attempts = 1
    set_obj.artwork_checked_at = datetime.datetime.utcnow()


def sweep_set(db: Session, set_obj: Set) -> dict:
    """Check one set for newly published artwork and commit the result.

    Never raises: a failed request is reported in the returned dict and only
    bumps that set's backoff, so one bad set cannot abort a sweep.
    """
    result = {"set_id": set_obj.id, "cards_updated": 0, "failed": False, "error": None}
    briefs: list = []
    if not set_obj.tcg_set_id:
        result.update(failed=True, error="set has no TCGdex id")
        logger.warning("Artwork sweep skipped set %s: no TCGdex id", set_obj.id)
    else:
        try:
            briefs = pokemon_api.get_set_card_briefs(set_obj.tcg_set_id, set_obj.lang or "en")
        except Exception as exc:  # network/API failure: back off, keep sweeping
            result["failed"] = True
            result["error"] = f"{type(exc).__name__}: {exc}"
            logger.warning("Artwork sweep could not fetch set %s: %s", set_obj.id, result["error"])

    if not result["failed"]:
        try:
            result["cards_updated"] = _apply_briefs(db, set_obj, briefs)
        except Exception as exc:  # never abort the sweep on one malformed set
            db.rollback()
            result.update(cards_updated=0, failed=True, error=f"{type(exc).__name__}: {exc}")
            logger.warning("Artwork sweep could not update set %s: %s", set_obj.id, result["error"])

    _record_check(
        db,
        set_obj,
        filled=result["cards_updated"] > 0,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        result.update(cards_updated=0, failed=True, error="integrity error while saving artwork")
        logger.warning("Artwork sweep rolled back set %s after an integrity error", set_obj.id)
    except Exception as exc:  # pragma: no cover - defensive
        db.rollback()
        result.update(
            cards_updated=0,
            failed=True,
            error=f"{type(exc).__name__}: {exc}",
        )
        logger.warning("Artwork sweep rolled back set %s: %s", set_obj.id, result["error"])
    return result


def _batch_size(db: Session) -> int:
    """Read the per-run batch size the way the scheduler reads its settings."""
    try:
        row = db.query(Setting).filter(Setting.key == SETTING_BATCH_SIZE).first()
        if row:
            return max(1, int(row.value))
    except (TypeError, ValueError):
        pass
    except Exception:  # pragma: no cover - settings table unavailable
        logger.warning("Could not read %s", SETTING_BATCH_SIZE, exc_info=True)
    return DEFAULT_SWEEP_BATCH_SIZE


def _record_sweep_finished(db: Session) -> None:
    try:
        row = db.query(Setting).filter(Setting.key == SETTING_LAST_SWEEP_AT).first()
        value = _iso_z(datetime.datetime.utcnow())
        if row:
            row.value = value
        else:
            db.add(Setting(key=SETTING_LAST_SWEEP_AT, value=value))
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("Could not record artwork sweep completion time", exc_info=True)


def is_sweep_running() -> bool:
    return _running


def run_artwork_sweep(
    db: Optional[Session] = None,
    *,
    limit: Optional[int] = None,
    set_ids: Optional[Iterable[str]] = None,
    force: bool = False,
) -> dict:
    """Sweep up to ``limit`` due sets, committing one set at a time.

    ``force`` ignores the backoff (a manual recheck). ``limit`` of 0 or less
    means "no limit"; ``None`` uses the ``artwork_sweep_batch_size`` setting.
    """
    global _running

    owns_session = db is None
    if owns_session:
        from database import SessionLocal

        db = SessionLocal()

    stats = {"sets_checked": 0, "sets_failed": 0, "cards_updated": 0, "remaining": 0}
    _running = True
    try:
        if limit is None:
            limit = _batch_size(db)

        now = datetime.datetime.utcnow()
        candidates = _candidate_sets(db, set_ids=set_ids)
        due = [set_obj for set_obj in candidates if force or is_set_due(set_obj, now=now)]
        selected = due if limit is None or limit <= 0 else due[:limit]
        stats["remaining"] = max(0, len(due) - len(selected))

        for set_obj in selected:
            stats["sets_checked"] += 1
            try:
                result = sweep_set(db, set_obj)
            except Exception:  # pragma: no cover - defensive; sweep_set catches its own
                db.rollback()
                logger.exception("Artwork sweep crashed on set %s", set_obj.id)
                stats["sets_failed"] += 1
                continue
            stats["cards_updated"] += result["cards_updated"]
            if result["failed"]:
                stats["sets_failed"] += 1

        _record_sweep_finished(db)
        return stats
    finally:
        _running = False
        if owns_session:
            db.close()


def _last_sweep_at(db: Session) -> Optional[str]:
    try:
        row = db.query(Setting).filter(Setting.key == SETTING_LAST_SWEEP_AT).first()
        if row and row.value:
            return str(row.value)
    except Exception:  # pragma: no cover - settings table unavailable
        logger.warning("Could not read %s", SETTING_LAST_SWEEP_AT, exc_info=True)
    newest = db.query(func.max(Set.artwork_checked_at)).scalar()
    return _iso_z(newest)


def artwork_status(db: Optional[Session] = None) -> dict:
    """Current artwork gap and sweep schedule, derived entirely from the DB."""
    owns_session = db is None
    if owns_session:
        from database import SessionLocal

        db = SessionLocal()
    try:
        now = datetime.datetime.utcnow()
        imageless_cards = (
            db.query(func.count(Card.id))
            .filter(
                Card.tcg_card_id.isnot(None),
                _not_custom_card_filter(),
                _missing_art_filter(),
            )
            .scalar()
            or 0
        )
        candidates = _candidate_sets(db)
        due = sum(1 for set_obj in candidates if is_set_due(set_obj, now=now))
        return {
            "imagelessCards": int(imageless_cards),
            "imagelessSets": len(candidates),
            "pendingSets": len(candidates) - due,
            "dueSets": due,
            "lastSweepAt": _last_sweep_at(db),
            "running": is_sweep_running(),
        }
    finally:
        if owns_session:
            db.close()
