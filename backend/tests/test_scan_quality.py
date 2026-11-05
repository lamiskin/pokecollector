import io
import unittest

try:
    from PIL import Image, ImageDraw, ImageFilter

    from services.scan_quality import (
        BLUR_THRESHOLD,
        MULTI_CARD,
        ROTATED_90,
        ROTATED_180,
        ROTATED_270,
        ROTATION_ORIENTATIONS,
        UPRIGHT,
        ScanQuality,
        assess_image_quality,
        correct_orientation,
    )

    DEPS_AVAILABLE = True
except ImportError:  # pragma: no cover - Pillow is a backend dependency
    DEPS_AVAILABLE = False


def _card_image(width: int, height: int) -> "Image.Image":
    """A rectangle with a bright border and repeated lines, resembling a card."""
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle(
        [2, 2, width - 3, height - 3],
        outline="black",
        width=max(2, min(width, height) // 50),
    )
    for y in range(10, height - 10, 24):
        draw.line([10, y, width - 10, y + 8], fill=(30, 30, 30), width=2)
    return image


def _encoded(image: "Image.Image", quality: int = 95) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


def _decoded_size(image_bytes: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(image_bytes)) as image:
        return image.size


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow is not installed")
class ScanQualityOrientationTests(unittest.TestCase):
    def test_portrait_card_is_classified_upright(self):
        quality = assess_image_quality(_encoded(_card_image(600, 840)))

        self.assertEqual(quality.orientation, UPRIGHT)
        self.assertEqual((quality.width, quality.height), (600, 840))
        self.assertAlmostEqual(quality.aspect_ratio, 600 / 840, places=4)

    def test_sideways_card_is_classified_rotated_90(self):
        quality = assess_image_quality(_encoded(_card_image(840, 600)))

        self.assertEqual(quality.orientation, ROTATED_90)
        self.assertAlmostEqual(quality.aspect_ratio, 1.4, places=4)

    def test_rotation_band_boundaries(self):
        self.assertEqual(
            assess_image_quality(_encoded(_card_image(1150, 1000))).orientation,
            ROTATED_90,
        )
        self.assertEqual(
            assess_image_quality(_encoded(_card_image(2200, 1000))).orientation,
            ROTATED_90,
        )
        self.assertEqual(
            assess_image_quality(_encoded(_card_image(2201, 1000))).orientation,
            MULTI_CARD,
        )

    def test_very_wide_and_very_tall_photos_are_multi_card(self):
        self.assertEqual(
            assess_image_quality(_encoded(_card_image(1600, 600))).orientation,
            MULTI_CARD,
        )
        self.assertEqual(
            assess_image_quality(_encoded(_card_image(400, 1200))).orientation,
            MULTI_CARD,
        )

    def test_rotation_labels_are_the_rotation_set(self):
        self.assertEqual(
            ROTATION_ORIENTATIONS, {ROTATED_90, ROTATED_180, ROTATED_270}
        )
        self.assertNotIn(UPRIGHT, ROTATION_ORIENTATIONS)
        self.assertNotIn(MULTI_CARD, ROTATION_ORIENTATIONS)


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow is not installed")
class ScanQualitySharpnessTests(unittest.TestCase):
    def test_sharp_synthetic_card_is_not_blurred(self):
        quality = assess_image_quality(_encoded(_card_image(600, 840)))

        self.assertFalse(quality.is_blurred)
        self.assertGreater(quality.sharpness, BLUR_THRESHOLD)

    def test_heavily_blurred_image_is_flagged(self):
        blurred = _card_image(600, 840).filter(ImageFilter.GaussianBlur(8))
        quality = assess_image_quality(_encoded(blurred))

        self.assertTrue(quality.is_blurred)
        self.assertLess(quality.sharpness, BLUR_THRESHOLD)


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow is not installed")
class CorrectOrientationTests(unittest.TestCase):
    def test_rotating_a_sideways_card_produces_portrait_pixels(self):
        sideways = _card_image(840, 600)

        corrected = correct_orientation(_encoded(sideways), ROTATED_90)

        self.assertEqual(_decoded_size(corrected), (600, 840))
        self.assertEqual(assess_image_quality(corrected).orientation, UPRIGHT)

    def test_rotated_180_keeps_dimensions(self):
        original = _encoded(_card_image(600, 840))

        corrected = correct_orientation(original, ROTATED_180)

        self.assertEqual(_decoded_size(corrected), (600, 840))

    def test_rotated_270_also_produces_portrait_pixels(self):
        corrected = correct_orientation(_encoded(_card_image(840, 600)), ROTATED_270)

        self.assertEqual(_decoded_size(corrected), (600, 840))

    def test_upright_and_multi_card_bytes_are_returned_unchanged(self):
        upright = _encoded(_card_image(600, 840))
        multi_card = _encoded(_card_image(1600, 600))

        self.assertEqual(correct_orientation(upright, UPRIGHT), upright)
        self.assertEqual(correct_orientation(multi_card, MULTI_CARD), multi_card)

    def test_non_image_bytes_raise_a_plain_value_error(self):
        with self.assertRaises(ValueError):
            assess_image_quality(b"not-an-image")
        with self.assertRaises(ValueError):
            correct_orientation(b"not-an-image", ROTATED_90)

    def test_empty_input_is_rejected_without_a_rotation(self):
        self.assertEqual(correct_orientation(b"", UPRIGHT), b"")
        with self.assertRaises(ValueError):
            assess_image_quality(b"")


@unittest.skipUnless(DEPS_AVAILABLE, "Pillow is not installed")
class ScanQualityDataclassTests(unittest.TestCase):
    def test_as_dict_round_trips_every_field(self):
        quality = ScanQuality(
            orientation=UPRIGHT,
            sharpness=1234.5,
            is_blurred=False,
            width=600,
            height=840,
            aspect_ratio=600 / 840,
        )

        self.assertEqual(
            quality.as_dict(),
            {
                "orientation": UPRIGHT,
                "sharpness": 1234.5,
                "is_blurred": False,
                "width": 600,
                "height": 840,
                "aspect_ratio": 600 / 840,
            },
        )
        with self.assertRaises(Exception):
            quality.orientation = ROTATED_90
