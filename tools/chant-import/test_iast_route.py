"""Does generating Devanagari FROM the roman layer actually work?

The saiveda PDF encodes each verse four times: Devanagari (Sanskrit2003, a
legacy 8-bit font whose bytes read as Latin — unusable without a hand-built
glyph map), romanised IAST with Vedic accents (URWPalladioITU, ~98% clean),
a simplified phonetic line, and an English translation.

Mapping the Devanagari font by eye is the expensive job. This script tests the
cheap alternative: repair the handful of broken glyphs in the ROMAN layer, then
run IAST -> Devanagari and get the script for free.

The test is possible at all because Anuvaka 1 already exists, decoded from a
DIFFERENT publisher's edition and verified against that edition's own roman
layer. That file is the answer key. If this route reproduces it, the route is
sound; where it does not, the differences say exactly what it costs.

    uv run --with pdfminer-six --with indic-transliteration python test_iast_route.py
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
KEY = ROOT / "src/data/chants/sri-rudram-namakam-anuvaka-1.json"

# The roman font's unmapped glyphs, read off by aligning against the verified
# text: i(cid:23)u̍ś / iṣuḥ, nama(cid:24) / namaḥ, m(cid:28)(cid:29)aya / mṛḍaya.
ROMAN_CIDS = {
    "(cid:23)": "ṣ",
    "(cid:24)": "ḥ",
    "(cid:28)": "ṛ",
    "(cid:29)": "ḍ",
    "(cid:1)": "oṃ ",  # the om sigil, set as a glyph rather than as letters
}

# ...and the ones that DON'T announce themselves.
#
# These resolve through WinAnsi to ordinary ASCII, so they survive extraction
# looking like punctuation and digits rather than like damage. Counting only
# the honest "(cid:N)" markers put the roman layer's glyph count at four; it is
# really twelve. Every one below was confirmed against a word whose spelling is
# already known from the verified edition.
ROMAN_SILENT = {
    ".": "ṇ",    # aru.a      -> aruṇa
    "&": "gṃ",   # hi&sīḥ     -> higṃsīḥ
    "%": "ṃ",    # yāmiṣu%    -> yāmiṣuṃ
    "+": "g",    # ahī+śca    -> ahīgśca
}

# Digits are glyphs too, but only inside a word — between pipes they are the
# printed verse number. Verse markers are stripped before this is applied.
ROMAN_DIGITS = {
    "1": "ṃ",    # sa1vṛdhvane -> saṃvṛdhvane
    "2": "ṭ",    # kā2yāya     -> kāṭyāya
    "7": "ḷ",    # k7ptañ      -> kḷptaṃ  (Chamakam's vocalic l)
}

# Vedic accents, carried in the roman layer as combining marks.
#
# This set is EXACT on purpose and must never be widened to a range. The marks
# that carry accent sit immediately beside the marks that carry meaning:
#
#   U+030D vertical line above  = udatta        strip
#   U+0304 macron above         = the ā in rudrāya      KEEP
#   U+0331 macron below         = anudatta      strip
#   U+0323 dot below            = the ṣ ṛ ḍ ḥ          KEEP
#
# A tidy-looking range like [̀-̳] swallows the second column, and the
# damage is silent: rudrāya becomes रुद्रय and namaḥ becomes नमह्, which are
# still perfectly well-formed Devanagari words. Measured, not theorised — that
# is exactly what the first run of this script produced.
UDATTA = "̍"
ANUDATTA = "̱"
DIRGHA = "̎"  # double vertical line above = dirgha svarita
ACCENTS = re.compile(f"[{UDATTA}{ANUDATTA}{DIRGHA}]")


def tagged_lines(pdf: Path, max_page: int) -> list[tuple[str, str]]:
    """(font, text) for every line, in reading order."""
    out: list[tuple[str, str]] = []

    def walk(node):
        if isinstance(node, LTTextLine):
            chars = [c for c in node if isinstance(c, LTChar)]
            if not chars:
                return
            font = Counter(c.fontname.split("+")[-1] for c in chars).most_common(1)[0][0]
            out.append((font, node.get_text().rstrip()))
            return
        try:
            for child in node:
                walk(child)
        except TypeError:
            pass

    for index, page in enumerate(extract_pages(str(pdf), laparams=LAParams())):
        walk(page)
        if index >= max_page:
            break
    return out


def anuvaka_slice(
    lines: list[tuple[str, str]], number: int, work: str = "namakam"
) -> list[str]:
    """The IAST lines belonging to one anuvaka of one work.

    Sliced on the printed headings rather than on page numbers — an anuvaka
    does not begin or end where a page does, and slicing by page is what made
    the first run compare 18 of the 33 lines and call it a result.

    `work` is not optional decoration. **Namakam and Chamakam each number their
    anuvakas 1-11**, so keying on "Anuvāka N" alone silently concatenates two
    unrelated passages. It is a quiet failure: the second run of this script
    glued Chamakam's first anuvaka onto Namakam's, and the only outward symptom
    was a surplus of च and स — the *ca me* refrain — in a character histogram.
    """
    head = re.compile(r"Anuv[āa]ka\s+(\d+)", re.I)
    work_head = re.compile(r"(Namakam|Chamakam)", re.I)
    current = 0
    current_work = "namakam"
    picked: list[str] = []
    for font, text in lines:
        # Times-Roman is page furniture — the running header, the source credit
        # and the folio. Its header names the anuvaka that *begins* on the
        # page, so on a page where Anuvaka 1 spills over and Anuvaka 2 starts,
        # it reads "Anuvāka 2" while the first lines under it are still
        # Anuvaka 1. Believing it silently truncated Anuvaka 1 at verse 13 and
        # lost the closing salutation. The real headings are set in the
        # Devanagari face.
        if font.startswith("Times"):
            continue
        found_work = work_head.search(text)
        if found_work:
            current_work = found_work.group(1).lower()
        found = head.search(text)
        if found:
            current = int(found.group(1))
            continue
        # Regular weight only. The Bold variant is the simplified phonetic
        # line, which is a different transliteration scheme entirely.
        if current == number and current_work == work and font == "URWPalladioITU":
            picked.append(text)
    return picked


def repair(text: str) -> str:
    """Undo the font's failures, then drop the printed verse apparatus.

    Order matters: the verse markers must go before the digit glyphs are
    mapped, or the 1 in ||1|| becomes an anusvara.
    """
    for cid, char in ROMAN_CIDS.items():
        text = text.replace(cid, char)
    for bad, good in ROMAN_SILENT.items():
        text = text.replace(bad, good)
    text = re.sub(r"\|+\s*\d*\s*\|*", " ", text)      # ||1||, ||, |
    for digit, char in ROMAN_DIGITS.items():
        text = text.replace(digit, char)
    return re.sub(r"[,\-–]", " ", text)


def strip_accents(text: str) -> str:
    """Remove Vedic accents from either script, for the accent-blind compare."""
    text = unicodedata.normalize("NFD", text)
    text = ACCENTS.sub("", text)
    text = re.sub("[॑-॔᳐-᳿꣠-ꣿ]", "", text)
    return unicodedata.normalize("NFC", text)


def to_devanagari(iast: str) -> str:
    iast = strip_accents(iast)
    iast = iast.replace("'", "ऽ").replace("’", "ऽ")
    return transliterate(iast, sanscript.IAST, sanscript.DEVANAGARI)


def only_devanagari(text: str) -> str:
    """Keep Devanagari letters and marks; drop spaces, dandas, digits, latin."""
    return "".join(
        c for c in text
        if "ऀ" <= c <= "ॿ" and c not in "।॥०१२३४५६७८९"
    )


def edits(a: str, b: str) -> int:
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def main() -> int:
    if not PDF.exists():
        print(f"missing {PDF}", file=sys.stderr)
        return 1

    key = json.loads(KEY.read_text())
    key_lines = key["anuvakas"][0]["lines"]
    truth_dev = only_devanagari(strip_accents("".join(l["devanagari"] for l in key_lines)))

    raw = anuvaka_slice(tagged_lines(PDF, max_page=40), number=1)
    cleaned = [repair(line).strip() for line in raw]
    iast = " ".join(x for x in cleaned if x)

    leftover = re.findall(r"\(cid:\d+\)", iast)
    generated = only_devanagari(to_devanagari(iast))

    distance = edits(generated, truth_dev)
    cer = distance / max(len(generated), len(truth_dev))

    # The number that actually decides this. The matcher never sees the text
    # above — it sees the normalised skeleton, which deliberately destroys the
    # very distinctions the two editions disagree about (every nasal and
    # anusvara collapse to न, visarga is deleted, vowel length is flattened).
    # A difference that survives normalisation is a difference that would move
    # the highlight; one that does not costs nothing.
    sys.path.insert(0, str(ROOT / "tools/asr-bakeoff"))
    from normalize import normalize as project_normalize  # noqa: E402

    norm_gen = project_normalize(to_devanagari(iast))
    norm_key = project_normalize("".join(l["devanagari"] for l in key_lines))
    norm_distance = edits(norm_gen, norm_key)
    norm_cer = norm_distance / max(len(norm_gen), len(norm_key))

    print("=" * 72)
    print("IAST-ROUTE TEST  ·  generated Devanagari vs the verified Trust edition")
    print("=" * 72)
    print(f"  roman lines pulled from PDF     {len(raw)}")
    print(f"  unrepaired glyphs remaining     {len(leftover)} {Counter(leftover).most_common(5)}")
    print(f"  generated chars (accent-blind)  {len(generated)}")
    print(f"  answer-key chars                {len(truth_dev)}")
    print(f"  edit distance                   {distance}")
    print(f"  character error rate            {cer:.4f}   ({100*(1-cer):.2f}% agreement)")
    print()
    print("  AS THE MATCHER SEES IT (after the project normaliser):")
    print(f"  generated / answer-key chars    {len(norm_gen)} / {len(norm_key)}")
    print(f"  edit distance                   {norm_distance}")
    print(f"  character error rate            {norm_cer:.4f}   ({100*(1-norm_cer):.2f}% agreement)")
    print()
    print("  For scale: the speech model's own instability is 0.095, and the two")
    print("  most similar lines of Anuvaka 1 differ by 0.516. Anything well under")
    print("  0.095 is quieter than the noise the matcher already tolerates.")
    print()

    print("-" * 72)
    print("FIRST DIVERGENCES (generated | answer key)")
    print("-" * 72)
    shown = 0
    i = j = 0
    while i < len(generated) and j < len(truth_dev) and shown < 12:
        if generated[i] == truth_dev[j]:
            i += 1
            j += 1
            continue
        print(f"  at {i:5}: ...{generated[max(0,i-14):i+14]}...")
        print(f"          ...{truth_dev[max(0,j-14):j+14]}...")
        shown += 1
        i += 1
        j += 1
    if shown == 0:
        print("  none — the two are identical.")
    print()
    print("SAMPLE — first 3 lines, generated from the roman layer:")
    for line in cleaned[:4]:
        if line:
            print(f"    IAST  {line[:82]}")
            print(f"    DEV   {to_devanagari(line)[:82]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
