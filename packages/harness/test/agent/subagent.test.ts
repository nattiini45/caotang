/**
 * The delegated-agent runner (agent-harness §2, "Delegate"): the list each agent is given on both wires, the fresh context it starts
 * from, a write it wants that comes back as a proposed step with no bus command dispatched, the refusals it reads, the model calls it
 * reserves and releases, and the writer's Stop. The runner is driven here with a hand-made parent handle over the real harness and the
 * mock provider; `eval/subagent.test.ts` runs it inside whole turns.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest } from '@caotang/gateway';
import { subagentScript } from '@caotang/gateway/mock';
import type { MockResponse, MockScript } from '@caotang/gateway/mock';

import {
  childTools,
  createAgentPorts,
  createContextPort,
  createSubagentRunner,
  GENERAL,
  plannerTools,
  READER,
  SUBAGENT_SYSTEM_PREFIX,
  SUMMARY_MAX_TOKENS,
  type ContextPort,
  type ParentTurnHandle,
  type SubagentSpec,
  type TraceEntry,
} from '../../src/index.js';
import { LANDING, makeHarness, makeState, refusalOf, run, snapshotOf } from '../fixtures.js';
import { mockGateway } from './gateway.js';

const NOTES = 'Hale knows about the lamp; the ferry crew do not.';
const reply = (text: string): string => JSON.stringify({ reply: text });
const stepsOf = (...calls: readonly { tool: string; params: Record<string, unknown> }[]): string =>
  JSON.stringify({ steps: calls.map((call) => ({ ...call, expect: 'for the notes' })) });
const READ = { tool: 'doc.read', params: { doc: 'The Landing' } };
const HERON = { tool: 'codex.write', params: { entries: [{ action: 'create', name: 'Heron', type: 'other', description: 'The grey bird on the breakwater.' }] } };

/** The replies an agent has already made. */
const repliesOf = (req: ChatRequest): number => req.messages.filter((message) => message.role === 'assistant').length;

/** A script that answers the agent's nth call with the nth reply, and the last one after that. */
function inOrder(replies: readonly (string | MockResponse)[], seen: ChatRequest[] = []): MockScript {
  return subagentScript((req) => {
    if (seen.at(-1) !== req) seen.push(req);
    return replies[Math.min(repliesOf(req), replies.length - 1)];
  });
}

interface Fixture {
  readonly runner: ReturnType<typeof createSubagentRunner>;
  readonly handle: ParentTurnHandle;
  readonly harness: ReturnType<typeof makeHarness>;
  readonly reserved: number[];
  readonly released: number[];
  readonly reads: string[];
  readonly traced: TraceEntry[];
  /** What each assembly was asked for, and what it returned. */
  readonly assembled: { readonly request: Parameters<ContextPort['assemble']>[0]; readonly payload: string; readonly l6: boolean }[];
  readonly controller: AbortController;
  /** Runs the agent. */
  go(spec: SubagentSpec, params?: { brief?: string; scope?: readonly string[] }): ReturnType<ReturnType<typeof createSubagentRunner>['run']>;
}

async function fixture(scripts: readonly MockScript[], options: { native?: boolean; allowed?: boolean; seen?: ChatRequest[] } = {}): Promise<Fixture> {
  const state = makeState();
  const harness = makeHarness({ ports: createAgentPorts() }, state);
  const base = await mockGateway(scripts);
  const seen = options.seen ?? [];
  const gateway = {
    complete: (request: ChatRequest, signal?: AbortSignal) => {
      seen.push(request);
      return base.complete(request, signal);
    },
  };
  const port = createContextPort({ state });
  const assembled: Fixture['assembled'] = [];
  const context: ContextPort = {
    assemble: (request) => {
      const call = port.assemble(request);
      assembled.push({ request, payload: call.preview.payload.map((message) => message.content).join('\n'), l6: call.prompt.layers.find((layer) => layer.id === 'L6')?.included === true });
      return call;
    },
  };
  const reserved: number[] = [];
  const released: number[] = [];
  const reads: string[] = [];
  const traced: TraceEntry[] = [];
  const controller = new AbortController();
  const agentPath = 'turn-9/reader#1';
  const handle: ParentTurnHandle = {
    turnId: 'turn-9',
    agentPath,
    native: options.native === true,
    reserve: (calls) => {
      reserved.push(calls);
      return options.allowed !== false;
    },
    release: (unused) => {
      released.push(unused);
    },
    model: () => ({ gateway, turnId: 'turn-9', agentPath, signal: controller.signal }),
    read: async (call) => {
      reads.push(`${call.callId} ${call.name}`);
      return harness.call(call, { turnId: 'turn-9', agentPath });
    },
    trace: (entry) => {
      traced.push({ ...entry, agentPath });
    },
  };
  const runner = createSubagentRunner({ tools: () => harness.tools(), previewPlan: (plan) => harness.previewPlan(plan), context });
  return {
    runner,
    handle,
    harness,
    reserved,
    released,
    reads,
    traced,
    assembled,
    controller,
    go: (spec, params = {}) => runner.run(spec, { agent: spec.name, brief: params.brief ?? 'Read the harbor scenes and report.', ...(params.scope === undefined ? {} : { scope: params.scope }) }, handle, controller.signal),
  };
}

