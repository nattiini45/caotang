/**
 * Encoding detection for files whose bytes are not UTF-8 text.
 *
 * The loader holds a non-UTF-8 file in place rather than decoding it lossily
 * (read.ts `readUtf8`): the state holds text only, so the file stays on disk
 * untouched and no save writes over it. That keeps the bytes safe and leaves
 * two questions this module answers:
 *
 *   - *what are the bytes?* — {@link guessEncoding}, a deterministic guess over
 *     the file's first bytes, recorded on the load's `encodingIssues` report so
 *     the open can name the file and the likely encoding together;
 *   - *what would they look like as text?* — {@link decodeForPreview}, the
 *     best-effort decode a convert flow previews before it touches anything.
 *
 * For a convert flow that must offer more than one reading, {@link detectEncoding}
 * scores the candidate encodings side by side and {@link decodeAs}/{@link decodeStrict}
 * decode as the writer's pick — the forgiving and the refusing forms.
 *
 * The guesses are deliberately coarse. A byte histogram cannot tell a
 * Windows-1252 letter from a Shift-JIS one, and `unknown` is an honest answer
 * the caller can escalate (to the writer, or to a smarter pass), which a wrong
 * confident answer is not. Detection is pure: no I/O, no mutation, same bytes
 * in → same answer out.
 */

/**
 * The encodings a guess can name. `'unknown'` is a first-class answer — it
 * means the bytes are not UTF-8 and do not match the shapes below (a binary
 * file, or an encoding a byte histogram cannot name).
 */
export type EncodingGuess = 'utf-16le' | 'utf-16be' | 'windows-1252' | 'unknown';

/** A guess, plus the `'utf-8'` an already-valid file resolves to on decode. */
export type DecodedEncoding = 'utf-8' | EncodingGuess;

/** What a reported file is to the project. `'unknown'` covers a file the layout does not name. */
export type EncodingIssueKind = 'document' | 'codex' | 'agent' | 'unknown';

/**
 * One file the load found that is not UTF-8 text — the structured companion to
 * the notice the same file produces. `size` is the file's length in bytes and
 * `encoding` the guess from its first bytes; the bytes themselves are not
 * carried (the file stays where it is).
 */
export interface EncodingIssue {
  /** Project-relative path, e.g. `docs/n_XXXXXXXXXX.md`. */
  readonly path: string;
  readonly kind: EncodingIssueKind;
  /** File size in bytes. */
  readonly size: number;
  readonly encoding: EncodingGuess;
}

/**
 * {@link decodeForPreview}'s and {@link decodeAs}'s result: the encoding the text was decoded as,
 * and the text. The wider union covers the candidate encodings a preview decodes as when the writer
 * picks one; `decodeForPreview` itself still answers only the narrower {@link DecodedEncoding}.
 */
export interface DecodedPreview {
  readonly encoding: DecodableEncoding | 'unknown';
  readonly text: string;
}

/** How many leading bytes a guess looks at. Detection is a first-block read, not a file scan. */
const GUESS_SAMPLE_BYTES = 4096;

/** The five values cp1252 leaves undefined — their presence rules the encoding out. */
const UNDEFINED_CP1252 = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/**
 * A deterministic best guess at what a non-UTF-8 file's bytes are.
 *
 * Order matters: the BOMs are certain, so they are answered before the
 * histograms run. Between them:
 *
 *   - UTF-16 without a BOM shows up as NUL bytes concentrated on one byte
 *     parity: `48 00` per ASCII character little-endian, `00 48` big-endian.
 *     Both parities have to agree for the guess to fire — a file that is NULs
 *     on both is binary, not text.
 *   - Windows-1252 / Latin-1 is the guess when the bytes carry high bytes
 *     (≥ 0x80) and nothing that cannot be text: no NULs, no C0 controls other
 *     than tab/LF/CR, no DEL, and none of the five code points cp1252 leaves
 *     undefined. A byte that fails UTF-8 has at least one high byte by
 *     definition, so this is the common case — a Western-European text file is
 *     what a non-UTF-8 `.md` almost always is.
 *   - Everything else is `'unknown'`: a double-byte encoding whose bytes happen
 *     to include an undefined cp1252 point, or a file that was never text.
 *
 * The guess reads at most the first {@link GUESS_SAMPLE_BYTES} bytes, so a
 * one-megabyte file costs the same as a one-kilobyte one.
 */
export function guessEncoding(bytes: Uint8Array): EncodingGuess {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  }

  const sample = bytes.length > GUESS_SAMPLE_BYTES ? bytes.subarray(0, GUESS_SAMPLE_BYTES) : bytes;

  // Sixteen pairs is the smallest sample the parity test runs on: a handful of
  // bytes is not enough evidence to call a file UTF-16 on NUL placement alone.
  if (sample.length >= 32) {
    const pairs = Math.floor(sample.length / 2);
    let evenNul = 0;
    let oddNul = 0;
    for (let i = 0; i < pairs; i += 1) {
      if (sample[i * 2] === 0x00) evenNul += 1;
      if (sample[i * 2 + 1] === 0x00) oddNul += 1;
    }
    if (oddNul / pairs > 0.4 && evenNul / pairs < 0.05) return 'utf-16le';
    if (evenNul / pairs > 0.4 && oddNul / pairs < 0.05) return 'utf-16be';
  }

  let high = 0;
  let notText = 0;
  for (const byte of sample) {
    if (byte >= 0x80) {
      if (UNDEFINED_CP1252.has(byte)) notText += 1;
      else high += 1;
    } else if (byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      notText += 1;
    }
  }
  if (notText > 0) return 'unknown';
  if (high > 0) return 'windows-1252';
  return 'unknown';
}

