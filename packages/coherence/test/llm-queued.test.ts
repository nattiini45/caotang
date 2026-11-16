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
    for (const checkpoint of checkpoints) expect(await reviewCheckpointEvidenceOk(plan, bodies, checkpoint)).toBe(true);
    expect(await reviewCheckpointEvidenceOk(plan, bodies, emptyReviewCheckpoint())).toBe(true);
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
    expect(await reviewCheckpointEvidenceOk(plan, bodies, unknownPair)).toBe(false);
    const forgedEvidence = {
      ...final,
      verdicts: final.verdicts.map((verdict) => ({ ...verdict, evidence: [{ docId: 'sA', quote: 'a forged passage', from: 0, to: 16 }] })),
    };
    expect(await reviewCheckpointEvidenceOk(plan, bodies, forgedEvidence)).toBe(false);
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
    expect(await reviewCheckpointEvidenceOk(plan, bodies, outsider)).toBe(false);
    const narrow = { ...plan, categories: ['characterization'] as const };
    const wrongCategory = { ...final, spans: final.spans.map((span) => ({ ...span, category: 'factual' as const })) };
    expect(await reviewCheckpointEvidenceOk(narrow, bodies, wrongCategory)).toBe(false);
    const overCounted = { ...final, verifiedBatches: final.verifiedBatches + 1 };
    expect(await reviewCheckpointEvidenceOk(plan, bodies, overCounted)).toBe(false);
    const outOfScope = { ...final, extractedDocIds: [...final.extractedDocIds, 'sX'] };
    expect(await reviewCheckpointEvidenceOk(plan, bodies, outOfScope)).toBe(false);
  });

  it('a large checkpoint validation yields to the host and a cancel there stops the resume before any model call', async () => {
    const scenes = [0, 1, 2, 3].map((d) => {
      const quotes = Array.from({ length: 17 }, (_, i) => `Fact ${d}-${i}.`);
      let at = 0;
      const spans = quotes.map((quote) => {
        const from = at;
        at += quote.length + 1;
        return { docId: `s${d}`, from, to: from + quote.length, quote, category: 'characterization' as const, note: '' };
      });
      return { id: `s${d}`, title: `Doc ${d}`, body: quotes.join(' '), spans };
    });
    const state = buildState({ scenes: scenes.map(({ id, title, body }) => ({ id, title, body })), entries: [] });
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoint: ReviewCheckpoint = {
      extractedDocIds: scenes.map((scene) => scene.id),
      spans: scenes.flatMap((scene) => scene.spans),
      verifiedBatches: 0,
      verdicts: [],
      usageByPair: {},
      promptTokens: 400,
      completionTokens: 80,
      notes: [],
      status: 'partial',
      evaluated: scenes.map((scene) => scene.id),
    };
    const bodies = new Map(scenes.map((scene) => [scene.id, scene.body] as const));
    let yields = 0;
    expect(await reviewCheckpointEvidenceOk(plan, bodies, checkpoint, async () => { yields += 1; })).toBe(true);
    expect(yields).toBeGreaterThan(0);

    const model = reviewing();
    await expect(computeReview(state, emptyCoherenceFile(), plan, {
      model,
      approved: true,
      resumeFrom: checkpoint,
      yieldToHost: async () => { throw new Error('cancelled while the checkpoint was checked'); },
    })).rejects.toThrow('cancelled while the checkpoint was checked');
    expect(model.calls).toHaveLength(0);
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

describe('a resume recomposes the pairs the new spans form', () => {
  const threeDocs = () =>
    buildState({
      scenes: [
        { id: 'sA', title: 'First', body: 'Elena is thirty-four.' },
        { id: 'sB', title: 'Second', body: 'Elena is forty-one.' },
        { id: 'sC', title: 'Third', body: 'Elena is thirty-four.' },
      ],
      entries: [entry(ELENA, 'Elena')],
    });

  function extractingExcept(failDocId: string, reasoning: string): CoherenceModel & { calls: ModelRequest[] } {
    return fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const docId = docIdOf(request.user);
        if (docId === failDocId) return new Error('provider down');
        const body = bodyOf(request.user);
        return extraction(body, docId, [{ quote: body, category: 'characterization' }]);
      }
      const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({
        verdicts: pairIds.map((pairId) => ({ pairId, verdict: 'contradictory', reasoning, factGroup: { entity: 'Elena', attribute: 'age' } })),
      });
    });
  }

  async function stoppedBefore(failDocId: string, state: ReturnType<typeof threeDocs>) {
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoints: ReviewCheckpoint[] = [];
    const model = extractingExcept(failDocId, 'first pass age differs');
    const computed = await computeReview(state, emptyCoherenceFile(), plan, {
      model,
      approved: true,
      onCheckpoint: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    });
    expect(computed.status).toBe('partial');
    return { plan, checkpoint: checkpoints.at(-1)! };
  }

  it('verifies the pairs the resumed extraction adds, even when they fill a batch the checkpoint already counted', async () => {
    const state = threeDocs();
    const { plan, checkpoint } = await stoppedBefore('sC', state);
    expect(checkpoint.verifiedBatches).toBe(1);
    expect(checkpoint.extractedDocIds).toEqual(['sA', 'sB']);

    const resumed = extractingExcept('none', 'second pass age differs');
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: resumed, approved: true, resumeFrom: checkpoint });
    expect(resumed.calls).toHaveLength(2);
    expect(resumed.calls[1]?.user).toContain('[pair p2]');
    expect(resumed.calls[1]?.user).toContain('[pair p3]');
    expect(again.status).toBe('complete');
    expect(again.drafts).toHaveLength(3);
  });

  it('carries a verdict to the pair its spans still form after the renumbering', async () => {
    const state = buildState({
      scenes: [
        { id: 'sB', title: 'Second', body: 'Elena is forty-one.' },
        { id: 'sC', title: 'Third', body: 'Elena is thirty-four.' },
        { id: 'sA', title: 'First', body: 'Elena is twenty-two.' },
      ],
      entries: [entry(ELENA, 'Elena')],
    });
    const { plan, checkpoint } = await stoppedBefore('sA', state);
    expect(checkpoint.verdicts.map((verdict) => verdict.pairId)).toEqual(['p1']);

    const resumed = extractingExcept('none', 'second pass age differs');
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: resumed, approved: true, resumeFrom: checkpoint });
    const carried = again.drafts.find((draft) => draft.reasoning === 'first pass age differs');
    expect(carried?.evidence.map((passage) => passage.docId)).toEqual(['sB', 'sC']);
    expect(again.drafts).toHaveLength(3);
    expect(again.status).toBe('complete');
  });

  it('a checkpoint taken mid-resume names its verdicts in the composition it carries', async () => {
    const state = buildState({
      scenes: [
        { id: 'sB', title: 'Second', body: 'Elena is forty-one.' },
        { id: 'sC', title: 'Third', body: 'Elena is thirty-four.' },
        { id: 'sA', title: 'First', body: 'Elena is twenty-two.' },
      ],
      entries: [entry(ELENA, 'Elena')],
    });
    const { plan, checkpoint } = await stoppedBefore('sA', state);
    const checkpoints: ReviewCheckpoint[] = [];
    const resumed = extractingExcept('none', 'second pass age differs');
    await computeReview(state, emptyCoherenceFile(), plan, {
      model: resumed,
      approved: true,
      resumeFrom: checkpoint,
      onCheckpoint: (next) => { checkpoints.push(structuredClone(next)); },
    });
    const bodies = new Map([['sA', 'Elena is twenty-two.'], ['sB', 'Elena is forty-one.'], ['sC', 'Elena is thirty-four.']]);
    for (const next of checkpoints) expect(await reviewCheckpointEvidenceOk(plan, bodies, next)).toBe(true);
  });

  it('a checkpoint taken after resumed extraction but before verification acknowledges only the pairs it verified', async () => {
    const state = threeDocs();
    const { plan, checkpoint } = await stoppedBefore('sC', state);
    const interrupted: ReviewCheckpoint[] = [];
    const extracting = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        const docId = docIdOf(request.user);
        return extraction(body, docId, [{ quote: body, category: 'characterization' }]);
      }
      return new Error('provider down');
    });
    await computeReview(state, emptyCoherenceFile(), plan, {
      model: extracting,
      approved: true,
      resumeFrom: checkpoint,
      onCheckpoint: (next) => { interrupted.push(structuredClone(next)); },
    });
    const mid = interrupted.at(-1)!;
    expect(mid.extractedDocIds).toEqual(['sA', 'sB', 'sC']);
    expect(mid.verifiedBatches).toBe(1);

    const resumed = extractingExcept('none', 'second pass age differs');
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: resumed, approved: true, resumeFrom: mid });
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.calls[0]?.user).toContain('[pair p2]');
    expect(resumed.calls[0]?.user).toContain('[pair p3]');
    expect(again.drafts).toHaveLength(3);
    expect(again.status).toBe('complete');
  });

  it('a legacy checkpoint taken mid-extraction re-verifies rather than trusting its batch count', async () => {
    const state = threeDocs();
    const { plan, checkpoint } = await stoppedBefore('sC', state);
    const quote = 'Elena is thirty-four.';
    const { verifiedPairs: _keys, ...mid } = {
      ...checkpoint,
      extractedDocIds: ['sA', 'sB', 'sC'],
      evaluated: ['sA', 'sB', 'sC'],
      spans: [...checkpoint.spans, { docId: 'sC', from: 0, to: quote.length, quote, category: 'characterization' as const, note: '' }],
    };
    const resumed = extractingExcept('none', 'second pass age differs');
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: resumed, approved: true, resumeFrom: mid });
    expect(resumed.calls).toHaveLength(1);
    expect(again.drafts).toHaveLength(3);
    expect(again.status).toBe('complete');
  });
});

