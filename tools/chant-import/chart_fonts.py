"""Re-derive the font maps in decode_pdf.py, by eye.

The two fonts in the PDF have no /ToUnicode map and their glyph *names* are the
stock Latin ones, so nothing in the file says what any glyph means. The only
way to find out is to look at the outlines. This pulls each embedded font
program out of the PDF and renders a labelled chart of every code point in its
cmap, plus the pages themselves for checking a decode against what is printed.

    uv run --group fonts python chart_fonts.py ../../Rudram_1st_anuvaka.pdf

Nothing downstream depends on this; it is here so the maps in decode_pdf.py can
be re-checked rather than taken on faith.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pypdfium2 as pdfium
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader

OUT = Path(__file__).with_name("fonts")
LABEL_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def extract_fonts(pdf: Path) -> list[Path]:
    """Write out every embedded TrueType font program in the PDF."""
    reader = PdfReader(str(pdf))
    written: dict[str, Path] = {}
    for page in reader.pages:
        for ref in page.get("/Resources", {}).get("/Font", {}).values():
            font = ref.get_object()
            base = str(font.get("/BaseFont", "")).split("+")[-1]
            if not base or base in written:
                continue
            descriptor = font.get("/FontDescriptor")
            if descriptor is None:
                continue
            descriptor = descriptor.get_object()
            for key in ("/FontFile2", "/FontFile3", "/FontFile"):
                if key in descriptor:
                    path = OUT / f"{base}.ttf"
                    path.write_bytes(descriptor[key].get_object().get_data())
                    written[base] = path
                    print(f"  extracted {path.name}")
                    break
    return list(written.values())


def chart(ttf: Path, cols: int = 5, cell: int = 300) -> None:
    """Render every mapped code point, big, with its byte value in red."""
    codes = [c for c in sorted(TTFont(ttf).getBestCmap()) if c != 0x20]
    glyph = ImageFont.truetype(str(ttf), 150)
    label = ImageFont.truetype(LABEL_FONT, 34)

    for part in range((len(codes) + 24) // 25):
        chunk = codes[part * 25:(part + 1) * 25]
        rows = (len(chunk) + cols - 1) // cols
        image = Image.new("RGB", (cols * cell, rows * cell), "white")
        draw = ImageDraw.Draw(image)
        for i, code in enumerate(chunk):
            x, y = (i % cols) * cell, (i // cols) * cell
            draw.rectangle([x, y, x + cell - 1, y + cell - 1], outline="#999")
            # A baseline, so marks that sit above or below are unambiguous.
            draw.line([x, y + cell * 2 // 3, x + cell - 1, y + cell * 2 // 3],
                      fill="#e0e0e0")
            draw.text((x + 8, y + 6), f"{code:02x} {chr(code)}",
                      font=label, fill="red")
            draw.text((x + cell // 2, y + cell * 2 // 3), chr(code),
                      font=glyph, fill="black", anchor="ms")
        path = OUT / f"{ttf.stem}-{part}.png"
        image.save(path)
        print(f"  {path.name}")


def render_pages(pdf: Path, dpi: int = 400) -> None:
    for i, page in enumerate(pdfium.PdfDocument(str(pdf)), 1):
        path = OUT / f"page{i}.png"
        page.render(scale=dpi / 72).to_pil().save(path)
        print(f"  {path.name}")


def main(argv: list[str]) -> int:
    pdf = Path(argv[1] if len(argv) > 1 else "../../Rudram_1st_anuvaka.pdf")
    if not pdf.exists():
        print(f"no such file: {pdf}", file=sys.stderr)
        return 1
    OUT.mkdir(exist_ok=True)
    print("fonts:")
    for ttf in extract_fonts(pdf):
        chart(ttf)
    print("pages:")
    render_pages(pdf)
    print(f"\nopen {OUT}/ and read the maps off the charts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
