/**
 * `tool.search` — determinism (§5, eval 2), the excerpt cap, browse and filter behaviour, the
 * refusals, the notes for an empty or unhealthy index, and the per-turn loaded set. The index is
 * built from a real client over the scripted servers, so the notes say what the client knows.
 */

import { describe, expect, it } from 'vitest';

import {
  EXCERPT_CHARS,
  TOOL_SEARCH_META,
  TOOL_SEARCH_NAME,
  TOOL_SEARCH_PARAMS,
  createLoadedTools,
  loadedAddendum,
  toolSearch,
  type NativeIndexRow,
} from '../src/index.js';
import { LONG_DESCRIPTION, SHELF_KEY, STORY_KEY, openClient, qualified } from './fixtures.js';

async function standardIndex() {
  return openClient({ approve: [STORY_KEY, SHELF_KEY], trust: [STORY_KEY] });
}

describe('the tool definition', () => {
  it('is a read tool outside the closed registry, with a parameter spec the harness can derive a schema from', () => {
    expect(TOOL_SEARCH_NAME).toBe('tool.search');
    expect(TOOL_SEARCH_META).toMatchObject({ name: 'tool.search', risk: 'read', undoable: false, surface: 'extension', load: 'core' });
    // The description now covers the registry's own deferred tools, so its version moved (agent-harness §9).
    expect(TOOL_SEARCH_META.descriptionVersion).toBe(2);
    expect(TOOL_SEARCH_PARAMS.kind).toBe('object');
    expect(TOOL_SEARCH_PARAMS.required).toEqual(['query']);
    expect(Object.keys(TOOL_SEARCH_PARAMS.properties).sort()).toEqual(['limit', 'query', 'risk', 'server']);
  });
});

describe('determinism', () => {
  it('returns the same matches in the same order on every run, servers in config order and tools by name', async () => {
    const first = await standardIndex();
    const second = await standardIndex();
    const run = (client: Awaited<ReturnType<typeof standardIndex>>['client'], loaded = createLoadedTools()) =>
      toolSearch({ query: '', limit: 20 }, { index: () => client.indexedTools(), loaded });
    const a = run(first.client);
    const b = run(second.client);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('expected matches');
    expect(a.value.data).toEqual(b.value.data);
    expect(a.value.data.surfaced).toEqual([
      qualified(STORY_KEY, 'lore_lookup'),
      qualified(STORY_KEY, 'lore_update'),
      qualified(STORY_KEY, 'timeline_check'),
      qualified(SHELF_KEY, 'shelf_search'),
    ]);
  });
});

