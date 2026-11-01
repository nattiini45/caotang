/**
 * The project's timeline calendar in the store (timeline.md §3.8): `project.setCalendar` through the shipped bus with its exact
 * undo, the manifest member through the writer, the loader and a `.caotang` bundle, and a load that never refuses a project over a
 * calendar it cannot use.
 */

import { describe, expect, it } from 'vitest';
import {
  CALENDAR_JSON_MAX_CHARS,
  calendarCommands,
  type ApplyContext,
  type Command,
  type ValidationSnapshot,
} from '@caotang/bus';

import {
  MemoryArtifactFs,
  setCalendarApply,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
  importProjectZip,
  readProject,
  writeProject,
  type ProjectState,
} from '../src/index.js';

const NOW = new Date('2026-10-20T08:00:00.000Z');
const clock = { now: () => 1_000 };

/** A calendar the timeline package accepts: the shape a project stores. */
const CALENDAR = {
  version: 1,
  id: 'reckoning',
  name: 'Reckoning of Ash',
  yearZero: 'include',
  epoch: { year: 3, month: 2, day: 7 },
  months: [
    { name: 'Rains', days: 30 },
    { name: 'Deep Ash', days: 40, leapDays: 1 },
    { name: 'Frost', days: 25 },
  ],
  intercalary: [
    { name: 'Hollow Days', days: 5, after: 0 },
    { name: 'Midwinter', days: 1, after: 3, leapOnly: true },
  ],
  leap: [{ every: 5, rule: 'include' }],
  eras: [{ name: 'AR' }, { name: 'Third Age', startYear: 300 }],
};
function project(): ProjectState {
  return createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
}

/**
 * The descriptor's check and the store's apply, in the bus's order, with the undo group the bus would keep. The command's name is
 * registered in the bus's own name list by the host (bus command.ts, registry.ts), so this runs the two halves that this package and
 * the bus's calendar descriptor own, without the pipeline between them.
 */
interface Harness {
  readonly state: ProjectState;
  readonly summaries: string[];
  readonly undos: Command[];
}

function bus(state: ProjectState = project()): Harness {
  return { state, summaries: [], undos: [] };
}

interface Outcome {
  readonly ok: boolean;
  readonly refusal?: string;
}

function dispatch(h: Harness, params: Record<string, unknown>): Outcome {
  const checked = calendarCommands.projectSetCalendar.validate(params, {} as ValidationSnapshot);
  if (!checked.ok) return { ok: false, refusal: checked.error.message };
  let inverse: Command | undefined;
  const context = {
    commandId: 'cmd_CAL000001',
    name: 'project.setCalendar',
    issuedBy: 'user',
    undo: {
      kind: 'inverse',
      inverse: (command: Command) => {
        inverse = command;
      },
      compensate: () => undefined,
      captured: () => undefined,
    },
    report: (report: { summary: string }) => {
      h.summaries.push(report.summary);
    },
  } as unknown as ApplyContext;
  try {
    setCalendarApply(clock)(h.state, checked.value, context);
  } catch (error) {
    return { ok: false, refusal: error instanceof Error ? error.message : String(error) };
  }
  if (inverse !== undefined) h.undos.push(inverse);
  return { ok: true };
}

function run(h: Harness, params: Record<string, unknown>): Outcome {
  return dispatch(h, params);
}

function undoLast(h: Harness): void {
  const inverse = h.undos.pop();
  if (inverse === undefined) throw new Error('nothing to undo');
  const outcome = dispatch(h, inverse.params as Record<string, unknown>);
  // The inverse is itself a command; undoing it must not stack a second undo for the caller.
  h.undos.pop();
  if (!outcome.ok) throw new Error(`undo refused: ${outcome.refusal ?? ''}`);
}
describe('project.setCalendar', () => {
  it('saves a calendar and chooses it, and one undo puts back both', () => {
    const b = bus();
    const result = run(b, { calendar: CALENDAR, lens: 'calendar' });
    expect(result.ok).toBe(true);
    expect(b.state.manifest.timeline).toEqual({ calendar: CALENDAR, lens: 'calendar' });
    undoLast(b);
    expect(b.state.manifest.timeline).toBeUndefined();
  });

  it('copies the calendar, so a later edit of the caller object cannot change the project', () => {
    const b = bus();
    const mine = structuredClone(CALENDAR);
    run(b, { calendar: mine });
    mine.name = 'Changed';
    expect(b.state.manifest.timeline?.calendar?.['name']).toBe('Reckoning of Ash');
  });

  it('switches the lens without touching the calendar, and undoes that alone', () => {
    const b = bus();
    run(b, { calendar: CALENDAR, lens: 'calendar' });
    run(b, { lens: 'day' });
    expect(b.state.manifest.timeline).toEqual({ calendar: CALENDAR, lens: 'day' });
    undoLast(b);
    expect(b.state.manifest.timeline).toEqual({ calendar: CALENDAR, lens: 'calendar' });
  });

  it('removes the calendar and the choice that named it, and undo brings both back', () => {
    const b = bus();
    run(b, { calendar: CALENDAR, lens: 'calendar' });
    expect(run(b, { calendar: null }).ok).toBe(true);
    expect(b.state.manifest.timeline).toBeUndefined();
    undoLast(b);
    expect(b.state.manifest.timeline).toEqual({ calendar: CALENDAR, lens: 'calendar' });
  });

  it('refuses choosing the calendar when there is none, and writes nothing', () => {
    const b = bus();
    const result = run(b, { lens: 'calendar' });
    expect(result.ok).toBe(false);
    expect(b.state.manifest.timeline).toBeUndefined();
  });

  it('refuses a call that changes nothing, an unknown key, a bad lens and an oversize calendar', () => {
    const b = bus();
    expect(run(b, {}).ok).toBe(false);
    expect(run(b, { calendar: CALENDAR, colour: 'red' }).ok).toBe(false);
    expect(run(b, { lens: 'lunar' }).ok).toBe(false);
    expect(run(b, { calendar: [] }).ok).toBe(false);
    expect(run(b, { calendar: { version: 1, name: 'x'.repeat(CALENDAR_JSON_MAX_CHARS) } }).ok).toBe(false);
    expect(b.state.manifest.timeline).toBeUndefined();
  });

  it('is never run on an agent\'s say-so', () => {
    expect(calendarCommands.projectSetCalendar.agentRisk).toBe('never');
    expect(calendarCommands.projectSetCalendar.undo).toBe('inverse');
  });

  it('touches no scene, no tree node and no coherence', () => {
    const b = bus();
    const before = JSON.stringify([b.state.manifest.tree, b.state.manifest.project]);
    run(b, { calendar: CALENDAR, lens: 'calendar' });
    expect(JSON.stringify([b.state.manifest.tree, b.state.manifest.project])).toBe(before);
  });
});

