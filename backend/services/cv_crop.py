"""CollectorVision proposals: a detected crop plus card identification.

CollectorVision is the *proposal source* for the capture-lab image. It locates
the card itself, rectifies it and identifies it against the offline Pokémon
catalog, so its detected corners are what the pipeline would produce without the
phone's quad. Detection plus the native warp are the crop; orientation and
catalogue identification are optional, so a failure there returns the crop
unidentified and unturned rather than discarding a good detection. Our
phone-quad straightening (``services.scan_straighten``) stays as the fallback:
whenever this module cannot produce a crop -- library missing, no card found, a
detection or dewarp failure -- it returns ``None`` and the caller keeps its
existing path. Nothing here ever raises into a request or a scan.

The crop is taken from the original pixels, not from CollectorVision's own
raster. ``DetectionResult.corners`` locates the card in the supplied frame, so
we warp the stored RGB image with a homography built from those corners. Its
``dewarp()`` output is a 448x448 square: that shape is an artefact of its
embedder's input, not the card's shape. The embedder -- and therefore the
catalogue identification and the 180-degree choice -- still runs on that
square, which is exactly what it was trained for. Only when the corners are
unusable (missing, non-finite, or a degenerate homography) do we fall back to
resampling the library's dewarp back to the card's 63:88 portrait frame, and
``crop_raster`` records which path produced the pixels.

Orientation has two states here. A card can be upright or upside down, and the
geometry cannot tell which; CollectorVision embeds both and keeps the stronger
catalog hit. When the half turn wins, ``turned_cw`` is 180 and the returned
pixels are that turned copy, so the consumer never has to apply it again.

Everything is loaded lazily on the first proposal, once, behind a lock, and the
initialisation cost is logged. The image build vendors the catalog and models
under ``~/.cache/collectorvision``; runtime resolution is offline so a missing
artifact degrades to the phone path instead of reaching the network.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from PIL import Image

logger = logging.getLogger(__name__)

CROP_SOURCE_ENV = "SCAN_CROP_SOURCE"
CROP_SOURCES = ("phone", "collectorvision")
DEFAULT_CROP_SOURCE = "phone"

# A Pokemon card is 63 mm wide by 88 mm tall. The proposal crop is built at
# this aspect, sized from the detected quad's measured side lengths.
CARD_ASPECT_WIDTH = 63
CARD_ASPECT_HEIGHT = 88

# A native warp can never be larger than the pixels the card actually covers.
# The cap only matters for absurdly large captures; it is never an upscale. It
# tracks the sanitizer's MAX_IMAGE_EDGE (``services.scan_storage``) so a
# full-resolution capture yields a full-resolution proposal instead of being
# held at the older 2048px storage size.
MAX_EDGE = 3200

# A little context outside the detected quad protects against corners that sit
# a few pixels inside the card. It is clamped into the source raster, and a
# side with no room is left unexpanded instead of failing the crop.
MARGIN_FRACTION = 0.02

# Which pixels the proposal came from: ``native`` is our warp of the original
# image using the detected corners; ``embedder`` is the library's dewarp raster
# resampled, used only when the corners cannot drive a homography.
CROP_RASTER_NATIVE = "native"
CROP_RASTER_EMBEDDER = "embedder"
CROP_RASTERS = (CROP_RASTER_NATIVE, CROP_RASTER_EMBEDDER)

# A card that fills the frame to its edge can fall below the detector's sharpness
# gate. Replicating a border recovers it; the same 12% was measured on the real
# captures.
RETRY_BORDER_FRACTION = 0.12
DETECTION_AUTO = "auto"
DETECTION_RETRY = "retry_border_replicate"
DETECTION_NONE = "none"

# Detection-only requests (the capture-lab comparison) are capped on the long
# edge so a phone photo cannot turn into a multi-second inference. The detector
# resizes to its own 384px input anyway; 1600 keeps small cards legible while
# bounding decode/resize cost. Normalised corners are unaffected by the scale.
DETECTION_MAX_EDGE = 1600

# Artifact/manifest identity for a CollectorVision proposal. It lives beside the
# phone helper's ``STRAIGHTEN_VERSION`` so a later rule set writes a new name.
CV_ALGORITHM_VERSION = "cv1"

# The identity records what produced a proposal, not just the rule version: the
# library commit and the exact detector/embedder artefacts make two crops of the
# same card comparable even when only one of them was measured. ``cropAspect``
# is the frame the dewarped square is restored to before publication.
IDENTITY_KEYS = (
    "algorithmVersion",
    "libraryCommit",
    "detectorFile",
    "detectorSha256",
    "embedderFile",
    "embedderSha256",
    "catalogKey",
    "catalogVersion",
    "cropAspect",
)

_engine_lock = threading.Lock()
_engine: "_Engine | None" = None
_unavailable_reason: str | None = None
_warned_unknown: set[str] = set()

# The library import and the corner detector are cached separately from the
# full proposal engine. Detection needs neither the catalogue nor the embedder,
# so the capture-lab comparison can run on an image whose catalogue is missing;
# the detector is still a single instance shared with proposals.
_library_lock = threading.Lock()
_library: Any | None = None
_detector_lock = threading.Lock()
_detector: Any | None = None
_detector_reason: str | None = None


@dataclass(frozen=True)
class CvIdentification:
    """The catalog's best match for the proposal."""

    id: str | None
    name: str | None
    score: float | None

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "score": self.score}


