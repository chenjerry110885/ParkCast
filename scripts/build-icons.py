#!/usr/bin/env python3
"""Generate ParkCast's app icons from a single geometric definition.

    python scripts/build-icons.py

Writes `favicon.svg`, `icon-192.png`, `icon-512.png` and `icon-maskable-512.png`
into `web/public/`. The outputs are committed; this script exists so they can be
regenerated rather than edited, and so the SVG and the PNGs cannot drift apart --
they are rasterised from the same numbers a few lines below.

**No image library.** Pillow would be a new dependency on a project whose whole
premise is no cost and no new attack surface, and the mark is a rounded square
and a letter P. PNG is a container format that the standard library already has
both halves of: `zlib` for the pixel stream and `struct` for the chunk headers.
A 4x supersampled coverage pass is what stands in for anti-aliasing.

The mark itself is deliberately dull -- a white parking `P` on the app's own
accent blue. It has to read at 16 px in a browser tab, so this is a legibility
exercise, not a branding one.

Runtime is a few seconds: the 512 px icons evaluate 512 x 512 x 4 x 4 sample
points per layer in pure Python. That is slow in the abstract and irrelevant in
practice, because this runs when the mark changes, which is approximately never.
"""

from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path

# The app's own accent, read off `--accent` in `web/src/index.css`. Duplicated
# rather than parsed out of the stylesheet: one value in two files that a human
# can compare on sight beats a CSS parser in a build script.
ACCENT = (0x1D, 0x5F, 0xD0)
ACCENT_HEX = "#1d5fd0"
WHITE = (0xFF, 0xFF, 0xFF)
WHITE_HEX = "#ffffff"

# Samples per pixel per axis. 4 (so 16 per pixel) puts edge steps below what the
# eye resolves at 16 px; 8 quadruples the runtime for no visible difference.
SUPERSAMPLE = 4

# Fraction of the canvas a maskable icon must keep clear on every side. Android
# crops maskable icons to an arbitrary shape -- circle, squircle, teardrop -- and
# guarantees only the central 80% survives. See the `maskable` note in `mark`.
MASKABLE_INSET = 0.10

# Corner radius of the plate, as a fraction of its width. Matches the rounding
# of the app's own cards closely enough to look like the same product.
PLATE_RADIUS = 0.22


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    """One length-tag-data-CRC PNG chunk."""
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def write_png(path: Path, rows: list[bytearray], width: int, height: int) -> int:
    """Write 8-bit RGBA rows as a PNG. Returns the file size in bytes.

    Filter type 0 ("None") on every scanline. Adaptive filtering would compress
    a photograph better; on a flat two-colour mark it mostly just adds code that
    has to be right.
    """
    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        # width, height, 8 bits per sample, colour type 6 (RGBA),
        # deflate, adaptive filtering, no interlace.
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(raw, 9))
        + _png_chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    return len(png)


def coverage(size: int, inside, samples: int = SUPERSAMPLE) -> list[list[float]]:
    """Per-pixel area coverage of the region `inside(x, y)`, in 0.0-1.0.

    This is the anti-aliasing: a pixel on the edge of the letterform reports the
    fraction of its `samples x samples` grid that landed inside the shape, and
    that fraction becomes the blend weight.
    """
    step = 1.0 / samples
    offset = step / 2
    out = []
    for py in range(size):
        row = [0.0] * size
        for px in range(size):
            hits = 0
            for sy in range(samples):
                y = py + offset + sy * step
                for sx in range(samples):
                    if inside(px + offset + sx * step, y):
                        hits += 1
            row[px] = hits / (samples * samples)
        out.append(row)
    return out


def glyph_geometry(inset: float, box: float) -> dict[str, float]:
    """The `P` letterform, in absolute units, inside a `box`-wide square at `inset`.

    A stem and a bowl, both described as areas rather than strokes so the same
    numbers can be sampled for a PNG and emitted as an SVG path. The bowl is the
    right half of an annulus, which is what makes the counter (the hole) a real
    hole instead of a lighter blue.
    """
    stem_x = inset + box * 0.315
    stem_w = box * 0.115
    return {
        "stem_x": stem_x,
        "stem_w": stem_w,
        "top": inset + box * 0.235,
        "bottom": inset + box * 0.775,
        # The bowl sits on the stem's right edge, so the two shapes abut exactly
        # and their union has no seam to anti-alias.
        "bowl_cx": stem_x + stem_w,
        "bowl_cy": inset + box * 0.385,
        "bowl_ro": box * 0.205,
        "bowl_ri": box * 0.088,
    }


