import { describe, expect, it } from 'vitest';
import type { BudgetSpend, RunEvent, TurnReport } from '@caotang/harness';
import type { TurnUsageRow } from '@caotang/gateway';
import type { AgentSessionRow, RunRow } from '@caotang/store';
import { newTurnRecord, type TurnRecord } from '../src/app/agent-model.js';
import { projectSessionTurn, recordedSessionTokens, sessionMarkdown, sessionPresentation } from '../src/app/agent-session-model.js';

const turnId = 'session.turn-1';
const report: TurnReport = {
  turnId, status: 'replied', summary: 'The lighthouse is empty.', text: 'The lighthouse is empty.',
  steps: [], cards: [], trace: [], tokens: { promptTokens: 100, completionTokens: 20, requests: 1 },
  dropped: [], modelCalls: 1, mode: 'ask', budgetUse: { wordsChanged: 0, documents: 0, modelCalls: 1, tokens: 120, steps: 0 },
};
const turn: TurnRecord = { ...newTurnRecord(turnId, 'Who is at the lighthouse?'), phase: 'done', mode: 'ask', report };
const run: RunRow = { schema: 3, runId: 'run_one', projectId: 'project', kind: 'turn', intent: turn.intent, createdAt: 1, updatedAt: 3, status: 'finished', outcome: 'replied' };
const events: RunEvent[] = [
  { t: 'turn.start', v: 3, seq: 0, at: 1, turnId, intent: turn.intent, wire: 'planner', native: false },
  { t: 'turn.end', seq: 1, at: 3, turnId, status: 'replied', summary: report.summary },
];
const session: AgentSessionRow = { projectId: 'project', sessionId: 'session', formatVersion: 1, title: turn.intent, createdAt: 1, updatedAt: 3, active: true, turns: [{ runId: run.runId, role: 'chat' }] };
const spend: BudgetSpend = { promptTokens: 90, completionTokens: 15, modelCalls: 2, estimatedTokens: 4, costUsd: 0.03, steps: 1, activeMs: 125 };

