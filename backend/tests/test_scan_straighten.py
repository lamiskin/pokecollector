"""Deterministic synthetic tests for services.scan_straighten."""

import json
import math
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

try:
    from services.scan_straighten import (
        SUPPORT_SAMPLES,
        Abstained,
        EdgeSupport,
        Straightened,
        assess_edge_support,
        boundary_diagnostics,
        classify_edge_offset,
        edge_inward_normal,
        edge_signed_offset,
        quad_centroid,
        transform_quad_for_storage,
        try_straighten,
    )
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

DARK = (26, 28, 34)
WHITE = (246, 246, 242)
GREY = (150, 152, 158)


def make_card(width=215, height=300):
    card = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(card)
    draw.rectangle((0, 0, width - 1, height - 1), outline=(4, 4, 4), width=7)
    for top in (70, 132, 194):
        draw.rectangle((18, top, width - 18, top + 26), fill=GREY)
    return card


def rotate_point(x, y, angle_degrees):
    radians = math.radians(angle_degrees)
    return (
        x * math.cos(radians) + y * math.sin(radians),
        -x * math.sin(radians) + y * math.cos(radians),
    )


def make_bordered_card(width=200, height=280):
    """Card stock on a contrasting edge, with a printed border a little inside.

    The outer silhouette is bright card stock, so the claimed edge has real
    contrast; the printed border is parallel and strong, which is exactly the
    structure that must not be mistaken for a competing edge.
    """
    card = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(card)
    draw.rectangle((10, 10, width - 11, height - 11), outline=(4, 4, 4), width=4)
    for top in (70, 132, 194):
        draw.rectangle((24, top, width - 24, top + 26), fill=GREY)
    return card


def make_plain_card(width=200, height=280):
    """Flat card stock: only the silhouette has structure."""
    return Image.new("RGB", (width, height), WHITE)


def make_landscape_card(width=300, height=215):
    """A card captured wider than tall, with its text bands across the width."""
    card = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(card)
    draw.rectangle((0, 0, width - 1, height - 1), outline=(4, 4, 4), width=7)
    for top in (48, 98, 148):
        draw.rectangle((24, top, width - 24, top + 24), fill=GREY)
    return card


def make_sleeved_card(width=220, height=300, sleeve=18):
    """A card inside a top loader: the container's edge is the claim.

    The sleeve material is mid-grey on a dark background, so the container
    silhouette has a real but weaker edge than the card's own dark border just
    inboard of it.
    """
    container = Image.new("RGB", (width + 2 * sleeve, height + 2 * sleeve), (120, 120, 120))
    card = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(card)
    draw.rectangle((0, 0, width - 1, height - 1), outline=(4, 4, 4), width=8)
    for top in (70, 132, 194):
        draw.rectangle((18, top, width - 18, top + 26), fill=GREY)
    container.paste(card, (sleeve, sleeve))
    return container


def make_grid_capture():
    """A landscape card with an equal-spacing square grid of dark lines.

    A uniform scale keeps the row and column spacing equal; a squeeze would
    change their ratio, so the two spacings are a direct distortion check.
    """
    canvas = Image.new("RGB", (360, 270), DARK)
    draw = ImageDraw.Draw(canvas)
    left, top, right, bottom = 24, 23, 335, 246
    draw.rectangle((left, top, right, bottom), fill=WHITE, outline=(0, 0, 0), width=6)
    for x in (left + 52, left + 116, left + 180, left + 244):
        draw.line((x, top + 8, x, bottom - 8), fill=(60, 60, 60), width=3)
    for y in (top + 40, top + 104, top + 168):
        draw.line((left + 8, y, right - 8, y), fill=(60, 60, 60), width=3)
    quad = [(float(left), float(top)), (float(right), float(top)),
            (float(right), float(bottom)), (float(left), float(bottom))]
    return canvas, quad


def line_centres(values, threshold=130.0, skip_fraction=0.15):
    """Centres of contiguous dark runs in a 1-D profile, ignoring the border."""
    start = int(len(values) * skip_fraction)
    stop = len(values) - start
    mask = values[start:stop] < threshold
    centres = []
    run_start = None
    for index, dark in enumerate(mask):
        if dark and run_start is None:
            run_start = index
        elif not dark and run_start is not None:
            centres.append(start + (run_start + index - 1) / 2.0)
            run_start = None
    if run_start is not None:
        centres.append(start + (run_start + len(mask) - 1) / 2.0)
    return centres


def mean_spacing(centres):
    gaps = [b - a for a, b in zip(centres, centres[1:])]
    return sum(gaps) / len(gaps) if gaps else 0.0


