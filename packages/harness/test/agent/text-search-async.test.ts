import { expect, it } from 'vitest';
import { createAgentSession, textSearchPort, type RuleSet } from '../../src/index.js';
import { LANDING, makeHarness } from '../fixtures.js';
import { mockGateway } from './gateway.js';

for (const native of [false, true]) it(`does not send stale asynchronous search results after a read-boundary change (native: ${native})`, async () => {
  let rules: RuleSet = { rules: [] };
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const harness = makeHarness({ rules: () => rules, asyncPorts: { 'text.search': async (params, context) => {
    const result = textSearchPort(params, context);
    expect(result).toMatchObject({ ok: true, value: { data: { total: 1 } } });
    started();
    await held;
    return result;
  } } });
  const real = await mockGateway([{ match: () => true, respond: () => {
    calls++;
    return native
      ? { content: '', toolCalls: [{ id: 'search', name: 'text.search', argumentsJson: JSON.stringify({ query: 'ferry' }) }], finishReason: 'tool_calls' }
      : { content: JSON.stringify({ steps: [{ tool: 'text.search', params: { query: 'ferry' }, expect: 'The passage is found.' }] }) };
  } }]);
  const session = createAgentSession({ harness, gateway: { ...real, modelCaps: () => ({ tools: native }) }, role: 'chat', decide: async () => ({ action: 'cancel' }) });
  const pending = session.submit('Find the ferry passage.', { preload: ['text.search'] });
  await entered;
  rules = { rules: [{ source: 'app', tool: 'doc.read', effect: 'deny', access: 'read', scope: { subtree: LANDING } }] };
  release();
  const report = await pending;
  expect(report).toMatchObject({ status: 'failed', tokens: { requests: 1 }, askBack: { code: 'needs_input' } });
  expect(report.askBack?.reason).toContain('read boundary');
  expect(calls).toBe(1);
});
