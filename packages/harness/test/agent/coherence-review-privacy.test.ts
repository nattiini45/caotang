import { describe, expect, it, vi } from 'vitest';

import { addDocument, createEmptyManifest, createProjectState, type CodexEntry, type ProjectState } from '@caotang/store';
import { computeReview, emptyCoherenceFile, planReview, type CoherenceModel, type ModelRequest } from '@caotang/coherence';
import { excludedBy, reviewContextOf, withheldState } from '../../src/index.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');

function bodyOf(user: string): string {
  const start = user.indexOf('--- BEGIN DOCUMENT ---\n') + '--- BEGIN DOCUMENT ---\n'.length;
  return user.slice(start, user.indexOf('\n--- END DOCUMENT ---'));
}

function docIdOf(user: string): string {
  return /docId: ([A-Za-z0-9]+)\)/.exec(user)?.[1] ?? '';
}

function captureModel(): CoherenceModel & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    model: 'fake-1',
    calls,
    async complete(request) {
      calls.push(request);
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        const docId = docIdOf(request.user);
        const quote = body.slice(0, 12);
        return { content: JSON.stringify({ spans: [{ docId, from: 0, to: quote.length, quote, category: 'factual', note: '' }] }), usage: { promptTokens: 10, completionTokens: 5 } };
      }
      return { content: JSON.stringify({ verdicts: [] }), usage: { promptTokens: 10, completionTokens: 5 } };
    },
  };
}

describe('a queued review reads only the agent-readable context', () => {
  it('never sends a withheld earlier document gist or a withheld codex description in the payload', async () => {
    const manifest = createEmptyManifest('Fixture', NOW);
    const secret: CodexEntry = {
      id: 'c_SECRET0001', name: 'Secret', aliases: [], type: 'character', description: 'SECRET-CODEX-DESCRIPTION',
      includePolicy: 'always', caseSensitive: false, exclude: [], attachments: ['sB'], keywords: [], origin: 'manual', sources: [],
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    };
    manifest.codex = [secret];
    const state = createProjectState(manifest, { now: NOW });
    addDocument(state, { id: 'sB', parentId: 'manuscript', title: 'Earlier', body: 'SECRET-EARLIER-BODY', synopsis: 'SECRET-EARLIER-SYNOPSIS', now: NOW });
    addDocument(state, { id: 'sA', parentId: 'manuscript', title: 'Focus', body: 'Elena is thirty-four.', now: NOW });

    const withheld = new Set(['sB']);
    const view = withheldState(state, withheld);
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'doc', docIds: ['sA'] }, ...(excludedBy(withheld) === undefined ? {} : { isExcluded: excludedBy(withheld) }) }, reviewContextOf(view));
    const model = captureModel();
    await computeReview(state, emptyCoherenceFile(), plan, { model, approved: true, context: reviewContextOf(view), ...(excludedBy(withheld) === undefined ? {} : { isExcluded: excludedBy(withheld) }) });

    expect(model.calls.length).toBeGreaterThan(0);
    for (const request of model.calls) {
      const text = request.system + request.user;
      expect(text).not.toContain('SECRET-EARLIER-BODY');
      expect(text).not.toContain('SECRET-EARLIER-SYNOPSIS');
      expect(text).not.toContain('SECRET-CODEX-DESCRIPTION');
      expect(text).not.toContain('docId: sB');
    }
  });
});

describe('a queued review yields its deterministic preparation', () => {
  function manyFacts(count: number): { state: ProjectState; spans: (docId: string, body: string) => string } {
    const manifest = createEmptyManifest('Fixture', NOW);
    const state = createProjectState(manifest, { now: NOW });
    for (let d = 0; d < 4; d += 1) {
      const body = Array.from({ length: count }, (_, i) => `Fact ${d}-${i} is here.`).join(' ');
      addDocument(state, { id: `s${d}`, parentId: 'manuscript', title: `Doc ${d}`, body, now: NOW });
    }
    const spans = (docId: string, body: string): string => {
      const items = Array.from({ length: count }, (_, i) => {
        const quote = `Fact ${docId.slice(1)}-${i} is here.`;
        const from = body.indexOf(quote);
        return { docId, from, to: from + quote.length, quote, category: 'factual', note: '' };
      });
      return JSON.stringify({ spans: items });
    };
    return { state, spans };
  }

  it('yields to the host while materializing a large pair set, and runs straight through without the hook', async () => {
    const { state, spans } = manyFacts(20);
    const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
    const makeModel = (): CoherenceModel => ({
      model: 'fake-1',
      async complete(request) {
        if (request.system.includes('continuity extractor')) return { content: spans(docIdOf(request.user), bodyOf(request.user)), usage: { promptTokens: 10, completionTokens: 5 } };
        const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
        return { content: JSON.stringify({ verdicts: pairIds.map((pairId) => ({ pairId, verdict: 'consistent', reasoning: 'ok', factGroup: { entity: 'x', attribute: 'y' } })) }), usage: { promptTokens: 10, completionTokens: 5 } };
      },
    });
    const yieldToHost = vi.fn(async () => {});
    await computeReview(state, emptyCoherenceFile(), plan, { model: makeModel(), approved: true, yieldToHost });
    expect(yieldToHost.mock.calls.length).toBeGreaterThan(0);

    const foreground = vi.fn(async () => {});
    await computeReview(state, emptyCoherenceFile(), plan, { model: makeModel(), approved: true });
    expect(foreground).not.toHaveBeenCalled();
  });
});
