// Devanagari normalisation — the load-bearing idea of the whole project.
//
// The speech model will not produce correct Sanskrit. It produces something
// Hindi-shaped and mangled. These rules collapse the distinctions the model is
// unreliable about, so that "consistently wrong" becomes "identical after
// normalisation", and the matcher can find its position anyway.
//
// Every rule here destroys information on purpose. The test of a rule is not
// "is this linguistically sound?" but "does the model confuse these two
// things?" If it does, collapse them.
//
// This is a port of tools/asr-bakeoff/normalize.py, and the two must agree
// character for character — the gate in Chunk 3 was measured with the Python
// version, so any divergence means the browser is running against numbers that
// were never measured. normalize.test.ts pins that with vectors generated from
// the Python implementation.

/** 1. Vedic accent marks (svara).
 *
 * Pitch notation. No ASR model outputs them, but the *reference* text is full
 * of them, so they must go from both sides or nothing will ever match.
 *
 * U+0901 candrabindu and U+0902 anusvara are deliberately excluded and left to
 * the nasal rule. They used to be inside a U+0900–U+0902 range here, which
 * silently disabled two rows of that table: deletion reached them before
 * mapping could. Deleting is the worse behaviour — when the model writes "नं"
 * where the reference has "नम्", deleting leaves "न" against "नन्", while
 * mapping to न leaves "नन" against "नन्", which is most of a match.
 */
const SVARA = /[॑-॔ऀ꣠-꣱᳐-᳿]/gu;

/** 2. Punctuation, digits, verse separators.
 *
 * Danda and double danda separate verses. Model output has none of this;
 * reference text is full of it.
 */
const PUNCT =
  /[।॥०-९0-9.,;:!?'"“”‘’()[\]{}<>/\\|@#$%^&*_+=~`–—-]/gu;

/** 3. Sibilants: श palatal, ष retroflex, स dental.
 *
 * Three distinct sounds in Sanskrit. Models trained mostly on Hindi flip
 * between them constantly.
 */
const SIBILANTS: Record<string, string> = { श: "स", ष: "स" };

/** 4. Nasals.
 *
 * Sanskrit has five nasal stops plus anusvara plus candrabindu. Which one is
 * "correct" depends on what follows, and models get it wrong constantly.
 * Collapse the lot to न.
 */
const NASALS: Record<string, string> = {
  "ङ": "न",
  "ञ": "न",
  "ण": "न",
  "म": "न",
  "ं": "न", // anusvara
  "ँ": "न", // candrabindu
};

/** 5. Visarga — a breathy release at the end of a word.
 *
 * Sometimes transcribed as ह, usually just dropped. Delete it everywhere.
 */
const VISARGA = /ः/gu;

/** 6. Vowel length.
 *
 * Sanskrit distinguishes short and long vowels and it is meaningful. ASR does
 * not reliably hear the difference, least of all in chanting, where vowels are
 * stretched for melodic reasons rather than lexical ones.
 *
 * e and o have no short/long contrast in Devanagari and are left alone.
 */
const VOWEL_LENGTH: Record<string, string> = {
  // independent vowels
  "आ": "अ",
  "ई": "इ",
  "ऊ": "उ",
  "ॠ": "ऋ",
  // dependent vowel signs (matras)
  "ा": "", // ा -> the inherent a
  "ी": "ि", // ी -> ि
  "ू": "ु", // ू -> ु
  "ॄ": "ृ", // ॄ -> ृ
};

/** 7. Aspiration — optional.
 *
 * Phonemic in Sanskrit, but exactly the kind of fine detail a small model
 * drops. Toggleable because it destroys a lot of information.
 */
const ASPIRATION: Record<string, string> = {
  "ख": "क",
  "घ": "ग",
  "छ": "च",
  "झ": "ज",
  "ठ": "ट",
  "ढ": "ड",
  "थ": "त",
  "ध": "द",
  "फ": "प",
  "भ": "ब",
};

/** Nukta-bearing forms that Hindi-trained models emit for Sanskrit sounds. */
const NUKTA: Record<string, string> = {
  "ऩ": "न",
  "ऱ": "र",
  "ऴ": "ल",
  "क़": "क",
  "ख़": "ख",
  "ग़": "ग",
  "ज़": "ज",
  "ड़": "ड",
  "ढ़": "ढ",
  "फ़": "फ",
  "य़": "य",
  "़": "", // combining nukta
};

const WHITESPACE = /\s+/gu;

/** Apply a character map, leaving anything absent from it untouched. */
function translate(text: string, table: Record<string, string>): string {
  let out = "";
  // Iterate by code point, not by UTF-16 unit, so an astral character is never
  // split into halves that then get mapped independently.
  for (const char of text) out += table[char] ?? char;
  return out;
}

export type NormalizeOptions = {
  /** Collapse ख→क, घ→ग and so on. Default true, matching the Python harness. */
  deaspirate?: boolean;
};

/**
 * Collapse a Devanagari string to its matchable skeleton.
 *
 * The output is not readable Sanskrit and is not meant to be. It exists only to
 * be compared against other output of this same function.
 */
export function normalize(
  text: string,
  { deaspirate = true }: NormalizeOptions = {},
): string {
  if (!text) return "";

  // NFC first, so combining marks are in a predictable form before any of them
  // are deleted. Without it the same visible character can be one code point or
  // two, and the rules would fire inconsistently.
  let out = text.normalize("NFC");

  // Case-fold. Devanagari has no case, so this looks pointless — but the model
  // does not always emit Devanagari. Whisper told language="sa" returns
  // romanised text, and returned the *same* line as both "namasti rudra" and
  // "NAMASTE RUDR" across takes. Without this the matcher scored two identical
  // transcripts as completely different: 0.505 before the rule, 0.076 after.
  // Measured, not theorised.
  out = out.toLowerCase();

  out = out.replace(SVARA, "");
  out = translate(out, NUKTA);
  out = out.replace(PUNCT, "");
  out = translate(out, SIBILANTS);
  out = translate(out, NASALS);
  out = out.replace(VISARGA, "");
  out = translate(out, VOWEL_LENGTH);
  if (deaspirate) out = translate(out, ASPIRATION);

  // 8. Delete all whitespace — the single highest-value rule.
  //
  // Sanskrit runs words together (sandhi), and where a transcript puts its
  // spaces is essentially arbitrary. Deleting them makes "namo namah",
  // "namonamah" and "na monamah" the same string, and the matcher stops caring
  // about word boundaries entirely.
  out = out.replace(WHITESPACE, "");

  return out;
}

/**
 * Character error rate between two strings: edits needed / longer length.
 *
 * 0 means identical. Used here to measure *consistency between two transcripts
 * of the same audio*, not accuracy against a ground truth.
 */
export function cer(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a || !b) return 1;

  // Compare by code point so a combining mark counts as one edit, not two.
  const left = [...a];
  const right = [...b];

  // Standard Levenshtein, two rows rolling. The full matrix would be
  // len(a) x len(b), which for a 5-second window against a whole anuvaka is
  // large enough to matter once Chunk 6 runs this every second.
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = new Array<number>(right.length + 1);
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1), // substitution
      );
    }
    previous = current;
  }
  return previous[right.length] / Math.max(left.length, right.length);
}
