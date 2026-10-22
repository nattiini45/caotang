import { describe, expect, it } from 'vitest';

import {
  assembleInput,
  dismissFinding,
  emptyCoherenceFile,
  runChecks,
  runDeterministic,
  type CheckInput,
  type CoherenceFile,
  type SceneMeta,
} from '../src/index.js';

import { LATER, NOW, buildState, detect } from './fixtures.js';

const CHECK = ['plot.unresolved-thread'] as const;

function withMeta(sceneMeta: Record<string, SceneMeta>): CoherenceFile {
  return { ...emptyCoherenceFile(), sceneMeta };
}

/** Chapter 2 sets threads up; chapter 14 is written; the epilogue is in the binder with no text; the old draft is archived. */
function book(setupBody = 'A lamp stood on the sill.'): ReturnType<typeof buildState> {
  return buildState({
    scenes: [
      { id: 'ch2', title: 'Chapter 2', body: setupBody },
      { id: 'ch14', title: 'Chapter 14', body: 'The lamp was lit again.' },
      { id: 'epilogue', title: 'Epilogue', body: '' },
      { id: 'oldDraft', title: 'Old draft', body: 'Cut chapter.', status: 'archived' },
    ],
  });
}

function scan(state: ReturnType<typeof buildState>, file: CoherenceFile): ReturnType<typeof runChecks> {
  return runChecks(assembleInput(state, file, { detector: detect }).input, CHECK);
}

describe('plot.unresolved-thread (coherence.md §5.5)', () => {
  it('raises nothing for a thread whose payoff is a scanned scene', () => {
    const out = scan(book(), withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'ch14' }] } }));
    expect(out.drafts).toEqual([]);
  });

  it('warns for a payoff that names nothing, naming the setup document, the payoff id and the handle', () => {
    const out = scan(book(), withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'gone9' }] } }));
    expect(out.drafts).toHaveLength(1);
    const [finding] = out.drafts;
    expect(finding).toMatchObject({ checkId: 'plot.unresolved-thread', type: 'payoff-unresolved', severity: 'warning' });
    expect(finding?.message).toBe('"Chapter 2" declares the thread "the lamp" with its payoff in gone9, which is not a document in the project');
    expect(finding?.evidence.map((passage) => passage.docId)).toEqual(['ch2']);
  });

  it('gives an info, not a warning, for a payoff that is in the project and was not read', () => {
    for (const payoff of ['epilogue', 'oldDraft']) {
      const out = scan(book(), withMeta({ ch2: { threads: [{ id: 'the lamp', payoff }] } }));
      expect(out.drafts).toHaveLength(1);
      expect(out.drafts[0]).toMatchObject({ type: 'payoff-not-read', severity: 'info' });
    }
    const named = scan(book(), withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'epilogue' }] } }));
    expect(named.drafts[0]?.message).toBe('"Chapter 2" declares the thread "the lamp" with its payoff in "Epilogue", which this scan did not read');
  });

  it('treats a folder named as the payoff as nothing, since only a document can pay a thread off', () => {
    const state = buildState({
      folders: [{ id: 'part1', title: 'Part one' }],
      scenes: [{ id: 'ch2', title: 'Chapter 2', body: 'A lamp.' }],
    });
    const out = scan(state, withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'part1' }] } }));
    expect(out.drafts[0]).toMatchObject({ severity: 'warning' });
  });

  it('raises one finding per unresolved thread on a scene, grouped by the setup document and the handle', () => {
    const file = withMeta({
      ch2: {
        threads: [
          { id: 'the lamp', payoff: 'gone9' },
          { id: 'The Key', payoff: 'epilogue' },
          { id: 'the map', payoff: 'ch14' },
        ],
      },
    });
    const out = scan(book(), file);
    expect(out.drafts.map((draft) => draft.factGroup)).toEqual(['ch2|thread:the lamp', 'ch2|thread:the key']);
  });

  it('keeps its fact group when the text around the setup changes, so a dismissal survives the edit', () => {
    const file = withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'gone9' }] } });
    const first = runDeterministic(book(), file, { scope: { mode: 'full' }, checks: [...CHECK], now: NOW, detector: detect });
    const found = first.file.findings.find((finding) => finding.checkId === 'plot.unresolved-thread');
    if (found === undefined) throw new Error('fixture: the scan made no thread finding');
    const dismissed = dismissFinding(first.file, found.id, { reason: 'intentional' }, NOW);

    const again = runDeterministic(book('Rain first. Then a lamp stood on the sill.'), dismissed, {
      scope: { mode: 'full' },
      checks: [...CHECK],
      now: LATER,
      detector: detect,
    });
    const threadFindings = again.file.findings.filter((finding) => finding.checkId === 'plot.unresolved-thread');
    expect(threadFindings).toHaveLength(1);
    expect(threadFindings[0]).toMatchObject({ id: found.id, status: 'dismissed' });
  });

  it('says how many scenes declared a thread and how many were not compared', () => {
    const none = scan(book(), emptyCoherenceFile());
    expect(none.drafts).toEqual([]);
    expect(none.notes).toEqual(['0 of 2 scene(s) declare a thread; 2 not compared']);
    const one = scan(book(), withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'ch14' }] } }));
    expect(one.notes).toEqual(['1 of 2 scene(s) declare a thread; 1 not compared']);
  });

  it('reads a payoff the same way whatever the scope: a changed-files run that skips the payoff scene does not warn', () => {
    const base = withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'ch14' }] } });
    const reviewed: CoherenceFile = { ...base, reviewState: { ch14: { lastReviewedRevision: 0, lastReviewedAt: NOW.toISOString() } } };
    const run = runDeterministic(book(), reviewed, { scope: { mode: 'changed' }, checks: [...CHECK], now: NOW, detector: detect });
    expect(run.run.scope.docIds).toEqual(['ch2']);
    expect(run.file.findings).toEqual([]);
  });

  it('leaves a thread out of a run that does not read its setup scene', () => {
    const file = withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'gone9' }] } });
    const run = runDeterministic(book(), file, { scope: { mode: 'doc', docIds: ['ch14'] }, checks: [...CHECK], now: NOW, detector: detect });
    expect(run.file.findings).toEqual([]);
  });

  it('does not compare a thread declared on a scene that was not scanned', () => {
    const out = scan(book(), withMeta({ epilogue: { threads: [{ id: 'the lamp', payoff: 'gone9' }] } }));
    expect(out.drafts).toEqual([]);
  });

  it('skips a thread with a blank handle, which the patch refuses and the file load drops', () => {
    const out = scan(book(), withMeta({ ch2: { threads: [{ id: '  ', payoff: 'gone9' }] } }));
    expect(out.drafts).toEqual([]);
    expect(out.notes).toEqual(['0 of 2 scene(s) declare a thread; 2 not compared']);
  });

  it('says it did not run when the document list was not supplied, and raises nothing', () => {
    const assembled = assembleInput(book(), withMeta({ ch2: { threads: [{ id: 'the lamp', payoff: 'gone9' }] } }), { detector: detect });
    const { treeDocuments: _omitted, ...rest } = assembled.input;
    const out = runChecks(rest as CheckInput, CHECK);
    expect(out.drafts).toEqual([]);
    expect(out.notes).toEqual(['thread payoffs not checked: the project’s document list was not supplied']);
  });
});
