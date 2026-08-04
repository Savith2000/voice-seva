# direction-approved

**Date:** 2026-08-04
**Decision:** Direction **C — the Hara book page**, as-is.

## What was shown

Three directions were built as real, interactive, self-contained pages from one
shared spec (`design-spec.md`), by three independent designers who could not see
each other's work.

| | logic | file | screenshot |
|---|---|---|---|
| A | bold / style roulette | `design-demos/A-cinematic-dark.html` | `A-cinematic-dark.png` |
| B | real-world benchmark transfer | `design-demos/B-benchmark.html` | `B-benchmark.png` |
| C | best designer for this product | `design-demos/C-hara.html` | `C-hara.png` |

## The user's choice, in their words

> "I think the design of C is the best. So I think we should go with that,
> actually. I think that would be the best case scenario."

Chosen **as-is**, not as the C+B hybrid that was recommended. Build C faithfully.

## Note on the style roulette

The roll (`date +%S` → 9) selected *Pixel-Game Side-Scroller* from the web style
library. That was overridden as inappropriate for sacred scripture — the style
library is explicitly "ammunition when you have no ideas," not a mandate, and
content outranks it. Direction A took the adjacent bold style, *Cinematic
Sound-Viz Dark*, instead. The override was disclosed to the user rather than
made silently.

## What C is, in one paragraph

Not an app screen — a printed page. A **fore-edge measure** down the left edge
shows your place in a text whose length is already fixed. The text block is an
unprinted field the chanter's own voice fills, the active line inked
left-to-right by their progress. The English meaning sits as a **marginal
gloss** beside the verse it glosses. The SSIO emblem is set at the foot of the
margin like a **printer's seal**, the five values beneath it. Controls are a
**colophon** along the bottom that fades away after ten seconds of stillness and
returns on any movement. Light is a **dimmer, not a mode switch** —
Day / Lamp / Before dawn — which is the design's answer to the fact that this is
used before sunrise.

## Carried forward from the directions not chosen

Not to be built now, but recorded so the reasoning is not lost:

- **From B:** the rule that *uncertainty lives in the margin, never in the
  scripture.* Four states shown as four different **kinds** of mark in the
  gutter (solid daṇḍa / dashed / absent / neutral) rather than by brightness
  alone. This came out of a verified accessibility failure in Spotify's synced
  lyrics, where brightness is the only cue and low-vision users cannot tell
  which line is being sung. Worth revisiting when C's state treatment is tested
  at distance.
- **From A:** the **metre comb** — one stroke per syllable of the active line,
  long/short, with the chanter's position moving through it. The most beautiful
  idea of the three and the most expensive; a candidate for later, not v1.
- **From A, as a warning:** A surfaced the live transcript in a "HEARD" panel.
  That contradicts the project's founding principle that nobody ever sees the
  transcript — the model is *allowed* to be wrong so long as it is wrong
  consistently, and showing garbled Devanagari would make a correctly-working
  app look broken. The transcript belongs on `/harness`, never on `/chant`.

## Open questions against C, to resolve while building

1. Paper-white at 3 m in a hall — does the Lamp default hold up, or does group
   use need Before-dawn as its default?
2. C's active line is 54px against B's 62px. Check at real viewing distance.
3. The fore-edge measure is more beautiful than it is legible as navigation, and
   it now has to carry **24 sections, not 1** (see the import work). This is the
   part of C most likely to need rework.
