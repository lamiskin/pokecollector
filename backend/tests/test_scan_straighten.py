"""Deterministic synthetic tests for services.scan_straighten."""

import math
import unittest

import numpy as np
from PIL import Image, ImageDraw

try:
    from services.scan_straighten import Abstained, Straightened, try_straighten
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

        tilted, tilted_quad = render_rotated(make_card(), 50)
        self.assertEqual(try_straighten(tilted, tilted_quad).reason, "tilt_exceeded")

        wide = [(80, 100), (280, 100), (230, 300), (130, 300)]
        self.assertEqual(try_straighten(canvas, wide).reason, "bad_shape")

    @unittest.skipUnless(DEPS_AVAILABLE, "Pillow/numpy unavailable")
    def test_never_upscales_beyond_card(self):
        canvas, quad = render_rotated(make_card(width=215, height=300), 3)
        result = try_straighten(canvas, quad, margin=0.015, max_edge=2048)
        self.assertIsInstance(result, Straightened)
        self.assertLessEqual(max(result.width, result.height), 300 * (1 + 2 * 0.015) + 2)


if __name__ == "__main__":
    unittest.main()
