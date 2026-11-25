"""Straighten and crop a card quad from a supplied RGB raster.

Pure helper: no database, storage or scan-queue coupling. The caller supplies
four pixel-space points in clockwise order; the helper returns an upright RGB
card with a small margin, or an explanation for abstaining.

The warp is a projective destination->source homography solved with numpy.
``Image.Transform.QUAD`` is intentionally not used: it interpolates the quad
bilinearly rather than inverting the projective transform, which bends card
edges on perspective photographs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence, Tuple

import numpy as np
from PIL import Image

CARD_ASPECT = 63.0 / 88.0
MIN_SIDE_PX = 8.0
MIN_ANGLE = 45.0
MAX_ANGLE = 135.0
MAX_OPPOSING_RATIO = 1.5
MIN_OUTPUT_PX = 32


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
