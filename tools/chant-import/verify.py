"""Check the Devanagari decode against the transliteration decode.

The PDF encodes the same anuvaka twice, in two unrelated legacy fonts. If both
font maps in decode_pdf.py are right, transliterating the Devanagari must
reproduce the roman layer. Anywhere it does not, either a map is wrong or the
edition disagrees with itself — and the diff says which.

This is the only reason to trust the decode at all. It is what caught `¾`
being ज्ज and not the ज्ञ it resembles, and reph landing inside conjuncts
(बिभ॒ष्र्यस्त॑वे for बिभ॒र्ष्यस्त॑वे).

    uv run python verify.py

Exits non-zero if anything beyond the known, listed source discrepancies
differs.
"""

from __future__ import annotations

import difflib
import json
import re
from pathlib import Path

from indic_transliteration import sanscript
from indic_transliteration.sanscript import transliterate

SVARA = re.compile("[॒॑᳚]")

# Places where the PDF's own two layers disagree. Each was checked against the
# rendered page, so these are the edition's slips, not decoding errors. The
# Devanagari is right in every one of them.
KNOWN_SOURCE_DIFFS = {
    "dṛṣṭho": "roman layer prints 'sa dṛṣṭho'; the Devanagari has स दृष्टो, "
              "which is the standard reading",
    "tebhyokaran": "roman layer drops the avagraha in तेभ्यो॑ऽकर॒न्नमः॑",
    "vāgmuta": "roman layer writes 'vāgm' where it writes 'gṁ' everywhere "
               "else; the Devanagari is consistent",
    "giriśanta": "roman layer writes 'giriśanta' against Devanagari "
                 "गिरिशंत — anusvara vs conjunct nasal, same sound",
}


def tidy(text: str) -> str:
    """Reduce to bare phonemes so only real disagreements survive."""
    # sanscript writes anusvara ṃ, this edition writes ṁ. Not a decode
    # question. Likewise ॐ, which sanscript renders "oṁ" and the book "om".
    text = SVARA.sub("", text).replace("ṃ", "ṁ").replace("’", "'")
    text = text.replace("oṁ", "om")
    text = re.sub(r"[|।॥,1१]", " ", text)
    return re.sub(r"\s+", "", text).strip()


def dev_to_iast(text: str) -> str:
    return tidy(transliterate(SVARA.sub("", text),
                              sanscript.DEVANAGARI, sanscript.IAST))


def blocks(lines: list[dict]) -> list[tuple[str, str]]:
    """Stitch wrapped lines together and pair each Devanagari run with the
    transliteration that follows it."""
    merged: list[list[str]] = []
    for line in lines:
        if line["kind"] in ("other", "heading"):
            continue
        if merged and merged[-1][0] == line["kind"]:
            merged[-1][1] += line["text"]
        else:
            merged.append([line["kind"], line["text"]])
    return [(merged[i][1], merged[i + 1][1])
            for i in range(len(merged) - 1)
            if merged[i][0] == "dev" and merged[i + 1][0] == "rom"]


def main() -> int:
    path = Path(__file__).with_name("decoded.json")
    if not path.exists():
        print("run decode_pdf.py first")
        return 1

    pairs = blocks(json.loads(path.read_text()))
    print(f"{len(pairs)} Devanagari/transliteration block pairs\n")

    unexplained = 0
    for n, (dev, rom) in enumerate(pairs, 1):
        got, want = dev_to_iast(dev), tidy(rom)
        if got == want:
            print(f"  [{n:2}] ok")
            continue

        excuse = next((why for key, why in KNOWN_SOURCE_DIFFS.items()
                       if key in want or key in got), None)
        if excuse:
            print(f"  [{n:2}] known source difference — {excuse}")
            continue

        unexplained += 1
        print(f"  [{n:2}] UNEXPLAINED")
        print(f"        devanagari -> iast : {got}")
        print(f"        roman layer        : {want}")
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(
                None, got, want).get_opcodes():
            if op != "equal":
                print(f"          {op:9} {got[max(0, i1 - 12):i2 + 12]!r} "
                      f"vs {want[max(0, j1 - 12):j2 + 12]!r}")

    print(f"\n{len(pairs) - unexplained}/{len(pairs)} blocks accounted for")
    return 1 if unexplained else 0


if __name__ == "__main__":
    raise SystemExit(main())
