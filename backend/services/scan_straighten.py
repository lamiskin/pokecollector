"""Straighten and crop a card quad from a supplied RGB raster.

Pure helper: no database, storage or scan-queue coupling. The caller supplies
four pixel-space points in clockwise order; the helper returns an upright RGB
card with a small margin, or an explanation for abstaining.

A returned ``Straightened`` image is a **proposal**, never an approval. The
pipeline records it as ``state: proposed`` in the manifest
(``services.scan_storage``) and no consumer may promote it by inference from
this module. The padded original capture is always the authoritative image;
the derivative exists only alongside it. There is no code path here that
certifies a proposal as accepted.

The warp is a projective destination->source homography solved with numpy.
``Image.Transform.QUAD`` is intentionally not used: it interpolates the quad
bilinearly rather than inverting the projective transform, which bends card
edges on perspective photographs.

Withholding rule
----------------
A proposal is withheld only when the transform is technically unusable:
invalid or self-crossing geometry, a degenerate or unstable transform,
insufficient source pixels, or a failed decode. Boundary evidence never
withholds and never approves. A valid transform produces a proposal even when
the boundary diagnostics look wrong.

Boundary diagnostics have no authority
--------------------------------------
Geometry alone cannot tell whether the supplied quad is the card's boundary.
``assess_edge_support`` reads a 1-D gradient profile normal to each claimed
side and classifies the strongest *parallel* edge by its side of the claim:

* an edge **outboard** of the claim (further from the quad's centre) means the
  real object is larger than the claim -- the claim cuts inside the card -- so
  the side is ``shaved``;
* an edge **inboard** of the claim means the claim framed a sleeve, top loader
  or shadow -- the whole card is still inside the crop -- so the side is
  ``loose``;
* a side whose claim is its own strongest edge is ``tight``;
* a side with neither a claim step nor any parallel edge is ``unsupported``.

These are **developer diagnostics**, not an assurance. They are recorded under
``diagnostics.boundary`` in the manifest, with the per-side support ratios,
verdicts, offsets and raw per-sample evidence, so a person can inspect what the
pixels contained. Do not derive or display a confidence label from them: an
inboard peak only proves an interior contrast edge exists, and absence of
detected outboard evidence is not evidence of no shaving. The only
collector-facing description of a derivative is **"Unverified crop"**.
Gradients cannot tell a printed inner border from container material, so a
printed border inboard of a correct claim reads as ``loose`` too. That is why
the diagnostics cannot grant or withhold anything.

Sign convention
---------------
For every ordered edge, ``edge_inward_normal`` builds a unit normal and orients
it toward the quad centroid. Along that direction positive/``inboard`` points
toward the interior and negative/``outboard`` points away from it. The
convention is chosen from the interior reference point, not from the cross
product, so it is independent of the quad's winding order and of rotation or
keystone skew. ``edge_signed_offset`` and ``classify_edge_offset`` expose the
convention so it can be proven with synthetic points and no image evidence.

Ledger -- retired strict-veto rule
----------------------------------
Refused 5 previously accepted: 6a51e904, adcb3d02, 53db1852, 67f5b5b4,
f595187e. Accepted 1 shaved: 88744406. Those counts describe the retired
vetoing rule. Under the current rule every one of them is technically valid
and produces a proposal; 88744406's outboard evidence is retained as
diagnostics.

The warp never re-pairs the caller's corners. Its destination has the
*measured* w/h of the quad as supplied, so rectification cannot squeeze the
card. A quad measured wider than tall is a sideways capture; the resulting
pixels are then turned a quarter turn clockwise so the derivative is portrait,
and ``turned_cw`` records that turn. Orientation remains ambiguous by a half
turn: upright versus 180 degrees inverted needs content knowledge, which this
geometry-only helper does not have.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Sequence, Tuple

import numpy as np
from PIL import Image

STRAIGHTEN_VERSION = "v1"

CARD_ASPECT = 63.0 / 88.0
MIN_SIDE_PX = 8.0
MIN_ANGLE = 45.0
MAX_ANGLE = 135.0
MAX_OPPOSING_RATIO = 1.5
MIN_OUTPUT_PX = 32

# Boundary-support thresholds; see assess_edge_support for the method.
MIN_STEP = 8.0          # grey levels: minimum contrast across the claimed line
SUPPORT_RATIO = 1.5     # claimed response / median inward response
SHAVE_RATIO = 1.1       # an outboard edge must beat the claim by this margin
_RATIO_EPS = 0.5        # keeps a flat profile from dividing by zero
SUPPORT_SAMPLES = 7     # points sampled along each claimed side
SUPPORT_BAND_PX = 6     # support band around the claimed line, in pixels
SUPPORT_INWARD_FRAC = 0.10  # parallel-edge search reach as a fraction of side length


def straighten_config_digest() -> str:
    """SHA-256 over the thresholds and rule flags behind the diagnostics.

    The manifest records this beside ``STRAIGHTEN_VERSION`` so a derivative can
    never be mistaken for one produced by different rules. It is computed from
    the live constants, so changing any threshold changes the digest. It
    identifies the diagnostics and transform, not an approval.
    """
    config = {
        "version": STRAIGHTEN_VERSION,
        "card_aspect": CARD_ASPECT,
        "min_side_px": MIN_SIDE_PX,
        "min_angle": MIN_ANGLE,
        "max_angle": MAX_ANGLE,
        "max_opposing_ratio": MAX_OPPOSING_RATIO,
        "min_output_px": MIN_OUTPUT_PX,
        "min_step": MIN_STEP,
        "support_ratio": SUPPORT_RATIO,
        "shave_ratio": SHAVE_RATIO,
        "ratio_eps": _RATIO_EPS,
        "support_samples": SUPPORT_SAMPLES,
        "support_band_px": SUPPORT_BAND_PX,
        "support_inward_frac": SUPPORT_INWARD_FRAC,
        "boundary_diagnostics": "only",
        "withhold_on_boundary": False,
        "boundary_by_peak_position": True,
        "proposal_state": "proposed",
        # The destination follows the measured quad aspect; a wider-than-tall
        # result is turned 90 degrees as pixels. A derivative from the old
        # corner-repairing rule must not share this identity.
        "orientation": "warp_measured_aspect_then_turn_cw",
        "landscape_turn_cw": 90,
    }
    body = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class EdgeSupport:
    verdict: str                  # "ok" | "loose" | "shaved" | "unsupported"
    sides: tuple[float, ...]      # per-side support ratio, 4 values
    # Kept for compatibility: True where a side is ``shaved`` (the old
    # "competing" edge was always the outboard/hidden-real-edge case).
    competing_sides: tuple[bool, ...]
    detail: str
    side_verdicts: tuple[str, ...] = ()
    # Signed offset in pixels of the strongest parallel peak per side; negative
    # is outboard (away from the quad centre), positive is inboard.
    side_offsets: tuple[float, ...] = ()
    # Evidence retained per sample point rather than averaged into the aggregate
    # above: one row per side, one entry per sample along that side. Each entry
    # carries the strongest outboard peak and the strongest inboard peak seen by
    # that single sample (``offset``<0 is outboard, ``inboardOffset``>0 is
    # inboard). Averaging seven samples into one profile is what hid the Tauros
    # shave, so the raw per-sample evidence must survive to the manifest.
    side_samples: tuple[tuple[dict, ...], ...] = ()
    # Per-side measurements behind the verdict, including both directions even
    # when the verdict only used one. ``outboardOffset``/``outboardStrength``
    # report a real outboard edge even when it was too weak to classify as a
    # shave; that is the difference between describing the pixels and asserting
    # a policy. Developer diagnostics only.
    side_evidence: tuple[dict, ...] = ()


@dataclass(frozen=True)
class Straightened:
    image: Image.Image
    width: int
    height: int
    margin_fraction: float
    angle_degrees: float
    warnings: tuple[str, ...]
    support: EdgeSupport | None = None
    turned_cw: int = 0


@dataclass(frozen=True)
class Abstained:
    reason: str
    detail: str
    support: EdgeSupport | None = None


Point = Tuple[float, float]


def _distance(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _cross(o: Point, a: Point, b: Point) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _interior_angle(prev: Point, here: Point, nxt: Point) -> float:
    ax, ay = prev[0] - here[0], prev[1] - here[1]
    bx, by = nxt[0] - here[0], nxt[1] - here[1]
    la = math.hypot(ax, ay)
    lb = math.hypot(bx, by)
    if not la or not lb:
        return 0.0
    cosine = max(-1.0, min(1.0, (ax * bx + ay * by) / (la * lb)))
    return math.degrees(math.acos(cosine))


def _normalise_tilt(angle: float) -> float:
    # A line's direction is modulo 180 degrees; report the smallest signed tilt.
    value = (angle + 90.0) % 180.0 - 90.0
    return value


def quad_centroid(quad: Sequence[Point]) -> Point:
    """Mean of the four corners, used as the interior reference point."""
    return (
        sum(float(x) for x, _ in quad) / 4.0,
        sum(float(y) for _, y in quad) / 4.0,
    )


def edge_inward_normal(p0: Point, p1: Point, centroid: Point) -> Point:
    """Unit normal of edge ``p0 -> p1`` oriented toward ``centroid``.

    The returned direction *is* positive/inboard by definition. The sign is
    chosen from the interior point, not from the (p1 - p0) cross product, so
    clockwise, counter-clockwise, rotated and keystoned quads all share one
    convention. A degenerate edge returns ``(0.0, 0.0)``.
    """
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    if length < 1e-12:
        return (0.0, 0.0)
    nx, ny = -dy / length, dx / length
    mid = ((p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0)
    if (centroid[0] - mid[0]) * nx + (centroid[1] - mid[1]) * ny < 0.0:
        nx, ny = -nx, -ny
    return (nx, ny)


def edge_signed_offset(quad: Sequence[Point], side_index: int, point: Point) -> float:
    """Signed distance of ``point`` from one ordered edge, positive inboard."""
    p0 = quad[side_index]
    p1 = quad[(side_index + 1) % 4]
    nx, ny = edge_inward_normal(p0, p1, quad_centroid(quad))
    return (point[0] - p0[0]) * nx + (point[1] - p0[1]) * ny


def classify_edge_offset(
    quad: Sequence[Point], side_index: int, point: Point
) -> str:
    """Return ``inboard``/``outboard``/``on`` for ``point`` against one edge."""
    offset = edge_signed_offset(quad, side_index, point)
    if offset > 1e-9:
        return "inboard"
    if offset < -1e-9:
        return "outboard"
    return "on"


def _bilinear(gray: np.ndarray, x: float, y: float) -> float:
    height, width = gray.shape
    x = min(max(x, 0.0), width - 1.0)
    y = min(max(y, 0.0), height - 1.0)
    x0 = int(x)
    y0 = int(y)
    x1 = min(x0 + 1, width - 1)
    y1 = min(y0 + 1, height - 1)
    fx = x - x0
    fy = y - y0
    top = gray[y0, x0] * (1.0 - fx) + gray[y0, x1] * fx
    bottom = gray[y1, x0] * (1.0 - fx) + gray[y1, x1] * fx
    return float(top * (1.0 - fy) + bottom * fy)


def _unmeasurable(detail: str) -> EdgeSupport:
    """An ``unsupported`` verdict for a quad the raster cannot be probed on."""
    return EdgeSupport(
        "unsupported",
        (0.0, 0.0, 0.0, 0.0),
        (False,) * 4,
        detail,
        ("unsupported",) * 4,
        (0.0,) * 4,
        ((),) * 4,
        (
            {
                "ratio": 0.0,
                "claimStep": 0.0,
                "claimPeak": 0.0,
                "outboardOffset": 0.0,
                "outboardStrength": 0.0,
                "inboardOffset": 0.0,
                "inboardStrength": 0.0,
                "verdict": "unsupported",
            },
        ) * 4,
    )


def assess_edge_support(
    rgb: Image.Image,
    quad: Sequence[Tuple[float, float]],
    *,
    samples: int = SUPPORT_SAMPLES,
    band_px: int = SUPPORT_BAND_PX,
    inward_frac: float = SUPPORT_INWARD_FRAC,
) -> EdgeSupport:
    """Decide whether the supplied quad actually sits on the card's boundary.

    Method (pure, numpy only):

    * Convert to greyscale once and take ``samples`` points along each side
      between 10 % and 90 % of its length, so the rounded corners do not vote.
    * At each point, sample the image along the side's inward normal (oriented
      towards the quad centroid) at integer pixel offsets. ``band_px`` is the
      support band around the claimed line; the parallel-edge search reaches
      ``inward_frac`` of the side length, floored at ``band_px`` and capped at
      a quarter of the raster, in *both* directions.
    * Average the per-position profiles and take the absolute central
      difference; that is the response profile. Negative offsets are outboard
      of the claim, positive offsets are inboard.

    Per side the numbers that matter are the step contrast across the claimed
    line (the largest band-mean difference over band widths 1..``band_px``
    either side), the median response inside the card, and the strongest
    parallel response on each side of the claim, excluding a +-2 px window so
    the near side of the claimed transition is not mistaken for a second edge.

    A side is **supported** when the step contrast is at least ``MIN_STEP``
    grey levels and the support ratio is at least ``SUPPORT_RATIO``.

    The strongest parallel edge decides the side's class when it is stronger
    than the claim's own gradient peak; a weaker parallel response is the tail
    of the claim's transition or distant background structure, not a second
    object edge. Position is what matters:

    * an outboard peak that beats the claim (``SHAVE_RATIO`` margin, floored at
      ``MIN_STEP``) means the real object is larger than the claim: the claim
      cuts inside the card, so the side is ``shaved``;
    * an inboard peak that beats the claim means the claim framed something
      bigger -- sleeve, top loader or shadow -- so the side is ``loose``;
    * otherwise a supported claim is ``tight``;
    * otherwise the side is ``unsupported``.

    Verdict: ``shaved`` when any side is shaved, else ``unsupported`` when any
    side is unsupported, else ``loose`` when any side is loose, else ``ok``.
    The verdict is **developer diagnostics only**: it is recorded under
    ``diagnostics.boundary`` and has no authority to block or approve a warp.
    There is deliberately no confidence label; per-side verdicts and offsets
    are the evidence, and a consumer that wants more must inspect them.

    Per-sample evidence is retained in ``side_samples`` in addition to the
    averaged profile the verdict is computed from. Seven samples averaged into
    one profile is what hid the Tauros shave; the raw per-sample offsets and
    strengths keep the next decision possible without changing thresholds.
    ``side_evidence`` likewise keeps both the outboard and inboard peak per
    side, including a real but weaker outboard edge that did not classify as a
    shave.

    Limitation: a printed inner border inboard of a correct claim is
    pixel-identical to container material, so it reads as ``loose`` as well.
    That over-reports an interior edge but never damages the crop. A shave
    whose real edge is weaker than the claim, or lies beyond the search reach,
    cannot be proven from gradients; ``side_evidence`` still reports the
    outboard peak it measured, but the side is not classified as a shave.
    """
    try:
        points = [(float(x), float(y)) for x, y in quad]
    except (TypeError, ValueError):
        return _unmeasurable("quad is not measurable")
    if len(points) != 4 or not all(
        math.isfinite(x) and math.isfinite(y) for x, y in points
    ):
        return _unmeasurable("quad is not measurable")

    gray = np.asarray(rgb.convert("L"), dtype=float)
    height, width = gray.shape
    if width < 3 or height < 3:
        return _unmeasurable(f"raster {width}x{height}")

    centroid = quad_centroid(points)
    reach_cap = max(band_px, int(round(0.25 * min(width, height))))
    count = max(2, int(samples))
    step_count = max(1, int(band_px))

    ratios: list[float] = []
    competing: list[bool] = []
    side_verdicts: list[str] = []
    side_offsets: list[float] = []
    side_samples: list[tuple[dict, ...]] = []
    side_evidence: list[dict] = []
    notes: list[str] = []
    supported_count = 0

    for index in range(4):
        p0 = points[index]
        p1 = points[(index + 1) % 4]
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        length = math.hypot(dx, dy)
        if length < 1e-6:
            ratios.append(0.0)
            competing.append(False)
            side_verdicts.append("unsupported")
            side_offsets.append(0.0)
            side_samples.append(())
            side_evidence.append(
                {
                    "ratio": 0.0,
                    "claimStep": 0.0,
                    "claimPeak": 0.0,
                    "outboardOffset": 0.0,
                    "outboardStrength": 0.0,
                    "inboardOffset": 0.0,
                    "inboardStrength": 0.0,
                    "verdict": "unsupported",
                }
            )
            notes.append(f"s{index}:degenerate")
            continue
        nx, ny = edge_inward_normal(p0, p1, centroid)

        reach = int(min(max(step_count, round(inward_frac * length)), reach_cap))
        reach = max(1, reach)
        offsets = np.arange(-reach, reach + 1, dtype=float)
        # Keep each sample's own profile: the aggregate below is what the
        # diagnostic verdict uses, but averaging must not erase the raw evidence.
        sample_profiles = np.zeros((count, offsets.size), dtype=float)
        for sample in range(count):
            fraction = 0.10 + 0.80 * (sample / (count - 1))
            bx = p0[0] + dx * fraction
            by = p0[1] + dy * fraction
            for slot, offset in enumerate(offsets):
                sample_profiles[sample, slot] = _bilinear(
                    gray, bx + nx * offset, by + ny * offset
                )
        profile = sample_profiles.mean(axis=0)

        response = np.abs(np.gradient(profile, 1.0))
        zero = reach
        inward = np.abs(response[zero + 1:])
        median_in = float(np.median(inward)) if inward.size else 0.0

        # The step contrast is the largest band-mean difference either side of
        # the claim, over band widths 1..band_px. Taking the largest lets a
        # thin printed border (where a wide window reaches the card body) and
        # a thick one (where only a wide window spans the rim) both register.
        window = max(1, min(step_count, reach))
        claim_step = 0.0
        for size in range(1, window + 1):
            before = profile[max(0, zero - size):zero]
            after = profile[zero + 1:zero + 1 + size]
            if before.size and after.size:
                claim_step = max(
                    claim_step, abs(float(before.mean()) - float(after.mean()))
                )

        ratio = claim_step / max(median_in, _RATIO_EPS)
        supported = claim_step >= MIN_STEP and ratio >= SUPPORT_RATIO

        # Compare parallel peaks against the claim's *own* gradient peak, so all
        # three numbers are in the same units. ``claim_step`` is a band-mean
        # difference and is about twice a sharp step's central-difference
        # gradient; using it directly would bias every comparison to the claim.
        claim_peak = float(response[max(0, zero - window):zero + window + 1].max())

        # Split the parallel search by side of the claim. The +-2 px window
        # excludes the near side of the claimed transition itself, so a thick
        # border's blurred rim is not counted as a second edge. Offsets are
        # pixel distances from the claim; negative is outboard (away from the
        # quad centre), positive is inboard.
        out_slice = response[:max(0, zero - 2)]
        in_slice = response[zero + 3:]
        peak_out = float(out_slice.max()) if out_slice.size else 0.0
        peak_in = float(in_slice.max()) if in_slice.size else 0.0
        off_out = (
            float(offsets[:max(0, zero - 2)][int(np.argmax(out_slice))])
            if out_slice.size else 0.0
        )
        off_in = (
            float(offsets[zero + 3:][int(np.argmax(in_slice))])
            if in_slice.size else 0.0
        )

        # Outboard first: when both sides show a stronger edge, the real object
        # is more likely outboard. The SHAVE_RATIO margin keeps a slightly
        # stronger inboard/printed edge from being mistaken for container
        # material. This classification is diagnostic and never withholds.
        if peak_out >= MIN_STEP and peak_out > max(claim_peak * SHAVE_RATIO, MIN_STEP):
            side_verdict = "shaved"
            deciding_offset = off_out
        elif peak_in >= MIN_STEP and peak_in > max(claim_peak, MIN_STEP):
            side_verdict = "loose"
            deciding_offset = off_in
        elif supported:
            side_verdict = "tight"
            deciding_offset = (
                off_out if peak_out >= peak_in else off_in
            ) if max(peak_out, peak_in) >= MIN_STEP else 0.0
        else:
            side_verdict = "unsupported"
            deciding_offset = 0.0

        if supported:
            supported_count += 1
        # Retain per-sample strongest outboard and inboard peaks. ``offset`` is
        # the signed outboard candidate (negative = outboard); ``inboardOffset``
        # is the inboard candidate (positive = inboard). Both strengths are
        # central-difference gradient magnitudes, the same units as peak_out /
        # peak_in, so they can be compared with the aggregate.
        per_sample: list[dict] = []
        for sample in range(count):
            sample_response = np.abs(np.gradient(sample_profiles[sample], 1.0))
            s_out = sample_response[:max(0, zero - 2)]
            s_in = sample_response[zero + 3:]
            s_peak_out = float(s_out.max()) if s_out.size else 0.0
            s_peak_in = float(s_in.max()) if s_in.size else 0.0
            s_off_out = (
                float(offsets[:max(0, zero - 2)][int(np.argmax(s_out))])
                if s_out.size else 0.0
            )
            s_off_in = (
                float(offsets[zero + 3:][int(np.argmax(s_in))])
                if s_in.size else 0.0
            )
            per_sample.append(
                {
                    "offset": round(s_off_out, 1),
                    "strength": round(s_peak_out, 1),
                    "inboardOffset": round(s_off_in, 1),
                    "inboardStrength": round(s_peak_in, 1),
                }
            )
        side_samples.append(tuple(per_sample))
        side_evidence.append(
            {
                "ratio": round(ratio, 3),
                "claimStep": round(claim_step, 1),
                "claimPeak": round(claim_peak, 1),
                "outboardOffset": round(off_out, 1),
                "outboardStrength": round(peak_out, 1),
                "inboardOffset": round(off_in, 1),
                "inboardStrength": round(peak_in, 1),
                "verdict": side_verdict,
            }
        )
        ratios.append(round(ratio, 3))
        competing.append(side_verdict == "shaved")
        side_verdicts.append(side_verdict)
        side_offsets.append(round(deciding_offset, 1))
        notes.append(
            f"s{index}:ratio={ratio:.2f},step={claim_step:.0f},"
            f"claim={claim_peak:.0f},out={peak_out:.0f}@{off_out:.0f},"
            f"in={peak_in:.0f}@{off_in:.0f},{side_verdict}"
        )

    shaved_count = sum(1 for verdict in side_verdicts if verdict == "shaved")
    unsupported_count = sum(1 for verdict in side_verdicts if verdict == "unsupported")
    loose_count = sum(1 for verdict in side_verdicts if verdict == "loose")
    if shaved_count:
        verdict = "shaved"
    elif unsupported_count:
        verdict = "unsupported"
    elif loose_count:
        verdict = "loose"
    else:
        verdict = "ok"

    detail = (
        f"{verdict}: {supported_count}/4 sides supported; "
        f"sides={[round(value, 2) for value in ratios]}; "
        f"sideVerdicts={side_verdicts}; offsets={side_offsets}; "
        f"competing={[i for i, flag in enumerate(competing) if flag]}; "
        + "; ".join(notes)
    )
    return EdgeSupport(
        verdict,
        tuple(ratios),
        tuple(competing),
        detail,
        tuple(side_verdicts),
        tuple(side_offsets),
        tuple(side_samples),
        tuple(side_evidence),
    )


def boundary_diagnostics(support: EdgeSupport) -> dict:
    """Serialise boundary evidence as developer diagnostics, never assurance.

    An inboard peak only proves an interior contrast edge exists; it does not
    establish that the claim is outside the card. Absence of detected outboard
    evidence is not evidence of no shaving. So this payload carries the raw
    per-side measurements and offsets for a person to inspect, with no
    confidence label and no authority over the proposal. The only
    collector-facing description of a derivative is ``Unverified crop``.
    """
    return {
        "note": "developer diagnostics only; cannot approve or withhold",
        "verdict": support.verdict,
        "sideRatios": [round(float(value), 3) for value in support.sides],
        "sideVerdicts": list(support.side_verdicts),
        "sideOffsets": [round(float(value), 1) for value in support.side_offsets],
        "sideEvidence": [
            {
                "ratio": round(float(item.get("ratio", 0.0)), 3),
                "claimStep": round(float(item.get("claimStep", 0.0)), 1),
                "claimPeak": round(float(item.get("claimPeak", 0.0)), 1),
                "outboardOffset": round(
                    float(item.get("outboardOffset", 0.0)), 1
                ),
                "outboardStrength": round(
                    float(item.get("outboardStrength", 0.0)), 1
                ),
                "inboardOffset": round(
                    float(item.get("inboardOffset", 0.0)), 1
                ),
                "inboardStrength": round(
                    float(item.get("inboardStrength", 0.0)), 1
                ),
                "verdict": str(item.get("verdict", "unsupported")),
            }
            for item in support.side_evidence
        ],
        "sideSamples": [
            [
                {
                    "offset": round(float(sample.get("offset", 0.0)), 1),
                    "strength": round(float(sample.get("strength", 0.0)), 1),
                    "inboardOffset": round(
                        float(sample.get("inboardOffset", 0.0)), 1
                    ),
                    "inboardStrength": round(
                        float(sample.get("inboardStrength", 0.0)), 1
                    ),
                }
                for sample in samples
            ]
            for samples in support.side_samples
        ],
        "shavedSides": [
            index
            for index, flag in enumerate(support.competing_sides)
            if flag
        ],
        "detail": support.detail,
    }


def transform_quad_for_storage(
    quad: Sequence[Tuple[float, float]],
    rotation_cw: int,
    width: int,
    height: int,
) -> list[Point]:
    """Map a normalized upload-space quad onto the stored raster's pixels.

    ``quad`` is in 0..1 of the uploaded JPEG as the client sees it. The
    sanitizer applies EXIF orientation (already reflected in the browser's
    displayed upload) and then the collector's clockwise quarter turn, before
    resizing. This rotates the normalized points by that same quarter turn and
    scales them to the sanitized raster, which is what ``try_straighten``
    expects.
    """
    rotation = int(rotation_cw or 0)
    if rotation not in (0, 90, 180, 270):
        raise ValueError(f"unsupported rotation {rotation_cw!r}")
    stored_width = float(width)
    stored_height = float(height)
    points: list[Point] = []
    for raw_u, raw_v in quad:
        u = float(raw_u)
        v = float(raw_v)
        if rotation == 90:
            u, v = 1.0 - v, u
        elif rotation == 180:
            u, v = 1.0 - u, 1.0 - v
        elif rotation == 270:
            u, v = v, 1.0 - u
        points.append((u * stored_width, v * stored_height))
    return points


def _homography(dst: Sequence[Point], src: Sequence[Point]) -> np.ndarray:
    """Solve the 3x3 destination->source projective transform."""
    rows = []
    values = []
    for (x, y), (u, v) in zip(dst, src):
        rows.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y])
        values.append(u)
        rows.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y])
        values.append(v)
    solution = np.linalg.solve(np.asarray(rows, dtype=float), np.asarray(values, dtype=float))
    return solution


def _project(matrix: np.ndarray, x: float, y: float) -> Point:
    denominator = matrix[6] * x + matrix[7] * y + 1.0
    if abs(denominator) < 1e-12:
        return (math.inf, math.inf)
    return (
        (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
        (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator,
    )


def try_straighten(
    rgb: Image.Image,
    quad: Sequence[Tuple[float, float]],
    *,
    margin: float = 0.015,
    max_edge: int = 2048,
) -> Straightened | Abstained:
    """Warp a supplied quad into a portrait proposal, or abstain technically.

    A ``Straightened`` result is an **Unverified crop**: a proposal produced by
    a technically valid transform. The padded original remains authoritative.
    Boundary diagnostics are attached for developers and never decide this
    function's outcome.

    Withholding rule: the only abstentions are technical failures -- invalid or
    self-crossing geometry, a degenerate or unstable transform, insufficient
    source pixels, or a failed decode. A shaved, loose, unsupported or
    otherwise surprising boundary verdict cannot withhold a valid proposal.
    """
    if rgb.mode != "RGB":
        rgb = rgb.convert("RGB")
    width, height = rgb.size
    if width < 2 or height < 2:
        return Abstained("too_small", f"raster {width}x{height}")

    try:
        points = [(float(x), float(y)) for x, y in quad]
    except (TypeError, ValueError):
        return Abstained("bad_quad", "points are not numeric")
    if len(points) != 4:
        return Abstained("bad_quad", f"expected 4 points, got {len(points)}")
    if not all(math.isfinite(x) and math.isfinite(y) for x, y in points):
        return Abstained("bad_quad", "non-finite point")
    if len(set(points)) != 4:
        return Abstained("bad_quad", "duplicate point")

    tolerance = 1.0
    if any(x < -tolerance or y < -tolerance or x > width + tolerance or y > height + tolerance
           for x, y in points):
        return Abstained("out_of_source", "quad point outside the raster")

    sides = [_distance(points[i], points[(i + 1) % 4]) for i in range(4)]
    if min(sides) < MIN_SIDE_PX:
        return Abstained("short_side", f"shortest side {min(sides):.1f}px")

    signs = [_cross(points[i], points[(i + 1) % 4], points[(i + 2) % 4]) for i in range(4)]
    if not (all(value > 0 for value in signs) or all(value < 0 for value in signs)):
        return Abstained("non_convex", "quad is not convex and consistently wound")

    angles = [
        _interior_angle(points[(i - 1) % 4], points[i], points[(i + 1) % 4])
        for i in range(4)
    ]
    if min(angles) < MIN_ANGLE or max(angles) > MAX_ANGLE:
        return Abstained("bad_shape", f"interior angles {min(angles):.1f}-{max(angles):.1f}")

    opposing = [max(sides[0], sides[2]) / max(1e-9, min(sides[0], sides[2])),
                max(sides[1], sides[3]) / max(1e-9, min(sides[1], sides[3]))]
    if max(opposing) > MAX_OPPOSING_RATIO:
        return Abstained("bad_shape", f"opposing side ratio {max(opposing):.2f}")

    # In-plane tilt is reported, never vetoed: the projective warp levels any
    # angle, and a card held sideways is fine because the result is turned as
    # pixels after the warp. Keep the tilt of the quad as detected.
    tilt = _normalise_tilt(math.degrees(math.atan2(
        points[1][1] - points[0][1], points[1][0] - points[0][0],
    )))

    # Never re-pair the caller's corners. The destination's inner aspect is the
    # measured w/h of the quad as supplied, so rectification cannot squeeze the
    # card. A quad measured wider than tall is a sideways capture: the pixels
    # are turned a quarter clockwise after the warp, and ``turned_cw`` records
    # the turn. Which upright (0 vs 180 degrees) is correct still needs content
    # knowledge, so it is not attempted here.
    measured_w = min(sides[0], sides[2])
    measured_h = min(sides[1], sides[3])
    inner_w = measured_w
    inner_h = measured_h
    out_w = inner_w * (1.0 + 2.0 * margin)
    out_h = inner_h * (1.0 + 2.0 * margin)

    limit_w = min(measured_w, float(max_edge))
    limit_h = min(measured_h, float(max_edge))
    scale = min(1.0, limit_w / out_w if out_w else 0.0, limit_h / out_h if out_h else 0.0)
    out_w = int(round(out_w * scale))
    out_h = int(round(out_h * scale))
    if out_w < MIN_OUTPUT_PX or out_h < MIN_OUTPUT_PX:
        return Abstained("too_small", f"output {out_w}x{out_h} below {MIN_OUTPUT_PX}px")

    # Geometry is satisfied; read the pixels for diagnostics. The evidence
    # reads the caller's own corners, in their order, so it describes exactly
    # what was supplied. It is recorded, never a veto: a produced warp is a
    # proposal regardless of the boundary verdict. There is no branch below
    # that reads ``support.verdict``.
    support = assess_edge_support(rgb, points)

    inset_x = out_w * margin
    inset_y = out_h * margin
    destination = [
        (inset_x, inset_y),
        (out_w - inset_x, inset_y),
        (out_w - inset_x, out_h - inset_y),
        (inset_x, out_h - inset_y),
    ]
    try:
        coefficients = _homography(destination, points)
    except np.linalg.LinAlgError:
        return Abstained("bad_quad", "degenerate homography")

    corners = [(0.0, 0.0), (float(out_w), 0.0), (float(out_w), float(out_h)), (0.0, float(out_h))]
    for x, y in corners:
        sx, sy = _project(coefficients, x, y)
        if not (math.isfinite(sx) and math.isfinite(sy)):
            return Abstained("out_of_source", "output corner maps to infinity")
        if sx < -0.5 or sy < -0.5 or sx > width + 0.5 or sy > height + 0.5:
            return Abstained("out_of_source", "output corner maps outside the raster")

    image = rgb.transform(
        (out_w, out_h),
        Image.Transform.PERSPECTIVE,
        coefficients.tolist(),
        resample=Image.Resampling.BICUBIC,
    ).convert("RGB")

    # A sideways capture warps into its measured landscape frame first (so no
    # squeeze) and is then turned a quarter clockwise as pixels, keeping the
    # card's own proportions. PIL's ROTATE_270 is 270 degrees counter-clockwise,
    # i.e. 90 degrees clockwise.
    turned_cw = 0
    if out_w > out_h:
        image = image.transpose(Image.Transpose.ROTATE_270).convert("RGB")
        out_w, out_h = out_h, out_w
        turned_cw = 90

    warnings: tuple[str, ...] = ()
    if min(opposing) > 1.4:
        warnings = ("near_limit_aspect",)
    return Straightened(
        image=image,
        width=out_w,
        height=out_h,
        margin_fraction=float(margin),
        angle_degrees=float(tilt),
        warnings=warnings,
        support=support,
        turned_cw=turned_cw,
    )
