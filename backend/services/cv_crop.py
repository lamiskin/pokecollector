"""CollectorVision proposals: a detected crop plus card identification.

CollectorVision is the *proposal source* for the capture-lab image. It locates
the card itself, rectifies it and identifies it against the offline Pokémon
catalog, so its crop is what the pipeline would produce without the phone's
quad. Detection, dewarp and the restored card frame are the crop; orientation
and catalogue identification are optional, so a failure there returns the crop
unidentified and unturned rather than discarding a good detection. Our
phone-quad straightening (``services.scan_straighten``) stays as the fallback:
whenever this module cannot produce a crop -- library missing, no card found, a
detection or dewarp failure -- it returns ``None`` and the caller keeps its
existing path. Nothing here ever raises into a request or a scan.

The dewarped crop CollectorVision hands back is a 448x448 square: that shape is
an artefact of its embedder's input, not the card's shape. We embed the square
(as the embedder requires), then resize the chosen orientation back to the
card's 63:88 portrait frame before returning it. No square is ever published as
a proposal.

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

# A Pokemon card is 63 mm wide by 88 mm tall. CollectorVision's 448x448 dewarp
# is square for its embedder; the proposal is resized back to this frame.
CARD_ASPECT_WIDTH = 63
CARD_ASPECT_HEIGHT = 88

# A card that fills the frame to its edge can fall below the detector's sharpness
# gate. Replicating a border recovers it; the same 12% was measured on the real
# captures.
RETRY_BORDER_FRACTION = 0.12
DETECTION_AUTO = "auto"
DETECTION_RETRY = "retry_border_replicate"

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
    global _engine, _unavailable_reason
    with _engine_lock:
        _engine = None
        _unavailable_reason = None
    _warned_unknown.clear()


def _import_library():
    """Import CollectorVision; a separate seam so its absence is testable."""
    import collector_vision

    return collector_vision


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
        try:
            cvg = _import_library()
            catalog = cvg.Catalog.load("pokemon", offline=True)
            detector = cvg.NeuralCornerDetector(provider="cpu")
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


def _pad_border(bgr):
    """Replicate a 12% border around a frame whose card touches its edge."""
    import cv2

    height, width = bgr.shape[:2]
    pad = int(RETRY_BORDER_FRACTION * max(height, width))
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


def _restore_card_aspect(square: Image.Image) -> Image.Image:
    """Resize a square dewarp back to the card's 63:88 portrait frame."""
    rgb = square if square.mode == "RGB" else square.convert("RGB")
    width = max(1, int(rgb.width))
    height = max(1, int(round(width * CARD_ASPECT_HEIGHT / CARD_ASPECT_WIDTH)))
    if (rgb.width, rgb.height) == (width, height):
        return rgb
    return rgb.resize((width, height), Image.Resampling.LANCZOS)


def propose_with_collectorvision(rgb_image: Image.Image | None) -> ProposalCrop | None:
    """Detect, dewarp and restore a crop; identify it when that is possible.

    Detection, dewarp and restoring the card aspect produce the crop, and only
    a failure there returns ``None`` so the caller keeps its phone-quad path.
    Orientation selection and catalogue identification are optional: any
    exception in that block leaves ``identification`` as ``None`` and
    ``turned_cw`` as 0 while the crop is still returned, because the crop is
    the artefact the pipeline needs and the identity is a bonus. This function
    never raises.
    """
    if rgb_image is None:
        return None

    # Detection and dewarp are the proposal itself. Initialisation is inside
    # the guard too: an unexpected failure while loading must fall back rather
    # than reach the request path.
    try:
        engine = _load_engine()
        if engine is None:
            return None
        rgb = rgb_image if rgb_image.mode == "RGB" else rgb_image.convert("RGB")
        bgr = _to_bgr(rgb)

        detection = engine.detector.detect(bgr)
        detection_mode = DETECTION_AUTO
        frame = bgr
        if not _detected(detection):
            # The card reaches the frame's edge: replicate a border and retry.
            frame = _pad_border(bgr)
            detection = engine.detector.detect(frame)
            detection_mode = DETECTION_RETRY
        if not _detected(detection):
            return None

        square = detection.dewarp(frame)
        if square is None:
            return None
        crop = _restore_card_aspect(square)
    except Exception as exc:  # noqa: BLE001 - a proposal must never fail a scan
        logger.warning(
            "CollectorVision proposal failed; the phone crop will be used: %s: %s",
            type(exc).__name__,
            exc,
        )
        return None

    # The crop exists. Identification and the half-turn choice may fail for any
    # reason -- a missing catalogue, an embedder error, a rotation helper -- and
    # the crop is still what the pipeline came for, so keep it unturned and
    # unidentified instead of discarding a good detection.
    identification = None
    turned_cw = 0
    image = crop
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
            # The square and its restored crop have the same orientation, so a
            # half turn of the crop is exactly the chosen turned square.
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
    )
