import { describe, expect, it } from 'vitest';

import {
  ScopeError,
  applySceneMetaPatch,
  effectiveMode,
  emptyCoherenceFile,
  headEvidence,
  parseCoherenceFile,
  resolveScope,
  serializeCoherenceFile,
  snapshotManuscript,
  type CoherenceFile,
} from '../src/index.js';

import { NOW, buildState, entry } from './fixtures.js';

function manuscript(): ReturnType<typeof buildState> {
  return buildState({
    folders: [{ id: 'act1', title: 'Act One' }],
    scenes: [
      { id: 'sA', title: 'Opening', parent: 'act1', body: 'Elena returned to the island.' },
      { id: 'sB', title: 'Middle', parent: 'act1', body: 'Lena waited.' },
      { id: 'sC', title: 'Coda', body: 'Gulls.' },
      { id: 'sEmpty', title: 'Blank', body: '   ' },
      { id: 'sArch', title: 'Old', body: 'Archived text.', status: 'archived' },
    ],
    research: [{ id: 'rR', title: 'Notes', body: 'Research notes.' }],
  });
}

describe('snapshotManuscript', () => {
  it('walks the binder depth-first in order, and scans only manuscript documents with text', () => {
    const snapshot = snapshotManuscript(manuscript(), emptyCoherenceFile());
    expect(snapshot.scanned.map((scene) => scene.docId)).toEqual(['sA', 'sB', 'sC']);
    expect(snapshot.scanned.map((scene) => scene.binderIndex)).toEqual([1, 2, 3]);
    expect(snapshot.scanned[0]?.ancestorIds).toEqual(['manuscript', 'act1']);
    expect(snapshot.emptyDocIds).toEqual(['sEmpty']);
  });

  it('never scans an archived document, and never scans research unless it is named', () => {
    const plain = snapshotManuscript(manuscript(), emptyCoherenceFile());
    expect(plain.excludedDocIds).toEqual(['sArch']);
    expect(plain.scanned.some((scene) => scene.docId === 'rR')).toBe(false);

    const named = snapshotManuscript(manuscript(), emptyCoherenceFile(), { includeDocIds: new Set(['rR']) });
    expect(named.scanned.map((scene) => scene.docId)).toEqual(['sA', 'sB', 'sC', 'rR']);
  });

  it('lists the manuscript folders, and not the research ones', () => {
    const snapshot = snapshotManuscript(manuscript(), emptyCoherenceFile());
    const ids = snapshot.folders.map((folder) => folder.id);
    expect(ids).toContain('act1');
    expect(ids).toContain('manuscript');
    expect(ids).not.toContain('research');
  });

  it('carries each node its declarations, and leaves the file untouched', () => {
    const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { sA: { dayOffset: 4, durationDays: 2 } } };
    const snapshot = snapshotManuscript(manuscript(), file);
    expect(snapshot.scanned[0]?.meta).toEqual({ dayOffset: 4, durationDays: 2 });
    expect(snapshot.scanned[1]?.meta).toEqual({});
  });
});

describe('resolveScope', () => {
  it('full reads every scanned document; changed reads only the ones edited since review', () => {
    const state = manuscript();
    const snapshot = snapshotManuscript(state, emptyCoherenceFile());
    expect(resolveScope(snapshot, emptyCoherenceFile(), { mode: 'full' }).map((s) => s.docId)).toEqual(['sA', 'sB', 'sC']);

    const reviewed: CoherenceFile = {
      ...emptyCoherenceFile(),
      reviewState: { sA: { lastReviewedRevision: 0, lastReviewedAt: NOW.toISOString() } },
    };
    expect(resolveScope(snapshot, reviewed, { mode: 'changed' }).map((s) => s.docId)).toEqual(['sB', 'sC']);
  });

  it('refuses a document scope that names more than one document, or a document it cannot read', () => {
    const snapshot = snapshotManuscript(manuscript(), emptyCoherenceFile());
    const file = emptyCoherenceFile();
    expect(() => resolveScope(snapshot, file, { mode: 'doc', docIds: ['sA', 'sB'] })).toThrow(ScopeError);
    expect(() => resolveScope(snapshot, file, { mode: 'doc', docIds: ['sEmpty'] })).toThrow(/is empty/);
    expect(() => resolveScope(snapshot, file, { mode: 'doc', docIds: ['sArch'] })).toThrow(/excluded from checks/);
    expect(() => resolveScope(snapshot, file, { mode: 'doc', docIds: ['rR'] })).toThrow(/Research documents must be named explicitly/);
  });

  it('reads a named research document when the snapshot was told to include it', () => {
    const state = manuscript();
    const snapshot = snapshotManuscript(state, emptyCoherenceFile(), { includeDocIds: new Set(['rR']) });
    expect(resolveScope(snapshot, emptyCoherenceFile(), { mode: 'doc', docIds: ['rR'] }).map((s) => s.docId)).toEqual(['rR']);
  });
});

describe('headEvidence', () => {
  it('quotes the whole opening verbatim with body offsets, capped at 300 characters', () => {
    const snapshot = snapshotManuscript(manuscript(), emptyCoherenceFile());
    const scene = snapshot.scanned[0];
    expect(scene).toBeDefined();
    if (scene === undefined) return;
    expect(headEvidence(scene)).toEqual({ docId: 'sA', quote: 'Elena returned to the island.', from: 0, to: 29 });
    const long = { ...scene, body: 'x'.repeat(400) };
    const evidence = headEvidence(long);
    expect(evidence.quote).toHaveLength(300);
    expect(evidence.to).toBe(300);
  });
});

