import { describe, expect, it } from 'vitest';

import {
  CoherenceError,
  MalformedReplyError,
  NoProviderError,
  ReviewNotApprovedError,
  assembleFindings,
  batchPairs,
  candidatePairs,
  emptyCoherenceFile,
  normalizeFactGroup,
  parseExtraction,
  parseJsonReply,
  parseVerification,
  planReview,
  runReview,
  type CoherenceFile,
  type CoherenceModel,
  type CoherenceRun,
  type ExtractedSpan,
  type ModelReply,
  type ModelRequest,
  type PairRef,
  type ParsedVerdict,
} from '../src/index.js';

import { LATER, NOW, buildState, entry } from './fixtures.js';

const ELENA = 'c_5H8QK2M9RT';
const ALL_CATEGORIES = ['timeline-plot', 'characterization', 'world-building', 'factual', 'narrative-style'];

/** A deterministic fake port. The responder sees each request and its index, and returns text, a usage-bearing reply, or an error. */
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

/** A reply that quotes the given phrases from a document, with correct offsets. */
function extraction(body: string, docId: string, items: readonly { quote: string; category: string }[]): string {
  const spans = items.map((item) => {
    const from = body.indexOf(item.quote);
    return { docId, from, to: from + item.quote.length, quote: item.quote, category: item.category, note: '' };
  });
  return JSON.stringify({ spans });
}

const CHARACTERIZATION = 'characterization';

