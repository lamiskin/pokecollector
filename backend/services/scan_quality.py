"""Deterministic preflight checks for one already-sanitized scan photo.

The scanner receives a sanitized JPEG (see ``services.scan_storage``), so EXIF
orientation has already been applied. What this module adds is the case that
EXIF cannot describe: a physically sideways card, whose pixels really are
rotated and which therefore reaches the provider as a landscape image.

Orientation is inferred from the aspect ratio only. That is deliberately
conservative and has two known limitations:

* 90 versus 270 degrees cannot be told apart from dimensions alone. Both
  produce a portrait image; one of them is upside down. Correcting to portrait
  still gives the vision provider a better chance than leaving it sideways,
  and metadata extraction (name/number) does not depend on reading direction.
* The "multi_card" bucket is a heuristic. A panorama-shaped photo is assumed
  to show several cards, so it is left untouched. A genuinely wide single-card
  photo (or a very tall one) is misclassified the same way; the cost is only
  that no rotation is attempted, never a wrong rotation. The rotation band
  likewise assumes the card fills the frame: a wide 4:3 photo of a portrait
  card with visible background can land in it.

Blurriness is annotation-only in this version: it is recorded on the trace and
used to choose a recovery hint for empty-candidate scans, but it never blocks
or alters recognition.

Threshold provenance: on sanitized 2048px-max card photos, pristine phone
captures measured roughly 1900-2200 edge variance and a GaussianBlur(8)
version of the same images measured roughly 110-126. ``BLUR_THRESHOLD`` sits
between those populations (500) so ordinary focus variation is not flagged.

That calibration is resolution-dependent: ``FIND_EDGES`` measures a gradient
per pixel, so the same scene at 3200px scores lower than at 2048px. The
sanitizer now stores up to 3200px, so sharpness is measured on a copy whose
long edge is at most ``SHARPNESS_MEASURE_EDGE``. For photos the sanitizer used
to produce (<= 2048px) that copy is the image itself, so their scores and
verdicts are unchanged; larger photos are measured at the size the threshold
was calibrated on.
"""

from __future__ import annotations

import io
import warnings
from dataclasses import asdict, dataclass

from PIL import Image, ImageFilter, ImageOps, ImageStat, UnidentifiedImageError

# Provider-visible orientation labels.
UPRIGHT = "upright"
ROTATED_90 = "rotated_90"
ROTATED_180 = "rotated_180"
ROTATED_270 = "rotated_270"
MULTI_CARD = "multi_card"

ROTATION_ORIENTATIONS = frozenset({ROTATED_90, ROTATED_180, ROTATED_270})

# A portrait card is about 0.71 wide/high. A sideways card lands around 1.4.
ROTATED_ASPECT_MIN = 1.15
ROTATED_ASPECT_MAX = 2.2
# Anything outside the rotated band in either direction is assumed to be a
# multi-card (composite) photo and is left for the composite path.
MULTI_CARD_ASPECT_MIN = 1 / ROTATED_ASPECT_MAX

# See the module docstring for the measured populations behind this value.
BLUR_THRESHOLD = 500.0

# The long edge sharpness is measured at, matching the size ``BLUR_THRESHOLD``
# was calibrated on. Images already at or below it are measured as they are.
SHARPNESS_MEASURE_EDGE = 2048

OUTPUT_JPEG_QUALITY = 92

_ROTATIONS = {
    ROTATED_90: Image.Transpose.ROTATE_90,
    ROTATED_180: Image.Transpose.ROTATE_180,
    ROTATED_270: Image.Transpose.ROTATE_270,
}


@dataclass(frozen=True)
class ScanQuality:
    """Preflight measurements for one scan photo."""

    orientation: str
    sharpness: float
    is_blurred: bool
    width: int
    height: int
    aspect_ratio: float

    def as_dict(self) -> dict:
        return asdict(self)


def _decode_rgb(image_bytes: bytes) -> Image.Image:
    """Decode an image with the same decode guards ``scan_storage`` uses."""
    if not image_bytes:
        raise ValueError("An empty image cannot be assessed.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as source:
                source.load()
                oriented = ImageOps.exif_transpose(source)
                return oriented.convert("RGB")
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("The image is too large to decode safely.") from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("The scan photo is not a decodable image.") from exc


def _classify_orientation(aspect_ratio: float) -> str:
    if ROTATED_ASPECT_MIN <= aspect_ratio <= ROTATED_ASPECT_MAX:
        return ROTATED_90
    if aspect_ratio > ROTATED_ASPECT_MAX or aspect_ratio < MULTI_CARD_ASPECT_MIN:
        return MULTI_CARD
    return UPRIGHT


def assess_image_quality(image_bytes: bytes) -> ScanQuality:
    """Measure orientation and edge sharpness of a sanitized scan photo.

    Raises ``ValueError`` when the bytes cannot be decoded; callers on the scan
    path treat that as "no preflight available" rather than a failed scan.
    """
    image = _decode_rgb(image_bytes)
    width, height = image.size
    aspect_ratio = (width / height) if height else 0.0
    measured = image
    if max(image.size) > SHARPNESS_MEASURE_EDGE:
        # Keep the threshold's calibration: a larger stored image is measured
        # at the reference edge instead of at its own finer pixel pitch.
        measured = image.copy()
        measured.thumbnail(
            (SHARPNESS_MEASURE_EDGE, SHARPNESS_MEASURE_EDGE),
            Image.Resampling.LANCZOS,
        )
    sharpness = float(
        ImageStat.Stat(
            measured.convert("L").filter(ImageFilter.FIND_EDGES)
        ).var[0]
    )
    return ScanQuality(
        orientation=_classify_orientation(aspect_ratio),
        sharpness=sharpness,
        is_blurred=sharpness < BLUR_THRESHOLD,
        width=width,
        height=height,
        aspect_ratio=aspect_ratio,
    )


def correct_orientation(image_bytes: bytes, orientation: str) -> bytes:
    """Rotate a sideways photo upright and re-encode it as JPEG.

    ``upright`` and ``multi_card`` inputs are returned unchanged, byte for byte.
    """
    if orientation not in _ROTATIONS:
        return image_bytes
    rotated = _decode_rgb(image_bytes).transpose(_ROTATIONS[orientation])
    output = io.BytesIO()
    rotated.save(
        output,
        format="JPEG",
        quality=OUTPUT_JPEG_QUALITY,
        progressive=False,
    )
    return output.getvalue()
