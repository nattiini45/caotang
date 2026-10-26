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
import { addDocument } from '@caotang/store';

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

  it('runs on a copy: a held file with a prior run and review state is deep-equal before and after, and no run is added', () => {
    const state = makeState();
    // Seed a file that already carries a run, findings and review state, so an evaluation that wrote back or mutated it in place shows.
    const seeded = runDeterministic(state, emptyCoherenceFile(), { scope: FULL, checks: ['codex.never-mentioned'], now: new Date('2026-10-25T09:00:00.000Z'), detector: countIn });
    const held: CoherenceFile = structuredClone(seeded.file);
    held.reviewState['seeded-doc'] = { lastReviewedRevision: 1, lastReviewedAt: '2026-10-25T09:00:00.000Z' };
    state.coherence = held;
    expect(held.runs).toHaveLength(1);
    expect(held.findings.length).toBeGreaterThan(0);
    const before = snapshot(state.coherence);
    const runs = held.runs.length;
    evaluateCheck(CLEAN, state, options);
    evaluateCheck(CLEAN, state, options);
    expect(snapshot(state.coherence)).toBe(before);
    expect(state.coherence).toBe(held);
    expect(state.coherence?.runs.length).toBe(runs);
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

  it('is not met when the scan drops every check it named, rather than passing on a scan that looked at nothing', () => {
    // The branch checks read a full scan with the app's dialogue facts; a document scope (or no facts) runs none of them.
    const state = makeState();
    for (const scope of [FULL, { mode: 'doc', docIds: [LANDING] } as const]) {
      const result = evaluateCheck({ kind: 'coherence.clean', scope, checks: ['branch.dead-end', 'branch.loose-end'] }, state, options);
      expect(result.pass).toBe(false);
      expect(result.distance).toBe(1);
      expect(result.failures[0]?.detail).toContain('nothing was checked');
      expect(result.skipped).toEqual(['branch.dead-end', 'branch.loose-end']);
    }
  });

  it('lists a named check the scan dropped in skipped when another one ran', () => {
    const state = makeState();
    setBody(state, LANDING, 'Elena met Kestrel on the quay.');
    const spec: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned', 'branch.dead-end'] };
    const result = evaluateCheck(spec, state, options);
    expect(result.pass).toBe(true);
    expect(result.skipped).toEqual(['branch.dead-end']);
  });

  it('is not met, and says why, when every check it would run is turned off', () => {
    const result = evaluateCheck(CLEAN, makeState(), { ...options, enabled: ['pov.coverage'] });
    expect(result.pass).toBe(false);
    expect(result.skipped).toEqual(['codex.never-mentioned']);
    expect(result.failures[0]?.detail).toContain('turned off in Settings');
    expect(result.unmeetable).toBe(true);
  });

  it('is not met, instead of throwing, when its scope cannot be read', () => {
    const result = evaluateCheck({ kind: 'coherence.clean', scope: { mode: 'doc', docIds: [FRIEND] } }, makeState(), options);
    expect(result.pass).toBe(false);
    expect(result.failures[0]?.detail).toContain('empty');
  });
});

