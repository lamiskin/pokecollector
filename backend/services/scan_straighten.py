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

Outward-only crop growth
------------------------
The detector's quad is frequently a few pixels *inside* the physical card, and
on a skewed side the miss can differ per sample. Because a crop can never lose
card by growing, ``expand_quad_outward`` grows each side outward along its own
normal by a percentile of the outboard offsets that side's samples actually
measured, capped per side at ``MAX_EXPAND_FRAC`` of that side's length. A single
isolated spike cannot grow a side (it is weaker than half the side's strongest
outboard sample); a coherent skewed edge can. Growth is clamped into the raster
and never moves a side inward, and it consumes the margin band on any side that
ran into the boundary. Without outboard evidence -- or with no support evidence
at all -- the quad is used exactly as claimed. The applied growth is recorded
under ``diagnostics.expansion`` beside the unchanged boundary numbers.

The reported offset must never be double-counted: the expansion is capped, so
the warp quad exceeds the claim by at most 4 % per side, and the margin band is
inset from the *expanded* quad rather than added a second time on top of it.

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

Orientation is decided by the card's own shape, not by the order in which the
detector happened to list the corners. A Pokemon card is 63:88 portrait, so
the longer of the two measured side pairs must be the destination's vertical
pair. The warp is given a corner order re-sequenced by one step when the
supplied order put the shorter pair vertical; only the warp's order changes.
Boundary diagnostics and the outward expansion keep the caller's corners
exactly as supplied and as expanded. The destination's inner dimensions are
the measured short-pair length by the measured long-pair length -- the means of
the two pairs of the warp quad -- so rectification cannot squeeze and the
output is portrait because the long pair is vertical. No post-warp quarter turn
is applied and ``turned_cw`` is always 0. Orientation remains ambiguous by a
half turn: upright versus 180 degrees inverted needs content knowledge, which
this geometry-only helper does not have.
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

# Outward-only crop expansion; see expand_quad_outward.
EXPAND_PERCENTILE = 0.75   # of the side's accepted outboard offsets
MAX_EXPAND_FRAC = 0.04     # per side, as a fraction of that side's length
EXPAND_STRENGTH_FRAC = 0.5 # samples weaker than half the strongest are noise
EXPAND_MIN_SAMPLES = 2     # an isolated sample can never expand a side


