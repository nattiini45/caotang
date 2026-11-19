import { createGateway, createKeyStore, createMemoryVaultPort, createProfileStore, type ChatMessage, type FetchLike } from '@caotang/gateway';
import { expect, it, vi } from 'vitest';

import { createAgentSession, createBudgetMeter, createMemoryRunLog, createProductHarness, traceGateway, type ModelHook, type RunLogPort, type TraceInput } from '../../src/index.js';
import { LANDING, makeState } from '../fixtures.js';
import { answer, steps } from './scripts.js';

const HOOK: ModelHook = { id: 'end', name: 'Follow-up check', enabled: true, event: 'turn.end', tool: '', prompt: 'Check whether to continue.', failClosed: false };
const INTENT = 'Make a private note.';
const PROSE = 'The tide was late.';
const REASON = 'Follow-up from the hook.';
const ALLOW = '{"decision":"allow","reason":""}';
const AGAIN = JSON.stringify({ decision: 'continue', reason: REASON });

function stream(delta: object, finish = 'stop'): Response {
  const frame = (part: object, stop: string | null, usage?: object) =>
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: part, finish_reason: stop }], usage })}\n\n`;
  return new Response(frame({ role: 'assistant', ...delta }, null) + frame({}, finish, { prompt_tokens: 50, completion_tokens: 10 }) + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function fixture(native: boolean, replies: readonly Response[], verdicts: readonly string[], onRequest?: (background: boolean) => void) {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = (name: string) => profiles.create({ name, kind: 'endpoint', preset: 'generic', baseUrl: `https://${name}.example/v1`, apiKey: 'fixture-key', defaultModel: `${name}-model` });
  const foreground = await profile('foreground');
  const background = await profile('background');
  const route = { profileId: background.id, model: background.defaultModel };
  const records: TraceInput[] = [];
  const sink = { write: (record: TraceInput) => { records.push(record); } };
  const calls: { background: boolean; messages: ChatMessage[] }[] = [];
  let nextPlanner = 0;
  let nextHook = 0;
  let hooks: readonly ModelHook[] = [HOOK];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    const isBackground = url.includes('background.example');
    const { messages } = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
    calls.push({ background: isBackground, messages });
    onRequest?.(isBackground);
    if (isBackground) return stream({ content: verdicts[nextHook++] ?? ALLOW });
    return replies[nextPlanner++] ?? stream({ content: 'Unexpected planner request.' });
  });
  const base = createGateway({ profiles, keys, fetch, observe: traceGateway(sink), roles: {
    resolve: (role) => role === 'background' ? route : undefined,
    allowed: (role) => role === 'background' ? [background.id] : [],
  } });
  const gateway = { ...base, modelCaps: (...args: Parameters<typeof base.modelCaps>) => ({ ...base.modelCaps(...args), tools: native }) };
  const state = makeState();
  const log = createMemoryRunLog();
  return {
    options: {
      gateway, profileId: foreground.id, modelHookRoute: () => route, trace: sink,
      harness: createProductHarness({ state, ports: 'agent', modelHooks: () => hooks }),
      runLog: { port: log, projectId: 'p_CONTINUATION' },
    },
    calls, records, log, state,
    setHooks: (next: readonly ModelHook[]) => { hooks = next; },
  };
}

it('continues the JSON planner twice on the same turn and reports a third request without following it', async () => {
  const reply = (text: string) => stream({ content: answer(text) });
  const run = await fixture(false, [reply('First answer.'), reply('Second answer.'), reply('Third answer.')], [AGAIN, AGAIN, AGAIN]);
  const report = await createAgentSession({ ...run.options, maxModelCalls: 6, decide: async () => ({ action: 'cancel' }) }).submit(INTENT);
  expect(report).toMatchObject({ status: 'replied', text: 'Third answer.', modelCalls: 6, external: true });
  expect(run.calls.map((call) => call.background)).toEqual([false, true, false, true, false, true]);
  const hooks = run.calls.filter((call) => call.background);
  expect(hooks.map(({ messages }) => messages[1]?.content)).toEqual(Array(3).fill('{"tool":"","prose":"replied"}'));
  expect(JSON.stringify(hooks)).not.toContain(INTENT);
  expect(JSON.stringify(hooks)).not.toContain('First answer.');
  const planners = run.calls.filter((call) => !call.background);
  expect(planners.map(({ messages }) => messages.filter((message) => String(message.content).includes(REASON)).length)).toEqual([0, 1, 2]);
  expect(report.hooks).toHaveLength(3);
  expect(report.hooks?.at(-1)?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('ignored') });
  expect(JSON.stringify(run.records)).not.toContain(REASON);
});