@dataclass(frozen=True)
class ProposalCrop:
    """A CollectorVision proposal, already restored to the card's shape."""

    image: Image.Image
    width: int
    height: int
    identification: CvIdentification | None
    turned_cw: int
    detection: str
    # ``native`` when the original image was warped with the detected corners;
    # ``embedder`` when only the library's dewarp raster was usable.
    crop_raster: str = CROP_RASTER_NATIVE


@dataclass(frozen=True)
class DetectionProbe:
    """CollectorVision's card boundary, in the supplied image's coordinates."""

    detected: bool
    # Four normalised (u, v) points in the supplied image, or ``None`` when no
    # card was found. The detection frame may be downscaled or padded, but the
    # values are already mapped back to the caller's image.
    corners: list[list[float]] | None
    confidence: float | None
    sharpness: float | None
    detection: str
    # Milliseconds spent inside the detector call(s), including a retry.
    detect_ms: float
    # True when the long edge was reduced before detection.
    resized: bool


class DetectionUnavailable(RuntimeError):
    """CollectorVision's detector cannot be loaded on this instance."""


@dataclass
class _Engine:
    detector: Any
    embedder: Any
    catalog: Any
    rotate_180: Callable[[Image.Image], Image.Image]
    catalog_key: str | None = None
    catalog_version: int | None = None
    # The actual artefact files behind the detector and embedder. They are
    # recorded in ``cv_identity`` by name and SHA-256 rather than copied.
    detector_path: Path | None = None
    embedder_path: Path | None = None


def crop_source() -> str:
    """Resolve ``SCAN_CROP_SOURCE`` to ``phone`` or ``collectorvision``.

    The code default is ``phone`` everywhere; only the capture-lab image sets
    ``SCAN_CROP_SOURCE=collectorvision``. An unknown value warns once and keeps
    the phone path rather than guessing.
    """
    raw = os.environ.get(CROP_SOURCE_ENV, "").strip().lower()
    if not raw:
        return DEFAULT_CROP_SOURCE
    if raw in CROP_SOURCES:
        return raw
    if raw not in _warned_unknown:
        _warned_unknown.add(raw)
        logger.warning(
            "%s=%s is not a known crop source; using %s",
            CROP_SOURCE_ENV,
            raw,
            DEFAULT_CROP_SOURCE,
        )
    return DEFAULT_CROP_SOURCE


