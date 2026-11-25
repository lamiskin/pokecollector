"""Offline straighten report for one captured scan job.

Reads a scan-job directory (``instances/<name>/scan-uploads/<job>``) and, for
every sanitized ``<stem>.jpg`` that has a ``<stem>.geometry.json`` sidecar,
re-runs the straighten helper exactly as the shadow pipeline does: the client's
normalized quad is mapped onto the stored raster with
``transform_quad_for_storage`` and handed to ``try_straighten``.

It writes a contact sheet (original | straight crop, or a grey panel for an
abstention) labelled with the outcome, reason, measured aspect and tilt, and
the four per-side support ratios. It prints counts by state and reason plus the
distribution of output orientations.

Read-only: nothing is written into the job directory. The sheet and its sibling
JSON go to ``--out`` (default ``/tmp/opencode``).

Usage::

    python -m scripts.straighten_job_report /path/to/scan-uploads/320
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from services.scan_straighten import (
    Abstained,
    Straightened,
    assess_edge_support,
    destination_aspect,
    transform_quad_for_storage,
    try_straighten,
)

GEOMETRY_SUFFIX = ".geometry.json"
ARTIFACT_MARKER = ".straight-"
PANEL_WIDTH = 680
PANEL_HEIGHT = 440
LABEL_HEIGHT = 58
LABEL_FILL = (18, 18, 22)
PAPER = (128, 128, 128)
ABSTAIN_FILL = (70, 70, 76)
PORTRAIT, LANDSCAPE = "portrait", "landscape"


def _font(size: int):
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _quad_metrics(quad: list[tuple[float, float]]) -> dict:
    """Measured side lengths, destination aspect and in-plane tilt of a quad."""
    sides = [
        math.hypot(quad[(i + 1) % 4][0] - quad[i][0], quad[(i + 1) % 4][1] - quad[i][1])
        for i in range(4)
    ]
    measured_w = min(sides[0], sides[2])
    measured_h = min(sides[1], sides[3])
    aspect = destination_aspect(measured_w, measured_h)
    tilt = (math.degrees(math.atan2(
        quad[1][1] - quad[0][1], quad[1][0] - quad[0][0],
    )) + 90.0) % 180.0 - 90.0
    return {
        "sides": sides,
        "measuredWidth": measured_w,
        "measuredHeight": measured_h,
        "aspect": aspect,
        "orientation": LANDSCAPE if aspect > 1.0 else PORTRAIT,
        "tiltDegrees": tilt,
    }


def _fit(image: Image.Image, max_width: int, max_height: int) -> Image.Image:
    scale = min(1.0, max_width / image.width, max_height / image.height)
    if scale < 1.0:
        return image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    return image


def collect_pairs(job_dir: Path) -> tuple[list[tuple[str, Path, Path]], list[Path]]:
    """Return (stem, image, geometry) pairs, plus images that have no sidecar."""
    pairs = []
    covered: set[str] = set()
    for geometry_path in sorted(job_dir.glob(f"*{GEOMETRY_SUFFIX}")):
        stem = geometry_path.name[: -len(GEOMETRY_SUFFIX)]
        image_path = job_dir / f"{stem}.jpg"
        if image_path.is_file():
            pairs.append((stem, image_path, geometry_path))
            covered.add(image_path.name)
    skipped = [
        path
        for path in sorted(job_dir.glob("*.jpg"))
        if ARTIFACT_MARKER not in path.name and path.name not in covered
    ]
    return pairs, skipped


def _support_line(support) -> str:
    ratios = " ".join(f"{value:.2f}" for value in support.sides)
    flagged = [str(index + 1) for index, flag in enumerate(support.competing_sides) if flag]
    competing = f" · competing {','.join(flagged)}" if flagged else ""
    return f"boundary {support.verdict} · sides {ratios}{competing}"


def build_sheet(job_dir: Path, out_path: Path) -> tuple[Path, list[dict]]:
    pairs, skipped = collect_pairs(job_dir)
    if not pairs:
        raise SystemExit(f"no <stem>.jpg + <stem>.geometry.json pairs in {job_dir}")

    rows = []
    outcomes = []
    for stem, image_path, geometry_path in pairs:
        geometry = json.loads(geometry_path.read_text())
        source = Image.open(image_path).convert("RGB")
        rotation = int(geometry.get("storedRotationCw") or 0)
        quad = transform_quad_for_storage(
            geometry["quad"], rotation, source.width, source.height
        )
        metrics = _quad_metrics(quad)
        support = assess_edge_support(source, quad)
        result = try_straighten(source, quad)

        outcome = {
            "stem": stem,
            "image": str(image_path),
            "rotationCw": rotation,
            "measuredWidth": round(metrics["measuredWidth"], 1),
            "measuredHeight": round(metrics["measuredHeight"], 1),
            "measuredAspect": round(metrics["aspect"], 3),
            "measuredOrientation": metrics["orientation"],
            "tiltDegrees": round(metrics["tiltDegrees"], 2),
            "sides": [round(value, 3) for value in support.sides],
            "competingSides": [i + 1 for i, flag in enumerate(support.competing_sides) if flag],
            "boundary": support.verdict,
            "supportDetail": support.detail,
        }
        if isinstance(result, Straightened):
            right = result.image
            orientation = LANDSCAPE if result.width > result.height else PORTRAIT
            outcome.update(
                state="ready",
                reason=None,
                outputWidth=result.width,
                outputHeight=result.height,
                outputOrientation=orientation,
                angleDegrees=round(result.angle_degrees, 2),
            )
            status = f"ready · {result.width}x{result.height} {orientation}" \
                     f" · tilt {result.angle_degrees:.1f}°"
        else:
            assert isinstance(result, Abstained)
            right = Image.new("RGB", (source.width, source.height), ABSTAIN_FILL)
            outcome.update(state="abstained", reason=result.reason,
                           outputOrientation=None, detail=result.detail)
            status = f"abstained · {result.reason}"
        outcomes.append(outcome)

        left = _fit(source, PANEL_WIDTH, PANEL_HEIGHT)
        right = _fit(right, PANEL_WIDTH, PANEL_HEIGHT)
        row_height = max(left.height, right.height) + LABEL_HEIGHT
        headline = f"{stem[:8]} · {status}"
        measured = (
            f"measured {metrics['measuredWidth']:.0f}x{metrics['measuredHeight']:.0f}px"
            f" · aspect {metrics['aspect']:.2f} {metrics['orientation']}"
            f" · tilt {metrics['tiltDegrees']:.1f}°"
        )
        rows.append((left, right, headline, measured, _support_line(support), row_height))

    header = 34
    width = PANEL_WIDTH * 2 + 36
    height = header + sum(row[5] for row in rows) + 14
    sheet = Image.new("RGB", (width, height), PAPER)
    draw = ImageDraw.Draw(sheet)
    title_font = _font(17)
    body_font = _font(14)
    draw.text((12, 9), f"straighten report · {job_dir} · {len(pairs)} images",
              fill=(16, 16, 16), font=title_font)

    y = header
    for left, right, headline, measured, support_line, row_height in rows:
        draw.text((12, y), headline, fill=LABEL_FILL, font=body_font)
        draw.text((12, y + 19), measured, fill=(38, 38, 58), font=body_font)
        draw.text((12, y + 38), support_line, fill=(38, 38, 58), font=body_font)
        top = y + LABEL_HEIGHT
        sheet.paste(left, (12, top))
        sheet.paste(right, (PANEL_WIDTH + 24, top))
        y += row_height

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() in (".jpg", ".jpeg"):
        sheet.convert("RGB").save(out_path, quality=92)
    else:
        sheet.save(out_path)
    outcomes_path = out_path.with_suffix(".json")
    outcomes_path.write_text(json.dumps(
        {"jobDirectory": str(job_dir), "skipped": [str(p) for p in skipped],
         "items": outcomes},
        indent=2,
    ))
    return outcomes_path, outcomes


def _print_summary(out_path: Path, outcomes: list[dict], skipped: list[Path]) -> None:
    states = Counter(item["state"] for item in outcomes)
    reasons = Counter(item["reason"] for item in outcomes if item["reason"])
    orientations = Counter(
        item["outputOrientation"] for item in outcomes if item["outputOrientation"]
    )
    print(f"contact sheet: {out_path}")
    print(f"outcomes: {out_path.with_suffix('.json')}")
    print(f"images: {len(outcomes)} with geometry"
          + (f", {len(skipped)} without" if skipped else ""))
    print("states: " + ", ".join(f"{key}={states[key]}" for key in sorted(states)))
    if reasons:
        print("reasons: " + ", ".join(f"{key}={reasons[key]}" for key in sorted(reasons)))
    print("output orientations: "
          + (", ".join(f"{key}={orientations[key]}"
                       for key in (PORTRAIT, LANDSCAPE) if orientations[key])
             or "none"))
    for item in outcomes:
        aspect = f"{item['measuredWidth']:.0f}x{item['measuredHeight']:.0f}px" \
                 f" aspect={item['measuredAspect']:.2f}"
        if item["state"] == "ready":
            tail = f"{item['outputWidth']}x{item['outputHeight']} {item['outputOrientation']}"
        else:
            tail = f"abstained {item['reason']}"
        print(f"- {item['stem'][:8]}: {tail} | {aspect}"
              f" tilt={item['tiltDegrees']:.1f}° sides="
              + " ".join(f"{value:.2f}" for value in item["sides"]))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Straighten report for a scan-job directory"
    )
    parser.add_argument("job_dir", type=Path, help="scan-job directory with .jpg/.geometry.json pairs")
    parser.add_argument("--out", type=Path, default=None,
                        help="contact sheet path (default /tmp/opencode/<job>-straighten.jpg)")
    args = parser.parse_args()

    job_dir = args.job_dir.resolve()
    if not job_dir.is_dir():
        parser.error(f"not a directory: {job_dir}")
    out_path = args.out or Path("/tmp/opencode") / f"{job_dir.name}-straighten.jpg"

    _, outcomes = build_sheet(job_dir, out_path)
    pairs, skipped = collect_pairs(job_dir)
    _print_summary(out_path, outcomes, skipped)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
