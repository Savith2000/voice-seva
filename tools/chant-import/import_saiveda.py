"""Import the saiveda edition of Sri Rudram — Namakam, Chamakam and the mantras.

    uv run --with pdfminer-six --with indic-transliteration python import_saiveda.py

This is a different program from decode_pdf.py, for a different publisher.

decode_pdf.py handles the Sri Sathya Sai Trust edition by decoding its
Devanagari font glyph by glyph, from maps read off rendered charts by eye. That
works and it is trustworthy, but it is ~100 glyphs of hand work per publisher.

This edition does not need it. It carries the text four times — Devanagari, a
romanised IAST layer with the Vedic accents, a simplified phonetic line, and an
English translation — and the IAST layer extracts almost intact. So the
Devanagari here is *generated from the roman layer* rather than decoded, which
turns ~100 glyphs of eye-work into twelve.

WHAT THIS COSTS, STATED PLAINLY
-------------------------------
The Devanagari that ships is derived, not photographed. That is a real
provenance step down from decode_pdf.py, which ships exactly what the book
prints. It was measured before being accepted: against the already-verified
Anuvaka 1 from the Trust edition, verses 1-13 agree to within 13 sites totalling
about 15 characters in 713 — and every one of those is the two publishers'
different sandhi convention (saiveda sets `iṣuś śivatamā`, the Trust edition
sets `iṣuḥ śivatamā`), not a decode error. After normalisation, which is all the
matcher ever sees, those differences are far below the speech model's own 0.095
instability.

THE THREE SIGNALS, AND WHAT EACH IS ACTUALLY GOOD FOR
-----------------------------------------------------
Sections are found by using each of the document's signals only for the thing
it does not lie about. This was learned by being lied to:

  Sanskrit2003 headings   TRUE section boundaries. One per section, in order.
  Times-Roman headers     Reliable for the WORK (Namakam / Chamakam). NOT for
                          the anuvaka: the running header names the anuvaka
                          that *begins* on a page, so where Anuvaka 1 spills
                          over it reads "Anuvāka 2" above Anuvaka 1's last
                          verses. Believing it silently truncated Anuvaka 1 at
                          verse 13 and ate the closing salutation.
  ||N|| verse markers     A self-checking sequence — it must step by one and
                          reset at a boundary. Used as corroboration, not as
                          the primary signal.

And the trap underneath all of them: **Namakam and Chamakam each number their
anuvakas 1-11**, so any rule keyed on the number alone welds two unrelated
passages together. The only outward symptom of that is a surplus of च and स —
the *ca me* refrain — in a character histogram.

EXPECTED SHAPE (this is the gate; see verify() at the foot)
-----------------------------------------------------------
    Namakam    anuvakas 1-11
    Rudra mantras
    Chamakam   anuvakas 1-11
    Shanti mantras
    = 24 sections, 22 of which are anuvakas.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
import warnings
from collections import Counter
from pathlib import Path

warnings.filterwarnings("ignore")

from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTChar, LTTextLine
from indic_transliteration import sanscript
from indic_transliteration.sanscript import transliterate

ROOT = Path(__file__).resolve().parents[2]
PDF = ROOT / "rudram-namakam-chamakam.pdf"
OUT = ROOT / "src/data/chants/sri-rudram-saiveda.json"

IAST_FONT = "URWPalladioITU"       # the accented roman layer — our source
HEAD_FONT = "Sanskrit2003"         # real section headings are set in this
FURNITURE = "Times"                # running header, source credit, folio

# --- the roman font's twelve unmapped glyphs --------------------------------
# Four announce themselves as "(cid:N)". The rest resolve through WinAnsi into
# ordinary ASCII and are silently wrong, which is why counting only the honest
# failures put this at four. Each was confirmed against a word whose spelling
# is already known from the verified edition.
CIDS = {
    "(cid:23)": "ṣ",   # i(cid:23)u̍ś     -> iṣuḥ
    "(cid:24)": "ḥ",   # nama(cid:24)     -> namaḥ
    "(cid:28)": "ṛ",   # m(cid:28)(cid:29)aya -> mṛḍaya
    "(cid:29)": "ḍ",
    "(cid:1)": "oṃ ",  # the om sigil, set as a single glyph
}
SILENT = {
    ".": "ṇ",          # aru.a       -> aruṇa
    "&": "gṃ",         # hi&sīḥ      -> higṃsīḥ
    "%": "ṃ",          # yāmiṣu%     -> yāmiṣuṃ
    "+": "g",          # ahī+śca     -> ahīgśca
}
DIGITS = {
    "1": "ṃ",          # sa1vṛdhvane -> saṃvṛdhvane
    "2": "ṭ",          # kā2yāya     -> kāṭyāya
    "7": "ḷ",          # k7ptañ      -> kḷptaṃ
}

# --- accents ----------------------------------------------------------------
# EXACT, never a range. The marks that carry accent sit immediately beside the
# marks that carry meaning: U+030D (udatta) next to U+0304 (the ā in rudrāya),
# U+0331 (anudatta) next to U+0323 (the ṣ ṛ ḍ ḥ). A tidy-looking [̀-̳]
# swallows the second column and the damage is silent — rudrāya becomes
# रुद्रय, namaḥ becomes नमह्, both perfectly well-formed words.
UDATTA, ANUDATTA, DIRGHA = "̍", "̱", "̎"
SVARA = {UDATTA: "॑", ANUDATTA: "॒", DIRGHA: "᳚"}
# Sentinels ride through transliteration untouched and land exactly where the
# accent was, which is how the accent survives a script change at all.
SENTINEL = {UDATTA: "\x01", ANUDATTA: "\x02", DIRGHA: "\x03"}

# Unicode wants the svara AFTER every matra, virama, anusvara and visarga in
# the syllable, but IAST writes it on the vowel — so `nama̍ḥ` transliterates to
# नम॑ः when the correct form is नमः॑. NFC will NOT repair this: reordering only
# applies within runs of non-zero combining class, and visarga is a spacing
# mark of class 0. Left alone the visarga is orphaned and HarfBuzz draws it on
# a dotted circle. Tests, typecheck and build all pass; it is visible only on
# screen. This is landmine 4 in HANDOFF.md, met from the other direction.
TRAILING = "ा-ौ्ंँःॢॣॕ-ॗ"
MISORDERED = re.compile(f"([॒॑᳚])([{TRAILING}])")


def tagged_lines(pdf: Path) -> list[tuple[str, str]]:
    """(font, text) for every line, in reading order."""
    out: list[tuple[str, str]] = []

    def walk(node):
        if isinstance(node, LTTextLine):
            chars = [c for c in node if isinstance(c, LTChar)]
            if chars:
                font = Counter(
                    c.fontname.split("+")[-1] for c in chars
                ).most_common(1)[0][0]
                out.append((font, node.get_text().rstrip()))
            return
        try:
            for child in node:
                walk(child)
        except TypeError:
            pass

    for page in extract_pages(str(pdf), laparams=LAParams()):
        walk(page)
    return out


def repair(text: str) -> str:
    """Undo the font's failures, then drop the printed verse apparatus.

    Order matters: verse markers go before digit glyphs are mapped, or the 1
    in ||1|| becomes an anusvara.
    """
    for bad, good in CIDS.items():
        text = text.replace(bad, good)
    for bad, good in SILENT.items():
        text = text.replace(bad, good)
    text = re.sub(r"\|+\s*\d*\s*\|*", " ", text)
    for bad, good in DIGITS.items():
        text = text.replace(bad, good)
    text = re.sub(r"[,\-–]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def to_devanagari(iast: str) -> str:
    """IAST -> Devanagari, carrying the Vedic accents across.

    Compose FIRST, then substitute. Decomposing first looks tidier and is
    wrong: canonical ordering sorts combining marks by class, and anudatta
    U+0331 (below, class 220) sorts BEFORE macron U+0304 (above, class 230).
    So `ā̱` decomposes to a + anudatta + macron, the sentinel lands between the
    `a` and its own macron, and NFC can no longer put them back together — the
    macron is orphaned and rudrāya ships as रुद्र॒̄य. In composed form the
    vowel is one character and the accent simply follows it.
    """
    text = unicodedata.normalize("NFC", iast)
    for mark, sentinel in SENTINEL.items():
        text = text.replace(mark, sentinel)
    text = text.replace("'", "ऽ").replace("’", "ऽ")
    out = transliterate(text, sanscript.IAST, sanscript.DEVANAGARI)
    for mark, sentinel in SENTINEL.items():
        out = out.replace(sentinel, SVARA[mark])
    # Walk the svara past anything that Unicode says must precede it. Repeat:
    # one syllable can carry a matra and an anusvara both.
    for _ in range(4):
        fixed = MISORDERED.sub(r"\2\1", out)
        if fixed == out:
            break
        out = fixed
    return unicodedata.normalize("NFC", out)


def strip_accents(text: str) -> str:
    text = unicodedata.normalize("NFD", text)
    text = re.sub(f"[{UDATTA}{ANUDATTA}{DIRGHA}]", "", text)
    text = re.sub("[॑-॔᳐-᳿꣠-ꣿ]", "", text)
    return unicodedata.normalize("NFC", text)


def sections(lines: list[tuple[str, str]]) -> list[dict]:
    """Split the document into its printed sections, in chanting order."""
    anuvaka = re.compile(r"Anuv[āa]ka\s+(\d+)", re.I)
    rudra = re.compile(r"Rudra\s+Mantra", re.I)
    shanti = re.compile(r"[śs]h?[āa]nti\s+Mantra", re.I)
    work_of = re.compile(r"(Namakam|Chamakam)", re.I)

    found: list[dict] = []
    work = "namakam"
    for font, text in lines:
        stripped = text.strip()
        # Furniture is read ONLY for the work name, never for the section.
        if font.startswith(FURNITURE):
            seen = work_of.search(stripped)
            if seen:
                work = seen.group(1).lower()
            continue
        if font != HEAD_FONT or len(stripped) > 40:
            continue
        if rudra.search(stripped):
            found.append({"kind": "rudra-mantras", "number": None, "work": work})
        elif shanti.search(stripped):
            found.append({"kind": "shanti-mantras", "number": None, "work": work})
        else:
            seen = anuvaka.search(stripped)
            if seen:
                found.append(
                    {"kind": "anuvaka", "number": int(seen.group(1)), "work": work}
                )
    return found


def collect(lines: list[tuple[str, str]]) -> list[dict]:
    """Attach the IAST lines to the section they fall inside."""
    anuvaka = re.compile(r"Anuv[āa]ka\s+(\d+)", re.I)
    rudra = re.compile(r"Rudra\s+Mantra", re.I)
    shanti = re.compile(r"[śs]h?[āa]nti\s+Mantra", re.I)
    work_of = re.compile(r"(Namakam|Chamakam)", re.I)

    out: list[dict] = []
    work = "namakam"
    current: dict | None = None
    for font, text in lines:
        stripped = text.strip()
        if font.startswith(FURNITURE):
            seen = work_of.search(stripped)
            if seen:
                work = seen.group(1).lower()
            continue
        if font == HEAD_FONT and len(stripped) <= 40:
            kind = number = None
            if rudra.search(stripped):
                kind = "rudra-mantras"
            elif shanti.search(stripped):
                kind = "shanti-mantras"
            else:
                seen = anuvaka.search(stripped)
                if seen:
                    kind, number = "anuvaka", int(seen.group(1))
            if kind:
                current = {"kind": kind, "number": number, "work": work, "iast": [], "raw": []}
                out.append(current)
                continue
        if current is not None and font == IAST_FONT:
            # Capture the printed verse number BEFORE repair() strips the
            # apparatus. A line ending ||N|| closes verse N; the lines above it
            # since the last marker belong to the same verse.
            # A group closes on a numbered ||N||, and ALSO on a bare || with no
            # number. The second case is not decoration: the opening invocation
            # oṃ namo bhagavate rudrāya ends in a bare || and is a unit on its
            # own, but the printed ||1|| does not arrive until two lines later.
            # Closing only on numbers swept the invocation into the first
            # couplet and made it a group of three, which is wrong on the page
            # and wrong to chant from.
            closes = re.search(r"\|\|\s*(\d+)\s*\|\|", stripped)
            bare = closes is None and re.search(r"\|\|\s*$", stripped) is not None
            fixed = repair(stripped)
            if fixed:
                current["iast"].append(fixed)
                current["raw"].append(
                    int(closes.group(1)) if closes else (0 if bare else None)
                )
    return out


def numbered(section: dict) -> list[int]:
    """Group index per line, counting the units the page actually prints.

    This is a **group index, not the printed verse number**, and they differ by
    one for the whole of Namakam anuvaka 1 — the book prints ||1|| after the
    first couplet, which is the second group, because the invocation before it
    is unnumbered. The already-verified Trust-edition file counts groups the
    same way, so this keeps one convention across both editions rather than two
    that look alike.

    Almost every group is a couplet. A handful are not, and those are real: the
    invocation stands alone, and the closing salutation runs to four lines that
    are chanted as one breath and must stay together.
    """
    marks = section["raw"]
    out = [0] * len(marks)
    pending: list[int] = []
    group = 0
    for i, mark in enumerate(marks):
        pending.append(i)
        if mark is not None:
            group += 1
            for j in pending:
                out[j] = group
            pending = []
    for j in pending:  # a trailing group the page never closed
        out[j] = group + 1
    return out


def build(found: list[dict]) -> dict:
    """The app's chant JSON, in chanting order."""
    sys.path.insert(0, str(ROOT / "tools/asr-bakeoff"))
    from normalize import normalize  # noqa: E402

    anuvakas = []
    sequence = 0
    for section in found:
        verses = numbered(section)
        lines = []
        for iast, verse in zip(section["iast"], verses):
            sequence += 1
            devanagari = to_devanagari(iast)
            lines.append(
                {
                    "sequence": sequence,
                    "verse": verse,
                    "devanagari": devanagari,
                    "transliteration": strip_accents(iast),
                    # A translation is an interpretation rather than a
                    # transcription. This edition has one, but shipping it is
                    # the owner's call, not this importer's.
                    "meaning": None,
                    "normalized": normalize(devanagari),
                }
            )
        if section["kind"] == "anuvaka":
            title = f"{section['work'].title()} · Anuvāka {section['number']}"
            ident = f"{section['work']}-anuvaka-{section['number']}"
        else:
            title = f"{section['work'].title()} · {section['kind'].replace('-', ' ').title()}"
            ident = f"{section['work']}-{section['kind']}"
        anuvakas.append(
            {
                "number": section["number"],
                "work": section["work"],
                "kind": section["kind"],
                "id": ident,
                "title": {"english": title},
                "lines": lines,
            }
        )

    return {
        "id": "sri-rudram-saiveda",
        "name": {
            "devanagari": "श्री रुद्रम्",
            "transliteration": "śrī rudram",
            "english": "Sri Rudram — Namakam and Chamakam",
        },
        "source": {
            "edition": "SaiVeda (www.saiveda.net), Roman Coloured Coding Script",
            "file": "rudram-namakam-chamakam.pdf",
            "note": (
                "The Devanagari is GENERATED from this edition's romanised IAST "
                "layer, not decoded from its Devanagari font — that font is a "
                "legacy 8-bit face whose bytes read as Latin. Measured against "
                "the independently-verified Anuvaka 1 of the Sri Sathya Sai "
                "Trust edition: 0.0276 character error with accents, 0.0208 "
                "after normalisation, and every remaining difference is the two "
                "editions' anusvara/visarga convention rather than a decode "
                "error. See tools/chant-import/import_saiveda.py."
            ),
        },
        "generated_by": "tools/chant-import/import_saiveda.py",
        "normalization": {
            "implementation": "src/lib/chant/normalize.ts",
            "deaspirate": True,
            "note": "The normalized field is what the matcher sees.",
        },
        "anuvakas": anuvakas,
    }


