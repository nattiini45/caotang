import { addDocument, addFolder, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import type { CoherenceFile, SceneMeta } from '@caotang/coherence';
import { describe, expect, it } from 'vitest';

import { buildTimeline, projectTimeline, type LaneKey, type TimelineAxis } from '../src/index.js';

import { NOW, coherence, entry } from './fixtures.js';

const SCENES = 2000;
const LANES = 12;
const SAMPLES = 30;
const WARM_UP = 8;
/** The spec's target is 30 ms on the declared CI runner; this ceiling only catches a real regression without flaking under load. */
const CEILING_MS = 300;

/** A small deterministic generator, so the fixture is the same on every machine. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function fixture(): { state: ProjectState; file: CoherenceFile } {
  const random = lcg(176);
  const manifest = createEmptyManifest('Series', NOW);
  manifest.codex = Array.from({ length: LANES }, (_, i) => entry(`c${i}`, `Character ${i}`));
  const state = createProjectState(manifest, { now: NOW });
  const meta: Record<string, SceneMeta> = {};

  const prologue = 40;
  const epilogue = 40;
  const mainCount = SCENES - prologue - epilogue;
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
    if (at % 40 === 0) entry.threads = [{ id: `t${at % 5}`, payoff: `s${Math.min(SCENES - 1, at + 30)}` }];
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

describe('the 2,000-scene, 12-lane fixture', () => {
  const { state, file } = fixture();
  const cases: [TimelineAxis, LaneKey][] = [
    ['story', 'character'],
    ['story', 'pov'],
    ['narrative', 'character'],
    ['braid', 'pov'],
  ];

  it('is the fixture the budget names', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'pov' });
    expect(model.stats.scenes).toBe(SCENES);
    expect(model.lanes).toHaveLength(LANES);
    expect(model.zones.map((zone) => zone.part)).toEqual(['prologue', 'main', 'epilogue']);
    expect(model.unscheduled.loose.length + model.unscheduled.sequenced.length).toBeGreaterThan(0);
    expect(model.axis.folds).toHaveLength(2);
    expect(model.connectors.length).toBeGreaterThan(0);
  });

  it.each(cases)('builds the %s axis grouped by %s within the ceiling', (axis, groupBy) => {
    const stats = measure(() => buildTimeline(state, file, { axis, groupBy }));
    process.stdout.write(`timeline build ${axis}/${groupBy}: median ${stats.median.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, max ${stats.max.toFixed(1)} ms (${SAMPLES} samples after ${WARM_UP} warm-up runs, ${SCENES} scenes)\n`);
    expect(stats.p95).toBeLessThan(CEILING_MS);
  });

  it('projects the finished model to coordinates within the ceiling too', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'character' });
    const stats = measure(() => projectTimeline(model));
    process.stdout.write(`timeline projection story/character: median ${stats.median.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms\n`);
    expect(stats.p95).toBeLessThan(CEILING_MS);
  });

  it('is deterministic: two builds of the same input are equal', () => {
    const a = buildTimeline(state, file, { axis: 'braid', groupBy: 'character' });
    const b = buildTimeline(state, file, { axis: 'braid', groupBy: 'character' });
    expect(b).toEqual(a);
  });
});
