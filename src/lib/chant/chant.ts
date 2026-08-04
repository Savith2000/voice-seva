// The chant script: types, and the flattening the matcher needs.
//
// The data is generated, not hand-written — tools/chant-import decodes the
// source PDF and emits src/data/chants/*.json. Do not edit that JSON by hand;
// edit the importer and re-run it, or the provenance is lost and `normalized`
// can drift away from what normalize.ts produces.
//
// Nothing here imports the JSON. Loading it is chant-data.ts's job, because
// the app resolves "@/data/..." through the bundler and `npm test` hands these
// files straight to Node, which knows nothing about tsconfig paths. Keeping
// the functions data-free lets both run the same code.

import { normalize } from "./normalize.ts";

export type ChantLine = {
  /** 1-based position in the whole chant. Stable; the UI keys off this. */
  sequence: number;
  /** Which printed verse this line came from. Several lines share one. */
  verse: number;
  /** Exactly what the source edition prints, svara marks included. */
  devanagari: string;
  /** IAST, generated from the Devanagari, accent marks removed. */
  transliteration: string;
  /** Null until a translation with a named source is supplied. */
  meaning: string | null;
  /** What the matcher compares against. Never shown to anyone. */
  normalized: string;
};

/**
 * One printed section of a chant.
 *
 * Named for the anuvaka because that is what almost every section is, but a
 * recitation also carries pieces that are not anuvakas at all — the Rudra
 * mantras that follow Namakam, the Shanti mantras that close Chamakam. Those
 * are chanted in sequence with everything else and so they live here too,
 * distinguished by `kind` rather than pushed into a separate list that the
 * scroll would then have to stitch back together.
 */
export type Anuvaka = {
  /**
   * Position within its own work, 1..11 — or null for a section that is not
   * numbered, like the closing mantras.
   *
   * Not unique on its own. **Namakam and Chamakam each number their anuvakas
   * 1 to 11**, so anything that identifies a section by this alone will
   * silently conflate two unrelated passages. Use `id`, or the pair with
   * `work`.
   */
  number: number | null;
  /** Which half of the recitation this belongs to. */
  work?: string;
  /** "anuvaka", or the sort of mantra group it is. */
  kind?: string;
  /** Unique across the whole chant. The safe key. */
  id: string;
  title: { english: string };
  note?: string;
  lines: ChantLine[];
};

export type Chant = {
  id: string;
  name: { devanagari: string; transliteration: string; english: string };
  source: { edition: string; file: string; note: string };
  normalization: { implementation: string; deaspirate: boolean; note: string };
  anuvakas: Anuvaka[];
};

/** Every line of every anuvaka, in chanting order. */
export function allLines(chant: Chant): ChantLine[] {
  return chant.anuvakas.flatMap((anuvaka) => anuvaka.lines);
}

export type FlatChant = {
  /** Every line's normalized text, concatenated with no separator at all. */
  text: string;
  /** lineAt[i] is the index into `lines` of the line owning text[i]. */
  lineAt: number[];
  lines: ChantLine[];
};

/**
 * Flatten the chant into one normalised string plus a character → line map.
 *
 * This is what turns "which line are we on?" into a substring search, and it
 * is why line boundaries and partial lines fall out for free.
 *
 * The lines are joined with nothing at all, deliberately. The normaliser has
 * already deleted every space, so a separator here would be a character that
 * can never appear in a transcript — costing an edit at every line boundary,
 * which is exactly where a 5-second window is most likely to land.
 *
 * Indices are UTF-16 units, matching String.slice and the regex engine.
 * Devanagari and the Vedic marks are all outside the astral planes, so this
 * agrees with counting code points; chant.test.ts pins that.
 */
export function flatten(chant: Chant): FlatChant {
  const lines = allLines(chant);
  const lineAt: number[] = [];
  let text = "";
  lines.forEach((line, index) => {
    text += line.normalized;
    for (let i = 0; i < line.normalized.length; i++) lineAt.push(index);
  });
  return { text, lineAt, lines };
}

/** Recompute a line's normalised form from its Devanagari. */
export function renormalize(line: ChantLine): string {
  return normalize(line.devanagari);
}
