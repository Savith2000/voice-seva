# brand-spec · Voice Seva

## Organisation

**Sri Sathya Sai International Organisation (SSIO).** Spiritual/service organisation.
Voice Seva is a chanting-companion app made for it. *Seva* means selfless service.

## Assets held

| asset | path | note |
|---|---|---|
| Primary emblem | `ssio-logo-english.png` (repo root) | 2010×2024 PNG, transparent |
| Embed-ready, 512px | `design/assets/ssio-logo.b64` | data-URI, 138 KB |
| Embed-ready, 160px | `design/assets/ssio-logo-sm.b64` | data-URI, 33 KB — use this in headers |

The emblem is the five-values lotus: a central white disc holding the orange
Sarva Dharma pillar with radiating rays, ringed by five blue petals reading
**TRUTH · RIGHT CONDUCT · PEACE · LOVE · NON-VIOLENCE**, interleaved with orange
petal tips.

## Colour — sampled, not guessed

Pixel-counted from the actual PNG (`PIL`, alpha > 200). These are measured values,
not eyeballed:

| role | hex | share of artwork |
|---|---|---|
| Brand blue | `#0C5098` | 34.6% |
| Brand orange | `#EE7900` | 15.6% |
| Ray orange (light) | `#FBBA74` | 1.3% |
| White | `#FFFFFF` | 46.7% |

### Derivation note (required by the colour protocol)

The blue is a deep institutional blue — low chroma for its depth, closer to
ink than to a SaaS accent. The orange is a saffron/marigold, the colour of
Indian devotional cloth and of the marigold garland; it is the *warm* half of
the identity and should carry the moments of life and attention. Blue is
structure and authority; orange is presence and the living voice.

**For UI, push both toward ink rather than screen-fluorescence.** Large fields
of `#EE7900` at full chroma will read as a warning banner, not as devotion.
Reserve full-chroma orange for small, earned moments — most importantly the
*currently-chanted line*. That is the single most important pixel in the app and
it should be the only thing wearing the brand orange at full strength.

## Forbidden

- Do not recolour, rotate, crop or place the emblem on a busy background. It is
  an organisational emblem, not decoration.
- Do not distort the five-value ring or set the emblem below body-text size.
- No purple gradients, no emoji icons, no generic tech-neon. This is a
  devotional instrument used by people of many faiths.

## Tone

Reverent, calm, unhurried, plain. The app is used *during* recitation by someone
who cannot stop to interpret the screen. Every decision serves that person.
