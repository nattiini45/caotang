// i18n: package-refs
/**
 * Presence checks — [coherence.md §5.1](../../../../docs/architecture/coherence.md):
 * `pov.coverage` and `presence.expected`.
 *
 * Both read mention counts, so both skip a scene whose count is unavailable. The
 * run report names the skipped scenes, and no finding is inferred from a missing number.
 */

import { headEvidence } from '../scope.js';
import { groupKey, labelOf, resolveEntry, type CheckInput, type CheckOutput, type DraftFinding } from './common.js';

/**
 * §5.1 `pov.coverage`: a scene's declared POV must be named in its text. Information
 * only, because deep and first-person POV routinely goes unnamed. A POV that is
 * not a codex entry gets a separate finding that asks for the entry, since the
 * coverage question cannot be answered without one.
 */
export function checkPovCoverage(input: CheckInput): CheckOutput {
  const drafts: DraftFinding[] = [];
  for (const scene of input.scenes) {
    const pov = scene.meta.pov;
    if (pov === undefined) continue;
    const entry = resolveEntry(input.entries, pov);
    if (entry === undefined) {
      drafts.push({
        checkId: 'pov.coverage',
        type: 'pov-unresolved',
        severity: 'info',
        factGroup: groupKey(pov.trim().toLowerCase(), 'pov-unresolved'),
        evidence: [headEvidence(scene)],
        message: `POV "${pov}" is not a codex entry, so its coverage cannot be checked; create the entry to check it`,
        messageRef: {
          id: 'coherence.pov.unresolved',
          message: 'POV "{pov}" is not a codex entry, so its coverage cannot be checked; create the entry to check it',
          values: { pov },
        },
        expected: 'a codex entry for the point-of-view character',
      });
      continue;
    }
    const counts = input.hits.get(scene.docId);
    if (counts === undefined) continue;
    if ((counts.get(entry.id) ?? 0) > 0) continue;
    drafts.push({
      checkId: 'pov.coverage',
      type: 'pov-not-named',
      severity: 'info',
      factGroup: groupKey(entry.id, 'pov-coverage'),
      evidence: [headEvidence(scene)],
      message: `POV "${labelOf(entry)}" is never named in "${scene.title}"`,
      messageRef: {
        id: 'coherence.pov.notNamed',
        message: 'POV "{entry}" is never named in "{sceneTitle}"',
        values: { entry: labelOf(entry), sceneTitle: scene.title },
      },
      expected: `"${labelOf(entry)}" named in the scene, or dismiss as deep POV`,
    });
  }
  return { drafts, notes: [] };
}

/**
 * §5.1 `presence.expected`: each entry a scene declares must be named in it. An
 * expectation that names no codex entry is reported as a note rather than as a
 * violation, since the writer may have deleted the entry on purpose.
 */
export function checkPresenceExpected(input: CheckInput): CheckOutput {
  const drafts: DraftFinding[] = [];
  const notes: string[] = [];
  for (const scene of input.scenes) {
    const expected = scene.meta.expectedPresent ?? [];
    if (expected.length === 0) continue;
    const counts = input.hits.get(scene.docId);
    for (const id of expected) {
      const entry = input.entries.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        notes.push(`"${scene.title}" expects "${id}", which is not a codex entry; not checked`);
        continue;
      }
      if (counts === undefined) continue;
      if ((counts.get(entry.id) ?? 0) > 0) continue;
      drafts.push({
        checkId: 'presence.expected',
        type: 'expected-absent',
        severity: 'error',
        factGroup: groupKey(entry.id, 'expected-present'),
        evidence: [headEvidence(scene)],
        message: `"${labelOf(entry)}" is expected in "${scene.title}" but is never named there`,
        messageRef: {
          id: 'coherence.presence.expectedAbsent',
          message: '"{entry}" is expected in "{sceneTitle}" but is never named there',
          values: { entry: labelOf(entry), sceneTitle: scene.title },
        },
        expected: `"${labelOf(entry)}" named in the scene`,
      });
    }
  }
  return { drafts, notes };
}
