# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Devotees of the Sri Sathya Sai International Organisation, broadly** — not a
single centre and not one person's practice tool.

They are chanting **out loud, from memory or near-memory, while looking at the
screen.** Hands are not free. They cannot stop to interpret an interface. Skill
ranges from people who have recited Sri Rudram for decades to people learning
it; reading ability ranges likewise, and **a large share read from the romanised
line rather than the Devanagari**, which is why both scripts are first-class and
either can lead.

Two usage scenes, both real:

- **Alone**, phone or laptop at roughly 40–70 cm.
- **Together**, one screen or projector in a centre or hall, read at 3 m or
  more, everyone chanting at once.

Age skews older than a typical web audience. Assume presbyopia is common rather
than exceptional.

## Product Purpose

Voice Seva listens to someone chanting Sanskrit scripture through the
microphone and **keeps the script in step with them**, so a reciter can follow a
long text without losing their place and without touching anything.

It currently carries the whole of **Sri Rudram — Namakam and Chamakam**: 24
sections, 303 lines, generated from a single edition.

Success is that a reciter finishes a 20–45 minute session having thought about
the chant and not about the app. The screen earns its place by disappearing.

## Positioning

**This is a matching problem, not a transcription problem** — and that reframing
is the product, not an implementation note.

The text is known, finite and fixed, and the transcript is never shown to
anyone. So the speech model is permitted to be wrong as long as it is wrong
*consistently*: systematic errors are normalised away before matching. That is
why a 94 M-parameter model on a laptop is sufficient where a transcription
product would need something far larger.

Two consequences a neighbouring product could not copy without adopting the same
reframing:

- **Everything runs in the browser.** No backend, no accounts, no API keys, and
  **no audio ever leaves the device.** For devotional recitation that is a
  dignity property, not a technical footnote.
- **The app is allowed to be uncertain, and says so.** A screen that twitches
  during a recitation is worse than one that lags, because a wrong line pulls
  someone out of the chant and a stale one does not.

## Operating Context

- **Before dawn is a normal time to chant.** Dim rooms are the common case, not
  an edge case; a bright screen at 5 a.m. is a functional problem.
- Sessions run **20–45 minutes** of continuous recitation.
- Chanting is **sustained and tonal, often in unison** — the opposite of the one
  person on a call that browser noise suppression and auto-gain are tuned for,
  so that processing is off by default.
- The reciter frequently **repeats, pauses for breath, or skips between
  anuvakas**. None of these are errors.
- Vedic recitation carries **pitch accents (svara)**. They are part of the text,
  not decoration, and must render.
- First use requires a **~190 MB one-time model download**, cached thereafter.

## Capabilities and Constraints

**Confirmed:**

- Follows live microphone audio and moves the script to match; the reciter can
  always override by hand, and a hand-placed position outranks the audio until
  the audio agrees or persistently disagrees.
- Devanagari and romanised IAST, either leading; text size and light level are
  user controls.
- Runs fully client-side. Microphone access requires a **secure context** —
  `localhost` qualifies, a plain-HTTP LAN address does not.
- 24 sections in chanting order: Namakam I–XI, Rudra mantras, Chamakam I–XI,
  Shanti mantras.

**Terminology** — use the tradition's words, not translations of them:
*anuvaka* (section), *verse*, *svara* (pitch accent), *Namakam* / *Chamakam*,
*seva* (selfless service).

**Explicitly undecided, and not to be invented:**

- **The speech model's licence is unverified.** Recorded in the project handoff
  as an open item and still open. Public distribution is now the stated
  destination, so this is **blocking**, not theoretical.
- **Redistribution rights for the source edition's text** have not been
  established. The decoded text ships in the app; the PDF itself does not, and
  it carries a metadata flag requesting that text not be extracted.
- **Whether user-uploaded PDFs ship at all**, and on what terms. Intended as a
  clearly-labelled beta, narrowly scoped, because splitting an arbitrary
  recitation into its sections reliably is unsolved.
- Any chant beyond Sri Rudram.

## Brand Commitments

**Sri Sathya Sai International Organisation. Use of the emblem and name is
approved** — confirmed by the owner, and therefore binding rather than
decorative.

- The emblem is the five-values lotus: **Truth · Right Conduct · Peace · Love ·
  Non-violence**. It is an organisational mark and is not to be recoloured,
  cropped, rotated, or placed on a busy field.
- Palette is sampled from the emblem itself, not chosen: brand blue `#0C5098`,
  brand orange `#EE7900`, ray orange `#FBBA74`.
- **Voice:** reverent, calm, unhurried, plain. It addresses someone mid-prayer.
  No marketing register, no exclamation, no cleverness.
- This is a devotional instrument used by people of many faiths — the emblem's
  own premise. Nothing in it should read as belonging to one tradition's
  aesthetics over another's.

## Evidence on Hand

- **The text**: `src/data/chants/sri-rudram-saiveda.json` — 303 lines, generated
  from the SaiVeda edition's romanised layer. Measured against the
  independently-decoded Sri Sathya Sai Trust edition of Anuvaka 1 at **0.0276
  character error with accents, 0.0208 after normalisation**, with every
  remaining difference being the two editions' anusvara/visarga convention.
- **The emblem**: `ssio-logo-english.png`, `public/ssio-logo.png`.
- **The model choice** was measured, not assumed: `tools/asr-bakeoff/` holds the
  bake-off, and `results-ctc.txt` holds the fifteen real transcripts every
  threshold in the app derives from.
- **The font**: Shobhika (SIL OFL 1.1), self-hosted, verified to cover U+1CDA.

**Absences that must not be filled in from memory:**

- **There is no translation.** Every `meaning` field is null on purpose. A
  translation is an interpretation rather than a transcription and needs a named
  edition. The source PDF does contain English, and shipping it is the owner's
  decision, not an oversight to be quietly corrected.
- **There is no second recording.** Every threshold in the follower comes from
  *one chanter, one session, fifteen windows.* No group recording, no second
  voice, no recording of someone deliberately jumping between anuvakas. This is
  the largest evidence gap in the product.

## Product Principles

1. **The screen serves the recitation, never the reverse.** If a decision helps
   the interface and costs the chanter attention, it is the wrong decision.
2. **Following is cheap, jumping is expensive.** Continuing needs ordinary
   evidence; moving somewhere else has to be corroborated. Asymmetry by design.
3. **Admit uncertainty rather than guess.** A held position is honest; a
   confidently wrong line is not.
4. **Nothing leaves the device.** A privacy property, and for prayer a matter of
   dignity.
5. **Sacred text is not content.** It is never paraphrased, silently corrected,
   auto-translated, or generated. Provenance is recorded and every deviation
   from a printed edition is measured and written down.

## Accessibility & Inclusion

- **Legibility at distance outranks novelty.** The active text must survive
  being read at 3 m in a hall; body text does not go below 16px and secondary
  text not below 13px.
- Contrast at or above **4.5:1** for readable text in every light setting,
  verified against the rendered surface rather than assumed.
- **Never encode state by brightness alone.** Verified accessibility complaints
  against comparable synced-lyric readers show low-vision users cannot tell
  which line is active when brightness is the only cue.
- Devanagari with svara marks needs generous line-height (≥1.9) or the accents
  collide.
- Every control reachable and visible by keyboard; the reading area scrollable
  by wheel, keyboard, touch and scrollbar, not by clicking alone.
- An older audience is the expected audience, not an accommodation.
