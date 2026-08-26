"""Suruga-ya JPY pricing for owned Japanese cards.

Personal, local-only feature — not part of the upstream TCGdex sync. Suruga-ya
has no number/set key for pre-2002 (vintage "旧裏") prints, so matching relies
on the set's release date (which does exist locally, from TCGdex's own
`releaseDate` field) plus, when present, an explicit NNN/NNN print number for
modern cards. A listing that can't be tied to the card by one of those two
signals is skipped rather than guessed at — a wrong vintage-print match is
worse than no price at all.
"""

from __future__ import annotations

import datetime
import logging
import re
import time
from dataclasses import dataclass
from urllib.parse import quote

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

SEARCH_URL = "https://www.suruga-ya.jp/search"
VINTAGE_SUFFIX = "　旧裏"  # full-width space + "old back" — Suruga-ya's vintage-print filter term
REQUEST_DELAY_SECONDS = 1.5  # be a polite, low-volume crawler — this runs on ~dozens of cards, once a week
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

_RARITY_MARKER_RE = re.compile(r"\[([●◆★◇])\]")
_NUMBER_TOTAL_RE = re.compile(r"^(\d+)/(\d+)")
_YEN_RE = re.compile(r"￥\s*([\d,]+)")
_RELEASE_DATE_RE = re.compile(r"発売日[：:]\s*(\d{4})/(\d{2})/(\d{2})")


@dataclass
class SurugaYaCandidate:
    title: str
    rarity_marker: str | None
    is_holo: bool
    number: str | None
    total: str | None
    release_date: str | None  # normalized to YYYY-MM-DD, matching Set.release_date
    price_low: float | None
    price_high: float | None
    marketplace_price: float | None
    in_stock: bool
    product_url: str


def build_search_url(query: str) -> str:
    return f"{SEARCH_URL}?search_word={quote(query)}"


def _parse_yen(text: str | None) -> float | None:
    if not text:
        return None
    match = _YEN_RE.search(text)
    if not match:
        return None
    return float(match.group(1).replace(",", ""))


def parse_release_date(text: str | None) -> str | None:
    """'[発売日：1996/10/20]' -> '1996-10-20', matching the local Set.release_date format."""
    match = _RELEASE_DATE_RE.search(text or "")
    if not match:
        return None
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"


def parse_price_range(price_text: str | None) -> tuple[float | None, float | None]:
    """'中古：￥580 ～ ￥1,280 税込' / '中古：￥280 税込' / '品切れ' -> (low, high)."""
    if not price_text or "品切れ" in price_text:
        return None, None
    amounts = [float(a.replace(",", "")) for a in re.findall(r"￥\s*([\d,]+)", price_text)]
    if not amounts:
        return None, None
    if len(amounts) == 1:
        return amounts[0], amounts[0]
    return amounts[0], amounts[-1]


def build_candidate(
    *,
    title: str | None,
    release_date_line: str | None,
    price_text: str | None,
    marketplace_text: str | None,
    product_url: str,
) -> SurugaYaCandidate:
    title = (title or "").strip()
    rarity_match = _RARITY_MARKER_RE.search(title)
    rarity_marker = rarity_match.group(1) if rarity_match else None
    is_holo = "(キラ)" in title or rarity_marker == "★"

    number_total_match = _NUMBER_TOTAL_RE.match(title)
    number = number_total_match.group(1) if number_total_match else None
    total = number_total_match.group(2) if number_total_match else None

    price_low, price_high = parse_price_range(price_text)

    return SurugaYaCandidate(
        title=title,
        rarity_marker=rarity_marker,
        is_holo=is_holo,
        number=number,
        total=total,
        release_date=parse_release_date(release_date_line),
        price_low=price_low,
        price_high=price_high,
        marketplace_price=_parse_yen(marketplace_text),
        in_stock=price_low is not None,
        product_url=product_url,
    )


def select_best_match(
    candidates: list[SurugaYaCandidate],
    *,
    target_release_date: str | None = None,
    target_number: str | None = None,
    target_total: str | None = None,
    prefer_holo: bool = False,
) -> SurugaYaCandidate | None:
    """Pick the Suruga-ya listing that best represents the given local card.

    Two independent signals, tried in order of confidence:
    1. An exact NNN/NNN print number match — unambiguous when the title has
       one (modern cards). Wins outright, no other tie-break needed.
    2. An exact release-date match against the card's own set — the only
       signal available for vintage prints, which carry no number/set key on
       Suruga-ya at all. Among same-date candidates, prefer the one whose
       holo-ness (rarity marker / "(キラ)") agrees with the locally recorded
       variant, then prefer one that's actually in stock.

    Returns None rather than guessing when neither signal narrows it down —
    a wrong print match is worse than no price.
    """
    if not candidates:
        return None

    if target_number and target_total:
        number_matches = [
            c for c in candidates if c.number == target_number and c.total == target_total
        ]
        if len(number_matches) == 1:
            return number_matches[0]
        if len(number_matches) > 1:
            in_stock = [c for c in number_matches if c.in_stock]
            return (in_stock or number_matches)[0]

    if not target_release_date:
        return None

    dated = [c for c in candidates if c.release_date == target_release_date]
    if not dated:
        return None
    if len(dated) == 1:
        return dated[0]

    holo_matches = [c for c in dated if c.is_holo == prefer_holo]
    pool = holo_matches or dated
    in_stock = [c for c in pool if c.in_stock]
    return (in_stock or pool)[0]