def shift_side(quad, index, pixels):
    """Move one side parallel to itself, towards the quad's centroid."""
    p0 = quad[index]
    p1 = quad[(index + 1) % 4]
    cx = sum(x for x, _ in quad) / 4.0
    cy = sum(y for _, y in quad) / 4.0
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy)
    nx, ny = -dy / length, dx / length
    mid = ((p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0)
    if (cx - mid[0]) * nx + (cy - mid[1]) * ny < 0.0:
        nx, ny = -nx, -ny
    moved = {
        index: (p0[0] + nx * pixels, p0[1] + ny * pixels),
        (index + 1) % 4: (p1[0] + nx * pixels, p1[1] + ny * pixels),
    }
    return [moved.get(position, point) for position, point in enumerate(quad)]


def shrink_quad(quad, fraction=0.8):
    cx = sum(x for x, _ in quad) / 4.0
    cy = sum(y for _, y in quad) / 4.0
    return [(cx + (x - cx) * fraction, cy + (y - cy) * fraction) for x, y in quad]


def render_corner_cut(card, canvas_size=(300, 360), offset=(140, 140)):
    """Paste the card so its bottom-right corner runs off the canvas.

    Returns the canvas and a quad that lies wholly inside the raster and
    follows the card on the two visible sides only, which is the Inkay case.
    """
    canvas = Image.new("RGB", canvas_size, DARK)
    canvas.paste(card, offset)
    left = float(offset[0])
    top = float(offset[1])
    quad = [
        (left, top),
        (canvas_size[0] - 60.0, top),        # inside the card, well inside the raster
        (canvas_size[0] - 60.0, canvas_size[1] - 60.0),
        (left, canvas_size[1] - 60.0),
    ]
    return canvas, quad


def render_one_side_cut(card, canvas_size=(300, 400), offset=(60, 160)):
    """Paste the card so only its bottom edge runs off the canvas."""
    canvas = Image.new("RGB", canvas_size, DARK)
    canvas.paste(card, offset)
    left = float(offset[0])
    top = float(offset[1])
    quad = [
        (left, top),
        (left + card.width - 1.0, top),
        (left + card.width - 1.0, canvas_size[1] - 60.0),
        (left, canvas_size[1] - 60.0),
    ]
    return canvas, quad


def render_rotated(card, angle_degrees, canvas_size=(520, 620)):
    canvas = Image.new("RGB", canvas_size, DARK)
    rotated = card.rotate(angle_degrees, expand=True, resample=Image.Resampling.BICUBIC, fillcolor=DARK)
    left = (canvas_size[0] - rotated.width) // 2
    top = (canvas_size[1] - rotated.height) // 2
    canvas.paste(rotated, (left, top))
    cx, cy = canvas_size[0] / 2, canvas_size[1] / 2
    half_w, half_h = card.width / 2, card.height / 2
    local = [(-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)]
    quad = []
    for x, y in local:
        dx, dy = rotate_point(x, y, angle_degrees)
        quad.append((cx + dx, cy + dy))
    return canvas, quad


def edge_means(image):
    arr = np.asarray(image.convert("L"), dtype=float)
    h, w = arr.shape
    band = max(2, int(round(min(h, w) * 0.015)))
    return (
        arr[:band, :].mean(),
        arr[-band:, :].mean(),
        arr[:, :band].mean(),
        arr[:, -band:].mean(),
        arr[band:-band, band:-band].mean(),
    )


class StraightenTests(unittest.TestCase):
    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_tilted_card_is_upright_with_border_and_horizontal_bands(self):
        card = make_card()
        canvas, quad = render_rotated(card, 7)
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertAlmostEqual(result.width / result.height, 63 / 88, delta=0.02 * (63 / 88))
        top, bottom, left, right, centre = edge_means(result.image)
        self.assertLess(top, centre)
        self.assertLess(bottom, centre)
        self.assertLess(left, centre)
        self.assertLess(right, centre)
        gray = np.asarray(result.image.convert("L"), dtype=float)
        self.assertGreater(np.var(gray.mean(axis=1)), np.var(gray.mean(axis=0)))

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_quarter_turns_keep_corner_order(self):
        card = make_card()
        for angle in (90, 180, 270):
            with self.subTest(angle=angle):
                canvas, quad = render_rotated(card, angle)
                result = try_straighten(canvas, quad)
                self.assertIsInstance(result, Straightened)
                self.assertAlmostEqual(result.width / result.height, 63 / 88,
                                       delta=0.02 * (63 / 88))
                top, bottom, left, right, centre = edge_means(result.image)
                for edge in (top, bottom, left, right):
                    self.assertLess(edge, centre)
                gray = np.asarray(result.image.convert("L"), dtype=float)
                self.assertGreater(np.var(gray.mean(axis=1)), np.var(gray.mean(axis=0)))

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_keystone_is_accepted_and_rectangular(self):
        canvas = Image.new("RGB", (440, 420), DARK)
        draw = ImageDraw.Draw(canvas)
        quad = [(120, 60), (318, 60), (335, 360), (103, 360)]
        draw.polygon(quad, fill=WHITE)
        draw.line(quad + [quad[0]], fill=(4, 4, 4), width=7, joint="curve")
        for top, bottom in ((130, 250), (200, 320)):
            left = 120 - (top - 60) * 0.055
            right = 318 + (top - 60) * 0.055
            draw.polygon([(left, top), (right, top), (right + 6, bottom), (left + 6, bottom)], fill=GREY)
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        arr = np.asarray(result.image)
        h, w = arr.shape[:2]
        for y, x in ((int(h * 0.12), int(w * 0.12)), (int(h * 0.12), int(w * 0.88)),
                     (int(h * 0.88), int(w * 0.12)), (int(h * 0.88), int(w * 0.88))):
            self.assertGreater(arr[y, x].mean(), 200)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_margin_includes_darker_background(self):
        canvas, quad = render_rotated(make_card(), 6)
        small = try_straighten(canvas, quad, margin=0.015)
        large = try_straighten(canvas, quad, margin=0.06)
        self.assertIsInstance(small, Straightened)
        self.assertIsInstance(large, Straightened)
        small_edges = edge_means(small.image)[:4]
        large_edges = edge_means(large.image)[:4]
        self.assertTrue(all(value < edge_means(small.image)[4] for value in small_edges))
        self.assertTrue(all(value < edge_means(large.image)[4] for value in large_edges))
        # The outermost band is already fully background at 1.5 %, so the larger
        # margin cannot be darker there; it must not become lighter either.
        self.assertTrue(all(a <= b + 3.0 for a, b in zip(large_edges, small_edges)))

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_abstentions(self):
        canvas, quad = render_rotated(make_card(), 0)
        outside = [(quad[0][0], quad[0][1]), (quad[1][0], quad[1][1]),
                   (quad[2][0], quad[2][1]), (-40, quad[3][1])]
        self.assertEqual(try_straighten(canvas, outside).reason, "out_of_source")

        nonconvex = [(100, 100), (320, 100), (210, 210), (100, 320)]
        self.assertEqual(try_straighten(canvas, nonconvex).reason, "non_convex")

        tiny = [(40, 40), (60, 40), (60, 70), (40, 70)]
        self.assertEqual(try_straighten(Image.new("RGB", (120, 120), WHITE), tiny).reason, "too_small")

        wide = [(80, 100), (280, 100), (230, 300), (130, 300)]
        self.assertEqual(try_straighten(canvas, wide).reason, "bad_shape")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_large_in_plane_tilt_is_accepted(self):
        """The warp levels any angle; there is no tilt policy."""
        canvas, quad = render_rotated(make_card(), 50)
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertAlmostEqual(result.width / result.height, 63 / 88,
                               delta=0.02 * (63 / 88))
        self.assertGreater(abs(result.angle_degrees), 45.0)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_landscape_capture_straightens_upright_into_portrait_with_rotated_content(self):
        """A wider-than-tall quad means the card was held sideways.

        The card is portrait in its own hands, so the longer measured pair must
        become the destination's vertical pair: the output is 63:88 and the
        bands that ran across the landscape capture now run across the tall
        one, i.e. the content arrives rotated by a quarter turn.
        """
        canvas, quad = render_rotated(make_landscape_card(), 5)
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertGreater(result.height, result.width)
        self.assertAlmostEqual(result.width / result.height, 63 / 88,
                               delta=0.02 * (63 / 88))
        top, bottom, left, right, centre = edge_means(result.image)
        for edge in (top, bottom, left, right):
            self.assertLess(edge, centre)
        # Bands across the landscape card become vertical strips once the
        # capture is turned upright, so columns vary more than rows.
        gray = np.asarray(result.image.convert("L"), dtype=float)
        self.assertGreater(np.var(gray.mean(axis=0)), np.var(gray.mean(axis=1)))

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_wide_quad_and_its_quarter_turn_give_the_same_output(self):
        """Pairing follows side length only, so a quad and its 90° turn agree.

        The same card measured once with its long pair horizontal and once with
        it vertical must land on one destination shape; otherwise the output
        would depend on how the detector happened to order the corners.
        """
        def with_quad(quad):
            canvas = Image.new("RGB", (600, 600), DARK)
            ImageDraw.Draw(canvas).polygon(quad, fill=WHITE)
            return canvas

        wide = [(110.0, 210.0), (490.0, 210.0), (490.0, 390.0), (110.0, 390.0)]
        tall = [(210.0, 110.0), (390.0, 110.0), (390.0, 490.0), (210.0, 490.0)]
        wide_result = try_straighten(with_quad(wide), wide)
        tall_result = try_straighten(with_quad(tall), tall)
        for result in (wide_result, tall_result):
            self.assertIsInstance(result, Straightened)
            self.assertGreater(result.height, result.width)
        self.assertEqual(
            (wide_result.width, wide_result.height),
            (tall_result.width, tall_result.height),
        )

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_landscape_capture_turns_pixels_without_squeezing(self):
        """A sideways capture is turned as pixels, never squeezed or re-paired.

        The equal-spacing grid is the distortion check: horizontal and vertical
        spacings must stay equal in the portrait output.
        """
        canvas, quad = make_grid_capture()
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.turned_cw, 90)
        self.assertGreater(result.height, result.width)
        gray = np.asarray(result.image.convert("L"), dtype=float)
        rows = line_centres(gray.mean(axis=1))
        columns = line_centres(gray.mean(axis=0))
        self.assertGreaterEqual(len(rows), 2)
        self.assertGreaterEqual(len(columns), 2)
        row_spacing = mean_spacing(rows)
        column_spacing = mean_spacing(columns)
        self.assertGreater(row_spacing, 0.0)
        self.assertAlmostEqual(
            row_spacing, column_spacing, delta=0.08 * column_spacing
        )

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_portrait_capture_keeps_the_caller_corner_order(self):
        """The warp maps corner 0 to the output top-left; corners are never re-paired."""
        canvas = Image.new("RGB", (300, 400), DARK)
        draw = ImageDraw.Draw(canvas)
        quad = [(60.0, 50.0), (240.0, 50.0), (240.0, 330.0), (60.0, 330.0)]
        draw.polygon(quad, fill=WHITE)
        draw.line(quad + [quad[0]], fill=(4, 4, 4), width=6, joint="curve")
        draw.rectangle((70, 60, 110, 100), fill=(200, 30, 30))
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.turned_cw, 0)
        arr = np.asarray(result.image)
        h, w = arr.shape[:2]
        corner = arr[int(h * 0.10):int(h * 0.25), int(w * 0.10):int(w * 0.30)]
        self.assertGreater(float(corner[..., 0].mean()), 120.0)
        self.assertLess(float(corner[..., 2].mean()), 120.0)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_never_upscales_beyond_card(self):
        canvas, quad = render_rotated(make_card(width=215, height=300), 3)
        result = try_straighten(canvas, quad, margin=0.015, max_edge=2048)
        self.assertIsInstance(result, Straightened)
        self.assertLessEqual(max(result.width, result.height), 300 * (1 + 2 * 0.015) + 2)