def reset_state() -> None:
    """Drop the lazily built engine and its warnings (test hook)."""
    global _engine, _unavailable_reason, _library, _detector, _detector_reason
    with _engine_lock:
        _engine = None
        _unavailable_reason = None
        with _detector_lock:
            _detector = None
            _detector_reason = None
            with _library_lock:
                _library = None
    _warned_unknown.clear()


def _import_library():
    """Import CollectorVision; a separate seam so its absence is testable."""
    import collector_vision

    return collector_vision


def _load_library():
    """Import CollectorVision once and share the module with every consumer."""
    global _library
    if _library is not None:
        return _library
    with _library_lock:
        if _library is None:
            _library = _import_library()
        return _library


def _detector_state() -> tuple[Any | None, str | None]:
    """The shared detector, or ``(None, reason)`` when it cannot be built."""
    global _detector, _detector_reason
    if _detector is not None:
        return _detector, None
    with _detector_lock:
        if _detector is not None:
            return _detector, None
        if _detector_reason is not None:
            return None, _detector_reason
        try:
            cvg = _load_library()
            _detector = cvg.NeuralCornerDetector(provider="cpu")
        except Exception as exc:  # noqa: BLE001 - absence is a 503, not a crash
            _detector_reason = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "CollectorVision is unavailable; detection and proposals fall back: %s",
                _detector_reason,
            )
            return None, _detector_reason
        return _detector, None


def load_detector() -> tuple[Any | None, str | None]:
    """The one corner detector shared by proposals and the detection endpoint.

    Returns ``(detector, None)`` when it is available and ``(None, reason)``
    when CollectorVision cannot be imported or its weights are missing. The
    reason is cached, so a broken install costs one warning, not one per call.
    """
    return _detector_state()


def _resolve_embedder(cvg, catalog) -> tuple[Any, Path]:
    """Build the catalog's exact embedder, resolving its weights offline.

    ``catalog.embedder`` would download a missing artifact. The image vendors
    it, and this path refuses the network so a broken cache degrades to the
    phone crop instead of hanging on a request. The resolved checkpoint is
    returned beside the embedder so ``cv_identity`` can hash the artefact that
    actually ran, not a registry string.
    """
    from collector_vision.model_artifacts import resolve_model_artifact
    from collector_vision.model_registry import get_model

    identity = str(getattr(catalog, "embedding_model", "") or "")
    _prefix, separator, rest = identity.partition(":")
    if not separator or "@sha256:" not in rest:
        raise ValueError(f"unsupported catalog embedding model {identity!r}")
    model_name, _, expected_sha = rest.partition("@sha256:")
    model = get_model(model_name)
    if model.sha256 != expected_sha:
        raise ValueError(
            f"installed model registry does not match {identity!r}"
        )
    checkpoint = resolve_model_artifact(model, offline=True)
    return cvg.NeuralEmbedder(checkpoint=checkpoint, provider="cpu"), Path(checkpoint)


def _load_engine() -> "_Engine | None":
    """Build the catalog, detector and embedder once; ``None`` when unavailable."""
    global _engine, _unavailable_reason
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is not None:
            return _engine
        if _unavailable_reason is not None:
            return None
        started = time.perf_counter()
        detector, detector_reason = _detector_state()
        if detector is None:
            _unavailable_reason = detector_reason or "detector unavailable"
            return None
        try:
            cvg = _load_library()
            catalog = cvg.Catalog.load("pokemon", offline=True)
            embedder, embedder_path = _resolve_embedder(cvg, catalog)
            rotate_180 = getattr(cvg, "rotate_card_180", None)
            if rotate_180 is None:
                rotate_180 = lambda image: image.transpose(  # noqa: E731
                    Image.Transpose.ROTATE_180
                )
        except Exception as exc:  # noqa: BLE001 - absence is a fallback, not a crash
            _unavailable_reason = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "CollectorVision is unavailable; proposals fall back to the phone "
                "crop: %s",
                _unavailable_reason,
            )
            return None
        _engine = _Engine(
            detector=detector,
            embedder=embedder,
            catalog=catalog,
            rotate_180=rotate_180,
            catalog_key=getattr(catalog, "catalog_key", None),
            catalog_version=getattr(catalog, "version", None),
            detector_path=getattr(detector, "_checkpoint", None),
            embedder_path=embedder_path,
        )
        try:
            card_count = len(catalog)
        except Exception:  # noqa: BLE001 - a count is diagnostic only
            card_count = None
        logger.info(
            "CollectorVision initialised in %.0f ms (catalog=%s v%s, %s cards)",
            (time.perf_counter() - started) * 1000.0,
            _engine.catalog_key,
            _engine.catalog_version,
            card_count,
        )
        return _engine


