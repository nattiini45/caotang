/**
 * A traced eval run (agent-harness §5.2, §9): `runScenario(scenario, { trace })` writes the same `caotang.trace/1` records the app keeps,
 * and two runs of one scenario write the same bytes.
 */

import { describe, expect, it } from 'vitest';

import { createTraceStore, parseTrace, runScenario, type Scenario, type TraceRecord } from '../../src/index.js';
import { makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { prose, steps, transcript } from '../agent/scripts.js';

// The storm already has a body, so the first draft is refused before its card and the planner is asked again: one turn, three calls.
const scenario: Scenario = {
  name: 'trace: a refused draft is adjusted and approved',
  category: 'verify-recovery',
  intent: 'Draft the storm again.',
  project: makeState,
  gateway: (_state, hooks) =>
    mockGateway(
      [
        transcript('Draft the storm again.', [
          steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The lamp fails and the keeper rows out to the wreck.', mode: 'draft' }, expect: 'The Storm is drafted' }),
          steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The lamp fails and the keeper rows out to the wreck.', mode: 'continue' }, expect: 'The Storm continues' }),
        ]),
        prose('Brief: The lamp fails', 'The keeper rows out to the wreck.'),
      ],
      hooks,
    ),
  expect: { status: 'applied' },
};

async function traced(): Promise<{ jsonl: string; records: readonly TraceRecord[]; modelCalls: number }> {
  const store = createTraceStore({ sessionId: 'eval' });
  const run = await runScenario(scenario, { trace: store });
  const jsonl = store.toJsonl();
  const parsed = parseTrace(jsonl);
  if (!parsed.ok) throw new Error(parsed.error);
  return { jsonl, records: parsed.value, modelCalls: run.report.modelCalls };
}

describe('a traced eval run', () => {
  it('writes byte-identical JSONL across two runs', async () => {
    const [first, second] = [await traced(), await traced()];
    expect(first.jsonl.length).toBeGreaterThan(1_000);
    expect(second.jsonl).toBe(first.jsonl);
  });

  it('holds every model call of the turn, the retry and the draft included, as a request and its response', async () => {
    const { records, modelCalls } = await traced();
    const requests = records.filter((record) => record.kind === 'model.request');
    const responses = records.filter((record) => record.kind === 'model.response');
    expect(modelCalls).toBe(3);
    expect(requests).toHaveLength(modelCalls);
    expect(responses).toHaveLength(modelCalls);
    expect(requests.map((record) => (record as { callIndex?: number }).callIndex)).toEqual([1, 2, 3]);
  });

  it('stamps the records from the run’s own clock, a millisecond apart, under the session name eval', async () => {
    const { records } = await traced();
    expect(new Set(records.map((record) => record.sessionId))).toEqual(new Set(['eval']));
    const turn = records.filter((record) => record.kind !== 'header' && record.kind !== 'message');
    const times = turn.map((record) => record.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
  });

  it('changes nothing about the run when no trace is asked for', async () => {
    const plain = await runScenario(scenario);
    const store = createTraceStore({ sessionId: 'eval' });
    const withTrace = await runScenario(scenario, { trace: store });
    expect(withTrace.report).toEqual(plain.report);
  });
});
