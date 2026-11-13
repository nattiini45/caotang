import { describe, expect, it } from 'vitest';
import { textOf } from '@caotang/gateway';
import { demoScripts, plannerScript, userTextOf } from '@caotang/gateway/mock';
import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { answer, steps } from '../agent/scripts.js';

describe('long-session scenarios', () => {
  it('recalls the first answer at turn six through deferred discovery and one session.history read', async () => {
    const firstAnswer = 'The ferryman holds the sealed letter.';
    const scenario: Scenario = {
      name: 'turn-six recall through session.history', category: 'multi-step', intent: 'Recall the first answer exactly.', project: makeState,
      priorIntents: ['Who has the sealed letter?', 'Keep the storm.', 'Keep the lighthouse.', 'Keep the ferry.', 'Keep the harbour.'],
      gateway: () => mockGateway([plannerScript((request) => {
        const user = userTextOf(request);
        if (!user.includes('Request: Recall the first answer exactly.')) return answer(user.includes('Request: Who has the sealed letter?') ? firstAnswer : 'Noted.');
        const calls = request.messages.filter((message) => message.role === 'assistant').length;
        if (calls === 0) return steps({ tool: 'tool.search', params: { query: 'session.history' }, expect: 'Earlier conversation can be read' });
        if (calls === 1) return steps({ tool: 'session.history', params: { limit: 5 }, expect: 'The first answer is recovered' });
        return answer(user.includes(firstAnswer) ? firstAnswer : 'The first answer was not recovered.');
      })]),
      expect: { status: 'replied', summaryIncludes: [firstAnswer], maxTokens: 20_000, maxModelCalls: 3,
        cards: { matcher: 'strict', items: [] }, reached: { 'session.history': 'search' },
        trace: { matcher: 'strict', calls: [{ tool: 'tool.search', outcome: 'ok' }, { tool: 'session.history', outcome: 'ok' }] },
      },
    };
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    expect(result.run.report.turnId).toBe('eval.turn-6');
    expect(result.run.requests).toHaveLength(3);
    expect(result.run.requests[0]!.messages.map((message) => textOf(message.content)).join('\n')).not.toContain(firstAnswer);
    expect(result.run.requests.at(-1)!.messages.map((message) => textOf(message.content)).join('\n')).toContain(firstAnswer);
    expect(result.run.report.trace.filter((entry) => entry.tool === 'session.history')).toHaveLength(1);
  });

  it('automatically folds seven real earlier turns with the keyless Background demo script', async () => {
    const scenario: Scenario = {
      name: 'keyless automatic conversation compaction', category: 'demo', intent: 'Continue the conversation.', project: makeState,
      priorIntents: Array.from({ length: 7 }, (_, index) => `Prior request ${index + 1}.`),
      gateway: () => mockGateway([plannerScript(() => answer('Noted.')), ...demoScripts]),
      expect: { status: 'replied', maxTokens: 15_000, maxModelCalls: 2, ledgerRequests: 2, cards: { matcher: 'strict', items: [] }, trace: { matcher: 'strict', calls: [] } },
    };
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    expect(result.run.report.turnId).toBe('eval.turn-8');
    expect(result.run.requests.map((request) => request.role)).toEqual(['background', undefined]);
    const compacted = result.run.events.find((event) => event.type === 'session.compacted');
    expect(compacted).toMatchObject({ summary: { origin: 'auto', covers: { from: 'eval.turn-1', to: 'eval.turn-5', turns: 5 } } });
    const planner = result.run.requests.at(-1)!.messages.map((message) => textOf(message.content)).join('\n');
    expect(planner).toContain('## Session summary');
    expect(planner).toContain('Prior request 6.');
    expect(planner).toContain('Prior request 7.');
    expect(result.run.report.compactions).toMatchObject([{ status: 'replied', usage: [{ role: 'background', requests: 1 }] }]);
  });

  it('refuses a known tiny model window with numbers and recovery choices before sending a request', async () => {
    const scenario: Scenario = {
      name: 'planner window preflight refusal', category: 'verify-recovery', intent: 'Read the project.', project: makeState,
      gateway: async () => ({ ...await mockGateway([]), modelLimits: () => ({ contextWindow: 1, maxOutputTokens: 1 }) }),
      expect: { status: 'failed', askBack: 'needs_input', maxTokens: 0, maxModelCalls: 0, ledgerRequests: 0, cards: { matcher: 'strict', items: [] }, trace: { matcher: 'strict', calls: [] } },
    };
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    expect(result.run.requests).toEqual([]);
    expect(result.run.report.askBack?.reason).toContain("this model's window is 1 tokens");
    expect(result.run.report.askBack?.options).toEqual(['Compact the conversation', 'Raise the budget', 'Start a new session']);
  });
});
