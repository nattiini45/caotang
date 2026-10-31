import { describe, expect, it } from 'vitest';

import { dueTasks, localTime, type AgentTask } from '../src/index.js';
import { fileOf, task } from './fixtures.js';

const BERLIN = 'Europe/Berlin';
const NEW_YORK = 'America/New_York';

const at = (iso: string): Date => new Date(iso);
const ids = (tasks: readonly AgentTask[]): string[] => tasks.map((entry) => entry.id);

describe('dueTasks', () => {
  const daily = task(1, { schedule: { kind: 'daily', at: '09:00' } });

  it('offers a daily task that has never run at once, and a handled one when its next time arrives', () => {
    // 07:30 Berlin on 2026-06-10 is 05:30 UTC.
    expect(dueTasks(fileOf(daily), {}, at('2026-06-10T05:30:00Z'), BERLIN)).toEqual([daily]);
    expect(dueTasks(fileOf(daily), { [daily.id]: '2026-06-09T08:00:00Z' }, at('2026-06-10T05:30:00Z'), BERLIN)).toEqual([]);
    expect(dueTasks(fileOf(daily), { [daily.id]: '2026-06-09T08:00:00Z' }, at('2026-06-10T07:00:00Z'), BERLIN)).toEqual([daily]);
  });

  it('is not due again once the day\'s run or skip is recorded, and is due again the next local day', () => {
    const handled = { [daily.id]: '2026-06-10T07:05:00Z' };
    expect(dueTasks(fileOf(daily), handled, at('2026-06-10T20:00:00Z'), BERLIN)).toEqual([]);
    expect(dueTasks(fileOf(daily), handled, at('2026-06-11T07:00:00Z'), BERLIN)).toEqual([daily]);
  });

  it('is due once for a task missed for several days', () => {
    const missed = { [daily.id]: '2026-06-01T07:00:00Z' };
    expect(ids(dueTasks(fileOf(daily), missed, at('2026-06-10T12:00:00Z'), BERLIN))).toEqual([daily.id]);
    // The run that answers it is the only one: recorded now, nothing more is due.
    expect(dueTasks(fileOf(daily), { [daily.id]: '2026-06-10T12:00:00Z' }, at('2026-06-10T12:01:00Z'), BERLIN)).toEqual([]);
  });

  it('reads the day in the time zone it is given', () => {
    // 07:30 UTC on June 10 is 09:30 in Berlin, so the day's 09:00 has come; in New York it is 03:30, so it has not.
    const handledMorning = { [daily.id]: '2026-06-09T13:30:00Z' };
    expect(dueTasks(fileOf(daily), handledMorning, at('2026-06-10T07:30:00Z'), BERLIN)).toEqual([daily]);
    expect(dueTasks(fileOf(daily), handledMorning, at('2026-06-10T07:30:00Z'), NEW_YORK)).toEqual([]);
  });

  describe('weekly', () => {
    const weekly = task(2, { schedule: { kind: 'weekly', day: 'mon', at: '08:00' } });

    it('is due from its weekday and time until it is handled, then not until the next one', () => {
      // 2026-06-08 is a Monday.
      expect(dueTasks(fileOf(weekly), { [weekly.id]: '2026-06-01T06:30:00Z' }, at('2026-06-08T05:00:00Z'), BERLIN)).toEqual([]);
      expect(dueTasks(fileOf(weekly), { [weekly.id]: '2026-06-01T06:30:00Z' }, at('2026-06-08T06:30:00Z'), BERLIN)).toEqual([weekly]);
      // Wednesday of the same week, still not handled: still due.
      expect(dueTasks(fileOf(weekly), { [weekly.id]: '2026-06-01T06:30:00Z' }, at('2026-06-10T12:00:00Z'), BERLIN)).toEqual([weekly]);
      // Handled on the Wednesday: not due until the next Monday.
      const handled = { [weekly.id]: '2026-06-10T12:00:00Z' };
      expect(dueTasks(fileOf(weekly), handled, at('2026-06-14T12:00:00Z'), BERLIN)).toEqual([]);
      expect(dueTasks(fileOf(weekly), handled, at('2026-06-15T06:30:00Z'), BERLIN)).toEqual([weekly]);
    });

    it('is due once when a fortnight was missed', () => {
      const missed = { [weekly.id]: '2026-05-25T06:30:00Z' };
      expect(dueTasks(fileOf(weekly), missed, at('2026-06-11T12:00:00Z'), BERLIN)).toEqual([weekly]);
      expect(dueTasks(fileOf(weekly), { [weekly.id]: '2026-06-11T12:00:00Z' }, at('2026-06-11T12:01:00Z'), BERLIN)).toEqual([]);
    });
  });

  describe('across a change of clocks', () => {
    it('Europe/Berlin spring forward: a 02:30 task is due when the clock first passes 02:30, which is 03:00', () => {
      // 2026-03-29: 02:00 CET jumps to 03:00 CEST (01:00 UTC). 02:30 does not exist.
      const night = task(3, { schedule: { kind: 'daily', at: '02:30' } });
      const yesterday = { [night.id]: '2026-03-28T01:30:00Z' };
      expect(dueTasks(fileOf(night), yesterday, at('2026-03-29T00:59:00Z'), BERLIN)).toEqual([]);
      expect(dueTasks(fileOf(night), yesterday, at('2026-03-29T01:00:00Z'), BERLIN)).toEqual([night]);
      // Handled at 03:05 CEST (01:05 UTC): the rest of the day is quiet and the next day's 02:30 is due.
      const handled = { [night.id]: '2026-03-29T01:05:00Z' };
      expect(dueTasks(fileOf(night), handled, at('2026-03-29T20:00:00Z'), BERLIN)).toEqual([]);
      expect(dueTasks(fileOf(night), handled, at('2026-03-30T00:30:00Z'), BERLIN)).toEqual([night]);
    });

    it('Europe/Berlin fall back: a 02:30 task that ran in the first 02:30 hour does not run again in the repeated one', () => {
      // 2026-10-25: 03:00 CEST falls back to 02:00 CET, so 02:00 to 03:00 happens twice (00:00-01:00 UTC, then 01:00-02:00 UTC).
      const night = task(4, { schedule: { kind: 'daily', at: '02:30' } });
      const ranFirstPass = { [night.id]: '2026-10-25T00:40:00Z' };
      expect(dueTasks(fileOf(night), ranFirstPass, at('2026-10-25T01:40:00Z'), BERLIN)).toEqual([]);
      // Not yet run when the second pass arrives: it is due once, then quiet.
      const yesterday = { [night.id]: '2026-10-24T00:40:00Z' };
      expect(dueTasks(fileOf(night), yesterday, at('2026-10-25T01:40:00Z'), BERLIN)).toEqual([night]);
    });

    it('America/New_York spring forward: a weekly Sunday 02:30 task is due at 03:00 and not before', () => {
      // 2026-03-08 is a Sunday: 02:00 EST jumps to 03:00 EDT (07:00 UTC).
      const sunday = task(5, { schedule: { kind: 'weekly', day: 'sun', at: '02:30' } });
      const lastWeek = { [sunday.id]: '2026-03-01T07:40:00Z' };
      expect(dueTasks(fileOf(sunday), lastWeek, at('2026-03-08T06:59:00Z'), NEW_YORK)).toEqual([]);
      expect(dueTasks(fileOf(sunday), lastWeek, at('2026-03-08T07:00:00Z'), NEW_YORK)).toEqual([sunday]);
    });

    it('America/New_York fall back: a daily 01:30 task that ran in the first 01:30 does not run again in the repeated hour', () => {
      // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:00 to 02:00 happens twice (05:00-06:00 UTC, then 06:00-07:00 UTC).
      const night = task(6, { schedule: { kind: 'daily', at: '01:30' } });
      const ranFirstPass = { [night.id]: '2026-11-01T05:35:00Z' };
      expect(dueTasks(fileOf(night), ranFirstPass, at('2026-11-01T06:40:00Z'), NEW_YORK)).toEqual([]);
      expect(dueTasks(fileOf(night), ranFirstPass, at('2026-11-02T06:40:00Z'), NEW_YORK)).toEqual([night]);
    });

    it('keeps the wall-clock day on the day the clocks change', () => {
      expect(localTime(at('2026-03-29T00:30:00Z'), BERLIN)).toMatchObject({ minutes: 90 });
      expect(localTime(at('2026-03-29T01:30:00Z'), BERLIN)).toMatchObject({ minutes: 210 });
    });
  });

  describe('what is never due', () => {
    const now = at('2026-06-10T12:00:00Z');

    it('a manual task, a disabled task and a task with a problem', () => {
      const manual = task(7, { schedule: { kind: 'manual' } });
      const off = task(8, { enabled: false });
      const broken = task(9, { problem: 'Its plan does not parse: nope' });
      expect(dueTasks(fileOf(manual, off, broken), {}, now, BERLIN, true)).toEqual([]);
    });

    it('an on-open task is due on the evaluation made as the project opens and on no other', () => {
      const open = task(10, { schedule: { kind: 'on-open' } });
      expect(dueTasks(fileOf(open), {}, now, BERLIN, true)).toEqual([open]);
      expect(dueTasks(fileOf(open), {}, now, BERLIN)).toEqual([]);
      // Handled in an earlier open, it is due again at the next one.
      expect(dueTasks(fileOf(open), { [open.id]: '2026-06-09T12:00:00Z' }, now, BERLIN, true)).toEqual([open]);
    });

    it('treats a last-run time that does not read as never run', () => {
      expect(dueTasks(fileOf(task(11)), { [task(11).id]: 'yesterday' }, now, BERLIN)).toEqual([task(11)]);
    });
  });

  it('returns the due tasks in file order', () => {
    const a = task(12);
    const b = task(13, { schedule: { kind: 'weekly', day: 'wed', at: '00:00' } });
    expect(ids(dueTasks(fileOf(b, a), {}, at('2026-06-10T12:00:00Z'), BERLIN))).toEqual([b.id, a.id]);
  });
});
