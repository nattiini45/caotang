import { MemoryArtifactFs } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { TASKS_FILE, loadTasks, saveTasks, serializeTasksFile, tasksSnapshotFile, withRun, lastRunsOf, RUN_HISTORY_LIMIT, type TaskRunRecord } from '../src/index.js';
import { fileOf, task } from './fixtures.js';

const NOW = new Date('2026-06-10T12:00:00Z');

describe('tasks.json on disk', () => {
  it('a project with no file loads as absent and empty, and the first save creates it', async () => {
    const fs = new MemoryArtifactFs();
    const load = await loadTasks(fs);
    expect(load).toMatchObject({ status: 'absent', writable: true });
    await saveTasks(fs, load, fileOf(task(1)), { now: NOW });
    expect(await fs.read(TASKS_FILE)).toBe(serializeTasksFile(fileOf(task(1))));
    expect((await loadTasks(fs)).file.tasks).toHaveLength(1);
  });

  it('rotates the previous file into .bak.1 to .bak.3 on a changed save, and a save that changes nothing makes no generation', async () => {
    const fs = new MemoryArtifactFs();
    const load = await loadTasks(fs);
    for (let n = 1; n <= 5; n += 1) await saveTasks(fs, load, fileOf(task(n)), { now: NOW });
    await saveTasks(fs, load, fileOf(task(5)), { now: NOW });
    const names = (await fs.listFiles('')).filter((name) => name.startsWith(TASKS_FILE)).sort();
    expect(names).toEqual([TASKS_FILE, tasksSnapshotFile(1), tasksSnapshotFile(2), tasksSnapshotFile(3)]);
    expect(await fs.read(tasksSnapshotFile(1))).toBe(serializeTasksFile(fileOf(task(4))));
    expect(await fs.read(tasksSnapshotFile(3))).toBe(serializeTasksFile(fileOf(task(2))));
  });

  it('a file that does not read is kept under a corrupt name and the newest snapshot that reads takes its place', async () => {
    const fs = new MemoryArtifactFs();
    const load = await loadTasks(fs);
    await saveTasks(fs, load, fileOf(task(1)), { now: NOW });
    await saveTasks(fs, load, fileOf(task(2)), { now: NOW });
    await fs.writeAtomic(TASKS_FILE, '{ half a file');

    const recovered = await loadTasks(fs, { now: NOW });
    expect(recovered.status).toBe('recovered');
    expect(recovered.file.tasks.map((entry) => entry.id)).toEqual([task(1).id]);
    expect(recovered.notices.map((notice) => notice.code)).toContain('restored-from-snapshot');
    expect(recovered.preservedAs).toBe('tasks.json.corrupt-2026-06-10T12-00-00-000Z');
    expect(await fs.read(recovered.preservedAs ?? '')).toBe('{ half a file');
    expect(await fs.read(TASKS_FILE)).toBe(serializeTasksFile(fileOf(task(1))));
  });

  it('with no snapshot that reads, the list starts empty and the notice says the kept copy is the only record', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeAtomic(TASKS_FILE, 'not json');
    const recovered = await loadTasks(fs, { now: NOW });
    expect(recovered.file.tasks).toEqual([]);
    expect(recovered.notices.map((notice) => notice.code)).toEqual(['corrupt-file']);
    expect(await fs.read('tasks.json.corrupt-2026-06-10T12-00-00-000Z')).toBe('not json');
  });

  it('a file from a newer format is shown as read-only and is never written over', async () => {
    const fs = new MemoryArtifactFs();
    const newer = '{"formatVersion":9,"tasks":[]}';
    await fs.writeAtomic(TASKS_FILE, newer);
    const load = await loadTasks(fs);
    expect(load).toMatchObject({ status: 'read-only', writable: false });
    await expect(saveTasks(fs, load, fileOf(task(1)))).rejects.toMatchObject({ code: 'read-only' });
    expect(await fs.read(TASKS_FILE)).toBe(newer);
  });

  it('a newer file that appeared after the load is not saved over either', async () => {
    const fs = new MemoryArtifactFs();
    const load = await loadTasks(fs);
    await fs.writeAtomic(TASKS_FILE, '{"formatVersion":9,"tasks":[]}');
    await expect(saveTasks(fs, load, fileOf(task(1)))).rejects.toMatchObject({ code: 'read-only' });
  });
});

