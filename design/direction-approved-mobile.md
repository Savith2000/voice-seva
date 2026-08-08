# direction-approved-mobile

**Date:** 2026-08-08
**Decision:** Direction **M-A — the unrolling scroll** — for the phone build.

## The process

Second run of the three-designers process (see `direction-approved.md` for
the first). One shared spec (`design-spec-mobile.md`), three independent
designers who could not see each other's work, three self-contained
interactive pages at 390×844 in `design-demos/`. This round the visual world
was **not** in question — the built app is the authority and all three
inherit its paper, ink, tokens, motion grammar, and the living well verbatim.
The comparison was purely **reading topology**: how a tall narrow screen
carries a voice through scripture.

## The user's choice, in their words

> "Rolling scroll is definitely the best one, like, option number one."

Chosen after trying the three on their own phone.

## What M-A is, in one paragraph

The text is one continuous column filling the whole screen above a
collapsible bottom bar. The active line rides a **fixed reading anchor**
roughly a third down the screen, and the paper glides beneath it — the
shipped desktop behavior recomposed for a hand. The bar, collapsed, holds
exactly the living well and the state words; expanded, it is the sheet with
the full section navigation, script leads, size, light, microphone, verse
gloss, and the uncaptioned crest. A hand-scroll is a **glance**: it detaches
only the camera, a quiet "Back to the voice" pill names the way back, and
the paper returns by itself after ~8 s because a chanter's hands are not
free. A tap is a statement: it pins the position and re-attaches. The
running head describes the paper under the anchor; the bar describes the
voice — two honest voices, never one lying about the other.

## Carried forward from the directions not chosen

- **From M-B (the turned page):** the bookmark-ribbon return — a hand-turned
  reader is never yanked back, they are *offered* the way back by name. M-A's
  auto-return-after-8s should be tested against real use; if it ever feels
  like being yanked, M-B's consent model is the recorded alternative. Also
  the folio's honesty: pagination by measurement, never arithmetic.
- **From M-C (the breath):** the deterministic type scale keyed to the
  unit's own length (a lone invocation set enormous, a long salutation set
  smaller so one breath stays on one screen) — worth adopting inside M-A's
  active-unit emphasis. And the discipline that ghosting is done by size and
  position, never brightness alone.

## Open questions to resolve while building

1. M-A's demo emphasises the active unit at 18→25 px. Verify on the real
   phone at arm's length, against the desktop's larger jump.
2. The 8-second auto-return: right length? Right behavior at all? Needs a
   real chanting session on a real phone.
3. How the real tracker's holding/searching states read at the anchor
   (the demo only simulates following).
4. Where the fore-edge measure's job (place in the whole work) lives on the
   phone: the running head's "n · 33" carries it in the demo; 303 lines need
   the section, not the line count.
