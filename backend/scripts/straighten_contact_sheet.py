"""Contact sheet for the straighten-and-crop helper.

Reads a JSON manifest of ``{"image": path, "quad": [[x, y], ...]}`` entries and
writes the original and straightened panels side by side, with a sibling JSON of
outcomes. ``--synth N`` generates deterministic fixtures and a manifest first so
the tool can be exercised without a phone.
"""

from __future__ import annotations

import argparse
import json
import math
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

from services.scan_straighten import Abstained, Straightened, try_straighten

DARK = (26, 28, 34)
WHITE = (246, 246, 242)
GREY = (150, 152, 158)
PANEL_MAX = 900


def _card(width=215, height=300, nested=False, inner_art=False):
    card = Image.new("RGB", (width, height), WHITE)
    draw = ImageDraw.Draw(card)
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


def generate_synth(count: int) -> tuple[Path, list[dict], Path]:
    base = Path(tempfile.mkdtemp(prefix="straighten-synth-", dir="/tmp/opencode"))
    entries = []
    tilts = [0, 8, 16, 22]
    for index in range(max(0, count)):
        if index < len(tilts):
            name = f"tilt-{tilts[index]}"
            canvas, quad = _render_rotated(_card(), tilts[index])
            note = name
        elif index == 4:
            name = "loader-nested-border"
            canvas, quad = _render_rotated(_card(nested=True), 5)
            note = "loader-like nested border"
        elif index == 5:
            name = "inner-art-lock"
            canvas, quad = _render_rotated(_card(inner_art=True), 11)
            note = "inner-art lock"
        elif index == 6:
            name = "keystone"
            canvas, quad = _render_keystone()
            note = "keystone"
        elif index == 7:
            name = "partly-cut"
            canvas, quad = _render_rotated(_card(), 4)
            quad[3][0] = -30
            note = "partly cut by the frame"
        else:
            angle = [(0, "upright"), (9, "tilt-9"), (18, "tilt-18")][(index - 8) % 3]
            name = f"extra-{index:02d}-{angle[1]}"
            canvas, quad = _render_rotated(_card(), angle[0])
            note = angle[1]
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


def build_sheet(entries: list[dict], out_path: Path) -> tuple[Path, list[dict]]:
    rows = []
    outcomes = []
    for entry in entries:
        source = Image.open(entry["image"]).convert("RGB")
        result = try_straighten(source, entry["quad"])
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
        outcomes.append(outcome)
        left = _fit(source, PANEL_MAX, 520)
        right = _fit(right, PANEL_MAX, 520)
        row_h = max(left.height, right.height) + 26
        rows.append((left, right, label, entry.get("note", ""), row_h))

    width = PANEL_MAX * 2 + 30
    height = sum(row[4] for row in rows) + 20
    sheet = Image.new("RGB", (width, height), (128, 128, 128))
    draw = ImageDraw.Draw(sheet)
    y = 10
    for left, right, label, note, row_h in rows:
        draw.text((10, y), f"original · {note}".strip(), fill=(20, 20, 20))
        draw.text((PANEL_MAX + 20, y), label, fill=(20, 20, 20))
        sheet.paste(left, (10, y + 18))
        sheet.paste(right, (PANEL_MAX + 20, y + 18))
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

    outcomes_path, outcomes = build_sheet(entries, args.out)
    print(f"contact sheet: {args.out}")
    print(f"outcomes: {outcomes_path}")
    for outcome in outcomes:
        print(f"- {Path(outcome['image']).name}: {outcome['outcome']}"
              + (f" ({outcome['reason']})" if outcome.get("reason") else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
