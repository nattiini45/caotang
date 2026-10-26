/**
 * Goal acceptance checks (agent-harness §7.2) on a real in-memory project: each kind passes and fails, a coherence check runs on a copy
 * and leaves the held file exactly as it was, a dismissed finding is clean, and a check the writer turned off is left out and said so.
 */

import { describe, expect, it } from 'vitest';

import { emptyCoherenceFile, runDeterministic, type CoherenceFile } from '@caotang/coherence';
import { setBody } from '@caotang/store';

import { checkKey, checkSpecProblem, coherenceScopeSize, evaluateCheck, evaluateChecks, largeScopes, type CheckOptions, type CheckSpec } from '../../src/index.js';
import { countIn } from '../../src/tools/coherence.js';
import { CHAPTER_ONE, CHAPTER_TWO, FRIEND, LANDING, STORM, makeState } from '../fixtures.js';

const options: CheckOptions = { now: new Date('2026-10-26T09:00:00.000Z') };
const FULL = { mode: 'full' } as const;

/** Elena and Kestrel are in the codex and named in no document of the fixture: two information findings. */
const CLEAN: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] };

const snapshot = (value: unknown): string => JSON.stringify(value);

describe('coherence.clean', () => {
  it('counts the open findings of the checks it runs, and passes once the codex is named', () => {
    const state = makeState();
    const failing = evaluateCheck(CLEAN, state, options);
    expect(failing.pass).toBe(false);
    expect(failing.distance).toBe(2);
    expect(failing.failures.map((failure) => failure.detail)).toEqual(
      expect.arrayContaining([expect.stringContaining('Elena'), expect.stringContaining('Kestrel')]),
    );
    expect(failing.failures.every((failure) => failure.title === 'Codex' && failure.docId === undefined)).toBe(true);

    setBody(state, LANDING, 'Elena met Kestrel on the quay.');
    const passing = evaluateCheck(CLEAN, state, options);
    expect(passing).toMatchObject({ pass: true, distance: 0, failures: [] });
  });

  it('runs on a copy: the held coherence file is deep-equal before and after, and no run is recorded', () => {
    const state = makeState();
    const before = snapshot(state.coherence ?? null);
    evaluateCheck(CLEAN, state, options);
    evaluateCheck(CLEAN, state, options);
    expect(snapshot(state.coherence ?? null)).toBe(before);
    expect(state.coherence?.runs ?? []).toEqual([]);
  });

  it('counts only findings at or above the minimum severity', () => {
    const state = makeState();
    expect(evaluateCheck({ ...CLEAN, minSeverity: 'warning' } as CheckSpec, state, options).pass).toBe(true);
    expect(evaluateCheck({ ...CLEAN, minSeverity: 'info' } as CheckSpec, state, options).distance).toBe(2);
  });

  it('treats a dismissed finding as clean', () => {
    const state = makeState();
    const scanned = runDeterministic(state, emptyCoherenceFile(), { scope: FULL, checks: ['codex.never-mentioned'], now: options.now, detector: countIn });
    expect(scanned.file.findings).toHaveLength(2);
    const file: CoherenceFile = structuredClone(scanned.file);
    for (const finding of file.findings) {
      finding.status = 'dismissed';
      finding.dismissedReason = 'intended';
    }
    state.coherence = file;
    const result = evaluateCheck(CLEAN, state, options);
    expect(result.pass).toBe(true);
    // The dismissed findings are still held: evaluating changed nothing.
    expect(state.coherence?.findings.every((finding) => finding.status === 'dismissed')).toBe(true);
  });

  it('leaves out a check the writer turned off, and says which', () => {
    const state = makeState();
    const spec: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned', 'codex.alias-collisions'] };
    const result = evaluateCheck(spec, state, { ...options, enabled: ['codex.never-mentioned'] });
    expect(result.skipped).toEqual(['codex.alias-collisions']);
    expect(result.distance).toBe(2);
  });

  it('is not met, and says why, when every check it would run is turned off', () => {
    const result = evaluateCheck(CLEAN, makeState(), { ...options, enabled: ['pov.coverage'] });
    expect(result.pass).toBe(false);
    expect(result.skipped).toEqual(['codex.never-mentioned']);
    expect(result.failures[0]?.detail).toContain('turned off in Settings');
  });

  it('is not met, instead of throwing, when its scope cannot be read', () => {
    const result = evaluateCheck({ kind: 'coherence.clean', scope: { mode: 'doc', docIds: [FRIEND] } }, makeState(), options);
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.detail).toContain('empty');
  });
});