def _glyph_test(g: dict[str, float]):
    """`inside(x, y)` for the letterform described by `glyph_geometry`."""

    def inside(x: float, y: float) -> bool:
        if g["stem_x"] <= x <= g["stem_x"] + g["stem_w"] and g["top"] <= y <= g["bottom"]:
            return True
        if x < g["bowl_cx"]:
            return False
        d2 = (x - g["bowl_cx"]) ** 2 + (y - g["bowl_cy"]) ** 2
        return g["bowl_ri"] ** 2 <= d2 <= g["bowl_ro"] ** 2

    return inside


def _rounded_square_test(size: float, radius: float):
    """`inside(x, y)` for a square with rounded corners, by clamped-centre distance."""

    def inside(x: float, y: float) -> bool:
        cx = min(max(x, radius), size - radius)
        cy = min(max(y, radius), size - radius)
        return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius

    return inside


def mark(size: int, *, maskable: bool = False) -> list[bytearray]:
    """Render the mark at `size` x `size` as RGBA rows.

    Two variants, and the difference is not cosmetic:

    - **Standard.** A rounded square with transparent corners, drawn edge to
      edge. This is the shape a browser tab and a favicon want.
    - **Maskable.** Full bleed, no rounding, no transparency anywhere, with the
      glyph shrunk into the central 80%. A launcher applies its *own* mask, so
      any transparent margin we leave shows up as a chipped corner behind it --
      the icon has to paint under the crop, not inside it.
    """
    s = float(size)
    if maskable:
        inset = s * MASKABLE_INSET

        def in_plate(x: float, y: float) -> bool:
            return True
    else:
        inset = 0.0
        in_plate = _rounded_square_test(s, s * PLATE_RADIUS)

    plate = coverage(size, in_plate)
    glyph = coverage(size, _glyph_test(glyph_geometry(inset, s - 2 * inset)))

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            alpha = plate[py][px]
            # Clamp the glyph to the plate: white must never spill past the
            # rounded corner into a pixel the plate does not cover.
            g = min(glyph[py][px], alpha)
            for channel in range(3):
                row.append(round(ACCENT[channel] * (1 - g) + WHITE[channel] * g))
            row.append(round(alpha * 255))
        rows.append(row)
    return rows


def favicon_svg(size: int = 512) -> str:
    """The standard variant as SVG, from the same numbers the raster uses.

    An SVG favicon is what a modern browser prefers, and generating it here is
    what keeps it honest: if the letterform moves, both formats move together.
    """
    g = glyph_geometry(0.0, float(size))
    n = lambda v: f"{v:g}"  # noqa: E731 -- one local formatter, not a helper worth naming
    radius = size * PLATE_RADIUS
    cx, cy, ro, ri = g["bowl_cx"], g["bowl_cy"], g["bowl_ro"], g["bowl_ri"]
    # Right half of an annulus: down the outside sweeping clockwise, back up the
    # inside sweeping anticlockwise, so the counter is subtracted, not painted.
    bowl = (
        f"M{n(cx)} {n(cy - ro)}"
        f"A{n(ro)} {n(ro)} 0 0 1 {n(cx)} {n(cy + ro)}"
        f"L{n(cx)} {n(cy + ri)}"
        f"A{n(ri)} {n(ri)} 0 0 0 {n(cx)} {n(cy - ri)}Z"
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'width="{size}" height="{size}" role="img" aria-label="ParkCast">'
        f'<rect width="{size}" height="{size}" rx="{n(radius)}" fill="{ACCENT_HEX}"/>'
        f'<g fill="{WHITE_HEX}">'
        f'<rect x="{n(g["stem_x"])}" y="{n(g["top"])}" '
        f'width="{n(g["stem_w"])}" height="{n(g["bottom"] - g["top"])}"/>'
        f'<path d="{bowl}"/>'
        f"</g></svg>\n"
    )


def main() -> None:
    default_out = Path(__file__).resolve().parent.parent / "web" / "public"
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out",
        type=Path,
        default=default_out,
        help=f"directory to write into (default: {default_out})",
    )
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    svg = out / "favicon.svg"
    svg.write_text(favicon_svg(), encoding="utf-8", newline="\n")
    print(f"{svg.name}: {svg.stat().st_size:,} bytes")

    for size, maskable, name in (
        (192, False, "icon-192.png"),
        (512, False, "icon-512.png"),
        (512, True, "icon-maskable-512.png"),
    ):
        written = write_png(out / name, mark(size, maskable=maskable), size, size)
        print(f"{name}: {size}x{size}{' maskable' if maskable else ''}, {written:,} bytes")


if __name__ == "__main__":
    main()
