"""Contact sheet for the straighten-and-crop helper.

Reads a JSON manifest of ``{"image": path, "quad": [[x, y], ...]}`` entries and
writes the original and straightened panels side by side, with a sibling JSON of
outcomes. Each panel also prints the boundary-support verdict and the four
per-side support ratios, so a veto can be read against the pixels that caused
it. ``--synth N`` generates deterministic fixtures and a manifest first so the
tool can be exercised without a phone.
"""

from __future__ import annotations

import argparse
import json
import math
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from services.scan_straighten import (
    Abstained,
    Straightened,
    assess_edge_support,
    try_straighten,
)

DARK = (26, 28, 34)
WHITE = (246, 246, 242)
GREY = (150, 152, 158)
PANEL_MAX = 900


def _card(width=215, height=300, nested=False, inner_art=False, plain=False):
    card = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(card)
    if plain:
        return card
    draw.rectangle((0, 0, width - 1, height - 1), outline=(4, 4, 4), width=7)
    if nested:
        for inset in (14, 28, 42):
            draw.rectangle((inset, inset, width - inset, height - inset),
                           outline=(40, 40, 40), width=3)
    if inner_art:
        draw.rectangle((36, 44, width - 36, 170), fill=(170, 40, 44))
    for top in (70, 132, 194):
        draw.rectangle((18, top, width - 18, top + 26), fill=GREY)
    return card


def _rotate_point(x, y, degrees):
    radians = math.radians(degrees)
    return (x * math.cos(radians) + y * math.sin(radians),
            -x * math.sin(radians) + y * math.cos(radians))


def _render_rotated(card, degrees, canvas_size=(520, 620)):
    canvas = Image.new("RGB", canvas_size, DARK)
    rotated = card.rotate(degrees, expand=True, resample=Image.Resampling.BICUBIC, fillcolor=DARK)
    left = (canvas_size[0] - rotated.width) // 2
    top = (canvas_size[1] - rotated.height) // 2
    canvas.paste(rotated, (left, top))
    cx, cy = canvas_size[0] / 2, canvas_size[1] / 2
    half_w, half_h = card.width / 2, card.height / 2
    quad = []
    for x, y in [(-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)]:
        dx, dy = _rotate_point(x, y, degrees)
        quad.append([round(cx + dx, 2), round(cy + dy, 2)])
    return canvas, quad


def _render_keystone(canvas_size=(440, 420)):
    canvas = Image.new("RGB", canvas_size, DARK)
    draw = ImageDraw.Draw(canvas)
    quad = [(120, 60), (318, 60), (335, 360), (103, 360)]
    draw.polygon(quad, fill=WHITE)
    draw.line(quad + [quad[0]], fill=(4, 4, 4), width=7, joint="curve")
    for top in (120, 190, 260):
        draw.rectangle((130, top, 305, top + 26), fill=GREY)
    return canvas, [list(point) for point in quad]


def _shrink_quad(quad, fraction=0.8):
    cx = sum(point[0] for point in quad) / 4.0
    cy = sum(point[1] for point in quad) / 4.0
    return [[cx + (x - cx) * fraction, cy + (y - cy) * fraction] for x, y in quad]


def _render_corner_cut(card, canvas_size=(300, 360), offset=(100, 140)):
    """Card stock pasted so its bottom-right corner runs off the canvas."""
    canvas = Image.new("RGB", canvas_size, DARK)
    canvas.paste(card, offset)
    left = float(offset[0])
    top = float(offset[1])
    quad = [
        (left, top),
        (canvas_size[0] - 60.0, top),
        (canvas_size[0] - 60.0, canvas_size[1] - 60.0),
        (left, canvas_size[1] - 60.0),
    ]
    return canvas, [list(point) for point in quad]


def _cases() -> list[tuple[str, str, Image.Image, list]]:
    cases = []
    for tilt in (0, 8, 16, 22):
        canvas, quad = _render_rotated(_card(), tilt)
        cases.append((f"tilt-{tilt}", "upright card, tilt", canvas, quad))
    canvas, quad = _render_rotated(_card(nested=True), 5)
    cases.append(("loader-nested-border", "loader-like nested border", canvas, quad))
    canvas, quad = _render_rotated(_card(inner_art=True), 11)
    cases.append(("inner-art-lock", "inner-art lock", canvas, quad))
    canvas, quad = _render_keystone()
    cases.append(("keystone", "keystone", canvas, quad))
    canvas, quad = _render_rotated(_card(), 4)
    quad[3][0] = -30
    cases.append(("partly-cut", "quad point off the raster", canvas, quad))

    # Boundary-support cases: what the geometry checks cannot see.
    canvas, quad = _render_rotated(_card(), 6)
    cases.append(("boundary-ok", "clear border, expect ok", canvas, quad))
    canvas, quad = _render_rotated(_card(inner_art=True), 6)
    cases.append(("inner-lock-80", "quad shrunk to 80 %, expect competing",
                  canvas, _shrink_quad(quad, 0.8)))
    canvas, _ = _render_rotated(_card(), 6)
    cases.append(("boundary-background", "quad in the background, expect unsupported",
                  canvas, [[20, 20], [110, 20], [110, 130], [20, 130]]))
    canvas, quad = _render_corner_cut(_card(plain=True))
    cases.append(("corner-cut", "card corner off frame, expect unsupported", canvas, quad))
    return cases


