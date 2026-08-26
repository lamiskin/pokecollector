VALID_PRICE_FIELDS = {"price_market", "price_trend", "price_avg1", "price_avg7", "price_avg30", "price_low"}
PRICE_PRIMARY_TO_FIELD = {
    "market": "price_market",
    "avg": "price_market",
    "trend": "price_trend",
    "avg1": "price_avg1",
    "avg7": "price_avg7",
    "avg30": "price_avg30",
    "low": "price_low",
}
REVERSE_HOLO_VARIANTS = {"Reverse Holo"}
HOLO_FIELD_MAP = {
    "price_market": "price_market_holo",
    "price_trend": "price_trend_holo",
    "price_avg1": "price_avg1_holo",
    "price_avg7": "price_avg7_holo",
    "price_avg30": "price_avg30_holo",
    "price_low": "price_low_holo",
}


def normalize_price_field(price_field: str | None) -> str:
    if not price_field:
        return "price_trend"
    value = str(price_field)
    field = PRICE_PRIMARY_TO_FIELD.get(value, value)
    return field if field in VALID_PRICE_FIELDS else "price_trend"


def _positive_price(value) -> float | None:
    """Return a usable Cardmarket price, treating missing/zero values as unavailable."""
    if value is None:
        return None
    try:
        price = float(value)
    except (TypeError, ValueError):
        return None
    return price if price > 0 else None


def effective_market_price(card, variant=None, price_field: str | None = "price_trend") -> float:
    """Return the selected Cardmarket EUR price for a card.

    TCGdex/Cardmarket may report unavailable reverse-holo prices as 0 instead of null.
    The ``*-holo`` price fields represent Cardmarket's alternate/reverse listing,
    not every card whose printed finish is Holo. Treat zero values as missing so
    Reverse Holo can fall back to the selected base price instead of being valued
    at €0.

    Falls back to price_jpy_eur_equivalent (a personal, local-only Suruga-ya price,
    pre-converted to EUR at sync time — see the Card model) only when no
    Cardmarket/TCGPlayer price exists at all. This is the sole point where that
    JPY-derived value enters "the" price — never overwrites price_market/price_trend
    directly, so vintage JP cards' fuzzy print matching stays a last resort, not a
    silent substitute for real Cardmarket data.

    Falls back further still to manual_value_override — a hand-entered EUR estimate,
    personal/local-only — only when neither Cardmarket nor the JPY price exists.
    Absolute last resort, for cards no automated source has ever priced.
    """
    if not card:
        return 0

    def _last_resort() -> float:
        jpy = _positive_price(getattr(card, "price_jpy_eur_equivalent", None))
        if jpy is not None:
            return jpy
        return _positive_price(getattr(card, "manual_value_override", None)) or 0

    field = normalize_price_field(price_field)
    if variant in REVERSE_HOLO_VARIANTS:
        holo_field = HOLO_FIELD_MAP.get(field)
        for candidate in (
            getattr(card, holo_field, None) if holo_field else None,
            getattr(card, field, None),
            getattr(card, "price_market_holo", None),
            getattr(card, "price_market", None),
        ):
            price = _positive_price(candidate)
            if price is not None:
                return price
        return _last_resort()

    for candidate in (getattr(card, field, None), getattr(card, "price_market", None)):
        price = _positive_price(candidate)
        if price is not None:
            return price
    return _last_resort()
