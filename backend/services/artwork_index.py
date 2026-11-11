"""Artwork similarity search: a candidate source that does not read any text.

The text pipeline can only find a card whose name it read roughly correctly. This
module is the independent channel: embed the photo, cosine-match it against a
prebuilt index of catalogue card images, and return the nearest card ids.

It is intentionally optional and failure-tolerant: if the index, the ONNX model or
`onnxruntime` is missing, `is_available()` is False and `search()` returns an empty
list, so the scanner behaves exactly as it does today.

Build the index offline with `scripts/build_artwork_index.py` (needs torch; not a
runtime dependency).
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_INDEX_DIR = Path(os.environ.get("ARTWORK_INDEX_DIR", "/app/data/artwork-index"))
_MODEL_FILENAME = "dinov2_vits14.onnx"
_EMBEDDINGS_FILENAME = "embeddings.npy"
_IDS_FILENAME = "ids.json"
_IMAGE_SIZE = 224
_MEAN = (0.485, 0.456, 0.406)
_SCALE = (0.229, 0.224, 0.225)

_lock = threading.Lock()
_state: dict | None = None
_warned = False


def _load_state(index_dir: Path) -> dict | None:
    embeddings_path = index_dir / _EMBEDDINGS_FILENAME
    ids_path = index_dir / _IDS_FILENAME
    model_path = index_dir / _MODEL_FILENAME
    if not (embeddings_path.exists() and ids_path.exists() and model_path.exists()):
        return None
    try:
        import numpy as np
        import onnxruntime  # noqa: F401  (imported for availability only)
    except Exception:
        return None
    try:
        embeddings = np.load(embeddings_path).astype("float32")
        ids = json.loads(ids_path.read_text())
    except Exception:
        return None
    if embeddings.ndim != 2 or embeddings.shape[0] != len(ids):
        logger.warning("Artwork index is inconsistent; ignoring it")
        return None
    try:
        import onnxruntime as ort

        session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    except Exception:
        return None
    return {
        "embeddings": embeddings,
        "ids": ids,
        "session": session,
        "np": np,
    }


def is_available(index_dir: Path | None = None) -> bool:
    return _get_state(index_dir) is not None


def _get_state(index_dir: Path | None = None) -> dict | None:
    global _state, _warned
    directory = Path(index_dir) if index_dir else DEFAULT_INDEX_DIR
    with _lock:
        if _state is not None and _state.get("dir") == str(directory):
            return _state if _state.get("session") is not None else None
        loaded = _load_state(directory)
        if loaded is None:
            if not _warned:
                logger.info(
                    "Artwork index unavailable at %s; text-only matching remains active",
                    directory,
                )
                _warned = True
            _state = {"dir": str(directory), "session": None}
            return None
        loaded["dir"] = str(directory)
        _state = loaded
        return loaded


def _prepare_pixels(image_bytes: bytes, np):
    """Decode to a 224×224 float32 CHW tensor, ImageNet-normalised.

    Uses Pillow rather than OpenCV so the runtime gains no new dependency.
    """
    import io

    from PIL import Image

    try:
        with Image.open(io.BytesIO(image_bytes)) as opened:
            image = opened.convert("RGB").resize((_IMAGE_SIZE, _IMAGE_SIZE), Image.BILINEAR)
            pixels = np.asarray(image, dtype="float32") / 255.0
    except Exception:
        return None
    pixels = (pixels - np.array(_MEAN, dtype="float32")) / np.array(_SCALE, dtype="float32")
    return np.transpose(pixels, (2, 0, 1))[None, ...]


def search(image_bytes: bytes, *, limit: int = 5, index_dir: Path | None = None) -> list[tuple[str, float]]:
    """Return up to `limit` (card_id, cosine similarity) pairs, best first."""
    state = _get_state(index_dir)
    if state is None or not image_bytes or limit <= 0:
        return []
    np = state["np"]
    try:
        pixels = _prepare_pixels(image_bytes, np)
        if pixels is None:
            return []
        output = state["session"].run(None, {"pixel_values": pixels})[0][0]
        norm = float(np.linalg.norm(output))
        if norm == 0:
            return []
        query = output / norm
        scores = state["embeddings"] @ query
        top = np.argsort(-scores)[:limit]
        return [(state["ids"][int(i)], float(scores[int(i)])) for i in top]
    except Exception:
        logger.warning("Artwork search failed; continuing without it", exc_info=True)
        return []


def reset_cache() -> None:
    """Drop the loaded index (tests, or after rebuilding it)."""
    global _state
    with _lock:
        _state = None