describe('parseJsonReply', () => {
  it('unwraps a fenced JSON block and refuses anything that is not an object', () => {
    expect(parseJsonReply('```json\n{"spans": []}\n```', 'extraction')).toEqual({ spans: [] });
    expect(() => parseJsonReply('not json', 'extraction')).toThrow(MalformedReplyError);
    expect(() => parseJsonReply('[1, 2]', 'extraction')).toThrow(/top level is not an object/);
  });

  it('unwraps a fence the way the old pattern did: tag case, CRLF, padding, bare fences, other text', () => {
    const obj = { a: 1 };
    expect(parseJsonReply('```\n{"a": 1}\n```', 'extraction')).toEqual(obj);
    expect(parseJsonReply('```JSON\r\n{"a": 1}\r\n```', 'extraction')).toEqual(obj);
    expect(parseJsonReply('  \n```json   \n\n  {"a": 1}  \n\n  ```\n ', 'extraction')).toEqual(obj);
    expect(parseJsonReply('```json{"a": 1}```', 'extraction')).toEqual(obj);
    expect(parseJsonReply('```{"a": 1}```', 'extraction')).toEqual(obj);
    expect(parseJsonReply('```json\n{"a": "é\u00a0\u2028"}\n```', 'extraction')).toEqual({ a: 'é\u00a0\u2028' });
    // Empty or whitespace-only fences hold no object; text that is not wholly one fence is not unwrapped.
    expect(() => parseJsonReply('``````', 'extraction')).toThrow(MalformedReplyError);
    expect(() => parseJsonReply('```json \n\n ```', 'extraction')).toThrow(MalformedReplyError);
    expect(() => parseJsonReply('```json\n{"a": 1}', 'extraction')).toThrow(MalformedReplyError);
    expect(() => parseJsonReply('``', 'extraction')).toThrow(MalformedReplyError);
    expect(() => parseJsonReply('', 'extraction')).toThrow(MalformedReplyError);
    expect(() => parseJsonReply('   ', 'extraction')).toThrow(MalformedReplyError);
    expect(() => parseJsonReply('Here you go:\n```json\n{"a": 1}\n```', 'extraction')).toThrow(MalformedReplyError);
  });

  it('reads a long run of whitespace after the fence in linear time', () => {
    for (const filler of [' ', '\n', ' \n']) {
      const reply = '```' + filler.repeat(50_000) + 'x';
      const started = performance.now();
      expect(() => parseJsonReply(reply, 'extraction')).toThrow(MalformedReplyError);
      expect(performance.now() - started).toBeLessThan(500);
    }
    const started = performance.now();
    expect(parseJsonReply('```json' + '\n'.repeat(50_000) + '{"a": 1}' + '\n'.repeat(50_000) + '```', 'extraction')).toEqual({ a: 1 });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('parseExtraction (Stage 1 contract)', () => {
  const body = 'Elena is thirty-four. Later, Elena is thirty-four again.';
  const doc = { docId: 'sA', body };

  it('keeps a span whose offsets are verbatim', () => {
    const out = parseExtraction(extraction(body, 'sA', [{ quote: 'Elena is thirty-four.', category: CHARACTERIZATION }]), doc);
    expect(out.spans).toEqual([{ docId: 'sA', from: 0, to: 21, quote: 'Elena is thirty-four.', category: CHARACTERIZATION, note: '' }]);
    expect(out.notes).toEqual([]);
  });

  it('relocates a span with wrong offsets when its quote appears exactly once', () => {
    const reply = JSON.stringify({ spans: [{ docId: 'sA', from: 5, to: 9, quote: 'Elena is thirty-four.', category: CHARACTERIZATION, note: '' }] });
    const out = parseExtraction(reply, doc);
    expect(out.spans[0]).toMatchObject({ from: 0, to: 21 });
  });

  it('drops a span whose quote is not in the document, or appears more than once with bad offsets', () => {
    const missing = JSON.stringify({ spans: [{ docId: 'sA', from: 0, to: 5, quote: 'Dorian', category: CHARACTERIZATION, note: '' }] });
    const ambiguous = JSON.stringify({ spans: [{ docId: 'sA', from: 90, to: 110, quote: 'Elena is thirty-four', category: CHARACTERIZATION, note: '' }] });
    expect(parseExtraction(missing, doc).spans).toEqual([]);
    const out = parseExtraction(ambiguous, doc);
    expect(out.spans).toEqual([]);
    expect(out.notes[0]).toContain('not a verbatim slice');
  });

  it('drops a span that names another document, or a category outside the enum', () => {
    const otherDoc = JSON.stringify({ spans: [{ docId: 'sZ', from: 0, to: 5, quote: 'Elena', category: CHARACTERIZATION, note: '' }] });
    const badCategory = JSON.stringify({ spans: [{ docId: 'sA', from: 0, to: 5, quote: 'Elena', category: 'horoscope', note: '' }] });
    expect(parseExtraction(otherDoc, doc).spans).toEqual([]);
    expect(parseExtraction(badCategory, doc).spans).toEqual([]);
  });

  it('keeps at most twenty spans per document, and says so', () => {
    const many = Array.from({ length: 25 }, (_, i) => `item${i}`);
    const wide = { docId: 'sW', body: many.join(' ') };
    const reply = JSON.stringify({
      spans: many.map((quote) => {
        const from = wide.body.indexOf(quote);
        return { docId: 'sW', from, to: from + quote.length, quote, category: 'factual', note: '' };
      }),
    });
    const out = parseExtraction(reply, wide);
    expect(out.spans).toHaveLength(20);
    expect(out.notes.some((note) => note.includes('only the first 20 are kept'))).toBe(true);
  });

  it('keeps one of two spans over the same range', () => {
    const one = { docId: 'sA', from: 0, to: 21, quote: 'Elena is thirty-four.', category: CHARACTERIZATION, note: '' };
    const out = parseExtraction(JSON.stringify({ spans: [one, one] }), doc);
    expect(out.spans).toHaveLength(1);
  });

  it('is a malformed reply when spans is not a list', () => {
    expect(() => parseExtraction('{"spans": "none"}', doc)).toThrow(MalformedReplyError);
  });
});

describe('parseVerification (Stage 2 contract)', () => {
  const bodies = new Map([
    ['sA', 'Elena is thirty-four.'],
    ['sB', 'Elena is forty-one.'],
  ]);
  const pairs = new Map([['p1', { a: { docId: 'sA', from: 0, to: 21 }, b: { docId: 'sB', from: 0, to: 19 } }]]);
  const known = { pairs, bodies };

  it('drops a verdict for a pair that was not in its batch', () => {
    const out = parseVerification(JSON.stringify({ verdicts: [{ pairId: 'p9', verdict: 'consistent', reasoning: '', factGroup: { entity: 'x', attribute: 'y' } }] }), known);
    expect(out.verdicts).toEqual([]);
    expect(out.notes[0]).toBe('a verdict names a pair that is not in its batch; dropped');
  });

  it('drops a contradiction that has no reasoning or no factGroup', () => {
    const noReason = { pairId: 'p1', verdict: 'contradictory', reasoning: '', factGroup: { entity: 'Elena', attribute: 'age' } };
    const noGroup = { pairId: 'p1', verdict: 'contradictory', reasoning: 'They differ.', factGroup: {} };
    const out = parseVerification(JSON.stringify({ verdicts: [noReason, noGroup] }), known);
    expect(out.verdicts).toEqual([]);
    expect(out.notes).toHaveLength(2);
  });

  it('keeps the model passages when they are verbatim, and falls back to the pair otherwise', () => {
    const verbatim = [
      { docId: 'sA', from: 0, to: 21, quote: 'Elena is thirty-four.' },
      { docId: 'sB', from: 0, to: 19, quote: 'Elena is forty-one.' },
    ];
    const good = parseVerification(
      JSON.stringify({ verdicts: [{ pairId: 'p1', verdict: 'contradictory', reasoning: 'Age differs.', factGroup: { entity: 'Elena', attribute: 'age' }, evidence: verbatim }] }),
      known,
    );
    expect(good.verdicts[0]?.evidence).toEqual(verbatim);

    const wrong = parseVerification(
      JSON.stringify({
        verdicts: [{ pairId: 'p1', verdict: 'contradictory', reasoning: 'Age differs.', factGroup: { entity: 'Elena', attribute: 'age' }, evidence: [{ ...verbatim[0], quote: 'Elena is 34.' }, verbatim[1]] }],
      }),
      known,
    );
    expect(wrong.verdicts[0]?.evidence).toBeUndefined();
    expect(wrong.notes[0]).toContain('not verbatim');
  });
});

describe('a verdict cites the pair it judged (§5.3 Stage 2)', () => {
  const bodies = new Map([
    ['sA', 'Elena is thirty-four. Ansel is tall.'],
    ['sB', 'Elena is forty-one.'],
    ['sC', 'Elena is fifty.'],
  ]);
  const pairs = new Map([['p1', { a: { docId: 'sA', from: 0, to: 21 }, b: { docId: 'sB', from: 0, to: 19 } }]]);
  const elenaThirtyFour = { docId: 'sA', from: 0, to: 21, quote: 'Elena is thirty-four.' };
  const elenaFortyOne = { docId: 'sB', from: 0, to: 19, quote: 'Elena is forty-one.' };
  const verdictWith = (evidence: unknown): string =>
    JSON.stringify({
      verdicts: [{ pairId: 'p1', verdict: 'contradictory', reasoning: 'Age differs.', factGroup: { entity: 'Elena', attribute: 'age' }, evidence }],
    });

  it('refuses passages from a document outside the pair, and keeps the pair as the evidence', () => {
    const outside = { docId: 'sC', from: 0, to: 15, quote: 'Elena is fifty.' };
    const parsed = parseVerification(verdictWith([elenaThirtyFour, outside]), { pairs, bodies });
    expect(parsed.verdicts[0]?.evidence).toBeUndefined();
    expect(parsed.notes[0]).toContain("not the pair's two passages");
    const judged: PairRef = {
      pairId: 'p1',
      ordinal: 1,
      category: 'characterization',
      a: { docId: 'sA', from: 0, to: 21, quote: 'Elena is thirty-four.', category: 'characterization', note: '' },
      b: { docId: 'sB', from: 0, to: 19, quote: 'Elena is forty-one.', category: 'characterization', note: '' },
    };
    const assembled = assembleFindings(parsed.verdicts, {
      pairs: new Map([['p1', judged]]),
      entries: [],
      model: 'fake-1',
      docOrder: new Map([['sA', 1], ['sB', 2]]),
      maxFindings: 50,
      usageByPair: new Map(),
    });
    expect(assembled.drafts[0]?.evidence.map((passage) => passage.docId)).toEqual(['sA', 'sB']);
  });

  it('refuses a passage that does not overlap the span of the pair it stands for, and accepts the pair in either order', () => {
    const otherSpan = { docId: 'sA', from: 0, to: 21, quote: 'Elena is thirty-four.' };
    const pairOnAnsel = new Map([['p1', { a: { docId: 'sA', from: 22, to: 36 }, b: { docId: 'sB', from: 0, to: 19 } }]]);
    const refused = parseVerification(verdictWith([otherSpan, elenaFortyOne]), { pairs: pairOnAnsel, bodies });
    expect(refused.verdicts[0]?.evidence).toBeUndefined();

    const ansel = { docId: 'sA', from: 22, to: 36, quote: 'Ansel is tall.' };
    const reversed = parseVerification(verdictWith([elenaFortyOne, ansel]), { pairs: pairOnAnsel, bodies });
    expect(reversed.verdicts[0]?.evidence).toEqual([ansel, elenaFortyOne]);
  });
});

describe('normalizeFactGroup (§4.2)', () => {
  const entries = [entry(ELENA, 'Elena', { aliases: ['Lena'] }), entry('c_AAAAAAAAAA', 'Ansel'), entry('c_BBBBBBBBBB', 'Ansel Vey'), entry('c_CCCCCCCCCC', 'Ansel Coy')];

  it('resolves an exact name or alias to its entry id, and falls back to the lowercased name', () => {
    expect(normalizeFactGroup('Lena', ' Age ', entries)).toBe('c_5h8qk2m9rt|age');
    expect(normalizeFactGroup('The Ferryman', 'Crossing Time', entries)).toBe('the ferryman|crossing time');
  });

  it('will not guess between two entries that share a name', () => {
    const ambiguous = [entry('c_AAAAAAAAAA', 'Ansel'), entry('c_BBBBBBBBBB', 'Ansel')];
    expect(normalizeFactGroup('Ansel', 'height', ambiguous)).toBe('ansel|height');
  });

  it('keeps a world-rule id as the entity', () => {
    expect(normalizeFactGroup('w_9Q8WRN2TQ6', 'magic cost', entries)).toBe('w_9q8wrn2tq6|magic cost');
  });
});

describe('assembleFindings (Stage 4)', () => {
  const span = (docId: string, from: number, quote: string, category: ExtractedSpan['category']): ExtractedSpan => ({
    docId,
    from,
    to: from + quote.length,
    quote,
    category,
    note: '',
  });
  const pair = (pairId: string, a: ExtractedSpan, b: ExtractedSpan): PairRef => ({ pairId, ordinal: Number(pairId.slice(1)), category: a.category, a, b });
  const contradiction = (pairId: string, entity = 'Lena', attribute = 'Age '): ParsedVerdict => ({
    pairId,
    verdict: 'contradictory',
    reasoning: 'They disagree. Clearly.',
    entity,
    attribute,
  });
  const entries = [entry(ELENA, 'Elena', { aliases: ['Lena'] })];
  const docOrder = new Map([
    ['sA', 1],
    ['sB', 2],
  ]);

  it('maps each category to the spec severity, and orders the cap by severity first', () => {
    const p1 = pair('p1', span('sA', 0, 'one', 'narrative-style'), span('sB', 0, 'two', 'narrative-style'));
    const p2 = pair('p2', span('sA', 10, 'three', 'timeline-plot'), span('sB', 10, 'four', 'timeline-plot'));
    const p3 = pair('p3', span('sA', 20, 'five', 'characterization'), span('sB', 20, 'six', 'characterization'));
    const out = assembleFindings([contradiction('p1'), contradiction('p2'), contradiction('p3')], {
      pairs: new Map([['p1', p1], ['p2', p2], ['p3', p3]]),
      entries,
      model: 'fake-1',
      docOrder,
      maxFindings: 50,
      usageByPair: new Map(),
    });
    expect(out.drafts.map((d) => [d.checkId, d.severity])).toEqual([
      ['llm:timeline-plot', 'error'],
      ['llm:characterization', 'warning'],
      ['llm:narrative-style', 'info'],
    ]);
    expect(out.drafts[0]).toMatchObject({ class: 'llm', factGroup: 'c_5h8qk2m9rt|age', type: 'timeline-plot' });
  });

  it('merges repeat verdicts with one identity into one finding, and reports the merge', () => {
    const p1 = pair('p1', span('sA', 0, 'one', 'characterization'), span('sB', 0, 'two', 'characterization'));
    const p2 = pair('p2', span('sA', 10, 'three', 'characterization'), span('sB', 10, 'four', 'characterization'));
    const out = assembleFindings([contradiction('p1'), contradiction('p2')], {
      pairs: new Map([['p1', p1], ['p2', p2]]),
      entries,
      model: 'fake-1',
      docOrder,
      maxFindings: 50,
      usageByPair: new Map(),
    });
    expect(out.drafts).toHaveLength(1);
    expect(out.folded).toBe(1);
  });

  it('caps the findings, keeps the most severe, and says how many it left out', () => {
    const pairs = new Map<string, PairRef>();
    const verdicts: ParsedVerdict[] = [];
    ['p1', 'p2', 'p3'].forEach((id, i) => {
      pairs.set(id, pair(id, span('sA', i * 10, `a${i}`, 'characterization'), span('sB', i * 10, `b${i}`, 'characterization')));
      verdicts.push(contradiction(id, 'Lena', `attr${i}`));
    });
    const out = assembleFindings(verdicts, { pairs, entries, model: 'fake-1', docOrder, maxFindings: 2, usageByPair: new Map() });
    expect(out.drafts).toHaveLength(2);
    expect(out.overflow).toBe(1);
    expect(out.notes).toContain('1 further contradiction(s) not recorded; raise maxFindings or narrow the scope');
  });

  it('ignores anything that is not a contradiction', () => {
    const p1 = pair('p1', span('sA', 0, 'one', 'factual'), span('sB', 0, 'two', 'factual'));
    const consistent: ParsedVerdict = { pairId: 'p1', verdict: 'consistent', reasoning: '', entity: '', attribute: '' };
    const out = assembleFindings([consistent], { pairs: new Map([['p1', p1]]), entries, model: 'fake-1', docOrder, maxFindings: 50, usageByPair: new Map() });
    expect(out.drafts).toEqual([]);
  });
});

describe('candidatePairs and batchPairs', () => {
  it('pairs spans only within a category, and batches at most ten pairs per call', () => {
    const span = (docId: string, from: number, category: ExtractedSpan['category']): ExtractedSpan => ({ docId, from, to: from + 1, quote: 'x', category, note: '' });
    const spans = [span('sA', 0, 'factual'), span('sA', 5, 'factual'), span('sB', 0, 'factual'), span('sB', 9, 'world-building')];
    const pairs = candidatePairs(spans);
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.category === 'factual')).toBe(true);
    const many = Array.from({ length: 25 }, (_, i) => ({ pairId: `p${i}`, ordinal: i, category: 'factual' as const, a: spans[0]!, b: spans[1]! }));
    expect(batchPairs(many).map((batch) => batch.length)).toEqual([10, 10, 5]);
  });
});

describe('planReview (the plan card)', () => {
  function project(count: number): ReturnType<typeof buildState> {
    return buildState({
      scenes: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `Scene ${i}`, body: `Elena is in scene ${i}.` })),
      entries: [entry(ELENA, 'Elena')],
    });
  }

  it('counts one extraction call per document and an upper bound on verification', () => {
    const plan = planReview(project(2), emptyCoherenceFile(), { scope: { mode: 'full' } });
    expect(plan.estimate.extractCalls).toBe(2);
    expect(plan.estimate.extractTokens).toBe(plan.documents.reduce((sum, doc) => sum + doc.estimatedTokens, 0));
    expect(plan.estimate.verifyCallsAtMost).toBe(78);
    expect(plan.overGuard).toBe(false);
    expect(plan.categories).toEqual(ALL_CATEGORIES);
    expect(plan.promptPreview).toContain('BEGIN DOCUMENT');
  });

  it('asks for approval over the twenty-document guard', () => {
    const plan = planReview(project(21), emptyCoherenceFile(), { scope: { mode: 'full' } });
    expect(plan.overGuard).toBe(true);
    expect(plan.estimate.extractCalls).toBe(21);
  });

  it('refuses a cap above 200, and an empty category list', () => {
    expect(() => planReview(project(1), emptyCoherenceFile(), { scope: { mode: 'full' }, maxFindings: 500 })).toThrow(/from 1 to 200/);
    expect(() => planReview(project(1), emptyCoherenceFile(), { scope: { mode: 'full' }, categories: [] })).toThrow(CoherenceError);
  });

  it('narrows the categories the prompt names', () => {
    const plan = planReview(project(1), emptyCoherenceFile(), { scope: { mode: 'full' }, categories: ['factual'] });
    expect(plan.categories).toEqual(['factual']);
  });
});

