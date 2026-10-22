/**
 * Screenplay and storyboard checks — [screenplay.md §4](../../../../docs/architecture/screenplay.md) and
 * [storyboard.md §5](../../../../docs/architecture/storyboard.md): `script.cue-collision`, `script.cue-consistency`
 * and `script.shot-coverage`.
 *
 * Pure over the scanned documents and the shot facts. The cue checks read only screenplay documents, and the shot
 * checks read the storyboard's shots, which sit in the tree and have no body of their own.
 */

import { characterCueNames, cueKey, type LocatedElement } from '@caotang/screenplay';

import { EVIDENCE_QUOTE_LIMIT, type Evidence } from '../model.js';
import { bodyOffsetsOf, resolveAnchor, type BodyRange } from '../anchors.js';
import { cueFactsOf, entryForCue, isScreenplayDocument, type CueFacts } from '../cues.js';
import { headEvidence, type ScannedScene, type ShotFact } from '../scope.js';
import { codePointPrefix } from '../text.js';

import { groupKey, type CheckInput, type CheckOutput, type DraftFinding } from './common.js';

/** The parse elements a shot can cover: a character cue and the dialogue under it (storyboard.md §2.2). */
const COVERABLE_TYPES: ReadonlySet<string> = new Set(['character', 'dialogue']);

/**
 * The screenplay read of a scene: the read the run shared, when it has one, and a read of its own otherwise. A check
 * called on its own reads the body itself, so the findings are the same either way.
 */
export function factsOf(input: CheckInput, scene: ScannedScene): CueFacts {
  return input.cueFacts?.get(scene.docId) ?? cueFactsOf(scene.body);
}

/**
 * A passage of a scene, quoted verbatim at the body's own offsets. The offsets given are the normalised text's (the parse
 * reads that text), and they are mapped to the body's before the slice, so a CRLF or byte-order-marked body quotes the
 * passage it names.
 */
export function passageAt(scene: ScannedScene, from: number, to: number): Evidence {
  const toBody = bodyOffsetsOf(scene.body);
  const start = toBody(from);
  const quote = codePointPrefix(scene.body.slice(start, toBody(to)), EVIDENCE_QUOTE_LIMIT);
  return { docId: scene.docId, quote, from: start, to: start + quote.length };
}

/** Names in quotes, joined as a sentence joins them: "A", "B" and "C". */
function quoteList(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  const last = quoted.pop() ?? '';
  return quoted.length === 0 ? last : `${quoted.join(', ')} and ${last}`;
}

/**
 * screenplay.md §4 `script.cue-collision`: a character cue that names no codex entry is information, because the
 * codex cannot count a character it does not hold. The fix is the codex (the `pov.coverage` pattern), so it is not a
 * violation. Each cue is judged in its own scene, and the group is the name, so the inbox shows one problem with
 * a citation per scene.
 */
export function checkCueCollision(input: CheckInput): CheckOutput {
  const drafts: DraftFinding[] = [];
  for (const scene of input.scenes) {
    if (!isScreenplayDocument(scene.kind)) continue;
    for (const element of factsOf(input, scene).elements) {
      if (element.type !== 'character') continue;
      const [name] = characterCueNames([element]);
      if (name === undefined || entryForCue(input.entries, name) !== undefined) continue;
      drafts.push({
        checkId: 'script.cue-collision',
        type: 'cue-unmatched',
        severity: 'info',
        factGroup: groupKey(cueKey(name), 'cue-unmatched'),
        evidence: [passageAt(scene, element.range.from, element.range.to)],
        message: `The cue "${name}" in "${scene.title}" matches no codex entry`,
        expected: 'a codex entry for this character, or an alias that names the cue',
      });
    }
  }
  return { drafts, notes: [] };
}

/**
 * screenplay.md §4 `script.cue-consistency`: one character cued in two or more spellings is a warning, since the
 * same person then reads as two. The spellings are compared across the screenplay documents read, because a variant
 * in chapter three is as much a problem as one inside a single scene. A finding names every spelling of the character,
 * and it is raised for each scene that cues the character, with that scene's own spelling in its message.
 */
export function checkCueConsistency(input: CheckInput): CheckOutput {
  const spellings = new Map<string, string[]>();
  const usedBy = new Map<string, Map<string, { readonly scene: ScannedScene; readonly forms: string[] }>>();
  for (const scene of input.scenes) {
    if (!isScreenplayDocument(scene.kind)) continue;
    for (const name of factsOf(input, scene).names) {
      const key = cueKey(name);
      if (key === '') continue;
      const forms = spellings.get(key) ?? [];
      if (!forms.includes(name)) forms.push(name);
      spellings.set(key, forms);
      const scenes = usedBy.get(key) ?? new Map<string, { readonly scene: ScannedScene; readonly forms: string[] }>();
      const use = scenes.get(scene.docId) ?? { scene, forms: [] };
      if (!use.forms.includes(name)) use.forms.push(name);
      scenes.set(scene.docId, use);
      usedBy.set(key, scenes);
    }
  }

  const drafts: DraftFinding[] = [];
  for (const [key, forms] of spellings) {
    if (forms.length < 2) continue;
    const listed = quoteList(forms);
    for (const { scene, forms: own } of usedBy.get(key)?.values() ?? []) {
      drafts.push({
        checkId: 'script.cue-consistency',
        type: 'cue-spelling',
        severity: 'warning',
        factGroup: groupKey(key, 'cue-spelling'),
        evidence: [headEvidence(scene)],
        message: `${listed} are cued as one character; "${scene.title}" cues ${quoteList(own)}`,
        expected: 'one spelling for each character, with the others kept as aliases',
      });
    }
  }
  return { drafts, notes: [] };
}