const namesOf = (listing: readonly { readonly name: string }[]): string[] => listing.map((tool) => tool.name).sort();
const toolLines = (system: string): string[] => [...system.matchAll(/^- ([a-z._]+) \[/gm)].map((match) => match[1] ?? '').sort();

describe('the list each agent is given', () => {
  const tools = makeHarness({ ports: createAgentPorts() }, makeState()).tools();

  it('holds the reader’s read tools only, whatever the planner has loaded', () => {
    expect(namesOf(childTools(READER, tools))).toEqual(['binder.read_tree', 'codex.read', 'dialogue.table', 'doc.read', 'notes.read', 'project.overview']);
    expect(childTools(READER, tools).every((tool) => tool.risk === 'read')).toBe(true);
  });

  it('adds the general agent’s write-confirm tools, which it may stage and never run', () => {
    const general = childTools(GENERAL, tools);
    expect(namesOf(general)).toEqual([...namesOf(childTools(READER, tools)), 'binder.restructure', 'codex.write', 'scene.draft', 'synopsis.fill'].sort());
    expect(general.filter((tool) => tool.risk !== 'read').every((tool) => tool.risk === 'write-confirm')).toBe(true);
  });

  it('never lists a write-auto tool, a meta tool, the delegation, the search or an external tool, even if a spec asked for one', () => {
    const greedy: SubagentSpec = {
      ...GENERAL,
      reads: [...GENERAL.reads, 'agent.delegate', 'agent.plan', 'tool.search', 'meta.set', 'skill.load'],
      stages: [...GENERAL.stages, 'agent.delegate', 'meta.set', 'notes.append', 'coherence.review'],
    };
    const listed = namesOf(childTools(greedy, tools));
    for (const never of ['agent.delegate', 'agent.plan', 'tool.search', 'meta.set', 'notes.append', 'coherence.review', 'continuity.scan', 'coherence.scan']) {
      expect(listed, never).not.toContain(never);
    }
    // A name is kept only where the registry's risk agrees with the list it is in, and a row this harness has not wired is not offered.
    expect(listed).not.toContain('skill.load');
    expect(childTools({ ...greedy, reads: ['meta.set'], stages: ['doc.read'] }, tools)).toEqual([]);
  });

  it('is the planner’s own filter closed to the named rows: deferral does not matter, and an unwired row is never offered', () => {
    const only = plannerTools(tools, { all: true, only: ['dialogue.table', 'continuity.scan', 'doc.read'] });
    // dialogue.table is deferred, and offered because the list is closed; the rest is the planner's callable, wired set.
    expect(namesOf(only)).toEqual(['continuity.scan', 'dialogue.table', 'doc.read']);
    const bare = makeHarness({}, makeState()).tools();
    expect(namesOf(plannerTools(bare, { all: true, only: ['scene.draft', 'doc.read'] }))).toEqual(['doc.read']);
  });

  it('declares the same names on the native wire and in the JSON-in-text system message', async () => {
    const seen: ChatRequest[] = [];
    const native = await fixture([inOrder([reply(NOTES)], seen)], { native: true });
    await native.go(GENERAL);
    const declared = namesOf(seen[0]?.tools ?? []);
    expect(declared).toEqual(namesOf(childTools(GENERAL, native.harness.tools())));

    const jsonSeen: ChatRequest[] = [];
    const json = await fixture([inOrder([reply(NOTES)], jsonSeen)]);
    await json.go(GENERAL);
    expect(jsonSeen[0]?.tools).toBeUndefined();
    expect(toolLines(jsonSeen[0]?.messages[0]?.content ?? '')).toEqual(declared);
    expect(jsonSeen[0]?.messages[0]?.content.startsWith(SUBAGENT_SYSTEM_PREFIX)).toBe(true);
  });
});

describe('the context an agent starts from', () => {
  it('has no L6 and none of the parent’s messages: the brief and the scope are all it is given', async () => {
    const seen: ChatRequest[] = [];
    const f = await fixture([inOrder([reply(NOTES)], seen)]);
    const result = await f.go(READER, { brief: 'Who knows about the lamp?', scope: [LANDING] });
    expect(result.status).toBe('done');
    const [call] = f.assembled;
    expect(call?.request.task.tool).toBe('delegate');
    expect(call?.request.turns).toBeUndefined();
    expect(call?.request.activity).toBeUndefined();
    expect(call?.l6).toBe(false);
    expect(call?.payload).not.toContain('# Recent turns');
    expect(call?.payload).toContain('Brief: Who knows about the lamp?');
    // The scope's document is the text it is sent, and the prompt the model received is exactly that preview.
    expect(call?.payload).toContain('The ferry was late, as always.');
    expect(seen[0]?.messages.map((message) => message.content)).toEqual((call?.payload ?? '').split('\n').length > 0 ? seen[0]?.messages.map((message) => message.content) : []);
    expect(seen[0]?.messages.map((message) => message.role)).toEqual(['system', 'user']);
  });
});

describe('a write the agent wants', () => {
  it('is returned as a proposed step, never run: no bus command, no read of it, and the project as it was', async () => {
    const f = await fixture([inOrder([stepsOf(READ, HERON), reply('Proposed a Heron entry.')])]);
    const before = snapshotOf(f.harness.state);
    const result = await f.go(GENERAL);
    expect(result.status).toBe('done');
    expect(result.proposedSteps).toEqual([{ tool: 'codex.write', params: HERON.params, expect: 'for the notes' }]);
    expect(f.harness.log.length).toBe(0);
    expect(snapshotOf(f.harness.state)).toBe(before);
    expect(f.reads).toEqual(['turn-9/reader#1:r1 doc.read']);
    expect(f.traced.map((row) => [row.tool, row.outcome])).toEqual([
      ['doc.read', 'ok'],
      ['codex.write', 'not-run'],
    ]);
  });

  it('is told to the agent as recorded and not run, and a repeat of the same step is one proposal', async () => {
    const seen: ChatRequest[] = [];
    const f = await fixture([inOrder([stepsOf(HERON, HERON), reply('Done.')], seen)]);
    const result = await f.go(GENERAL);
    expect(result.proposedSteps).toHaveLength(1);
    const answered = seen[1]?.messages.at(-1)?.content ?? '';
    expect(answered).toContain('Recorded as a proposed step');
    expect(answered).toContain('nothing was changed');
  });

  it('is checked as a plan step is: params the registry refuses are given back to the agent and kept out of the proposals', async () => {
    const seen: ChatRequest[] = [];
    const f = await fixture([inOrder([stepsOf({ tool: 'codex.write', params: { entries: 'Heron' } }), reply('Could not propose it.')], seen)]);
    const result = await f.go(GENERAL);
    expect(result.proposedSteps).toEqual([]);
    expect(seen[1]?.messages.at(-1)?.content).toContain('"ok":false');
    expect(f.traced.map((row) => row.outcome)).toEqual(['refused']);
  });

  it('comes back on the native wire as a tool result for the call, in the same words', async () => {
    const seen: ChatRequest[] = [];
    const call: MockResponse = { content: 'Proposing it.', toolCalls: [{ id: 'call_1', name: 'codex.write', argumentsJson: JSON.stringify(HERON.params) }], finishReason: 'tool_calls' };
    const f = await fixture([inOrder([call, reply('Done.')], seen)], { native: true });
    const result = await f.go(GENERAL);
    expect(result.proposedSteps).toHaveLength(1);
    // The native wire has no `expect`, so the step takes the reply's text, as the planner's calls do.
    expect(result.proposedSteps[0]?.expect).toBe('Proposing it.');
    const tool = seen[1]?.messages.find((message) => message.role === 'tool');
    expect(tool?.toolCallId).toBe('call_1');
    expect(tool?.content).toContain('Recorded as a proposed step');
  });

  it('cannot run even if the runner’s own filter were bypassed: the harness refuses the call under the agent path', async () => {
    const f = await fixture([inOrder([reply(NOTES)])]);
    const error = refusalOf(run(f.harness, 'codex.write', HERON.params, { agentPath: 'turn-9/general#1', permission: { approvedPlan: true, confirmed: true } }));
    expect(error.code).toBe('permission-denied');
    expect(f.harness.log.length).toBe(0);
  });
});

describe('what an agent reads when it asks for a tool it was not given', () => {
  it('is told a delegated agent cannot delegate (depth is 1), and its trace says it was refused', async () => {
    const seen: ChatRequest[] = [];
    const delegate = { tool: 'agent.delegate', params: { agent: 'reader', brief: 'Read more.' } };
    const f = await fixture([inOrder([stepsOf(delegate), reply('Read it myself.')], seen)]);
    const result = await f.go(GENERAL);
    expect(result.status).toBe('done');
    expect(seen[1]?.messages.at(-1)?.content).toContain('a delegated agent cannot hand work to another agent');
    expect(f.traced).toEqual([{ tool: 'agent.delegate', callId: 'turn-9/reader#1:r1', outcome: 'refused', code: 'permission-denied', params: delegate.params, agentPath: 'turn-9/reader#1' }]);
    expect(f.reads).toEqual([]);
  });

  it('is told its tools when it names another, such as a write-auto tool or the search, and nothing runs', async () => {
    const seen: ChatRequest[] = [];
    const f = await fixture([inOrder([stepsOf({ tool: 'meta.set', params: { targets: [LANDING], status: 'final' } }, { tool: 'tool.search', params: { query: 'x' } }), reply('Done.')], seen)]);
    await f.go(GENERAL);
    const answered = seen[1]?.messages.at(-1)?.content ?? '';
    expect(answered).toContain('\\"meta.set\\" is not one of your tools');
    expect(answered).toContain('\\"tool.search\\" is not one of your tools');
    expect(f.harness.log.length).toBe(0);
  });
});

describe('the model calls an agent reserves', () => {
  it('are taken from the turn before the agent starts: a refusal means no model call and a failed result', async () => {
    const seen: ChatRequest[] = [];
    const f = await fixture([inOrder([reply(NOTES)], seen)], { allowed: false });
    const result = await f.go(READER);
    expect(f.reserved).toEqual([READER.maxModelCalls]);
    expect(result.status).toBe('failed');
    expect(seen).toEqual([]);
    // Nothing was reserved, so nothing is released.
    expect(f.released).toEqual([]);
  });

  it('are given back when unused: an agent that makes 2 of its 3 calls releases 1', async () => {
    const f = await fixture([inOrder([stepsOf(READ), reply(NOTES)])]);
    const result = await f.go(READER);
    expect(result.usage.modelCalls).toBe(2);
    expect(f.reserved).toEqual([3]);
    expect(f.released).toEqual([1]);
  });

  it('end the agent on its last call: it is asked for its notes, and one that keeps calling ends partial with nothing left to release', async () => {
    const seen: ChatRequest[] = [];
    const f = await fixture([inOrder([stepsOf(READ)], seen)]);
    const result = await f.go(READER);
    expect(result.status).toBe('partial');
    expect(result.usage.modelCalls).toBe(READER.maxModelCalls);
    expect(seen).toHaveLength(READER.maxModelCalls);
    expect(JSON.stringify(seen.at(-1)?.messages)).toContain('This is your last model call');
    expect(f.released).toEqual([0]);
  });

  it('stay declared on the native wire’s last call with tool choice none, so the replayed tool history is valid and it can only answer', async () => {
    const seen: ChatRequest[] = [];
    const call: MockResponse = { content: '', toolCalls: [{ id: 'c', name: 'doc.read', argumentsJson: JSON.stringify(READ.params) }], finishReason: 'tool_calls' };
    const f = await fixture([inOrder([call, call, reply(NOTES)], seen)], { native: true });
    const result = await f.go(READER);
    expect(result.status).toBe('done');
    expect(seen.map((request) => (request.tools?.length ?? 0) > 0)).toEqual([true, true, true]);
    expect(seen.map((request) => request.toolChoice)).toEqual(['auto', 'auto', 'none']);
  });

  it('give every read a call id derived from the turn and the agent’s path, so the replay cache cannot answer one with another’s', async () => {
    const f = await fixture([inOrder([stepsOf(READ, { tool: 'notes.read', params: { doc: 'The Landing' } }), reply(NOTES)])]);
    await f.go(READER);
    expect(f.reads).toEqual(['turn-9/reader#1:r1 doc.read', 'turn-9/reader#1:r2 notes.read']);
    expect(f.reads.every((read) => read.startsWith('turn-9/'))).toBe(true);
  });
});

describe('the writer’s Stop', () => {
  it('aborts a running agent: it ends partial, its unused calls are released, and no later call is made', async () => {
    const seen: ChatRequest[] = [];
    const stopper: { controller?: AbortController } = {};
    const f = await fixture([
      subagentScript((req) => {
        if (seen.at(-1) !== req) seen.push(req);
        // The writer stops the turn while the agent’s first request is in flight.
        stopper.controller?.abort();
        return repliesOf(req) === 0 ? stepsOf(READ) : reply(NOTES);
      }),
    ]);
    stopper.controller = f.controller;
    const result = await f.go(READER);
    expect(result.status).toBe('partial');
    expect(result.summary).toContain('stopped the turn');
    expect(seen).toHaveLength(1);
    expect(f.released).toEqual([READER.maxModelCalls - 1]);
    expect(f.reads).toEqual([]);
  });
});

describe('what the planner reads of a finished agent', () => {
  it('is clipped to the summary bound, with the ellipsis the other clips use', async () => {
    const f = await fixture([inOrder([reply('Notes. '.repeat(2_000))])]);
    const result = await f.go(READER);
    expect(result.status).toBe('done');
    expect(result.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_TOKENS * 4);
    expect(result.summary.endsWith('…')).toBe(true);
  });

  it('is a failure, not a pretence, when the agent’s context cannot be assembled', async () => {
    const f = await fixture([inOrder([reply(NOTES)])]);
    const result = await f.go(READER, { scope: ['n_NOTADOC001'] });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('could not start');
    expect(f.released).toEqual([READER.maxModelCalls]);
  });
});

describe('agent.delegate’s params', () => {
  const harness = makeHarness({ ports: createAgentPorts() }, makeState());
  const refused = (params: unknown): string => refusalOf(run(harness, 'agent.delegate', params)).message;

  it('are a closed set: a built-in agent, a brief, and a scope of at most twenty documents', () => {
    expect(refused({ agent: 'critic', brief: 'Read.' })).toContain('agent');
    expect(refused({ agent: 'reader', brief: '   ' })).toContain('brief');
    expect(refused({ agent: 'reader' })).toContain('brief');
    expect(refused({ agent: 'reader', brief: 'Read.', scope: Array.from({ length: 21 }, (_, index) => `Scene ${index}`) })).toContain('scope');
    expect(refused({ agent: 'reader', brief: 'Read.', budget: 20 })).toContain('budget');
  });

  it('name no budget, tools or permission an agent could take for itself', () => {
    const row = harness.tools().find((tool) => tool.name === 'agent.delegate');
    expect(Object.keys(row?.schema['properties'] as Record<string, unknown>).sort()).toEqual(['agent', 'brief', 'scope']);
    expect(row?.risk).toBe('read');
    expect(row?.load).toBe('deferred');
  });

  it('are described to the planner with each agent’s one line', () => {
    const row = harness.tools().find((tool) => tool.name === 'agent.delegate');
    for (const spec of [READER, GENERAL]) expect(row?.description).toContain(`${spec.name} — ${spec.description}`);
  });
});