describe('a resume that finishes the missing work completes', () => {
  it('a provider stop no longer holds the recovered run partial', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoints: ReviewCheckpoint[] = [];
    const malformed = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const docId = docIdOf(request.user);
        if (docId === 'sB') return 'not json at all';
        const body = bodyOf(request.user);
        return extraction(body, docId, [{ quote: body, category: 'characterization' }]);
      }
      return JSON.stringify({ verdicts: [] });
    });
    const stopped = await computeReview(state, emptyCoherenceFile(), plan, {
      model: malformed,
      approved: true,
      onCheckpoint: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    });
    expect(stopped.status).toBe('partial');
    expect(checkpoints.at(-1)?.status).toBe('partial');

    const resumed = reviewing();
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: resumed, approved: true, resumeFrom: checkpoints.at(-1)! });
    expect(resumed.calls[0]?.user).toContain('docId: sB');
    expect(again.status).toBe('complete');
    expect(again.drafts).toHaveLength(1);
    const published = publishReview(emptyCoherenceFile(), again, { now: NOW, runId: 'r_RECOVER001' });
    expect(published.status).toBe('complete');
    expect(Object.keys(published.file.reviewState)).toEqual(['sA', 'sB']);
  });

  it('an unusable verification batch is retried by the resume, not counted as verified', async () => {
    const scenes = [0, 1].map((d) => {
      const quotes = Array.from({ length: 5 }, (_, i) => `Fact ${d}-${i}.`);
      let at = 0;
      const spans = quotes.map((quote) => {
        const from = at;
        at += quote.length + 1;
        return { docId: `s${d}`, from, to: from + quote.length, quote, category: 'characterization' as const, note: '' };
      });
      return { id: `s${d}`, title: `Doc ${d}`, body: quotes.join(' '), spans };
    });
    const state = buildState({ scenes: scenes.map(({ id, title, body }) => ({ id, title, body })), entries: [] });
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoints: ReviewCheckpoint[] = [];
    let verificationCalls = 0;
    const malformed = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const docId = docIdOf(request.user);
        const scene = scenes.find((candidate) => candidate.id === docId)!;
        return JSON.stringify({ spans: scene.spans });
      }
      verificationCalls += 1;
      return verificationCalls === 1 ? 'not json at all' : JSON.stringify({ verdicts: [] });
    });
    const stopped = await computeReview(state, emptyCoherenceFile(), plan, {
      model: malformed,
      approved: true,
      onCheckpoint: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    });
    expect(stopped.status).toBe('partial');
    expect(stopped.notes.some((note) => note.includes('a verification batch was unusable'))).toBe(true);
    expect(checkpoints.at(-1)?.verifiedBatches).toBe(0);

    const resumed = fake((request) => {
      if (request.system.includes('continuity extractor')) throw new Error('extraction must not run again');
      const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({ verdicts: pairIds.map((pairId) => ({ pairId, verdict: 'consistent', reasoning: 'no conflict', factGroup: { entity: 'Elena', attribute: 'age' } })) });
    });
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: resumed, approved: true, resumeFrom: checkpoints.at(-1)! });
    expect(resumed.calls).toHaveLength(5);
    expect(resumed.calls[0]?.user).toContain('[pair p1]');
    expect(again.status).toBe('complete');
  });

  it('a legacy checkpoint that counted an unusable extraction as done asks that document again', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const quote = 'Elena is thirty-four.';
    const legacy: ReviewCheckpoint = {
      extractedDocIds: ['sA', 'sB'],
      spans: [{ docId: 'sA', from: 0, to: quote.length, quote, category: 'characterization', note: '' }],
      verifiedBatches: 0,
      verdicts: [],
      usageByPair: {},
      promptTokens: 100,
      completionTokens: 20,
      notes: ['extraction for "Second" was unusable: not the contract'],
      status: 'partial',
      evaluated: ['sA'],
    };
    const resumed = reviewing();
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: resumed, approved: true, resumeFrom: legacy });
    expect(resumed.calls[0]?.user).toContain('docId: sB');
    expect(again.status).toBe('complete');
    expect(again.drafts).toHaveLength(1);
  });
});