def fetch_candidates(page, query: str) -> list[SurugaYaCandidate]:
    """Fetch and parse Suruga-ya search results for one query string. Playwright I/O only —
    all actual parsing goes through build_candidate() so it stays unit-testable without a browser.
    """
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    page.goto(build_search_url(query), timeout=20000)
    try:
        page.wait_for_selector(".item", timeout=15000)
    except PlaywrightTimeoutError:
        return []

    candidates = []
    for item in page.query_selector_all(".item"):
        title_el = item.query_selector("h3.product-name")
        if not title_el:
            continue
        title = title_el.inner_text()

        release_el = item.query_selector(".release_date")
        release_date_line = release_el.inner_text() if release_el else None

        price_el = item.query_selector(".price_teika")
        price_text = price_el.inner_text() if price_el else None
        if not price_text:
            stock_el = item.query_selector(".item_price .price")
            price_text = stock_el.inner_text() if stock_el else None

        marketplace_el = item.query_selector(".makeplaTit .text-red strong")
        marketplace_text = marketplace_el.inner_text() if marketplace_el else None

        link_el = item.query_selector(".title a")
        href = link_el.get_attribute("href") if link_el else None
        product_url = ""
        if href:
            product_url = href if href.startswith("http") else f"https://www.suruga-ya.jp{href}"

        candidates.append(
            build_candidate(
                title=title,
                release_date_line=release_date_line,
                price_text=price_text,
                marketplace_text=marketplace_text,
                product_url=product_url,
            )
        )
    return candidates


def sync_jp_prices_for_collection(db: Session) -> dict:
    """Fetch Suruga-ya prices for every distinct Japanese card actually in the collection.

    Scope is deliberately owned-cards-only, re-derived from the collection table each
    run (not a fixed list) — see feedback_collection_vs_catalog_scope for why "all our
    cards" means owned, not the full synced catalogue.
    """
    from models import Card, CollectionItem, Set
    from playwright.sync_api import sync_playwright

    card_ids = [
        row[0]
        for row in (
            db.query(CollectionItem.card_id)
            .join(Card, Card.id == CollectionItem.card_id)
            .filter(Card.lang == "ja")
            .distinct()
            .all()
        )
    ]
    cards = db.query(Card).filter(Card.id.in_(card_ids)).all() if card_ids else []

    attempted = 0
    updated = 0
    no_match = 0
    failed = 0

    if not cards:
        return {"attempted": 0, "updated": 0, "no_match": 0, "failed": 0}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page(user_agent=USER_AGENT)
        try:
            for card in cards:
                attempted += 1
                try:
                    set_row = (
                        db.query(Set)
                        .filter(Set.tcg_set_id == card.set_id, Set.lang == "ja")
                        .first()
                    )
                    target_release_date = set_row.release_date if set_row else None
                    target_total = str(set_row.printed_total) if set_row and set_row.printed_total else None

                    collection_row = (
                        db.query(CollectionItem).filter(CollectionItem.card_id == card.id).first()
                    )
                    prefer_holo = bool(
                        collection_row and collection_row.variant in ("Holo", "Reverse Holo")
                    )

                    candidates = fetch_candidates(page, f"{card.name}{VINTAGE_SUFFIX}")
                    if not candidates:
                        candidates = fetch_candidates(page, card.name)

                    best = select_best_match(
                        candidates,
                        target_release_date=target_release_date,
                        target_number=card.number,
                        target_total=target_total,
                        prefer_holo=prefer_holo,
                    )

                    if best is None:
                        no_match += 1
                        time.sleep(REQUEST_DELAY_SECONDS)
                        continue

                    card.price_jpy_low = best.price_low
                    card.price_jpy_high = best.price_high
                    card.price_jpy_marketplace = best.marketplace_price
                    card.price_jpy_variant = "holo" if best.is_holo else "normal"
                    card.price_jpy_match_note = f"{best.title} ({best.release_date or 'date unknown'})"
                    card.price_jpy_source_url = best.product_url
                    card.price_jpy_updated_at = datetime.datetime.utcnow()
                    db.commit()
                    updated += 1
                except Exception:
                    logger.exception("Suruga-ya price fetch failed for card %s", card.id)
                    db.rollback()
                    failed += 1
                time.sleep(REQUEST_DELAY_SECONDS)
        finally:
            browser.close()

    return {"attempted": attempted, "updated": updated, "no_match": no_match, "failed": failed}
