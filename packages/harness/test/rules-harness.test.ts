/**
 * The rules at the harness (agent-harness §4, "Rules"): what a deny, an ask and a read-deny do to a call, to a plan's preflight and
 * to the read tools, on the real bus and the real project fixture. The agent loop's side (cards, modes) is rules-loop.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { createMcpClient, createMockWireFactory, qualifiedNameOf, type McpServerConfig, type MockMcpScript, type WireTool } from '@caotang/mcp-client';
import { createProjectCommandRegistry } from '@caotang/store';

import { TOOL_METADATA, TOOL_NAMES, TOOL_TARGETS, createAgentPorts, type RuleSet, type SourcedRule } from '../src/index.js';
import { CHAPTER_ONE, CHAPTER_TWO, ENTRY, ENTRY_TWO, FRIEND, LANDING, STORM, callId, makeHarness, makeState, refusalOf, registryWithFakeExports, run, snapshotOf, valueOf } from './fixtures.js';

const rule = (effect: 'deny' | 'ask', fields: Partial<SourcedRule> = {}): SourcedRule => ({ effect, tool: '*', source: 'project', ...fields });

/** A harness whose rules are read from `current` at each call, so a test changes them between calls. */
function harnessWith(rules: SourcedRule[], overrides: { unreadable?: boolean } = {}) {
  const current: { set: RuleSet } = { set: { rules, ...(overrides.unreadable === true ? { unreadable: true } : {}) } };
  const state = makeState();
  const harness = makeHarness({ rules: () => current.set, ports: createAgentPorts() }, state);
  return { harness, state, current };
}