describe('a tasks.json that is not ours', () => {
  const foreign = '{"tasks":[{"title":"buy milk"}]}';

  it('is shown as read-only and left byte for byte as it was, with no corrupt copy kept', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeAtomic(TASKS_FILE, foreign);
    const load = await loadTasks(fs, { now: NOW });
    expect(load).toMatchObject({ status: 'read-only', writable: false });
    expect(load.file.tasks).toEqual([]);
    expect(load.notices.map((notice) => notice.code)).toEqual(['foreign-file']);
    expect(load.notices[0]?.message).toContain('not a Caotang tasks file');
    expect(await fs.read(TASKS_FILE)).toBe(foreign);
    expect((await fs.listFiles('')).filter((name) => name.startsWith(TASKS_FILE))).toEqual([TASKS_FILE]);
  });

  it('is not saved over, and a save leaves it as it was', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeAtomic(TASKS_FILE, foreign);
    const load = await loadTasks(fs);
    await expect(saveTasks(fs, load, fileOf(task(1)))).rejects.toMatchObject({ code: 'read-only' });
    expect(await fs.read(TASKS_FILE)).toBe(foreign);
  });

  it('is not saved over when it appeared after the load either', async () => {
    const fs = new MemoryArtifactFs();
    const load = await loadTasks(fs);
    await fs.writeAtomic(TASKS_FILE, foreign);
    await expect(saveTasks(fs, load, fileOf(task(1)))).rejects.toMatchObject({ code: 'read-only' });
    expect(await fs.read(TASKS_FILE)).toBe(foreign);
  });

  it('is told apart from a file that claims to be ours and cannot be read, which is kept and recovered', async () => {
    for (const text of ['{ half a file', '{"formatVersion":"1"}']) {
      const fs = new MemoryArtifactFs();
      await fs.writeAtomic(TASKS_FILE, text);
      const recovered = await loadTasks(fs, { now: NOW });
      expect(recovered.status, text).toBe('recovered');
      expect(await fs.read(recovered.preservedAs ?? ''), text).toBe(text);
    }
  });

  it('is skipped as a snapshot, so recovery never restores from it', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeAtomic(tasksSnapshotFile(1), foreign);
    await fs.writeAtomic(TASKS_FILE, 'not json');
    const recovered = await loadTasks(fs, { now: NOW });
    expect(recovered.notices.map((notice) => notice.code)).toEqual(['corrupt-file']);
  });
});

describe('run history', () => {
  const record = (n: number, patch: Partial<TaskRunRecord> = {}): TaskRunRecord => ({
    taskId: task(1).id,
    at: `2026-06-${String(n).padStart(2, '0')}T08:00:00Z`,
    status: 'done',
    trigger: 'due',
    summary: `Run ${n}`,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    ...patch,
  });

  it('keeps the newest first and at most the limit', () => {
    let history: TaskRunRecord[] = [];
    for (let n = 1; n <= RUN_HISTORY_LIMIT + 5; n += 1) history = withRun(history, record(n % 28 + 1, { summary: `Run ${n}` }));
    expect(history).toHaveLength(RUN_HISTORY_LIMIT);
    expect(history[0]?.summary).toBe(`Run ${RUN_HISTORY_LIMIT + 5}`);
  });

  it('reads the last handled time of each task from its newest record', () => {
    expect(lastRunsOf({ a: [record(9), record(3)], b: [] })).toEqual({ a: record(9).at });
  });
});