it('does not spend the final available call on a hook that could not continue the planner', async () => {
  const run = await fixture(false, [stream({ content: answer('The original answer.') })], [AGAIN]);
  const meter = createBudgetMeter({ maxModelCalls: 2 });
  const report = await createAgentSession({ ...run.options, meter, decide: async () => ({ action: 'cancel' }) }).submit(INTENT);
  expect(report).toMatchObject({ status: 'replied', text: 'The original answer.', modelCalls: 1, spend: { modelCalls: 1 } });
  expect(report.hooks?.[0]?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('not enough model calls left') });
  expect(run.calls.map((call) => call.background)).toEqual([false]);
});

it('keeps the completed reply if the planner fails during a follow-up', async () => {
  const run = await fixture(false, [stream({ content: answer('The original answer.') }), new Response('provider unavailable', { status: 400 })], [AGAIN]);
  const report = await createAgentSession({ ...run.options, decide: async () => ({ action: 'cancel' }) }).submit(INTENT);
  expect(report).toMatchObject({ status: 'replied', text: 'The original answer.', modelCalls: 3 });
  expect(report.hooks?.at(-1)?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('previous result was kept') });
  expect(JSON.stringify(report)).not.toContain('provider unavailable');
});

it('keeps the completed reply when an invalid follow-up exhausts the planner budget', async () => {
  const run = await fixture(false, [stream({ content: answer('The original answer.') }), stream({ content: 'Not a planner reply.' })], [AGAIN]);
  const report = await createAgentSession({ ...run.options, maxModelCalls: 3, decide: async () => ({ action: 'cancel' }) }).submit(INTENT);
  expect(report).toMatchObject({ status: 'replied', text: 'The original answer.', modelCalls: 3 });
  expect(report.hooks?.at(-1)?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('previous result was kept') });
  expect(run.calls.map((call) => call.background)).toEqual([false, true, false]);
});

it('does not honor a verdict from a hook that changed before its reply could be used', async () => {
  const run = await fixture(false, [stream({ content: answer('The original answer.') })], [AGAIN], (background) => {
    if (background) run.setHooks([{ ...HOOK, prompt: 'A different check.' }]);
  });
  const report = await createAgentSession({ ...run.options, decide: async () => ({ action: 'cancel' }) }).submit(INTENT);
  expect(report).toMatchObject({ status: 'replied', text: 'The original answer.', modelCalls: 2 });
  expect(report.external).toBeUndefined();
  expect(report.hooks?.[0]?.decision).toMatchObject({ action: 'warn', reason: expect.stringContaining('configuration') });
  expect(run.calls.map((call) => call.background)).toEqual([false, true]);
});

it('reports Stop during the check without starting another planner request', async () => {
  const stop = new AbortController();
  const run = await fixture(false, [stream({ content: answer('The original answer.') })], [AGAIN], (background) => {
    if (background) stop.abort();
  });
  const report = await createAgentSession({ ...run.options, decide: async () => ({ action: 'cancel' }) }).submit(INTENT, { signal: stop.signal });
  expect(report).toMatchObject({ status: 'cancelled', stop: { by: 'user' } });
  expect(run.calls.map((call) => call.background)).toEqual([false, true]);
});

it('never checks successful explicitly supplied plans or background planners for continuation', async () => {
  const plan = { steps: [{ tool: 'notes.append', params: { doc: LANDING, text: PROSE }, expect: 'Add a note.' }] };
  const explicit = await fixture(false, [], [AGAIN]);
  const planned = await createAgentSession({ ...explicit.options, decide: async () => ({ action: 'approve' }) }).submitPlan(INTENT, plan);
  expect(planned.status).toBe('applied');
  expect(explicit.calls).toEqual([]);

  const task = await fixture(false, [stream({ content: answer('The task answer.') })], [AGAIN]);
  const report = await createAgentSession({ ...task.options, role: 'background', decide: async () => ({ action: 'cancel' }) }).submit(INTENT);
  expect(report).toMatchObject({ status: 'replied', text: 'The task answer.', modelCalls: 1 });
  expect(report.hooks).toBeUndefined();
});

