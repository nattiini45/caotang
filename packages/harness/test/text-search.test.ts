import { describe, expect, it } from 'vitest';
import { setBody } from '@caotang/store';
import { resolveAnchor } from '@caotang/editor';
import type { TextSearchData } from '../src/tools/text-search.js';
import { codexReadPort, estimateTokens, type RuleSet } from '../src/index.js';
import { modelResult, turnNonce } from '../src/agent/untrusted.js';
import { CHAPTER_ONE, ENTRY, FRIEND, LANDING, makeHarness, STORM } from './fixtures.js';

let callId = 0;

describe('text.search as a local read tool', () => {
  it('is discoverable and returns bounded source snippets without writes or provider requests', () => {
    const harness = makeHarness();
    const before = JSON.stringify(harness.state.manifest);
    const found = harness.call({ callId: `search-${++callId}`, name: 'tool.search', params: { query: 'find project passages' } }, { turnId: 'search' });
    expect(found.ok).toBe(true);
    expect(JSON.stringify(found)).toContain('text.search');
    const result = harness.call({ callId: `search-${++callId}`, name: 'text.search', params: { query: 'ferry' } }, { turnId: 'search' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data as TextSearchData;
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0]).toMatchObject({ nodeId: LANDING, field: 'body', title: 'The Landing', rank: 1, snippet: { text: 'The ferry was late, as always.' } });
    expect(data.hits[0]).not.toHaveProperty('unit');
    expect(result.value.affected).toEqual([]);
    expect(JSON.stringify(harness.state.manifest)).toBe(before);
  });

  it('applies every scoped read-deny and live Never changes before scoring, not just text.search rules', () => {
    let rules: RuleSet = { rules: [] };
    const harness = makeHarness({ rules: () => rules });
    setBody(harness.state, FRIEND, 'ferry '.repeat(300));
    const call = () => harness.call({ callId: `search-${++callId}`, name: 'text.search', params: { query: 'ferry keeper' } }, { turnId: 'search' });
    expect(call().ok).toBe(true);
    rules = { rules: [{ source: 'app', tool: 'doc.read', effect: 'deny', access: 'read', scope: { subtree: FRIEND } }] };
    harness.state.manifest.codex!.find((entry) => entry.id === ENTRY)!.includePolicy = 'never';
    const result = call();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.data as TextSearchData).hits.map((hit) => hit.nodeId)).toEqual([LANDING]);
    expect(JSON.stringify(result.value)).not.toContain(FRIEND);
    expect(JSON.stringify(result.value)).not.toContain(ENTRY);
  });

it('leaves out a codex entry attached only to withheld nodes, as codex.read does', () => {
    const rules: RuleSet = { rules: ['doc.read', 'codex.read'].map((tool) => ({ source: 'app', tool, effect: 'deny', access: 'read', scope: { subtree: FRIEND } })) };
    const harness = makeHarness({ rules: () => rules, ports: { 'codex.read': codexReadPort } });
    const entry = harness.state.manifest.codex!.find((item) => item.id === ENTRY)!;
    entry.attachments = [FRIEND];
    entry.description = 'The keeper of the quietlamp.';
    const search = harness.call({ callId: `search-${++callId}`, name: 'text.search', params: { query: 'quietlamp' } }, { turnId: 'search' });
    const read = harness.call({ callId: `search-${++callId}`, name: 'codex.read', params: { query: 'quietlamp' } }, { turnId: 'search' });
    expect(read.ok).toBe(true);
    if (read.ok) expect(JSON.stringify(read.value)).not.toContain('quietlamp');
    expect(search.ok).toBe(true);
    if (search.ok) expect(JSON.stringify(search.value)).not.toContain('quietlamp');
  });

  it('expands binder scope, filters fields and refuses bad focus or scope ids', () => {
    const harness = makeHarness();
    const result = harness.call({ callId: `search-${++callId}`, name: 'text.search', params: { query: 'island rain', scope: [CHAPTER_ONE], fields: ['synopsis'] } }, { turnId: 'search' });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value.data as TextSearchData).hits.map((hit) => [hit.nodeId, hit.field])).toEqual([[LANDING, 'synopsis']]);
    for (const params of [{ query: 'ferry', scope: ['unknown'] }, { query: 'ferry', focus: CHAPTER_ONE }, { query: 'ferry', excludeAfter: 'unknown' }]) expect(harness.call({ callId: `search-${++callId}`, name: 'text.search', params }, { turnId: 'search' }).ok).toBe(false);
    const empty = harness.call({ callId: `search-${++callId}`, name: 'text.search', params: { query: 'unfindable' } }, { turnId: 'search' });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value.data).toEqual({ hits: [], total: 0, truncated: false, hint: 'Try fewer words, or codex.read for names.' });
  });

  it('caps the complete model envelope at whole hit rows and reports the exact visible total', () => {
    const harness = makeHarness();
    for (const id of [LANDING, STORM, FRIEND]) setBody(harness.state, id, Array.from({ length: 15 }, () => `ferry ${'x\u0001'.repeat(350)}`).join('\n\n'));
    const result = harness.call({ callId: `search-${++callId}`, name: 'text.search', params: { query: 'ferry', limit: 25 } }, { turnId: 'search' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data as TextSearchData;
    expect(data.total).toBe(45);
    expect(data.truncated).toBe(true);
    expect(data.hits.length).toBeGreaterThan(0);
    expect(data.hits.length).toBeLessThan(25);
    expect(estimateTokens(modelResult({ tool: 'text.search', ok: true, body: data }, turnNonce('search')))).toBeLessThanOrEqual(4_000);
  });

  it('resolves a returned body snippet through the real edit-anchor ladder', () => {
    const harness = makeHarness();
    const body = 'Before.\n\nThe lighthouse shines through the storm.\n\nAfter.';
    setBody(harness.state, LANDING, body);
    const result = harness.call({ callId: `search-${++callId}`, name: 'text.search', params: { query: 'lighthouse', fields: ['body'] } }, { turnId: 'search' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = (result.value.data as TextSearchData).hits[0]!;
    const { from, to, text } = hit.snippet;
    const anchor = { from, to, exact: text, prefix: body.slice(Math.max(0, from - 32), from), suffix: body.slice(to, to + 32), capturedRevision: hit.revision };
    expect(resolveAnchor(anchor, body, hit.revision)).toMatchObject({ status: 'ok', method: 'exact', range: { from, to } });
  });
});
