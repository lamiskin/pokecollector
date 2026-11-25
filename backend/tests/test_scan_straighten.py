"""Deterministic synthetic tests for services.scan_straighten."""

import math
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

try:
    from services.scan_straighten import (
        Abstained,
        EdgeSupport,
        Straightened,
        assess_edge_support,
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
        return result

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_clear_border_is_ok_and_straightens(self):
        """Measured: sides [143.8, 101.4, 32.7, 117.4], 4/4 supported."""
        canvas, quad = render_rotated(make_bordered_card(), 6)
        support = self.support(canvas, quad)
        self.assertEqual(support.verdict, "ok")
        self.assertEqual(support.competing_sides, (False, False, False, False))
        for ratio in support.sides:
            self.assertGreaterEqual(ratio, 1.5)
        # The printed border is parallel and strong, yet it is inside the card
        # and must not be mistaken for a competing edge.
        self.assertIsInstance(try_straighten(canvas, quad), Straightened)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_inner_lock_is_competing_and_abstains(self):
        """Measured: sides [0.0, 33.4, 0.0, 33.6], both short sides competing."""
        canvas, quad = render_rotated(make_bordered_card(), 6)
        support = self.support(canvas, quad)
        locked = self.support(canvas, shrink_quad(quad, 0.8))
        self.assertEqual(locked.verdict, "competing")
        self.assertTrue(any(locked.competing_sides))
        result = try_straighten(canvas, shrink_quad(quad, 0.8))
        self.assertIsInstance(result, Abstained)
        self.assertEqual(result.reason, "boundary_competing")
        self.assertIn("sides=", result.detail)
        # The veto is what stops it: the geometry itself is acceptable.
        self.assertIsInstance(support, EdgeSupport)

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_a_single_competing_side_vetoes(self):
        """One side with no edge of its own and a real edge nearby abstains.

        Shifting only the top side 24 px inside the card leaves the claim on
        the printed border (no edge of its own) with the real outer edge
        parallel to it. Under the strict rule that single competing side is a
        veto: the crop would shave the top of the card.
        """
        canvas, quad = render_rotated(make_bordered_card(), 6)
        shifted = shift_side(quad, 0, 24)
        support = self.support(canvas, shifted)
        self.assertEqual(sum(support.competing_sides), 1)
        self.assertEqual(support.verdict, "competing")
        result = try_straighten(canvas, shifted)
        self.assertIsInstance(result, Abstained)
        self.assertEqual(result.reason, "boundary_competing")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_two_competing_sides_still_veto(self):
        """A quad locked onto the inner frame competes on both parallel sides."""
        canvas, quad = render_rotated(make_bordered_card(), 6)
        locked = self.support(canvas, shrink_quad(quad, 0.8))
        self.assertGreaterEqual(sum(locked.competing_sides), 2)
        self.assertEqual(locked.verdict, "competing")
        result = try_straighten(canvas, shrink_quad(quad, 0.8))
        self.assertEqual(result.reason, "boundary_competing")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_quad_in_background_is_unsupported(self):
        """Measured: sides [0.0, 0.0, 0.0, 0.0], 0/4 supported."""
        canvas, _ = render_rotated(make_bordered_card(), 6)
        background_quad = [(20, 20), (110, 20), (110, 130), (20, 130)]
        support = self.support(canvas, background_quad)
        self.assertEqual(support.verdict, "unsupported")
        self.assertEqual(support.competing_sides, (False, False, False, False))
        result = try_straighten(canvas, background_quad)
        self.assertIsInstance(result, Abstained)
        self.assertEqual(result.reason, "boundary_unsupported")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_corner_cut_by_the_frame_is_abstained(self):
        """Inkay case: two sides run off the canvas, the quad does not.

        Measured (plain stock): sides [436.0, 0.0, 0.0, 436.0]; the two
        visible sides support, the two cut sides have no edge at all.
        """
        canvas, quad = render_corner_cut(make_plain_card())
        support = self.support(canvas, quad)
        self.assertEqual(support.verdict, "unsupported")
        self.assertLessEqual(support.sides[1], 1.5)
        self.assertLessEqual(support.sides[2], 1.5)
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Abstained)
        self.assertEqual(result.reason, "boundary_unsupported")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_single_side_cut_abstains_under_the_all_four_rule(self):
        """A card cut along one whole side leaves 3 supported sides and abstains.

        The all-four rule exists because this case is otherwise indistinguishable
        from a valid three-sided claim: straightening it would shave the card,
        while abstaining only keeps the padded photo, which is a fine capture.
        """
        canvas, quad = render_one_side_cut(make_plain_card())
        support = self.support(canvas, quad)
        supported = sum(1 for ratio in support.sides if ratio >= 1.5)
        self.assertEqual(supported, 3)
        self.assertEqual(support.verdict, "unsupported")
        result = try_straighten(canvas, quad)
        self.assertIsInstance(result, Abstained)
        self.assertEqual(result.reason, "boundary_unsupported")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_require_boundary_false_restores_the_old_behaviour(self):
        canvas, quad = render_rotated(make_bordered_card(), 6)
        locked = shrink_quad(quad, 0.8)
        self.assertEqual(try_straighten(canvas, locked).reason, "boundary_competing")
        self.assertIsInstance(
            try_straighten(canvas, locked, require_boundary=False), Straightened
        )

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_assess_is_pure_and_handles_a_bad_quad(self):
        canvas, quad = render_rotated(make_bordered_card(), 6)
        before = np.asarray(canvas, dtype=np.uint8).copy()
        bad = assess_edge_support(canvas, [(0, 0), (1, 1)])
        self.assertEqual(bad.verdict, "unsupported")
        self.assertTrue(np.array_equal(np.asarray(canvas, dtype=np.uint8), before))
        self.assertIsInstance(assess_edge_support(canvas, quad), EdgeSupport)


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
        with patch.object(scan_straighten, "COMPETE_RATIO", 3.0):
            self.assertNotEqual(scan_straighten.straighten_config_digest(), baseline)
        with patch.object(scan_straighten, "MIN_STEP", 9.0):
            self.assertNotEqual(scan_straighten.straighten_config_digest(), baseline)
        self.assertEqual(scan_straighten.straighten_config_digest(), baseline)


if __name__ == "__main__":
    unittest.main()
