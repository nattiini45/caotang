import { expect, test } from '@playwright/test';
import { EMPTY_BUDGET_USE, type PlanCardView, type TurnReport } from '../../packages/harness/src/index.js';
import { assemble, buildPreview, meterOf } from '../../packages/context/src/index.js';
import { newTurnView, reduceTurn } from '../../apps/desktop/src/app/agent-model.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';

test('a report releases the live conversation preview while retaining the existing step preview', () => {
  const turnId = 'context.turn-1';
  const prompt = assemble({ tool: 'meta', instruction: 'Consider the scene.' }, { state: sampleProjectState() });
  const preview = buildPreview(prompt);
  const livePreview = { ...preview, payload: [...preview.payload, { role: 'user' as const, content: 'LIVE_ONLY_CONVERSATION' }] };
  const card: PlanCardView = {
    id: 'card', turnId, kind: 'plan', revision: 0, previewRevision: 0, from: 0, approvable: true, canAcceptCut: false, cut: false,
    steps: [{ index: 0, origin: 0, tool: 'scene.draft', expect: 'Drafted.', risk: 'write-confirm', params: {}, status: 'ready', badges: [], stale: false, cut: false, context: preview }],
  };
  const shown = reduceTurn(newTurnView(turnId, 'Consider the scene.'), { type: 'plan', turnId, card });
  const running = reduceTurn(shown, { type: 'context-meter', turnId, preview: livePreview, meter: meterOf(prompt) });
  expect(running.requestContext?.preview).toBe(livePreview);
  const report: TurnReport = {
    turnId, status: 'applied', summary: 'Drafted.', steps: [], cards: [], trace: [], tokens: { promptTokens: 1, completionTokens: 1, requests: 1 },
    dropped: [], modelCalls: 1, mode: 'ask', budgetUse: EMPTY_BUDGET_USE,
  };
  const finished = reduceTurn(running, { type: 'report', turnId, report });
  expect(finished.requestContext).toBeUndefined();
  expect(finished.plan?.steps[0]?.context).toBe(preview);
  expect(JSON.stringify(finished)).not.toContain('LIVE_ONLY_CONVERSATION');
  expect(running.requestContext?.preview).toBe(livePreview);
});
