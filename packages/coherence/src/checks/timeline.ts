/**
 * Timeline checks — [coherence.md §5.1 and §5.2.1](../../../../docs/architecture/coherence.md):
 * `timeline.order-drift`, `timeline.relation`, `timeline.window`, `timeline.overlap`, `timeline.gap`.
 *
 * Every rule here fires only on something the writer declared. A scene with no
 * day offset is counted and reported as unscheduled, and it is never a violation
 * (the Aeon lesson in §5.1). The mode exemption table is applied through
 * {@link treatmentOf}, so this file holds no mode lists of its own.
 */

import { GAP_THRESHOLD_DAYS, treatmentOf, windowInside, windowOf, windowsOverlap, type DayWindow } from '../timeline.js';
import { headEvidence, type ScannedScene } from '../scope.js';
import { groupKey, modeOf, pairKey, type CheckInput, type CheckOutput, type DraftFinding } from './common.js';

function dayOf(scene: ScannedScene): number | undefined {
  return scene.meta.dayOffset;
}

function scheduledScenes(input: CheckInput): ScannedScene[] {
  return input.scenes.filter((scene) => dayOf(scene) !== undefined);
}

/**
 * Adjacent pairs in day order whose binder order disagrees (§5.1). Ties on the
 * day tie-sort in binder order and never drift, which keeps a same-day pair from
 * raising a finding the writer cannot act on.
 */
function compareDayOrder(list: readonly ScannedScene[], type: string, strand: string | undefined): DraftFinding[] {
  const sorted = [...list].sort((a, b) => (dayOf(a) ?? 0) - (dayOf(b) ?? 0) || a.binderIndex - b.binderIndex);
  const drafts: DraftFinding[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const early = sorted[i];
    const late = sorted[i + 1];
    if (early === undefined || late === undefined) continue;
    if (dayOf(early) === dayOf(late)) continue;
    if (early.binderIndex < late.binderIndex) continue;
    // `late` happens later in the story but sits earlier in the binder. Cite in binder order.
    const where = strand === undefined ? 'in the binder' : `in the binder, within the ${strand} strand`;
    drafts.push({
      checkId: 'timeline.order-drift',
      type,
      severity: 'info',
      factGroup: groupKey(pairKey(early.docId, late.docId), 'order-drift'),
      evidence: [headEvidence(late), headEvidence(early)],
      message: `"${late.title}" comes before "${early.title}" ${where}, but happens after it (day ${dayOf(late)} against day ${dayOf(early)})`,
      expected: `"${early.title}" before "${late.title}", as the days say`,
    });
  }
  return drafts;
}

/** §5.1 `timeline.order-drift`, with the §5.2.1 exemption table applied per scene. */
export function checkOrderDrift(input: CheckInput): CheckOutput {
  const scheduled = scheduledScenes(input);
  const notes: string[] = [];
  const unscheduled = input.scenes.length - scheduled.length;
  if (unscheduled > 0) notes.push(`${unscheduled} scene(s) unscheduled (no day offset); they are not compared`);

  const population = scheduled.filter((scene) => treatmentOf(modeOf(scene), 'timeline.order-drift') === 'checked');
  const drafts = compareDayOrder(population, 'order-drift', undefined);
  // `per-strand` modes compare only among scenes that share the mode (§5.2.1 parallel/frame).
  for (const mode of ['parallel', 'frame'] as const) {
    const strand = scheduled.filter((scene) => modeOf(scene) === mode);
    drafts.push(...compareDayOrder(strand, 'strand-order-drift', mode));
  }
  return { drafts, notes };
}

/**
 * Adjacent pairs in day order that are {@link GAP_THRESHOLD_DAYS} or more apart, start to start. The pair is skipped when
 * either side is exempt from the gap, which is how `time-skip`, `dream` and `mythic` legitimize one (§5.2.1).
 */
function gapsIn(list: readonly ScannedScene[], strand: string | undefined): DraftFinding[] {
  const sorted = [...list].sort((a, b) => (dayOf(a) ?? 0) - (dayOf(b) ?? 0) || a.binderIndex - b.binderIndex);
  const drafts: DraftFinding[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const early = sorted[i];
    const late = sorted[i + 1];
    if (early === undefined || late === undefined) continue;
    const days = (dayOf(late) ?? 0) - (dayOf(early) ?? 0);
    if (days < GAP_THRESHOLD_DAYS) continue;
    // A pair whose binder order disagrees with the days is `timeline.order-drift`'s already, and one finding is enough for one mistake.
    const reversed = early.binderIndex > late.binderIndex;
    if (reversed && (strand !== undefined || [early, late].every((scene) => treatmentOf(modeOf(scene), 'timeline.order-drift') === 'checked'))) continue;
    if ([early, late].some((scene) => treatmentOf(modeOf(scene), 'timeline.gap') === 'exempt')) continue;
    drafts.push({
      checkId: 'timeline.gap',
      type: 'time-gap',
      severity: 'info',
      factGroup: groupKey(pairKey(early.docId, late.docId), 'gap'),
      evidence: [headEvidence(early), headEvidence(late)],
      message: `"${late.title}" happens ${days} days after "${early.title}"${strand === undefined ? '' : `, within the ${strand} strand`}`,
      expected: 'declare a time skip on one of the scenes if the jump is intended, or accept the gap',
    });
  }
  return drafts;
}

/**
 * §5.1 `timeline.gap`: consecutive scheduled scenes in day order that are a week or more apart. Information only, a prompt to
 * declare a `time-skip` rather than a rule. Order is not this check's concern: a pair whose binder order disagrees with the
 * days is `timeline.order-drift`'s and is not reported here a second time. `parallel` and
 * `frame` scenes are compared within their own strand, as for order drift.
 */
