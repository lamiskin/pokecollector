"""Catalogue card artwork cache helpers.

The image proxy in ``api/images.py`` serves card art from the ``image_cache``
table and only reaches out to TCGdex on a miss. A miss currently costs seconds
per image, so the collection can pre-fill its artwork once and keep it warm.

This module owns the cache key format (diagnostics depend on it), the shared
sync fetch-and-store path, and a best-effort warmer that is safe to run from a
FastAPI background task after the request session has closed.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Iterable, Optional

import httpx
from sqlalchemy.orm import Session

from database import SessionLocal
from models import Card, ImageCache

logger = logging.getLogger(__name__)

# Same client semantics the image proxy used before this helper was extracted.
_client = httpx.Client(timeout=15, follow_redirects=True)

_SIZE_FIELDS = {
    "large": "images_large",
    "small": "images_small",
}


class CardArtworkError(Exception):
    """Raised when catalogue artwork cannot be fetched from upstream."""


def card_image_cache_key(card_id: str, size: str, url: str) -> str:
    """Stable ``image_cache`` key for one catalogue card image.

    The source URL is hashed into the key so a corrected URL busts the entry
    instead of reusing bytes fetched for the old artwork.
    """
    return f"card:{card_id}:{size}:{hashlib.sha1(url.encode()).hexdigest()}"


def get_or_fetch_card_image(
    db: Session,
    key: str,
    url: str,
    *,
    client: Optional[httpx.Client] = None,
) -> tuple[bytes, str]:
    """Return cached artwork, fetching and storing it on a miss.

    Mirrors the historical ``api.images._get_or_fetch`` behavior: a commit race
    rolls back and re-reads the winning row, and upstream failures raise
    :class:`CardArtworkError` rather than an HTTP error so non-request callers
    (background tasks, scripts) do not have to deal with transport concerns.
    """
    cached = db.query(ImageCache).filter(ImageCache.image_key == key).first()
    if cached:
        return cached.data, cached.content_type

    try:
        resp = (client or _client).get(url)
        resp.raise_for_status()
    except Exception as exc:
        raise CardArtworkError("Failed to fetch image from upstream") from exc

    content_type = resp.headers.get("content-type", "image/webp")
    entry = ImageCache(image_key=key, data=resp.content, content_type=content_type)
    db.add(entry)
    try:
        db.commit()
    except Exception:
        db.rollback()
        cached = db.query(ImageCache).filter(ImageCache.image_key == key).first()
        if cached:
            return cached.data, cached.content_type
        raise

    return resp.content, content_type


def _card_image_url(card: Card, size: str) -> Optional[str]:
    field = _SIZE_FIELDS.get(size)
    if field is None:
        return None
    return getattr(card, field, None)


def warm_card_artwork(
    card_id: str,
    *,
    sizes: Iterable[str] = ("large",),
    db: Optional[Session] = None,
) -> bool:
    """Fetch and cache one card's artwork if it is missing.

    Never raises: failures are logged and reported as ``False``. When no
    session is passed it opens (and closes) its own ``SessionLocal``, which is
    what makes it safe as a FastAPI background task after the request session
    is gone. Re-running is cheap because cached keys are skipped.
    """
    owns_session = db is None
    session = db or SessionLocal()
    warmed = False
    try:
        card = session.query(Card).filter(Card.id == card_id).first()
        if card is None:
            logger.debug("Artwork warm skipped missing card %s", card_id)
            return False
        if getattr(card, "is_custom", False):
            logger.debug("Artwork warm skipped custom card %s", card_id)
            return False

        for size in sizes:
            url = _card_image_url(card, size)
            if not url:
                continue
            key = card_image_cache_key(card.id, size, url)
            if session.query(ImageCache.id).filter(ImageCache.image_key == key).first():
                continue
            try:
                get_or_fetch_card_image(session, key, url)
                warmed = True
            except Exception:
                logger.warning(
                    "Could not warm %s artwork for card %s", size, card_id, exc_info=True
                )
        return warmed
    except Exception:
        logger.warning("Could not warm artwork for card %s", card_id, exc_info=True)
        try:
            session.rollback()
        except Exception:
            pass
        return False
    finally:
        if owns_session:
            session.close()
