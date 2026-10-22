import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  COHERENCE_TOOL_ENTRIES,
  COHERENCE_TOOL_NAMES,
  DETERMINISTIC_CHECK_IDS,
  DISMISSAL_REASONS,
  MODE_CROSS_LINK_COPY,
  checkCrossLinkFor,
  emptyCoherenceFile,
  executeReviewTool,
  groupFindings,
  previewReviewTool,
  resolveMentions,
  scanTool,
  setFindingStatusTool,
  tooltipFor,
  validateDismissal,
  type CoherenceFile,
  type CoherenceToolContext,
  type Finding,
  type MentionCacheSource,
} from '../src/index.js';

import { NOW, buildState, detect, entry } from './fixtures.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SPEC = join(REPO_ROOT, 'docs', 'architecture', 'coherence.md');

function context(state: ReturnType<typeof buildState>, file: CoherenceFile = emptyCoherenceFile(), extra: Partial<CoherenceToolContext> = {}): CoherenceToolContext {
  return { state, file, now: NOW, detector: detect, ...extra };
}

function project(count: number): ReturnType<typeof buildState> {
  return buildState({
    scenes: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `Scene ${i}`, body: `Elena is in scene ${i}.` })),
    entries: [entry('c_5H8QK2M9RT', 'Elena')],
  });
}

describe('dismissal picker (§6.3, as data)', () => {
  it('offers the five reasons in the spec order, two of them techniques', () => {
    expect(DISMISSAL_REASONS.map((r) => r.id)).toEqual(['flashback', 'in-world-lie', 'unreliable-narrator', 'intentional', 'false-positive']);
    expect(DISMISSAL_REASONS.filter((r) => r.kind === 'technique').map((r) => r.id)).toEqual([
      'flashback',
      'in-world-lie',
      'unreliable-narrator',
    ]);
  });

  it('gives a tooltip to the two deception reasons only, with the spec wording', () => {
    expect(tooltipFor('in-world-lie')).toBe('In-story deception between characters.');
    expect(tooltipFor('unreliable-narrator')).toBe('Narration-level deception.');
    expect(tooltipFor('flashback')).toBeUndefined();
    expect(tooltipFor('intentional')).toBeUndefined();
  });

  it('cross-links the technique reasons to the mode picker, and never the judgments', () => {
    for (const reason of DISMISSAL_REASONS) {
      expect(reason.modeCrossLink).toBe(reason.kind === 'technique');
    }
    expect(MODE_CROSS_LINK_COPY).toBe('Declare this as a scene mode instead.');
  });

  it('gives a timeline.gap finding a line about declaring a time skip, and no other check one', () => {
    expect(checkCrossLinkFor('timeline.gap')).toBe('Declare a time skip on one of these scenes instead.');
    for (const id of DETERMINISTIC_CHECK_IDS.filter((candidate) => candidate !== 'timeline.gap')) {
      expect(checkCrossLinkFor(id), id).toBeUndefined();
    }
  });

  it('maps flashback to its timeline mode, and no other reason to one', () => {
    expect(DISMISSAL_REASONS.find((r) => r.id === 'flashback')).toMatchObject({ declaresMode: 'flashback' });
    expect(DISMISSAL_REASONS.find((r) => r.id === 'in-world-lie')).not.toHaveProperty('declaresMode');
  });

  it('accepts a picker reason and refuses a free-text one, and caps the note', () => {
    expect(validateDismissal('in-world-lie', undefined)).toEqual({ ok: true });
    const refused = validateDismissal('deep pov', undefined);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('valid reasons are flashback, in-world-lie');
    const long = validateDismissal('intentional', 'x'.repeat(501));
    expect(long.ok).toBe(false);
  });
});