/** The text an element says, which names its uncovered finding: a cue's name, or a line of dialogue. */
function contentOf(element: LocatedElement): string {
  if (element.type === 'character') return characterCueNames([element])[0] ?? '';
  return element.type === 'dialogue' ? element.text : '';
}

/** Whether a resolved anchor range and an element's range share a character. A zero-length span shares none. */
function overlaps(range: BodyRange, from: number, to: number): boolean {
  return range.from < to && from < range.to;
}

/**
 * storyboard.md §5 `script.shot-coverage`, with its three finding kinds:
 *  - `uncovered`: a cue or dialogue element of a screenplay document that no shot's `dialogue[]` anchor covers;
 *  - `duration-missing`: a shot with no `durationSec`, so it is left out of the animatic totals;
 *  - `anchor-drift`: a shot's `dialogue[]` anchor that no longer resolves in its scene (edit-anchors §3, see anchors.ts).
 *    The check reports it; the re-anchor happens only when the writer fixes it (edit-anchors §3 posture).
 *
 * Coverage is judged on the anchors as they resolve in the body now, so an edit above a covered line keeps the line
 * covered. Each finding's group is its content, not its position, so a dismissed finding stays dismissed when the text
 * around it changes.
 *
 * The uncovered kind is judged only once the project has a shot, since a manuscript with no storyboard would
 * otherwise be all findings. Every finding is information: a coverage gap is a plan, not an error.
 */
export function checkShotCoverage(input: CheckInput): CheckOutput {
  const shots = input.shots ?? [];
  const drafts: DraftFinding[] = [];

  for (const shot of shots) {
    if (shot.durationSec !== undefined) continue;
    drafts.push({
      checkId: 'script.shot-coverage',
      type: 'duration-missing',
      severity: 'info',
      factGroup: groupKey(shot.id, 'duration-missing'),
      evidence: [],
      message: `"${shot.title}" has no duration, so it is left out of the animatic totals`,
      expected: 'a duration in seconds for the shot',
    });
  }

  const byDocId = new Map(input.scenes.map((scene) => [scene.docId, scene] as const));
  const coveredByDoc = new Map<string, BodyRange[]>();
  const drifted: { readonly shot: ShotFact; readonly scene: ScannedScene; readonly exact: string }[] = [];
  for (const shot of shots) {
    for (const entry of shot.coverage) {
      const scene = byDocId.get(entry.docId);
      // A document this run did not read cannot be compared, so it neither covers nor drifts here.
      if (scene === undefined) continue;
      const range = resolveAnchor(entry.anchor, scene.body);
      if (range === undefined) {
        drifted.push({ shot, scene, exact: entry.anchor.exact });
        continue;
      }
      coveredByDoc.set(entry.docId, [...(coveredByDoc.get(entry.docId) ?? []), range]);
    }
  }

  if (shots.length > 0) {
    for (const scene of input.scenes) {
      if (!isScreenplayDocument(scene.kind)) continue;
      const toBody = bodyOffsetsOf(scene.body);
      const covered = coveredByDoc.get(scene.docId) ?? [];
      // The n-th element of a given text in a scene is the same element for every run, whatever sits above it.
      const occurrences = new Map<string, number>();
      for (const element of factsOf(input, scene).elements) {
        if (!COVERABLE_TYPES.has(element.type)) continue;
        const slot = `${element.type}|${contentOf(element)}`;
        const ordinal = occurrences.get(slot) ?? 0;
        occurrences.set(slot, ordinal + 1);
        if (covered.some((range) => overlaps(range, toBody(element.range.from), toBody(element.range.to)))) continue;
        const kind = element.type === 'character' ? 'cue' : 'line of dialogue';
        drafts.push({
          checkId: 'script.shot-coverage',
          type: 'uncovered',
          severity: 'info',
          factGroup: groupKey(scene.docId, `uncovered|${slot}#${ordinal}`),
          evidence: [passageAt(scene, element.range.from, element.range.to)],
          message: `The ${kind} at this point in "${scene.title}" is covered by no shot`,
          expected: 'a shot whose dialogue coverage includes this line',
        });
      }
    }
  }

  for (const { shot, scene, exact } of drifted) {
    drafts.push({
      checkId: 'script.shot-coverage',
      type: 'anchor-drift',
      severity: 'info',
      factGroup: groupKey(shot.id, `anchor-drift|${exact}`),
      evidence: [headEvidence(scene)],
      message: `A dialogue anchor of "${shot.title}" no longer matches the text of "${scene.title}"`,
      expected: 're-anchor the coverage to the passage it names',
    });
  }

  return { drafts, notes: [] };
}
