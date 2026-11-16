/**
 * `caotang tasks` in process, over a seeded project with a tasks.json: the reading commands leave the folder byte-identical, the
 * state lives outside it, and a run records what settled. The provider is the demo mock; no test needs a key.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCK_FILE } from '@caotang/sdk/folder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTasksCommand, capFor, modeFor } from '../src/run-tasks.js';
import { capture, folderBytes, removeDir, seedProject, tempDir } from './support.js';

const NOW = new Date('2026-11-16T10:00:00.000Z');
const SCAN = 't_5H8QK2M9RT';
const MODEL = 't_7K2QX9M4A1';
const MANUAL = 't_AQ5T03R7D4';
const OFF = 't_ZZZZZZZZZZ';
const BAD = 't_9ADP1AN001';

const TASKS = {
  formatVersion: 1,
  tasks: [
    { id: SCAN, name: 'Nightly scan', enabled: true, schedule: { kind: 'daily', at: '00:00' }, whenDue: 'run', body: { kind: 'scan', scope: 'full' }, permission: 'read-only' },
    { id: MODEL, name: 'Summarise', enabled: true, schedule: { kind: 'daily', at: '00:00' }, whenDue: 'offer', body: { kind: 'intent', text: 'Draft the opening scene of The Friend.' }, permission: 'ask', maxModelCalls: 2 },
    { id: MANUAL, name: 'Changed scan', enabled: true, schedule: { kind: 'manual' }, whenDue: 'offer', body: { kind: 'plan', steps: [{ tool: 'coherence.scan', params: { scope: 'changed' }, expect: 'A scan is recorded' }] }, permission: 'ask' },
    { id: OFF, name: 'Switched off', enabled: false, schedule: { kind: 'daily', at: '00:00' }, whenDue: 'run', body: { kind: 'scan', scope: 'full' }, permission: 'read-only' },
    { id: BAD, name: 'Broken plan', enabled: true, schedule: { kind: 'manual' }, whenDue: 'offer', body: { kind: 'plan', steps: [{ tool: 'coherence.scan', params: {} }] }, permission: 'ask' },
  ],
};

let root = '';
let state = '';
beforeEach(async () => {
  root = tempDir('tasks');
  await seedProject(root);
  writeFileSync(join(root, 'tasks.json'), `${JSON.stringify(TASKS, null, 2)}\n`);
  state = join(tempDir('tasks-state'), 'state.json');
});
afterEach(() => {
  removeDir(root);
  removeDir(join(state, '..'));
});

const run = (argv: readonly string[], over: Parameters<typeof capture>[0] = {}) =>
  runTasksCommand(argv, { ...capture({ cwd: root, ...over }), now: () => NOW });

describe('caotang tasks list and due', () => {
  it('list prints every task and changes no byte of the folder', async () => {
    const before = folderBytes(root);
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['list'], io)).toBe(0);
    expect(io.out.join('')).toContain(SCAN);
    expect(io.out.join('')).toContain('Broken plan');
    expect(io.out.join('')).toContain('problem');
    expect(folderBytes(root)).toEqual(before);
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it('list in json is one object with the rows', async () => {
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['list', '--format', 'json'], io)).toBe(0);
    const parsed = JSON.parse(io.out.join('')) as { type: string; tasks: { id: string }[] };
    expect(parsed.type).toBe('tasks');
    expect(parsed.tasks.map((task) => task.id)).toEqual([SCAN, MODEL, MANUAL, OFF, BAD]);
  });

  it('a folder with no project is a usage error', async () => {
    const empty = tempDir('tasks-empty');
    const io = { ...capture({ cwd: empty }), now: () => NOW };
    expect(await runTasksCommand(['list'], io)).toBe(2);
    removeDir(empty);
  });

  it('due reads the state outside the project, writes nothing, and respects the zone', async () => {
    const before = folderBytes(root);
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['due', '--state', state, '--time-zone', 'UTC'], io)).toBe(0);
    const text = io.out.join('');
    expect(text).toContain(SCAN);
    expect(text).toContain(MODEL);
    expect(text).not.toContain(MANUAL);
    expect(text).not.toContain(OFF);
    expect(folderBytes(root)).toEqual(before);
    expect(existsSync(state)).toBe(false);

    writeFileSync(state, JSON.stringify({ formatVersion: 1, lastRuns: { [SCAN]: NOW.toISOString(), [MODEL]: NOW.toISOString() } }));
    const io2 = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['due', '--state', state], io2)).toBe(0);
    expect(io2.out.join('')).toContain('No tasks.');
  });

  it('the zone decides a boundary occurrence: 00:30 local is due in Berlin at 00:10 UTC, not in UTC', async () => {
    const tasks = { ...TASKS, tasks: TASKS.tasks.map((task) => (task.id === SCAN ? { ...task, schedule: { kind: 'daily', at: '00:30' } } : task)) };
    writeFileSync(join(root, 'tasks.json'), `${JSON.stringify(tasks, null, 2)}\n`);
    writeFileSync(state, JSON.stringify({ formatVersion: 1, lastRuns: { [SCAN]: '2026-11-15T00:30:00.000Z', [MODEL]: NOW.toISOString() } }));
    const early = new Date('2026-11-16T00:10:00.000Z');
    const utc = { ...capture({ cwd: root }), now: () => early };
    expect(await runTasksCommand(['due', '--state', state, '--time-zone', 'UTC'], utc)).toBe(0);
    expect(utc.out.join('')).not.toContain(SCAN);
    const berlin = { ...capture({ cwd: root }), now: () => early };
    expect(await runTasksCommand(['due', '--state', state, '--time-zone', 'Europe/Berlin'], berlin)).toBe(0);
    expect(berlin.out.join('')).toContain(SCAN);
  });

  it('a state path inside the project is refused', async () => {
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['due', '--state', join(root, 'state.json')], io)).toBe(2);
    expect(io.err.join('')).toContain('outside the project');
  });

  it('a corrupt state is kept aside and the run starts empty; a newer one refuses', async () => {
    writeFileSync(state, '{not json');
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['due', '--state', state], io)).toBe(0);
    expect(io.err.join('')).toContain('corrupt');
    expect(io.out.join('')).toContain(SCAN);
    writeFileSync(state, JSON.stringify({ formatVersion: 2, lastRuns: {} }));
    const io2 = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['due', '--state', state], io2)).toBe(1);
    expect(io2.err.join('')).toContain('newer format');
  });
});

describe('caotang tasks run', () => {
  it('a scan by id with --write records coherence.json and the state, and releases the lock', async () => {
    expect(await run(['run', SCAN, '--state', state, '--write'])).toBe(0);
    const coherence = JSON.parse(readFileSync(join(root, 'coherence.json'), 'utf8')) as { runs: unknown[] };
    expect(coherence.runs.length).toBe(1);
    const saved = JSON.parse(readFileSync(state, 'utf8')) as { lastRuns: Record<string, string> };
    expect(saved.lastRuns[SCAN]).toBe(NOW.toISOString());
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it('a scan without --write leaves the folder byte-identical and still records the machine state', async () => {
    const before = folderBytes(root);
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['run', SCAN, '--state', state], io)).toBe(0);
    expect(folderBytes(root)).toEqual(before);
    expect(io.out.join('')).toContain('done');
    expect(existsSync(state)).toBe(true);
  });

  it('a model task under the default read-only policy cancels its card and exits 4, recorded', async () => {
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['run', MODEL, '--state', state, '--mock'], io)).toBe(4);
    const saved = JSON.parse(readFileSync(state, 'utf8')) as { lastRuns: Record<string, string> };
    expect(saved.lastRuns[MODEL]).toBe(NOW.toISOString());
  });

  it('--due runs the scan and skips the offered task; --include-offered needs an explicit permission and runs both', async () => {
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['run', '--due', '--state', state, '--write'], io)).toBe(0);
    expect(io.out.join('')).toContain(SCAN);
    expect(io.out.join('')).not.toContain(MODEL);
    let saved = JSON.parse(readFileSync(state, 'utf8')) as { lastRuns: Record<string, string> };
    expect(Object.keys(saved.lastRuns)).toEqual([SCAN]);

    const io2 = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['run', '--due', '--state', state, '--include-offered'], io2)).toBe(2);

    const io3 = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['run', '--due', '--state', state, '--include-offered', '--permission', 'read-only', '--mock', '--write'], io3)).toBe(4);
    expect(io3.out.join('')).toContain(MODEL);
    saved = JSON.parse(readFileSync(state, 'utf8')) as { lastRuns: Record<string, string> };
    expect(Object.keys(saved.lastRuns).sort()).toEqual([MODEL, SCAN].sort());
  });

  it('an unrunnable task is refused and records nothing; an unknown name is a usage error', async () => {
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['run', BAD, '--state', state], io)).toBe(4);
    expect(existsSync(state)).toBe(false);
    const io2 = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['run', 'no such task', '--state', state], io2)).toBe(2);
  });

  it('a model task without a provider is a usage error before anything opens', async () => {
    const io = { ...capture({ cwd: root }), now: () => NOW };
    expect(await runTasksCommand(['run', MODEL, '--state', state], io)).toBe(2);
    expect(io.err.join('')).toContain('needs a provider');
    expect(existsSync(state)).toBe(false);
  });

  it('the permission and the cap are the lowest of the file and the flag', () => {
    const scan = TASKS.tasks[0] as never;
    const model = TASKS.tasks[1] as never;
    expect(modeFor(scan, 'approve-all')).toBe('read-only');
    expect(modeFor(model, 'approve-all')).toBe('approve-all');
    expect(modeFor(model, 'read-only')).toBe('read-only');
    expect(capFor(model, 8)).toBe(2);
    expect(capFor(model, 1)).toBe(1);
    expect(capFor(scan, 8)).toBe(8);
  });
});
