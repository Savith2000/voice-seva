"""Decode the Sri Sathya Sai Books and Publications Trust anuvaka PDF.

The PDF carries the text twice — once in Devanagari and once in roman
transliteration — and *both* are in legacy 8-bit font encodings. The fonts are
embedded but declare WinAnsiEncoding with no /ToUnicode map, so a plain text
extraction returns things like `nm?Ste éÔ m/Nyv?` rather than नमस्ते.

Neither map below was guessed. Each font program was pulled out of the PDF and
every code point in its cmap rendered to a chart, and the maps were read off
those charts. The glyph *names* in the fonts are no help: they are the stock
Latin ones ("adieresis", "ntilde") because these are hacked font shells whose
outlines were replaced but whose naming was not.

The check that makes this trustworthy is that the two layers are independent
encodings of the same text: transliterate the Devanagari decode and it must
reproduce the roman decode. `verify.py` does exactly that, and it is what
caught `¾` being ज्ज rather than the ज्ञ it looks like at a glance.

Usage:
    uv run python decode_pdf.py ../../Rudram_1st_anuvaka.pdf
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTChar, LTTextContainer, LTTextLine

# --- URWPalladioIT: the transliteration layer -------------------------------
# Plain IAST, plus the two Taittiriya accent markers.
ROM = {
    "×": "॑",  # multiply    -> vertical bar above = svarita
    "Þ": "॒",  # Thorn       -> bar below          = anudatta
    "÷": "᳚",  # divide      -> double bar above   = dirgha svarita
    "à": "ṁ",  # agrave      -> m with dot above
    "ä": "ā",  # adieresis   -> a macron
    "å": "ṛ",  # aring       -> r with dot below
    "ç": "ś",  # ccedilla    -> s with acute
    "é": "ī",  # eacute      -> i macron
    "ë": "ṇ",  # edieresis   -> n with dot below
    "ì": "ṅ",  # igrave      -> n with dot above
    "ï": "ñ",  # idieresis   -> n tilde
    "ñ": "ṣ",  # ntilde      -> s with dot below
    "ò": "ḍ",  # ograve      -> d with dot below
    "ö": "ṭ",  # odieresis   -> t with dot below
    "ù": "ḥ",  # ugrave      -> h with dot below
    "ü": "ū",  # udieresis   -> u macron
    "'": "’",       # quotesingle -> avagraha
}

# --- Sanskrit99: the Devanagari layer ---------------------------------------
# A *visual order* font: it stores glyphs in the order they are drawn, not the
# order Unicode encodes them. Two consequences, both handled in decode_dev():
# the i-matra is stored before its consonant, and reph is stored after the
# syllable it sits above.
DEV = {
    # independent vowels
    "A": "अ", "#": "इ", "$": "ई", "%": "उ",
    # dependent vowel signs. "i" is pre-posed and handled separately.
    "a": "ा", "I": "ी", "u": "ु", "U": "ू", "…": "ु", "&": "ृ",
    "e": "े", "E": "ै",
    # marks and punctuation
    "!": "्", "œ": "्", "<": "ं", ">": "ः",
    "=": "ऽ", "`": "ॐ",
    "?": "॑", "/": "॒", "š": "᳚",
    ",": "।", ".": "॥", "1": "१",
    # simple consonants
    "b": "ब", "c": "च", "d": "द", "f": "ड", "g": "ग", "h": "ह", "j": "ज",
    "k": "क", "l": "ल", "m": "म", "n": "न", "o": "ख", "p": "प", "r": "र",
    "s": "स", "t": "त", "v": "व", "w": "थ", "x": "ध", "y": "य", "z": "श",
    '"': "घ", "D": "छ", "F": "ढ", "Q": "ठ", ";": "ष", "[": "ण",
    "É": "भ",
    # half consonants (consonant + virama)
    "B": "ब्", "C": "च्", "J": "ज्", "L": "ल्", "M": "म्", "N": "न्",
    "S": "स्", "T": "त्", "V": "व्", "X": "ध्", "_": "भ्", ":": "ष्",
    "{": "ण्", "ú": "क्ष्", "È": "त्र्", "Å": "त्त्",
    # ligatures and conjuncts
    "]": "क्ष", "´": "क्त", "¢": "ग्र", "¶": "ग्न",
    "¼": "ङ्ग", "Â": "ञ्च", "Ã": "ञ्ज", "¾": "ज्ज",
    "Æ": "त्न", "Ç": "त्र", "Ô": "द्र", "Ú": "न्न",
    "à": "प्र", "æ": "भ्र", "è": "म्र", "é": "रु",
    "í": "श्च", "ï": "श्र", "ñ": "श्व", "ò": "ष्ट",
    "ö": "स्र", "÷": "हु", "†": "दृ",
}

REPH = "R"
IMATRA = "i"
VIRAMA = "्"

# Everything that hangs off a consonant rather than standing on its own.
MARKS = set("ािीुूृॄेैोौ॒॑᳚ंः") | {VIRAMA}

# Pairs this font draws as two glyphs that Unicode encodes as one.
COMBINE = [("अा", "आ"), ("ाे", "ो"), ("ाै", "ौ"), ("अे", "ए"), ("अै", "ऐ")]

# A svara mark that ended up before the rest of its syllable's marks.
#
# The font draws the accent as soon as its glyph is reached, so "नमः॑" is
# stored as न म ॑ ः — accent, then visarga. Unicode wants the accent last,
# after every matra, virama, anusvara and visarga in the syllable. Left in the
# font's order the visarga is an orphan, and HarfBuzz renders it on a dotted
# circle: नम॑ः displays as "नम॑◌ः".
#
# Unicode normalisation will not fix this. Reordering only applies to runs of
# non-zero combining class, and visarga and anusvara are spacing marks of
# class 0 — so NFC walks straight past it.
MISORDERED_SVARA = re.compile("([॒॑᳚]+)([ंःािीुूृॄेैोौ्]+)")


def decode_dev(text: str) -> tuple[str, set[str]]:
    """Legacy Sanskrit99 bytes -> Unicode Devanagari.

    `out` holds single characters rather than whole glyph pieces on purpose.
    Reph has to scan back *through* a conjunct like "ष्" to land in front of
    it, and a list of multi-character pieces hides the very virama it needs to
    see — which silently produced बिभ॒ष्र्यस्त॑वे for बिभ॒र्ष्यस्त॑वे.
    """
    out: list[str] = []
    pending_i = False
    unknown: set[str] = set()

    for ch in text:
        if ch == IMATRA:
            # Drawn before its consonant, encoded after it.
            pending_i = True
            continue

        if ch == REPH:
            # Drawn above the syllable it precedes in Unicode, so walk back
            # over that whole syllable: its marks, its consonant, and any
            # half-consonants joined to it by a virama.
            j = len(out)
            while j > 0 and out[j - 1] in MARKS and out[j - 1] != VIRAMA:
                j -= 1
            if j > 0:
                j -= 1                                     # the consonant
                while j >= 2 and out[j - 1] == VIRAMA:     # and its half-forms
                    j -= 2
            out[j:j] = ["र", VIRAMA]
            continue

        if ch in (" ", "\xa0"):
            out.append(" ")
            continue

        piece = DEV.get(ch)
        if piece is None:
            unknown.add(ch)
            piece = f"<{ord(ch):04x}>"
        out.extend(piece)

        if pending_i and piece[-1] not in MARKS:
            out.append("ि")
            pending_i = False

    text_out = "".join(out)
    for a, b in COMBINE:
        text_out = text_out.replace(a, b)

    # Loop: one pass moves an accent past one run of marks, and a syllable can
    # have the accent buried deeper than that.
    while True:
        moved = MISORDERED_SVARA.sub(r"\2\1", text_out)
        if moved == text_out:
            break
        text_out = moved

    return unicodedata.normalize("NFC", text_out), unknown


def decode_rom(text: str) -> str:
    body = "".join(ROM.get(c, c) for c in text.replace("\xa0", " "))
    return unicodedata.normalize("NFC", body)


def font_kind(fontname: str) -> str:
    name = str(fontname)
    if "Sanskrit99" in name:
        return "dev"
    if "Palladio" in name:
        return "rom"
    return "other"


def extract(pdf: Path) -> list[dict]:
    """Read the PDF into per-line records, tagged by which layer they are."""
    rows: list[dict] = []
    for page_no, page in enumerate(
        extract_pages(str(pdf), laparams=LAParams(detect_vertical=False)), 1
    ):
        for element in page:
            if not isinstance(element, LTTextContainer):
                continue
            for line in element:
                if not isinstance(line, LTTextLine):
                    continue
                runs: list[list[str]] = []
                size = 0.0
                for char in line:
                    if not isinstance(char, LTChar):
                        continue
                    size = max(size, char.size)
                    kind = font_kind(char.fontname)
                    if runs and runs[-1][0] == kind:
                        runs[-1][1] += char.get_text()
                    else:
                        runs.append([kind, char.get_text()])
                if runs:
                    rows.append({"page": page_no, "y": round(line.y0, 1),
                                 "x": round(line.x0, 1),
                                 "size": round(size, 1), "runs": runs})
    rows.sort(key=lambda r: (r["page"], -r["y"], r["x"]))
    return rows


def decode(rows: list[dict]) -> tuple[list[dict], set[str]]:
    unknown: set[str] = set()
    out = []
    for row in rows:
        parts = []
        weight: dict[str, int] = {}
        for kind, raw in row["runs"]:
            weight[kind] = weight.get(kind, 0) + len(raw)
            if kind == "dev":
                decoded, missing = decode_dev(raw)
                unknown |= missing
                parts.append(decoded)
            elif kind == "rom":
                parts.append(decode_rom(raw))
            else:
                parts.append(raw)
        # Classify by the dominant font, not by any character. A roman line
        # ending in a Sanskrit99 danda is still a roman line, and tagging it
        # "dev" silently merges it into the previous Devanagari block.
        kind = max(weight, key=lambda k: weight[k])
        # The book title is Devanagari too, but it is set at 24pt against the
        # 16pt body. Left as "dev" it merges into the opening invocation.
        if kind == "dev" and row["size"] >= 20:
            kind = "heading"
        out.append({"page": row["page"], "kind": kind,
                    "size": row["size"], "text": "".join(parts)})
    return out, unknown


def main(argv: list[str]) -> int:
    pdf = Path(argv[1] if len(argv) > 1 else "../../Rudram_1st_anuvaka.pdf")
    if not pdf.exists():
        print(f"no such file: {pdf}", file=sys.stderr)
        return 1

    rows = extract(pdf)
    lines, unknown = decode(rows)

    out = Path(__file__).with_name("decoded.json")
    out.write_text(json.dumps(lines, ensure_ascii=False, indent=1) + "\n")

    for line in lines:
        print(f'p{line["page"]} [{line["kind"]:5}] {line["text"]}')
    print(f"\nwrote {out.name}  ({len(lines)} lines)")

    if unknown:
        codes = ", ".join(sorted(f"U+{ord(c):04X}" for c in unknown))
        print(f"UNKNOWN GLYPHS, map them before trusting this: {codes}",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
