import { describe, expect, it } from 'vitest';
import type { TurnReport } from '@caotang/sdk';

import { ASK_BACK_EXIT_CODES, ExitCode, exitCodeOf, REPORT_STATUS_EXIT_CODES } from '../src/output.js';

const base: TurnReport = {
  turnId: 't',
  status: 'failed',
  summary: '',
  steps: [],
  cards: [],
  trace: [],
  tokens: { promptTokens: 0, completionTokens: 0, requests: 0 },
  dropped: [],
  modelCalls: 0,
  mode: 'ask',
  budgetUse: { modelCalls: 0, tokens: 0, wordsChanged: 0, documents: 0, steps: 0 },
};

const statuses = ['replied', 'applied', 'failed', 'cancelled'] as const satisfies readonly TurnReport['status'][];
const askBacks = [
  ['needs_input', 4],
  ['budget_exhausted', 4],
  ['hook_blocked', 4],
  ['conflict', 5],
  ['anchor_unresolvable', 5],
  ['verify_failed', 6],
] as const satisfies readonly (readonly [NonNullable<TurnReport['askBack']>['code'], ExitCode])[];

describe('the public CLI exit mapping', () => {
  it('keeps every published number unchanged, including caller-owned usage, lock and signal codes', () => {
    expect(ExitCode).toEqual({ Ok: 0, Internal: 1, Usage: 2, Locked: 3, NeedsInput: 4, Conflict: 5, VerifyFailed: 6, Interrupted: 130, Terminated: 143 });
  });

  it('covers all report statuses and all ask-back codes in tables', () => {
    expect(Object.keys(REPORT_STATUS_EXIT_CODES).sort()).toEqual([...statuses].sort());
    expect(Object.keys(ASK_BACK_EXIT_CODES).sort()).toEqual(askBacks.map(([code]) => code).sort());
    expect(REPORT_STATUS_EXIT_CODES).toEqual({ replied: 0, applied: 0, failed: 1, cancelled: 4 });
    expect(ASK_BACK_EXIT_CODES).toEqual(Object.fromEntries(askBacks));
  });

  it.each(statuses)('maps %s without an ask-back to its status fallback', (status) => {
    const expected = status === 'replied' || status === 'applied' ? 0 : status === 'cancelled' ? 4 : 1;
    expect(exitCodeOf({ ...base, status })).toBe(expected);
  });

  it.each(statuses)('maps every ask-back for %s, with successful status taking precedence', (status) => {
    for (const [code, exitCode] of askBacks) {
      const report: TurnReport = { ...base, status, askBack: { code, reason: '', options: [] } };
      expect(exitCodeOf(report)).toBe(status === 'replied' || status === 'applied' ? 0 : exitCode);
    }
  });
});
