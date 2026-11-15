import { describe, expect, it } from 'vitest';

import {
  computeReview,
  emptyCoherenceFile,
  emptyReviewCheckpoint,
  planReview,
  publishReview,
  reviewCheckpointEvidenceOk,
  type CoherenceModel,
  type ModelReply,
  type ModelRequest,
  type ReviewCheckpoint,
} from '../src/index.js';

import { NOW, buildState, entry } from './fixtures.js';

const ELENA = 'c_5H8QK2M9RT';

function fake(respond: (request: ModelRequest, index: number) => string | Error | ModelReply): CoherenceModel & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    model: 'fake-1',
    calls,
    async complete(request: ModelRequest): Promise<ModelReply> {
      calls.push(request);
      const reply = respond(request, calls.length - 1);
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'string') return { content: reply, usage: { promptTokens: 100, completionTokens: 20 } };
      return reply;
    },
  };
}

function docIdOf(user: string): string {
  return /docId: ([A-Za-z0-9]+)\)/.exec(user)?.[1] ?? '';
}

function bodyOf(user: string): string {
  const start = user.indexOf('--- BEGIN DOCUMENT ---\n') + '--- BEGIN DOCUMENT ---\n'.length;
  const end = user.indexOf('\n--- END DOCUMENT ---');
  return user.slice(start, end);
}

function extraction(body: string, docId: string, items: readonly { quote: string; category: string }[]): string {
  const spans = items.map((item) => {
    const from = body.indexOf(item.quote);
    return { docId, from, to: from + item.quote.length, quote: item.quote, category: item.category, note: '' };
  });
  return JSON.stringify({ spans });
}

const twoDocs = () =>
  buildState({
    scenes: [
      { id: 'sA', title: 'First', body: 'Elena is thirty-four.' },
      { id: 'sB', title: 'Second', body: 'Elena is forty-one.' },
    ],
    entries: [entry(ELENA, 'Elena')],
  });

function reviewing(verdict: 'contradictory' | 'consistent' = 'contradictory'): CoherenceModel & { calls: ModelRequest[] } {
  return fake((request) => {
    if (request.system.includes('continuity extractor')) {
      const body = bodyOf(request.user);
      const docId = docIdOf(request.user);
      const quote = body.includes('thirty-four') ? 'Elena is thirty-four.' : 'Elena is forty-one.';
      return extraction(body, docId, [{ quote, category: 'characterization' }]);
    }
    const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
    return JSON.stringify({
      verdicts: pairIds.map((pairId) => ({
        pairId,
        verdict,
        reasoning: 'Elena is thirty-four in one and forty-one in the other.',
        factGroup: { entity: 'Elena', attribute: 'age' },
      })),
    });
  });
}

describe('computeReview checkpoints', () => {
  it('acknowledges each stage, and a resume repeats no acknowledged model work', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoints: ReviewCheckpoint[] = [];
    const first = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        const docId = docIdOf(request.user);
        const quote = body.includes('thirty-four') ? 'Elena is thirty-four.' : 'Elena is forty-one.';
        return extraction(body, docId, [{ quote, category: 'characterization' }]);
      }
      const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({ verdicts: pairIds.map((pairId) => ({ pairId, verdict: 'contradictory', reasoning: 'age differs', factGroup: { entity: 'Elena', attribute: 'age' } })) });
    });
    const computed = await computeReview(state, emptyCoherenceFile(), plan, {
      model: first,
      approved: true,
      onCheckpoint: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    });
    expect(computed.status).toBe('complete');
    expect(first.calls).toHaveLength(3);
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0]?.extractedDocIds).toEqual(['sA']);
    expect(checkpoints[0]?.verifiedBatches).toBe(0);

    const resumed = reviewing();
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: resumed, approved: true, resumeFrom: checkpoints[0] });
    expect(again.status).toBe('complete');
    expect(resumed.calls).toHaveLength(2);
    expect(resumed.calls[0]?.user).toContain('docId: sB');
    expect(again.drafts).toHaveLength(1);
    expect(again.promptTokens).toBe(computed.promptTokens);
  });

  it('a beforeCall refusal stops the run partial at that point', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const model = reviewing();
    let calls = 0;
    const computed = await computeReview(state, emptyCoherenceFile(), plan, {
      model,
      approved: true,
      beforeCall: () => { calls += 1; if (calls === 2) throw new Error('the read rules changed'); },
    });
    expect(computed.status).toBe('partial');
    expect(model.calls).toHaveLength(1);
    expect(computed.notes.some((note) => note.includes('the read rules changed'))).toBe(true);
  });
});

