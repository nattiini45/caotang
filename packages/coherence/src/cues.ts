/**
 * Screenplay cues as the coherence module reads them — [screenplay.md §4](../../../docs/architecture/screenplay.md).
 *
 * A cue is a mention. The parse names the characters a scene's body cues, and the codex's mention index counts a
 * character's name in the text, cue spellings included: `@caotang/codex` resolves each cue to its entry and the detector counts
 * it (cueTermsOf), so a cue whose spelling differs from the entry's name (`MR. SMITH` against `Mr Smith`) is counted once,
 * by the detector, and never merged in afterwards. This module keeps the parse-level reads the checks need: the cue facts,
 * the entry a cue names, and the document kind. Nothing here calls a model or writes anything.
 */

import { characterCueNames, cueKey, normaliseSource, parseFountain, isScreenplayKind, type LocatedElement } from '@caotang/screenplay';
import type { CodexEntry } from '@caotang/store';

import { resolveEntry, termsOf } from './checks/common.js';
import type { ScannedScene } from './scope.js';

/** What the screenplay parse reads from one document body, in the normalised source's offsets. */
export interface CueFacts {
  /** The parsed elements, located in the normalised text. */
  readonly elements: readonly LocatedElement[];
  /** The normalised text the offsets index. Equal to the body unless it has CRLF line endings. */
  readonly text: string;
  /** Character names, deduplicated, in first-seen order (screenplay.md §4 cue names). */
  readonly names: readonly string[];
}

/** The screenplay read of one body. A body that is not a screenplay is never passed here. */
export function cueFactsOf(body: string): CueFacts {
  const text = normaliseSource(body);
  const parsed = parseFountain(text);
  return {
    elements: parsed.elements,
    text,
    names: characterCueNames(parsed.elements),
  };
}

/**
 * The screenplay read of every scene in a run, by document id. The three script checks read the same bodies, so a run
 * parses each screenplay body once and shares the read.
 */
export function cueFactsOfScenes(scenes: readonly ScannedScene[]): Map<string, CueFacts> {
  const facts = new Map<string, CueFacts>();
  for (const scene of scenes) {
    if (!isScreenplayDocument(scene.kind)) continue;
    facts.set(scene.docId, cueFactsOf(scene.body));
  }
  return facts;
}

/**
 * The codex entry a cue names. An exact term match wins (resolveEntry, the rule every check uses). Failing that, a
 * cue matches an entry when the two agree once punctuation and case are dropped, and only when that is one entry, so
 * an ambiguous cue is left unmatched rather than guessed at.
 */
export function entryForCue(entries: readonly CodexEntry[], name: string): CodexEntry | undefined {
  const exact = resolveEntry(entries, name);
  if (exact !== undefined) return exact;
  const key = cueKey(name);
  if (key === '') return undefined;
  const matches = entries.filter((entry) => termsOf(entry).some((term) => cueKey(term) === key));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Whether a document declares the screenplay kind, which is the only kind whose cues are read (screenplay.md §2.1). */
export function isScreenplayDocument(kind: string | undefined): boolean {
  return isScreenplayKind(kind);
}