describe('settled session presentation boundary', () => {
  it.each(['planning', 'running', 'awaiting-approval'] as const)('settles a %s view from its report before the final phase event arrives', (phase) => {
    const presentation = sessionPresentation({ ...turn, phase }, false);
    expect(presentation.turn.phase).toBe('done');
    expect(presentation.turn.report).toEqual(report);
    expect(projectSessionTurn({ ...run, presentation }, events)?.turn.phase).toBe('done');
  });

  it.each([
    { steering: [null] },
    { tasks: {} },
    { tasks: { ...turn.tasks, items: [null] } },
    { tasks: { ...turn.tasks, items: [{ key: 'one', content: 'Read', activeForm: 'Reading', state: 'done', contentRef: { id: 'bad' } }] } },
    { plan: { steps: [null] } },
    { cards: [null] },
    { cards: [{ id: 'call', args: {}, delegation: { trace: [null] } }] },
    { findings: [null] },
    { ladder: [{ callId: 'call', attempt: 1, askBack: { options: [null] } }] },
    { checkpoint: {} },
    { phase: 'unrecognized' },
    { report: { ...report, status: 'invented' } },
    { report: { ...report, tokens: { ...report.tokens, promptTokens: -1 } } },
    { report: { ...report, tokens: { ...report.tokens, completionTokens: Infinity } } },
    { report: { ...report, usage: [null] } },
    { report: { ...report, steering: [null] } },
    { report: { ...report, cache: { misses: [null] } } },
    { report: { ...report, heldSteps: [{ params: null }] } },
  ])('falls back to v3 events for damaged nested presentation %j', (changed) => {
    const projected = projectSessionTurn({ ...run, presentation: { version: 1, hidden: false, turn: { ...turn, ...changed } } }, events);
    expect(projected?.turn.report?.summary).toBe(report.summary);
    expect(projected?.turn.accountingUnavailable).toBe(true);
    expect(projected?.turn.cards).toEqual([]);
  });

  it('keeps valid presentation metadata and strips unknown fields at every structural level', () => {
    const source = { ...turn, unwanted: 'turn sentinel', tasks: { ...turn.tasks, unwanted: 'task sentinel' }, report: { ...report, unwanted: 'report sentinel', tokens: { ...report.tokens, unwanted: 'token sentinel' } } };
    const presentation = sessionPresentation(source, true);
    const restored = projectSessionTurn({ ...run, presentation }, events);
    expect(restored?.turn.report?.tokens).toEqual(report.tokens);
    expect(restored?.turn.tasks.items).toEqual([]);
    expect(JSON.stringify(presentation)).not.toContain('sentinel');
    expect(recordedSessionTokens({ ...run, presentation })).toBe(120);
  });

  it('omits undelivered notes in both steering locations, previews, ghost, reasoning, streams and credential fields', () => {
    const notes = [{ noteId: 'delivered', text: 'Keep the door blue.', deliveredAtCall: 1 }, { noteId: 'draft', text: 'undelivered sentinel' }];
    const source = {
      ...turn, steering: notes, reasoning: 'reasoning sentinel', streamed: 'stream sentinel', ghost: { text: 'ghost sentinel' }, requestContext: { preview: 'preview sentinel' },
      report: { ...report, steering: notes, trace: [{ tool: 'doc.read', callId: 'read', outcome: 'ok', params: { doc: 'scene', apiKey: 'credential sentinel', authorization: 'header sentinel', nested: { customHeaders: { key: 'nested sentinel' } } } }] },
    } as unknown as TurnRecord;
    const presentation = sessionPresentation(source, false);
    expect(presentation.turn.steering).toEqual([notes[0]]);
    expect(presentation.turn.report?.steering).toEqual([notes[0]]);
    expect(presentation.turn.reasoning).toBe('');
    expect(presentation.turn.ghost).toBeNull();
    expect(presentation.turn.streamed).toBe('');
    expect(presentation.turn.requestContext).toBeUndefined();
    expect(JSON.stringify(presentation)).not.toContain('sentinel');
    expect(sessionMarkdown(session, [source])).not.toContain('sentinel');
  });

  it('keeps the last plan read-only without its draft and request previews', () => {
    const source: TurnRecord = { ...turn, plan: {
      id: 'plan', turnId, kind: 'plan', revision: 1, previewRevision: 1, from: 0, approvable: true, canAcceptCut: true, cut: false,
      steps: [{ index: 0, origin: 0, tool: 'scene.draft', expect: 'Draft', risk: 'write-confirm', params: { doc: 'scene' }, status: 'done', badges: [], stale: false, cut: false,
        preview: { text: 'draft sentinel' }, context: { layers: ['context sentinel'] } as never }],
    } };
    const presentation = sessionPresentation(source, false);
    expect(presentation.turn.plan).toMatchObject({ approvable: false, canAcceptCut: false });
    expect(JSON.stringify(presentation)).not.toContain('sentinel');
    expect(projectSessionTurn({ ...run, presentation }, events)?.turn.plan?.steps).toHaveLength(1);
  });

  it('uses the same credential scrubbing in Markdown text as in its front matter', () => {
    const source = { ...turn, report: { ...report, text: 'A provider replied: Bearer example-secret-token' } };
    const markdown = sessionMarkdown(session, [source]);
    expect(markdown).not.toContain('example-secret-token');
    expect(markdown).toContain('Bearer [redacted]');
  });

  it('does not use an optional presentation to bypass invalid v3 events or a mismatching turn end', () => {
    const presentation = sessionPresentation(turn, false);
    expect(projectSessionTurn({ ...run, presentation }, [{ ...events[0], v: 4 }, events[1]])).toBeNull();
    expect(projectSessionTurn({ ...run, presentation }, [events[0], { ...events[1], turnId: 'other.turn-1' }])).toBeNull();
  });
});