describe('words.between', () => {
  it('fails for a document outside the range and names how far, then passes inside it', () => {
    const state = makeState();
    const spec: CheckSpec = { kind: 'words.between', scope: FULL, min: 3, max: 8 };
    const failing = evaluateCheck(spec, state, options);
    // The Landing has six words; The Storm has five; The Friend is empty and so is short by three.
    expect(failing.failures.map((failure) => failure.title)).toEqual(['The Friend']);
    expect(failing.failures[0]?.detail).toBe('has 0 words, 3 short of 3');
    expect(failing.distance).toBe(1);

    setBody(state, FRIEND, 'The friend waited.');
    expect(evaluateCheck(spec, state, options).pass).toBe(true);
    setBody(state, STORM, 'Rain fell on the lamp room for a very long night.');
    const over = evaluateCheck(spec, state, options);
    expect(over.failures[0]).toMatchObject({ title: 'The Storm', detail: expect.stringContaining('over 8') });
  });

  it('reads the counter the inspector and the goals read', () => {
    const state = makeState();
    state.manifest.derived.wordCounts[STORM] = 100;
    const result = evaluateCheck({ kind: 'words.between', scope: { mode: 'doc', docIds: [STORM] }, max: 50 }, state, options);
    expect(result.failures[0]?.detail).toBe('has 100 words, 50 over 50');
  });

  it('expands a folder in a document scope to the documents under it', () => {
    const state = makeState();
    const one = evaluateCheck({ kind: 'words.between', scope: { mode: 'doc', docIds: [CHAPTER_ONE] }, min: 100 }, state, options);
    expect(one.failures.map((failure) => failure.title)).toEqual(['The Landing', 'The Storm']);
    const two = evaluateCheck({ kind: 'words.between', scope: { mode: 'doc', docIds: [CHAPTER_TWO] }, min: 100 }, state, options);
    expect(two.failures.map((failure) => failure.title)).toEqual(['The Friend']);
  });
});

describe('status.all', () => {
  it('names each document with another status, and passes when every one has it', () => {
    const state = makeState();
    const spec: CheckSpec = { kind: 'status.all', scope: FULL, status: 'draft' };
    const failing = evaluateCheck(spec, state, options);
    expect(failing.failures.map((failure) => failure.title)).toEqual(['The Storm', 'The Friend']);
    expect(failing.failures[0]?.detail).toBe('has no status, not "draft"');
    for (const id of [STORM, FRIEND]) {
      const node = state.manifest.tree.find((candidate) => candidate.id === id);
      if (node !== undefined) node.status = 'draft';
    }
    expect(evaluateCheck(spec, state, options)).toMatchObject({ pass: true, distance: 0 });
  });
});

describe('synopsis.filled', () => {
  it('fails for an empty synopsis and for one over the word limit', () => {
    const state = makeState();
    const spec: CheckSpec = { kind: 'synopsis.filled', scope: FULL, maxWords: 3 };
    const failing = evaluateCheck(spec, state, options);
    expect(failing.failures.map((failure) => `${failure.title}: ${failure.detail}`)).toEqual([
      'The Landing: has a synopsis of 5 words, over 3',
      'The Storm: has no synopsis',
      'The Friend: has no synopsis',
    ]);
    for (const node of state.manifest.tree) if (node.type === 'document') node.synopsis = 'Short one.';
    expect(evaluateCheck(spec, state, options).pass).toBe(true);
  });
});

describe('scopes', () => {
  it('reads the documents changed since the last review in a changed scope', () => {
    const state = makeState();
    const spec: CheckSpec = { kind: 'synopsis.filled', scope: { mode: 'changed' } };
    expect(evaluateCheck(spec, state, options).distance).toBe(2);
    const file = emptyCoherenceFile();
    file.reviewState[STORM] = { lastReviewedRevision: state.documents.get(STORM)?.revision ?? 0, lastReviewedAt: options.now.toISOString() };
    state.coherence = file;
    expect(evaluateCheck(spec, state, options).failures.map((failure) => failure.title)).toEqual(['The Friend']);
  });

  it('is not met, and names the reference, when a document scope names nothing in the project', () => {
    const result = evaluateCheck({ kind: 'status.all', scope: { mode: 'doc', docIds: ['n_MSSNG00001'] }, status: 'draft' }, makeState(), options);
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toMatchObject({ title: 'n_MSSNG00001', detail: 'is not a document or folder in this project' });
  });

  it('counts the documents a coherence scope reads, for the large-scope guard', () => {
    const state = makeState();
    expect(coherenceScopeSize(state, FULL)).toBe(2);
    expect(largeScopes([CLEAN], state)).toEqual([]);
  });
});

describe('a spec that cannot be evaluated', () => {
  it('is named before a goal starts, and evaluates as not met instead of throwing', () => {
    const bad: CheckSpec[] = [
      { kind: 'words.between', scope: FULL },
      { kind: 'words.between', scope: FULL, min: 9, max: 3 },
      { kind: 'words.between', scope: FULL, min: 1.5 },
      { kind: 'status.all', scope: FULL, status: ' ' },
      { kind: 'synopsis.filled', scope: FULL, maxWords: 0 },
      { kind: 'coherence.clean', scope: { mode: 'doc', docIds: ['a', 'b'] } },
      { kind: 'coherence.clean', scope: FULL, checks: ['not.a.check' as never] },
    ];
    for (const spec of bad) {
      expect(checkSpecProblem(spec), JSON.stringify(spec)).toEqual(expect.any(String));
      expect(evaluateCheck(spec, makeState(), options).pass).toBe(false);
    }
  });

  it('is identified by its canonical JSON, so key order does not matter', () => {
    expect(checkKey({ kind: 'words.between', scope: FULL, min: 1, max: 2 })).toBe(checkKey({ max: 2, min: 1, scope: FULL, kind: 'words.between' }));
  });
});

describe('evaluateChecks', () => {
  it('is pure: the same project gives the same results', () => {
    const state = makeState();
    const specs: CheckSpec[] = [CLEAN, { kind: 'words.between', scope: FULL, min: 1 }, { kind: 'status.all', scope: FULL, status: 'draft' }];
    expect(evaluateChecks(specs, state, options)).toEqual(evaluateChecks(specs, state, options));
  });
});