class TransformQuadTests(unittest.TestCase):
    """Client upload-space quad -> sanitized raster pixels."""

    UNIT = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_no_turn_only_scales(self):
        self.assertEqual(
            transform_quad_for_storage(self.UNIT, 0, 100, 200),
            [(0.0, 0.0), (100.0, 0.0), (100.0, 200.0), (0.0, 200.0)],
        )

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_clockwise_quarter_turn_moves_top_left_to_top_right(self):
        self.assertEqual(
            transform_quad_for_storage(self.UNIT, 90, 100, 200),
            [(100.0, 0.0), (100.0, 200.0), (0.0, 200.0), (0.0, 0.0)],
        )

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_half_turn_moves_every_corner_opposite(self):
        self.assertEqual(
            transform_quad_for_storage(self.UNIT, 180, 100, 200),
            [(100.0, 200.0), (0.0, 200.0), (0.0, 0.0), (100.0, 0.0)],
        )

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_three_quarter_turn_moves_top_left_to_bottom_left(self):
        self.assertEqual(
            transform_quad_for_storage(self.UNIT, 270, 100, 200),
            [(0.0, 200.0), (0.0, 0.0), (100.0, 0.0), (100.0, 200.0)],
        )


class EdgeSupportTests(unittest.TestCase):
    """Boundary veto: the claimed edge must be an edge the pixels show."""

    def support(self, canvas, quad):
        result = assess_edge_support(canvas, quad)
        self.assertIsInstance(result, EdgeSupport)
        self.assertEqual(len(result.sides), 4)
        self.assertEqual(len(result.competing_sides), 4)
        self.assertEqual(len(result.side_samples), 4)
        self.assertEqual(len(result.side_evidence), 4)
        for item in result.side_evidence:
            for key in (
                "ratio",
                "claimStep",
                "claimPeak",
                "outboardOffset",
                "outboardStrength",
                "inboardOffset",
                "inboardStrength",
                "verdict",
            ):
                self.assertIn(key, item)
        for samples in result.side_samples:
            self.assertEqual(len(samples), SUPPORT_SAMPLES)
            for sample in samples:
                for key in ("offset", "strength", "inboardOffset", "inboardStrength"):
                    self.assertIsInstance(sample[key], float)
        return result

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_clear_border_is_loose_and_straightens(self):
        """Measured: sides [143.8, 101.4, 32.7, 117.4], 4/4 supported.

        The printed border is parallel and strong and lies inboard of the
        claim. Position-based classification reads that as ``loose`` (the claim
        framed something bigger) rather than ``competing``; gradients cannot
        tell a printed frame from sleeve material. The crop is still accepted
        because a loose crop contains the whole card.
        """
        canvas, quad = render_rotated(make_bordered_card(), 6)
        support = self.support(canvas, quad)
        self.assertEqual(support.verdict, "loose")
        self.assertEqual(support.competing_sides, (False, False, False, False))
        for ratio in support.sides:
            self.assertGreaterEqual(ratio, 1.5)
        # The printed border is parallel and strong, yet it is inside the card
        # and must not veto the crop.
        self.assertIsInstance(try_straighten(canvas, quad), Straightened)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_inner_lock_is_shaved_and_still_proposes(self):
        """Measured: sides [0.0, 33.4, 0.0, 33.6], both short sides shaved.

        The boundary verdict is diagnostic now: it records the shave but the
        geometry is valid, so the warp still returns a proposal.
        """
        canvas, quad = render_rotated(make_bordered_card(), 6)
        support = self.support(canvas, quad)
        locked = self.support(canvas, shrink_quad(quad, 0.8))
        self.assertEqual(locked.verdict, "shaved")
        self.assertTrue(any(locked.competing_sides))
        result = try_straighten(canvas, shrink_quad(quad, 0.8))
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.support.verdict, "shaved")
        self.assertIn("sides=", result.support.detail)
        self.assertNotIn("confidence", result.support.detail)
        # The evidence is what stopped the old rule; it no longer withholds.
        self.assertIsInstance(support, EdgeSupport)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_a_single_shaved_side_is_diagnostic(self):
        """One side that cuts inside the card is evidence, not a veto.

        Shifting only the top side 24 px inside the card leaves the claim on
        the printed border (an edge of its own) with the real outer edge
        parallel and outboard of it. That single shaved side is recorded as a
        developer diagnostic, and the warp still proposes a derivative.
        """
        canvas, quad = render_rotated(make_bordered_card(), 6)
        shifted = shift_side(quad, 0, 24)
        support = self.support(canvas, shifted)
        self.assertEqual(support.verdict, "shaved")
        self.assertEqual(support.side_verdicts[0], "shaved")
        self.assertLess(support.side_offsets[0], 0.0)
        result = try_straighten(canvas, shifted)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.support.verdict, "shaved")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_two_shaved_sides_still_propose(self):
        """A quad locked onto the inner frame reports both parallel sides."""
        canvas, quad = render_rotated(make_bordered_card(), 6)
        locked = self.support(canvas, shrink_quad(quad, 0.8))
        self.assertGreaterEqual(sum(locked.competing_sides), 2)
        self.assertEqual(locked.verdict, "shaved")
        result = try_straighten(canvas, shrink_quad(quad, 0.8))
        self.assertIsInstance(result, Straightened)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_sleeved_card_is_loose_and_accepted(self):
        """Claim on a top loader: the card edge is inboard, so accept as loose.

        The crop of the *container* still contains the whole card; it is loose,
        not damaged, so it must not abstain.
        """
        container = make_sleeved_card()
        canvas = Image.new("RGB", (340, 420), DARK)
        offset = ((canvas.width - container.width) // 2,
                  (canvas.height - container.height) // 2)
        canvas.paste(container, offset)
        left = float(offset[0])
        top = float(offset[1])
        quad = [(left, top), (left + container.width - 1.0, top),
                (left + container.width - 1.0, top + container.height - 1.0),
                (left, top + container.height - 1.0)]
        support = self.support(canvas, quad)
        self.assertEqual(support.verdict, "loose")
        self.assertIn("loose", support.side_verdicts)
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.support.verdict, "loose")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_quad_on_inner_print_frame_is_shaved(self):
        """The real card edge is outboard of a printed inner frame claim.

        The outer silhouette is stronger than the printed frame's own edge, so
        the claim cuts inside the card; the outboard offset proves it and the
        proposal is still produced.
        """
        canvas = Image.new("RGB", (320, 400), (10, 10, 10))
        draw = ImageDraw.Draw(canvas)
        outer = (40, 40, 279, 359)
        draw.rectangle(outer, fill=WHITE)
        frame = (52, 52, 267, 347)
        draw.rectangle(frame, outline=(70, 70, 70), width=5)
        quad = [(float(frame[0]), float(frame[1])),
                (float(frame[2]), float(frame[1])),
                (float(frame[2]), float(frame[3])),
                (float(frame[0]), float(frame[3]))]
        support = self.support(canvas, quad)
        self.assertEqual(support.verdict, "shaved")
        self.assertLess(support.side_offsets[0], 0.0)
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.support.verdict, "shaved")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_quad_in_background_is_unsupported_but_proposes(self):
        """Measured: sides [0.0, 0.0, 0.0, 0.0], 0/4 supported."""
        canvas, _ = render_rotated(make_bordered_card(), 6)
        background_quad = [(20, 20), (110, 20), (110, 130), (20, 130)]
        support = self.support(canvas, background_quad)
        self.assertEqual(support.verdict, "unsupported")
        self.assertEqual(support.competing_sides, (False, False, False, False))
        result = try_straighten(canvas, background_quad)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.support.verdict, "unsupported")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_corner_cut_by_the_frame_still_proposes(self):
        """Inkay case: two sides run off the canvas, the quad does not.

        Measured (plain stock): sides [436.0, 0.0, 0.0, 436.0]; the two
        visible sides support, the two cut sides have no edge at all. That is
        developer diagnostics, not a reason to withhold the proposal.
        """
        canvas, quad = render_corner_cut(make_plain_card())
        support = self.support(canvas, quad)
        self.assertEqual(support.verdict, "unsupported")
        self.assertLessEqual(support.sides[1], 1.5)
        self.assertLessEqual(support.sides[2], 1.5)
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.support.verdict, "unsupported")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_single_side_cut_is_diagnostic(self):
        """A card cut along one whole side leaves 3 supported sides.

        The evidence cannot tell this from a valid three-sided claim, so it is
        reported as unsupported; the warp still proposes a derivative.
        """
        canvas, quad = render_one_side_cut(make_plain_card())
        support = self.support(canvas, quad)
        supported = sum(1 for ratio in support.sides if ratio >= 1.5)
        self.assertEqual(supported, 3)
        self.assertEqual(support.verdict, "unsupported")
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.support.verdict, "unsupported")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_boundary_verdict_never_withholds_a_proposal(self):
        canvas, quad = render_rotated(make_bordered_card(), 6)
        locked = shrink_quad(quad, 0.8)
        result = try_straighten(canvas, locked)
        self.assertIsInstance(result, Straightened)
        self.assertEqual(result.support.verdict, "shaved")
        # The removed veto parameter is not silently accepted either.
        with self.assertRaises(TypeError):
            try_straighten(canvas, locked, require_boundary=False)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_assess_is_pure_and_handles_a_bad_quad(self):
        canvas, quad = render_rotated(make_bordered_card(), 6)
        before = np.asarray(canvas, dtype=np.uint8).copy()
        bad = assess_edge_support(canvas, [(0, 0), (1, 1)])
        self.assertEqual(bad.verdict, "unsupported")
        self.assertTrue(np.array_equal(np.asarray(canvas, dtype=np.uint8), before))
        self.assertIsInstance(assess_edge_support(canvas, quad), EdgeSupport)