def verify(found: list[dict]) -> list[str]:
    """The gate. Returns complaints; empty means the shape is right."""
    problems: list[str] = []
    shape = [(s["work"], s["kind"], s["number"]) for s in found]

    expected = (
        [("namakam", "anuvaka", n) for n in range(1, 12)]
        + [("namakam", "rudra-mantras", None)]
        + [("chamakam", "anuvaka", n) for n in range(1, 12)]
        + [("chamakam", "shanti-mantras", None)]
    )
    if shape != expected:
        problems.append(f"shape is not the expected 24 sections (got {len(shape)})")
        for i in range(max(len(shape), len(expected))):
            got = shape[i] if i < len(shape) else None
            want = expected[i] if i < len(expected) else None
            if got != want:
                problems.append(f"    at {i}: got {got}, expected {want}")
    for s in found:
        if not s.get("iast"):
            problems.append(f"    empty: {s['work']} {s['kind']} {s['number']}")
    return problems


def main() -> int:
    lines = tagged_lines(PDF)
    found = collect(lines)

    print(f"lines in document        {len(lines)}")
    print(f"sections found           {len(found)}")
    print()
    for i, s in enumerate(found):
        label = (
            f"{s['work']} anuvaka {s['number']}"
            if s["kind"] == "anuvaka"
            else f"{s['work']} {s['kind']}"
        )
        print(f"  {i + 1:2}. {label:28} {len(s['iast']):3} lines")

    print()
    problems = verify(found)
    if problems:
        print("GATE FAILED:")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print("GATE PASSED — 24 sections, 22 anuvakas, in chanting order.")

    chant = build(found)
    total = sum(len(a["lines"]) for a in chant["anuvakas"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(chant, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}  —  {len(chant['anuvakas'])} sections, {total} lines")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