describe('groupFindings', () => {
  const finding = (id: string, checkId: string, factGroup: string, severity: Finding['severity'], docId: string): Finding => ({
    id,
    runId: 'r_AAAAAAAAAA',
    class: 'deterministic',
    checkId,
    type: 'x',
    severity,
    status: 'open',
    factGroup,
    message: 'm',
    evidence: [{ docId, quote: 'q', from: 0, to: 1 }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });

  it('groups by check and fact, orders the most severe group first, and lists its documents', () => {
    const groups = groupFindings([
      finding('f_AAAAAAAAAA', 'codex.never-mentioned', 'c_x|never', 'info', 'sA'),
      finding('f_BBBBBBBBBB', 'presence.expected', 'c_y|expected', 'error', 'sB'),
      finding('f_CCCCCCCCCC', 'presence.expected', 'c_y|expected', 'error', 'sC'),
    ]);
    expect(groups.map((g) => [g.checkId, g.count, g.severity])).toEqual([
      ['presence.expected', 2, 'error'],
      ['codex.never-mentioned', 1, 'info'],
    ]);
    expect(groups[0]?.docIds).toEqual(['sB', 'sC']);
  });
});

describe('resolveMentions (codex.md §4 invalidation)', () => {
  const scenes = [{ docId: 'sA', body: 'Elena is here.', revision: 2 }];
  const codex = [entry('c_5H8QK2M9RT', 'Elena', { updatedAt: '2026-10-01T09:00:00.000Z' })];
  const codexRevision = Date.parse('2026-10-01T09:00:00.000Z');

  it('uses a cache whose document and codex revisions both match, without detecting', () => {
    const hits = new Map([['c_5H8QK2M9RT', 1]]);
    const source: MentionCacheSource = () => ({ docRevision: 2, codexRevision, hits });
    const spy = vi.fn(detect);
    const out = resolveMentions(scenes, codex, source, spy);
    expect(out.hits.get('sA')).toBe(hits);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rebuilds a cache whose document revision is stale', () => {
    const source: MentionCacheSource = () => ({ docRevision: 1, codexRevision, hits: new Map() });
    const out = resolveMentions(scenes, codex, source, detect);
    expect(out.rebuilt).toEqual(['sA']);
    expect(out.hits.get('sA')?.get('c_5H8QK2M9RT')).toBe(1);
  });

  it('rebuilds a cache whose codex revision is stale, as the spec requires', () => {
    const source: MentionCacheSource = () => ({ docRevision: 2, codexRevision: codexRevision - 1, hits: new Map() });
    expect(resolveMentions(scenes, codex, source, detect).rebuilt).toEqual(['sA']);
  });

  it('reports a document as unavailable when there is neither a current cache nor a detector', () => {
    const out = resolveMentions(scenes, codex, undefined, undefined);
    expect(out.unavailable).toEqual(['sA']);
    expect(out.hits.has('sA')).toBe(false);
  });
});

describe('the coherence tools (§7)', () => {
  function specRows(): Map<string, { risk: string; undoable: boolean }> {
    const rows = new Map<string, { risk: string; undoable: boolean }>();
    for (const line of readFileSync(SPEC, 'utf8').split('\n')) {
      if (!/^\| 1[567] \|/.test(line)) continue;
      // Pipes inside a cell are escaped as `\|`, so only unescaped pipes separate columns.
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
      const name = (cells[1] ?? '').replace(/`/g, '');
      const risk = (cells[2] ?? '').split(/[\s(]/)[0] ?? '';
      const undo = cells[5] ?? '';
      rows.set(name, { risk, undoable: !(undo.startsWith('—') || undo.startsWith('n/a')) });
    }
    return rows;
  }

  it('declares the three tools the spec names, with the spec risk and undo column', () => {
    expect([...COHERENCE_TOOL_NAMES]).toEqual(['coherence.scan', 'coherence.review', 'coherence.setFindingStatus']);
    const rows = specRows();
    expect(rows.size).toBe(3);
    for (const entryDef of COHERENCE_TOOL_ENTRIES) {
      const row = rows.get(entryDef.meta.name);
      expect(row, entryDef.meta.name).toBeDefined();
      expect(entryDef.meta.risk).toBe(row?.risk);
      expect(entryDef.meta.undoable).toBe(row?.undoable);
      expect(entryDef.kind).toBe('port');
      expect(entryDef.meta.surface).toBe('extension');
    }
  });

  it('exposes only fixed to the agent, and carries the dismissal value so the refusal can be worded', () => {
    const status = COHERENCE_TOOL_ENTRIES.find((e) => e.meta.name === 'coherence.setFindingStatus')?.params.properties['status'];
    expect(status).toMatchObject({ kind: 'enum', values: ['fixed', 'dismissed'] });
  });

  it('checks the cross-field scope rule for review, and leaves an optional scan scope alone', () => {
    const review = COHERENCE_TOOL_ENTRIES.find((e) => e.meta.name === 'coherence.review');
    const scan = COHERENCE_TOOL_ENTRIES.find((e) => e.meta.name === 'coherence.scan');
    expect(review?.refine?.({ scope: { mode: 'doc' } })).toContain('names exactly one document');
    expect(review?.refine?.({ scope: { mode: 'full', docIds: ['sA'] } })).toContain('takes no docIds');
    expect(review?.refine?.({ scope: { mode: 'doc', docIds: ['sA'] } })).toBeUndefined();
    expect(scan?.refine?.({})).toBeUndefined();
  });

  it('scans the whole manuscript by default and returns the file and a grouped summary', () => {
    const state = project(2);
    const result = scanTool({}, context(state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toBeDefined();
    expect(result.summary).toMatch(/^Scan /);
    expect(typeof result.data.runId).toBe('string');
  });

  it('refuses a document scope with no document, or more than one', () => {
    const state = project(2);
    expect(scanTool({ scope: { mode: 'doc' } }, context(state))).toMatchObject({ ok: false, code: 'scope-invalid' });
    expect(scanTool({ scope: { mode: 'doc', docIds: ['s0', 's1'] } }, context(state))).toMatchObject({ ok: false, code: 'scope-invalid' });
  });

  it('asks for confirmation over the twenty-document guard, and runs once confirmed', () => {
    const state = project(21);
    const asked = scanTool({}, context(state));
    expect(asked).toMatchObject({ ok: false, code: 'confirmation-required' });
    const confirmed = scanTool({}, context(state, emptyCoherenceFile(), { approvedLargeScope: true }));
    expect(confirmed.ok).toBe(true);
  });

  it('refuses a review plan when there is no provider, and names the settings to fix it', () => {
    const result = previewReviewTool({ scope: { mode: 'full' } }, context(project(1)));
    expect(result).toMatchObject({ ok: false, code: 'no-provider' });
    if (!result.ok) expect(result.message).toContain('settings');
  });

  it('plans a review without running it, and refuses to run one that is not approved', async () => {
    const state = project(1);
    const model = { model: 'fake-1', complete: vi.fn(async () => ({ content: '{"spans": []}' })) };
    const plan = previewReviewTool({ scope: { mode: 'full' } }, context(state, emptyCoherenceFile(), { model }));
    expect(plan.ok).toBe(true);
    expect(model.complete).not.toHaveBeenCalled();
    if (!plan.ok) return;
    const refused = await executeReviewTool(plan.data.plan, false, context(state, emptyCoherenceFile(), { model }));
    expect(refused).toMatchObject({ ok: false, code: 'not-approved' });
    expect(model.complete).not.toHaveBeenCalled();
  });

  it('asks for a review scope when none is given', () => {
    const result = previewReviewTool({}, context(project(1), emptyCoherenceFile(), { model: { model: 'm', complete: async () => ({ content: '' }) } }));
    expect(result).toMatchObject({ ok: false, code: 'scope-required' });
  });

  it('refuses a dismissal from the agent with the spec sentence, and an unknown finding with the way to find one', () => {
    const state = project(1);
    const dismissed = setFindingStatusTool({ findingId: 'f_AAAAAAAAAA', status: 'dismissed' }, context(state));
    expect(dismissed).toEqual({
      ok: false,
      code: 'dismissal-is-writer-judgment',
      message: 'dismissal is a writer judgment; propose it in your report',
    });
    const unknown = setFindingStatusTool({ findingId: 'f_AAAAAAAAAA', status: 'fixed' }, context(state));
    expect(unknown).toMatchObject({ ok: false, code: 'unknown-finding' });
  });

  it('refuses an unknown check id with a stable code, and lists every valid id', () => {
    const result = scanTool({ checks: ['timeline.nope'] }, context(project(2)));
    expect(result).toMatchObject({ ok: false, code: 'unknown-check' });
    if (result.ok) return;
    expect(result.message).toContain('timeline.nope');
    for (const id of DETERMINISTIC_CHECK_IDS) expect(result.message).toContain(id);
  });

  it('refuses an empty list of checks, rather than running nothing and reporting the run complete', () => {
    expect(scanTool({ checks: [] }, context(project(2)))).toMatchObject({ ok: false, code: 'checks-empty' });
  });

  it('runs exactly the checks it is named, and records them on the run', () => {
    const result = scanTool({ checks: ['timeline.relation'] }, context(project(2)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file?.runs.at(-1)?.checkIds).toEqual(['timeline.relation']);
  });

  it('refuses an agent note past the limit before it reads the finding, and names the count and the limit', () => {
    const refused = setFindingStatusTool({ findingId: 'f_AAAAAAAAAA', status: 'fixed', note: 'x'.repeat(501) }, context(project(1)));
    expect(refused).toMatchObject({ ok: false, code: 'note-too-long' });
    if (!refused.ok) expect(refused.message).toContain('501 characters; the limit is 500');
  });
});