def straighten_config_digest() -> str:
    """SHA-256 over the thresholds and rule flags behind the diagnostics.

    The manifest records this beside ``STRAIGHTEN_VERSION`` so a derivative can
    never be mistaken for one produced by different rules. It is computed from
    the live constants, so changing any threshold changes the digest. It
    identifies the diagnostics and transform, not an approval.
    """
    config = {
        "version": STRAIGHTEN_VERSION,
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
        "expand_percentile": EXPAND_PERCENTILE,
        "max_expand_frac": MAX_EXPAND_FRAC,
        "expand_strength_frac": EXPAND_STRENGTH_FRAC,
        "expand_min_samples": EXPAND_MIN_SAMPLES,
        "crop_expansion": "outward_only_per_side",
        "boundary_diagnostics": "only",
        "withhold_on_boundary": False,
        "boundary_by_peak_position": True,
        "proposal_state": "proposed",
        # The warp re-sequences the supplied corners when needed so the longer
        # measured pair is vertical, then warps into that measured short x long
        # frame. It never turns the pixels afterwards and never forces a
        # nominal aspect. A derivative from an older orientation rule must not
        # share this identity.
        "orientation": "measured_pair_long_axis_vertical",
        "post_warp_turn_cw": 0,
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
    # The outward expansion actually applied to the warp quad, in the manifest's
    # ``diagnostics.expansion`` shape, or None when the quad was used as claimed.
    expansion: dict | None = None


@dataclass(frozen=True)
class Abstained:
    reason: str
    detail: str
    support: EdgeSupport | None = None


Point = Tuple[float, float]


def _distance(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _unit(a: Point, b: Point) -> Point:
    """Unit vector from ``a`` to ``b``; ``(0, 0)`` for a degenerate edge."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    if length < 1e-12:
        return (0.0, 0.0)
    return (dx / length, dy / length)


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


def _outboard_candidates(samples: Sequence[dict]) -> list[float]:
    """Outboard distances (positive px) of one side's real outboard edges.

    Each per-sample entry reports the strongest outboard peak as a negative
    ``offset`` (negative is outboard of the claim) and its ``strength`` as a
    central-difference gradient magnitude. A sample with no outboard edge at all
    reports offset 0. Samples weaker than half the side's strongest outboard
    peak are dropped: an isolated weak response is noise, while a coherent
    skewed edge keeps several comparable samples. A peak below ``MIN_STEP`` is
    never treated as an edge, so a flat background cannot expand anything.
    """
    measured: list[tuple[float, float]] = []
    for sample in samples:
        offset = float(sample.get("offset", 0.0))
        strength = float(sample.get("strength", 0.0))
        if offset < -1e-9:
            measured.append((-offset, strength))
    if len(measured) < EXPAND_MIN_SAMPLES:
        return []
    floor = max(MIN_STEP, EXPAND_STRENGTH_FRAC * max(value for _, value in measured))
    return sorted(distance for distance, strength in measured if strength >= floor)


def expand_quad_outward(
    claims: Sequence[Tuple[float, float]],
    support: "EdgeSupport | None",
    *,
    percentile: float = EXPAND_PERCENTILE,
    max_expand_frac: float = MAX_EXPAND_FRAC,
    bounds: tuple[float, float] | None = None,
) -> tuple[list[Point], list[float], list[bool]]:
    """Grow a claimed quad outward by the outboard edge it demonstrably missed.

    Growing a crop can never remove card, at worst it adds background, so the
    expansion is **outward only**: every side moves along its own outward normal
    and never inward. Each side is measured independently from the per-sample
    outboard evidence ``assess_edge_support`` already recorded:

    * keep the side's per-sample outboard distances whose strength is at least
      ``EXPAND_STRENGTH_FRAC`` of that side's strongest outboard peak and at
      least ``MIN_STEP`` grey levels -- this rejects an isolated noise spike
      without hiding a coherent, possibly skewed, edge;
    * take ``percentile`` of those distances (default 0.75), so a majority of
      the tracked edge is covered rather than its most extreme sample;
    * clamp to ``max_expand_frac`` of that side's length (4 % by default), so a
      bad track cannot balloon the crop.

    Fewer than ``EXPAND_MIN_SAMPLES`` surviving outboard samples, or no support
    evidence at all, leaves the side exactly where it was claimed. A side with
    no outboard evidence therefore cannot move.

    With ``bounds`` (the source raster size) each resulting corner is clamped
    into the raster, and a side is flagged when either of its corners hit the
    boundary. The clamp is applied after the outward shift; if it would leave a
    side inboard of its claim (which a rotation plus a rectangular clamp can in
    principle do), that side falls back to the claim and is flagged instead. So
    the returned quad is never smaller than the claimed one on any side.

    Returns ``(quad, expansion_px, clamped)`` with four per-side values in the
    caller's corner order (side ``i`` runs from corner ``i`` to ``i + 1``).
    """
    points = [(float(x), float(y)) for x, y in claims]
    if len(points) != 4:
        return points, [0.0] * 4, [False] * 4
    expansion = [0.0, 0.0, 0.0, 0.0]
    if support is None or not getattr(support, "side_samples", None):
        return points, expansion, [False] * 4

    crop = float(percentile)
    if not math.isfinite(crop):
        crop = EXPAND_PERCENTILE
    crop = min(max(crop, 0.0), 1.0)

    samples_per_side = support.side_samples
    for index in range(4):
        length = _distance(points[index], points[(index + 1) % 4])
        if length < 1e-6:
            continue
        samples = samples_per_side[index] if index < len(samples_per_side) else ()
        distances = _outboard_candidates(samples)
        if len(distances) < EXPAND_MIN_SAMPLES:
            continue
        value = float(np.percentile(np.asarray(distances, dtype=float), crop * 100.0))
        limit = max(0.0, float(max_expand_frac)) * length
        expansion[index] = max(0.0, min(value, limit))

    centroid = quad_centroid(points)
    expanded = list(points)
    for index in range(4):
        amount = expansion[index]
        if amount <= 0.0:
            continue
        nx, ny = edge_inward_normal(
            points[index], points[(index + 1) % 4], centroid
        )
        # Outward is the negated inward normal.
        dx, dy = -nx * amount, -ny * amount
        expanded[index] = (expanded[index][0] + dx, expanded[index][1] + dy)
        end = (index + 1) % 4
        expanded[end] = (expanded[end][0] + dx, expanded[end][1] + dy)

    clamped = [False, False, False, False]
    if bounds is not None:
        limit_x, limit_y = float(bounds[0]), float(bounds[1])
        corner_hit = [False, False, False, False]
        for index, (x, y) in enumerate(expanded):
            bounded_x = min(max(x, 0.0), limit_x - 1.0)
            bounded_y = min(max(y, 0.0), limit_y - 1.0)
            if abs(bounded_x - x) > 1e-9 or abs(bounded_y - y) > 1e-9:
                corner_hit[index] = True
                expanded[index] = (bounded_x, bounded_y)
        for index in range(4):
            end = (index + 1) % 4
            if corner_hit[index] or corner_hit[end]:
                clamped[index] = True
        # Never let a clamp tuck a side inboard of its claim: a boundary is not
        # evidence that the card shrank. Fall back to the claimed side instead.
        for index in range(4):
            if expansion[index] <= 0.0 or not clamped[index]:
                continue
            midpoint = (
                (points[index][0] + points[(index + 1) % 4][0]) / 2.0,
                (points[index][1] + points[(index + 1) % 4][1]) / 2.0,
            )
            if edge_signed_offset(points, index, midpoint) > 1e-9:
                continue  # degenerate claim; nothing to compare against
            end = (index + 1) % 4
            side_midpoint = (
                (expanded[index][0] + expanded[end][0]) / 2.0,
                (expanded[index][1] + expanded[end][1]) / 2.0,
            )
            if edge_signed_offset(points, index, side_midpoint) > 1e-9:
                expanded[index] = points[index]
                expanded[end] = points[end]
                expansion[index] = 0.0
    return expanded, expansion, clamped


def expansion_diagnostics(
    quad: Sequence[Tuple[float, float]],
    expansion: Sequence[float],
    clamped: Sequence[bool],
    *,
    percentile: float = EXPAND_PERCENTILE,
) -> dict:
    """Serialise the outward expansion as diagnostics beside the claimed quad.

    The claimed quad's own numbers (support ratios, verdicts, offsets) are
    unchanged; this block says only how far each side was grown, whether the
    source raster stopped it, and the quad the warp actually used. Like the
    boundary block it is developer diagnostics and has no authority.
    """
    sides = []
    for index in range(4):
        amount = float(expansion[index]) if index < len(expansion) else 0.0
        hit = bool(clamped[index]) if index < len(clamped) else False
        sides.append({"expandPx": round(amount, 2), "expandClamped": hit})
    return {
        "percentile": round(float(percentile), 3),
        "sides": sides,
        "clamped": [entry["expandClamped"] for entry in sides],
        "quad": [
            [round(float(x), 2), round(float(y), 2)] for x, y in quad
        ],
    }


def output_pixel_size(
    measured_w: float,
    measured_h: float,
    *,
    margin: float = 0.015,
    max_edge: int = 2048,
) -> tuple[int, int]:
    """Destination size for a card of the measured size, never upscaled."""
    out_w = float(measured_w) * (1.0 + 2.0 * float(margin))
    out_h = float(measured_h) * (1.0 + 2.0 * float(margin))
    limit_w = min(float(measured_w), float(max_edge))
    limit_h = min(float(measured_h), float(max_edge))
    scale = min(1.0, limit_w / out_w if out_w else 0.0, limit_h / out_h if out_h else 0.0)
    return int(round(out_w * scale)), int(round(out_h * scale))


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


def _usable_warp_quad(
    candidate: Sequence[Point], claims: Sequence[Point]
) -> bool:
    """True when the expanded quad is still a sane, non-folded rectangle.

    Per-side growth can in principle turn a convex claim into a crossed or
    dented quad (an adjacent side growing much further than its neighbour). The
    warp is then not usable, so the caller keeps the claim; this never withholds
    a proposal, it only declines the extra background.
    """
    if len(candidate) != 4:
        return False
    if not all(math.isfinite(x) and math.isfinite(y) for x, y in candidate):
        return False
    signs = [
        _cross(candidate[i], candidate[(i + 1) % 4], candidate[(i + 2) % 4])
        for i in range(4)
    ]
    if not (all(value > 1e-9 for value in signs) or all(value < -1e-9 for value in signs)):
        return False
    for index in range(4):
        if _distance(candidate[index], candidate[(index + 1) % 4]) < MIN_SIDE_PX:
            return False
        angle = _interior_angle(
            candidate[(index - 1) % 4], candidate[index], candidate[(index + 1) % 4]
        )
        if angle < 20.0 or angle > 160.0:
            return False
        # Never let the expansion move a side inward versus the claim.
        midpoint = (
            (candidate[index][0] + candidate[(index + 1) % 4][0]) / 2.0,
            (candidate[index][1] + candidate[(index + 1) % 4][1]) / 2.0,
        )
        if edge_signed_offset(claims, index, midpoint) > 1e-6:
            return False
    return True


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
    # angle, and a card held sideways is fine because the pairing below
    # re-sequences the warp corners. Keep the tilt of the quad as detected.
    tilt = _normalise_tilt(math.degrees(math.atan2(
        points[1][1] - points[0][1], points[1][0] - points[0][0],
    )))

    # Never re-pair the expanded quad for diagnostics or for the expansion
    # record. The warp's corner order is re-sequenced below when the detector's
    # first corner put the card's short pair on the horizontal sides; the
    # expansion itself stays in the caller's order.
    #
    # Geometry is satisfied on the claim; read the pixels for the boundary
    # evidence, then grow the quad outward by the outboard edge it demonstrably
    # missed. Growing can only add background, never remove card, so a shaved
    # claim is corrected where the evidence exists. The evidence is recorded,
    # never a veto: there is no branch below that reads ``support.verdict``.
    support = assess_edge_support(rgb, points)
    warp_points, expansion_px, expansion_clamped = expand_quad_outward(
        points, support, bounds=(float(width), float(height))
    )
    if not _usable_warp_quad(warp_points, points):
        # One side growing far more than its neighbour can fold the quad; keep
        # the claim rather than abstain or warp a self-crossing shape.
        warp_points = list(points)
        expansion_px = [0.0, 0.0, 0.0, 0.0]
        expansion_clamped = [False, False, False, False]
    expansion = expansion_diagnostics(
        warp_points, expansion_px, expansion_clamped
    )

    warp_sides = [
        _distance(warp_points[i], warp_points[(i + 1) % 4]) for i in range(4)
    ]

    # A card is portrait in its own hands, so the longer measured side pair must
    # be the destination's vertical pair (sides 1 and 3). The detector's first
    # corner can fall on any edge, so the supplied/expanded order may put the
    # short pair there; one step of corner rotation swaps the pairing. Only the
    # warp sees this re-sequenced order: boundary diagnostics and the expansion
    # record above stay exactly as supplied and as expanded. Length alone
    # decides, so upright versus 180 degrees remains undecidable without content
    # knowledge.
    pair_a = (warp_sides[0] + warp_sides[2]) / 2.0
    pair_b = (warp_sides[1] + warp_sides[3]) / 2.0
    source_points = list(warp_points)
    source_claims = list(points)
    source_clamped = list(expansion_clamped)
    if pair_b <= pair_a:
        source_points = list(warp_points[3:]) + list(warp_points[:3])
        source_claims = list(points[3:]) + list(points[:3])
        source_clamped = list(expansion_clamped[3:]) + list(expansion_clamped[:3])
        pair_a, pair_b = pair_b, pair_a

    # The card's footprint in the output is the *claim's* measured short and long
    # pairs, not the expanded quad's: deriving the destination size from the
    # grown quad would let an asymmetric expansion change the output aspect,
    # which is a squeeze by another name. The expansion becomes extra area around
    # a card footprint of the claimed size. Inner dimensions are the measured
    # short and long pairs, not a nominal 63:88, so rectification cannot squeeze
    # and the output is portrait with the card's long axis vertical before any
    # pixels are turned (none are).
    claim_sides = [
        _distance(source_claims[i], source_claims[(i + 1) % 4]) for i in range(4)
    ]
    inner_w = (claim_sides[0] + claim_sides[2]) / 2.0
    inner_h = (claim_sides[1] + claim_sides[3]) / 2.0

    # Margins are per side in the warp's own order (0 top, 1 right, 2 bottom,
    # 3 left). A side whose expansion ran into the raster boundary has no source
    # left for a band, so its inset collapses to zero -- otherwise the
    # extrapolated output corner would map outside the raster and a clamped
    # expansion would fail the warp.
    insets = [
        inner_h * margin,
        inner_w * margin,
        inner_h * margin,
        inner_w * margin,
    ]
    for index in range(4):
        if source_clamped[index]:
            insets[index] = 0.0
    inset_left, inset_top = insets[3], insets[0]
    inset_right, inset_bottom = insets[1], insets[2]

    # Express each corner's growth in the card's own axes (u along side 0, v
    # along side 1), so a rotated claim grows out of its own sides rather than
    # out of the raster's. The destination corner is the inner-rect corner plus
    # that growth: the homography maps the expanded corner there while the claim
    # itself lands back on the inner rectangle, so the card is neither squeezed
    # nor moved by the expansion.
    u = _unit(source_claims[0], source_claims[1])
    v = _unit(source_claims[1], source_claims[2])
    determinant = u[0] * v[1] - u[1] * v[0]
    inner = [
        (0.0, 0.0),
        (inner_w, 0.0),
        (inner_w, inner_h),
        (0.0, inner_h),
    ]
    destination_points: list[Point] = []
    for index in range(4):
        dx = source_points[index][0] - source_claims[index][0]
        dy = source_points[index][1] - source_claims[index][1]
        if abs(determinant) < 1e-9:
            du, dv = dx, dy
        else:
            du = (dx * v[1] - dy * v[0]) / determinant
            dv = (u[0] * dy - u[1] * dx) / determinant
        destination_points.append((inner[index][0] + du, inner[index][1] + dv))

    # The output holds the warp quad and at least the inset band around the card
    # footprint. A side grown further than its band takes that space instead of
    # adding a second band on top, so the growth is never double-counted.
    x_min = min(min(x for x, _ in destination_points), -inset_left)
    x_max = max(max(x for x, _ in destination_points), inner_w + inset_right)
    y_min = min(min(y for _, y in destination_points), -inset_top)
    y_max = max(max(y for _, y in destination_points), inner_h + inset_bottom)

    nominal_w = x_max - x_min
    nominal_h = y_max - y_min
    extra_w = max(0.0, nominal_w - (inner_w + inset_left + inset_right))
    extra_h = max(0.0, nominal_h - (inner_h + inset_top + inset_bottom))

    # No upscaling: the card itself is never enlarged.
    limit_w = min(inner_w, float(max_edge))
    limit_h = min(inner_h, float(max_edge))
    scale = min(
        1.0,
        (inner_w + extra_w) / nominal_w if nominal_w else 0.0,
        (inner_h + extra_h) / nominal_h if nominal_h else 0.0,
    )
    out_w = int(round(nominal_w * scale))
    out_h = int(round(nominal_h * scale))
    if out_w < MIN_OUTPUT_PX or out_h < MIN_OUTPUT_PX:
        return Abstained("too_small", f"output {out_w}x{out_h} below {MIN_OUTPUT_PX}px")

    destination = [
        ((x - x_min) * scale, (y - y_min) * scale)
        for x, y in destination_points
    ]
    try:
        coefficients = _homography(destination, source_points)
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

    # The destination is already portrait with the card's long pair vertical,
    # so no post-warp turn is applied. ``turned_cw`` stays 0 for manifest
    # compatibility; nothing rotates the pixels here.
    turned_cw = 0

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
        expansion=expansion,
    )
