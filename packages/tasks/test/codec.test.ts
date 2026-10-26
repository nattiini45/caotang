import { describe, expect, it } from 'vitest';

import { parseTasksFile, serializeTasksFile, type AgentTask } from '../src/index.js';
import { fileOf, task } from './fixtures.js';

const ok = (text: string) => {
  const outcome = parseTasksFile(text);
  if (outcome.kind !== 'ok') throw new Error(`expected ok, got ${outcome.kind}`);
  return outcome;
};

const textOf = (...tasks: unknown[]): string => JSON.stringify({ formatVersion: 1, tasks });

/** A task as it sits in the file, to be patched into something a reader must tolerate. */
const raw = (seed: number): Record<string, unknown> => (JSON.parse(serializeTasksFile(fileOf(task(seed)))) as { tasks: Record<string, unknown>[] }).tasks[0] ?? {};

describe('tasks.json codec', () => {
  it('round-trips the three kinds of body, each schedule and the optional cap', () => {
    const tasks: AgentTask[] = [
      task(1, { body: { kind: 'scan', scope: 'changed', checks: ['codex.alias-collisions'] }, whenDue: 'run' }),
      task(2, { schedule: { kind: 'weekly', day: 'fri', at: '17:30' }, body: { kind: 'intent', text: 'Summarise the week.' }, maxModelCalls: 4 }),
      task(3, {
        schedule: { kind: 'on-open' },
        permission: 'read-only',
        body: { kind: 'plan', steps: [{ tool: 'coherence.scan', params: { scope: { mode: 'full' } }, expect: 'A scan is recorded' }] },
      }),
      task(4, { schedule: { kind: 'manual' }, enabled: false }),
    ];
    const text = serializeTasksFile(fileOf(...tasks));
    const back = ok(text);
    expect(back.notices).toEqual([]);
    expect(back.file.tasks).toEqual(tasks);
    expect(serializeTasksFile(back.file)).toBe(text);
  });

  it('writes keys in a fixed order, two-space indented, with a trailing newline', () => {
    const text = serializeTasksFile(fileOf(task(1)));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "tasks": [\n');
    expect(Object.keys(raw(1))).toEqual(['id', 'name', 'enabled', 'schedule', 'whenDue', 'body', 'permission']);
  });

  it('holds no consent, no last run and no key: a field of that kind is dropped with a notice and is not written back', () => {
    const loaded = ok(textOf({ ...raw(1), consent: true, lastRun: '2026-01-01T00:00:00Z', apiKey: 'sk-secret' }));
    expect(loaded.notices.map((notice) => notice.code)).toEqual(['unknown-field']);
    const rewritten = serializeTasksFile(loaded.file);
    expect(rewritten).not.toContain('consent');
    expect(rewritten).not.toContain('sk-secret');
    expect(rewritten).not.toContain('lastRun');
  });

  it('reports text that is not JSON, a file with no format version, and a file from a newer format', () => {
    expect(parseTasksFile('{nope').kind).toBe('corrupt');
    expect(parseTasksFile('[]').kind).toBe('corrupt');
    expect(parseTasksFile('{"tasks":[]}').kind).toBe('corrupt');
    expect(parseTasksFile('{"formatVersion":1,"tasks":{}}').kind).toBe('corrupt');
    expect(parseTasksFile('{"formatVersion":2,"tasks":[]}')).toEqual({ kind: 'newer', formatVersion: 2 });
  });

  describe('a permission above ask', () => {
    const withPermission = (permission: unknown): string => textOf({ ...raw(1), permission });

    it.each(['accept-edits', 'auto', 'approve-all'])('%s is capped to ask, with a notice that says so', (word) => {
      const loaded = ok(withPermission(word));
      expect(loaded.file.tasks[0]?.permission).toBe('ask');
      expect(loaded.notices).toEqual([expect.objectContaining({ code: 'permission-capped', message: expect.stringContaining(word) })]);
    });

    it('read-only and plan-only read as read-only; a missing permission is ask without a notice', () => {
      expect(ok(withPermission('read-only')).file.tasks[0]?.permission).toBe('read-only');
      expect(ok(withPermission('plan-only')).file.tasks[0]?.permission).toBe('read-only');
      const absent = ok(withPermission(undefined));
      expect(absent.file.tasks[0]?.permission).toBe('ask');
      expect(absent.notices).toEqual([]);
    });

    it('a word it does not know is ask, with a notice', () => {
      const loaded = ok(withPermission('root'));
      expect(loaded.file.tasks[0]?.permission).toBe('ask');
      expect(loaded.notices.map((notice) => notice.code)).toEqual(['defaulted-field']);
    });

    it('inherited property names are not permission words', () => {
      expect(ok(withPermission('constructor')).file.tasks[0]?.permission).toBe('ask');
      expect(ok(withPermission('__proto__')).file.tasks[0]?.permission).toBe('ask');
    });
  });

  describe('a task that does not read', () => {
    it.each([
      ['an id that is not a task id', { id: 'n_7K2QX9M4A1' }],
      ['no name', { name: '  ' }],
      ['a schedule that is not one of the four', { schedule: { kind: 'cron', expr: '* * * * *' } }],
      ['a time that is not HH:MM', { schedule: { kind: 'daily', at: '9am' } }],
      ['a weekly schedule with no weekday', { schedule: { kind: 'weekly', at: '09:00' } }],
      ['an empty instruction', { body: { kind: 'intent', text: '' } }],
      ['a body kind that does not exist', { body: { kind: 'shell', command: 'rm -rf /' } }],
      ['a scan scope that is not full or changed', { body: { kind: 'scan', scope: 'doc' } }],
    ])('is dropped with a notice, and the rest of the file loads: %s', (_label, patch) => {
      const good = raw(2);
      const loaded = ok(textOf({ ...raw(1), ...patch }, good));
      expect(loaded.file.tasks.map((entry) => entry.id)).toEqual([good['id']]);
      expect(loaded.notices.map((notice) => notice.code)).toEqual(['dropped-task']);
    });

    it('a repeated id is dropped; the first task keeps it', () => {
      const loaded = ok(textOf(raw(1), { ...raw(1), name: 'Again' }));
      expect(loaded.file.tasks.map((entry) => entry.name)).toEqual([raw(1)['name']]);
      expect(loaded.notices.map((notice) => notice.code)).toEqual(['dropped-task']);
    });

    it('keeps at most fifty tasks', () => {
      const many = Array.from({ length: 52 }, (_, index) => raw(index + 1));
      const loaded = ok(textOf(...many));
      expect(loaded.file.tasks).toHaveLength(50);
      expect(loaded.notices.map((notice) => notice.code)).toContain('too-many-tasks');
    });
  });

  describe('a bad step makes the task invalid and visible', () => {
    const plan = (steps: unknown) => ({ ...raw(1), body: { kind: 'plan', steps } });

    it('keeps the task as written with a problem, and loads the tasks beside it', () => {
      const steps = [{ tool: 'meta.set', params: {} }];
      const loaded = ok(textOf(plan(steps), raw(2)));
      expect(loaded.file.tasks).toHaveLength(2);
      const [broken, fine] = loaded.file.tasks;
      expect(broken?.problem).toMatch(/^Its plan does not parse:/);
      expect(broken?.body).toEqual({ kind: 'plan', steps });
      expect(fine?.problem).toBeUndefined();
      // Written back as it was read, without the derived problem.
      const written = serializeTasksFile(loaded.file);
      expect(written).not.toContain('problem');
      expect(ok(written).file.tasks[0]?.problem).toMatch(/^Its plan does not parse:/);
    });

    it('an empty step list is a bad plan', () => {
      expect(ok(textOf(plan([]))).file.tasks[0]?.problem).toMatch(/^Its plan does not parse:/);
    });

    it('a scan that names a check that does not exist is invalid and visible', () => {
      const scan = { ...raw(1), body: { kind: 'scan', scope: 'full', checks: ['nope.check'] } };
      expect(ok(textOf(scan)).file.tasks[0]?.problem).toContain('nope.check');
    });
  });
});