describe('resume revalidates the checkpoint evidence', () => {
  async function firstExtraction() {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoints: ReviewCheckpoint[] = [];
    const model = reviewing();
    await computeReview(state, emptyCoherenceFile(), plan, {
      model,
      approved: true,
      onCheckpoint: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    });
    return { state, plan, checkpoints };
  }

  it('accepts the evidence a run produced', async () => {
    const { plan, checkpoints } = await firstExtraction();
    const bodies = new Map([['sA', 'Elena is thirty-four.'], ['sB', 'Elena is forty-one.']]);
    for (const checkpoint of checkpoints) expect(reviewCheckpointEvidenceOk(plan, bodies, checkpoint)).toBe(true);
    expect(reviewCheckpointEvidenceOk(plan, bodies, emptyReviewCheckpoint())).toBe(true);
  });

  it('a span quote that no longer matches restarts the review, keeping the accounted tokens and notes', async () => {
    const { state, plan, checkpoints } = await firstExtraction();
    const base = checkpoints[0]!;
    const tampered = { ...base, spans: base.spans.map((span, index) => (index === 0 ? { ...span, quote: 'not in the document' } : span)) };
    const model = reviewing();
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model, approved: true, resumeFrom: tampered });
    expect(model.calls).toHaveLength(3);
    expect(model.calls[0]?.user).toContain('docId: sA');
    expect(again.status).toBe('complete');
    expect(again.promptTokens).toBe(tampered.promptTokens + 300);
    expect(again.notes.some((note) => note.includes('did not match the approved documents'))).toBe(true);
  });

  it('a verdict naming a pair the spans no longer form, or evidence that is not verbatim, is not resumed', async () => {
    const { state, plan, checkpoints } = await firstExtraction();
    const final = checkpoints[2]!;
    const unknownPair = { ...final, verdicts: final.verdicts.map((verdict) => ({ ...verdict, pairId: 'p999' })) };
    const bodies = new Map([['sA', 'Elena is thirty-four.'], ['sB', 'Elena is forty-one.']]);
    expect(reviewCheckpointEvidenceOk(plan, bodies, unknownPair)).toBe(false);
    const forgedEvidence = {
      ...final,
      verdicts: final.verdicts.map((verdict) => ({ ...verdict, evidence: [{ docId: 'sA', quote: 'a forged passage', from: 0, to: 16 }] })),
    };
    expect(reviewCheckpointEvidenceOk(plan, bodies, forgedEvidence)).toBe(false);
    const model = reviewing();
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model, approved: true, resumeFrom: unknownPair });
    expect(model.calls).toHaveLength(3);
    expect(again.status).toBe('complete');
  });

  it('a span outside the approved scope or categories, or an over-counted batch, is not resumed', async () => {
    const { plan, checkpoints } = await firstExtraction();
    const bodies = new Map([['sA', 'Elena is thirty-four.'], ['sB', 'Elena is forty-one.']]);
    const final = checkpoints[2]!;
    const outsider = { ...final, spans: [...final.spans, { docId: 'sX', from: 0, to: 1, quote: 'E', category: 'characterization' as const, note: '' }] };
    expect(reviewCheckpointEvidenceOk(plan, bodies, outsider)).toBe(false);
    const narrow = { ...plan, categories: ['characterization'] as const };
    const wrongCategory = { ...final, spans: final.spans.map((span) => ({ ...span, category: 'factual' as const })) };
    expect(reviewCheckpointEvidenceOk(narrow, bodies, wrongCategory)).toBe(false);
    const overCounted = { ...final, verifiedBatches: final.verifiedBatches + 1 };
    expect(reviewCheckpointEvidenceOk(plan, bodies, overCounted)).toBe(false);
    const outOfScope = { ...final, extractedDocIds: [...final.extractedDocIds, 'sX'] };
    expect(reviewCheckpointEvidenceOk(plan, bodies, outOfScope)).toBe(false);
  });
});

describe('publishReview merges into the current file', () => {
  it('keeps intervening findings, statuses and runs, and is idempotent by run identity', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const computed = await computeReview(state, emptyCoherenceFile(), plan, { model: reviewing(), approved: true });

    const current = emptyCoherenceFile();
    current.findings.push({
      id: 'f_INTERVENING', runId: 'r_OTHER', createdByRunId: 'r_OTHER', class: 'deterministic', checkId: 'codex.alias-collisions',
      type: 'codex', severity: 'error', status: 'dismissed', factGroup: 'other|group', message: 'An intervening finding', evidence: [],
    } as never);
    current.runs.push({ id: 'r_OTHER', at: NOW.toISOString(), kind: 'deterministic', checkIds: [], scope: { docIds: [] }, findingsUpserted: ['f_INTERVENING'], status: 'complete' });

    const published = publishReview(current, computed, { now: NOW, runId: 'r_QUEUED0001' });
    expect(published.status).toBe('complete');
    expect(published.file.findings.map((finding) => finding.id)).toContain('f_INTERVENING');
    expect(published.file.findings.find((finding) => finding.id === 'f_INTERVENING')?.status).toBe('dismissed');
    expect(published.file.findings).toHaveLength(2);
    expect(published.file.runs.map((run) => run.id)).toEqual(['r_OTHER', 'r_QUEUED0001']);

    const replayed = publishReview(published.file, computed, { now: NOW, runId: 'r_QUEUED0001' });
    expect(replayed.file.runs).toHaveLength(2);
    expect(replayed.file.findings).toHaveLength(2);
    expect(replayed.file).toEqual(published.file);
  });

  it('a complete run with zero findings is completed, and a partial run leaves review state due', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const consistent = await computeReview(state, emptyCoherenceFile(), plan, { model: reviewing('consistent'), approved: true });
    const zero = publishReview(emptyCoherenceFile(), consistent, { now: NOW, runId: 'r_ZERO000001' });
    expect(zero.status).toBe('complete');
    expect(zero.file.findings).toHaveLength(0);
    expect(zero.file.runs[0]?.status).toBe('complete');
    expect(Object.keys(zero.file.reviewState)).toEqual(['sA', 'sB']);

    const failing = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        const docId = docIdOf(request.user);
        const quote = body.includes('thirty-four') ? 'Elena is thirty-four.' : 'Elena is forty-one.';
        return extraction(body, docId, [{ quote, category: 'characterization' }]);
      }
      return new Error('provider down');
    });
    const partial = await computeReview(state, emptyCoherenceFile(), plan, { model: failing, approved: true });
    expect(partial.status).toBe('partial');
    const partialPublished = publishReview(emptyCoherenceFile(), partial, { now: NOW, runId: 'r_PARTIAL001' });
    expect(partialPublished.status).toBe('partial');
    expect(partialPublished.file.runs[0]?.status).toBe('partial');
    expect(partialPublished.file.reviewState).toEqual({});
  });
});
