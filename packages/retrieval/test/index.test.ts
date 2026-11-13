import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addDocument, setBody } from '@caotang/store';
import { createLexicalIndex, searchCandidates } from '../src/index.js';
import { entry, id, project } from './fixtures.js';

describe('local lexical passages', () => {
  it('resolves permission candidates from binder metadata without reading document text', () => {
    const state = project(['ferry', 'letter']);
    addDocument(state, { id: 'n_RESRCH0001', parentId: 'research', title: 'Research', body: 'ferry notes', now: new Date('2026-11-13T12:00:00Z') });
    Object.defineProperty(state, 'documents', { get: () => { throw new Error('Permission candidates must not read document text.'); } });
    const candidates = searchCandidates(state, { excludeAfter: id(0) });
    expect(candidates.eligible.map((node) => node.id)).toContain(id(0));
    expect(candidates.eligible.map((node) => node.id)).not.toContain(id(1));
    expect(candidates.eligible.map((node) => node.id)).toContain('n_RESRCH0001');
    expect(searchCandidates(state, { scope: ['research'] }).eligible.map((node) => node.id)).toEqual(['research', 'n_RESRCH0001']);
  });
  it('uses source coordinates, paragraph boundaries and whole short paragraphs', () => {
    const paragraph = `lighthouse ${'storm '.repeat(180)}`;
    const body = `The ferry.\r\n\r\n${paragraph}\r\n\r\nThe letter.`;
    const state = project([body]);
    const [hit] = createLexicalIndex().search(state, 'lighthouse');
    expect(hit?.unit).toMatchObject({ nodeId: id(0), field: 'body', from: 14, to: 14 + paragraph.length, text: paragraph });
    expect(body.slice(hit!.unit.from, hit!.unit.to)).toBe(hit?.unit.text);
    expect(body.slice(hit!.snippet.from, hit!.snippet.to)).toBe(hit?.snippet.text);
  });

  it('splits long paragraphs into bounded source ranges without splitting surrogate pairs', () => {
    const body = `${'😀storm '.repeat(900)} lighthouse`;
    const state = project([body]);
    const hits = createLexicalIndex().search(state, 'storm', { limit: 25 });
    expect(hits.length).toBeGreaterThan(2);
    for (const hit of hits) {
      expect(hit.unit.text.length).toBeLessThanOrEqual(800);
      expect(body.slice(hit.unit.from, hit.unit.to)).toBe(hit.unit.text);
      expect(hit.snippet.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });

  it.each([
    ['en', 'A lighthouse in the storm.', 'LIGHTHOUSE'],
    ['de', 'Die Straße führt zur Küste.', 'STRAẞE'],
    ['fr', 'Le Cafe\u0301 est fermé.', 'CAFÉ'],
    ['zh', '灯塔照亮海面。', '灯塔'],
    ['ja', '灯台から海が見える。', '灯台'],
    ['not_a_language', 'The lighthouse.', 'lighthouse'],
  ])('segments and folds %s words without losing original offsets', (language, body, query) => {
    const [hit] = createLexicalIndex().search(project([body], language), query);
    expect(hit).toBeDefined();
    expect(body.slice(hit!.snippet.from, hit!.snippet.to)).toBe(hit?.snippet.text);
  });

  it('keeps the codex fold: no accent stripping, stemming or ss expansion', () => {
    const state = project(['Straße, Küste, storms.'], 'de');
    expect(createLexicalIndex().search(state, 'strasse kuste storm')).toEqual([]);
  });

  it('requires quoted phrases to be adjacent tokens', () => {
    const state = project(['A grey lighthouse.', 'A grey old lighthouse.', 'LIGHTHOUSE grey.']);
    expect(createLexicalIndex().search(state, '"grey lighthouse"').map((hit) => hit.unit.nodeId)).toEqual([id(0)]);
    expect(createLexicalIndex().search(state, '-> === ***')).toEqual([]);
    expect(createLexicalIndex().search(state, '')).toEqual([]);
  });

  it('matches the hand-computed BM25 score and recomputes global length statistics after an unrelated edit', () => {
    const state = project(['lighthouse storm', 'quiet harbour']);
    const index = createLexicalIndex();
    expect(index.search(state, 'lighthouse')[0]?.score).toBe(0.693147);
    setBody(state, id(1), 'quiet '.repeat(20).trim());
    expect(index.search(state, 'lighthouse')[0]?.score).toBe(1.041873);
    expect(index.search(state, 'lighthouse')).toEqual(createLexicalIndex().search(state, 'lighthouse'));
  });

  it('breaks ties by binder order and then field order, not cache insertion order', () => {
    const state = project(['lighthouse', 'lighthouse']);
    state.manifest.tree.find((node) => node.id === id(0))!.notes = 'lighthouse';
    const index = createLexicalIndex();
    expect(index.search(state, 'lighthouse').map((hit) => [hit.unit.nodeId, hit.unit.field])).toEqual([[id(0), 'body'], [id(0), 'notes'], [id(1), 'body']]);
    state.manifest.tree.find((node) => node.id === id(1))!.order = 0;
    expect(index.search(state, 'lighthouse')).toEqual(createLexicalIndex().search(state, 'lighthouse'));
    expect(index.search(state, 'lighthouse')[0]?.unit.nodeId).toBe(id(1));
  });

  it('rescans only the changed document, and invalidates notes independently of body revision', () => {
    const state = project(['storm', 'ferry']);
    const index = createLexicalIndex();
    index.search(state, 'storm');
    expect(index.stats.documentPasses).toBe(2);
    index.search(state, 'ferry');
    expect(index.stats.documentPasses).toBe(2);
    setBody(state, id(0), 'letter');
    index.search(state, 'letter');
    expect(index.stats.documentPasses).toBe(3);
    state.manifest.tree.find((node) => node.id === id(1))!.notes = 'letter';
    expect(index.search(state, 'letter', { fields: ['notes'] })).toHaveLength(1);
    expect(index.stats.documentPasses).toBe(4);
  });

  it('excludes Never and read-denied units before scoring, including after cached policy changes', () => {
    const state = project(['lighthouse storm', 'lighthouse lighthouse lighthouse']);
    entry(state);
    const index = createLexicalIndex();
    index.search(state, 'lighthouse');
    state.manifest.codex![0]!.includePolicy = 'never';
    const filtered = index.search(state, 'lighthouse', { excluded: new Set([id(1)]) });
    expect(filtered.map((hit) => hit.unit.nodeId)).toEqual([id(0)]);
    expect(filtered[0]?.score).toBe(0.287682);
    expect(index.stats.units).toBe(1);
    state.manifest.codex![0]!.includePolicy = 'detected';
    state.manifest.codex![0]!.description = 'A letter.';
    index.bumpCodexRevision();
    expect(index.search(state, 'letter')).toEqual(createLexicalIndex().search(state, 'letter'));
  });

  it('expands scope and labels forward, focus and research results correctly', () => {
    const state = project(['lighthouse', 'lighthouse', 'lighthouse']);
    addDocument(state, { id: id(9), parentId: 'research', title: 'Reference', body: 'lighthouse' });
    const index = createLexicalIndex();
    expect(index.search(state, 'lighthouse', { focus: id(1) }).map((hit) => hit.position)).toEqual(['before-focus', 'focus', 'after-focus', 'research']);
    expect(index.search(state, 'lighthouse', { excludeAfter: id(1) }).map((hit) => hit.position)).toEqual(['before-focus', 'focus', 'research']);
    expect(index.search(state, 'lighthouse', { scope: ['research'] }).map((hit) => hit.unit.nodeId)).toEqual([id(9)]);
    expect(index.search(state, 'lighthouse', { scope: [] })).toEqual([]);
  });

  it('agrees exactly with a rebuilt index after seeded random edit sequences', () => {
    for (let seed = 1; seed <= 12; seed++) {
      let random = seed;
      const next = (): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
      const state = project(Array.from({ length: 6 }, () => 'lighthouse storm ferry letter'));
      entry(state);
      const index = createLexicalIndex();
      for (let step = 0; step < 30; step++) {
        const target = next() % 6;
        const node = state.manifest.tree.find((item) => item.id === id(target))!;
        switch (next() % 6) {
          case 0: setBody(state, node.id, `${'ferry '.repeat(next() % 60)}\n\nlighthouse storm ${next()}`); break;
          case 1: node.notes = `letter ${next()}`; break;
          case 2: node.synopsis = `storm ${next()}`; break;
          case 3: node.order = next() % 100; node.title = `Scene ${next()}`; break;
          case 4: state.manifest.codex![0]!.description = `letter ${next()}`; index.bumpCodexRevision(); break;
          case 5: state.manifest.codex![0]!.includePolicy = next() % 2 ? 'never' : 'detected'; break;
        }
        const options = { focus: id(next() % 6), ...(step % 3 === 0 ? { excluded: new Set([id(next() % 6)]) } : {}) };
        const rebuilt = createLexicalIndex();
        for (const query of ['lighthouse letter', 'ferry', '"lighthouse storm"']) {
          expect(index.search(state, query, options), `seed ${seed}, step ${step}, query ${query}`).toEqual(rebuilt.search(state, query, options));
        }
      }
    }
  });

  it('has no network, browser-storage or DOM execution path', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|indexedDB|localStorage|window)\b/);
    expect([...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1])).toEqual(['@caotang/codex', '@caotang/store']);
  });

  it('forgets deleted nodes, picks up additions and retokenizes when the project language changes', () => {
    const state = project(['lighthouse', 'ferry']);
    const index = createLexicalIndex();
    index.search(state, 'lighthouse');
    state.manifest.tree = state.manifest.tree.filter((node) => node.id !== id(0));
    state.documents.delete(id(0));
    expect(index.search(state, 'lighthouse')).toEqual([]);
    addDocument(state, { id: id(2), parentId: 'manuscript', title: 'New scene', body: '灯塔照亮海面。' });
    state.manifest.project.language = 'zh';
    expect(index.search(state, '灯塔')).toEqual(createLexicalIndex().search(state, '灯塔'));
    expect(index.search(state, '灯塔')[0]?.unit.nodeId).toBe(id(2));
  });
});
