/**
 * Goal acceptance checks (agent-harness §7.2) on a real in-memory project: each kind passes and fails, a coherence check runs on a copy
 * and leaves the held file exactly as it was, a dismissed finding is clean, and a check the writer turned off is left out and said so.
 */

import { describe, expect, it } from 'vitest';

import { emptyCoherenceFile, runDeterministic, type CoherenceFile } from '@caotang/coherence';
import { getRevision, setBody } from '@caotang/store';

import type { ChatRequest } from '@caotang/gateway';

import { checkKey, checkSpecProblem, coherenceScopeSize, evaluateCheck, evaluateChecks, largeScopes, type CheckOptions, type CheckSpec } from '../../src/index.js';
import { checks, producedOutputs, type Check, type CheckContext, type TreeRow } from '../../src/agent/checks.js';
import type { TurnReport } from '../../src/agent/events.js';
import { countIn } from '../../src/tools/coherence.js';
import { CHAPTER_ONE, CHAPTER_TWO, FRIEND, LANDING, LANDING_BODY, STORM, makeState } from '../fixtures.js';
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

  it('cannot be met by any turn when the scan drops its checks for the scope, but can when the dropped one is only for want of a count', () => {
    const state = makeState();
    // Over documents, or a changed scan, the dialogue branch checks and speaker parity never run, whatever the manuscript says.
    for (const scope of [{ mode: 'doc', docIds: [LANDING] } as const, { mode: 'changed' } as const]) {
      for (const checks of [['branch.dead-end'], ['medium.speaker-parity'], ['branch.loose-end', 'medium.speaker-parity']] as const) {
        const result = evaluateCheck({ kind: 'coherence.clean', scope, checks: [...checks] }, state, options);
        expect(result.unmeetable, `${scope.mode} ${checks.join()}`).toBe(true);
        expect(result.failures[0]?.detail).toContain('full scan');
      }
    }
    // A full scan without the app's dialogue facts runs none of them either.
    expect(evaluateCheck({ kind: 'coherence.clean', scope: FULL, checks: ['branch.dead-end'] }, state, options).unmeetable).toBe(true);
    // Never-mentioned is dropped when no document is scanned, which a write can change, so it stays meetable.
    const empty = makeState();
    for (const node of empty.manifest.tree) if (node.type === 'document') node.status = 'archived';
    const mixed = evaluateCheck({ kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned', 'branch.dead-end'] }, empty, options);
    expect(mixed.pass).toBe(false);
    expect(mixed.unmeetable).toBeUndefined();
    expect(evaluateCheck({ kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] }, empty, options).unmeetable).toBeUndefined();
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
    // Nothing else was named, so the check measured nothing and is not met.
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([{ title: 'This check', detail: 'its scope holds no document the agent may read', weight: 1 }]);
    expect(result.notes).toContain('"The Storm" is archived, so a goal does not read it.');
    expect(result.notes).toContain('no documents in scope');
  });

  it('is not met by a full scope whose every document is archived, and a `changed` scope with nothing changed stays vacuous', () => {
    const state = makeState();
    for (const node of state.manifest.tree) if (node.type === 'document') node.status = 'archived';
    for (const spec of [{ kind: 'words.between', scope: FULL, min: 1 }, { kind: 'status.all', scope: FULL, status: 'draft' }, { kind: 'synopsis.filled', scope: FULL }] as CheckSpec[]) {
      const result = evaluateCheck(spec, state, options);
      expect(result.pass, spec.kind).toBe(false);
      expect(result.distance).toBe(1);
    }
    const file = emptyCoherenceFile();
    for (const node of state.manifest.tree) {
      if (node.type === 'document') file.reviewState[node.id] = { lastReviewedRevision: getRevision(state, node.id), lastReviewedAt: options.now.toISOString() };
    }
    state.coherence = file;
    const quiet = evaluateCheck({ kind: 'status.all', scope: { mode: 'changed' }, status: 'final' }, state, options);
    expect(quiet.pass).toBe(true);
    expect(quiet.notes).toContain('no documents in scope');
  });

  it('notes only the archived document a `doc` scope names directly, not one reached through a folder or the whole manuscript', () => {
    const state = archivedStorm();
    const friend = state.manifest.tree.find((node) => node.id === FRIEND);
    if (friend !== undefined) friend.status = 'archived';
    const notes = (scope: CheckSpec['scope']): readonly string[] => evaluateCheck({ ...tooShort, scope } as CheckSpec, state, options).notes.filter((note) => note.includes('archived'));
    expect(notes({ mode: 'doc', docIds: [STORM, CHAPTER_TWO] })).toEqual(['"The Storm" is archived, so a goal does not read it.']);
    expect(notes(FULL)).toEqual([]);
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
    // The scope holds nothing the agent may read, so the check is not met; it says so without naming the document.
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([{ title: 'This check', detail: 'its scope holds no document the agent may read', weight: 1 }]);
    expect(JSON.stringify([result.failures, result.notes])).not.toContain(STORM);
    expect(JSON.stringify([result.failures, result.notes])).not.toContain('The Storm');
    expect(result.notes).toContain('1 document is withheld from the agent by a rule and not checked.');
  });

  it('counts a withheld document once: named directly and through a folder, or named twice', () => {
    const state = makeState();
    const one = '1 document is withheld from the agent by a rule and not checked.';
    const status = (docIds: readonly string[]) =>
      evaluateCheck({ kind: 'status.all', scope: { mode: 'doc', docIds: [...docIds] }, status: 'draft' }, state, withheld);
    expect(status([STORM, CHAPTER_ONE]).notes).toContain(one);
    expect(status([STORM, STORM]).notes).toContain(one);
    // A withheld folder stands for the live documents under it, not for itself.
    const folder = evaluateCheck({ kind: 'status.all', scope: { mode: 'doc', docIds: [CHAPTER_ONE] }, status: 'draft' }, state, { ...options, withheld: new Set([CHAPTER_ONE, LANDING, STORM]) });
    expect(folder.notes).toContain('2 documents are withheld from the agent by a rule and not checked.');
  });

  it('counts, under `changed`, only the withheld documents the scope would have read', () => {
    const state = makeState();
    const file = emptyCoherenceFile();
    // The Storm is withheld and unchanged since its review; The Landing is withheld and changed; The Friend is not withheld and unchanged.
    for (const id of [STORM, FRIEND]) file.reviewState[id] = { lastReviewedRevision: getRevision(state, id), lastReviewedAt: options.now.toISOString() };
    state.coherence = file;
    const both: CheckOptions = { ...options, withheld: new Set([STORM, LANDING]) };
    const spec: CheckSpec = { kind: 'status.all', scope: { mode: 'changed' }, status: 'final' };
    expect(evaluateCheck(spec, state, both).notes).toContain('1 document is withheld from the agent by a rule and not checked.');
    // With only the unchanged one withheld there is nothing to say.
    const quiet = evaluateCheck(spec, state, { ...options, withheld: new Set([STORM]) });
    expect(quiet.notes.some((note) => note.includes('withheld'))).toBe(false);
    // The coherence note reuses the count.
    // (The Friend is made a changed document the scan can read, so the coherence check runs.)
    setBody(state, FRIEND, 'The friend waited.');
    const clean: CheckSpec = { kind: 'coherence.clean', scope: { mode: 'changed' }, checks: ['codex.never-mentioned'] };
    expect(evaluateCheck(clean, state, both).notes).toContain('1 document is withheld from the agent by a rule and not checked.');
    expect(evaluateCheck(clean, state, { ...options, withheld: new Set([STORM]) }).notes.some((note) => note.includes('withheld'))).toBe(false);
  });

  it('does not count a withheld archived document, which no goal scope would have read', () => {
    const state = makeState();
    const storm = state.manifest.tree.find((node) => node.id === STORM);
    if (storm !== undefined) storm.status = 'archived';
    const result = evaluateCheck({ kind: 'status.all', scope: FULL, status: 'draft' }, state, withheld);
    expect(result.notes.some((note) => note.includes('withheld'))).toBe(false);
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

/* ------------------------------------------------------------------ *
 * Run-context checks: each one passes and fails on a hand-built turn.
 * ------------------------------------------------------------------ */

describe('run-context checks', () => {
  const report = (extra: Partial<TurnReport> = {}): TurnReport => ({ modelCalls: 2, steps: [], ...extra }) as unknown as TurnReport;

  /** A turn that set `doc`'s body to `body`, with the output read the way the golden runner reads it. */
  function turn(doc: string, body: string, options: { requests?: ChatRequest[]; report?: TurnReport } = {}): CheckContext {
    const before = makeState();
    const after = makeState();
    setBody(after, doc, body);
    const turnReport = options.report ?? report();
    return { before, after, report: turnReport, requests: options.requests ?? [], outputs: producedOutputs(before, after, turnReport) };
  }

  const request = (...texts: string[]): ChatRequest => ({ messages: texts.map((content) => ({ role: 'user' as const, content })) });
  const run = (check: Check, context: CheckContext) => check.run(context);

  describe('wordCountWithin', () => {
    const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');
    it('passes inside the tolerance and fails outside it', () => {
      expect(run(checks.wordCountWithin(FRIEND, 100, 0.25), turn(FRIEND, words(80))).pass).toBe(true);
      expect(run(checks.wordCountWithin(FRIEND, 100, 0.25), turn(FRIEND, words(125))).pass).toBe(true);
      expect(run(checks.wordCountWithin(FRIEND, 100, 0.25), turn(FRIEND, words(60))).pass).toBe(false);
      expect(run(checks.wordCountWithin(FRIEND, 100, 0.25), turn(FRIEND, words(130))).detail).toContain('130 words');
    });
    it('fails when nothing was written into the document', () => {
      const context = { ...turn(FRIEND, ''), outputs: [] };
      expect(run(checks.wordCountWithin(FRIEND, 100, 0.25), context).pass).toBe(false);
    });
  });

  describe('prefixUnchanged', () => {
    it('passes for an append and fails for a rewrite of the start', () => {
      expect(run(checks.prefixUnchanged(LANDING), turn(LANDING, `${LANDING_BODY}\n\nThen the bell rang.`)).pass).toBe(true);
      const changed = run(checks.prefixUnchanged(LANDING), turn(LANDING, 'The boat was late, as always.'));
      expect(changed.pass).toBe(false);
      expect(changed.detail).toContain(`${LANDING_BODY.length} earlier characters`);
    });
    it('names a document that does not exist', () => {
      expect(run(checks.prefixUnchanged('Nowhere'), turn(LANDING, 'x')).detail).toContain('"Nowhere" is not a document');
    });
  });

  describe('outsideAnchorUnchanged', () => {
    const anchor = { from: 4, to: 9 }; // "ferry" of "The ferry was late, as always."
    it('passes when only the anchored span changed', () => {
      expect(run(checks.outsideAnchorUnchanged(LANDING, anchor), turn(LANDING, 'The boat was late, as always.')).pass).toBe(true);
    });
    it('fails when text before or after the anchor changed, and when nothing changed', () => {
      expect(run(checks.outsideAnchorUnchanged(LANDING, anchor), turn(LANDING, 'A ferry was late, as always.')).detail).toContain('before the anchor');
      expect(run(checks.outsideAnchorUnchanged(LANDING, anchor), turn(LANDING, 'The boat was late, as ever.')).detail).toContain('after the anchor');
      expect(run(checks.outsideAnchorUnchanged(LANDING, anchor), turn(LANDING, LANDING_BODY)).detail).toContain('nothing inside the anchor');
    });
  });

  describe('noPreamble', () => {
    it('passes for the writing alone', () => {
      expect(run(checks.noPreamble(FRIEND), turn(FRIEND, 'He waited by the gate.')).pass).toBe(true);
    });
    it.each([
      ['an opening remark', "Here's the scene you asked for.\n\nHe waited."],
      ['a Markdown heading', 'He waited.\n\n# The gate\n\nHe left.'],
      ['a chapter title', 'Chapter 3\n\nHe waited.'],
      ['a code fence', '```\nHe waited.\n```'],
    ])('fails for %s', (_, text) => {
      expect(run(checks.noPreamble(FRIEND), turn(FRIEND, text)).pass).toBe(false);
    });
  });

  describe('mentionsAll', () => {
    it('passes when every name appears, in any case, and names the ones that do not', () => {
      expect(run(checks.mentionsAll(FRIEND, ['Hale', 'Elena']), turn(FRIEND, 'ELENA met captain hale.')).pass).toBe(true);
      const failed = run(checks.mentionsAll(FRIEND, ['Hale', 'Mara']), turn(FRIEND, 'Hale waited.'));
      expect(failed).toMatchObject({ pass: false, detail: '"Mara" missing' });
      expect(run(checks.mentionsAll(FRIEND, ['Hale']), { ...turn(FRIEND, 'x'), outputs: [] }).pass).toBe(false);
    });
  });

  describe('absentEverywhere', () => {
    it('passes when no name is in the text or the requests', () => {
      expect(run(checks.absentEverywhere(['Ferryman']), turn(FRIEND, 'They talk in the rain.', { requests: [request('Write a scene about Elena.')] })).pass).toBe(true);
    });
    it('fails for a name in the written text, in any case', () => {
      const failed = run(checks.absentEverywhere(['Ferryman']), turn(FRIEND, 'The FERRYMAN waited.'));
      expect(failed.pass).toBe(false);
      expect(failed.detail).toContain('the text written');
    });
    it('fails for a name in a request, in a message or in a tool declaration, unless requests are left out of where', () => {
      const inMessage = turn(FRIEND, 'Rain.', { requests: [request('the ferryman keeps a secret')] });
      expect(run(checks.absentEverywhere(['Ferryman']), inMessage).detail).toContain('a model request');
      const inTool = turn(FRIEND, 'Rain.', { requests: [{ messages: [], tools: [{ name: 'x', description: 'about the Ferryman', parameters: {} }] } as unknown as ChatRequest] });
      expect(run(checks.absentEverywhere(['Ferryman']), inTool).pass).toBe(false);
      expect(run(checks.absentEverywhere(['Ferryman'], ['outputs']), inMessage).pass).toBe(true);
    });
  });

  describe('parsesAsFountain', () => {
    const SCENE = 'INT. LAMP ROOM - NIGHT\n\nThe lamp gutters.\n\nELENA\nIt is going out.\n\nKESTREL\n(quietly)\nThen we row.';
    it('passes for a scene with cues, and honours the heading rule', () => {
      expect(run(checks.parsesAsFountain(FRIEND, { heading: 'required', minCues: 2 }), turn(FRIEND, SCENE)).pass).toBe(true);
      expect(run(checks.parsesAsFountain(FRIEND, { heading: 'forbidden' }), turn(FRIEND, SCENE)).detail).toContain('scene heading');
      expect(run(checks.parsesAsFountain(FRIEND, { heading: 'required' }), turn(FRIEND, 'ELENA\nIt is going out.')).detail).toContain('no scene heading');
    });
    it('fails for prose with no cue', () => {
      const failed = run(checks.parsesAsFountain(FRIEND), turn(FRIEND, 'The lamp gutters. Nobody speaks.'));
      expect(failed.pass).toBe(false);
      expect(failed.detail).toContain('0 character cues');
    });
  });

  describe('compilesAsInk', () => {
    it('passes for Ink that compiles with enough choices', () => {
      const ink = 'The ferryman waits.\n* [Ask his name] "Who are you?" -> done\n* [Say nothing] -> done\n=== done ===\n-> END';
      expect(run(checks.compilesAsInk(FRIEND, { minChoices: 2 }), turn(FRIEND, ink)).pass).toBe(true);
    });
    it('fails for Ink that does not compile, too few choices and a code fence', () => {
      expect(run(checks.compilesAsInk(FRIEND), turn(FRIEND, '* [Ask] -> nowhere')).detail).toContain('does not compile');
      expect(run(checks.compilesAsInk(FRIEND, { minChoices: 2 }), turn(FRIEND, 'Hello.\n-> END')).pass).toBe(false);
      expect(run(checks.compilesAsInk(FRIEND), turn(FRIEND, '```ink\nHello.\n-> END\n```')).detail).toContain('code fence');
    });
  });

  describe('findsContradiction', () => {
    const scan = (findings: unknown[]): TurnReport => report({ steps: [{ index: 0, tool: 'continuity.scan', expect: '', status: 'done', data: { findings } }] as unknown as TurnReport['steps'] });
    const planted = { aspect: 'characters', severity: 'major', docs: ['The Landing', 'The Storm'], quote: 'grey eyes', note: 'Her eyes are green elsewhere.' };
    it('passes for a finding that names both documents and quotes the span', () => {
      expect(run(checks.findsContradiction([LANDING, STORM], 'grey eyes', 3), turn(FRIEND, 'x', { report: scan([planted]) })).pass).toBe(true);
    });
    it('fails for a finding about other documents or another span, and for too many findings', () => {
      expect(run(checks.findsContradiction([LANDING, STORM], 'grey eyes', 3), turn(FRIEND, 'x', { report: scan([{ ...planted, docs: ['The Landing'] }]) })).pass).toBe(false);
      expect(run(checks.findsContradiction([LANDING, STORM], 'grey eyes', 3), turn(FRIEND, 'x', { report: scan([{ ...planted, quote: 'the lamp' }]) })).pass).toBe(false);
      const noisy = run(checks.findsContradiction([LANDING, STORM], 'grey eyes', 1), turn(FRIEND, 'x', { report: scan([planted, planted]) }));
      expect(noisy.pass).toBe(false);
      expect(noisy.detail).toContain('2 findings, at most 1');
    });
    it('fails when the turn ran no scan', () => {
      expect(run(checks.findsContradiction([LANDING, STORM], 'grey eyes', 3), turn(FRIEND, 'x')).pass).toBe(false);
    });
  });

  describe('treeEquals', () => {
    const base: TreeRow[] = [
      { parent: 'Manuscript', title: 'Chapter 1' },
      { parent: 'Chapter 1', title: 'The Landing' },
      { parent: 'Chapter 1', title: 'The Storm' },
      { parent: 'Manuscript', title: 'Chapter 2' },
      { parent: 'Chapter 2', title: 'The Friend' },
    ];
    it('passes for the binder as listed, ordered or not', () => {
      const context = turn(FRIEND, 'x');
      expect(run(checks.treeEquals(base), context).pass).toBe(true);
      expect(run(checks.treeEquals([...base].reverse(), { ordered: false }), context).pass).toBe(true);
    });
    it('fails for a different order when ordered, and for a different parent', () => {
      const context = turn(FRIEND, 'x');
      expect(run(checks.treeEquals([...base].reverse()), context).pass).toBe(false);
      const moved = base.map((row) => (row.title === 'The Friend' ? { ...row, parent: 'Chapter 1' } : row));
      expect(run(checks.treeEquals(moved), context).detail).toContain('expected [');
    });
  });

  describe('projectUnchanged', () => {
    it('passes for a turn that wrote nothing and fails for a changed body or manifest', () => {
      const idle = { ...turn(FRIEND, ''), after: makeState() };
      expect(run(checks.projectUnchanged(), idle).pass).toBe(true);
      expect(run(checks.projectUnchanged(), turn(FRIEND, 'Written.')).pass).toBe(false);
      const reworded = { ...idle, after: makeState() };
      setBody(reworded.after, FRIEND, 'Written.');
      reworded.before.manifest = structuredClone(reworded.after.manifest);
      expect(run(checks.projectUnchanged(), reworded).detail).toBe('1 bodies changed');
      const relabelled = makeState();
      const node = relabelled.manifest.tree.find((candidate) => candidate.id === FRIEND);
      if (node !== undefined) node.label = 'act-2';
      expect(run(checks.projectUnchanged(), { ...idle, after: relabelled }).detail).toBe('the manifest changed: tree');
    });
  });

  describe('labelsMatch', () => {
    const labelled = (labels: Record<string, string>): CheckContext => {
      const context = turn(FRIEND, '');
      for (const node of context.after.manifest.tree) if (labels[node.title] !== undefined) node.label = labels[node.title] as string;
      return context;
    };
    const truth = { 'The Landing': 'act-1', 'The Storm': 'act-1', 'The Friend': 'act-2' };
    it('passes when enough documents carry the expected label', () => {
      expect(run(checks.labelsMatch(truth), labelled({ 'The Landing': 'act-1', 'The Storm': 'act-1', 'The Friend': 'act-2' })).pass).toBe(true);
      expect(run(checks.labelsMatch(truth, 0.6), labelled({ 'The Landing': 'act-1', 'The Storm': 'act-1', 'The Friend': 'act-1' })).pass).toBe(true);
    });
    it('fails below the share and names the documents that are wrong', () => {
      const failed = run(checks.labelsMatch(truth), labelled({ 'The Landing': 'act-1', 'The Storm': 'act-2', 'The Friend': 'act-2' }));
      expect(failed.pass).toBe(false);
      expect(failed.detail).toContain('The Storm should be act-1');
    });
  });

  describe('synopsesGrounded', () => {
    const synopsised = (synopses: Record<string, string>): CheckContext => {
      const context = turn(FRIEND, '');
      for (const node of context.after.manifest.tree) if (synopses[node.title] !== undefined) node.synopsis = synopses[node.title] as string;
      return context;
    };
    it('passes for short synopses that name what their own text names', () => {
      const context = synopsised({ 'The Landing': 'Elena waits for the ferry.', 'The Storm': 'The lamp fails in the rain.' });
      expect(run(checks.synopsesGrounded([LANDING, STORM], 20), context).pass).toBe(false); // The Storm names no capitalised word beyond its first
      const named = synopsised({ 'The Landing': 'The ferry arrives late at The Landing.', 'The Storm': 'Rain takes the lamp. The Storm ends.' });
      expect(run(checks.synopsesGrounded([LANDING, STORM], 20), named).pass).toBe(true);
    });
    it('fails for a missing synopsis, one over the limit and a name its text does not hold', () => {
      expect(run(checks.synopsesGrounded([FRIEND], 20), turn(FRIEND, '')).detail).toContain('"The Friend" has no synopsis');
      const long = synopsised({ 'The Landing': 'The ferry arrives late at The Landing and nobody meets Elena there at all.' });
      expect(run(checks.synopsesGrounded([LANDING], 5), long).detail).toContain('over 5');
      const stranger = synopsised({ 'The Landing': 'The ferry brings Kestrel to The Landing.' });
      expect(run(checks.synopsesGrounded([LANDING], 20), stranger).detail).toContain('names Kestrel, which its text does not');
    });
  });

  describe('modelCallsAtMost', () => {
    it('passes at the bound and fails above it', () => {
      expect(run(checks.modelCallsAtMost(2), turn(FRIEND, 'x', { report: report({ modelCalls: 2 }) })).pass).toBe(true);
      expect(run(checks.modelCallsAtMost(2), turn(FRIEND, 'x', { report: report({ modelCalls: 3 }) })).detail).toBe('3 model calls, at most 2 wanted');
    });
  });

  describe('producedOutputs', () => {
    it('reads a scene.draft from the range its step names, so a rewrite is the whole replacement', () => {
      const before = makeState();
      const after = makeState();
      setBody(after, LANDING, 'The boat was late, as always.');
      const steps = [{ index: 0, tool: 'scene.draft', expect: '', status: 'done', data: { doc: { title: 'The Landing' }, range: { from: 4, to: 9 } } }] as unknown as TurnReport['steps'];
      expect(producedOutputs(before, after, report({ steps }))).toEqual([{ docTitle: 'The Landing', text: 'boat' }]);
    });
    it('reads any other write as what lies between the shared start and end', () => {
      const before = makeState();
      const after = makeState();
      setBody(after, STORM, 'Rain.\n\n***\n\nThe lamp failed.\n\nThen the bell.');
      expect(producedOutputs(before, after, report())).toEqual([{ docTitle: 'The Storm', text: 'Then the bell.' }]);
    });
    it('lists nothing for a document the turn left alone', () => {
      expect(producedOutputs(makeState(), makeState(), report())).toEqual([]);
    });
  });
});
