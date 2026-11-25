"""Straighten and crop a card quad from a supplied RGB raster.

Pure helper: no database, storage or scan-queue coupling. The caller supplies
four pixel-space points in clockwise order; the helper returns an upright RGB
card with a small margin, or an explanation for abstaining.

The warp is a projective destination->source homography solved with numpy.
``Image.Transform.QUAD`` is intentionally not used: it interpolates the quad
bilinearly rather than inverting the projective transform, which bends card
edges on perspective photographs.

Geometry alone cannot tell whether the supplied quad is the card's boundary.
``assess_edge_support`` reads a 1-D gradient profile normal to each claimed
side and vetoes the warp when any of the four claims has no edge of its own
(a card cut by the frame) or when a stronger parallel edge sits off the claim
(a quad locked onto a loader lip, a printed inner frame or inner artwork).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence, Tuple

import numpy as np
from PIL import Image

HELPER_VERSION = "v1"

CARD_ASPECT = 63.0 / 88.0
MIN_SIDE_PX = 8.0
MIN_ANGLE = 45.0
MAX_ANGLE = 135.0
MAX_OPPOSING_RATIO = 1.5
MIN_OUTPUT_PX = 32

# Boundary-support thresholds; see assess_edge_support for the method.
MIN_STEP = 8.0          # grey levels: minimum contrast across the claimed line
SUPPORT_RATIO = 1.5     # claimed response / median inward response
COMPETE_RATIO = 1.5     # parallel response / claimed response
_RATIO_EPS = 0.5        # keeps a flat profile from dividing by zero


@dataclass(frozen=True)
class Straightened:
    image: Image.Image
    width: int
    height: int
    margin_fraction: float
    angle_degrees: float
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class Abstained:
    reason: str
    detail: str


@dataclass(frozen=True)
class EdgeSupport:
    verdict: str                  # "ok" | "unsupported" | "competing"
    sides: tuple[float, ...]      # per-side support ratio, 4 values
    competing_sides: tuple[bool, ...]
    detail: str


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


def assess_edge_support(
    rgb: Image.Image,
    quad: Sequence[Tuple[float, float]],
    *,
    samples: int = 7,
    band_px: int = 6,
    inward_frac: float = 0.10,
) -> EdgeSupport:
    """Decide whether the supplied quad actually sits on the card's boundary.

    Method (pure, numpy only):

    * Convert to greyscale once and take ``samples`` points along each side
      between 10 % and 90 % of its length, so the rounded corners do not vote.
    * At each point, sample the image along the side's inward normal (oriented
      towards the quad centroid) at integer pixel offsets. ``band_px`` is the
      support band around the claimed line; the competing search reaches
      ``inward_frac`` of the side length, floored at ``band_px`` and capped at
      a quarter of the raster, in *both* directions: a quad locked inside the
      card has the real edge outboard of the claim, while a quad around a
      loader lip or printed inner frame has it inboard.
    * Average the per-position profiles and take the absolute central
      difference; that is the response profile.

    Per side the numbers that matter are the step contrast across the claimed
    line (the largest band-mean difference over band widths 1..``band_px``
    either side), the median response inside the card, and the strongest
    parallel response anywhere else in the profile. The reported per-side
    support ratio is the first divided by the second.

    A side is **supported** when the step contrast is at least ``MIN_STEP``
    grey levels (a genuinely flat profile is not an edge) and the support ratio
    is at least ``SUPPORT_RATIO``. Widest-band comparison gives the claim a
    +-``band_px`` tolerance, which a rotated or antialiased edge needs.

    A side is **competing** when the step contrast is below ``MIN_STEP`` (no
    edge of its own) and a parallel response elsewhere in the profile exceeds
    ``COMPETE_RATIO`` times the step (floored at ``MIN_STEP``, so a flat claim
    needs a parallel response above 12 grey levels): the claim is inside the
    card and a real edge lies off it.

    Verdict: ``competing`` if any side is competing, else ``unsupported`` if
    any of the four sides is unsupported, else ``ok``. Requiring all four is