describe('runReview (the approved run, against a fake port)', () => {
  const twoDocs = (): ReturnType<typeof buildState> =>
    buildState({
      scenes: [
        { id: 'sA', title: 'First', body: 'Elena is thirty-four.' },
        { id: 'sB', title: 'Second', body: 'Elena is forty-one.' },
      ],
      entries: [entry(ELENA, 'Elena')],
    });

  /** Extraction finds each document's age claim; verification calls every pair a contradiction about Elena's age. */
  function reviewing(): CoherenceModel & { calls: ModelRequest[] } {
    return fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        const docId = docIdOf(request.user);
        const quote = body.includes('thirty-four') ? 'Elena is thirty-four.' : 'Elena is forty-one.';
        return extraction(body, docId, [{ quote, category: CHARACTERIZATION }]);
      }
      const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({
        verdicts: pairIds.map((pairId) => ({
          pairId,
          verdict: 'contradictory',
          reasoning: 'Elena is thirty-four in one and forty-one in the other.',
          factGroup: { entity: 'Elena', attribute: 'age' },
        })),
      });
    });
  }

  it('refuses to run without an approval, or without a provider', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    await expect(runReview(state, emptyCoherenceFile(), plan, { model: reviewing(), approved: false, now: NOW })).rejects.toBeInstanceOf(ReviewNotApprovedError);
    await expect(runReview(state, emptyCoherenceFile(), plan, { model: undefined, approved: true, now: NOW })).rejects.toBeInstanceOf(NoProviderError);
  });

  it('extracts per document, verifies the pairs, and records llm findings with their model and tokens', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const model = reviewing();
    const result = await runReview(state, emptyCoherenceFile(), plan, { model, approved: true, now: NOW });

    expect(model.calls).toHaveLength(3);
    expect(result.status).toBe('complete');
    expect(result.file.findings).toHaveLength(1);
    const [finding] = result.file.findings;
    expect(finding).toMatchObject({
      class: 'llm',
      checkId: 'llm:characterization',
      type: 'characterization',
      severity: 'warning',
      status: 'open',
      factGroup: 'c_5h8qk2m9rt|age',
      modelMeta: { model: 'fake-1', promptTokens: 100, completionTokens: 20 },
    });
    expect(finding?.evidence.map((p) => p.docId)).toEqual(['sA', 'sB']);
    expect(finding?.evidence[0]?.quote).toBe('Elena is thirty-four.');

    const run = result.run;
    expect(run).toMatchObject({ kind: 'llm', status: 'complete', model: 'fake-1', checkIds: ALL_CATEGORIES.map((c) => `llm:${c}`) });
    expect(run.tokens).toEqual({ promptTokens: 300, completionTokens: 60 });
    expect(result.file.reviewState).toEqual({
      sA: { lastReviewedRevision: 0, lastReviewedAt: NOW.toISOString() },
      sB: { lastReviewedRevision: 0, lastReviewedAt: NOW.toISOString() },
    });
    expect(LATER.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('writes the run into the file as it stands once the model has answered, so a run recorded while it waited is kept', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const meanwhile: CoherenceRun = { id: 'r_MEANWHILE1', at: NOW.toISOString(), kind: 'deterministic', checkIds: [], scope: { docIds: [] }, findingsUpserted: [], status: 'complete' };
    let held: CoherenceFile = emptyCoherenceFile();
    const answering = reviewing();
    const model: CoherenceModel = {
      model: 'fake-1',
      complete: async (request: ModelRequest): Promise<ModelReply> => {
        // While the review waits on the model, a scan replaces the held file with its run in it.
        held = { ...emptyCoherenceFile(), runs: [meanwhile] };
        return answering.complete(request);
      },
    };
    const result = await runReview(state, emptyCoherenceFile(), plan, { model, approved: true, now: NOW, currentFile: () => held });
    expect(result.file.runs.map((run) => run.id)).toEqual(['r_MEANWHILE1', result.run.id]);
  });

  it('sends the category guide and the output contract with every extraction', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const model = reviewing();
    await runReview(state, emptyCoherenceFile(), plan, { model, approved: true, now: NOW });
    const first = model.calls[0];
    expect(first?.system).toContain('continuity extractor');
    for (const category of ALL_CATEGORIES) expect(first?.system).toContain(category);
    expect(first?.system).toContain('at most 20 spans');
    expect(first?.jsonSchemaHint).toMatchObject({ required: ['spans'] });
    expect(model.calls[2]?.system).toContain('judge whether two passages');
  });

  it('keeps the findings of a finished verification batch when a later batch fails, and leaves review state as it was', async () => {
    const quotes = ['Elena is thirty-four.', 'Ansel is tall.', 'The bridge is out.', 'Gulls cry at dawn.', 'Rain falls at dusk.', 'Night comes slowly.'];
    const state = buildState({
      scenes: [{ id: 'sA', title: 'One', body: quotes.join(' ') }],
      entries: [entry(ELENA, 'Elena')],
    });
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    // Six spans of one category make 15 pairs: a first verification call of ten, and a second of five.
    const model = fake((request, index) => {
      if (request.system.includes('continuity extractor')) {
        return extraction(bodyOf(request.user), docIdOf(request.user), quotes.map((quote) => ({ quote, category: CHARACTERIZATION })));
      }
      if (index > 1) return new Error('provider timed out');
      const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({
        verdicts: pairIds.map((pairId) => ({
          pairId,
          verdict: 'contradictory',
          reasoning: 'Elena is thirty-four in one and forty-one in the other.',
          factGroup: { entity: 'Elena', attribute: 'age' },
        })),
      });
    });
    const result = await runReview(state, emptyCoherenceFile(), plan, { model, approved: true, now: NOW });
    expect(model.calls).toHaveLength(3);
    expect(result.status).toBe('partial');
    expect(result.file.findings.length).toBeGreaterThan(0);
    // The note names the pair by its number in the run (p11 is the eleventh pair), never by its id.
    expect(result.notes.some((note) => note.includes('verification stopped at pair 11: provider timed out'))).toBe(true);
    expect(result.file.reviewState).toEqual({});
  });

  it('stops at a failed extraction, marks the run partial, and does not advance review state', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const model = fake((request, index) => {
      if (index === 1) return new Error('provider timed out');
      const body = bodyOf(request.user);
      return extraction(body, docIdOf(request.user), [{ quote: 'Elena is thirty-four.', category: CHARACTERIZATION }]);
    });
    const result = await runReview(state, emptyCoherenceFile(), plan, { model, approved: true, now: NOW });
    expect(result.status).toBe('partial');
    expect(result.file.findings).toEqual([]);
    expect(result.notes.some((note) => note.includes('extraction stopped at "Second": provider timed out'))).toBe(true);
    expect(result.file.reviewState).toEqual({});
  });

  it('marks the run partial when a reply is not the contract, and records nothing for it', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const model = fake(() => 'I think Elena is old.');
    const result = await runReview(state, emptyCoherenceFile(), plan, { model, approved: true, now: NOW });
    expect(result.status).toBe('partial');
    expect(result.notes.some((note) => note.includes('was unusable'))).toBe(true);
  });

  it('treats an empty result as a result, not an error', async () => {
    const state = twoDocs();
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const result = await runReview(state, emptyCoherenceFile(), plan, { model: fake(() => '{"spans": []}'), approved: true, now: NOW });
    expect(result.status).toBe('complete');
    expect(result.file.findings).toEqual([]);
    expect(result.run.findingsUpserted).toEqual([]);
  });

  it('applies the cap to the number of findings it records', async () => {
    const state = buildState({
      scenes: [
        { id: 'sA', title: 'One', body: 'Elena is thirty-four.' },
        { id: 'sB', title: 'Two', body: 'Elena is forty-one.' },
        { id: 'sC', title: 'Three', body: 'Elena is fifty.' },
      ],
      entries: [entry(ELENA, 'Elena')],
    });
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' }, maxFindings: 2 });
    const model = fake((request) => {
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        return extraction(body, docIdOf(request.user), [{ quote: body.slice(0, body.indexOf('.') + 1), category: CHARACTERIZATION }]);
      }
      const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
      return JSON.stringify({
        verdicts: pairIds.map((pairId) => ({ pairId, verdict: 'contradictory', reasoning: 'They clash.', factGroup: { entity: 'Elena', attribute: 'age' } })),
      });
    });
    const result = await runReview(state, emptyCoherenceFile(), plan, { model, approved: true, now: NOW });
    expect(result.file.findings).toHaveLength(2);
    expect(result.notes.some((note) => note.includes('further contradiction(s) not recorded'))).toBe(true);
  });
});
