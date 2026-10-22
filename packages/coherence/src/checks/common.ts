/**
 * Shared shapes for the deterministic checks — [coherence.md §5.1](../../../../docs/architecture/coherence.md).
 *
 * A check is a pure function from a {@link CheckInput} to draft findings. It
 * never writes, never mutates the manuscript, and never reads the clock. The
 * lifecycle (upsert, dedupe, dismissal) is the caller's business, which keeps a
 * check testable with a fixture and nothing else.
 */

import type { CodexEntry } from '@caotang/store';

import type { CueFacts } from '../cues.js';
import { effectiveMode } from '../scene-meta.js';
import type { DeterministicCheckId, Evidence, FindingSeverity, TimelineMode } from '../model.js';
import type { ManuscriptFolder, ScannedScene, ShotFact } from '../scope.js';

/** One finding as a check produced it, before the lifecycle has placed it. */
export interface DraftFinding {
  readonly checkId: DeterministicCheckId;
  readonly type: string;
  readonly severity: FindingSeverity;
  /** §4.2's grouping key, already lowercased. */
  readonly factGroup: string;
  /** Scene passages, in the order the message reads. Codex-level checks quote none. */
  readonly evidence: readonly Evidence[];
  readonly message: string;
  /** §5.1: the declaration side, rendered as the "expected" line. */
  readonly expected?: string;
}

/**
 * The dialogue module's findings for the containers a run reads (dialogue-narrative.md §5). The coherence module
 * cannot compute them itself: the dialogue package depends on this one, so the app runs the dialogue validation and
 * passes the result in. Each finding is already in the shape of a {@link DraftFinding}.
 */
export interface DialogueFacts {
  /** Findings from `validateContainer` for each container read. Only the three branch check ids are taken. */
  readonly findings: readonly DraftFinding[];
  /** The dialogue containers the findings were computed for. A finding is in scope when its container is. */
  readonly containerIds: readonly string[];
}

export interface CheckInput {
  /** Scanned scenes in binder order. */
  readonly scenes: readonly ScannedScene[];
  /** Manuscript folders. Only folders with a declared span take part in `timeline.window`. */
  readonly folders: readonly ManuscriptFolder[];
  readonly entries: readonly CodexEntry[];
  /** Mention hits for scanned scenes with a usable count. A scene absent here is unavailable. */
  readonly hits: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** Every storyboard shot in the project (storyboard.md §5). Absent is the same as none. */
  readonly shots?: readonly ShotFact[];
  /** The dialogue module's validation, when the app supplied it. Absent means the branch checks are not evaluated. */
  readonly dialogue?: DialogueFacts;
  /**
   * The screenplay read of each scene body, keyed by `scene.docId`, when the run computed it: the three script checks
   * share one parse per scene. The map is trusted as it stands — a check quotes these facts as finding evidence
   * without re-reading the body, so the caller must build it from the very bodies this input carries; facts parsed
   * from older bodies would be quoted as stale evidence with nothing to detect it. A scene missing from a partial map
   * is not an error: that scene's checks fall back to a fresh parse of its own body, which costs a parse, nothing else.
   */
  readonly cueFacts?: ReadonlyMap<string, CueFacts>;
  /**
   * Every document in the binder, scanned or not, by id and title (§5.5). `plot.unresolved-thread` needs it to tell a payoff
   * that names nothing from one that is in the project and was not read. Absent means that check cannot run and says so.
   */
  readonly treeDocuments?: ReadonlyMap<string, string>;
}

export interface CheckOutput {
  readonly drafts: DraftFinding[];
  /** Plain lines for the run report: what was skipped and why. */
  readonly notes: string[];
}

/**
 * §4.2: `factGroup = lower(entity + '|' + attribute)`. The formula is applied to
 * the whole key, so an entry id comes out lowercase. The spec's own example
 * shows the id in capitals, which the formula does not produce; the formula wins.
 */
export function groupKey(entity: string, attribute: string): string {
  return `${entity}|${attribute}`.toLowerCase();
}

/** The two ids of a pair, sorted, joined. The same pair names the same key in either order. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('+');
}

/** A codex entry's terms: its name and its aliases, trimmed and de-duplicated, name first (codex.md §2). */
export function termsOf(entry: CodexEntry): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [entry.name, ...entry.aliases]) {
    const term = raw.trim();
    if (term === '' || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

export function modeOf(scene: ScannedScene): TimelineMode {
  return effectiveMode(scene.meta);
}

/** An entry by id, or by a name that is unique among the codex's names and aliases. */
export function resolveEntry(entries: readonly CodexEntry[], value: string): CodexEntry | undefined {
  const byId = entries.find((entry) => entry.id === value);
  if (byId !== undefined) return byId;
  const wanted = value.trim().toLowerCase();
  const matches = entries.filter((entry) => termsOf(entry).some((term) => term.toLowerCase() === wanted));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The first name of an entry, or its id when the name is blank. Used in messages, which must name something. */
export function labelOf(entry: CodexEntry): string {
  return entry.name.trim() === '' ? entry.id : entry.name;
}