deliberate: a card cut along one whole side looks exactly like a valid
three-sided claim, and straightening a shaved card loses card content, while
abstaining only leaves the padded photo in place.

    Limitation: a quad sitting on a top-loader's *outer* silhouette is
    pixel-identical to a card with a thick dark border, so this method passes
    it; catching that case needs material/colour knowledge, not gradients.
    """
    try:
        points = [(float(x), float(y)) for x, y in quad]
    except (TypeError, ValueError):
        empty = (0.0, 0.0, 0.0, 0.0)
        return EdgeSupport("unsupported", empty, (False,) * 4, "quad is not measurable")
    if len(points) != 4 or not all(
        math.isfinite(x) and math.isfinite(y) for x, y in points
    ):
        empty = (0.0, 0.0, 0.0, 0.0)
        return EdgeSupport("unsupported", empty, (False,) * 4, "quad is not measurable")

    gray = np.asarray(rgb.convert("L"), dtype=float)
    height, width = gray.shape
    if width < 3 or height < 3:
        empty = (0.0, 0.0, 0.0, 0.0)
        return EdgeSupport("unsupported", empty, (False,) * 4, f"raster {width}x{height}")

    centroid = (sum(x for x, _ in points) / 4.0, sum(y for _, y in points) / 4.0)
    reach_cap = max(band_px, int(round(0.25 * min(width, height))))
    count = max(2, int(samples))
    step_count = max(1, int(band_px))

    ratios: list[float] = []
    competing: list[bool] = []
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
            notes.append(f"s{index}:degenerate")
            continue
        ux, uy = dx / length, dy / length
        nx, ny = -uy, ux
        mid = ((p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0)
        if (centroid[0] - mid[0]) * nx + (centroid[1] - mid[1]) * ny < 0.0:
            nx, ny = -nx, -ny

        reach = int(min(max(step_count, round(inward_frac * length)), reach_cap))
        reach = max(1, reach)
        offsets = np.arange(-reach, reach + 1, dtype=float)
        profile = np.zeros(offsets.shape, dtype=float)
        for sample in range(count):
            fraction = 0.10 + 0.80 * (sample / (count - 1))
            bx = p0[0] + dx * fraction
            by = p0[1] + dy * fraction
            for slot, offset in enumerate(offsets):
                profile[slot] += _bilinear(gray, bx + nx * offset, by + ny * offset)
        profile /= float(count)

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

        # A competing edge must be a separate parallel edge, not the near side
        # of the claimed transition itself, so the +-2 px claim window is
        # excluded.
        parallel = np.abs(np.concatenate((response[:max(0, zero - 2)],
                                          response[zero + 3:])))
        parallel_peak = float(parallel.max()) if parallel.size else 0.0
        is_competing = (
            claim_step < MIN_STEP
            and parallel_peak > COMPETE_RATIO * max(claim_step, MIN_STEP)
        )

        if supported:
            supported_count += 1
        ratios.append(round(ratio, 3))
        competing.append(bool(is_competing))
        notes.append(
            f"s{index}:ratio={ratio:.2f},step={claim_step:.0f},"
            f"peak={parallel_peak:.0f}"
        )

    if any(competing):
        verdict = "competing"
    elif supported_count < 4:
        verdict = "unsupported"
    else:
        verdict = "ok"

    detail = (
        f"{verdict}: {supported_count}/4 sides supported; "
        f"sides={[round(value, 2) for value in ratios]}; "
        f"competing={[i for i, flag in enumerate(competing) if flag]}; "
        + "; ".join(notes)
    )
    return EdgeSupport(verdict, tuple(ratios), tuple(competing), detail)


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
    max_tilt_degrees: float = 45.0,
    require_boundary: bool = True,
) -> Straightened | Abstained:
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

    raw_tilt = _normalise_tilt(math.degrees(math.atan2(
        points[1][1] - points[0][1], points[1][0] - points[0][0],
    )))
    # A card that is almost sideways is best treated as a quarter turn of the
    # supplied order; the transform still maps the card top edge to horizontal.
    if abs(raw_tilt) >= 80.0:
        tilt = 0.0
    else:
        tilt = raw_tilt
    if abs(tilt) > max_tilt_degrees:
        return Abstained("tilt_exceeded", f"tilt {tilt:.1f} degrees")

    measured_w = min(sides[0], sides[2])
    measured_h = min(sides[1], sides[3])
    inner_h = min(measured_h, measured_w / CARD_ASPECT)
    inner_w = CARD_ASPECT * inner_h
    out_w = inner_w * (1.0 + 2.0 * margin)
    out_h = inner_h * (1.0 + 2.0 * margin)

    limit_w = min(measured_w, float(max_edge))
    limit_h = min(measured_h, float(max_edge))
    scale = min(1.0, limit_w / out_w if out_w else 0.0, limit_h / out_h if out_h else 0.0)
    out_w = int(round(out_w * scale))
    out_h = int(round(out_h * scale))
    if out_w < MIN_OUTPUT_PX or out_h < MIN_OUTPUT_PX:
        return Abstained("too_small", f"output {out_w}x{out_h} below {MIN_OUTPUT_PX}px")

    # Geometry is satisfied; ask the pixels whether the claim is really the
    # card's boundary before paying for the warp.
    if require_boundary:
        support = assess_edge_support(rgb, points)
        if support.verdict != "ok":
            reason = (
                "boundary_competing" if support.verdict == "competing"
                else "boundary_unsupported"
            )
            return Abstained(reason, support.detail)

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
    )
