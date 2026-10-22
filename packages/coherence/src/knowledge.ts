/**
 * Who knows what, when — [coherence.md §4.4](../../../docs/architecture/coherence.md).
 *
 * The writer declares, on a scene, which characters learn a fact and which act on it. This module holds what is derived
 * from those declarations: the order of two scenes in the story, the exemption table that says which modes teach and which
 * are checked, and the ledger of who learns each fact where. `checks/knowledge.ts` reads all three, and the Knowledge list
 * reads the ledger, so the check and the view cannot disagree.
 *
 * Pure: nothing here reads a clock or writes a file.
 */

import type { SceneMeta, TimelineMode } from './model.js';
import { effectiveMode } from './scene-meta.js';

/**
 * How a mode takes part in the ledger. `teaches` is whether a `learns` declared in the scene counts; `checked` is whether
 * a `knows` declared in it is judged. `sequence` is how the scene's place against another is known: `binder` for a scene
 * whose binder position is its place in the story, `strand` for one that is ordered by binder position only among scenes of
 * its own mode, `days` for one that is ordered by its declared days alone.
 */
export interface KnowledgeTreatment {
  readonly teaches: boolean;
  readonly checked: boolean;
  readonly sequence: 'binder' | 'strand' | 'days';
}

/** §4.4's exemption table. Its own type: `timeline.ts`'s table is keyed to the timeline checks. */
const TREATMENTS: Readonly<Record<TimelineMode, KnowledgeTreatment>> = {
  linear: { teaches: true, checked: true, sequence: 'binder' },
  simultaneous: { teaches: true, checked: true, sequence: 'binder' },
  'time-skip': { teaches: true, checked: true, sequence: 'binder' },
  flashback: { teaches: true, checked: true, sequence: 'days' },
  'flash-forward': { teaches: true, checked: true, sequence: 'days' },
  backstory: { teaches: true, checked: true, sequence: 'days' },
  circular: { teaches: true, checked: true, sequence: 'days' },
  parallel: { teaches: true, checked: true, sequence: 'strand' },
  frame: { teaches: true, checked: true, sequence: 'strand' },
  // A dream or a myth teaches the reader, not the character, and nothing said in one is a claim about what they know.
  dream: { teaches: false, checked: false, sequence: 'days' },
  mythic: { teaches: false, checked: false, sequence: 'days' },
};

export function knowledgeTreatmentOf(mode: TimelineMode): KnowledgeTreatment {
  return TREATMENTS[mode];
}

/** The part of a scene the ledger reads. A scanned scene is one. */
export interface LedgerScene {
  readonly docId: string;
  readonly title: string;
  /** Position in the depth-first binder walk. */
  readonly binderIndex: number;
  readonly meta: SceneMeta;
}

/** Where scene `a` stands against scene `b` in story order. `unknown` is an order nobody declared. */
export type StoryOrder = 'before' | 'same' | 'after' | 'unknown';

/**
 * §4.4's story order: days when both scenes declare them, binder position where it is reliable, and unknown otherwise.
 * The same days tie-break by binder position, as the timeline checks do.
 */
export function storyOrder(a: LedgerScene, b: LedgerScene): StoryOrder {
  if (a.docId === b.docId) return 'same';
  const dayA = a.meta.dayOffset;
  const dayB = b.meta.dayOffset;
  if (dayA !== undefined && dayB !== undefined && dayA !== dayB) return dayA < dayB ? 'before' : 'after';
  const byBinder = (): StoryOrder => (a.binderIndex < b.binderIndex ? 'before' : 'after');
  if (dayA !== undefined && dayB !== undefined) return byBinder();
  const modeA = effectiveMode(a.meta);
  const modeB = effectiveMode(b.meta);
  const inSequence = (mode: TimelineMode): boolean => TREATMENTS[mode].sequence === 'binder';
  if (inSequence(modeA) && inSequence(modeB)) return byBinder();
  if (modeA === modeB && TREATMENTS[modeA].sequence === 'strand') return byBinder();
  return 'unknown';
}

/** One scene that teaches one character one fact. */
export interface Lesson<S extends LedgerScene = LedgerScene> {
  readonly entryId: string;
  readonly scene: S;
}

/**
 * The ledger of one fact: every scene that teaches it to a character, in binder order. A scene in a mode that does not
 * teach is not in it. The ledger lists where each character learns, not when in the story: that is `storyOrder`'s question,
 * asked against the scene that uses the fact.
 */
export function lessonsOf<S extends LedgerScene>(factId: string, scenes: readonly S[]): Lesson<S>[] {
  const lessons: Lesson<S>[] = [];
  for (const scene of [...scenes].sort((a, b) => a.binderIndex - b.binderIndex)) {
    if (!TREATMENTS[effectiveMode(scene.meta)].teaches) continue;
    for (const link of scene.meta.learns ?? []) {
      if (link.factId === factId) lessons.push({ entryId: link.entryId, scene });
    }
  }
  return lessons;
}

/** What the ledger says about a character using a fact in a scene. */
export type LeakVerdict<S extends LedgerScene = LedgerScene> =
  /** A scene at or before it teaches the character, or the scene is exempt. */
  | { readonly kind: 'fine' }
  /** The order against every scene that teaches the character is unknown, so nothing can be said. */
  | { readonly kind: 'unordered' }
  /** The character is taught only in the scene named, which is later. */
  | { readonly kind: 'learns-later'; readonly scene: S }
  /** No scene teaches the character. */
  | { readonly kind: 'never-learns' };

/**
 * §4.4's ledger rule for one `knows` pair in `scene`: fine when a counting scene at or before it teaches the pair, exempt
 * when the order against one is unknown, a later teacher when only later scenes teach it, and never learned otherwise.
 */
export function leakVerdict<S extends LedgerScene>(entryId: string, factId: string, scene: S, scenes: readonly S[]): LeakVerdict<S> {
  if (!TREATMENTS[effectiveMode(scene.meta)].checked) return { kind: 'fine' };
  const teachers = lessonsOf(factId, scenes)
    .filter((lesson) => lesson.entryId === entryId)
    .map((lesson) => lesson.scene);
  let unordered = false;
  let later: S | undefined;
  for (const teacher of teachers) {
    const order = storyOrder(teacher, scene);
    if (order === 'before' || order === 'same') return { kind: 'fine' };
    if (order === 'unknown') unordered = true;
    else if (later === undefined) later = teacher;
    else {
      // The earliest of the later teachers; two that cannot be ordered are named by binder position.
      const between = storyOrder(teacher, later);
      if (between === 'before' || (between === 'unknown' && teacher.binderIndex < later.binderIndex)) later = teacher;
    }
  }
  if (unordered) return { kind: 'unordered' };
  if (later !== undefined) return { kind: 'learns-later', scene: later };
  return { kind: 'never-learns' };
}
