import { describe, expect, it } from 'vitest';

import { promptTokensOf, textOf, type ChatRequest, type Gateway } from '@caotang/gateway';
import { setBody } from '@caotang/store';

import { createAgentSession, type AgentEvent } from '../../src/index.js';
import { FRIEND, LANDING, makeHarness, STORM } from '../fixtures.js';
import { mockGateway } from './gateway.js';

describe('planner window preflight', () => {
  it('asks for input with the known limits before sending an oversized first request', async () => {
    const requests: ChatRequest[] = [];
    const real = await mockGateway([{ match: () => true, respond: () => ({ content: '{"reply":"Done."}' }) }]);
    const gateway: Gateway = {
      ...real,
      modelLimits: () => ({ contextWindow: 100, maxOutputTokens: 20 }),
      complete: (request, signal) => {
        requests.push(request);
        return real.complete(request, signal);
      },
    };
    const session = createAgentSession({ harness: makeHarness(), gateway, decide: async () => ({ action: 'cancel' }), sessionId: 'small-window' });

    const report = await session.submit('Tell me about the lighthouse.');

    expect(report.status).toBe('failed');
    expect(report.askBack).toMatchObject({
      code: 'needs_input',
      options: ['Compact the conversation', 'Raise the budget', 'Start a new session'],
      window: { promptTokens: expect.any(Number), reserveTokens: 2020, windowTokens: 100 },
    });
    expect(report.askBack?.reason).toContain('100');
    expect(report.askBack?.reason).toContain('2020');
    expect(report.modelCalls).toBe(0);
    expect(requests).toEqual([]);
  });

  it('clears an old native result before the next request and meters the messages actually sent', async () => {
    const requests: ChatRequest[] = [];
    const events: AgentEvent[] = [];
    const harness = makeHarness();
    for (const [doc, letter] of [[LANDING, 'L'], [STORM, 'S'], [FRIEND, 'F']] as const) setBody(harness.state, doc, letter.repeat(20_000));
    const calls = [LANDING, STORM, FRIEND].map((doc, index) => ({
      id: `read-${index}`, name: 'doc.read', argumentsJson: JSON.stringify({ doc }),
    }));
    const real = await mockGateway([{
      match: () => true,
      respond: (request) => request.messages.some((message) => message.role === 'tool')
        ? { content: 'The final chapter is at the river.' }
        : { content: '', toolCalls: calls, reasoning: 'Read the three chapters in order.' },
    }]);
    const gateway: Gateway = {
      ...real,
      modelCaps: () => ({ tools: true }),
      modelLimits: () => ({ contextWindow: 20_000, maxOutputTokens: 4_096 }),
      complete: (request, signal) => {
        requests.push(structuredClone(request));
        return real.complete(request, signal);
      },
    };
    const session = createAgentSession({
      harness, gateway, emit: (event) => events.push(event),
      compaction: { keepToolResults: 1 }, decide: async () => ({ action: 'approve' }), sessionId: 'native-window',
    });

    const report = await session.submit('Read all three chapters.');

    expect(report.status).toBe('replied');
    expect(report.modelCalls).toBe(2);
    expect(report.tokens.requests).toBe(2);
    expect(requests).toHaveLength(2);
    const sent = requests[1]!.messages;
    expect(sent.filter((message) => message.role === 'tool').map((message) => message.toolCallId)).toEqual(['read-0', 'read-1', 'read-2']);
    expect(textOf(sent.find((message) => message.toolCallId === 'read-0')!.content)).toContain('result cleared to save room');
    expect(textOf(sent.find((message) => message.toolCallId === 'read-2')!.content)).toContain('F'.repeat(1_000));
    expect(sent.find((message) => message.role === 'assistant')?.toolCalls).toEqual(calls);
    expect(sent.find((message) => message.role === 'assistant')?.reasoning?.[0]?.text).toBe('Read the three chapters in order.');
    const cleared = events.filter((event) => event.type === 'context.cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.cleared.map((result) => result.toolCallId)).toEqual(['read-0']);
    const metered = events.filter((event) => event.type === 'context-meter').at(-1);
    expect(metered?.meter.promptTokens).toBe(promptTokensOf(sent));
    expect(metered?.preview.payload.map(({ role, content }) => ({ role, content }))).toEqual(sent.map(({ role, content }) => ({ role, content })));
  });
});