def _library_commit() -> str | None:
    """The installed CollectorVision commit, from pip's ``direct_url.json``.

    The library is installed from a pinned Git commit (see
    ``Dockerfile.capture-lab``); its distribution metadata records that commit.
    A wheel or edit install without VCS metadata degrades to ``None`` rather
    than inventing an identity.
    """
    try:
        from importlib.metadata import distribution

        raw = distribution("collectorvision").read_text("direct_url.json")
        if raw:
            info = json.loads(raw)
            commit = (info.get("vcs_info") or {}).get("commit_id")
            if commit:
                return str(commit)
    except Exception:  # noqa: BLE001 - identity is diagnostic, never fatal
        pass
    return None


def _file_sha256(path: Path | None) -> str | None:
    """SHA-256 of an artefact file, or ``None`` when it cannot be read."""
    if path is None:
        return None
    digest = hashlib.sha256()
    try:
        with Path(path).open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def cv_identity(engine: "_Engine | None" = None) -> dict[str, Any]:
    """The artefacts that define a CollectorVision proposal.

    This is deliberately more than a version string. Two environments can both
    run ``cv1`` while shipping a different detector, embedder or catalogue; the
    library commit, the model files (by name and SHA-256), the catalogue key and
    version, and the restored crop's target aspect pin down which artefacts
    produced a crop. ``cv_identity_digest`` hashes this dict so a manifest can
    record the identity itself and a compact value to compare against.
    """
    if engine is None:
        engine = _load_engine()
    detector_path = getattr(engine, "detector_path", None) if engine else None
    embedder_path = getattr(engine, "embedder_path", None) if engine else None
    return {
        "algorithmVersion": CV_ALGORITHM_VERSION,
        "libraryCommit": _library_commit(),
        "detectorFile": Path(detector_path).name if detector_path else None,
        "detectorSha256": _file_sha256(detector_path),
        "embedderFile": Path(embedder_path).name if embedder_path else None,
        "embedderSha256": _file_sha256(embedder_path),
        "catalogKey": engine.catalog_key if engine else None,
        "catalogVersion": engine.catalog_version if engine else None,
        "cropAspect": [CARD_ASPECT_WIDTH, CARD_ASPECT_HEIGHT],
    }


def cv_identity_digest(identity: dict[str, Any] | None = None) -> str:
    """SHA-256 over a canonical ``cv_identity`` dict.

    ``identity`` defaults to the live engine's identity. Callers that record a
    manifest must pass the same dict they store so the digest and the dict can
    never disagree; ``services.scan_storage.cv_manifest_is_current`` verifies
    that pairing.
    """
    payload = cv_identity() if identity is None else identity
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _to_bgr(rgb: Image.Image):
    """RGB raster to the detector's BGR uint8 frame (cv2 imported lazily)."""
    import cv2
    import numpy as np

    return cv2.cvtColor(np.asarray(rgb, dtype=np.uint8), cv2.COLOR_RGB2BGR)


def _padding_for(shape: tuple[int, ...]) -> int:
    """The border width ``_pad_border`` adds for a frame of ``shape``."""
    height, width = shape[:2]
    return int(RETRY_BORDER_FRACTION * max(int(height), int(width)))


def _pad_border(bgr):
    """Replicate a 12% border around a frame whose card touches its edge."""
    import cv2

    pad = _padding_for(bgr.shape)
    return cv2.copyMakeBorder(bgr, pad, pad, pad, pad, cv2.BORDER_REPLICATE)


