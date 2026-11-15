import { describe, expect, it } from 'vitest';

import type { PlanStep } from '@caotang/harness';
import { asTaskRecord, reviewOf, type TaskRecord } from '../src/app/task-store.js';

const PROJECT = 'p_REVIEWSTORE';
const reviewStep: PlanStep = { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' };
const draftStep: PlanStep = { tool: 'scene.draft', params: { doc: 'Scene', instruction: 'Open.', mode: 'draft' }, expect: 'A draft' };

function approval(): Record<string, unknown> {
  return {
    plan: {
      scopeDocIds: ['sA'],
      documents: [{ docId: 'sA', title: 'First', estimatedTokens: 10, truncated: false, codexDropped: [], storyDropped: [] }],
      categories: ['factual'],
      maxFindings: 50,
      estimate: { extractCalls: 1, extractTokens: 10, verifyCallsAtMost: 0, verifyTokensAtMost: 0, totalTokensAtMost: 10 },
      overGuard: false,
      promptPreview: 'prompt',
    },
    route: { profileId: 'p_MOCK000001', model: 'fake', label: 'Mock, fake' },
    callBound: { extractCalls: 1, verifyCallsAtMost: 0 },
    scopeDocIds: ['sA'],
    categories: ['factual'],
    maxFindings: 50,
    fingerprint: 'fp-1',
  };
}

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task_TEST000001',
    projectId: PROJECT,
    intent: 'Review.',
    steps: [reviewStep],
    status: 'queued',
    items: [{ key: '0', step: 0, state: 'pending' }],
    cap: 1,
    used: 0,
    promptTokens: 0,
    completionTokens: 0,
    runs: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

describe('a stored review record is validated, and a legacy draft record keeps its meaning', () => {
  it('accepts a legacy draft-only record with no review metadata', () => {
    const legacy = record({ steps: [draftStep], items: [{ key: '0', step: 0, state: 'staged', proposal: { text: 'x' } }] });
    expect(asTaskRecord(legacy, PROJECT)).toBeDefined();
  });

  it('accepts a well-shaped review record', () => {
    expect(asTaskRecord(record({ kind: 'review', review: approval(), reviewRunId: 'r_QUEUED0001' }), PROJECT)).toBeDefined();
  });

  it('refuses malformed approval, route, bound and fingerprint rather than falling back to a draft', () => {
    expect(asTaskRecord(record({ kind: 'review', review: { ...approval(), fingerprint: '' } }), PROJECT)).toBeUndefined();
    expect(asTaskRecord(record({ kind: 'review', review: { ...approval(), route: { profileId: 'p', model: 'm' } } }), PROJECT)).toBeUndefined();
    expect(asTaskRecord(record({ kind: 'review', review: { ...approval(), callBound: { extractCalls: -1, verifyCallsAtMost: 0 } } }), PROJECT)).toBeUndefined();
    expect(asTaskRecord(record({ kind: 'review', review: { ...approval(), plan: { scopeDocIds: ['sA'], documents: [], categories: ['factual'], maxFindings: 50, estimate: {}, overGuard: false, promptPreview: 'p' } } }), PROJECT)).toBeUndefined();
    expect(asTaskRecord(record({ kind: 'review' }), PROJECT)).toBeUndefined();
    expect(asTaskRecord(record({ kind: 'mixed', review: undefined }), PROJECT)).toBeUndefined();
    expect(asTaskRecord(record({ kind: 'bogus' }), PROJECT)).toBeUndefined();
  });

  it('refuses a malformed checkpoint or report', () => {
    const good = record({ kind: 'review', review: approval() });
    expect(asTaskRecord({ ...good, reviewCheckpoint: { extractedDocIds: 'sA', spans: [], verifiedBatches: 0, verdicts: [], usageByPair: {}, promptTokens: 0, completionTokens: 0, notes: [], status: 'complete', evaluated: [] } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, report: { runId: 'r', outcome: 'complete', findingsCount: 0, scopeTitles: [], routeLabel: 'x', usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, source: 'free' } } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, acknowledged: 'yes' }, PROJECT)).toBeUndefined();
  });

  it('refuses fractional counts, unknown categories and verdicts, unchecked documents and evidence, and inconsistent scope/bounds/kind', () => {
    const good = record({ kind: 'review', review: approval() });
    const checkpoint = { extractedDocIds: ['sA'], spans: [{ docId: 'sA', from: 0, to: 5, quote: 'Elena', category: 'factual', note: '' }], verifiedBatches: 0, verdicts: [], usageByPair: {}, promptTokens: 0, completionTokens: 0, notes: [], status: 'complete', evaluated: ['sA'] };
    const verdict = { pairId: 'p1', verdict: 'contradictory', reasoning: 'age differs', entity: 'Elena', attribute: 'age' };
    const report = { runId: 'r_QUEUED0001', outcome: 'complete', findingsCount: 1, scopeTitles: ['First'], routeLabel: 'Mock, fake', usage: { modelCalls: 1, promptTokens: 10, completionTokens: 2, source: 'reported' } };
    expect(asTaskRecord({ ...good, used: 0.5 }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, cap: 1.5 }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, review: { ...approval(), categories: ['bogus'], plan: { ...approval().plan, categories: ['bogus'] } } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, review: { ...approval(), plan: { ...approval().plan, documents: [{ docId: 'sA' }] } } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, review: { ...approval(), callBound: { extractCalls: 2, verifyCallsAtMost: 0 } } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, review: { ...approval(), scopeDocIds: ['sB'] } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, review: { ...approval(), maxFindings: 0 } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, reviewCheckpoint: { ...checkpoint, spans: [{ docId: 'sA', from: 0, to: 5, quote: 'Elena', category: 'not-a-category', note: '' }] } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, reviewCheckpoint: { ...checkpoint, spans: [{ docId: 'sA', from: 5, to: 0, quote: 'Elena', category: 'factual', note: '' }] } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, reviewCheckpoint: { ...checkpoint, verdicts: [{ ...verdict, verdict: 'maybe' }] } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, reviewCheckpoint: { ...checkpoint, verdicts: [{ ...verdict, evidence: [{ docId: 'sA', quote: 'Elena', from: 'bad', to: 5 }] }] } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...good, reviewCheckpoint: { ...checkpoint, verdicts: [{ ...verdict, evidence: [{ docId: 'sA', quote: 'Elena', from: 0, to: 5 }] }] } }, PROJECT)).toBeDefined();
    expect(asTaskRecord({ ...good, report: { ...report, findingsCount: 1.5 } }, PROJECT)).toBeUndefined();
    expect(asTaskRecord(record({ kind: 'draft', report }), PROJECT)).toBeUndefined();
    expect(asTaskRecord(record({ report }), PROJECT)).toBeUndefined();
  });
});

describe('reviewOf filters the published review out of the draft review', () => {
  it('never offers a coherence.review step to submitStaged, but keeps the draft steps', () => {
    const mixed: TaskRecord = {
      id: 'task_TEST000002',
      projectId: PROJECT,
      intent: 'Mixed.',
      steps: [reviewStep, draftStep],
      status: 'ready',
      items: [
        { key: '0', step: 0, state: 'staged', proposal: { runId: 'r_QUEUED0001' } },
        { key: '1', step: 1, state: 'staged', proposal: { text: 'draft' }, revisions: {} },
      ],
      cap: 2,
      used: 1,
      promptTokens: 0,
      completionTokens: 0,
      runs: 1,
      createdAt: 1,
      updatedAt: 1,
      kind: 'mixed',
    };
    const review = reviewOf(mixed);
    expect(review.steps.map((step) => step.tool)).toEqual(['scene.draft']);
    expect(review.proposals).toEqual([{ text: 'draft' }]);
  });
});
