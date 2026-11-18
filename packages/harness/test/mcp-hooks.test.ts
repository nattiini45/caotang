import { err, ok } from '@caotang/bus';
import { createMcpClient, createMockWireFactory, type MockMcpScript, type WireTool } from '@caotang/mcp-client';
import { describe, expect, it, vi } from 'vitest';

import { createAgentSession, createMemoryRunLog, createProductHarness, validateMcpReadHook, type McpReadHook, type RuleSet, type TurnContext } from '../src/index.js';
import { withResultChecks } from '../src/testing.js';
import { mockGateway } from './agent/gateway.js';
import { FRIEND, LANDING, makeHarness, makeState } from './fixtures.js';

const KEY = 's_HOOK000001';
const NAME = 'check';
const TARGET = 'pictures.view';
const CALL = { name: TARGET, callId: 'picture-call', params: { assetIds: ['a_0000000001'] } };
const TURN = { turnId: 'mcp-hook-turn' };
const REMOTE_TEXT = 'untrusted payload with an apparent credential';
const TOOL: WireTool = { name: NAME, inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true } };

async function setup(tool = TOOL) {
  const responses: string[] = [];
  const args: Record<string, unknown>[] = [];
  const wire: string[] = [];
  const script: MockMcpScript = {
    listTools: [tool],
    record: ({ phase }) => wire.push(phase),
    respond: (_name, input) => {
      args.push(input);
      responses.push('mcp');
      return { content: [{ type: 'text', text: REMOTE_TEXT }] };
    },
  };
  const client = createMcpClient({
    settings: { enabled: true, servers: [{ key: KEY, name: 'Fixture', transport: 'http', url: 'https://fixture.test/mcp', enabled: true, auth: { kind: 'none' }, trustReads: false, pinnedTools: {}, addedAt: '2026-01-01T00:00:00.000Z' }] },
    wire: createMockWireFactory({ [KEY]: script }),
    probe: async () => false,
  });
  await client.connect(KEY);
  await client.approveReview(KEY, client.review(KEY)!.fingerprint);
  await client.setTrustReads(KEY, true);
  wire.length = 0;
  const hook: McpReadHook = {
    id: 'before', name: 'Check availability', enabled: true, event: 'tool.before', tool: TARGET,
    serverKey: KEY, toolName: NAME, pin: client.describe(KEY, NAME)!.candidateHash, failClosed: false,
  };
  let rules: RuleSet = { rules: [] };
  let hooks = [hook];
  const view = vi.fn(async () => {
    responses.push('port');
    return ok({ data: { pictures: [{ id: 'a_0000000001' }] }, summary: 'Viewed picture.', affected: [] });
  });
  const harness = withResultChecks(createProductHarness({
    state: makeState(),
    ports: 'agent',
    mcp: { client },
    mcpHooks: () => hooks,
    rules: () => rules,
    asyncPorts: { [TARGET]: view },
  }));
  return {
    args, client, harness, hook, responses, script, view, wire,
    setRules: (next: RuleSet) => { rules = next; },
    setHooks: (next: McpReadHook[]) => { hooks = next; },
  };
}