describe('an archived document', () => {
  const tooShort: CheckSpec = { kind: 'words.between', scope: FULL, max: 1 };
  const titlesOf = (spec: CheckSpec, state = archivedStorm()): readonly string[] => evaluateCheck(spec, state, options).failures.map((failure) => failure.title);

  function archivedStorm() {
    const state = makeState();
    const storm = state.manifest.tree.find((node) => node.id === STORM);
    if (storm !== undefined) storm.status = 'archived';
    return state;
  }

  it('is not read when named directly, and the result says it was left out', () => {
    const result = evaluateCheck({ ...tooShort, scope: { mode: 'doc', docIds: [STORM] } } as CheckSpec, archivedStorm(), options);
    expect(result.failures).toEqual([]);
    expect(result.notes).toContain('"The Storm" is archived, so a goal does not read it.');
    // Nothing else was named, so the check is visibly vacuous.
    expect(result.notes).toContain('no documents in scope');
  });

  it('is read on no route: not named, not through its folder, not in the whole manuscript', () => {
    const named = evaluateCheck({ ...tooShort, scope: { mode: 'doc', docIds: [STORM, CHAPTER_ONE] } } as CheckSpec, archivedStorm(), options);
    expect(named.failures.map((failure) => failure.title)).toEqual(['The Landing']);
    expect(titlesOf({ ...tooShort, scope: { mode: 'doc', docIds: [CHAPTER_ONE] } } as CheckSpec)).toEqual(['The Landing']);
    expect(titlesOf(tooShort)).toEqual(['The Landing']);
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
      { kind: 'words.between', min: 1 } as never,
      { kind: 'words.between', scope: { mode: 'bogus' } as never, min: 1 },
      { kind: 'words.between', scope: { mode: 'doc' } as never, min: 1 },
      { kind: 'nope', scope: FULL } as never,
      null as never,
      { kind: 'coherence.clean', scope: FULL, checks: [] },
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

describe('a read rule (agent-harness §4)', () => {
  const hidden = new Set([STORM]);
  const withheld: CheckOptions = { ...options, withheld: hidden };

  it('leaves a withheld document out of words, status and synopsis checks, counting it without naming it', () => {
    const state = makeState();
    for (const spec of [{ kind: 'words.between', scope: FULL, min: 100 }, { kind: 'status.all', scope: FULL, status: 'final' }, { kind: 'synopsis.filled', scope: FULL }] as CheckSpec[]) {
      const open = evaluateCheck(spec, state, options);
      expect(open.failures.some((failure) => failure.docId === STORM)).toBe(true);
      const result = evaluateCheck(spec, state, withheld);
      expect(JSON.stringify(result)).not.toContain('The Storm');
      expect(JSON.stringify(result)).not.toContain(STORM);
      expect(result.distance).toBe(open.distance - 1);
      expect(result.notes).toContain('1 document is withheld from the agent by a rule and not checked.');
    }
  });

  it('does not report a withheld reference as unknown, and does not read it', () => {
    const state = makeState();
    const result = evaluateCheck({ kind: 'status.all', scope: { mode: 'doc', docIds: [STORM] }, status: 'final' }, state, withheld);
    expect(result.failures).toEqual([]);
    expect(JSON.stringify([result.failures, result.notes])).not.toContain(STORM);
    expect(result.notes).toContain('1 document is withheld from the agent by a rule and not checked.');
  });

  it('leaves the documents under a withheld folder out too', () => {
    const state = makeState();
    const result = evaluateCheck({ kind: 'status.all', scope: FULL, status: 'final' }, state, { ...options, withheld: new Set([CHAPTER_ONE, LANDING, STORM]) });
    expect(result.failures.map((failure) => failure.docId)).toEqual([FRIEND]);
  });

  it('runs a coherence check with the withheld document excluded, so no finding quotes it', () => {
    const state = makeState();
    setBody(state, STORM, 'Elena met Kestrel in the storm.');
    const spec: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] };
    expect(evaluateCheck(spec, state, options).pass).toBe(true);
    const result = evaluateCheck(spec, state, withheld);
    expect(result.pass).toBe(false);
    expect(JSON.stringify(result)).not.toContain('The Storm');
  });

  it('shows a held finding that quotes a withheld document without its title or text', () => {
    const state = makeState();
    setBody(state, STORM, 'Elena met Kestrel in the storm.');
    const seeded = runDeterministic(state, emptyCoherenceFile(), { scope: FULL, checks: ['codex.never-mentioned'], now: new Date('2026-10-25T09:00:00.000Z'), detector: countIn });
    const quoting = structuredClone(seeded.file);
    quoting.findings.push({
      ...(quoting.findings[0] ?? ({} as never)),
      id: 'f_held',
      status: 'open',
      checkId: 'codex.never-mentioned',
      severity: 'warning',
      message: 'Secret passage in the storm',
      evidence: [{ docId: STORM, text: 'Secret passage in the storm' } as never],
    });
    state.coherence = quoting;
    const result = evaluateCheck({ kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] }, state, withheld);
    expect(JSON.stringify(result)).not.toContain('Secret passage');
    expect(JSON.stringify(result)).not.toContain('The Storm');
  });

  it('counts only what the agent may read toward the large-scope guard', () => {
    const state = makeState();
    const extra: string[] = [];
    for (let at = 0; at < 20; at += 1) {
      const id = `n_EXTRA${String(at).padStart(5, '0')}`;
      extra.push(id);
      addDocument(state, { parentId: CHAPTER_TWO, title: `Extra ${at}`, body: 'Words.', now: new Date('2026-10-08T09:00:00.000Z'), id });
    }
    const spec: CheckSpec = { kind: 'coherence.clean', scope: FULL };
    expect(largeScopes([spec], state)).toHaveLength(1);
    expect(largeScopes([spec], state, new Set(extra.slice(0, 5)))).toEqual([]);
    expect(coherenceScopeSize(state, FULL, new Set(extra.slice(0, 5)))).toBe(coherenceScopeSize(state, FULL) - 5);
  });
});