describe('a deny', () => {
  it('refuses a write into a locked subtree as permission-denied, names the rule, and changes nothing', () => {
    const { harness, state } = harnessWith([rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write', note: 'Locked for my editor' })]);
    const before = snapshotOf(state);
    const error = refusalOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'A note.' }));
    expect(error.code).toBe('permission-denied');
    expect(error.message).toContain('"The Landing" is locked against changes by a rule in this project’s file (Locked for my editor)');
    expect(snapshotOf(state)).toBe(before);
  });

  it('lets the same call through outside the subtree, and a read of the locked subtree', () => {
    const { harness } = harnessWith([rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write' })]);
    expect(valueOf(run(harness, 'notes.append', { doc: 'The Friend', text: 'A note.' })).summary).toContain('The Friend');
    expect(valueOf(run(harness, 'doc.read', { doc: 'The Landing' })).data['text']).toContain('ferry');
  });

  it('refuses a batch whole when one target is locked, with no partial effect', () => {
    const { harness, state } = harnessWith([rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write' })]);
    const before = snapshotOf(state);
    const error = refusalOf(run(harness, 'meta.set', { targets: [FRIEND, LANDING], status: 'final' }));
    expect(error.code).toBe('permission-denied');
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a binder.restructure whole, naming the operation that touches a locked node, before anything is applied', () => {
    const { harness, state } = harnessWith([rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write' })]);
    const before = snapshotOf(state);
    const error = refusalOf(
      run(
        harness,
        'binder.restructure',
        {
          ops: [
            { action: 'create', parent: CHAPTER_TWO, type: 'document', title: 'New scene' },
            { action: 'rename', node: FRIEND, title: 'The Friend, again' },
            { action: 'move', node: STORM, newParent: CHAPTER_TWO, index: 0 },
          ],
        },
        { permission: { approvedPlan: true } },
      ),
    );
    expect(error.code).toBe('permission-denied');
    expect(error.target).toBe('params.ops[2]');
    expect(error.message).toContain('operation 2');
    expect(snapshotOf(state)).toBe(before);
  });

  it('also refuses a move into a locked folder, and a create under it', () => {
    const { harness } = harnessWith([rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write' })]);
    const into = refusalOf(run(harness, 'binder.restructure', { ops: [{ action: 'move', node: FRIEND, newParent: CHAPTER_ONE, index: 0 }] }, { permission: { approvedPlan: true } }));
    expect(into.target).toBe('params.ops[0]');
    const under = refusalOf(run(harness, 'binder.restructure', { ops: [{ action: 'create', parent: CHAPTER_ONE, type: 'document', title: 'X' }] }, { permission: { approvedPlan: true } }));
    expect(under.code).toBe('permission-denied');
  });

  it('applies to a tool by name with no scope, in every case', () => {
    const { harness } = harnessWith([rule('deny', { tool: 'codex.write', note: 'No codex edits' })]);
    const error = refusalOf(run(harness, 'codex.write', { entries: [{ action: 'create', name: 'Mara', type: 'character', description: 'A sailor.' }] }, { permission: { approvedPlan: true } }));
    expect(error.code).toBe('permission-denied');
    expect(error.message).toContain('No codex edits');
  });

  it('is not a hard-deny, and the writer removing the rule lets the call through at the next call', () => {
    const { harness, current } = harnessWith([rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write' })]);
    expect(refusalOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'A note.' })).code).not.toBe('hard-denied');
    current.set = { rules: [] };
    expect(run(harness, 'notes.append', { doc: 'The Landing', text: 'A note.' }).ok).toBe(true);
  });

  it('shows a denied step as refused in a plan’s preflight, so the card cannot approve it', () => {
    const { harness } = harnessWith([rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write' })]);
    const preflight = harness.previewPlan({
      steps: [
        { tool: 'notes.append', params: { doc: 'The Friend', text: 'ok' }, expect: 'noted' },
        { tool: 'notes.append', params: { doc: 'The Landing', text: 'no' }, expect: 'noted' },
      ],
    });
    if (!preflight.ok) throw new Error('expected a preflight');
    expect(preflight.value.ok).toBe(false);
    expect(preflight.value.steps.map((step) => step.status)).toEqual(['ready', 'refused']);
    expect(preflight.value.steps[1]?.error?.code).toBe('permission-denied');
  });

  it('refuses an executed plan at the denied step, before it is applied', () => {
    const { harness, state } = harnessWith([rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write' })]);
    const before = snapshotOf(state);
    const outcome = harness.executePlan(
      { steps: [{ tool: 'notes.append', params: { doc: 'The Landing', text: 'no' }, expect: 'noted' }] },
      { turnId: 'turn-plan', callId: 'plan-1', permission: { approvedPlan: true } },
    );
    expect(outcome.ok && outcome.value.status === 'applied').toBe(false);
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a call from the outward surface the same way', () => {
    const locked = (): RuleSet => ({ rules: [rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'write' })] });
    const harness = makeHarness({ rules: locked, externalWrites: true });
    expect(refusalOf(run(harness, 'notes.append', { doc: 'The Landing', text: 'x' }, { source: 'mcp' })).code).toBe('permission-denied');
    expect(run(harness, 'notes.append', { doc: 'The Friend', text: 'x' }, { source: 'mcp' }).ok).toBe(true);
  });

  it('does not block export.compile when a subtree is read-denied, since an export sends nothing to a provider', () => {
    const harness = makeHarness({ registry: registryWithFakeExports(), rules: () => ({ rules: [rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'read' })] }) });
    expect(run(harness, 'export.compile', { selection: { root: CHAPTER_ONE }, format: 'txt' }, { permission: { confirmed: true } }).ok).toBe(true);
  });
});

describe('an ask', () => {
  const asking = (): SourcedRule[] => [rule('ask', { tool: 'meta.set', note: 'Check statuses with me' })];

  it('refuses a call that carries no confirmation, even for a write-auto tool, and names the rule', () => {
    const { harness, state } = harnessWith(asking());
    const before = snapshotOf(state);
    const error = refusalOf(run(harness, 'meta.set', { targets: [FRIEND], status: 'final' }));
    expect(error.code).toBe('permission-denied');
    expect(error.message).toContain('needs the writer’s confirmation');
    expect(error.message).toContain('Check statuses with me');
    expect(snapshotOf(state)).toBe(before);
  });

  it('runs once the writer has confirmed the call, or approved the plan it is a step of', () => {
    const { harness } = harnessWith(asking());
    expect(run(harness, 'meta.set', { targets: [FRIEND], status: 'final' }, { permission: { confirmed: true } }).ok).toBe(true);
    expect(run(harness, 'meta.set', { targets: [STORM], status: 'final' }, { permission: { approvedPlan: true } }).ok).toBe(true);
  });

  it('is not met by a call from the outward surface, which cannot confirm', () => {
    const state = makeState();
    const harness = makeHarness({ rules: () => ({ rules: asking() }), externalWrites: true }, state);
    expect(refusalOf(run(harness, 'meta.set', { targets: [FRIEND], status: 'final' }, { source: 'mcp' })).code).toBe('permission-denied');
  });

  it('leaves a tool the rule does not name alone', () => {
    const { harness } = harnessWith(asking());
    expect(run(harness, 'notes.append', { doc: 'The Friend', text: 'x' }).ok).toBe(true);
  });

  it('is asked of a read too', () => {
    const { harness } = harnessWith([rule('ask', { tool: 'doc.read' })]);
    expect(refusalOf(run(harness, 'doc.read', { doc: 'The Storm' })).code).toBe('permission-denied');
    expect(run(harness, 'doc.read', { doc: 'The Storm' }, { permission: { confirmed: true } }).ok).toBe(true);
  });
});

describe('rules that cannot be read', () => {
  it('refuse every write and leave the reads, when the provider throws', () => {
    const state = makeState();
    const harness = makeHarness(
      {
        rules: () => {
          throw new Error('the manifest could not be read');
        },
      },
      state,
    );
    expect(refusalOf(run(harness, 'notes.append', { doc: 'The Friend', text: 'x' })).message).toContain('the rules could not be read');
    expect(run(harness, 'doc.read', { doc: 'The Storm' }).ok).toBe(true);
  });
});

describe('a read-deny', () => {
  const hidden = (): SourcedRule[] => [rule('deny', { scope: { subtree: CHAPTER_ONE }, access: 'read' })];

  it('refuses doc.read and notes.read of a withheld document without naming it, and refuses a write to it too', () => {
    const { harness } = harnessWith(hidden());
    for (const [tool, params] of [
      ['doc.read', { doc: LANDING }],
      ['notes.read', { doc: LANDING }],
      ['notes.append', { doc: LANDING, text: 'x' }],
    ] as const) {
      const error = refusalOf(run(harness, tool, params));
      expect(error.code).toBe('permission-denied');
      expect(error.message).not.toContain('The Landing');
    }
  });

  it('omits the subtree from binder.read_tree and says how many items it left out', () => {
    const { harness } = harnessWith(hidden());
    const whole = valueOf(run(harness, 'binder.read_tree', { root: 'manuscript', depth: 3 }));
    const ids = (whole.data['nodes'] as { id: string }[]).map((node) => node.id);
    expect(ids).toContain(CHAPTER_TWO);
    expect(ids).not.toContain(CHAPTER_ONE);
    expect(ids).not.toContain(LANDING);
    expect(whole.data['withheld']).toBe(3);
    expect(whole.notes?.join(' ')).toContain('3 items are withheld');
    expect(JSON.stringify(whole.data)).not.toContain('The Landing');
  });

  it('refuses binder.read_tree started inside the subtree', () => {
    const { harness } = harnessWith(hidden());
    expect(refusalOf(run(harness, 'binder.read_tree', { root: CHAPTER_ONE })).code).toBe('permission-denied');
  });

  it('counts the withheld nodes in project.overview and leaves their words, titles and goals out', () => {
    const open = harnessWith([]).harness;
    const { harness } = harnessWith(hidden());
    const all = valueOf(run(open, 'project.overview', {}));
    const some = valueOf(run(harness, 'project.overview', {}));
    expect(some.data['withheld']).toBe(3);
    expect(some.data['totalWords']).toBeLessThan(all.data['totalWords'] as number);
    expect(JSON.stringify(some.data['tree'])).not.toContain('Chapter 1');
    expect(some.notes?.join(' ')).toContain('withheld from the agent by a rule');
  });

  it('withholds a codex entry attached only to withheld nodes, and keeps one attached anywhere visible or nowhere', () => {
    const { harness, state } = harnessWith(hidden());
    const entries = state.manifest.codex ?? [];
    const onlyHidden = entries.find((entry) => entry.id === ENTRY);
    const mixed = entries.find((entry) => entry.id === ENTRY_TWO);
    if (onlyHidden === undefined || mixed === undefined) throw new Error('fixture');
    onlyHidden.attachments = [LANDING, STORM];
    mixed.attachments = [LANDING, FRIEND];
    const read = valueOf(run(harness, 'codex.read', {}));
    const names = (read.data['entries'] as { name: string }[]).map((entry) => entry.name);
    expect(names).toEqual(['Kestrel']);
    expect(read.data['withheld']).toBe(1);
    mixed.attachments = [];
    expect((valueOf(run(harness, 'codex.read', {})).data['entries'] as unknown[]).length).toBe(1);
  });

  it('keeps a withheld document out of a coherence scan, as an archived one is', () => {
    const open = harnessWith([]).harness;
    const { harness } = harnessWith(hidden());
    const scanned = (h: typeof open): string => valueOf(run(h, 'coherence.scan', { scope: { mode: 'full' } })).summary;
    expect(scanned(open)).toContain('across 2 document');
    expect(scanned(harness)).toContain('across 0 document');
  });

  it('leaves a withheld document out of continuity.scan with no scope, by title and by count', () => {
    const scan = (rules: SourcedRule[], params: Record<string, unknown> = {}) =>
      harnessWith(rules).harness.call(
        { name: 'continuity.scan', callId: callId('continuity.scan'), params, proposal: { findings: [] } },
        { turnId: 'turn-continuity' },
      );
    expect(valueOf(scan([])).data['scope']).toEqual(['The Landing', 'The Storm', 'The Friend']);
    const hiddenScope = valueOf(scan(hidden()));
    expect(hiddenScope.data['scope']).toEqual(['The Friend']);
    expect(JSON.stringify(hiddenScope)).not.toContain('The Landing');
    expect(refusalOf(scan(hidden(), { scope: ['The Landing'] })).code).toBe('permission-denied');
  });

  it('applies only to the tools its pattern names', () => {
    const { harness } = harnessWith([rule('deny', { tool: 'notes.read', scope: { subtree: CHAPTER_ONE }, access: 'read' })]);
    expect(run(harness, 'doc.read', { doc: LANDING }).ok).toBe(true);
    expect(run(harness, 'notes.read', { doc: LANDING }).ok).toBe(false);
  });
});

describe('an external tool', () => {
  const KEY = 's_STORYB0001';
  const SEARCH = qualifiedNameOf(KEY, 'search_lore');
  const config: McpServerConfig = {
    key: KEY,
    name: 'Story Bible',
    transport: 'http',
    url: 'https://s-storyb0001.fixture.test/mcp',
    auth: { kind: 'none' },
    enabled: true,
    trustReads: true,
    pinnedTools: {},
    addedAt: '2026-10-08T09:00:00.000Z',
  };
  const tools: WireTool[] = [
    {
      name: 'search_lore',
      description: 'Search the story bible for an entry.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
  ];

  async function connected(calls: string[]) {
    const script: MockMcpScript = {
      listTools: tools,
      respond: (tool) => {
        calls.push(tool);
        return { content: [{ type: 'text', text: 'answer' }], isError: false };
      },
    };
    const client = createMcpClient({
      settings: { enabled: true, servers: [config] },
      wire: createMockWireFactory({ [KEY]: script }),
      probe: async () => false,
      now: () => config.addedAt,
      listTimeoutMs: 2_000,
      callTimeoutMs: 2_000,
    });
    await client.connect(KEY);
    const card = client.review(KEY);
    if (card !== undefined) client.approveReview(KEY, card.fingerprint);
    return client;
  }

  it('is refused by a deny that names it, before the server is called', async () => {
    const calls: string[] = [];
    const client = await connected(calls);
    const harness = makeHarness({ mcp: { client }, rules: () => ({ rules: [rule('deny', { tool: `mcp__${KEY}__*`, note: 'No outside lookups' })] }) });
    run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-ext' });
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'ext-1', params: { query: 'x' } }, { turnId: 'turn-ext' });
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('permission-denied');
    expect(outcome.error.message).toContain('No outside lookups');
    expect(calls).toEqual([]);
  });

  it('fails closed under a scoped deny, since an external tool’s nodes are unknown', async () => {
    const calls: string[] = [];
    const client = await connected(calls);
    const harness = makeHarness({ mcp: { client }, rules: () => ({ rules: [rule('deny', { tool: SEARCH, scope: { subtree: CHAPTER_ONE }, access: 'read' })] }) });
    run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-ext' });
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'ext-2', params: { query: 'x' } }, { turnId: 'turn-ext' });
    expect(outcome.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('is not changed by an ask: an external call confirms per call whatever the rules say', async () => {
    const calls: string[] = [];
    const client = await connected(calls);
    const harness = makeHarness({ mcp: { client }, rules: () => ({ rules: [rule('ask', { tool: `mcp__${KEY}__*`, note: 'x' })] }) });
    run(harness, 'tool.search', { query: 'lore' }, { turnId: 'turn-ext' });
    const outcome = await harness.callExternal({ name: SEARCH, callId: 'ext-3', params: { query: 'x' } }, { turnId: 'turn-ext' });
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(['search_lore']);
  });
});

describe('targets', () => {
  it('every registry row declares its targets, or says it names no node', () => {
    expect(TOOL_METADATA.map((meta) => meta.name)).toEqual([...TOOL_NAMES]);
    expect(Object.keys(TOOL_TARGETS).sort()).toEqual([...TOOL_NAMES].sort());
    for (const meta of TOOL_METADATA) expect(['project'].includes(meta.targets as string) || typeof meta.targets === 'function', meta.name).toBe(true);
  });

  it('resolves a title the way the tool does, and names every node a compound call touches', () => {
    const state = makeState();
    const append = TOOL_TARGETS['notes.append'];
    const targets = typeof append === 'function' ? append({ doc: 'The Landing', text: 'x' }, state) : undefined;
    expect(targets?.ok && targets.value.writes).toEqual([LANDING]);
    const restructure = TOOL_TARGETS['binder.restructure'];
    const compound = typeof restructure === 'function' ? restructure({ ops: [{ action: 'move', node: STORM, newParent: CHAPTER_TWO, index: 0 }, { action: 'rename', node: STORM, title: 'x' }] }, state) : undefined;
    expect(compound?.ok && compound.value.writes).toEqual([STORM, CHAPTER_TWO]);
    expect(compound?.ok && compound.value.opOf?.[STORM]).toBe(0);
  });

  it('cannot be written by any registry tool or bus command: no row or command is named for rules', () => {
    for (const name of TOOL_NAMES) expect(name.toLowerCase()).not.toContain('rule');
    const registry = createProjectCommandRegistry({ clock: { now: () => 0 } });
    for (const name of Object.keys(registry)) expect(name.toLowerCase()).not.toContain('rule');
  });
});
