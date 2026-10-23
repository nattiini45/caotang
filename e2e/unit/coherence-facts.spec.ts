import { expect, test } from '@playwright/test';
import { runDeterministic, emptyCoherenceFile, type CoherenceFile } from '../../packages/coherence/src/index.js';
import { addDocument } from '../../packages/store/src/index.js';

import { containersOf, dialogueFactsOf } from '../../apps/desktop/src/app/coherence-facts.js';
import { project } from './fixtures.js';
import { loadInkCompiler } from '../../packages/dialogue/src/index.js';

const NOW = new Date('2026-10-08T09:00:00.000Z');

/**
 * A dialogue container with an Ink body, as the binder holds one (dialogue-narrative.md §2.1). The store writes a body only for a
 * node that has a document record, so the container is added as a document and then given its node type.
 */
function addContainer(state: ReturnType<typeof project>, id: string, parentId: string, body: string, status: string | null = null): void {
  addDocument(state, { parentId, title: `Dialogue ${id}`, id, body, now: NOW });
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`fixture: ${id} was not added`);
  Object.assign(node, { type: 'dialogue', status });
}

const INK_BODY = '=== court ===\nZed: Hello there.\n';

// The Ink compiler loads on demand, as it does in the app (dialogue ink-loader.ts); these specs read the Ink with it.
test.beforeAll(async () => {
  await loadInkCompiler();
});

test.describe('the dialogue facts a scan reads (dialogue-narrative.md §5, coherence.md §5.1)', () => {
  test('a container under the manuscript is read, and the others are not: research and archived containers stay out', () => {
    const state = project();
    addContainer(state, 'd_COURT00001', 'manuscript', INK_BODY);
    addContainer(state, 'd_NOTE000001', 'research', INK_BODY);
    addContainer(state, 'd_OLD000001', 'manuscript', INK_BODY, 'archived');
    expect(containersOf(state).map((node) => node.id)).toEqual(['d_COURT00001']);
    expect(dialogueFactsOf(state).containerIds).toEqual(['d_COURT00001']);
  });

  test('every finding the facts carry is one of the three branch checks, and names the container it was computed for', () => {
    const state = project();
    addContainer(state, 'd_COURT00001', 'manuscript', INK_BODY);
    const facts = dialogueFactsOf(state);
    for (const finding of facts.findings) {
      expect(['branch.loose-end', 'branch.dead-end', 'dialogue.speaker-unknown']).toContain(finding.checkId);
      expect(finding.evidence.every((passage) => passage.docId === 'd_COURT00001')).toBe(true);
    }
  });

  test('a scan given the facts takes the branch findings into its inbox, and a scan without them does not', () => {
    const state = project();
    addContainer(state, 'd_COURT00001', 'manuscript', INK_BODY);
    const facts = dialogueFactsOf(state);
    const withFacts = runDeterministic(state, emptyCoherenceFile(), { scope: { mode: 'full' }, now: new Date('2026-10-08T09:00:00.000Z'), dialogue: facts });
    const without: CoherenceFile = runDeterministic(state, emptyCoherenceFile(), { scope: { mode: 'full' }, now: new Date('2026-10-08T09:00:00.000Z') }).file;
    expect(withFacts.run.checkIds).toEqual(expect.arrayContaining(['branch.loose-end']));
    expect(without.findings.some((finding) => finding.checkId.startsWith('branch.'))).toBe(false);
    // Each finding the dialogue module computed is one the scan holds, under the group key the module gave it.
    const held = withFacts.file.findings.filter((finding) => finding.checkId.startsWith('branch.') || finding.checkId.startsWith('dialogue.'));
    expect(new Set(held.map((finding) => finding.factGroup))).toEqual(new Set(facts.findings.map((finding) => finding.factGroup)));
  });

  test('the facts carry the speakers each container names, for the containers the scan reads', () => {
    const state = project();
    addContainer(state, 'd_COURT00001', 'manuscript', INK_BODY);
    addContainer(state, 'd_NOTE000001', 'research', INK_BODY);
    const speakers = dialogueFactsOf(state).speakersByContainer;
    expect([...(speakers?.keys() ?? [])]).toEqual(['d_COURT00001']);
    expect(speakers?.get('d_COURT00001')).toEqual([{ name: 'Zed' }]);
  });
});