def _detected(result: Any) -> bool:
    return bool(
        result is not None
        and getattr(result, "card_present", False)
        and getattr(result, "corners", None) is not None
    )


def _score(hits: list[dict[str, Any]]) -> float | None:
    if not hits:
        return None
    try:
        value = hits[0].get("score")
        return None if value is None else float(value)
    except (TypeError, ValueError, AttributeError):
        return None


def _text(value: Any) -> str | None:
    return None if value is None else str(value)


def _corner_pixels(corners: Any, width: int, height: int, pad: int):
    """Map normalised corners into the original raster's pixel coordinates.

    Corners are normalised to the frame the detector saw. On the retry that
    frame is the original image plus ``pad`` replicated pixels on every side,
    so the pad is subtracted after scaling; the result may sit slightly
    outside the original raster when the card touches the padded edge, and the
    warp clamps it.
    """
    import numpy as np

    points = np.asarray(corners, dtype=np.float64)
    if points.shape != (4, 2) or not np.all(np.isfinite(points)):
        raise ValueError("corners are not four finite coordinates")
    padded_width = width + 2 * pad
    padded_height = height + 2 * pad
    xs = points[:, 0] * padded_width - pad
    ys = points[:, 1] * padded_height - pad
    return np.column_stack((xs, ys))


def _quad_metrics(points) -> tuple[float, float] | None:
    """Measured width/height of the quad from its opposite side pairs."""
    import numpy as np

    def length(a, b) -> float:
        return float(np.hypot(*(points[b] - points[a])))

    width = (length(0, 1) + length(3, 2)) / 2.0
    height = (length(0, 3) + length(1, 2)) / 2.0
    if not (np.isfinite(width) and np.isfinite(height)):
        return None
    if width < 1.0 or height < 1.0:
        return None
    return width, height


def _target_size(measured_width: float, measured_height: float) -> tuple[int, int] | None:
    """The card's 63:88 frame, fitted inside the measured card and MAX_EDGE.

    The scale is the smaller of the two axes so neither dimension exceeds what
    the detector measured: this crop is never an upscale.
    """
    scale = min(
        measured_width / CARD_ASPECT_WIDTH,
        measured_height / CARD_ASPECT_HEIGHT,
        MAX_EDGE / CARD_ASPECT_HEIGHT,
    )
    width = int(math.floor(CARD_ASPECT_WIDTH * scale))
    height = int(math.floor(CARD_ASPECT_HEIGHT * scale))
    if width < 1 or height < 1:
        return None
    return width, height


def _expand_quad(points, card_width: float, card_height: float, width: int, height: int):
    """Grow the quad by 2% of the card per side where the raster has room.

    Each edge is offset along its own outward normal. A side whose offset
    endpoints would leave the raster is skipped rather than clamped inward, so
    the margin never distorts the card; the final points are clipped as a
    last-resort guard.
    """
    import numpy as np

    centroid = points.mean(axis=0)
    offsets = np.zeros_like(points)
    counts = np.zeros(4, dtype=np.float64)
    edges = (
        (0, 1, MARGIN_FRACTION * card_height),
        (1, 2, MARGIN_FRACTION * card_width),
        (2, 3, MARGIN_FRACTION * card_height),
        (3, 0, MARGIN_FRACTION * card_width),
    )
    for start, end, amount in edges:
        first, second = points[start], points[end]
        delta = second - first
        length = float(np.hypot(*delta))
        if length <= 0 or amount <= 0:
            continue
        normal = np.array([delta[1], -delta[0]], dtype=np.float64) / length
        midpoint = (first + second) / 2.0
        if float(np.dot(normal, midpoint - centroid)) < 0:
            normal = -normal
        offset = normal * amount
        moved = (first + offset, second + offset)
        if any(
            not (0 <= point[0] <= width - 1 and 0 <= point[1] <= height - 1)
            for point in moved
        ):
            continue
        offsets[start] += offset
        offsets[end] += offset
        counts[start] += 1
        counts[end] += 1
    expanded = points + offsets / np.maximum(counts, 1)[:, None]
    expanded[:, 0] = np.clip(expanded[:, 0], 0, width - 1)
    expanded[:, 1] = np.clip(expanded[:, 1], 0, height - 1)
    return expanded


