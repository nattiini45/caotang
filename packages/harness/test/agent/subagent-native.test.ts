/**
 * A delegation on the native tool-call wire (agent-harness §2): the planner's call is answered by a `tool` message keyed by its id that
 * carries the agent's result behind the fixed notice, and the agent it started speaks the same wire with the list it was given and none
 * of the planner's conversation. The JSON wire is `eval/subagent.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest, Gateway } from '@caotang/gateway';
import { subagentScript } from '@caotang/gateway/mock';
import type { MockResponse, MockScript } from '@caotang/gateway/mock';

import { childTools, createAgentPorts, createAgentSession, createContextPort, DELEGATE_NOTICE, PLANNER_SYSTEM_PREFIX, READER } from '../../src/index.js';
import { makeHarness, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';

const INTENT = 'Who knows about the lamp?';
const repliesOf = (req: ChatRequest): number => req.messages.filter((message) => message.role === 'assistant').length;
const call = (id: string, name: string, args: unknown): MockResponse => ({
  content: '',
  toolCalls: [{ id, name, argumentsJson: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});

describe('a delegation on the native wire', () => {
  it('answers the planner’s call with the agent’s result, and the agent reads with the list it was given', async () => {
    const seen: ChatRequest[] = [];
    const delegate = call('call_planner_1', 'agent.delegate', { agent: 'reader', brief: 'Who knows the lamp failed?', scope: ['The Storm'] });
    const scripts: MockScript[] = [
      {
        match: (req) => (req.tools?.length ?? 0) > 0 && req.messages[0]?.content.startsWith(PLANNER_SYSTEM_PREFIX) === true,
        respond: (req) => (repliesOf(req) === 0 ? delegate : { content: 'Only the keeper knows.' }),
      },
      subagentScript((req) => (repliesOf(req) === 0 ? call('call_child_1', 'doc.read', { doc: 'The Storm' }) : { content: 'The keeper alone knows the lamp failed.' })),
    ];
    const base = await mockGateway(scripts);
    const gateway: Gateway = {
      ...base,
      modelCaps: () => ({ tools: true }),
      complete: (req, signal) => {
        seen.push(req);
        return base.complete(req, signal);
      },
    };
    const state = makeState();
    const harness = makeHarness({ ports: createAgentPorts() }, state);
    const session = createAgentSession({ harness, gateway, context: createContextPort({ state }), decide: async () => ({ action: 'approve' }), sessionId: 'native' });
    const report = await session.submit(INTENT, { preload: ['agent.delegate'] });

    expect(report.status).toBe('replied');
    expect(report.text).toBe('Only the keeper knows.');

    // The agent's requests declare its list and nothing else, and carry none of the planner's messages.
    const own = seen.filter((request) => request.agentPath !== undefined);
    expect(own).toHaveLength(2);
    expect(own.every((request) => request.agentPath === 'native.turn-1/reader#1' && request.turnId === 'native.turn-1')).toBe(true);
    expect((own[0]?.tools ?? []).map((tool) => tool.name).sort()).toEqual(childTools(READER, harness.tools()).map((tool) => tool.name).sort());
    expect(JSON.stringify(own[0]?.messages)).not.toContain(INTENT);
    // The second request answers the agent's call by its id, with the same list declared.
    expect(own[1]?.messages.find((message) => message.role === 'tool')?.toolCallId).toBe('call_child_1');
    expect(own[1]?.tools).toEqual(own[0]?.tools);

    // The planner's call is answered by its id, with the notice first and the notes as data.
    const planner = seen.filter((request) => request.agentPath === undefined);
    const answered = planner.at(-1)?.messages.find((message) => message.role === 'tool' && message.toolCallId === 'call_planner_1');
    const body = JSON.parse(answered?.content ?? '{}') as { ok?: boolean; data?: { notice?: string; summary?: string; status?: string } };
    expect(body.ok).toBe(true);
    expect(body.data?.notice).toBe(DELEGATE_NOTICE);
    expect(body.data?.summary).toBe('The keeper alone knows the lamp failed.');
    expect(body.data?.status).toBe('done');
    expect(harness.log.length).toBe(0);
  });
});
