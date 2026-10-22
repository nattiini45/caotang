/**
 * Line classification shared by the parser and the serialiser — the element
 * inference order of [screenplay.md §2.3](../../../docs/architecture/screenplay.md),
 * from fountain.io: heading prefix, then transition, then cue, then parenthetical
 * inside a dialogue block, and everything else is action.
 *
 * Each rule is a pure function of one line. The serialiser asks the same question the
 * parser will ask — "would this line be read as X here?" — and forces the line's
 * character only when the answer is no.
 */

/** INT, EXT, EST, I/E and INT./EXT, followed by a full stop or a space. */
export const SCENE_HEADING_RE = /^(?:INT\.?\/EXT|I\/E|INT|EXT|EST)[. ]/i;

/**
 * A title page opens with one of fountain.io's title-page keys, matched case-insensitively.
 * Any other first line is body text, so `SMASH CUT TO:` at the top of a file stays a transition.
 */
export const TITLE_KEY_RE =
  /^(?:title|credit|author|authors|source|draft date|date|contact|copyright|notes|revision|episode|series|season|font)\s*:(?:\s|$)/i;

/** A parenthetical is a whole line in round brackets, read only inside a dialogue block. */
export const PARENTHETICAL_RE = /^\(.*\)$/;

const SCENE_NUMBER_RE = /#\s*([^#]+?)\s*#\s*$/;

export function isSceneHeadingText(text: string): boolean {
  return SCENE_HEADING_RE.test(text);
}

/**
 * A transition has a capital letter and no lower-case letter, and ends `TO:` (`CUT TO:`,
 * `SMASH CUT TO:`). The case test is Unicode, so a Cyrillic or Greek transition reads the same.
 */
export function isTransitionText(text: string): boolean {
  const t = text.trim();
  return /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t) && t.endsWith('TO:');
}

/** A boneyard (slash-star to star-slash) or a note (double brackets), which may run over lines. */
const ANNOTATION = String.raw`\/\*[\s\S]*?\*\/|\[\[[\s\S]*?\]\]`;

/** A run of annotations with the white space around it, which prints as one space. */
const ANNOTATION_RUN = new RegExp(String.raw`\s*(?:${ANNOTATION})(?:\s*(?:${ANNOTATION}))*\s*`, 'g');

/**
 * The text as it prints: boneyards and notes removed, the white space they sat in made one space
 * (screenplay.md §2.1). The element text keeps them, so ranges and the Fountain round trip do not change.
 */
export function printedText(text: string): string {
  return text.replace(ANNOTATION_RUN, ' ').trim();
}

/** Removes trailing parenthesised extensions such as `(V.O.)` or `(CONT'D)`, repeatedly. */
export function stripExtensions(text: string): string {
  const t = text.trim();
  let end = t.length;
  // Scanned from the right, one extension at a time, so a long run of spaces or brackets costs one pass.
  while (end > 0 && t[end - 1] === ')') {
    const open = t.lastIndexOf('(', end - 2);
    if (open < 0 || t.lastIndexOf(')', end - 2) > open) break;
    end = open;
    while (end > 0 && /\s/.test(t[end - 1] as string)) end--;
  }
  return t.slice(0, end);
}

export interface CueLine {
  /** The cue as written, without the dual marker. Extensions are kept: `ANNA (V.O.)`. */
  readonly name: string;
  readonly dual: boolean;
}

/**
 * A character cue: no lower-case letters, at least one capital, once extensions are
 * set aside. The case classes are Unicode (`\p{Lu}`, `\p{Ll}`), so `ИВАН` is a cue as `IVAN` is.
 * A trailing `^` marks the second speaker of a dual-dialogue pair. A script with no letter case
 * (CJK) has no uppercase cue, so its cues are forced with `@` (a known gap).
 */
export function cueOf(text: string): CueLine | null {
  let t = text.trim();
  let dual = false;
  if (t.endsWith('^')) {
    dual = true;
    t = t.slice(0, -1).trimEnd();
  }
  const core = stripExtensions(t);
  if (!/\p{Lu}/u.test(core) || /\p{Ll}/u.test(core)) return null;
  return { name: t, dual };
}

/** The cue's name with extensions and dual marker removed: `DANIEL (V.O.) ^` gives `DANIEL`. */
export function cueBaseName(text: string): string {
  let t = text.trim();
  if (t.endsWith('^')) t = t.slice(0, -1).trimEnd();
  return stripExtensions(t);
}

/** The scene number written at the end of a heading, `INT. HALL #24A#` gives `24A`. */
export function sceneNumberOf(heading: string): string | null {
  const m = SCENE_NUMBER_RE.exec(heading);
  return m ? (m[1] ?? null) : null;
}

/** The heading without its trailing scene number. */
export function stripSceneNumber(heading: string): string {
  return heading.replace(SCENE_NUMBER_RE, '').trim();
}
