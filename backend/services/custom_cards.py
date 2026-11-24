"""Shared construction rules for user-created (custom) cards.

``POST /api/cards/custom`` and the scan review's create-custom path must agree
on how a manual card is stored: a collision-safe id, free-text set fields, a
stub ``Set`` row when the catalogue does not know the set yet, and the manual
image kept in both TCGdex image columns.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import uuid4

from sqlalchemy.orm import Session

from models import Card, Set, User, UserSetting
from services.image_url_security import validate_public_https_image_url
from services.tcgdex_languages import is_supported_tcgdex_language, normalize_tcgdex_language

DEFAULT_CUSTOM_CARD_LANG = "en"


def _user_catalogue_language(db: Session, user_id: int | None) -> str | None:
    """The user's own catalogue language, if they have chosen a supported one."""
    if user_id is None:
        return None
    row = (
        db.query(UserSetting)
        .filter(UserSetting.user_id == user_id, UserSetting.key == "language")
        .first()
    )
    if not row or not row.value:
        return None
    language = normalize_tcgdex_language(row.value)
    return language if is_supported_tcgdex_language(language) else None


def find_set_for_free_text_id(
    db: Session,
    set_id: str,
    *,
    user_id: int | None = None,
) -> Set | None:
    """Resolve a custom card's free-text set against the catalogue.

    A set exists once per language, so an unordered first row could silently
    pick a printing the user does not read. Resolve deliberately: the user's own
    language, then English, then a deterministic row.
    """
    rows = (
        db.query(Set)
        .filter((Set.tcg_set_id == set_id) | (Set.id == set_id))
        .order_by(Set.lang.asc(), Set.id.asc())
        .all()
    )
    if not rows:
        return None

    by_language: dict[str, Set] = {}
    for row in rows:
        if row.lang and row.lang not in by_language:
            by_language[row.lang] = row
    for language in (_user_catalogue_language(db, user_id), DEFAULT_CUSTOM_CARD_LANG):
        if language and language in by_language:
            return by_language[language]
    return next((row for row in rows if row.lang), rows[0])


def stage_custom_card(
    db: Session,
    user: User,
    *,
    name: str,
    set_id: str | None = None,
    set_name: str | None = None,
    number: str | None = None,
    rarity: str | None = None,
    types: Sequence[str] | None = None,
    hp: str | None = None,
    artist: str | None = None,
    image_url: str | None = None,
    lang: str | None = None,
    is_shared_template: bool = False,
) -> Card:
    """Add a new custom ``Card`` row to the session without committing.

    The manual image goes to ``images_small``/``images_large`` (unchanged, not
    TCGdex art) and must be a public HTTPS URL; an unsafe URL raises
    ``ValueError`` so each caller can choose its own HTTP mapping. ``set_name``
    only names a stub set the caller created for an unknown free-text set id.
    """
    card_id = f"custom-{uuid4().hex}"
    manual_image = (image_url or "").strip()
    if manual_image:
        manual_image = validate_public_https_image_url(manual_image)

    set_id = set_id or None
    existing_set = find_set_for_free_text_id(db, set_id, user_id=user.id) if set_id else None

    # Derive language from the set if not explicitly provided
    card_lang = lang
    if not card_lang and existing_set:
        card_lang = existing_set.lang
    card_lang = card_lang or DEFAULT_CUSTOM_CARD_LANG

    # Ensure set record exists if set_id given
    if set_id and existing_set is None:
        db.add(Set(
            id=set_id,
            name=(set_name or "").strip() or set_id,
            total=0,
            tcg_set_id=set_id,
            lang=card_lang,
        ))

    card = Card(
        id=card_id,
        name=name,
        set_id=set_id,
        number=number or None,
        rarity=rarity or None,
        types=list(types) if types else None,
        hp=hp or None,
        artist=artist or None,
        images_small=manual_image or None,
        images_large=manual_image or None,
        is_custom=True,
        custom_owner_id=user.id,
        is_shared_template=is_shared_template,
        lang=card_lang,
    )
    db.add(card)
    db.flush()
    return card