def _homography(source, destination):
    """The 3x3 projective transform mapping four source points to four targets."""
    import numpy as np

    rows = []
    values = []
    for (x, y), (u, v) in zip(source, destination):
        rows.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y])
        values.append(u)
        rows.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y])
        values.append(v)
    solution = np.linalg.solve(
        np.asarray(rows, dtype=np.float64), np.asarray(values, dtype=np.float64)
    )
    matrix = np.array(
        [
            [solution[0], solution[1], solution[2]],
            [solution[3], solution[4], solution[5]],
            [solution[6], solution[7], 1.0],
        ],
        dtype=np.float64,
    )
    if not np.all(np.isfinite(matrix)):
        raise ValueError("homography is not finite")
    if abs(float(np.linalg.det(matrix))) < 1e-9:
        raise ValueError("homography is degenerate")
    return matrix


def _native_crop(
    rgb: Image.Image, corners: Any, pad: int
) -> Image.Image | None:
    """Warp the original raster with the detected corners.

    Returns ``None`` -- never raises, and never substitutes an upscale -- when
    the corners are unusable. The destination is the card's 63:88 frame fitted
    inside the measured quad, with a small clamped margin sampled from the
    source for safety.
    """
    import numpy as np

    width, height = rgb.size
    try:
        points = _corner_pixels(corners, width, height, pad)
        metrics = _quad_metrics(points)
        if metrics is None:
            return None
        measured_width, measured_height = metrics
        size = _target_size(measured_width, measured_height)
        if size is None:
            return None
        out_width, out_height = size
        source = _expand_quad(
            points, measured_width, measured_height, width, height
        )
        destination = np.array(
            [
                [0.0, 0.0],
                [out_width - 1.0, 0.0],
                [out_width - 1.0, out_height - 1.0],
                [0.0, out_height - 1.0],
            ],
            dtype=np.float64,
        )
        inverse = np.linalg.inv(_homography(source, destination))
    except (ValueError, TypeError, np.linalg.LinAlgError):
        return None
    coefficients = (
        float(inverse[0, 0]),
        float(inverse[0, 1]),
        float(inverse[0, 2]),
        float(inverse[1, 0]),
        float(inverse[1, 1]),
        float(inverse[1, 2]),
        float(inverse[2, 0]),
        float(inverse[2, 1]),
    )
    return rgb.transform(
        (out_width, out_height),
        Image.Transform.PERSPECTIVE,
        coefficients,
        Image.Resampling.BICUBIC,
    )


def _restore_card_aspect(square: Image.Image) -> Image.Image:
    """Resize a square dewarp back to the card's 63:88 portrait frame."""
    rgb = square if square.mode == "RGB" else square.convert("RGB")
    width = max(1, int(rgb.width))
    height = max(1, int(round(width * CARD_ASPECT_HEIGHT / CARD_ASPECT_WIDTH)))
    if (rgb.width, rgb.height) == (width, height):
        return rgb
    return rgb.resize((width, height), Image.Resampling.LANCZOS)