/**
 * Decode a file's bytes for preview, naming the encoding the text came out as.
 *
 * Byte-order marks are honoured first, then a strict UTF-8 decode; what is left
 * is decoded by the guess — UTF-16 by its decoder, everything else through
 * `windows-1252`, which maps every byte and so never throws. An `'unknown'`
 * guess therefore still returns text: it is a best-effort preview the caller
 * should distrust, not a conversion.
 *
 * Side-effect free by construction: the bytes are only read.
 */
export function decodeForPreview(bytes: Uint8Array): DecodedPreview {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', text: new TextDecoder('utf-8').decode(bytes) };
  }
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { encoding: 'utf-16le', text: new TextDecoder('utf-16le').decode(bytes) };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { encoding: 'utf-16be', text: new TextDecoder('utf-16be').decode(bytes) };
    }
  }
  try {
    return { encoding: 'utf-8', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    // Not UTF-8 — fall through to the guess.
  }
  const guess = guessEncoding(bytes);
  if (guess === 'utf-16le' || guess === 'utf-16be') {
    return { encoding: guess, text: new TextDecoder(guess).decode(bytes) };
  }
  return { encoding: guess, text: new TextDecoder('windows-1252').decode(bytes) };
}

/**
 * The name a guess is reported under in a load notice, e.g. "its bytes look
 * like Windows-1252". `'unknown'` has no name; callers phrase that case
 * themselves. The candidates are named here too so a preview can label what it
 * decoded as.
 */
export function encodingName(encoding: Exclude<DecodableEncoding, 'utf-8'>): string {
  switch (encoding) {
    case 'utf-16le':
      return 'UTF-16, little-endian';
    case 'utf-16be':
      return 'UTF-16, big-endian';
    case 'windows-1252':
      return 'Windows-1252';
    case 'iso-8859-15':
      return 'ISO-8859-15';
    case 'gb18030':
      return 'GB18030';
    case 'big5':
      return 'Big5';
    case 'shift_jis':
      return 'Shift JIS';
    case 'euc-kr':
      return 'EUC-KR';
  }
}

/**
 * The encodings a held file can be previewed or converted as, beside UTF-16: the single-byte and
 * multi-byte sets whose decode the writer is likeliest to meet in a file another tool saved. The
 * order is the tie-break order, so two readings that score the same prefer the more common one.
 */
export type CandidateEncoding = 'windows-1252' | 'iso-8859-15' | 'gb18030' | 'big5' | 'shift_jis' | 'euc-kr';
export const ENCODING_CANDIDATES: readonly CandidateEncoding[] = [
  'windows-1252',
  'iso-8859-15',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-kr',
];

/** Every encoding a held file can be decoded as for a preview or a conversion. */
export type DecodableEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | CandidateEncoding;

/** One encoding the file could plausibly be in, with how well the decoded text reads (see {@link scoreText}). */
export interface ScoredEncodingCandidate {
  readonly encoding: DecodableEncoding;
  readonly score: number;
}

/**
 * What {@link detectEncoding} found: the best single reading of the bytes, whether it is certain (a
 * BOM names it rather than a statistic), and every candidate scored best-first for a side-by-side
 * preview. `best` is `'unknown'` when no candidate decodes the bytes as credible text — the
 * candidates are still ranked, so the writer can preview each and choose.
 */
export interface EncodingDetection {
  readonly best: DecodableEncoding | 'unknown';
  readonly certain: boolean;
  readonly candidates: readonly ScoredEncodingCandidate[];
}

/** A candidate needs at least this mean weight to be named as the best reading; below it the bytes stay `unknown`. */
const BEST_SCORE_FLOOR = 0.75;

/** The weight one decoded code point adds toward an encoding reading these bytes as text. */
function charWeight(codePoint: number, char: string): number {
  if (codePoint === 0xfffd) return -6;
  if (codePoint < 0x20) return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ? 1 : -6;
  if (codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) return -6;
  if (codePoint >= 0xe000 && codePoint <= 0xf8ff) return -3;
  if (codePoint === 0xfeff) return -3;
  if (codePoint === 0x20) return 1.5;
  if (codePoint >= 0x30 && codePoint <= 0x39) return 1.5;
  if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) return 2;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df)
  ) {
    return 2.5;
  }
  if (codePoint >= 0x3000 && codePoint <= 0x303f) return 1.5;
  if (codePoint >= 0x00c0 && codePoint <= 0x024f) return 1.2;
  if (codePoint >= 0xff00 && codePoint <= 0xff65) return 1.2;
  if (/^\p{L}$/u.test(char)) return 1.5;
  if (/^[\p{P}\p{Z}\p{N}\p{M}]$/u.test(char)) return 1;
  return 0.3;
}