describe('read-only MCP runtime hooks', () => {
  it.each([false, true])('wraps a writer-approved native notes.append without touching synchronous APIs (run log: %s)', async (logged) => {
    const { harness, hook, setHooks, script, wire } = await setup();
    const before = { ...hook, tool: 'notes.append' };
    setHooks([before, { ...before, id: 'after', event: 'tool.after' }]);
    harness.state.manifest.agent = {
      hooks: [{
        id: 'h_0000000001',
        name: 'Tide wording',
        event: 'tool.before',
        enabled: true,
        matcher: { tools: ['notes.append'] },
        handler: { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'tide', message: 'Check this wording.' }] } },
      }],
    };
    const log = createMemoryRunLog();
    const text = 'Check the tide.';
    const notes = () => harness.state.manifest.tree.find((node) => node.id === LANDING)?.notes ?? '';
    const observations: { input: Record<string, unknown>; written: boolean; journaled: boolean }[] = [];
    script.respond = (_name, input) => {
      observations.push({ input, written: notes().includes(text), journaled: log.dump().includes('"t":"step.applied"') });
      return { content: [{ type: 'text', text: REMOTE_TEXT }] };
    };
    const decide = vi.fn(async () => {
      expect(wire).toEqual([]);
      expect(notes()).not.toContain(text);
      return { action: 'approve' as const };
    });
    const session = createAgentSession({
      harness,
      gateway: await mockGateway([]),
      mode: 'ask',
      decide,
      ...(logged ? { runLog: { port: log, projectId: 'p_HOOKS' } } : {}),
    });
    const report = await session.submitPlan('Add and replace notes.', {
      steps: [
        { tool: 'notes.append', params: { doc: LANDING, text }, expect: 'Add a tide note.' },
        { tool: 'notes.replace', params: { doc: FRIEND, notes: 'Look at the receipt.' }, expect: 'Replace the other note.' },
      ],
    });
    expect(report.status).toBe('applied');
    expect(decide).toHaveBeenCalledOnce();
    expect(observations).toEqual([
      { input: {}, written: false, journaled: false },
      { input: {}, written: true, journaled: logged },
    ]);
    expect(notes().match(/Check the tide\./gu)).toHaveLength(1);
    expect(report.hooks?.filter((run) => run.name === 'Tide wording')).toHaveLength(1);

    const direct = harness.call({ name: 'notes.append', callId: 'direct', params: { doc: LANDING, text: 'A direct note.' } }, { turnId: 'direct' });
    expect(direct.ok).toBe(true);
    expect(observations).toHaveLength(2);
  });

  it('runs before and after the port with empty input, without adding a model tool or exposing the reply', async () => {
    const { harness, hook, responses, args, setHooks } = await setup();
    setHooks([hook, { ...hook, id: 'after', event: 'tool.after' }]);
    const outcome = await harness.callAsync(CALL, TURN);
    expect(outcome.ok).toBe(true);
    expect(responses).toEqual(['mcp', 'port', 'mcp']);
    expect(args).toEqual([{}, {}]);
    expect(harness.loadedExternalTools()).toEqual([]);
    expect(harness.log.entries()).toMatchObject([
      { command: 'mcp.invoke', source: 'mcp', summary: 'Ran a read-only MCP hook.' },
      { command: 'mcp.invoke', source: 'mcp', summary: 'Ran a read-only MCP hook.' },
    ]);
    expect(JSON.stringify([outcome, harness.log.entries(), harness.takeHookRuns(TURN.turnId)])).not.toContain(REMOTE_TEXT);
  });

  it('does not call an after hook for a write whose applied record could not be saved', async () => {
    const { harness, hook, setHooks, wire } = await setup();
    setHooks([{ ...hook, tool: 'notes.append', event: 'tool.after' }]);
    const port = createMemoryRunLog();
    const flush = vi.fn(async () => { throw new Error('Test storage is unavailable.'); });
    const session = createAgentSession({
      harness, gateway: await mockGateway([]), mode: 'ask',
      decide: async () => ({ action: 'approve' }),
      runLog: { port, flush, projectId: 'p_HOOKS' },
    });
    const text = 'The original note was applied.';
    await session.submitPlan('Add a note.', { steps: [{ tool: 'notes.append', params: { doc: LANDING, text }, expect: 'Add a note.' }] });
    expect(flush).toHaveBeenCalled();
    expect(harness.state.manifest.tree.find(node => node.id === LANDING)?.notes).toContain(text);
    expect(port.dump()).not.toContain('"t":"step.applied"');
    expect(wire).toEqual([]);
  });

  it('never reaches the wire during sync preflight or when the original port is denied', async () => {
    const { harness, wire, view, setRules } = await setup();
    const plan = { steps: [{ tool: TARGET, params: CALL.params, expect: 'See the picture.' }] };
    expect(harness.previewPlan(plan).ok).toBe(true);
    expect(wire).toEqual([]);
    setRules({ rules: [{ source: 'app', tool: TARGET, effect: 'deny' }] });
    expect(await harness.callAsync(CALL, TURN)).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(wire).toEqual([]);
    expect(view).not.toHaveBeenCalled();
  });

  it.each<TurnContext>([
    { ...TURN, source: 'mcp' },
    { ...TURN, agentPath: 'parent/reader#1' },
  ])('does not chain to MCP for a delegated or external read (%j)', async (turn) => {
    const { harness, wire, view } = await setup();
    expect((await harness.callAsync(CALL, turn)).ok).toBe(true);
    expect(wire).toEqual([]);
    expect(view).toHaveBeenCalledOnce();
  });

  it('validates without network and refuses an untrusted, changed, write-confirm or required-input destination', async () => {
    const trusted = await setup();
    expect(validateMcpReadHook(trusted.client, trusted.hook).ok).toBe(true);
    expect(validateMcpReadHook(trusted.client, { ...trusted.hook, pin: 'stale' }).ok).toBe(false);
    await trusted.client.setTrustReads(KEY, false);
    expect(validateMcpReadHook(trusted.client, trusted.hook).ok).toBe(false);
    expect(trusted.wire).toEqual([]);
    const write = await setup({ ...TOOL, annotations: { readOnlyHint: false } });
    expect(validateMcpReadHook(write.client, write.hook).ok).toBe(false);
    const input = await setup({ ...TOOL, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } });
    expect(validateMcpReadHook(input.client, input.hook)).toMatchObject({ ok: false, error: { message: expect.stringContaining('empty arguments') } });
    expect([...write.wire, ...input.wire]).toEqual([]);
  });

  it('refuses a pin change discovered during the live relist', async () => {
    const { harness, hook, script, wire, view, setHooks } = await setup();
    setHooks([{ ...hook, failClosed: true }]);
    script.listTools = [{ ...TOOL, description: 'Changed after review.' }];
    const outcome = await harness.callAsync(CALL, { ...TURN, permission: { confirmed: true } });
    expect(outcome).toMatchObject({ ok: false, error: { details: { askBackCode: 'hook_blocked' } } });
    expect(wire).toEqual(['list']);
    expect(view).not.toHaveBeenCalled();
    expect(harness.log.entries()).toMatchObject([{ command: 'mcp.invoke', source: 'mcp' }]);
  });

  it('rechecks the original permission after the hook waits, and does not run another hook or the port if revoked', async () => {
    const { harness, hook, script, view, setHooks, setRules, wire } = await setup();
    setHooks([hook, { ...hook, id: 'second' }]);
    script.respond = () => {
      setRules({ rules: [{ source: 'app', tool: TARGET, effect: 'deny' }] });
      return { content: [] };
    };
    expect(await harness.callAsync(CALL, TURN)).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(wire).toEqual(['list', 'call']);
    expect(view).not.toHaveBeenCalled();
  });

  it('does not send the hook call if the original permission is revoked during relist', async () => {
    const { harness, script, view, setRules, wire } = await setup();
    script.fail = (phase) => {
      if (phase === 'list') setRules({ rules: [{ source: 'app', tool: TARGET, effect: 'deny' }] });
    };
    expect(await harness.callAsync(CALL, TURN)).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(wire).toEqual(['list']);
    expect(view).not.toHaveBeenCalled();
  });

  it('does not call a denied MCP destination or inherit the original call’s approval', async () => {
    const { client, harness, hook, setHooks, setRules, wire } = await setup();
    setHooks([{ ...hook, failClosed: true }]);
    const destination = client.describe(KEY, NAME)!.qualifiedName;
    setRules({ rules: [{ source: 'app', tool: destination, effect: 'ask' }] });
    expect(await harness.callAsync(CALL, { ...TURN, permission: { confirmed: true } })).toMatchObject({
      ok: false, error: { details: { askBackCode: 'hook_blocked' } },
    });
    expect(wire).toEqual([]);
  });

  it('skips the after hook on a failed original call', async () => {
    const { client, hook, wire } = await setup();
    const harness = makeHarness({
      mcp: { client },
      mcpHooks: () => [{ ...hook, event: 'tool.after' }],
      asyncPorts: { [TARGET]: async () => err({ code: 'not-found', message: 'Picture missing.' }) },
    });
    expect(await harness.callAsync(CALL, TURN)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(wire).toEqual([]);
  });

  it('does not start the original port if stopped during the hook', async () => {
    const { harness, script, view } = await setup();
    const stop = new AbortController();
    script.respond = () => {
      stop.abort();
      return { content: [] };
    };
    expect(await harness.callAsync(CALL, { ...TURN, signal: stop.signal })).toMatchObject({
      ok: false, error: { message: expect.stringContaining('did not run') },
    });
    expect(view).not.toHaveBeenCalled();
  });

  it('reports failures without copying server errors, and only a fail-closed before hook blocks', async () => {
    const { harness, hook, script, view, setHooks } = await setup();
    script.respond = () => ({ code: 'server_error', message: REMOTE_TEXT });
    setHooks([hook, { ...hook, id: 'after', event: 'tool.after', failClosed: true }]);
    const outcome = await harness.callAsync(CALL, TURN);
    expect(outcome).toMatchObject({ ok: true, value: { hookNotes: [{ hook: hook.name }] } });
    const reports = harness.takeHookRuns(TURN.turnId);
    expect(reports.map((run) => run.decision.action)).toEqual(['warn', 'warn']);
    expect(JSON.stringify([outcome, reports, harness.log.entries()])).not.toContain(REMOTE_TEXT);
    setHooks([{ ...hook, failClosed: true }]);
    expect(await harness.callAsync({ ...CALL, callId: 'second' }, TURN)).toMatchObject({
      ok: false, error: { message: expect.stringContaining('The original tool did not run.'), details: { askBackCode: 'hook_blocked' } },
    });
    expect(view).toHaveBeenCalledOnce();
  });

  it('replays one original outcome without duplicating pending or completed hook calls', async () => {
    const { harness, responses } = await setup();
    const first = harness.callAsync(CALL, TURN);
    const copy = harness.callAsync(CALL, TURN);
    const mismatch = harness.callAsync({ ...CALL, params: { assetIds: ['a_0000000002'] } }, TURN);
    expect(await copy).toEqual(await first);
    expect((await mismatch).ok).toBe(false);
    expect(await harness.callAsync(CALL, TURN)).toEqual(await first);
    expect(responses).toEqual(['mcp', 'port']);
  });
});