class SignConventionTests(unittest.TestCase):
    """Prove inboard/outboard from geometry alone, with no image evidence.

    ``edge_inward_normal`` must point toward the quad centroid for every
    ordered edge, in both windings and under rotation/skew/keystone. These
    tests are the proof the pipeline's signed offsets rely on.
    """

    CW = [(40.0, 30.0), (260.0, 30.0), (260.0, 390.0), (40.0, 390.0)]
    # A sheared parallelogram and a strong keystone (narrow top, wide bottom).
    SKEW = [(80.0, 60.0), (300.0, 60.0), (360.0, 380.0), (140.0, 380.0)]
    KEYSTONE = [(150.0, 40.0), (250.0, 40.0), (330.0, 400.0), (70.0, 400.0)]

    @staticmethod
    def _rotated(quad, angle_degrees):
        cx = sum(x for x, _ in quad) / 4.0
        cy = sum(y for _, y in quad) / 4.0
        return [
            (cx + dx, cy + dy)
            for dx, dy in (
                rotate_point(x - cx, y - cy, angle_degrees) for x, y in quad
            )
        ]

    @staticmethod
    def _point_at(quad, side, distance):
        p0 = quad[side]
        p1 = quad[(side + 1) % 4]
        nx, ny = edge_inward_normal(p0, p1, quad_centroid(quad))
        mid = ((p0[0] + p1[0]) / 2.0, (p0[1] + p1[1]) / 2.0)
        return (mid[0] + nx * distance, mid[1] + ny * distance)

    def _assert_all_sides(self, quad):
        for side in range(4):
            with self.subTest(side=side, quad=quad):
                inside = self._point_at(quad, side, 20.0)
                outside = self._point_at(quad, side, -20.0)
                self.assertGreater(edge_signed_offset(quad, side, inside), 0.0)
                self.assertLess(edge_signed_offset(quad, side, outside), 0.0)
                self.assertEqual(classify_edge_offset(quad, side, inside), "inboard")
                self.assertEqual(classify_edge_offset(quad, side, outside), "outboard")
                midpoint = self._point_at(quad, side, 0.0)
                self.assertEqual(classify_edge_offset(quad, side, midpoint), "on")

    def test_all_sides_both_windings(self):
        self._assert_all_sides(self.CW)
        self._assert_all_sides(list(reversed(self.CW)))

    def test_rotated_skewed_and_keystone_quads(self):
        self._assert_all_sides(self._rotated(self.CW, 25))
        self._assert_all_sides(self._rotated(self.CW, 25)[::-1])
        self._assert_all_sides(self.SKEW)
        self._assert_all_sides(list(reversed(self.SKEW)))
        self._assert_all_sides(self.KEYSTONE)
        self._assert_all_sides(list(reversed(self.KEYSTONE)))

    def test_same_physical_point_answers_the_same_in_both_windings(self):
        cw = self.CW
        ccw = list(reversed(cw))
        for side in range(4):
            with self.subTest(side=side):
                # The same geometric edge reversed in the CCW ordering.
                first = cw[side]
                second = cw[(side + 1) % 4]
                ccw_side = next(
                    index
                    for index in range(4)
                    if ccw[index] == second and ccw[(index + 1) % 4] == first
                )
                for distance, expected in ((15.0, "inboard"), (-15.0, "outboard")):
                    point = self._point_at(cw, side, distance)
                    cw_answer = classify_edge_offset(cw, side, point)
                    ccw_answer = classify_edge_offset(ccw, ccw_side, point)
                    self.assertEqual(cw_answer, expected)
                    self.assertEqual(ccw_answer, expected)
                    self.assertEqual(cw_answer, ccw_answer)


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
TAUROS_FIXTURE = FIXTURE_DIR / "straighten_tauros_88744406.json"


