/**
 * One project calendar, one label everywhere (timeline.md §3.8): the SDK's model, the MCP `timeline.read` answer, the
 * exporter's table and its SVG all name the same scene day through the same lens, so a writer who reads a day in the
 * view finds the same words in an export and in an agent's answer.
 */

import { describe, expect, it } from 'vitest';
import { emptyCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import { renderTimelineSvg, timelineTable } from '@caotang/exporter';
import { timelineModelOf } from '@caotang/sdk/folder';
import { addDocument, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { projectLensOf } from '@caotang/timeline';

import { timelineReadDataOf } from '@caotang/harness';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const SCENE = 'n_SCENE000001';

const MOONS = { version: 1, id: 'moons', name: 'Moons', yearZero: 'include', epoch: { year: 1, month: 1, day: 1 }, months: [{ name: 'Moon', days: 7 }] };

function projectWith(timeline: ProjectState['manifest']['timeline']): ProjectState {
  const state = createProjectState(createEmptyManifest('Lunar', NOW));
  addDocument(state, { parentId: 'manuscript', title: 'The Tide', body: 'Water.', now: NOW, id: SCENE });
  if (timeline !== undefined) state.manifest.timeline = timeline;
  const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [SCENE]: { dayOffset: 10 } } };
  state.coherence = file;
  return state;
}

describe('a project calendar across the surfaces', () => {
  it('writes the same day label in the SDK model, the MCP answer, the CSV table and the SVG', () => {
    const state = projectWith({ lens: 'calendar', calendar: MOONS });
    const chosen = projectLensOf(state.manifest.timeline);
    expect(chosen.source).toBe('calendar');
    const label = chosen.lens.label(10, 'long');
    expect(label).toBe('4 Moon, 2');

    const model = timelineModelOf(state);
    expect(model.items.find((item) => item.nodeId === SCENE)?.a11yLabel).toContain(label);

    const data = timelineReadDataOf(model, { lens: chosen.lens });
    expect(data.lens).toBe('calendar:moons');
    expect(data.scenes.find((scene) => scene.nodeId === SCENE)?.dayLabel).toBe(label);

    const table = timelineTable({ state, includeRootIds: ['manuscript'] });
    expect(table.rows.find((row) => row.title === 'The Tide')?.dayLabel).toBe(label);

    const short = chosen.lens.label(10, 'short');
    expect(renderTimelineSvg({ state, includeRootIds: ['manuscript'] }).svg).toContain(short);
  });

  it('falls back to the day lens everywhere when the chosen calendar cannot be used', () => {
    const state = projectWith({ lens: 'calendar', calendar: { ...MOONS, months: [] } });
    const chosen = projectLensOf(state.manifest.timeline);
    expect(chosen.source).toBe('day');
    expect(chosen.problems.length).toBeGreaterThan(0);
    expect(timelineModelOf(state).items.find((item) => item.nodeId === SCENE)?.a11yLabel).toContain('Day 10');
    expect(timelineTable({ state, includeRootIds: ['manuscript'] }).rows[0]?.dayLabel).toBe('Day 10');
  });

  it('keeps the day lens when the project chose it, whatever calendar is stored beside it', () => {
    const state = projectWith({ lens: 'day', calendar: MOONS });
    expect(timelineTable({ state, includeRootIds: ['manuscript'] }).rows[0]?.dayLabel).toBe('Day 10');
  });
});