describe('excerpts', () => {
  it('caps every excerpt at 200 characters and marks a cut', async () => {
    const { client } = await standardIndex();
    const result = toolSearch({ query: 'timeline' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!result.ok) throw new Error('expected matches');
    const match = result.value.data.matches.find((candidate) => candidate.toolName === 'timeline_check');
    expect(match?.excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(match?.excerpt.endsWith('…')).toBe(true);
    expect(LONG_DESCRIPTION.length).toBeGreaterThan(EXCERPT_CHARS);
  });

  it('gives the full descriptor to the harness for the turn, so the approval card can show the whole text', async () => {
    const { client } = await standardIndex();
    const result = toolSearch({ query: 'timeline' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!result.ok) throw new Error('expected matches');
    const surfaced = result.value.surfaced.find((tool) => tool.toolName === 'timeline_check');
    expect(surfaced?.description).toBe(LONG_DESCRIPTION);
    expect(surfaced?.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('matching, browse and filters', () => {
  it('matches on the name and the description, case-insensitively', async () => {
    const { client } = await standardIndex();
    const byName = toolSearch({ query: 'LORE_UP' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    const byText = toolSearch({ query: 'aliases' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!byName.ok || !byText.ok) throw new Error('expected matches');
    expect(byName.value.data.surfaced).toEqual([qualified(STORY_KEY, 'lore_update')]);
    expect(byText.value.data.surfaced).toEqual([qualified(STORY_KEY, 'lore_lookup')]);
  });

  it('browses the first matches with an empty query, and says how many more there are', async () => {
    const { client } = await standardIndex();
    const result = toolSearch({ query: '', limit: 2 }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!result.ok) throw new Error('expected matches');
    expect(result.value.data.surfaced).toHaveLength(2);
    expect(result.value.notes.join(' ')).toContain('2 more matched');
  });

  it('filters to one server by its key', async () => {
    const { client } = await standardIndex();
    const result = toolSearch({ query: '', server: SHELF_KEY }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!result.ok) throw new Error('expected matches');
    expect(result.value.data.surfaced).toEqual([qualified(SHELF_KEY, 'shelf_search')]);
  });

  it('filters by the badge: read is the trusted, read-only tool, and write is everything that asks first', async () => {
    const { client } = await standardIndex();
    const reads = toolSearch({ query: '', risk: 'read' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    const writes = toolSearch({ query: '', risk: 'write', limit: 20 }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!reads.ok || !writes.ok) throw new Error('expected matches');
    expect(reads.value.data.matches.map((match) => match.risk)).toEqual(['read']);
    expect(reads.value.data.surfaced).toEqual([qualified(STORY_KEY, 'lore_lookup')]);
    expect(writes.value.data.matches.every((match) => match.risk === 'write')).toBe(true);
    expect(writes.value.data.surfaced).not.toContain(qualified(STORY_KEY, 'lore_lookup'));
  });

  it('reports a miss as a result with the corrective terms, not as an error', async () => {
    const { client } = await standardIndex();
    const result = toolSearch({ query: 'zzz' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('a miss is a result');
    expect(result.value.summary).toBe("no tool matched 'zzz'; re-search with terms from the task");
    expect(result.value.data.surfaced).toEqual([]);
  });
});

describe('refusals name the parameter and the accepted set', () => {
  it.each([
    [{}, '"query" is required'],
    [{ query: 3 }, '"query" is required'],
    [{ query: 'a', extra: true }, '"extra" is not a parameter of tool.search'],
    [{ query: 'a', limit: 0 }, '"limit" must be an integer from 1 to 20'],
    [{ query: 'a', limit: 21 }, '"limit" must be an integer from 1 to 20'],
    [{ query: 'a', limit: 2.5 }, '"limit" must be an integer from 1 to 20'],
    [{ query: 'a', risk: 'auto' }, '"risk" must be "read" or "write"'],
    [{ query: 'x'.repeat(201) }, '"query" is longer than 200 characters'],
    [[], 'tool.search takes an object of named parameters'],
  ])('refuses %j', async (params, message) => {
    const { client } = await standardIndex();
    const result = toolSearch(params, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error.code).toBe('invalid-params');
    expect(result.error.message).toContain(message);
  });
});

describe('the notes an empty or unhealthy index gives', () => {
  it('says so when no server is connected at all, as a result', async () => {
    const { client } = await openClient({ servers: [] });
    const result = toolSearch({ query: '' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!result.ok) throw new Error('expected a result');
    expect(result.value.notes).toEqual(['no MCP servers connected — add one in Settings › MCP & tools']);
    expect(result.value.data.surfaced).toEqual([]);
  });

  it('says so when MCP & tools is off', async () => {
    const { client } = await openClient({ enabled: false, connect: [] });
    const result = toolSearch({ query: '' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!result.ok) throw new Error('expected a result');
    expect(result.value.notes).toEqual(['MCP & tools is off — turn it on in Settings › MCP & tools']);
  });

  it('excludes an unreviewed server and names it, so a person knows why its tools are missing', async () => {
    const { client } = await openClient({ approve: [STORY_KEY], connect: [STORY_KEY, SHELF_KEY] });
    const result = toolSearch({ query: '' }, { index: () => client.indexedTools(), loaded: createLoadedTools() });
    if (!result.ok) throw new Error('expected a result');
    expect(result.value.notes.some((note) => note.startsWith('Research Shelf is not searched:'))).toBe(true);
    expect(result.value.data.surfaced.every((name) => name.startsWith(`mcp__${STORY_KEY}__`))).toBe(true);
  });
});

describe('the per-turn loaded set', () => {
  it('loads what a search surfaces, so a call can name it, and a new turn starts with nothing loaded', async () => {
    const { client } = await standardIndex();
    const loaded = createLoadedTools();
    loaded.beginTurn('turn-1');
    toolSearch({ query: 'lookup' }, { index: () => client.indexedTools(), loaded });
    expect(loaded.isLoaded(qualified(STORY_KEY, 'lore_lookup'))).toBe(true);
    expect(loaded.isLoaded(qualified(STORY_KEY, 'lore_update'))).toBe(false);
    loaded.beginTurn('turn-2');
    expect(loaded.isLoaded(qualified(STORY_KEY, 'lore_lookup'))).toBe(false);
    expect(loaded.turnId).toBe('turn-2');
  });

  it('describes the loaded tools in one L0 line, and nothing when none are loaded', () => {
    expect(loadedAddendum([])).toBeUndefined();
    expect(loadedAddendum([qualified(STORY_KEY, 'lore_lookup')])).toBe(
      `Tools loaded this turn, callable by name: mcp__${STORY_KEY}__lore_lookup.`,
    );
  });
});

const NATIVE: readonly NativeIndexRow[] = [
  { source: 'native', name: 'dialogue.table', description: 'Read the lines of one dialogue container as a table.', keywords: ['cutscene', 'ink'], risk: 'read' },
  { source: 'native', name: 'shots.derive', description: 'x'.repeat(EXCERPT_CHARS * 2), keywords: ['storyboard'], risk: 'write' },
];

describe('the registry’s deferred rows in the same index', () => {
  const search = async (params: unknown, loaded = createLoadedTools()) => {
    const { client } = await standardIndex();
    return { result: toolSearch(params, { index: () => client.indexedTools(), native: () => NATIVE, loaded }), loaded };
  };

  it('lists native rows first, in the order given, then servers in config order and tools by name', async () => {
    const { result } = await search({ query: '', limit: 20 });
    if (!result.ok) throw new Error('expected matches');
    const sources = result.value.data.matches.map((match) => match.source);
    expect(sources).toEqual(['native', 'native', ...Array.from({ length: sources.length - 2 }, () => 'external')]);
    expect(result.value.data.surfaced.slice(0, 2)).toEqual(['dialogue.table', 'shots.derive']);
    expect(result.value.data.surfaced.slice(2).every((name) => name.startsWith('mcp__'))).toBe(true);
    // Only the external matches have a descriptor to read back from the index.
    expect(result.value.surfaced.every((tool) => tool.qualifiedName.startsWith('mcp__'))).toBe(true);
  });

  it('gives a native match its bare name, its badge and an excerpt of at most the cap, and loads it by name for the turn', async () => {
    const { result, loaded } = await search({ query: 'shots' });
    if (!result.ok) throw new Error('expected matches');
    const [match] = result.value.data.matches;
    expect(match).toMatchObject({ source: 'native', name: 'shots.derive', risk: 'write' });
    expect(match?.serverKey).toBeUndefined();
    expect(match?.excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(loaded.isLoaded('shots.derive')).toBe(true);
    expect(loaded.hashOf('shots.derive')).toBeUndefined();
    expect(loaded.nativeNames()).toEqual(['shots.derive']);
  });

  it('matches a native row by its keyword, by every word of the query, and by risk', async () => {
    expect((await search({ query: 'cutscene' })).result).toMatchObject({ value: { data: { surfaced: ['dialogue.table'] } } });
    expect((await search({ query: 'dialogue container' })).result).toMatchObject({ value: { data: { surfaced: ['dialogue.table'] } } });
    expect((await search({ query: 'dialogue storyboard' })).result).toMatchObject({ value: { data: { surfaced: [] } } });
    expect((await search({ query: '', risk: 'write', limit: 1 })).result).toMatchObject({ value: { data: { surfaced: ['shots.derive'] } } });
  });

  it('leaves the native rows out of a search that names an external server', async () => {
    const { result } = await search({ query: '', server: SHELF_KEY });
    if (!result.ok) throw new Error('expected matches');
    expect(result.value.data.matches.every((match) => match.source === 'external')).toBe(true);
  });

  it('keeps an external match bound to its candidate hash beside a native one', async () => {
    const { result, loaded } = await search({ query: '', limit: 20 });
    if (!result.ok) throw new Error('expected matches');
    const external = result.value.surfaced[0];
    expect(external?.candidateHash).toBeDefined();
    expect(loaded.hashOf(external?.qualifiedName ?? '')).toBe(external?.candidateHash);
    expect(loaded.names()).toEqual([...loaded.names()].sort());
    expect(loaded.entries().map((entry) => (entry.source === 'native' ? entry.name : entry.qualifiedName))).toEqual(loaded.names());
  });

  it('names native and external tools alike in the one-line addendum', () => {
    expect(loadedAddendum(['dialogue.table', 'mcp__s_X__lookup'])).toBe('Tools loaded this turn, callable by name: dialogue.table, mcp__s_X__lookup.');
  });

  it('keeps a restored native entry, so a load put back after an external search is still loaded', () => {
    const loaded = createLoadedTools();
    loaded.beginTurn('t');
    loaded.load([{ source: 'native', name: 'shots.derive' }, { qualifiedName: 'mcp__s_X__lookup', candidateHash: 'h1' }]);
    const before = loaded.entries();
    loaded.beginTurn('t');
    loaded.load(before);
    expect(loaded.entries()).toEqual(before);
    loaded.load(['mcp__s_X__lookup']);
    expect(loaded.hashOf('mcp__s_X__lookup')).toBe('h1');
  });
});