def load_tauros_fixture():
    return json.loads(TAUROS_FIXTURE.read_text())


def tauros_support(data):
    """Rebuild the recorded Tauros diagnostics without the source JPEG."""
    measured = data["measured"]
    return EdgeSupport(
        verdict=measured["verdict"],
        sides=tuple(measured["sideRatios"]),
        competing_sides=tuple(value == "shaved" for value in measured["sideVerdicts"]),
        detail="recorded fixture",
        side_verdicts=tuple(measured["sideVerdicts"]),
        side_offsets=tuple(measured["sideOffsets"]),
        side_samples=tuple(
            tuple(dict(sample) for sample in samples)
            for samples in measured["sideSamples"]
        ),
        side_evidence=tuple(dict(item) for item in measured["sideEvidence"]),
    )


def fixture_pixel_quad(data):
    width = data["raster"]["width"]
    height = data["raster"]["height"]
    return [(u * width, v * height) for u, v in data["geometry"]["quad"]]


class TaurosBoundaryRegressionTests(unittest.TestCase):
    """The 88744406 failure, replayed from recorded numbers, not the image.

    The source JPEG is deliberately not committed. The fixture carries the
    geometry and the measured per-sample offsets so the case stays
    reproducible after the capture is gone.
    """

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_diagnostics_report_the_outboard_edge_with_its_real_offsets(self):
        data = load_tauros_fixture()
        diagnostics = boundary_diagnostics(tauros_support(data))

        self.assertEqual(diagnostics["verdict"], "loose")
        self.assertNotIn("confidence", diagnostics)
        self.assertEqual(
            diagnostics["sideVerdicts"], ["loose", "tight", "tight", "loose"]
        )
        # The real per-sample outboard offsets survive into the manifest shape.
        self.assertEqual(diagnostics["sideSamples"][0][0]["offset"], -12.0)
        self.assertEqual(diagnostics["sideSamples"][0][2]["offset"], -44.0)
        self.assertEqual(diagnostics["sideSamples"][0][3]["offset"], -24.0)
        self.assertEqual(diagnostics["sideSamples"][3][0]["offset"], -25.0)
        self.assertEqual(diagnostics["sideSamples"][3][1]["offset"], -45.0)
        # Each side also carries the aggregate outboard peak that was measured,
        # even where the verdict did not use it (the Tauros crop read as loose).
        self.assertEqual(
            [item["outboardOffset"] for item in diagnostics["sideEvidence"]],
            [-3.0, -3.0, -11.0, -25.0],
        )
        for item in diagnostics["sideEvidence"]:
            self.assertGreater(item["outboardStrength"], 0.0)
            # The outboard edge was real but weaker than the claimed edge, which
            # is exactly why diagnostics must report it and not call it a shave.
            self.assertLess(item["outboardStrength"], item["claimPeak"])
        self.assertEqual(diagnostics["shavedSides"], [])

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_recorded_diagnostics_cannot_withhold_a_technically_valid_crop(self):
        data = load_tauros_fixture()
        support = tauros_support(data)
        quad = fixture_pixel_quad(data)
        canvas = Image.new(
            "RGB", (data["raster"]["width"], data["raster"]["height"]), WHITE
        )

        with patch(
            "services.scan_straighten.assess_edge_support", return_value=support
        ):
            result = try_straighten(canvas, quad)

        self.assertIsInstance(result, Straightened)
        self.assertIs(result.support, support)
        self.assertGreater(result.width, 0)
        self.assertGreater(result.height, 0)
        # The diagnostics stay attached and still report no confidence label.
        diagnostics = boundary_diagnostics(result.support)
        self.assertEqual(diagnostics["verdict"], "loose")
        self.assertNotIn("confidence", diagnostics)


