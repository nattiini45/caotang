/**
 * The AV script's derived model — [av-script.md §2](../../../docs/architecture/av-script.md).
 *
 * Everything here is what the parser derives from an episode's Markdown body. None of it is stored: the body
 * (`docs/<id>.md`) is the one copy of the text, and the only thing Caotang writes into it on its own is the minted
 * `<!-- lineId: … -->` tag (line-ids.ts).
 */

/** A line's kind (§3): a speaker's turn, the narrator's, or plain text that is neither. */
export type ScriptLineKind = 'speech' | 'narration' | 'text';

export interface ScriptLine {
  /**
   * The line's id: its minted `sl_` tag, or a session-local id (`~l` + the line number) until the next save mints one
   * (§2). Only a minted id is stable; `minted` says which this is.
   */
  readonly id: string;
  readonly minted: boolean;
  readonly kind: ScriptLineKind;
  /** The label as typed (`HOST_A`, `NARRATION`). Absent on a text line. */
  readonly label?: string;
  /**
   * Who speaks (§2): on a speech line, the codex entry id when the label resolves to one character, else the typed name.
   * On a narration line, the show's `defaultSpeaker` when it has one. Absent on a text line.
   */
  readonly speaker?: string;
  /** The words, without the label, parentheticals, timing brackets or id tag. A text line keeps its whole text. */
  readonly text: string;
  /** The parentheticals the line carries, without their parentheses, in order (`over the theme`, `OFF`). */
  readonly modifiers: readonly string[];
  /** The counted words of `text`, by the word-count rule (`countBody`). */
  readonly words: number;
  /** Seconds: declared by a duration bracket, else estimated from the speech rate. Absent = untimed (§4). */
  readonly durationSec?: number;
  /** True when `durationSec` came from a bracket; false for an estimate or an untimed line. */
  readonly declared: boolean;
  /** The 1-based line of the body it was read from. */
  readonly line: number;
}

export interface ScriptCue {
  /** The cue's id: its minted `sc_` tag, or a session-local id (`~c` + the line number) until the next save mints one. */
  readonly id: string;
  readonly minted: boolean;
  /** The cue's kind: the vocabulary label it matched, as the vocabulary spells it. An open string (SD7). */
  readonly kind: string;
  /** The label as typed (`MUSIC`, `music`, `Sfx`). */
  readonly label: string;
  readonly text: string;
  readonly modifiers: readonly string[];
  /** Seconds from the segment's start: declared by `[at …]`, else the sum of the timed lines before it (§3). */
  readonly atSec: number;
  /** True when `atSec` came from an `[at …]` bracket. */
  readonly atDeclared: boolean;
  /** The cue's duration in seconds, from its duration bracket. Absent = a point cue. */
  readonly forSec?: number;
  /** A bed: the cue runs under the speech (a `(under)` modifier, or text that ends in the word "under"). */
  readonly under: boolean;
  readonly line: number;
}

export interface ScriptSegment {
  /** `segment-N`, by position: `segment-1` is the first `##` heading, `segment-0` the text before it when there is any. */
  readonly id: string;
  /** The heading text. Free; nothing is privileged (E1, E8). Empty for the text before the first heading. */
  readonly title: string;
  readonly lines: readonly ScriptLine[];
  readonly cues: readonly ScriptCue[];
  /** The episode time the segment starts at, the sum of the timed segments before it. Absent on an untimed segment. */
  readonly startSec?: number;
  /** The later of the speech end and the last cue end (§4). Absent on an untimed segment. */
  readonly durationSec?: number;
  /** The 1-based line of its heading (or of its first line, for `segment-0`). */
  readonly line: number;
}

/** The `AnimaticTotals` shape (storyboard's `animaticTotals`): seconds to two places, the timed count, the untimed ids. */
export interface ScriptTotals {
  /** The sum of the timed segments' durations, in seconds, to two places. */
  readonly seconds: number;
  /** How many segments are timed. */
  readonly timedCount: number;
  /** Ids of the segments left out of the sum, in body order. */
  readonly untimed: readonly string[];
}

export interface ScriptEpisode {
  readonly segments: readonly ScriptSegment[];
  readonly totals: ScriptTotals;
}

/** What a notice is about. */
export type ScriptNoticeKind =
  /** A bracket that looks like a timing and does not parse; it stays in the text. */
  | 'bracket-unparsed'
  /**
   * A timing bracket in a place that takes none (an offset on a speech line, a second duration or offset), or a bracket
   * of words (closed, unclosed, or a stray `]`) that kept a well-formed timing before it from being applied.
   */
  | 'bracket-misplaced'
  /** A well-formed timing bracket that was not applied, because reading stopped at a bracket after it. */
  | 'bracket-not-applied'
  /** An unclosed timing bracket at the end of a line. */
  | 'bracket-unclosed'
  /** A `lineId` tag whose id is not a minted id of the right kind; left as written. */
  | 'id-malformed'
  /** A minted id a line before this one already carries; this line gets a session-local id. */
  | 'id-duplicate'
  /** A speech label that resolves to no codex character; kept under the typed name. */
  | 'speaker-unknown'
  /** A speech label that resolves to more than one codex character; kept under the typed name. */
  | 'speaker-ambiguous';

/** One thing the parse kept tolerantly and reports, with the line it is on (§3: nothing is dropped quietly). */
export interface ScriptNotice {
  readonly kind: ScriptNoticeKind;
  readonly line: number;
  readonly message: string;
}

/** What `parseEpisode` returns: the episode, its `#` title when it has one, and the notices. */
export interface ParsedEpisode extends ScriptEpisode {
  readonly title?: string;
  readonly notices: readonly ScriptNotice[];
}
