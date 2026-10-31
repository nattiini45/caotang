/**
 * Response caps — each answer fits its `response_token_cap` on the harness's own
 * estimate, and when it cannot, the answer says what was left out, or is refused
 * rather than returned over its cap.
 */

import { ok } from '@caotang/bus';
import { addFolder, countBody } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { capOf, fitsCap, type ToolPort } from '../src/index.js';
import { LANDING, OPENED, makeHarness, makeState, refusalOf, run, valueOf } from './fixtures.js';

const CONFIRMED = { permission: { confirmed: true } } as const;

describe('an injected read port, measured as a native read is', () => {
  it('refuses an answer over codex.read’s cap, rather than returning it as ok', () => {
    const codexRead: ToolPort = () => ok({ data: { text: 'x'.repeat(200_000) }, summary: 'read the codex', affected: [] });
    const error = refusalOf(run(makeHarness({ ports: { 'codex.read': codexRead } }), 'codex.read', { query: 'Elena' }));
    expect(error.code).toBe('limit-exceeded');
    expect(error.message).toContain('codex.read');
    expect(error.message).toContain(`over its ${capOf('codex.read')}-token cap`);
  });

  it('returns an injected read answer that fits its cap', () => {
    const codexRead: ToolPort = () => ok({ data: { entries: [{ name: 'Elena' }], total: 1, truncated: false }, summary: 'read the codex', affected: [] });
    expect(valueOf(run(makeHarness({ ports: { 'codex.read': codexRead } }), 'codex.read', { query: 'Elena' })).data).toEqual({ entries: [{ name: 'Elena' }], total: 1, truncated: false });
  });
});

describe('project.overview under a large binder', () => {
  it('fits its cap by showing fewer children of each part, and says how many it left out', () => {
    const state = makeState();
    for (let index = 0; index < 400; index += 1) {
      addFolder(state, { parentId: 'manuscript', title: `Chapter ${index}, a long title that takes up room in every row`, now: OPENED });
    }
    const outcome = valueOf(run(makeHarness({}, state), 'project.overview', {}));
    expect(fitsCap(outcome.data, capOf('project.overview'))).toBe(true);
    const manuscript = (outcome.data['tree'] as { id: string; children: unknown[]; childrenTotal?: number }[]).find(
      (node) => node.id === 'manuscript',
    );
    expect(manuscript?.childrenTotal).toBe(402);
    expect((manuscript?.children ?? []).length).toBeLessThan(402);
    expect(outcome.notes?.join(' ')).toContain('The tree shows');
  });

  it('refuses rather than return an overview that cannot be fitted under its cap at all', () => {
    const state = makeState();
    for (let index = 0; index < 2000; index += 1) {
      addFolder(state, { parentId: 'root', title: `Part ${index} with a title long enough to matter`, now: OPENED });
    }
    const error = refusalOf(run(makeHarness({}, state), 'project.overview', {}));
    expect(error.code).toBe('limit-exceeded');
    expect(error.message).toContain('over its 4000-token cap');
  });
});

describe('notes.read under a long notes field', () => {
  it('shortens notes that exceed the cap, names the cut, and returns a response that fits', () => {
    const state = makeState();
    const long = 'n'.repeat(60000);
    state.manifest.tree.find((node) => node.id === LANDING)!.notes = long;
    const outcome = valueOf(run(makeHarness({}, state), 'notes.read', { doc: LANDING, fields: ['notes'] }));
    const text = outcome.data['notes'] as string;
    expect(text.length).toBeLessThan(long.length);
    expect(fitsCap(outcome.data, capOf('notes.read'))).toBe(true);
    expect(outcome.notes?.join(' ')).toContain('cut');
  });

  it('returns notes that fit untouched, with no note', () => {
    const outcome = valueOf(run(makeHarness(), 'notes.read', { doc: LANDING, fields: ['notes'] }));
    expect(outcome.data['notes']).toBe('Fix pacing in the last three paragraphs.');
    expect(outcome.notes).toBeUndefined();
  });
});

describe('codex.write responses and plan cards', () => {
  it('keeps the full description on the plan card, and gives the response a shortened one', () => {
    const description = 'z'.repeat(1500);
    const preview = makeHarness().previewPlan({
      steps: [{ tool: 'codex.write', params: { entries: [{ action: 'create', name: 'Long', description }] }, expect: 'add an entry' }],
    });
    if (!preview.ok) throw new Error('expected a preflight');
    const card = preview.value.steps[0]?.preview as { entries: { description: string }[] };
    expect(card.entries[0]?.description).toBe(description);
  });

  it('leaves diffs out of a response that would exceed its cap, and says how many', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const created = valueOf(
      run(
        harness,
        'codex.write',
        { entries: Array.from({ length: 20 }, (_, index) => ({ action: 'create', name: `Bulk ${index}` })) },
        CONFIRMED,
      ),
    );
    const ids = created.data['created'] as string[];
    const updates = ids.map((id) => ({
      action: 'update',
      id,
      description: 'd'.repeat(1900),
      aliases: Array.from({ length: 10 }, () => 'x'.repeat(60)),
      exclude: Array.from({ length: 20 }, () => 'e'.repeat(60)),
    }));
    const outcome = valueOf(run(harness, 'codex.write', { entries: updates }, CONFIRMED));
    expect(fitsCap(outcome.data, capOf('codex.write'))).toBe(true);
    expect(outcome.data['diffsOmitted']).toBeGreaterThan(0);
    expect(outcome.notes?.join(' ')).toContain('left out');
  });
});

describe('the store’s own count, used by the summaries that report words', () => {
  it('agrees with countBody for the overview total of a plain project', () => {
    const state = makeState();
    const outcome = valueOf(run(makeHarness({}, state), 'project.overview', {}));
    const expected = countBody('The ferry was late, as always.').words + countBody('Rain.\n\n***\n\nThe lamp failed.').words;
    expect(outcome.data['totalWords']).toBe(expected);
  });
});
