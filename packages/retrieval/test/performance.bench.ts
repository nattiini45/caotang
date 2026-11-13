import { expect, it } from 'vitest';
import { setBody } from '@caotang/store';
import { createLexicalIndex } from '../src/index.js';
import { id, project } from './fixtures.js';

it('benchmarks 200,000 words and 100 scenes', async ({ bench }) => {
  const words = ['lighthouse', 'storm', 'ferry', 'letter', 'harbour', 'keeper', 'island', 'rain'];
  const bodies = Array.from({ length: 100 }, (_, scene) => Array.from({ length: 2000 }, (_, word) => word % 8 === 0 ? words[(word / 8) % 8] : `lexeme${(scene * 2000 + word) % 10_000}`).join(' '));
  const state = project(bodies);
  const incremental = createLexicalIndex();
  incremental.search(state, 'lighthouse letter');
  let edits = 0;
  const cold = await bench('build and first query', () => {
    const hits = createLexicalIndex().search(state, 'lighthouse letter');
    if (hits.length === 0) throw new Error('The benchmark must perform a real search.');
  }).run({ iterations: 20, time: 0, warmupTime: 0, warmupIterations: 0 });

  const edited = await bench('one edited scene and incremental query', () => {
    setBody(state, id(0), `${bodies[0]} revision${++edits}`);
    const hits = incremental.search(state, 'lighthouse letter');
    if (hits.length === 0) throw new Error('The benchmark must perform a real search.');
  }).run({ iterations: 50, time: 0, warmupTime: 0, warmupIterations: 0 });
  console.warn(JSON.stringify({ words: 200_000, scenes: 100, vocabulary: incremental.stats.terms, units: incremental.stats.units, cold: cold.latency, edited: edited.latency }));
  expect(cold.latency.p99).toBeLessThanOrEqual(250);
  expect(edited.latency.p99).toBeLessThanOrEqual(50);
}, 30_000);
