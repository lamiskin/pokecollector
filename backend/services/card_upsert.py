"""Shared card upsert helper."""

from __future__ import annotations

import datetime

from sqlalchemy.orm import Session

from models import Card, ImageCache, Set
from services.price_utils import preserve_existing_prices_for_invalid_update

# TCGdex's vintage Japanese sync data has a handful of garbled/mistranslated
# names (see the "TCGdex vintage JP data quality" investigation) that a full
# sync would otherwise silently re-write on every run. Corrected by manual
# cross-reference against Hareruya2's full print listing (by card number,
# since the stored name can't be trusted) — see docs/OWNED_JP_CARDS_PRICING.md.
KNOWN_NAME_OVERRIDES = {
    "VS1-041_ja": "ヤナギのラプラス",
}


def _apply_known_name_override(card_data: dict) -> None:
    override = KNOWN_NAME_OVERRIDES.get(card_data.get("id"))
    if override:
        card_data["name"] = override


def _apply_set_digital_flag(db: Session, card_data: dict) -> None:
    if card_data.get("is_digital") or not card_data.get("set_id"):
        return
    set_lang = card_data.get("lang") or "en"
    set_row = db.query(Set.is_digital).filter(
        Set.tcg_set_id == card_data["set_id"],
        Set.lang == set_lang,
    ).first()
    if set_row and set_row[0]:
        card_data["is_digital"] = True


def upsert_card(db: Session, card_data: dict) -> Card:
    """Insert or update a card row consistently across sync and API flows."""
    existing = db.query(Card).filter(Card.id == card_data["id"]).first()
    card_data["updated_at"] = datetime.datetime.utcnow()
    _apply_known_name_override(card_data)
    _apply_set_digital_flag(db, card_data)
    preserve_existing_prices_for_invalid_update(card_data, existing)
    has_api_image = bool(card_data.get("images_small") or card_data.get("images_large"))
    if existing:
        for key, value in card_data.items():
            if key != "id":
                setattr(existing, key, value)
        if has_api_image:
            existing.custom_image_url = None
            db.query(ImageCache).filter(ImageCache.image_key.in_([
                f"card:{existing.id}:small:custom",
                f"card:{existing.id}:large:custom",
            ])).delete(synchronize_session=False)
    else:
        existing = Card(**card_data)
        db.add(existing)
    return existing