class SyntheticBoundaryDirectionTests(unittest.TestCase):
    """Direction and coordinate tests beyond the sign convention.

    Each case asserts what the pixels contain. A shave is reported when a
    stronger outboard edge exists; a weak real outboard edge is still reported
    in the side evidence but is not promoted to a shave.
    """

    @staticmethod
    def _on_dark(card, offset=(50, 60)):
        left, top = float(offset[0]), float(offset[1])
        canvas = Image.new(
            "RGB", (int(left) + card.width + 50, int(top) + card.height + 50), DARK
        )
        canvas.paste(card, (int(left), int(top)))
        quad = [
            (left, top),
            (left + card.width - 1.0, top),
            (left + card.width - 1.0, top + card.height - 1.0),
            (left, top + card.height - 1.0),
        ]
        return canvas, quad

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_known_correct_quad_reports_the_claim_as_tight(self):
        canvas, quad = self._on_dark(make_plain_card())
        support = assess_edge_support(canvas, quad)
        self.assertEqual(support.verdict, "ok")
        self.assertEqual(support.side_verdicts, ("tight",) * 4)
        self.assertTrue(all(item["outboardStrength"] < 8.0 for item in support.side_evidence))

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_expanded_quad_reports_the_card_edge_inboard_as_loose(self):
        canvas, quad = self._on_dark(make_plain_card())
        expanded = shrink_quad(quad, 1.10)
        support = assess_edge_support(canvas, expanded)
        self.assertEqual(support.verdict, "loose")
        self.assertNotIn("shaved", support.side_verdicts)
        self.assertTrue(any(item["inboardOffset"] > 0.0 for item in support.side_evidence))
        self.assertTrue(
            any(item["inboardStrength"] >= 8.0 for item in support.side_evidence)
        )

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_contracted_quad_reports_the_card_edge_outboard_as_shaved(self):
        canvas, quad = self._on_dark(make_plain_card())
        contracted = shrink_quad(quad, 0.90)
        support = assess_edge_support(canvas, contracted)
        self.assertEqual(support.verdict, "shaved")
        for item in support.side_evidence:
            self.assertLess(item["outboardOffset"], 0.0)
            self.assertGreaterEqual(item["outboardStrength"], 8.0)
            self.assertGreater(item["outboardStrength"], item["claimPeak"])

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_skewed_quad_keeps_the_claim_direction(self):
        skew = [(80.0, 60.0), (300.0, 60.0), (360.0, 380.0), (140.0, 380.0)]
        canvas = Image.new("RGB", (440, 440), DARK)
        draw = ImageDraw.Draw(canvas)
        draw.polygon(skew, fill=WHITE)
        draw.line(skew + [skew[0]], fill=(4, 4, 4), width=6, joint="curve")
        support = assess_edge_support(canvas, skew)
        self.assertEqual(support.verdict, "ok")
        self.assertNotIn("shaved", support.side_verdicts)
        self.assertTrue(all(abs(item["outboardOffset"]) < 20.0 for item in support.side_evidence))

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_rotated_quad_keeps_the_claim_direction(self):
        canvas, quad = render_rotated(make_plain_card(), 28)
        support = assess_edge_support(canvas, quad)
        self.assertEqual(support.verdict, "ok")
        self.assertNotIn("shaved", support.side_verdicts)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_perspective_quad_keeps_the_claim_direction(self):
        quad = [(150.0, 40.0), (250.0, 40.0), (330.0, 400.0), (70.0, 400.0)]
        canvas = Image.new("RGB", (400, 440), DARK)
        draw = ImageDraw.Draw(canvas)
        draw.polygon(quad, fill=WHITE)
        draw.line(quad + [quad[0]], fill=(4, 4, 4), width=6, joint="curve")
        support = assess_edge_support(canvas, quad)
        self.assertEqual(support.verdict, "ok")
        self.assertNotIn("shaved", support.side_verdicts)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_stronger_printed_interior_edge_is_inboard_not_shaved(self):
        canvas, quad = self._on_dark(make_bordered_card())
        support = assess_edge_support(canvas, quad)
        self.assertEqual(support.verdict, "loose")
        self.assertNotIn("shaved", support.side_verdicts)
        self.assertTrue(any(item["inboardOffset"] > 0.0 for item in support.side_evidence))
        self.assertTrue(
            any(item["inboardStrength"] >= item["claimPeak"] for item in support.side_evidence)
        )

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_weak_exterior_boundary_is_reported_but_never_called_a_shave(self):
        """A real outboard edge weaker than the claim is evidence, not a shave."""
        canvas = Image.new("RGB", (360, 440), (160, 160, 160))
        draw = ImageDraw.Draw(canvas)
        # Weak exterior: white card stock on mid-grey background.
        draw.rectangle((40, 40, 279, 399), fill=WHITE)
        # Strong printed border, inboard of the real card edge.
        frame = (56, 56, 263, 383)
        draw.rectangle(frame, outline=(10, 10, 10), width=6)
        quad = [
            (float(frame[0]), float(frame[1])),
            (float(frame[2]), float(frame[1])),
            (float(frame[2]), float(frame[3])),
            (float(frame[0]), float(frame[3])),
        ]
        support = assess_edge_support(canvas, quad)
        self.assertNotEqual(support.verdict, "shaved")
        outer = support.side_evidence[0]
        # The exterior edge is 22 px outboard and is actually visible; the
        # diagnostics must report it even though it is weaker than the claim.
        self.assertLess(outer["outboardOffset"], -10.0)
        self.assertGreaterEqual(outer["outboardStrength"], 8.0)
        self.assertGreater(outer["claimPeak"], outer["outboardStrength"])


class ConfigIdentityTests(unittest.TestCase):
    """The manifest's algorithm identity must follow the live rules."""

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_config_digest_changes_when_a_threshold_changes(self):
        from services import scan_straighten

        baseline = scan_straighten.straighten_config_digest()
        self.assertEqual(len(baseline), 64)
        int(baseline, 16)
        with patch.object(scan_straighten, "SUPPORT_RATIO", 1.4):
            self.assertNotEqual(scan_straighten.straighten_config_digest(), baseline)
        with patch.object(scan_straighten, "SHAVE_RATIO", 1.3):
            self.assertNotEqual(scan_straighten.straighten_config_digest(), baseline)
        with patch.object(scan_straighten, "MIN_STEP", 9.0):
            self.assertNotEqual(scan_straighten.straighten_config_digest(), baseline)
        self.assertEqual(scan_straighten.straighten_config_digest(), baseline)


if __name__ == "__main__":
    unittest.main()