export function checkGap(input: CheckInput): CheckOutput {
  const scheduled = scheduledScenes(input);
  const notes: string[] = [];
  const unscheduled = input.scenes.length - scheduled.length;
  if (unscheduled > 0) notes.push(`${unscheduled} scene(s) unscheduled (no day offset); they are not compared`);

  const main = scheduled.filter((scene) => modeOf(scene) !== 'parallel' && modeOf(scene) !== 'frame');
  const drafts = gapsIn(main, undefined);
  for (const mode of ['parallel', 'frame'] as const) {
    drafts.push(...gapsIn(scheduled.filter((scene) => modeOf(scene) === mode), mode));
  }
  return { drafts, notes };
}

/**
 * §5.1 `timeline.relation`: for each declared `after: [B]`, A's day must be at
 * least B's day plus B's duration. This is the Finish-to-Start shape with no
 * exact timing (§5.2). It is checked in every mode, because a flashback still
 * happens after what it refers to.
 */
export function checkRelation(input: CheckInput): CheckOutput {
  const byDoc = new Map(input.scenes.map((scene) => [scene.docId, scene] as const));
  const notes: string[] = [];
  const drafts: DraftFinding[] = [];
  for (const scene of input.scenes) {
    const after = scene.meta.after ?? [];
    if (after.length === 0) continue;
    const day = dayOf(scene);
    for (const depId of after) {
      const dependency = byDoc.get(depId);
      if (dependency === undefined) {
        notes.push(`"${scene.title}" follows "${depId}", which is not a scanned scene; not checked`);
        continue;
      }
      const depDay = dayOf(dependency);
      if (day === undefined || depDay === undefined) {
        notes.push(`"${scene.title}" follows "${dependency.title}", but one of them has no day offset; not checked`);
        continue;
      }
      const required = depDay + (dependency.meta.durationDays ?? 0);
      if (day >= required) continue;
      drafts.push({
        checkId: 'timeline.relation',
        type: 'after-violated',
        severity: 'error',
        factGroup: groupKey(scene.docId, `after:${dependency.docId}`),
        evidence: [headEvidence(scene), headEvidence(dependency)],
        message: `"${scene.title}" is declared to follow "${dependency.title}", but it happens on day ${day}, before day ${required}`,
        expected: `day ${required} or later`,
      });
    }
  }
  return { drafts, notes };
}

/**
 * §5.1 `timeline.window`: a scene under a folder that declares a span must fall
 * inside it. Only declared spans are checked, and the folder's own span is never
 * inherited from anywhere (§5.1). Dream, mythic and backstory scenes are exempt.
 */
export function checkWindow(input: CheckInput): CheckOutput {
  const drafts: DraftFinding[] = [];
  for (const folder of input.folders) {
    const start = folder.meta.dayOffset;
    const duration = folder.meta.durationDays;
    if (start === undefined || duration === undefined || duration < 1) continue;
    const span: DayWindow = windowOf(start, duration);
    const end = span.end - 1;
    for (const scene of input.scenes) {
      if (!scene.ancestorIds.includes(folder.id)) continue;
      const day = dayOf(scene);
      if (day === undefined) continue;
      if (treatmentOf(modeOf(scene), 'timeline.window') === 'exempt') continue;
      const window = windowOf(day, scene.meta.durationDays);
      if (windowInside(window, span)) continue;
      drafts.push({
        checkId: 'timeline.window',
        type: 'outside-span',
        severity: 'warning',
        factGroup: groupKey(scene.docId, `within:${folder.id}`),
        evidence: [headEvidence(scene)],
        message: `"${scene.title}" falls outside "${folder.title}", which spans days ${start} to ${end}`,
        expected: `days ${start} to ${end}`,
      });
    }
  }
  return { drafts, notes: [] };
}

/**
 * §5.1 `timeline.overlap`: sibling scenes whose windows intersect. Information
 * only, because parallel points of view are normal. A `simultaneous` scene is
 * exempt, since declaring simultaneity is the intent this check is asking about.
 */
export function checkOverlap(input: CheckInput): CheckOutput {
  const groups = new Map<string, ScannedScene[]>();
  for (const scene of scheduledScenes(input)) {
    const key = scene.parentId ?? '';
    const list = groups.get(key) ?? [];
    list.push(scene);
    groups.set(key, list);
  }
  const drafts: DraftFinding[] = [];
  for (const siblings of groups.values()) {
    const ordered = [...siblings].sort((a, b) => a.binderIndex - b.binderIndex);
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = ordered[i];
        const b = ordered[j];
        if (a === undefined || b === undefined) continue;
        if (modeOf(a) === 'simultaneous' || modeOf(b) === 'simultaneous') continue;
        const wa = windowOf(dayOf(a) ?? 0, a.meta.durationDays);
        const wb = windowOf(dayOf(b) ?? 0, b.meta.durationDays);
        if (!windowsOverlap(wa, wb)) continue;
        const first = Math.max(wa.start, wb.start);
        const last = Math.min(wa.end, wb.end) - 1;
        drafts.push({
          checkId: 'timeline.overlap',
          type: 'sibling-overlap',
          severity: 'info',
          factGroup: groupKey(pairKey(a.docId, b.docId), 'overlap'),
          evidence: [headEvidence(a), headEvidence(b)],
          message: `"${a.title}" and "${b.title}" share day${first === last ? '' : 's'} ${first === last ? first : `${first} to ${last}`}`,
          expected: 'separate days, or declare the scene simultaneous if the overlap is intended',
        });
      }
    }
  }
  return { drafts, notes: [] };
}
