import { expect, it } from 'vitest';
import type { ChatRequest, TaskRole } from '@caotang/gateway';
import { createAgentPorts, createAgentSession, createContextPort, createHarness } from '../../src/index.js';
import { makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, transcript } from './scripts.js';

it('attributes multiple turns and role namespaces to one accounting session without mixing another visit', async () => {
  const seen: ChatRequest[] = [];
  const gateway = await mockGateway([transcript('Tell me.', [answer('Hello.')], seen)]);
  const profile = gateway.profiles.active()!;
  await gateway.profiles.update(profile.id, { pricePer1k: { prompt: 1, completion: 2 } });
  const make = (sessionId: string, usageSessionId?: string, role?: TaskRole) => {
    const state = makeState();
    return createAgentSession({
      harness: createHarness({ state, ports: createAgentPorts() }), gateway,
      context: createContextPort({ state }), decide: async () => ({ action: 'cancel' }),
      sessionId, ...(usageSessionId === undefined ? {} : { usageSessionId }),
      ...(role === undefined ? {} : { role }),
    });
  };
  const main = make('visit', 'visit');
  const first = await main.submit('Tell me.');
  const second = await main.submit('Tell me.');
  const role = await make('visit.background', 'visit', 'background').submit('Tell me.');
  await make('other').submit('Tell me.');
  expect(new Set([first.turnId, second.turnId, role.turnId]).size).toBe(3);
  expect(seen.map((request) => request.sessionId)).toEqual(['visit', 'visit', 'visit', 'other']);
  const totals = gateway.ledger.sessionTotals('visit');
  expect(totals.requests).toBe(first.tokens.requests + second.tokens.requests + role.tokens.requests);
  expect(totals.promptTokens).toBe(first.tokens.promptTokens + second.tokens.promptTokens + role.tokens.promptTokens);
  expect(totals.costUsd).toBeCloseTo(first.costUsd! + second.costUsd! + role.costUsd!, 10);
  expect(gateway.ledger.sessionTotals('other').requests).toBe(1);
  expect(gateway.ledger.turnRows().find((row) => row.role === 'background')).toMatchObject({ sessionId: 'visit', requests: 1 });
  expect(first.budgetUse.costUsd).toBe(first.costUsd);
});

it('keeps an explicit legacy budget price separate from the recorded turn cost', async () => {
  const gateway = await mockGateway([transcript('Tell me.', [answer('Hello.')])]);
  await gateway.profiles.update(gateway.profiles.active()!.id, { pricePer1k: { prompt: 1, completion: 2 } });
  const state = makeState();
  const session = createAgentSession({
    harness: createHarness({ state, ports: createAgentPorts() }), gateway,
    context: createContextPort({ state }), decide: async () => ({ action: 'cancel' }),
    price: () => ({ prompt: 1000, completion: 1000 }),
  });
  const report = await session.submit('Tell me.');
  expect(report.costUsd).toBe(gateway.ledger.turnTotals(report.turnId).costUsd);
  expect(report.costUsd).toBeCloseTo((report.tokens.promptTokens + 2 * report.tokens.completionTokens) / 1000, 10);
  expect(report.budgetUse.costUsd).toBe(report.tokens.promptTokens + report.tokens.completionTokens);
});