describe('a verification reply must judge every pair it was sent', () => {
  const manyPairs = () => {
    const scenes = [0, 1].map((d) => {
      const quotes = Array.from({ length: 5 }, (_, i) => `Fact ${d}-${i}.`);
      let at = 0;
      const spans = quotes.map((quote) => {
        const from = at;
        at += quote.length + 1;
        return { docId: `s${d}`, from, to: from + quote.length, quote, category: 'characterization' as const, note: '' };
      });
      return { id: `s${d}`, title: `Doc ${d}`, body: quotes.join(' '), spans };
    });
    const state = buildState({ scenes: scenes.map(({ id, title, body }) => ({ id, title, body })), entries: [] });
    return { state, scenes };
  };

  const idsOf = (request: ModelRequest): string[] => [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]!);
  const verdictsFor = (ids: readonly string[], verdict: 'contradictory' | 'consistent' | 'unclear' = 'consistent'): string =>
    JSON.stringify({ verdicts: ids.map((pairId) => ({ pairId, verdict, reasoning: 'no conflict', factGroup: { entity: 'Elena', attribute: 'age' } })) });
  const extracting = (scenes: ReturnType<typeof manyPairs>['scenes']) => (request: ModelRequest): string => {
    const docId = docIdOf(request.user);
    const scene = scenes.find((candidate) => candidate.id === docId)!;
    return JSON.stringify({ spans: scene.spans });
  };

  async function firstBatch(reply: (ids: string[]) => string) {
    const { state, scenes } = manyPairs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoints: ReviewCheckpoint[] = [];
    const model = fake((request) => {
      if (request.system.includes('continuity extractor')) return extracting(scenes)(request);
      return reply(idsOf(request));
    });
    const computed = await computeReview(state, emptyCoherenceFile(), plan, {
      model,
      approved: true,
      onCheckpoint: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    });
    return { state, plan, computed, checkpoints, model };
  }

  const full = fake((request) => {
    if (request.system.includes('continuity extractor')) throw new Error('extraction must not run again');
    return verdictsFor(idsOf(request));
  });

  it('a reply that judges only part of its batch leaves the batch unacknowledged and the run partial', async () => {
    const { state, plan, computed, checkpoints } = await firstBatch((ids) => verdictsFor(ids.slice(0, 2)));
    expect(computed.status).toBe('partial');
    expect(computed.notes.some((note) => note.includes('judged 2 of 10'))).toBe(true);
    const last = checkpoints.at(-1)!;
    expect(last.verifiedBatches).toBe(0);
    expect(last.verifiedPairs).toEqual([]);
    expect(last.verdicts).toHaveLength(2);
    expect(last.promptTokens).toBe(300);

    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: full, approved: true, resumeFrom: last });
    expect(full.calls).toHaveLength(5);
    expect(full.calls[0]?.user).toContain('[pair p1]');
    expect(again.status).toBe('complete');
  });

  it('an empty verdicts list is an incomplete batch, not a judged one', async () => {
    const { state, plan, computed, checkpoints } = await firstBatch(() => JSON.stringify({ verdicts: [] }));
    expect(computed.status).toBe('partial');
    expect(computed.notes.some((note) => note.includes('judged 0 of 10'))).toBe(true);
    expect(checkpoints.at(-1)?.verifiedPairs).toEqual([]);
    const again = await computeReview(state, emptyCoherenceFile(), plan, { model: full, approved: true, resumeFrom: checkpoints.at(-1)! });
    expect(again.status).toBe('complete');
  });

  it('a repeated verdict for one pair is kept once in the checkpoint', async () => {
    const { computed, checkpoints } = await firstBatch((ids) => JSON.stringify({
      verdicts: [...ids, ...ids].map((pairId) => ({ pairId, verdict: 'consistent', reasoning: 'no conflict', factGroup: { entity: 'Elena', attribute: 'age' } })),
    }));
    expect(computed.status).toBe('complete');
    const last = checkpoints.at(-1)!;
    expect(last.verdicts).toHaveLength(45);
    expect(new Set(last.verdicts.map((verdict) => verdict.pairId)).size).toBe(45);
    expect(computed.notes.some((note) => note.includes('kept once'))).toBe(true);
  });

  it('verdicts in any order judge the same pairs', async () => {
    const { computed, checkpoints } = await firstBatch((ids) => verdictsFor([...ids].reverse()));
    expect(computed.status).toBe('complete');
    const last = checkpoints.at(-1)!;
    expect(new Set(last.verdicts.map((verdict) => verdict.pairId))).toEqual(new Set(Array.from({ length: 45 }, (_, i) => `p${i + 1}`)));
  });

  it('a verdict for a pair outside the batch is dropped, and the pair it replaced is asked again', async () => {
    const { computed, checkpoints } = await firstBatch((ids) => verdictsFor([...ids.slice(0, 9), 'p999']));
    expect(computed.status).toBe('partial');
    expect(computed.notes.some((note) => note.includes('not in its batch'))).toBe(true);
    expect(computed.notes.some((note) => note.includes('judged 9 of 10'))).toBe(true);
    expect(checkpoints.at(-1)?.verifiedPairs).toEqual([]);
  });

  it('an unclear verdict judges its pair', async () => {
    const { computed } = await firstBatch((ids) => verdictsFor(ids, 'unclear'));
    expect(computed.status).toBe('complete');
    expect(computed.drafts).toEqual([]);
  });

  it('a contradictory verdict without reasoning is dropped, so its pair is asked again', async () => {
    const { computed, checkpoints } = await firstBatch((ids) => JSON.stringify({
      verdicts: [
        ...ids.slice(0, 9).map((pairId) => ({ pairId, verdict: 'consistent', reasoning: 'no conflict', factGroup: { entity: 'Elena', attribute: 'age' } })),
        { pairId: ids[9], verdict: 'contradictory', reasoning: '', factGroup: { entity: 'Elena', attribute: 'age' } },
      ],
    }));
    expect(computed.status).toBe('partial');
    expect(computed.notes.some((note) => note.includes('judged 9 of 10'))).toBe(true);
    expect(checkpoints.at(-1)?.verifiedPairs).toEqual([]);
  });

  it('an unusable verification batch keeps its spent tokens in the checkpoint', async () => {
    const { computed, checkpoints } = await firstBatch(() => 'not json at all');
    expect(computed.status).toBe('partial');
    expect(checkpoints.at(-1)?.promptTokens).toBe(300);
    expect(checkpoints.at(-1)?.verifiedPairs).toEqual([]);
  });

  it('a span naming another document is dropped and the rest still extract', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const model = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        const docId = docIdOf(request.user);
        const spans = [{ docId, from: 0, to: body.length, quote: body, category: 'characterization', note: '' }];
        if (docId === 'sA') spans.push({ docId: 'sB', from: 0, to: 5, quote: 'Elena', category: 'characterization', note: '' });
        return JSON.stringify({ spans });
      }
      const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({ verdicts: pairIds.map((pairId) => ({ pairId, verdict: 'consistent', reasoning: 'no conflict', factGroup: { entity: 'Elena', attribute: 'age' } })) });
    });
    const computed = await computeReview(state, emptyCoherenceFile(), plan, { model, approved: true });
    expect(computed.status).toBe('complete');
    expect(computed.notes.some((note) => note.includes('names another document'))).toBe(true);
    expect(computed.evaluated).toEqual(['sA', 'sB']);
  });

  it('an extraction over the per-document cap keeps the first twenty spans', async () => {
    const quotes = Array.from({ length: 25 }, (_, i) => `Fact ${i}.`);
    let at = 0;
    const spans = quotes.map((quote) => {
      const from = at;
      at += quote.length + 1;
      return { docId: 'sA', from, to: from + quote.length, quote, category: 'characterization' as const, note: '' };
    });
    const state = buildState({ scenes: [{ id: 'sA', title: 'One', body: quotes.join(' ') }], entries: [] });
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoints: ReviewCheckpoint[] = [];
    const model = fake((request) => {
      if (request.system.includes('continuity extractor')) return JSON.stringify({ spans });
      return JSON.stringify({ verdicts: [] });
    });
    const computed = await computeReview(state, emptyCoherenceFile(), plan, {
      model,
      approved: true,
      onCheckpoint: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    });
    expect(computed.notes.some((note) => note.includes('only the first 20'))).toBe(true);
    expect(checkpoints[0]?.spans).toHaveLength(20);
    expect(computed.status).toBe('partial');
  });

  it('a verdict whose passages are not the pair\'s own falls back to the pair\'s spans', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const model = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        return extraction(body, docIdOf(request.user), [{ quote: body, category: 'characterization' }]);
      }
      return JSON.stringify({ verdicts: [{ pairId: 'p1', verdict: 'contradictory', reasoning: 'age differs', factGroup: { entity: 'Elena', attribute: 'age' }, evidence: [{ docId: 'sA', quote: 'Elena is thirty-four.', from: 0, to: 21 }, { docId: 'sA', quote: 'Elena is thirty-four.', from: 0, to: 21 }] }] });
    });
    const computed = await computeReview(state, emptyCoherenceFile(), plan, { model, approved: true });
    expect(computed.status).toBe('complete');
    expect(computed.drafts).toHaveLength(1);
    expect(computed.drafts[0]?.evidence.map((passage) => passage.docId)).toEqual(['sA', 'sB']);
    expect(computed.notes.some((note) => note.includes('not the pair\'s two passages'))).toBe(true);
  });

  it('the first verdict for a pair wins when a reply repeats it with another answer', async () => {
    const { computed } = await firstBatch((ids) => JSON.stringify({
      verdicts: ids.flatMap((pairId) => [
        { pairId, verdict: 'consistent', reasoning: 'no conflict', factGroup: { entity: 'Elena', attribute: 'age' } },
        { pairId, verdict: 'contradictory', reasoning: 'age differs', factGroup: { entity: 'Elena', attribute: 'age' } },
      ]),
    }));
    expect(computed.status).toBe('complete');
    expect(computed.drafts).toEqual([]);
  });

  it('a pair judged before an incomplete batch is not judged twice in the checkpoint', async () => {
    const { state, plan, checkpoints } = await firstBatch((ids) => verdictsFor(ids.slice(0, 2)));
    const resumed: ReviewCheckpoint[] = [];
    const again = await computeReview(state, emptyCoherenceFile(), plan, {
      model: full,
      approved: true,
      resumeFrom: checkpoints.at(-1)!,
      onCheckpoint: (checkpoint) => { resumed.push(structuredClone(checkpoint)); },
    });
    expect(again.status).toBe('complete');
    const last = resumed.at(-1)!;
    expect(last.verdicts).toHaveLength(45);
    expect(new Set(last.verdicts.map((verdict) => verdict.pairId)).size).toBe(45);
    expect(again.evaluated).toEqual(['s0', 's1']);
  });

  it('duplicated and reordered extraction spans form the same pairs once', async () => {
    const { state, scenes } = manyPairs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const checkpoints: ReviewCheckpoint[] = [];
    const model = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const docId = docIdOf(request.user);
        const scene = scenes.find((candidate) => candidate.id === docId)!;
        return JSON.stringify({ spans: [...scene.spans].reverse().concat(scene.spans) });
      }
      return verdictsFor(idsOf(request));
    });
    const computed = await computeReview(state, emptyCoherenceFile(), plan, {
      model,
      approved: true,
      onCheckpoint: (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
    });
    expect(computed.status).toBe('complete');
    expect(model.calls).toHaveLength(7);
    expect(checkpoints.at(-1)?.spans).toHaveLength(10);
    expect(checkpoints.at(-1)?.verdicts).toHaveLength(45);
  });
});
