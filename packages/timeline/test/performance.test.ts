import { addDocument, addFolder, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import type { CoherenceFile, SceneMeta } from '@caotang/coherence';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { bundleWorkSource } from '../../../test/support/bundle-work.js';
import { measureWork, type WorkCall, type WorkResult } from '../../../test/support/measure-work.js';

import { buildTimeline, projectTimeline, type LaneKey, type TimelineAxis, type TimelineGeometry, type TimelineModel } from '../src/index.js';

import { NOW, coherence, entry } from './fixtures.js';

const SCENES = 2000;
const LANES = 12;
const SAMPLES = 30;
const WARM_UP = 8;
const BUILD_WORK_PER_SCENE = 200;
const PROJECT_WORK_PER_SCENE = 10;
const WORK_GROWTH = 8;
const ENTRY = new URL('../src/index.ts', import.meta.url);
const source = bundleWorkSource(ENTRY, ['buildTimeline']);
const projectionSource = bundleWorkSource(ENTRY, ['projectTimeline']);
const buildWrapper = `
  export function measuredBuild(manifest, documents, file, options) {
    return exports.buildTimeline({ manifest, documents: new Map(documents) }, file, options);
  }
`;

function buildCall({ state, file }: ReturnType<typeof fixture>, axis: TimelineAxis, groupBy: LaneKey): WorkCall {
  return { name: 'measuredBuild', args: [state.manifest, [...state.documents], file, { axis, groupBy }] };
}

function expectBudget(small: WorkResult<unknown>, large: WorkResult<unknown>, perScene: number): void {
  expect(large.steps + large.scanned + large.backtracks).toBeLessThan(SCENES * perScene);
  expect(small.steps).toBeGreaterThan(0);
  for (const metric of ['steps', 'scanned', 'backtracks'] as const) {
    expect(large[metric] / Math.max(small[metric], 1), metric).toBeLessThan(WORK_GROWTH);
  }
}

/** A small deterministic generator, so the fixture is the same on every machine. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function fixture(scenes = SCENES): { state: ProjectState; file: CoherenceFile } {
  const random = lcg(176);
  const manifest = createEmptyManifest('Series', NOW);
  manifest.codex = Array.from({ length: LANES }, (_, i) => entry(`c${i}`, `Character ${i}`));
  const state = createProjectState(manifest, { now: NOW });
  const meta: Record<string, SceneMeta> = {};

  const prologue = 40;
  const epilogue = 40;
  const mainCount = scenes - prologue - epilogue;
  const chapters = 40;
  addFolder(state, { id: 'pro', parentId: 'manuscript', title: 'Prologue', now: NOW });
  meta.pro = { storyPart: 'prologue' };
  for (let c = 0; c < chapters; c += 1) addFolder(state, { id: `ch${c}`, parentId: 'manuscript', title: `Chapter ${c}`, now: NOW });
  addFolder(state, { id: 'epi', parentId: 'manuscript', title: 'Epilogue', now: NOW });
  meta.epi = { storyPart: 'epilogue' };

  const modes = ['linear', 'linear', 'linear', 'flashback', 'flash-forward', 'parallel', 'dream', 'backstory', 'simultaneous', 'time-skip', 'circular', 'frame', 'mythic'] as const;
  const scene = (id: string, parent: string, day: number | undefined, at: number): void => {
    addDocument(state, { id, parentId: parent, title: `Scene ${at}`, body: 'word '.repeat(5 + (at % 40)), now: NOW });
    const entry: SceneMeta = {
      expectedPresent: [`c${at % LANES}`, ...(at % 3 === 0 ? [`c${(at * 7) % LANES}`] : [])],
      pov: `c${at % LANES}`,
      timelineMode: modes[at % modes.length] as (typeof modes)[number],
    };
    if (day !== undefined) {
      entry.dayOffset = day;
      if (at % 9 === 0) entry.durationDays = 1 + Math.floor(random() * 4);
    }
    if (at % 25 === 0 && at > 0) entry.after = [`s${at - 1}`];
    if (at % 40 === 0) entry.threads = [{ id: `t${at % 5}`, payoff: `s${Math.min(scenes - 1, at + 30)}` }];
    meta[id] = entry;
  };

  let at = 0;
  for (let i = 0; i < prologue; i += 1, at += 1) scene(`s${at}`, 'pro', -4000 + i * 3, at);
  for (let i = 0; i < mainCount; i += 1, at += 1) {
    // About one scene in nine is left undated, and every fourth day holds several scenes at once.
    const day = i % 9 === 8 ? undefined : Math.floor(i / 3) * (i % 31 === 0 ? 9 : 1);
    scene(`s${at}`, `ch${Math.floor(i / (mainCount / chapters))}`, day, at);
  }
  for (let i = 0; i < epilogue; i += 1, at += 1) scene(`s${at}`, 'epi', 5000 + i * 2, at);
  return { state, file: coherence(meta) };
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
}

function measure(run: () => unknown): { median: number; p95: number; max: number } {
  for (let i = 0; i < WARM_UP; i += 1) run();
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { median: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: samples[samples.length - 1] as number };
}

describe('the 2,000-scene, 12-lane fixture', { timeout: 120_000 }, () => {
  const large = fixture();
  const small = fixture(500);
  const { state, file } = large;
  const cases: [TimelineAxis, LaneKey][] = [
    ['story', 'character'],
    ['story', 'pov'],
    ['narrative', 'character'],
    ['braid', 'pov'],
  ];
  let builds: WorkResult<TimelineModel>[];

  beforeAll(async () => {
    builds = measureWork<TimelineModel>(await source + buildWrapper, cases.flatMap(([axis, groupBy]) => [small, large].map((input) => buildCall(input, axis, groupBy))));
  }, 120_000);

  it('is the fixture the budget names', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'pov' });
    expect(model.stats.scenes).toBe(SCENES);
    expect(model.lanes).toHaveLength(LANES);
    expect(model.zones.map((zone) => zone.part)).toEqual(['prologue', 'main', 'epilogue']);
    expect(model.unscheduled.loose.length + model.unscheduled.sequenced.length).toBeGreaterThan(0);
    expect(model.axis.folds).toHaveLength(2);
    expect(model.connectors.length).toBeGreaterThan(0);
  });

  it.each(cases)('builds the %s axis grouped by %s within the work budget', (axis, groupBy) => {
    const at = cases.findIndex(([a, g]) => a === axis && g === groupBy) * 2;
    const measured = builds.slice(at, at + 2);
    for (const [i, input] of [small, large].entries()) {
      expect(measured[i]!.result).toEqual(buildTimeline(input.state, input.file, { axis, groupBy }));
    }
    expectBudget(measured[0]!, measured[1]!, BUILD_WORK_PER_SCENE);
    process.stdout.write(`timeline work ${axis}/${groupBy}: ${JSON.stringify(measured.map(({ steps, scanned, backtracks }) => ({ steps, scanned, backtracks })))}\n`);
    const stats = measure(() => buildTimeline(state, file, { axis, groupBy }));
    process.stdout.write(`timeline build ${axis}/${groupBy}: median ${stats.median.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, max ${stats.max.toFixed(1)} ms (${SAMPLES} samples after ${WARM_UP} warm-up runs, ${SCENES} scenes)\n`);
  });

  it('projects the finished model to coordinates within the work budget too', async () => {
    const models = [small, large].map(({ state, file }) => buildTimeline(state, file, { axis: 'story', groupBy: 'character' }));
    const measured = measureWork<TimelineGeometry>(await projectionSource, models.map((model) => ({ name: 'projectTimeline', args: [model] })));
    for (const [i, model] of models.entries()) expect(measured[i]!.result).toEqual(projectTimeline(model));
    expectBudget(measured[0]!, measured[1]!, PROJECT_WORK_PER_SCENE);
    process.stdout.write(`timeline projection work: ${JSON.stringify(measured.map(({ steps, scanned, backtracks }) => ({ steps, scanned, backtracks })))}\n`);
    const model = models[1]!;
    const stats = measure(() => projectTimeline(model));
    process.stdout.write(`timeline projection story/character: median ${stats.median.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms\n`);
  });

  it('rejects replacing the part index with a repeated scene search', async () => {
    const file = new URL('../src/build.ts', import.meta.url);
    const original = readFileSync(file, 'utf8');
    const quadratic = original.replace('parts.get(node.id)', 'Array.from(parts).find(([id]) => id === node.id)?.[1]');
    expect(quadratic).not.toBe(original);
    const mutant = await bundleWorkSource(ENTRY, ['buildTimeline'], { [fileURLToPath(file)]: quadratic });
    const measured = measureWork<TimelineModel>(mutant + buildWrapper, [small, large].map((input) => buildCall(input, 'story', 'character')));
    for (const [i, input] of [small, large].entries()) {
      expect(measured[i]!.result).toEqual(buildTimeline(input.state, input.file, { axis: 'story', groupBy: 'character' }));
    }
    expect(() => expectBudget(measured[0]!, measured[1]!, BUILD_WORK_PER_SCENE)).toThrow();
    expect(measured[1]!.steps / measured[0]!.steps).toBeGreaterThan(WORK_GROWTH);
    process.stdout.write(`timeline repeated-search mutant steps: ${measured.map(({ steps }) => steps).join(' -> ')}\n`);
  });

  it('rejects recomputing every slot prefix during projection', async () => {
    const file = new URL('../src/axis.ts', import.meta.url);
    const original = readFileSync(file, 'utf8');
    const quadratic = original.replace('slotX[i] = i * slotPx;', 'slotX[i] = measures.slice(0, i).reduce((sum) => sum + slotPx, 0);');
    expect(quadratic).not.toBe(original);
    const mutant = await bundleWorkSource(ENTRY, ['projectTimeline'], { [fileURLToPath(file)]: quadratic });
    const models = [small, large].map(({ state, file }) => buildTimeline(state, file, { axis: 'story', groupBy: 'character' }));
    const measured = measureWork<TimelineGeometry>(mutant, models.map((model) => ({ name: 'projectTimeline', args: [model] })));
    for (const [i, model] of models.entries()) expect(measured[i]!.result).toEqual(projectTimeline(model));
    expect(() => expectBudget(measured[0]!, measured[1]!, PROJECT_WORK_PER_SCENE)).toThrow();
    expect(measured[1]!.steps / measured[0]!.steps).toBeGreaterThan(WORK_GROWTH);
    process.stdout.write(`timeline repeated-prefix mutant steps: ${measured.map(({ steps }) => steps).join(' -> ')}\n`);
  });

  it('is deterministic: two builds of the same input are equal', () => {
    const a = buildTimeline(state, file, { axis: 'braid', groupBy: 'character' });
    const b = buildTimeline(state, file, { axis: 'braid', groupBy: 'character' });
    expect(b).toEqual(a);
  });
});