/**
 * How well `text` reads as prose, as the mean weight over its code points. The same weights for
 * every candidate keep the comparison deterministic: a reading whose decode fills with U+FFFD,
 * C0/C1 controls or private-use characters scores low, and one whose characters are letters, spaces
 * and punctuation of any script scores high. Only the first {@link GUESS_SAMPLE_BYTES} characters
 * are weighed, so a large file is scored on the same head the guess was.
 */
function scoreText(text: string): number {
  let weight = 0;
  let count = 0;
  for (const char of text) {
    if (count >= GUESS_SAMPLE_BYTES) break;
    weight += charWeight(char.codePointAt(0)!, char);
    count += 1;
  }
  return count === 0 ? 0 : weight / count;
}

/** Every candidate's score on the same sampled head of the bytes, best first. */
function scoredCandidates(bytes: Uint8Array): ScoredEncodingCandidate[] {
  const head = bytes.subarray(0, GUESS_SAMPLE_BYTES * 4);
  return ENCODING_CANDIDATES.map((encoding) => ({ encoding, score: scoreText(new TextDecoder(encoding).decode(head)) })).sort(
    (a, b) => b.score - a.score,
  );
}

/**
 * The multi-encoding answer {@link guessEncoding}'s single pick cannot give: which of several
 * plausible encodings these bytes decode best as, scored side by side, and whether the best is
 * certain. Same bytes in → same answer out; the scores need no model and no I/O.
 *
 * The marks the bytes carry are read in the same order `guessEncoding` reads them: a UTF-16 BOM is
 * certain and stands alone; a NUL-byte parity names UTF-16 without a BOM as the best of the ranked
 * candidates; otherwise every {@link ENCODING_CANDIDATES} member decodes the sample and is scored on
 * how well the text reads, and the top score is `best` when it clears {@link BEST_SCORE_FLOOR}.
 * Bytes that are already valid UTF-8 answer `'utf-8'` with no candidates — detection is meant for
 * files that failed to read, but it does not pretend a healthy file is something else.
 */
export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  if (bytes.length === 0) return { best: 'utf-8', certain: true, candidates: [] };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { best: 'utf-16le', certain: true, candidates: [{ encoding: 'utf-16le', score: 1 }] };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { best: 'utf-16be', certain: true, candidates: [{ encoding: 'utf-16be', score: 1 }] };
  }

  const sample = bytes.subarray(0, GUESS_SAMPLE_BYTES);
  if (decodesCleanlyAsUtf8(bytes)) return { best: 'utf-8', certain: true, candidates: [] };

  // The same parity test guessEncoding runs: NULs concentrated on one byte parity are UTF-16
  // without a BOM. Sixteen pairs is the smallest sample that test runs on.
  if (sample.length >= 32) {
    const pairs = Math.floor(sample.length / 2);
    let evenNul = 0;
    let oddNul = 0;
    for (let i = 0; i < pairs; i += 1) {
      if (sample[i * 2] === 0x00) evenNul += 1;
      if (sample[i * 2 + 1] === 0x00) oddNul += 1;
    }
    const scored = scoredCandidates(bytes);
    if (oddNul / pairs > 0.4 && evenNul / pairs < 0.05) {
      return { best: 'utf-16le', certain: false, candidates: [{ encoding: 'utf-16le', score: 0.95 }, ...scored] };
    }
    if (evenNul / pairs > 0.4 && oddNul / pairs < 0.05) {
      return { best: 'utf-16be', certain: false, candidates: [{ encoding: 'utf-16be', score: 0.95 }, ...scored] };
    }
  }

  const scored = scoredCandidates(bytes);
  const best = scored[0];
  return {
    best: best !== undefined && best.score >= BEST_SCORE_FLOOR ? best.encoding : 'unknown',
    certain: false,
    candidates: scored,
  };
}

/**
 * Decodes the bytes as the named encoding — the writer's chosen reading, not the marks'. The decode
 * is forgiving: malformed sequences stand out as U+FFFD rather than throwing, so a wrong pick
 * previews as the mojibake it would save. UTF-16 decoders still consume a matching BOM.
 */
export function decodeAs(bytes: Uint8Array, encoding: DecodableEncoding): DecodedPreview {
  return { encoding, text: new TextDecoder(encoding).decode(bytes) };
}

/**
 * The strict form of {@link decodeAs}, for a conversion: malformed sequences throw rather than
 * become U+FFFD. A conversion writes the text this returns, so a file whose bytes do not fit the
 * chosen encoding is refused before anything is written.
 */
export function decodeStrict(bytes: Uint8Array, encoding: DecodableEncoding): string {
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

/** Whether the bytes are already valid UTF-8 — the check {@link decodeForPreview} runs before guessing. */
function decodesCleanlyAsUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