describe('legacy v3 session accounting', () => {
  const stoppedEvents: RunEvent[] = [events[0]!, { t: 'spend', seq: 1, at: 2, turnId, spend, reservedCalls: 0 }, { t: 'turn.end', seq: 2, at: 3, turnId, status: 'cancelled', summary: 'Stopped by you.' }];

  it('recovers recorded spend and stopped outcome without a presentation', () => {
    const projected = projectSessionTurn({ ...run, outcome: 'stopped' }, stoppedEvents);
    expect(projected?.turn).not.toHaveProperty('accountingUnavailable');
    expect(projected?.turn.report).toMatchObject({ tokens: { promptTokens: 90, completionTokens: 15, requests: 2 }, modelCalls: 2, spend, costUsd: 0.03, stop: { by: 'user' } });
    expect(recordedSessionTokens({ ...run, presentation: projected })).toBe(105);
  });

  it('uses matching durable ledger rows, including cache, reasoning and recorded prices, without another call', () => {
    const row: TurnUsageRow = { version: 1, turnId, sessionId: 'session', profileId: 'profile', model: 'mock', role: 'chat', promptTokens: 100, completionTokens: 20, requests: 2,
      cachedPromptTokens: 30, cacheWritePromptTokens: 10, reasoningTokens: 5, estimatedRequests: 1, unpricedRequests: 0, providerCostRequests: 1, costUsd: 0.04 };
    const requested: string[] = [];
    const projected = projectSessionTurn({ ...run, outcome: 'stopped' }, stoppedEvents, (id) => {
      requested.push(id);
      return [row, { ...row, turnId: 'foreign.turn-1', promptTokens: 9999 }, { ...row, promptTokens: -1 }];
    });
    expect(requested).toEqual([turnId]);
    expect(projected?.turn.report).toMatchObject({ tokens: { promptTokens: 100, completionTokens: 20, requests: 2 }, costUsd: 0.04, usage: [row], spend });
    expect(recordedSessionTokens({ ...run, presentation: projected })).toBe(120);
  });

  it('marks accounting unavailable instead of inventing a recorded zero', () => {
    const projected = projectSessionTurn(run, events);
    expect(projected?.turn.accountingUnavailable).toBe(true);
    expect(recordedSessionTokens(run)).toBeNull();
    expect(recordedSessionTokens({ ...run, presentation: projected })).toBeNull();
    expect(sessionMarkdown(session, [projected!.turn])).toContain('"accountingUnavailable": true');
  });

  it('keeps finite fractional token amounts accepted by the v3 spend validator', () => {
    const fractional: RunEvent[] = [events[0]!, { t: 'spend', seq: 1, at: 2, turnId, spend: { ...spend, promptTokens: 90.5 }, reservedCalls: 0 }, { ...events[1]!, seq: 2 }];
    const projected = projectSessionTurn(run, fractional)!;
    expect(recordedSessionTokens({ ...run, presentation: sessionPresentation(projected.turn, false) })).toBe(105.5);
  });

  it.each([undefined, null, {}, { promptTokens: -1, completionTokens: 2, requests: 1 }, { promptTokens: 1, completionTokens: NaN, requests: 1 }])('does not convert absent or damaged counters to zero: %j', (saved) => {
    expect(recordedSessionTokens({ ...run, presentation: { version: 1, turn: { report: { tokens: saved } } } })).toBeNull();
  });
});

it('measures a reproducible 100-turn presentation fixture with 64 KiB draft and context previews per turn', () => {
  const turns: TurnRecord[] = Array.from({ length: 100 }, (_, index) => ({
    ...turn, turnId: `session.turn-${index + 1}`, report: { ...report, turnId: `session.turn-${index + 1}` },
    tasks: { ...turn.tasks, turnId: `session.turn-${index + 1}` },
    reasoning: 'Thinking about the lighthouse. '.repeat(100), streamed: 'An unfinished sentence. '.repeat(100),
    plan: {
      id: `plan-${index + 1}`, turnId: `session.turn-${index + 1}`, kind: 'plan', revision: 1, previewRevision: 1, from: 0, approvable: true, canAcceptCut: false, cut: false,
      steps: [{ index: 0, origin: 0, tool: 'scene.draft', expect: 'Draft the scene.', risk: 'write-confirm', params: { doc: 'scene' }, status: 'done', badges: [], stale: false, cut: false,
        preview: { text: 'd'.repeat(64 * 1024) }, context: { layers: [{ text: 'c'.repeat(64 * 1024) }] } as never }],
    },
  }));
  const before = new TextEncoder().encode(JSON.stringify(turns)).byteLength;
  const stored = turns.map((value) => sessionPresentation(value, false));
  const after = new TextEncoder().encode(JSON.stringify(stored)).byteLength;
  expect(stored).toHaveLength(100);
  expect(after).toBeLessThan(before);
  expect(stored.every((value) => value.turn.plan?.steps[0]?.preview === undefined && value.turn.plan?.steps[0]?.context === undefined && value.turn.reasoning === '' && value.turn.streamed === '')).toBe(true);
  console.warn(`100-turn presentation fixture: ${before} source bytes; ${after} stored bytes; ${before - after} bytes omitted.`);
});
