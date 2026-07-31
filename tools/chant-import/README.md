# chant-import

Turns the source PDF of an anuvaka into the JSON the app loads.

```bash
uv sync
uv run python decode_pdf.py ../../Rudram_1st_anuvaka.pdf   # -> decoded.json
uv run python verify.py                                    # cross-check
uv run python build_chant.py                               # -> src/data/chants/
```

`verify.py` is not optional. Run it, and read what it says.

## Why this is a program and not a copy-paste

The PDF (Sri Sathya Sai Books and Publications Trust, Prasanthi Nilayam) has a
text layer, but selecting it gives you this:

```
nm?Ste éÔ m/Nyv? %/taet/ #;?ve/ nm?>,
```

That is `नम॑स्ते रुद्र म॒न्यव॑ उ॒तोत॒ इष॑वे॒ नमः॑` in **Sanskrit99**, a legacy
8-bit font. The PDF declares it as WinAnsiEncoding with no `/ToUnicode` map, so
every tool reads the bytes as Latin. The transliteration underneath is a second
legacy font, **URWPalladioIT**, encoded differently again.

The fonts are embedded, but their glyph *names* are the stock Latin ones
("adieresis", "ntilde") — these are hacked font shells whose outlines were
replaced and whose naming was not. Nothing in the file says what any glyph
means.

So `chart_fonts.py` extracts each embedded font program and renders every code
point in its cmap as a labelled chart, and the maps in `decode_pdf.py` were
read off those charts by eye:

```bash
uv run --group fonts python chart_fonts.py ../../Rudram_1st_anuvaka.pdf
open fonts/
```

It also renders the pages, which is how a decode gets checked against what is
actually printed.

## Why the decode can be trusted

Reading 97 glyphs off a chart is exactly the kind of job where being 95% right
looks identical to being right. A mis-mapped glyph does not crash anything — it
produces plausible Devanagari in a sacred text.

The check is that **the PDF encodes the same anuvaka twice**, in two unrelated
fonts. Transliterate the Devanagari decode and it has to reproduce the roman
decode. `verify.py` does that per block, and it earned its keep:

- `¾` is **ज्ज**, not the ज्ञ it looks like — caught by *sarvamijjagadaya*.
- `{` is **ण्**, not the ए it resembles — caught by *nīlakaṇṭhāya*.
- Reph was landing *inside* conjuncts, giving बिभ॒ष्र्यस्त॑वे for
  बिभ॒र्ष्यस्त॑वे. The walk-back has to see the virama inside a piece like
  "ष्", so the buffer holds single characters rather than glyph pieces.

Four differences survive, and all four are the book disagreeing with itself.
Each was checked against the rendered page; the Devanagari is right in every
one, which is why the Devanagari is what ships and the transliteration is
generated from it rather than copied out:

| the book's roman layer | its Devanagari | |
|---|---|---|
| `sa dṛṣṭho` | स दृ॒ष्टो | stray *h*; दृष्टो is the received reading |
| `tebhyo karan` | तेभ्यो॑ऽकर॒न् | dropped avagraha |
| `bāṇavāgm uta` | बाण॑वाग्ं उ॒त | writes *gm* where it writes *gṁ* elsewhere |
| `giriśanta` | गिरिशंत | anusvara vs conjunct nasal, same sound |

## The two reorderings

Sanskrit99 stores glyphs in *drawing* order, not Unicode order.

**The i-matra** is drawn before its consonant, so `iz` is शि. It is held back
and emitted after the consonant cluster that follows it.

**Reph** is drawn above the syllable that follows it in Unicode, so `svaR` is
सर्वा. It has to walk back over that syllable's marks, its consonant, and any
half-consonants joined by a virama.

And one that is not the font's fault: **svara marks come out too early**.
`nm?>` is न म ॑ ः, but Unicode wants the accent after every matra, virama,
anusvara and visarga in the syllable. Unicode normalisation will not fix it —
reordering only applies to runs of non-zero combining class, and visarga is a
spacing mark of class 0. Left alone the visarga is orphaned and HarfBuzz draws
it on a dotted circle, so the page renders `नम॑◌ः` and nothing errors.
`chant.test.ts` pins all of this.

## What the output contains

Three fields per line, each from a different place on purpose:

- **`devanagari`** — exactly what the book prints, svara marks included. The
  only field a human reads, so the only one that must not be invented.
- **`transliteration`** — generated from the Devanagari with
  `indic_transliteration`, accents removed. Not copied from the PDF's roman
  layer, for the reasons in the table above. The accents have to come out
  first: sanscript passes ॑ through, and it then combines with whatever Latin
  letter follows, turning नमस्ते॑ into "namastḙ".
- **`normalized`** — produced by `tools/asr-bakeoff/normalize.py`, the same
  implementation the Chunk 3 gate was measured with. The matcher only ever
  sees this field.

**`meaning` is null on every line.** The PDF has no translation, and a
translation is an interpretation rather than a transcription — it needs a named
source rather than being filled in from memory.

## The PDF is not in the repo

`Rudram_1st_anuvaka.pdf` is gitignored. It is a Trust publication, and whether
to redistribute it is not a decision this tool should make quietly. Put it at
the repo root before running the importer.

It also carries a metadata flag asking that text not be extracted. pdfminer
notes this and continues. That flag is a request about the publisher's
typesetting, not a technical protection, and the text itself is scripture — but
it is worth knowing it is there.

## Adding the remaining anuvakas

The decoder is not specific to anuvaka 1; point it at another PDF from the same
edition and it should work unchanged. `build_chant.py` writes a single-anuvaka
file and would need its output path and the `anuvakas` array generalised.

If a PDF from a *different* publisher shows up, expect different fonts, so
re-run `chart_fonts.py` and check `verify.py` before believing any of it.
