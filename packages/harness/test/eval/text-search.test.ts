import { describe, expect, it } from 'vitest';
import { plannerScript, userTextOf } from '@caotang/gateway/mock';
import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { LANDING, makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { answer, steps } from '../agent/scripts.js';

describe('lexical search scenario', () => {
  it('finds the first ferry passage with two planner calls and no manuscript change', async () => {
    const scenario: Scenario = {
      name: 'find the first ferry mention', category: 'multi-step', intent: 'Where did I first mention the ferry?', project: makeState,
      preload: ['text.search'],
      gateway: () => mockGateway([plannerScript((request) => {
        const user = userTextOf(request);
        if (!user.includes('"tool":"text.search","ok":true')) return steps({ tool: 'text.search', params: { query: 'ferry', fields: ['body'] }, expect: 'The matching passage is found.' });
        return answer(user.includes(LANDING) && user.includes('The ferry was late') ? 'The first ferry mention is in The Landing.' : 'No ferry passage was found.');
      })]),
      expect: { status: 'replied', summaryIncludes: ['The first ferry mention is in The Landing.'], maxModelCalls: 2, ledgerRequests: 2, maxTokens: 20_000,
        cards: { matcher: 'strict', items: [] }, reached: { 'text.search': 'preload' },
        trace: { matcher: 'strict', calls: [{ tool: 'text.search', outcome: 'ok' }] },
      },
    };
    const result = await evaluate(scenario);
    expect(result.failures).toEqual([]);
    expect(result.run.requests).toHaveLength(2);
    expect(result.run.report.steps).toHaveLength(1);
    expect(result.run.state.documents.get(LANDING)?.body).toBe('The ferry was late, as always.');
  });
});
