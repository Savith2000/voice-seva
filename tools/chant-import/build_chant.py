"""Turn the decoded PDF into the chant JSON the app loads.

    uv run python decode_pdf.py && uv run python verify.py && \
    uv run python build_chant.py

Three fields per line, and each comes from a different place on purpose:

  devanagari      exactly what the book prints, svara marks and all. This is
                  the only field a human reads, so it is the one that must not
                  be invented.
  transliteration generated from the Devanagari, not copied from the PDF's own
                  roman layer. That layer has at least three slips (see
                  verify.py) and generating keeps it self-consistent.
  normalized      produced by tools/asr-bakeoff/normalize.py — the same
                  implementation the Chunk 3 gate was measured with. The
                  matcher only ever sees this field.

`meaning` is null throughout. The PDF has no translation, and a translation is
an interpretation rather than a transcription, so it needs a named source
rather than being filled in from memory.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

from indic_transliteration import sanscript
from indic_transliteration.sanscript import transliterate

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "tools" / "asr-bakeoff"))

from normalize import normalize  # noqa: E402  (needs the path above)

OUT = ROOT / "src" / "data" / "chants" / "sri-rudram-namakam-anuvaka-1.json"

# Danda ends a half-line, double danda ends a verse. Both are line breaks for
# a screen that highlights one line at a time.
SPLIT = re.compile(r"[।॥]")

# Udatta, anudatta and the Taittiriya double svarita.
SVARA = re.compile("[॒॑᳚]")


def clean(text: str) -> str:
    # A stray Latin comma sits after तया॒ऽस्मान् on page 3, in the body text
    # font rather than the Devanagari one. The transliteration layer has no
    # separator there and neither does the received text, so it is a typo.
    text = text.replace(",", " ")
    text = re.sub(r"\s+", " ", text)
    return unicodedata.normalize("NFC", text).strip()


def to_iast(text: str) -> str:
    """Devanagari -> IAST, without the accent marks.

    They have to come out first. sanscript passes svara through untouched, and
    a combining mark that meant "pitch on this syllable" over Devanagari lands
    on whatever Latin letter follows it: नमस्ते॑ becomes "namastḙ" and धनु॑ः
    becomes "dhanṷḥ". The accents stay in the devanagari field, which is the
    one that reproduces the book.
    """
    return unicodedata.normalize(
        "NFC", transliterate(SVARA.sub("", text),
                             sanscript.DEVANAGARI, sanscript.IAST))


def main() -> int:
    decoded = json.loads((HERE / "decoded.json").read_text())

    # Group consecutive Devanagari lines; each group is one printed verse.
    groups: list[str] = []
    previous = None
    for line in decoded:
        if line["kind"] != "dev":
            previous = line["kind"]
            continue
        if previous == "dev":
            groups[-1] += line["text"]
        else:
            groups.append(line["text"])
        previous = "dev"

    entries = []
    sequence = 0
    for verse_no, group in enumerate(groups, 1):
        for part in SPLIT.split(group):
            body = clean(part)
            # Drop the trailing verse number "१" and any empty fragments the
            # split leaves behind.
            body = re.sub(r"^[१-९0-9]+$", "", body).strip()
            if not body:
                continue
            sequence += 1
            entries.append({
                "sequence": sequence,
                "verse": verse_no,
                "devanagari": body,
                "transliteration": to_iast(body),
                "meaning": None,
                "normalized": normalize(body),
            })

    chant = {
        "id": "sri-rudram-namakam-anuvaka-1",
        "name": {
            "devanagari": "श्री रुद्रम्",
            "transliteration": "śrī rudram",
            "english": "Sri Rudram (Namakam)",
        },
        "source": {
            "edition": "Sri Sathya Sai Books and Publications Trust, "
                       "Prasanthi Nilayam",
            "file": "Rudram_1st_anuvaka.pdf",
            "note": "Decoded from the PDF's legacy Sanskrit99 and "
                    "URWPalladioIT font layers by tools/chant-import. Both "
                    "layers were decoded independently and cross-checked "
                    "against each other; see tools/chant-import/README.md.",
        },
        "generated_by": "tools/chant-import/build_chant.py",
        "normalization": {
            "implementation": "src/lib/chant/normalize.ts",
            "deaspirate": True,
            "note": "The normalized field is what the matcher sees. "
                    "chant.test.ts recomputes it and fails if it drifts.",
        },
        "anuvakas": [{
            "number": 1,
            "id": "anuvaka-1",
            "title": {"english": "Anuvaka 1"},
            "note": "Verse 1 is the opening invocation, "
                    "ॐ नमो भगवते रुद्राय.",
            "lines": entries,
        }],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(chant, ensure_ascii=False, indent=2) + "\n")

    for entry in entries:
        print(f'{entry["sequence"]:3}  v{entry["verse"]:<3} '
              f'{entry["devanagari"]}')
        print(f'     {entry["transliteration"]}')
        print(f'     -> {entry["normalized"]}')
    print(f"\nwrote {OUT.relative_to(ROOT)}  "
          f"({len(entries)} lines, {len(groups)} verses)")

    shortest = min(entries, key=lambda e: len(e["normalized"]))
    print(f'shortest normalized line: {len(shortest["normalized"])} chars '
          f'(#{shortest["sequence"]})')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
