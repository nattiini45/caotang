import { describe, expect, it } from 'vitest';

import { bodyHash, checkTask, effectiveMode, effectiveWhenDue, newTaskId, scheduleWords, usesModel, type AgentTask } from '../src/index.js';
import { isTaskId } from '../src/index.js';
import { task } from './fixtures.js';

const intent = (patch: Partial<AgentTask> = {}): AgentTask => task(1, { body: { kind: 'intent', text: 'Read the new scenes.' }, ...patch });

describe('usesModel', () => {
  it('an instruction does, a scan does not, and a plan does when a step drafts', () => {
    expect(usesModel(intent())).toBe(true);
    expect(usesModel(task(2))).toBe(false);
    const step = (tool: string) => ({ tool, params: {}, expect: 'x' });
    expect(usesModel(task(3, { body: { kind: 'plan', steps: [step('coherence.scan'), step('synopsis.fill')] } }))).toBe(true);
    expect(usesModel(task(4, { body: { kind: 'plan', steps: [step('coherence.scan')] } }))).toBe(false);
  });
});

describe('checkTask', () => {
  it('accepts a scan that starts by itself with no cap and no consent', () => {
    expect(checkTask(task(1, { whenDue: 'run' }))).toBeUndefined();
  });

  it('asks a model task that starts by itself for a cap, and accepts it once it has one', () => {
    expect(checkTask(intent({ whenDue: 'run' }))).toContain('limit on its model calls');
    expect(checkTask(intent({ whenDue: 'run', maxModelCalls: 5 }))).toBeUndefined();
    expect(checkTask(intent({ whenDue: 'offer' }))).toBeUndefined();
  });

  it('says what is wrong with a name, an instruction, a time and a cap', () => {
    expect(checkTask(task(1, { name: ' ' }))).toBe('Give the task a name.');
    expect(checkTask(intent({ body: { kind: 'intent', text: ' ' } }))).toBe('Say what the task should do.');
    expect(checkTask(task(2, { schedule: { kind: 'daily', at: '25:00' } }))).toBe('Write the time of day as HH:MM.');
    expect(checkTask(task(3, { maxModelCalls: 0 }))).toContain('whole number from 1 to 100');
    expect(checkTask(task(4, { maxModelCalls: 2.5 }))).toContain('whole number');
  });

  it('shows the problem a load found', () => {
    expect(checkTask(task(1, { problem: 'Its plan does not parse: nope' }))).toBe('Its plan does not parse: nope');
  });
});

describe('effectiveWhenDue', () => {
  it('a scan that says run runs, and one that says offer is offered', () => {
    expect(effectiveWhenDue(task(1, { whenDue: 'run' }))).toBe('run');
    expect(effectiveWhenDue(task(2, { whenDue: 'offer' }))).toBe('offer');
  });

  it('a model task is offered whatever the file says, unless a consent names exactly this task and it has a cap', () => {
    const model = intent({ whenDue: 'run', maxModelCalls: 4 });
    expect(effectiveWhenDue(model)).toBe('offer');
    expect(effectiveWhenDue(model, { hash: 'not-this-task' })).toBe('offer');
    expect(effectiveWhenDue(model, { hash: bodyHash(model) })).toBe('run');
    // No cap, no self-start, consent or not.
    const uncapped = intent({ whenDue: 'run' });
    expect(effectiveWhenDue(uncapped, { hash: bodyHash(uncapped) })).toBe('offer');
  });

  it('a plan is offered even when it calls no model: it can change the project, so it needs a consent too', () => {
    const plan = task(5, { whenDue: 'run', body: { kind: 'plan', steps: [{ tool: 'meta.set', params: {}, expect: 'x' }] } });
    expect(usesModel(plan)).toBe(false);
    expect(effectiveWhenDue(plan)).toBe('offer');
    expect(effectiveWhenDue(plan, { hash: bodyHash(plan) })).toBe('run');
  });

  it('editing a task voids its consent', () => {
    const model = intent({ whenDue: 'run', maxModelCalls: 4 });
    const consent = { hash: bodyHash(model) };
    expect(effectiveWhenDue({ ...model, maxModelCalls: 9 }, consent)).toBe('offer');
    expect(effectiveWhenDue({ ...model, schedule: { kind: 'daily', at: '03:00' } }, consent)).toBe('offer');
  });

  it('a task with a problem is offered nothing by itself', () => {
    expect(effectiveWhenDue(task(1, { whenDue: 'run', problem: 'broken' }))).toBe('offer');
  });
});

describe('bodyHash', () => {
  const base = intent({ whenDue: 'run', maxModelCalls: 4 });

  it('changes when the body, the schedule, the permission or the cap changes', () => {
    const hash = bodyHash(base);
    expect(bodyHash({ ...base, body: { kind: 'intent', text: 'Read every scene.' } })).not.toBe(hash);
    expect(bodyHash({ ...base, schedule: { kind: 'daily', at: '10:00' } })).not.toBe(hash);
    expect(bodyHash({ ...base, permission: 'read-only' })).not.toBe(hash);
    expect(bodyHash({ ...base, maxModelCalls: 5 })).not.toBe(hash);
    expect(bodyHash({ ...base, maxModelCalls: undefined })).not.toBe(hash);
  });

  it('keeps when the name, the enabled switch and whenDue change, and when keys are written in another order', () => {
    const hash = bodyHash(base);
    expect(bodyHash({ ...base, name: 'Renamed', enabled: false, whenDue: 'offer' })).toBe(hash);
    expect(bodyHash({ ...base, body: { text: 'Read the new scenes.', kind: 'intent' } })).toBe(hash);
  });

  it('is a SHA-256 in hex', () => {
    expect(bodyHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('effectiveMode', () => {
  it('is the lowest of the file and every other mode in play: the file can only lower a run', () => {
    expect(effectiveMode('ask', 'auto')).toBe('ask');
    expect(effectiveMode('ask', 'plan-only')).toBe('plan-only');
    expect(effectiveMode('read-only', 'auto', 'accept-edits')).toBe('plan-only');
    expect(effectiveMode('ask')).toBe('ask');
    expect(effectiveMode('ask', 'accept-edits', 'ask')).toBe('ask');
  });
});

describe('scheduleWords and newTaskId', () => {
  it('words each schedule', () => {
    expect(scheduleWords({ kind: 'manual' })).toBe('Only when you run it');
    expect(scheduleWords({ kind: 'on-open' })).toBe('Each time the project opens');
    expect(scheduleWords({ kind: 'daily', at: '09:00' })).toBe('Every day from 09:00');
    expect(scheduleWords({ kind: 'weekly', day: 'mon', at: '08:30' })).toBe('Every Monday from 08:30');
  });

  it('mints a t_ id of ten Crockford base32 characters that is not taken', () => {
    const taken = new Set<string>();
    for (let n = 0; n < 20; n += 1) {
      const id = newTaskId(taken);
      expect(isTaskId(id)).toBe(true);
      expect(id).toMatch(/^t_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });
});
