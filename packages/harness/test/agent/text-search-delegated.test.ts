import { expect, it } from 'vitest';
import { textOf, type ChatRequest } from '@caotang/gateway';
import type { MockResponse } from '@caotang/gateway/mock';
import { createAgentPorts, createAgentSession, textSearchPort } from '../../src/index.js';
import { makeHarness } from '../fixtures.js';
import { mockGateway } from './gateway.js';

for (const native of [false, true]) for (const agent of ['reader', 'general'] as const) it(`runs asynchronous search for the ${agent} delegate (native: ${native})`, async () => {
  let searches = 0;
  let signal: AbortSignal | undefined;
  const harness = makeHarness({ ports: createAgentPorts(), asyncPorts: { 'text.search': async (params, context) => {
    searches++;
    signal = context.signal;
    return textSearchPort(params, context);
  } } });
  const own: ChatRequest[] = [];
  const call = (name: string, params: unknown): MockResponse => native
    ? { content: '', toolCalls: [{ id: name, name, argumentsJson: JSON.stringify(params) }], finishReason: 'tool_calls' }
    : { content: JSON.stringify({ steps: [{ tool: name, params, expect: 'The passage is found.' }] }) };
  const reply = (text: string): MockResponse => ({ content: native ? text : JSON.stringify({ reply: text }) });
  const real = await mockGateway([{ match: () => true, respond: (request) => {
    const replies = request.messages.filter((message) => message.role === 'assistant').length;
    if (request.agentPath !== undefined) {
      own.push(request);
      return replies === 0 ? call('text.search', { query: 'ferry' }) : reply('The ferry is in The Landing.');
    }
    return replies === 0 ? call('agent.delegate', { agent, brief: 'Find the ferry passage.' }) : reply('The delegate found the ferry.');
  } }]);
  const controller = new AbortController();
  const session = createAgentSession({ harness, gateway: { ...real, modelCaps: () => ({ tools: native }) }, role: 'chat', decide: async () => ({ action: 'cancel' }) });
  const report = await session.submit('Ask a delegate to find the ferry.', { preload: ['agent.delegate'], signal: controller.signal });
  expect(report).toMatchObject({ status: 'replied', tokens: { requests: 4 } });
  expect(searches).toBe(1);
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(false);
  expect(own).toHaveLength(2);
  expect(own[1]!.agentPath).toContain(`/${agent}#1`);
  expect(own[1]!.messages.map((message) => textOf(message.content)).join('\n')).toContain('The ferry was late, as always.');
  expect(report.trace).toContainEqual(expect.objectContaining({ tool: 'text.search', outcome: 'ok', agentPath: own[1]!.agentPath }));
  expect(harness.log.length).toBe(0);
});
