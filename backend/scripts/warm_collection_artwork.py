"""Warm the persistent card-artwork cache for the current collection.

The image proxy in ``api/images.py`` fills ``image_cache`` lazily, so the first
open of a card pays a multi-second TCGdex fetch. This script pre-fills the same
keys for every distinct catalogue card in the collection, using a bounded
thread pool, and skips anything already cached. Re-running is always safe: a
cached key is never fetched again and cards without a source URL are ignored.
"""

from __future__ import annotations

import argparse
import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

from sqlalchemy import or_

from database import SessionLocal
from models import Card, CollectionItem, ImageCache
from services.card_artwork import card_image_cache_key, get_or_fetch_card_image

logger = logging.getLogger(__name__)

_KEY_LOOKUP_CHUNK = 500


def _sizes(value: str) -> tuple[str, ...]:
    return ("large", "small") if value == "both" else (value,)


def _cached_keys(db, keys: list[str]) -> set[str]:
    cached: set[str] = set()
    for start in range(0, len(keys), _KEY_LOOKUP_CHUNK):
        chunk = keys[start:start + _KEY_LOOKUP_CHUNK]
        cached.update(
            row[0]
            for row in db.query(ImageCache.image_key).filter(ImageCache.image_key.in_(chunk)).all()
        )
    return cached


def _warm_images(card_id: str, images: list[tuple[str, str, str]]) -> tuple[int, int, int]:
    """Fetch and store one card's planned images in a session of its own."""
    db = SessionLocal()
    warmed = 0
    failed = 0
    byte_count = 0
    try:
        for size, url, key in images:
            try:
                data, _content_type = get_or_fetch_card_image(db, key, url)
                warmed += 1
                byte_count += len(data)
            except Exception as exc:
                failed += 1
                logger.warning("Could not warm %s artwork for %s: %s", size, card_id, exc)
                db.rollback()
    finally:
        db.close()
    return warmed, failed, byte_count


def main() -> int:
    parser = argparse.ArgumentParser(description="Warm the card-artwork image cache for the collection")
    parser.add_argument("--limit", type=int, default=0, help="maximum cards to consider (0 = all)")
    parser.add_argument("--concurrency", type=int, default=4, help="parallel fetches (default 4)")
    parser.add_argument("--size", choices=("large", "small", "both"), default="large")
    parser.add_argument("--dry-run", action="store_true", help="report planned work without fetching")
    args = parser.parse_args()

    sizes = _sizes(args.size)
    db = SessionLocal()
    try:
        owned_card_ids = [row[0] for row in db.query(CollectionItem.card_id).distinct().all()]
        cards = (
            db.query(Card)
            .filter(
                Card.id.in_(owned_card_ids),
                or_(Card.is_custom.is_(None), Card.is_custom.is_(False)),
            )
            .order_by(Card.id)
            .all()
        )
        if args.limit and args.limit > 0:
            cards = cards[:args.limit]

        slots: list[tuple[str, str, str | None]] = []
        for card in cards:
            for size in sizes:
                url = card.images_large if size == "large" else card.images_small
                slots.append((card.id, size, url))
        all_keys = [
            card_image_cache_key(card_id, size, url)
            for card_id, size, url in slots
            if url
        ]
        cached = _cached_keys(db, all_keys)
    finally:
        db.close()

    skipped = 0
    planned: dict[str, list[tuple[str, str, str]]] = {}
    for card_id, size, url in slots:
        if not url:
            skipped += 1
            continue
        key = card_image_cache_key(card_id, size, url)
        if key in cached:
            skipped += 1
            continue
        planned.setdefault(card_id, []).append((size, url, key))

    result = {
        "cards": len(cards),
        "warmed": 0,
        "skipped": skipped,
        "failed": 0,
        "bytes": 0,
    }
    if args.dry_run:
        result["would_warm"] = sum(len(images) for images in planned.values())
        print(json.dumps(result, indent=2))
        return 0

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = [
            pool.submit(_warm_images, card_id, images)
            for card_id, images in planned.items()
        ]
        for future in as_completed(futures):
            warmed, failed, byte_count = future.result()
            result["warmed"] += warmed
            result["failed"] += failed
            result["bytes"] += byte_count

    print(json.dumps(result, indent=2))
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
