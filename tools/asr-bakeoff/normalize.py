"""Devanagari normalisation — the rules that let a wrong transcript still match.

This is the load-bearing idea of the whole project. The speech model will not
produce correct Sanskrit. It will produce something Hindi-shaped and mangled.
These rules collapse the distinctions the model is unreliable about, so that
"consistently wrong" becomes "identical after normalisation".

Every rule below destroys information on purpose. The test of a rule is not
"is this linguistically sound?" but "does the model confuse these two things?"
If it does, collapse them.

Ported to Python first so the rules can be measured against real model output
before Chunk 5 commits them to TypeScript.
"""

import re
import unicodedata

# --- 1. Vedic accent marks (svara) -------------------------------------------
# Anudatta, udatta, and the vedic tone marks. These are pitch notation. No ASR
# model outputs them, but the *reference* text is full of them, so they must go
# from both sides or nothing will ever match.
SVARA = re.compile(
    "["
    "॑-॔"  # devanagari stress/tone signs (udatta, anudatta, grave, acute)
    "ऀ-ं"  # inverted candrabindu, candrabindu, anusvara handled below
    "꣠-꣱"  # devanagari extended: vedic tone marks
    "᳐-᳿"  # vedic extensions block
    "]"
)

# --- 2. Punctuation, digits, whitespace markers -------------------------------
# Danda and double danda are verse separators. Model output has none of this;
# reference text is full of it.
PUNCT = re.compile(
    "["
    "।॥"  # danda, double danda
    "०-९"  # devanagari digits
    "0-9"
    r"""।॥.,;:!?'"“”‘’()\[\]{}<>/\\|@#$%^&*_+=~`\-–—"""
    "]"
)

# --- 3. Sibilants -------------------------------------------------------------
# श (palatal), ष (retroflex), स (dental). Three distinct sounds in Sanskrit.
# ASR models trained mostly on Hindi flip between them constantly.
SIBILANTS = str.maketrans({"श": "स", "ष": "स"})  # श,ष -> स

# --- 4. Nasals ----------------------------------------------------------------
# Sanskrit has five nasal stops plus anusvara plus candrabindu. Which one is
# "correct" depends on what follows, and models get this wrong constantly.
# Collapse the lot to न.
NASALS = str.maketrans(
    {
        "ङ": "न",  # ङ -> न
        "ञ": "न",  # ञ -> न
        "ण": "न",  # ण -> न
        "म": "न",  # म -> न
        "ं": "न",  # ं anusvara -> न
        "ँ": "न",  # ँ candrabindu -> न
    }
)

# --- 5. Visarga ---------------------------------------------------------------
# ः is a breathy release at the end of a word. Sometimes transcribed as ह,
# usually just dropped. Delete it everywhere.
VISARGA = "ः"

# --- 6. Vowel length ----------------------------------------------------------
# Sanskrit distinguishes short and long vowels and it is meaningful. ASR does
# not reliably hear the difference, especially in chanting where vowels are
# stretched for melodic reasons rather than lexical ones.
VOWEL_LENGTH = str.maketrans(
    {
        # independent vowels
        "आ": "अ",  # आ -> अ
        "ई": "इ",  # ई -> इ
        "ऊ": "उ",  # ऊ -> उ
        "ॠ": "ऋ",  # ॠ -> ऋ
        # dependent vowel signs (matras)
        "ा": "",  # ा -> (inherent a)
        "ी": "ि",  # ी -> ि
        "ू": "ु",  # ू -> ु
        "ॄ": "ृ",  # ॄ -> ृ
        # e/o have no short/long contrast in Devanagari, left alone
    }
)

# --- 7. Aspiration (optional) -------------------------------------------------
# ख=क+h, घ=ग+h etc. Aspiration is phonemic in Sanskrit but is exactly the kind
# of fine detail a small model drops. Toggleable because it destroys a lot of
# information — worth measuring whether it helps or hurts.
ASPIRATION = str.maketrans(
    {
        "ख": "क",  # ख -> क
        "घ": "ग",  # घ -> ग
        "छ": "च",  # छ -> च
        "झ": "ज",  # झ -> ज
        "ठ": "ट",  # ठ -> ट
        "ढ": "ड",  # ढ -> ड
        "थ": "त",  # थ -> त
        "ध": "द",  # ध -> द
        "फ": "प",  # फ -> प
        "भ": "ब",  # भ -> ब
    }
)

# Nukta-bearing forms that Hindi-trained models emit for Sanskrit sounds.
NUKTA = str.maketrans(
    {
        "ऩ": "न",  # ऩ -> न
        "ऱ": "र",  # ऱ -> र
        "ऴ": "ल",  # ऴ -> ल
        "क़": "क",  # क़ -> क
        "ख़": "ख",  # ख़ -> ख
        "ग़": "ग",  # ग़ -> ग
        "ज़": "ज",  # ज़ -> ज
        "ड़": "ड",  # ड़ -> ड
        "ढ़": "ढ",  # ढ़ -> ढ
        "फ़": "फ",  # फ़ -> फ
        "य़": "य",  # य़ -> य
        "़": "",  # combining nukta
    }
)


def normalize(text: str, *, deaspirate: bool = True) -> str:
    """Collapse a Devanagari string to its matchable skeleton.

    The output is not readable Sanskrit and is not meant to be. It exists only
    to be compared against other output of the same function.
    """
    if not text:
        return ""

    # NFC first so that combining marks are in a predictable form before we
    # start deleting them. Without this, the same visible character can be one
    # code point or two and the rules would fire inconsistently.
    text = unicodedata.normalize("NFC", text)

    # Case-fold. Devanagari has no case, so this looks pointless — but Whisper
    # does not reliably emit Devanagari. Told language="sa" it returns romanised
    # text, and the *same* line came back both "namasti rudra" and
    # "NAMASTE RUDR" across takes. Without this the matcher would score two
    # identical transcripts as completely different. Measured, not theorised.
    text = text.casefold()

    text = SVARA.sub("", text)
    text = text.translate(NUKTA)
    text = PUNCT.sub("", text)
    text = text.translate(SIBILANTS)
    text = text.translate(NASALS)
    text = text.replace(VISARGA, "")
    text = text.translate(VOWEL_LENGTH)
    if deaspirate:
        text = text.translate(ASPIRATION)

    # --- 8. Delete all whitespace ---------------------------------------------
    # The single highest-value rule. Sanskrit runs words together (sandhi), and
    # where a transcript puts its spaces is essentially arbitrary. Deleting them
    # means "namo namah" and "namonamah" and "na monamah" are all the same
    # string, and the matcher stops caring about word boundaries entirely.
    text = re.sub(r"\s+", "", text)

    return text


def cer(a: str, b: str) -> float:
    """Character error rate between two strings: edits needed / length.

    0.0 means identical. Used here to measure *consistency between two
    transcripts of the same audio*, not accuracy against a ground truth.
    """
    if not a and not b:
        return 0.0
    if not a or not b:
        return 1.0

    # Standard Levenshtein, two-row rolling.
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cur[j] = min(
                prev[j] + 1,  # deletion
                cur[j - 1] + 1,  # insertion
                prev[j - 1] + (ca != cb),  # substitution
            )
        prev = cur
    return prev[-1] / max(len(a), len(b))