def _number(value: Any) -> float | None:
    """A finite float from a detector result, or ``None``."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def detect_card(
    rgb_image: Image.Image, max_edge: int = DETECTION_MAX_EDGE
) -> DetectionProbe:
    """Locate the card's four corners without dewarping or identifying.

    This mirrors the detection half of ``propose_with_collectorvision`` -- the
    same 12% ``BORDER_REPLICATE`` retry when the card reaches the frame's edge
    -- and stops at the corners. It never warps, embeds, searches a catalogue or
    writes anything, so it works whenever the library and detector weights are
    present even if the catalogue is not.

    A long edge above ``max_edge`` is downscaled first for latency; the returned
    corners are normalised, so they already describe the supplied image. Raises
    ``DetectionUnavailable`` when CollectorVision cannot be loaded; a detector
    error or unusable corners are reported as ``detected=False`` instead.
    """
    detector, reason = load_detector()
    if detector is None:
        raise DetectionUnavailable(reason or "CollectorVision detector unavailable")

    rgb = rgb_image if rgb_image.mode == "RGB" else rgb_image.convert("RGB")
    width, height = rgb.size
    resized = False
    if max_edge > 0 and max(width, height) > max_edge:
        scale = max_edge / float(max(width, height))
        rgb = rgb.resize(
            (max(1, round(width * scale)), max(1, round(height * scale))),
            Image.Resampling.LANCZOS,
        )
        resized = True
    frame_width, frame_height = rgb.size

    started = time.perf_counter()
    try:
        bgr = _to_bgr(rgb)
        detection = detector.detect(bgr)
        mode = DETECTION_AUTO
        pad = 0
        if not _detected(detection):
            # The card reaches the frame's edge: replicate a border and retry.
            padded = _pad_border(bgr)
            pad = _padding_for((frame_height, frame_width))
            detection = detector.detect(padded)
            mode = DETECTION_RETRY
    except Exception as exc:  # noqa: BLE001 - a comparison request must not 500
        logger.warning(
            "CollectorVision detection failed: %s: %s", type(exc).__name__, exc
        )
        detect_ms = (time.perf_counter() - started) * 1000.0
        return DetectionProbe(
            False, None, None, None, DETECTION_NONE, detect_ms, resized
        )
    detect_ms = (time.perf_counter() - started) * 1000.0

    confidence = _number(getattr(detection, "confidence", None))
    sharpness = _number(getattr(detection, "sharpness", None))
    if not _detected(detection):
        return DetectionProbe(
            False, None, confidence, sharpness, DETECTION_NONE, detect_ms, resized
        )

    try:
        import numpy as np

        points = _corner_pixels(detection.corners, frame_width, frame_height, pad)
        # Normalised coordinates are scale-invariant: dividing the padded frame's
        # pixels by the detection frame's size maps them straight back onto the
        # supplied image, downscaled or not. Clamp the retry's slight overhang.
        normalised = np.asarray(points, dtype=np.float64) / np.array(
            [frame_width, frame_height], dtype=np.float64
        )
        if not np.all(np.isfinite(normalised)):
            raise ValueError("corners are not finite")
        corners = [
            [
                round(float(np.clip(point[0], 0.0, 1.0)), 6),
                round(float(np.clip(point[1], 0.0, 1.0)), 6),
            ]
            for point in normalised
        ]
    except Exception as exc:  # noqa: BLE001 - malformed corners are no detection
        logger.warning(
            "CollectorVision returned unusable corners: %s: %s",
            type(exc).__name__,
            exc,
        )
        return DetectionProbe(
            False, None, confidence, sharpness, DETECTION_NONE, detect_ms, resized
        )

    return DetectionProbe(
        True, corners, confidence, sharpness, mode, detect_ms, resized
    )


def propose_with_collectorvision(rgb_image: Image.Image | None) -> ProposalCrop | None:
    """Detect, warp and identify a crop; identify it when that is possible.

    Detection locates the card; the crop is a native warp of the original
    pixels with those corners, falling back to the library's dewarp raster only
    when the corners are unusable. A detection or crop failure returns ``None``
    so the caller keeps its phone-quad path. Orientation selection and
    catalogue identification are optional: any exception there leaves
    ``identification`` as ``None`` and ``turned_cw`` as 0 while the crop is
    still returned, because the crop is the artefact the pipeline needs and the
    identity is a bonus. This function never raises.
    """
    if rgb_image is None:
        return None

    # Detection is the proposal's anchor. Initialisation is inside the guard
    # too: an unexpected failure while loading must fall back rather than reach
    # the request path.
    try:
        engine = _load_engine()
        if engine is None:
            return None
        rgb = rgb_image if rgb_image.mode == "RGB" else rgb_image.convert("RGB")
        bgr = _to_bgr(rgb)

        detection = engine.detector.detect(bgr)
        detection_mode = DETECTION_AUTO
        frame = bgr
        pad = 0
        if not _detected(detection):
            # The card reaches the frame's edge: replicate a border and retry.
            frame = _pad_border(bgr)
            pad = _padding_for((rgb.height, rgb.width))
            detection = engine.detector.detect(frame)
            detection_mode = DETECTION_RETRY
        if not _detected(detection):
            return None
    except Exception as exc:  # noqa: BLE001 - a proposal must never fail a scan
        logger.warning(
            "CollectorVision proposal failed; the phone crop will be used: %s: %s",
            type(exc).__name__,
            exc,
        )
        return None

    # The crop is built from the original pixels with the detected corners.
    # The library's dewarp square is still produced because the embedder needs
    # it for identification and the half-turn choice; it is only the crop's
    # source when the corners cannot drive a homography.
    try:
        crop = _native_crop(rgb, detection.corners, pad)
    except Exception as exc:  # noqa: BLE001 - an unusable warp falls back
        logger.debug("native CollectorVision crop failed: %s: %s", type(exc).__name__, exc)
        crop = None
    crop_raster = CROP_RASTER_NATIVE if crop is not None else None
    try:
        square = detection.dewarp(frame)
    except Exception as exc:  # noqa: BLE001 - identification is optional
        logger.debug("CollectorVision dewarp failed: %s: %s", type(exc).__name__, exc)
        square = None
    if crop is None:
        if square is None:
            return None
        try:
            crop = _restore_card_aspect(square)
        except Exception as exc:  # noqa: BLE001 - a proposal must never fail a scan
            logger.warning(
                "CollectorVision proposal failed; the phone crop will be used: "
                "%s: %s",
                type(exc).__name__,
                exc,
            )
            return None
        crop_raster = CROP_RASTER_EMBEDDER

    # The crop exists. Identification and the half-turn choice may fail for any
    # reason -- a missing catalogue, an embedder error, a rotation helper -- and
    # the crop is still what the pipeline came for, so keep it unturned and
    # unidentified instead of discarding a good detection.
    identification = None
    turned_cw = 0
    image = crop
    if square is None:
        return ProposalCrop(
            image=image,
            width=image.width,
            height=image.height,
            identification=None,
            turned_cw=0,
            detection=detection_mode,
            crop_raster=crop_raster,
        )
    try:
        upright_embedding = engine.embedder.embed(square)
        turned_square = engine.rotate_180(square)
        turned_embedding = engine.embedder.embed(turned_square)
        upright_hits = list(engine.catalog.search_records(upright_embedding, top_k=1))
        turned_hits = list(engine.catalog.search_records(turned_embedding, top_k=1))

        upright_score = _score(upright_hits)
        turned_score = _score(turned_hits)
        if turned_score is not None and (
            upright_score is None or turned_score > upright_score
        ):
            hits = turned_hits
            # The crop has the same orientation as the square it was derived
            # from only when it is the dewarp raster; either way a half turn
            # of the returned pixels is exactly the chosen turned copy.
            image = crop.transpose(Image.Transpose.ROTATE_180)
            turned_cw = 180
        else:
            hits = upright_hits

        record = hits[0] if hits else {}
        identification = CvIdentification(
            id=_text(record.get("id")),
            name=_text(record.get("name")),
            score=_score(hits),
        )
    except Exception as exc:  # noqa: BLE001 - identity is optional; the crop is not
        logger.warning(
            "CollectorVision identification failed; returning the crop without "
            "it: %s: %s",
            type(exc).__name__,
            exc,
        )
        identification = None
        turned_cw = 0
        image = crop

    return ProposalCrop(
        image=image,
        width=image.width,
        height=image.height,
        identification=identification,
        turned_cw=turned_cw,
        detection=detection_mode,
        crop_raster=crop_raster,
    )
