import { expect, it } from 'vitest';
import { addDocument } from '@caotang/store';
import { textSearchPort, type RuleSet } from '../src/index.js';
import { CHAPTER_ONE, CHAPTER_TWO, LANDING, STORM, makeHarness } from './fixtures.js';

for (const async of [false, true]) it(`requires scoped read confirmation for candidate passages before search (async: ${async})`, async () => {
  let rules: RuleSet = { rules: [{ source: 'app', tool: 'text.search', effect: 'ask', access: 'read', scope: { subtree: CHAPTER_ONE } }] };
  let invoked = 0;
  const harness = makeHarness({ rules: () => rules, ...(async ? { asyncPorts: { 'text.search': async (params, context) => { invoked++; return textSearchPort(params, context); } } } : {}) });
  let id = 0;
  const call = (params: Record<string, unknown>, confirmed = false) => {
    const request = { name: 'text.search' as const, callId: `ask-${++id}`, params };
    const turn = { turnId: 'search-ask', ...(confirmed ? { permission: { confirmed: true as const } } : {}) };
    return async ? harness.callAsync(request, turn) : Promise.resolve(harness.call(request, turn));
  };
  for (const params of [{ query: 'ferry' }, { query: 'ferry', scope: [CHAPTER_ONE] }, { query: 'ferry', scope: [LANDING] }, { query: 'unfindable' }]) {
    expect(await call(params)).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  }
  expect(invoked).toBe(0);
  expect(await call({ query: 'ferry' }, true)).toMatchObject({ ok: true, value: { data: { total: 1 } } });
  expect(await call({ query: 'ferry', scope: [CHAPTER_TWO] })).toMatchObject({ ok: true, value: { data: { total: 0 } } });
  expect(await call({ query: 'keeper', fields: ['codex'] })).toMatchObject({ ok: true, value: { data: { total: 1 } } });
  expect(await call({ query: 'ferry', scope: [] })).toMatchObject({ ok: true, value: { data: { total: 0 } } });

  rules = { rules: [{ source: 'app', tool: 'text.search', effect: 'ask', access: 'read', scope: { subtree: STORM } }] };
  expect(await call({ query: 'ferry', excludeAfter: LANDING })).toMatchObject({ ok: true, value: { data: { total: 1 } } });
  addDocument(harness.state, { id: 'n_RESRCH0001', parentId: 'research', title: 'Ferry notes', body: 'ferry notes', now: new Date('2026-11-13T12:00:00Z') });
  rules = { rules: [{ source: 'app', tool: 'text.search', effect: 'ask', access: 'read', scope: { subtree: 'research' } }] };
  expect(await call({ query: 'ferry', excludeAfter: LANDING })).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  expect(await call({ query: 'ferry', excludeAfter: LANDING }, true)).toMatchObject({ ok: true, value: { data: { total: 2 } } });
  rules = { rules: [{ source: 'app', tool: 'text.search', effect: 'ask', access: 'write', scope: { subtree: CHAPTER_ONE } }] };
  expect((await call({ query: 'ferry' })).ok).toBe(true);

  rules = { rules: [{ source: 'app', tool: 'text.search', effect: 'deny', access: 'read', scope: { subtree: CHAPTER_ONE } }] };
  expect(await call({ query: 'ferry' })).toMatchObject({ ok: true, value: { data: { total: 1, hits: [{ nodeId: 'n_RESRCH0001' }] } } });
  rules = { rules: [
    { source: 'app', tool: 'doc.read', effect: 'deny', access: 'read', scope: { subtree: CHAPTER_ONE } },
    { source: 'app', tool: 'text.search', effect: 'ask', access: 'read', scope: { subtree: CHAPTER_ONE } },
  ] };
  expect(await call({ query: 'ferry' })).toMatchObject({ ok: true, value: { data: { total: 1, hits: [{ nodeId: 'n_RESRCH0001' }] } } });
  rules = { rules: [{ source: 'app', tool: 'text.search', effect: 'deny', access: 'read' }] };
  expect(await call({ query: 'ferry' }, true)).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
});