describe('applySceneMetaPatch (§5.2 and §7.1)', () => {
  const context = { entries: [entry('c_5H8QK2M9RT', 'Elena')], documentIds: new Set(['sA', 'sB']) };

  it('refuses an unknown POV and names the codex entries that would be accepted', () => {
    const result = applySceneMetaPatch('sA', undefined, { pov: 'Zed' }, context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"Zed" is not a codex entry');
    expect(result.error).toContain('Elena (c_5H8QK2M9RT)');
  });

  it('sets a POV from a codex id, and clears it with null', () => {
    const set = applySceneMetaPatch('sA', undefined, { pov: 'c_5H8QK2M9RT' }, context);
    expect(set).toEqual({ ok: true, meta: { pov: 'c_5H8QK2M9RT' } });
    const cleared = applySceneMetaPatch('sA', { pov: 'c_5H8QK2M9RT', dayOffset: 2 }, { pov: null }, context);
    expect(cleared).toEqual({ ok: true, meta: { dayOffset: 2 } });
  });

  it('keeps day offsets as whole numbers (negative allowed, §5.2.2) and durations as whole numbers of zero or more', () => {
    expect(applySceneMetaPatch('sA', undefined, { dayOffset: -1 }, context)).toEqual({ ok: true, meta: { dayOffset: -1 } });
    expect(applySceneMetaPatch('sA', undefined, { dayOffset: 2.5 }, context).ok).toBe(false);
    expect(applySceneMetaPatch('sA', undefined, { durationDays: -1 }, context).ok).toBe(false);
    expect(applySceneMetaPatch('sA', undefined, { dayOffset: 0, durationDays: 3 }, context)).toEqual({
      ok: true,
      meta: { dayOffset: 0, durationDays: 3 },
    });
    const cleared = applySceneMetaPatch('sA', { durationDays: 3 }, { durationDays: null }, context);
    expect(cleared).toEqual({ ok: true, meta: {} });
  });

  it('will not let a scene follow itself, or follow a document the project does not have', () => {
    expect(applySceneMetaPatch('sA', undefined, { after_add: ['sA'] }, context).ok).toBe(false);
    const unknown = applySceneMetaPatch('sA', undefined, { after_add: ['sZ'] }, context);
    expect(unknown.ok === false && unknown.error).toContain('after names "sZ", which is not a document in this project');
  });

  it('adds dependencies without duplicates, and removes the key when none are left', () => {
    const added = applySceneMetaPatch('sA', undefined, { after_add: ['sB', 'sB'] }, context);
    expect(added).toEqual({ ok: true, meta: { after: ['sB'] } });
    const removed = applySceneMetaPatch('sA', { after: ['sB'] }, { after_remove: ['sB'] }, context);
    expect(removed).toEqual({ ok: true, meta: {} });
  });

  it('validates expected presence against the codex', () => {
    const bad = applySceneMetaPatch('sA', undefined, { expectedPresent_add: ['c_NOPE'] }, context);
    expect(bad.ok === false && bad.error).toContain('not a codex entry');
  });

  it('validates the timeline mode, and stores linear as absence', () => {
    const bad = applySceneMetaPatch('sA', undefined, { timelineMode: 'montage' }, context);
    expect(bad.ok === false && bad.error).toContain('valid modes are linear, flashback');
    expect(applySceneMetaPatch('sA', { timelineMode: 'dream' }, { timelineMode: 'linear' }, context)).toEqual({ ok: true, meta: {} });
    expect(applySceneMetaPatch('sA', undefined, { timelineMode: 'circular' }, context)).toEqual({
      ok: true,
      meta: { timelineMode: 'circular' },
    });
  });

  it('declares and removes a thread through the shared rule, and the file codec keeps it', () => {
    const declared = applySceneMetaPatch('sA', undefined, { threads_add: [{ id: 'the lamp', payoff: 'sB', note: 'lit again' }] }, context);
    expect(declared).toEqual({ ok: true, meta: { threads: [{ id: 'the lamp', payoff: 'sB', note: 'lit again' }] } });
    if (!declared.ok) return;
    const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { sA: { threads: declared.meta.threads ?? [] } } };
    const loaded = parseCoherenceFile(serializeCoherenceFile(file));
    expect(loaded.kind === 'ok' && loaded.file).toEqual(file);
    const removed = applySceneMetaPatch('sA', declared.meta, { threads_remove: ['the lamp'] }, context);
    expect(removed).toEqual({ ok: true, meta: {} });
  });

  it('refuses a patch field it does not know', () => {
    const result = applySceneMetaPatch('sA', undefined, { mood: 'bleak' } as Record<string, unknown>, context);
    expect(result.ok === false && result.error).toContain('unknown patch field "mood"');
  });

  it('reads an absent mode as linear', () => {
    expect(effectiveMode(undefined)).toBe('linear');
    expect(effectiveMode({})).toBe('linear');
    expect(effectiveMode({ timelineMode: 'dream' })).toBe('dream');
  });
});