def generate_synth(count: int) -> tuple[Path, list[dict], Path]:
    base = Path(tempfile.mkdtemp(prefix="straighten-synth-", dir="/tmp/opencode"))
    entries = []
    cases = _cases()
    for index in range(max(0, count)):
        if index < len(cases):
            name, note, canvas, quad = cases[index]
        else:
            angle, tag = [(0, "upright"), (9, "tilt-9"), (18, "tilt-18")][(index - len(cases)) % 3]
            name = f"extra-{index:02d}-{tag}"
            note = tag
            canvas, quad = _render_rotated(_card(), angle)
        path = base / f"{index:02d}-{name}.png"
        canvas.save(path)
        entries.append({"image": str(path), "quad": quad, "note": note})
    manifest = base / "manifest.json"
    manifest.write_text(json.dumps(entries, indent=2))
    return base, entries, manifest


def _fit(image: Image.Image, max_width: int, max_height: int) -> Image.Image:
    scale = min(1.0, max_width / image.width, max_height / image.height)
    if scale < 1.0:
        return image.resize((max(1, round(image.width * scale)),
                            max(1, round(image.height * scale))),
                           Image.Resampling.LANCZOS)
    return image


def _support_text(support) -> str:
    text = f"{support.verdict} · sides " + " ".join(f"{v:.2f}" for v in support.sides)
    flagged = [str(index + 1) for index, flag in enumerate(support.competing_sides) if flag]
    if flagged:
        text += " · competing " + ",".join(flagged)
    return text


def build_sheet(entries: list[dict], out_path: Path,
                require_boundary: bool = True) -> tuple[Path, list[dict]]:
    rows = []
    outcomes = []
    for entry in entries:
        source = Image.open(entry["image"]).convert("RGB")
        support = assess_edge_support(source, entry["quad"])
        result = try_straighten(source, entry["quad"], require_boundary=require_boundary)
        if isinstance(result, Straightened):
            right = result.image
            outcome = {
                "image": entry["image"],
                "note": entry.get("note", ""),
                "outcome": "straightened",
                "width": result.width,
                "height": result.height,
                "angle_degrees": round(result.angle_degrees, 2),
                "warnings": list(result.warnings),
            }
            label = f"straightened {result.width}x{result.height} · {result.angle_degrees:.1f}°"
        else:
            right = Image.new("RGB", (source.width, source.height), (70, 70, 76))
            outcome = {
                "image": entry["image"],
                "note": entry.get("note", ""),
                "outcome": "abstained",
                "reason": result.reason,
                "detail": result.detail,
            }
            label = f"abstained: {result.reason}"
        outcome["boundary"] = {
            "verdict": support.verdict,
            "sides": [round(value, 3) for value in support.sides],
            "competing_sides": list(support.competing_sides),
        }
        outcomes.append(outcome)
        left = _fit(source, PANEL_MAX, 520)
        right = _fit(right, PANEL_MAX, 520)
        row_h = max(left.height, right.height) + 42
        rows.append((left, right, label, entry.get("note", ""),
                     _support_text(support), row_h))

    width = PANEL_MAX * 2 + 30
    height = sum(row[5] for row in rows) + 20
    sheet = Image.new("RGB", (width, height), (128, 128, 128))
    draw = ImageDraw.Draw(sheet)
    y = 10
    for left, right, label, note, support_line, row_h in rows:
        draw.text((10, y), f"original · {note}".strip(), fill=(20, 20, 20))
        draw.text((PANEL_MAX + 20, y), label, fill=(20, 20, 20))
        draw.text((10, y + 13), f"boundary: {support_line}", fill=(40, 40, 60))
        sheet.paste(left, (10, y + 30))
        sheet.paste(right, (PANEL_MAX + 20, y + 30))
        y += row_h

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() in (".jpg", ".jpeg"):
        sheet.convert("RGB").save(out_path, quality=92)
    else:
        sheet.save(out_path)
    outcomes_path = out_path.with_suffix(".json")
    outcomes_path.write_text(json.dumps(outcomes, indent=2))
    return outcomes_path, outcomes


def main() -> int:
    parser = argparse.ArgumentParser(description="Straighten helper contact sheet")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--synth", type=int, default=0,
                        help="generate N synthetic fixtures and process them")
    parser.add_argument("--no-boundary", action="store_true",
                        help="disable the boundary veto (shadow comparison)")
    args = parser.parse_args()

    if args.synth:
        base, entries, manifest = generate_synth(args.synth)
        print(f"synthetic fixtures: {base}")
        print(f"manifest: {manifest}")
    elif args.manifest:
        entries = json.loads(args.manifest.read_text())
    else:
        parser.error("provide --manifest or --synth")
        return 2

    outcomes_path, outcomes = build_sheet(
        entries, args.out, require_boundary=not args.no_boundary
    )
    print(f"contact sheet: {args.out}")
    print(f"outcomes: {outcomes_path}")
    for outcome in outcomes:
        boundary = outcome["boundary"]
        ratios = " ".join(f"{value:.2f}" for value in boundary["sides"])
        print(f"- {Path(outcome['image']).name}: {outcome['outcome']}"
              + (f" ({outcome['reason']})" if outcome.get("reason") else "")
              + f" | boundary {boundary['verdict']} [{ratios}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
