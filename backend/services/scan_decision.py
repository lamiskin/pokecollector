"""Calibrated confidence that the top candidate is the right card.

This is the "decision layer": instead of trusting a single rule (unique number,
unique candidate), it scores the structured evidence the scanner already holds and
returns a probability. It is deliberately dependency-free so it can run inside the
scan path.

The weights below were fitted offline on 76 labelled scans (48 in-catalogue
end-to-end + 28 real phone photos; 57 positive, 19 negative) with a numpy logistic
regression. Treat them as a starting calibration, not a finished model: they need
refitting once there are enough real scans to hold out a validation set.

The single most important feature is `number_matches`. The one failure this model
structurally cannot catch is a misread number that lands on a different real card —
every text feature looks correct there, which is why an independent artwork channel
is needed alongside it.
"""

from __future__ import annotations

import math
import unicodedata

# Fitted 2026-11-10 (see docs/scanner-evaluation.md). Standardisation then weights.
_MODEL = {
    "mean": [0.473684, 0.75, 4.486842, 0.921053, 0.605263, 0.644737, 0.362166,
             0.486842, 0.578947, 0.092105, 0.105263, 0.0, 0.052632],
    "scale": [0.499307, 0.433013, 3.318582, 0.269657, 0.488794, 0.478593, 0.467663,
              0.499827, 0.493728, 0.289174, 0.306892, 1.0, 0.223297],
    "coef": [-0.70553, -0.2493, -0.177322, 2.000962, -0.505689, -0.449534, 0.480847,
             4.059489, -0.196066, -1.5012, 2.03573, 0.0, 0.158895],
    "intercept": 2.070098,
    "features": [
        "set_valid", "set_edit1", "n_candidates", "has_top1", "name_exact",
        "name_subset", "name_lev", "number_matches", "number_in_set", "reg_match",
        "artist_match", "hp_match", "glyph_energy",
    ],
}

_ACCENTS = str.maketrans(
    {"ā": "a", "á": "a", "à": "a", "â": "a", "ä": "a", "å": "a", "ç": "c", "é": "e",
     "è": "e", "ê": "e", "ë": "e", "í": "i", "ì": "i", "î": "i", "ï": "i", "ñ": "n",
     "ó": "o", "ò": "o", "ô": "o", "ö": "o", "õ": "o", "ú": "u", "ù": "u", "û": "u",
     "ü": "u", "ÿ": "y"}
)


def _norm(value) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold().translate(_ACCENTS)
    return " ".join(text.split())


def _lev(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a or not b:
        return len(a) or len(b)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _digits(value) -> int | None:
    text = str(value or "").split("/")[0]
    out = "".join(ch for ch in text if ch.isdigit())
    return int(out) if out else None


def build_features(
    *,
    read: dict | None,
    candidates: list[dict] | None,
    known_set_codes: set[str] | None = None,
) -> dict[str, float]:
    """Turn the read plus the ranked candidates into the model's feature vector."""
    read = read or {}
    candidates = candidates or []
    top = candidates[0] if candidates else {}

    read_name = _norm(read.get("name") or read.get("name_en"))
    top_name = _norm(top.get("name"))
    read_set = _norm(read.get("set_code")).upper()
    codes = {_norm(c).upper() for c in (known_set_codes or set())}

    features = {
        "set_valid": 0.0,
        "set_edit1": 0.0,
        "n_candidates": float(len(candidates)),
        "has_top1": 0.0 if not candidates else 1.0,
    }
    if read_set and codes:
        features["set_valid"] = 1.0 if read_set in codes else 0.0
        features["set_edit1"] = 1.0 if any(_lev(read_set, c) <= 1 for c in codes) else 0.0

    if top:
        features["name_exact"] = 1.0 if read_name and read_name == top_name else 0.0
        tokens = read_name.split()
        features["name_subset"] = (
            1.0 if tokens and all(tok in top_name for tok in tokens) else 0.0
        )
        denom = max(1, len(read_name), len(top_name))
        features["name_lev"] = _lev(read_name, top_name) / denom

        read_number = _digits(read.get("number_local"))
        top_number = _digits(top.get("number"))
        features["number_matches"] = (
            1.0 if read_number is not None and read_number == top_number else 0.0
        )
        total = _digits(top.get("printed_total"))
        features["number_in_set"] = (
            1.0
            if read_number is not None and total is not None and read_number <= total
            else 0.0
        )
        features["reg_match"] = (
            1.0
            if _norm(read.get("regulation_mark"))
            and _norm(read.get("regulation_mark")) == _norm(top.get("regulation_mark"))
            else 0.0
        )
        features["artist_match"] = (
            1.0
            if _norm(read.get("artist")) and _norm(read.get("artist")) == _norm(top.get("artist"))
            else 0.0
        )
        features["hp_match"] = (
            1.0
            if str(read.get("hp") or "") and str(read.get("hp")) == str(top.get("hp") or "")
            else 0.0
        )
        features["glyph_energy"] = (
            1.0
            if read_name.endswith("energy")
            and len(tokens) >= 2
            and len(top_name.split()) > len(tokens)
            else 0.0
        )
    else:
        features.update(
            {"name_exact": 0.0, "name_subset": 0.0, "name_lev": 1.0,
             "number_matches": 0.0, "number_in_set": 0.0, "reg_match": 0.0,
             "artist_match": 0.0, "hp_match": 0.0, "glyph_energy": 0.0}
        )
    return features


def confidence(features: dict[str, float]) -> float:
    """Calibrated probability that the top candidate is correct."""
    total = _MODEL["intercept"]
    for name, mean, scale, coef in zip(
        _MODEL["features"], _MODEL["mean"], _MODEL["scale"], _MODEL["coef"]
    ):
        value = float(features.get(name, 0.0))
        total += ((value - mean) / (scale or 1.0)) * coef
    # guard against overflow
    if total >= 0:
        z = math.exp(-total)
        return 1.0 / (1.0 + z)
    z = math.exp(total)
    return z / (1.0 + z)


def assess(*, read: dict | None, candidates: list[dict] | None,
           known_set_codes: set[str] | None = None) -> tuple[float, dict[str, float]]:
    features = build_features(read=read, candidates=candidates, known_set_codes=known_set_codes)
    return confidence(features), features
