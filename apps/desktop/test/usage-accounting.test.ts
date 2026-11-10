import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sumUsage, type DayUsageRow } from '@caotang/gateway';
import { groupUsage } from '../src/app/usage-model.js';
import { usageCsv } from '../src/app/usage-export.js';
import { activityMarkdown } from '../src/app/activity-model.js';
import { newTurnView } from '../src/app/agent-model.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';
import type { TurnReport } from '@caotang/harness';
import { formatUsd } from '../src/app/plan-preview.js';

const row: DayUsageRow = {
  ...sumUsage([]), version: 1, date: '2026-11-10', profileId: 'profile', model: 'model', role: 'chat',
  requests: 1, promptTokens: 100, completionTokens: 20, cachedPromptTokens: 40, reasoningTokens: 5, costUsd: 0.125,
};

describe('the usage readers', () => {
  it('formats USD with the interface locale while keeping four/two decimal places and the small-cost floor', () => {
    activateEnglish();
    expect(formatUsd(0.067, 'en-US')).toBe('$0.0670');
    expect(formatUsd(1.5, 'en-US')).toBe('$1.50');
    expect(formatUsd(0.00001, 'en-US')).toBe('under $0.0001');
    expect(formatUsd(0.067, 'de-DE')).toBe('0,0670\u00a0$');
    expect(formatUsd(1.5, 'de-DE')).toBe('1,50\u00a0$');
    expect(formatUsd(0.00001, 'de-DE')).toBe('under 0,0001\u00a0$');
  });
  it('translates the small-cost floor without pinning the USD amount to English punctuation', async () => {
    await activateCatalogue('de');
    try {
      expect(formatUsd(0.00001, 'de-DE')).toBe('unter 0,0001\u00a0$');
    } finally {
      activateEnglish();
    }
  });
  it('keeps recorded cost and incomplete/estimated coverage in the Activity Markdown export', () => {
    activateEnglish();
    const report: TurnReport = {
      turnId: 'turn', status: 'replied', summary: 'Done.', steps: [], cards: [], trace: [], dropped: [], modelCalls: 1, mode: 'ask',
      tokens: { promptTokens: 100, completionTokens: 20, requests: 2 }, costUsd: 0.125,
      usage: [{ ...row, turnId: 'turn', requests: 2, estimatedRequests: 1, unpricedRequests: 1 }],
      budgetUse: { modelCalls: 1, tokens: 120, wordsChanged: 0, documents: 0, steps: 0, costUsd: 0.125 },
    };
    const markdown = activityMarkdown({ title: 'Usage', entries: [], turns: [{ ...newTurnView('turn', 'Answer.'), report }], now: 0 });
    expect(markdown).toContain('- Recorded cost: about $0.1250');
    expect(markdown).toContain('- Includes estimated token counts.');
    expect(markdown).toContain('- 1 request has no recorded cost.');
  });
  it('keeps the old whole-turn Chat-profile price path out of the display readers', () => {
    for (const file of ['../src/app/agent.ts', '../src/app/agent-model.ts', '../src/app/plan-preview.ts', '../src/components/AgentPanel.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toContain('turnCostOf');
      expect(source, file).not.toContain('priceForNextTurn');
      expect(source, file).not.toMatch(/(?:promptTokens|completionTokens)\s*\*\s*[^\n]*price/);
    }
  });
  it('groups turn and delegated rows by profile, model and role without repricing or changing them', () => {
    const rows = [row, { ...row, estimatedRequests: 1, unpricedRequests: 1, costUsd: undefined }, { ...row, role: 'drafting' as const, costUsd: 0 }];
    const before = structuredClone(rows);
    const groups = groupUsage(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ requests: 2, promptTokens: 200, completionTokens: 40, cachedPromptTokens: 80, reasoningTokens: 10, estimatedRequests: 1, unpricedRequests: 1, costUsd: 0.125 });
    expect(groups[1]).toMatchObject({ role: 'drafting', requests: 1, costUsd: 0 });
    expect(sumUsage(groups)).toMatchObject({ requests: 3, costUsd: 0.125, unpricedRequests: 1 });
    expect(rows).toEqual(before);
    expect(sumUsage([]).costUsd).toBeUndefined();
  });

  it('exports stable daily CSV headers, raw decimals and coverage counts, not manuscript or credentials', () => {
    const extra = { ...row, estimatedRequests: 1, unpricedRequests: 1, providerCostRequests: 1, prompt: 'DO_NOT_EXPORT_TEXT', apiKey: 'DO_NOT_EXPORT_CREDENTIAL' };
    const csv = usageCsv([extra, { ...row, costUsd: undefined }], new Map([['profile', 'My profile']]));
    expect(csv.split('\r\n')[0]).toBe('day,profile_id,profile,model,role,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,estimated_requests,unpriced_requests,provider_cost_requests,cost_usd');
    expect(csv).toContain('2026-11-10,profile,My profile,model,chat,1,100,20,40,0,5,1,1,1,0.125\r\n');
    expect(csv.split('\r\n')[2]).toMatch(/,$/);
    expect(csv).not.toContain('DO_NOT_EXPORT');
    expect(csv).not.toContain('$');
  });

  for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
    it(`guards spreadsheet formulas in names and model ids beginning with ${JSON.stringify(prefix)}`, () => {
      const csv = usageCsv([{ ...row, model: `${prefix}MODEL` }], new Map([['profile', `${prefix}PROFILE`]]));
      expect(csv).toContain(`'${prefix}MODEL`);
      expect(csv).toContain(`'${prefix}PROFILE`);
    });
  }

  it('quotes commas, quotes and line breaks in supplied names', () => {
    const csv = usageCsv([row], new Map([['profile', 'Name, "quoted"\ncontinued']]));
    expect(csv).toContain('"Name, ""quoted""\ncontinued"');
  });
});