it('answers the native call before the untrusted reason and requires approval for a follow-up write in Auto', async () => {
  const note = (id: string, text: string) => stream({
    tool_calls: [{ index: 0, id, type: 'function', function: { name: 'notes.append', arguments: JSON.stringify({ doc: LANDING, text }) } }],
  }, 'tool_calls');
  const run = await fixture(true, [note('first-call', PROSE), note('second-call', 'A follow-up note.')], [AGAIN]);
  const decide = vi.fn(async () => ({ action: 'cancel' as const }));
  const report = await createAgentSession({ ...run.options, mode: 'auto', loadEveryTool: () => true, decide }).submit(INTENT);
  expect(report).toMatchObject({ status: 'cancelled', modelCalls: 3, external: true, undoGroupId: expect.any(String) });
  expect(decide).toHaveBeenCalledOnce();
  expect(run.state.manifest.tree.find((node) => node.id === LANDING)?.notes).toContain(PROSE);
  expect(run.state.manifest.tree.find((node) => node.id === LANDING)?.notes).not.toContain('A follow-up note.');
  expect(run.calls[1]?.messages[1]?.content).toBe('{"tool":"","prose":"applied"}');
  expect(JSON.stringify(run.calls[1])).not.toContain(PROSE);
  const messages = run.calls[2]?.messages ?? [];
  expect(messages.findIndex((message) => message.role === 'tool')).toBeGreaterThan(messages.findIndex((message) => message.role === 'assistant'));
  expect(messages.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'first-call' });
  expect(messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining(`<<untrusted source="hook:Follow-up check"`) });
  expect(JSON.stringify(run.records)).not.toContain(REASON);
});

it('recovers the reserved call and untrusted reason without replaying the prior write', async () => {
  const note = (text: string) => stream({ content: steps({ tool: 'notes.append', params: { doc: LANDING, text }, expect: 'Add a note.' }) });
  const later = 'A resumed note.';
  const run = await fixture(false, [note(PROSE), note(later)], [AGAIN, ALLOW]);
  let drop = (): void => {};
  const dropped = new Promise<void>((resolve) => { drop = resolve; });
  const port: RunLogPort = {
    ...run.log,
    append: async (runId, events, patch) => {
      await run.log.append(runId, events, patch);
      if (events.some((event) => event.t === 'spend' && event.spend.modelCalls === 2 && event.reservedCalls === 1)) {
        drop();
        await new Promise<void>(() => {});
      }
    },
  };
  const options = { ...run.options, mode: 'auto' as const };
  void createAgentSession({ ...options, runLog: { ...options.runLog, port }, decide: async () => ({ action: 'cancel' }) }).submit(INTENT);
  await dropped;
  const [interrupted] = await run.log.open(options.runLog.projectId);
  if (interrupted === undefined) throw new Error('The interrupted run was not saved.');
  await run.log.update(interrupted.runId, { status: 'interrupted' });

  const decide = vi.fn(async () => ({ action: 'approve' as const }));
  const report = await createAgentSession({ ...options, decide }).resume(interrupted.runId);
  expect(report).toMatchObject({ status: 'applied', external: true, modelCalls: 5 });
  expect(decide).toHaveBeenCalledOnce();
  expect(run.calls.map((call) => call.background)).toEqual([false, true, false, true]);
  const resumedReason = run.calls[2]?.messages.find((message) => message.role === 'user' && String(message.content).includes(REASON));
  expect(resumedReason?.content).toContain('The preceding plan already applied.');
  const notes = run.state.manifest.tree.find((node) => node.id === LANDING)?.notes ?? '';
  expect(notes.split(PROSE)).toHaveLength(2);
  expect(notes).toContain(later);
});

it('answers the original native call id after applying an approved rewrite', async () => {
  const first = stream({ tool_calls: [{ index: 0, id: 'note-to-rewrite', type: 'function', function: {
    name: 'notes.append', arguments: JSON.stringify({ doc: LANDING, text: PROSE }),
  } }] }, 'tool_calls');
  const replacement = 'The tide was early.';
  const transform = JSON.stringify({ decision: 'transform', reason: 'Tidy the note.', replacement });
  const run = await fixture(true, [first, stream({ content: 'Follow-up complete.' })], [transform, AGAIN, ALLOW]);
  run.setHooks([{ ...HOOK, id: 'before', event: 'tool.before', tool: 'notes.append', canTransform: true }, HOOK]);
  const decide = vi.fn(async () => ({ action: 'approve' as const }));
  const report = await createAgentSession({ ...run.options, mode: 'auto', loadEveryTool: () => true, decide }).submit(INTENT);
  expect(report).toMatchObject({ status: 'replied', text: 'Follow-up complete.' });
  expect(decide).toHaveBeenCalledOnce();
  const planner = run.calls.filter((entry) => !entry.background).at(-1);
  expect(planner?.messages.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'note-to-rewrite', content: expect.stringContaining('"ok":true') });
  const notes = run.state.manifest.tree.find((node) => node.id === LANDING)?.notes ?? '';
  expect(notes).not.toContain(PROSE);
  expect(notes.split(replacement)).toHaveLength(2);
});