async function written(state: ProjectState): Promise<MemoryArtifactFs> {
  const fs = new MemoryArtifactFs();
  await writeProject(fs, state, { now: NOW });
  return fs;
}

describe('the timeline member of the manifest', () => {
  it('comes back from a save and a load exactly, with nothing dropped', async () => {
    const state = project();
    state.manifest.timeline = { lens: 'calendar', calendar: structuredClone(CALENDAR) };
    const loaded = await readProject(await written(state));
    expect(loaded.report.warnings).toEqual([]);
    expect(loaded.state.manifest.timeline).toEqual({ lens: 'calendar', calendar: CALENDAR });
  });

  it('is written as plain, line-oriented text a diff can read', async () => {
    const state = project();
    state.manifest.timeline = { lens: 'calendar', calendar: structuredClone(CALENDAR) };
    const text = (await (await written(state)).read('caotang.json')) as string;
    expect(text).toContain('"timeline"');
    expect(text).toContain('        {"name":"Deep Ash","days":40,"leapDays":1},\n        {"name":"Frost","days":25}\n');
  });

  it('is absent from a project that never chose a calendar', async () => {
    const text = (await (await written(project())).read('caotang.json')) as string;
    expect(text).not.toContain('"timeline"');
  });

  it('survives a .caotang bundle', async () => {
    const state = project();
    state.manifest.timeline = { lens: 'calendar', calendar: structuredClone(CALENDAR) };
    const exported = await exportProjectZip(state, { now: NOW });
    const imported = await importProjectZip(exported.bytes);
    const loaded = await readProject(imported.fs);
    expect(loaded.state.manifest.timeline).toEqual({ lens: 'calendar', calendar: CALENDAR });
  });

  it('is gone from a save after the command that set it is undone', async () => {
    const b = bus();
    run(b, { calendar: CALENDAR, lens: 'calendar' });
    undoLast(b);
    const loaded = await readProject(await written(b.state));
    expect(loaded.state.manifest.timeline).toBeUndefined();
  });
});

describe('a load that meets a calendar it cannot use', () => {
  async function loadedWith(timeline: unknown) {
    const fs = await written(project());
    const manifest = JSON.parse((await fs.read('caotang.json')) as string) as Record<string, unknown>;
    manifest['timeline'] = timeline;
    await fs.writeAtomic('caotang.json', JSON.stringify(manifest));
    return readProject(fs);
  }

  it('drops a timeline that is not an object, with a warning, and opens the project', async () => {
    const loaded = await loadedWith('lunar');
    expect(loaded.report.ok).toBe(true);
    expect(loaded.report.warnings.length).toBeGreaterThan(0);
    expect(loaded.state.manifest.timeline).toBeUndefined();
  });

  it('drops a calendar that is not an object, and the choice that named it', async () => {
    const loaded = await loadedWith({ lens: 'calendar', calendar: 7 });
    expect(loaded.report.ok).toBe(true);
    expect(loaded.state.manifest.timeline).toBeUndefined();
  });

  it('drops an unknown lens and an unknown member, and keeps the calendar', async () => {
    const loaded = await loadedWith({ lens: 'lunar', mood: 'sad', calendar: CALENDAR });
    expect(loaded.report.ok).toBe(true);
    expect(loaded.state.manifest.timeline).toEqual({ calendar: CALENDAR });
  });

  it('keeps a calendar of a newer version as it is, so the next save does not delete it', async () => {
    const newer = { ...CALENDAR, version: 2, pendulum: true };
    const loaded = await loadedWith({ lens: 'calendar', calendar: newer });
    expect(loaded.state.manifest.timeline).toEqual({ lens: 'calendar', calendar: newer });
    const again = await readProject(await written(loaded.state));
    expect(again.state.manifest.timeline).toEqual({ lens: 'calendar', calendar: newer });
  });
});
