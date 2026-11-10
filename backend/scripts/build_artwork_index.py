"""Build the artwork-similarity index used by services/artwork_index.py.

Offline only: needs torch + timm (and onnxruntime to export the ONNX model). The
backend runtime needs only onnxruntime + Pillow, both already required.

    python -m scripts.build_artwork_index --out data/artwork-index
    python -m scripts.build_artwork_index --out data/artwork-index --limit 500

The index is a pair of files:
    embeddings.npy   float32 [n, 384], L2-normalised
    ids.json         list[str] of tcg_card_id, same order
plus dinov2_vits14.onnx, exported once.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

MODEL_NAME = "vit_small_patch14_dinov2.lvd142m"
IMAGE_SIZE = 224
MEAN = (0.485, 0.456, 0.406)
SCALE = (0.229, 0.224, 0.225)


def _die(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def _load_dependencies():
    try:
        import numpy as np
        import torch
        import timm
        from PIL import Image
    except ImportError as error:  # pragma: no cover - dependency guard
        _die(
            "This script needs torch, timm, numpy and Pillow "
            f"(missing: {error.name}). Install them in a scratch environment; "
            "they are not runtime dependencies of the backend."
        )
    return np, torch, timm, Image


def _encode(path: Path, np, Image):
    with Image.open(path) as opened:
        image = opened.convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE), Image.BILINEAR)
        pixels = np.asarray(image, dtype="float32") / 255.0
    pixels = (pixels - np.array(MEAN, dtype="float32")) / np.array(SCALE, dtype="float32")
    return np.transpose(pixels, (2, 0, 1))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--images", type=Path, help="directory of <tcg_card_id>.webp files")
    parser.add_argument("--urls", type=Path, help="TSV of tcg_card_id<TAB>url to download")
    parser.add_argument("--out", type=Path, required=True, help="index output directory")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=16)
    args = parser.parse_args(argv)

    np, torch, timm, Image = _load_dependencies()
    torch.set_num_threads(16)

    files: list[tuple[str, Path]] = []
    if args.images:
        files = [(p.stem, p) for p in sorted(args.images.glob("*.webp"))]
    elif args.urls:
        import urllib.request

        cache = args.out / "images"
        cache.mkdir(parents=True, exist_ok=True)
        for line in args.urls.read_text().splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            card_id, url = parts[0], parts[1]
            dest = cache / f"{card_id}.webp"
            if not dest.exists():
                try:
                    request = urllib.request.Request(url, headers={"User-Agent": "pokecollector"})
                    with urllib.request.urlopen(request, timeout=20) as response:
                        dest.write_bytes(response.read())
                except Exception:
                    continue
            files.append((card_id, dest))
    else:
        _die("Pass --images or --urls")

    if args.limit:
        files = files[: args.limit]
    if not files:
        _die("No reference images found")

    args.out.mkdir(parents=True, exist_ok=True)
    model = timm.create_model(MODEL_NAME, pretrained=True, num_classes=0, img_size=IMAGE_SIZE).eval()

    vectors: list = []
    ids: list[str] = []
    batch: list = []
    batch_ids: list[str] = []

    mean = torch.tensor(MEAN).view(1, 3, 1, 1)
    scale = torch.tensor(SCALE).view(1, 3, 1, 1)

    def flush() -> None:
        if not batch:
            return
        tensor = torch.from_numpy(np.stack(batch)).permute(0, 3, 1, 2)
        tensor = (tensor - mean) / scale
        with torch.no_grad():
            features = torch.nn.functional.normalize(model(tensor), dim=1).numpy()
        vectors.append(features)
        ids.extend(batch_ids)
        batch.clear()
        batch_ids.clear()

    for index, (card_id, path) in enumerate(files, 1):
        try:
            batch.append(_encode(path, np, Image))
            batch_ids.append(card_id)
        except Exception:
            continue
        if len(batch) >= args.batch_size:
            flush()
        if index % 1000 == 0:
            print(f"  {index}/{len(files)}", flush=True)
    flush()

    matrix = np.concatenate(vectors, axis=0).astype("float32")
    np.save(args.out / "embeddings.npy", matrix)
    (args.out / "ids.json").write_text(json.dumps(ids))

    onnx_path = args.out / "dinov2_vits14.onnx"
    if not onnx_path.exists():
        dummy = torch.randn(1, 3, IMAGE_SIZE, IMAGE_SIZE)
        torch.onnx.export(
            model, dummy, str(onnx_path),
            input_names=["pixel_values"], output_names=["embedding"],
            dynamic_axes={"pixel_values": {0: "batch"}}, opset_version=17,
        )
    print(f"indexed {matrix.shape[0]} cards -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
