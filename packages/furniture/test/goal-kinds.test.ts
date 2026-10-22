/**
 * Goal metrics and kinds — goals-progress §9.2 (the `chars` metric) and §9.3 (weekly and monthly session goals), read as recorded in
 * docs/decisions.md: the session window each kind counts over, its progress and pace, and the save and load rules a session goal keeps.
 * The session times below are written without a zone, so they read as the same local day in every timezone the suite runs in.
 */
import { countBody, type SessionRecord } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { BINDER, NOW } from './fixtures/binder.js';
import {
  GOAL_KINDS,
  createBinderIndex,
  goalCharsOf,
  goalProgress,
  goalWindowOf,
  localeFirstWeekday,
  parseProjectGoals,
  prepareProjectGoal,
  sessionGoalProblems,
  wordsWrittenBetween,
  type GoalProbe,
  type ProjectGoal,
  type ProjectGoalSaveContext,
} from '../src/index.js';

const TODAY = '2026-10-08'; // a Thursday
const GOAL_ID = 'g_ABCDEFGHJK';

function goal(overrides: Partial<ProjectGoal> = {}): ProjectGoal {
  return {
    id: GOAL_ID,
    nodeId: 'manuscript',
    metric: 'words',
    comparator: 'at-least',
    target: 1000,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function probe(overrides: Partial<GoalProbe> = {}): GoalProbe {
  return { wordsOf: () => 0, isGoalTarget: () => true, ...overrides };
}

function session(endedAt: string, wordsWritten: number): SessionRecord {
  return { startedAt: endedAt, endedAt, wordsWritten, docIds: [] };
}

const context: ProjectGoalSaveContext = { tree: BINDER, existing: [], now: NOW, newId: () => GOAL_ID };

describe('the windows a session goal counts over (goals-progress §9.3)', () => {
  it('with no reset day and no locale a week runs Monday to Sunday, and holds every day from Monday on, Sunday included', () => {
    expect(goalWindowOf('weekly', '2026-10-08')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(goalWindowOf('weekly', '2026-10-05')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(goalWindowOf('weekly', '2026-10-11')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(goalWindowOf('weekly', '2026-10-12')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
  });

  it('a month runs from its first day to its last, February of a leap year included', () => {
    expect(goalWindowOf('monthly', '2026-10-08')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(goalWindowOf('monthly', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('a weekly goal with a reset weekday starts its week on the latest such day on or before today', () => {
    // Thursday 8 October 2026. A Sunday reset (0) starts the week on Sunday the 4th; a Thursday reset (4) starts it today.
    expect(goalWindowOf('weekly', '2026-10-08', { resetDay: 0 })).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(goalWindowOf('weekly', '2026-10-08', { resetDay: 4 })).toEqual({ from: '2026-10-08', to: '2026-10-14' });
    // A Friday reset (5) started last Friday, the 2nd, and the week ends on Thursday the 8th, today.
    expect(goalWindowOf('weekly', '2026-10-08', { resetDay: 5 })).toEqual({ from: '2026-10-02', to: '2026-10-08' });
    // The goal's own reset day wins over the locale's first weekday.
    expect(goalWindowOf('weekly', '2026-10-08', { resetDay: 6, firstWeekday: 0 })).toEqual({ from: '2026-10-03', to: '2026-10-09' });
  });

  it('a weekly goal without a reset day starts on the first weekday it is given, and on Monday with none', () => {
    expect(goalWindowOf('weekly', '2026-10-08', { firstWeekday: 0 })).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(goalWindowOf('weekly', '2026-10-08', { firstWeekday: 6 })).toEqual({ from: '2026-10-03', to: '2026-10-09' });
    expect(goalWindowOf('weekly', '2026-10-08', {})).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });

  it('the locale default is read from Intl.Locale, injected, and falls back to Monday', () => {
    expect(localeFirstWeekday('en-US')).toBe(0); // Sunday
    expect(localeFirstWeekday('de-DE')).toBe(1); // Monday
    expect(localeFirstWeekday('en-GB')).toBe(1);
    expect(localeFirstWeekday('ar-EG')).toBe(6); // Saturday
    expect(localeFirstWeekday(undefined)).toBe(1);
    expect(localeFirstWeekday('')).toBe(1);
    expect(localeFirstWeekday('not a locale!')).toBe(1);
  });

  it('a monthly goal with reset day N runs from the latest N-th to the day before the next', () => {
    expect(goalWindowOf('monthly', '2026-10-08', { resetDay: 15 })).toEqual({ from: '2026-09-15', to: '2026-10-14' });
    expect(goalWindowOf('monthly', '2026-10-15', { resetDay: 15 })).toEqual({ from: '2026-10-15', to: '2026-11-14' });
    expect(goalWindowOf('monthly', '2026-10-08', { resetDay: 1 })).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    // Across the year: a reset on the 28th, on 10 January, started on 28 December; on 30 December it runs to 27 January.
    expect(goalWindowOf('monthly', '2027-01-10', { resetDay: 28 })).toEqual({ from: '2026-12-28', to: '2027-01-27' });
    expect(goalWindowOf('monthly', '2026-12-30', { resetDay: 28 })).toEqual({ from: '2026-12-28', to: '2027-01-27' });
    // February is short: a reset on the 28th still lands in it, in a leap year and out of one.
    expect(goalWindowOf('monthly', '2027-02-28', { resetDay: 28 })).toEqual({ from: '2027-02-28', to: '2027-03-27' });
    expect(goalWindowOf('monthly', '2028-02-29', { resetDay: 28 })).toEqual({ from: '2028-02-28', to: '2028-03-27' });
    expect(goalWindowOf('monthly', '2027-03-10', { resetDay: 28 })).toEqual({ from: '2027-02-28', to: '2027-03-27' });
  });

  it('a monthly goal reset on the last day starts on a month\'s last day and ends the day before the next month\'s last day', () => {
    expect(goalWindowOf('monthly', '2026-10-15', { resetDay: 'last' })).toEqual({ from: '2026-09-30', to: '2026-10-30' });
    expect(goalWindowOf('monthly', '2026-10-31', { resetDay: 'last' })).toEqual({ from: '2026-10-31', to: '2026-11-29' });
    expect(goalWindowOf('monthly', '2026-12-31', { resetDay: 'last' })).toEqual({ from: '2026-12-31', to: '2027-01-30' });
    expect(goalWindowOf('monthly', '2027-01-05', { resetDay: 'last' })).toEqual({ from: '2026-12-31', to: '2027-01-30' });
    // February: 28 days in 2027, 29 in 2028 (a leap year), and 28 in 2100 (a century that is not one).
    expect(goalWindowOf('monthly', '2027-02-10', { resetDay: 'last' })).toEqual({ from: '2027-01-31', to: '2027-02-27' });
    expect(goalWindowOf('monthly', '2027-02-28', { resetDay: 'last' })).toEqual({ from: '2027-02-28', to: '2027-03-30' });
    expect(goalWindowOf('monthly', '2028-02-28', { resetDay: 'last' })).toEqual({ from: '2028-01-31', to: '2028-02-28' });
    expect(goalWindowOf('monthly', '2028-02-29', { resetDay: 'last' })).toEqual({ from: '2028-02-29', to: '2028-03-30' });
    expect(goalWindowOf('monthly', '2100-02-28', { resetDay: 'last' })).toEqual({ from: '2100-02-28', to: '2100-03-30' });
  });

  it('a reset day the kind does not take is ignored by the window, which keeps the default', () => {
    expect(goalWindowOf('weekly', '2026-10-08', { resetDay: 'last' })).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(goalWindowOf('monthly', '2026-10-08', { resetDay: 31 })).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('wordsWrittenBetween sums the sessions that ended on a day of the window, both ends included', () => {
    const sessions = [
      session('2026-10-04T12:00:00', 50), // before the week
      session('2026-10-05T12:00:00', 400),
      session('2026-10-08T12:00:00', 300),
      session('2026-10-11T12:00:00', 200),
      session('2026-10-12T12:00:00', 900), // after the week
    ];
    expect(wordsWrittenBetween(sessions, '2026-10-05', '2026-10-11')).toBe(900);
    expect(wordsWrittenBetween([], '2026-10-05', '2026-10-11')).toBe(0);
  });

  it('the kinds are project, weekly and monthly, and a daily target is not among them', () => {
    expect(GOAL_KINDS).toEqual(['project', 'weekly', 'monthly']);
  });
});

describe('the chars metric (goals-progress §9.2)', () => {
  it('counts characters from the probe, not words', () => {
    const progress = goalProgress(
      goal({ metric: 'chars', target: 5000 }),
      probe({ wordsOf: () => 900, charsOf: () => 4200 }),
      TODAY,
    );
    expect(progress).toEqual({ current: 4200, met: false, state: 'open' });
  });

  it('is met when the character count reaches the target', () => {
    const progress = goalProgress(goal({ metric: 'chars', target: 5000 }), probe({ charsOf: () => 5000 }), TODAY);
    expect(progress.met).toBe(true);
    expect(progress.state).toBe('met');
  });

  it('reads as no characters when the probe cannot count them, rather than as words', () => {
    const progress = goalProgress(goal({ metric: 'chars', target: 5000 }), probe({ wordsOf: () => 4000 }), TODAY);
    expect(progress.current).toBe(0);
  });
});

describe('a words goal over CJK text (editor-engine §9)', () => {
  const body = '我喜欢在海边的灯塔里写作。';

  it('reads the segmented word count, not one word for the unspaced run', () => {
    const words = countBody(body).words;
    expect(words).toBeGreaterThan(1);
    const progress = goalProgress(goal({ target: words }), probe({ wordsOf: () => countBody(body).words }), TODAY);
    expect(progress).toEqual({ current: words, met: true, state: 'met' });
  });

  it('leaves a chars goal on the exact character count', () => {
    expect(goalCharsOf(body)).toBe([...body].length);
  });
});

describe('what a chars goal counts (goals-progress §9, as recorded in docs/decisions.md)', () => {
  it('counts the non-whitespace code points of a body', () => {
    expect(goalCharsOf('The ferry was late.')).toBe(16);
    expect(goalCharsOf(' a\n\tb ')).toBe(2);
    expect(goalCharsOf('')).toBe(0);
    expect(goalCharsOf('   \n\n')).toBe(0);
  });

  it('counts each code point once, so an ideograph and an emoji count as one character each', () => {
    expect(goalCharsOf('猫与狗')).toBe(3);
    expect(goalCharsOf('😀 a')).toBe(2);
  });

  it('counts the markup as it is written, and not the body length countBody reports', () => {
    expect(goalCharsOf('# A')).toBe(2);
    expect(countBody('a b').chars).toBe(3);
    expect(goalCharsOf('a b')).toBe(2);
  });

  it('sums a folder\'s characters over its subtree, as the words are summed, and reads zero with no counts given', () => {
    const index = createBinderIndex(BINDER, {}, { s1: 100, s2: 40, s3: 7, s4: 900, r1: 5 });
    expect(index.charsOf('ch1')).toBe(140);
    expect(index.charsOf('manuscript')).toBe(1047);
    expect(index.charsOf('research')).toBe(5);
    expect(createBinderIndex(BINDER).charsOf('manuscript')).toBe(0);
  });
});

describe('weekly and monthly session goals (goals-progress §9.3)', () => {
  it('a weekly goal counts the words of this week and paces them over the days left in it, today included', () => {
    const weekly = goal({ kind: 'weekly', target: 1000 });
    const window = (from: string, to: string): number => (from === '2026-10-05' && to === '2026-10-11' ? 800 : 0);
    // Thursday 8 October: 4 days are left in the week (8, 9, 10, 11), and 200 words are still to write.
    expect(goalProgress(weekly, probe({ wordsWrittenIn: (w) => window(w.from, w.to) }), TODAY)).toEqual({
      current: 800,
      met: false,
      state: 'open',
      pace: { perDay: 50, daysLeft: 4 },
    });
    // On the last day of the week the whole remainder is due today.
    expect(goalProgress(weekly, probe({ wordsWrittenIn: (w) => window(w.from, w.to) }), '2026-10-11')).toMatchObject({
      pace: { perDay: 200, daysLeft: 1 },
    });
  });

  it('a weekly goal met by the window reads as met, with no pace', () => {
    const progress = goalProgress(goal({ kind: 'weekly', target: 1000 }), probe({ wordsWrittenIn: () => 1200 }), TODAY);
    expect(progress).toEqual({ current: 1200, met: true, state: 'met' });
  });

  it('a monthly goal paces over the days left in the month', () => {
    const monthly = goal({ kind: 'monthly', target: 30_000 });
    // 8 to 31 October is 24 days, today included; 21,000 words are still to write, so 875 a day.
    expect(goalProgress(monthly, probe({ wordsWrittenIn: () => 9000 }), TODAY)).toEqual({
      current: 9000,
      met: false,
      state: 'open',
      pace: { perDay: 875, daysLeft: 24 },
    });
  });

  it('a weekly goal paces over its own week: its reset day, else the first weekday the caller passes', () => {
    const seen: string[] = [];
    const reader = probe({ wordsWrittenIn: (w) => (seen.push(`${w.from}..${w.to}`), 0) });
    // Thursday 8 October. A Saturday reset: the week is 3 to 9 October, so 2 days are left (8 and 9).
    expect(goalProgress(goal({ kind: 'weekly', resetDay: 6, target: 1000 }), reader, TODAY).pace).toEqual({ perDay: 500, daysLeft: 2 });
    // No reset day, a Sunday-first locale: 4 to 10 October, 3 days left.
    expect(goalProgress(goal({ kind: 'weekly', target: 900 }), reader, TODAY, { firstWeekday: 0 }).pace).toEqual({ perDay: 300, daysLeft: 3 });
    expect(seen).toEqual(['2026-10-03..2026-10-09', '2026-10-04..2026-10-10']);
  });

  it('a monthly goal reset on the 15th paces over the days to the 14th of next month', () => {
    // 8 to 14 October is 7 days, today included.
    expect(goalProgress(goal({ kind: 'monthly', resetDay: 15, target: 700 }), probe({ wordsWrittenIn: () => 0 }), TODAY).pace).toEqual({
      perDay: 100,
      daysLeft: 7,
    });
  });

  it('a session goal reads 0 words without a session reader, and never reads the binder', () => {
    const progress = goalProgress(goal({ kind: 'weekly', target: 1000 }), probe({ isGoalTarget: () => false }), TODAY);
    expect(progress.current).toBe(0);
    expect(progress.state).toBe('open');
  });
});

describe('the rules a session goal keeps (sessionGoalProblems)', () => {
  const weekly = { kind: 'weekly', nodeId: 'manuscript', metric: 'words', comparator: 'at-least', hasDeadline: false };

  it('keeps no rule problem when it attaches to the manuscript, counts words, is a minimum and has no deadline', () => {
    expect(sessionGoalProblems(weekly)).toEqual([]);
  });

  it('names each rule it breaks', () => {
    expect(sessionGoalProblems({ ...weekly, nodeId: 'act1' })).toHaveLength(1);
    expect(sessionGoalProblems({ ...weekly, metric: 'chars' })).toHaveLength(1);
    expect(sessionGoalProblems({ ...weekly, comparator: 'about' })).toHaveLength(1);
    expect(sessionGoalProblems({ ...weekly, hasDeadline: true })).toHaveLength(1);
  });

  it('is empty for a project goal, whatever it holds', () => {
    expect(sessionGoalProblems({ ...weekly, kind: 'project', nodeId: 'act1', hasDeadline: true })).toEqual([]);
    expect(sessionGoalProblems({ ...weekly, kind: undefined, nodeId: 'act1' })).toEqual([]);
  });

  it('takes a reset day its kind can use, and names one it cannot', () => {
    expect(sessionGoalProblems({ ...weekly, resetDay: 0 })).toEqual([]);
    expect(sessionGoalProblems({ ...weekly, resetDay: 6 })).toEqual([]);
    expect(sessionGoalProblems({ ...weekly, resetDay: null })).toEqual([]);
    expect(sessionGoalProblems({ ...weekly, resetDay: 7 })).toEqual(['a weekly goal resets on a weekday, 0 (Sunday) to 6 (Saturday)']);
    expect(sessionGoalProblems({ ...weekly, resetDay: 'last' })).toHaveLength(1);
    const monthly = { ...weekly, kind: 'monthly' };
    expect(sessionGoalProblems({ ...monthly, resetDay: 1 })).toEqual([]);
    expect(sessionGoalProblems({ ...monthly, resetDay: 28 })).toEqual([]);
    expect(sessionGoalProblems({ ...monthly, resetDay: 'last' })).toEqual([]);
    expect(sessionGoalProblems({ ...monthly, resetDay: 29 })).toHaveLength(1);
    expect(sessionGoalProblems({ ...monthly, resetDay: 0 })).toHaveLength(1);
    expect(sessionGoalProblems({ ...monthly, resetDay: 1.5 })).toHaveLength(1);
    expect(sessionGoalProblems({ ...weekly, kind: 'project', resetDay: 1 })).toEqual(['a project goal does not reset, so it takes no reset day']);
  });
});

describe('saving a goal of either metric or kind (prepareProjectGoal)', () => {
  it('saves a chars goal, and refuses a metric the project does not measure', () => {
    const chars = prepareProjectGoal({ nodeId: 'act1', metric: 'chars', comparator: 'at-least', target: 5000 }, context);
    expect(chars.ok && chars.value.metric).toBe('chars');
    const pages = prepareProjectGoal({ nodeId: 'act1', metric: 'pages', comparator: 'at-least', target: 5000 }, context);
    expect(pages.ok).toBe(false);
    if (!pages.ok) expect(pages.errors[0]).toContain('unknown metric "pages"');
  });

  it('saves a weekly goal on the manuscript with its kind, and a project goal with no kind key', () => {
    const weekly = prepareProjectGoal({ kind: 'weekly', nodeId: 'manuscript', comparator: 'at-least', target: 7000 }, context);
    expect(weekly.ok && weekly.value).toMatchObject({ kind: 'weekly', metric: 'words', nodeId: 'manuscript' });

    const project = prepareProjectGoal({ kind: 'project', nodeId: 'act1', comparator: 'at-least', target: 7000 }, context);
    expect(project.ok && project.value).not.toHaveProperty('kind');
  });

  it('refuses a weekly goal that breaks a rule, and a kind the project does not know', () => {
    const onFolder = prepareProjectGoal({ kind: 'weekly', nodeId: 'act1', comparator: 'at-least', target: 7000 }, context);
    expect(onFolder.ok).toBe(false);
    const dated = prepareProjectGoal(
      { kind: 'weekly', nodeId: 'manuscript', comparator: 'at-least', target: 7000, deadline: '2026-10-31' },
      context,
    );
    expect(dated.ok).toBe(false);
    const daily = prepareProjectGoal({ kind: 'daily', nodeId: 'manuscript', comparator: 'at-least', target: 1000 }, context);
    if (!daily.ok) expect(daily.errors[0]).toContain('unknown kind "daily"');
    expect(daily.ok).toBe(false);
  });

  it('saves a reset day with a weekly or monthly goal, and leaves the key out when none is chosen', () => {
    const weekly = prepareProjectGoal({ kind: 'weekly', nodeId: 'manuscript', comparator: 'at-least', target: 7000, resetDay: 0 }, context);
    expect(weekly.ok && weekly.value.resetDay).toBe(0);
    const monthly = prepareProjectGoal({ kind: 'monthly', nodeId: 'manuscript', comparator: 'at-least', target: 7000, resetDay: 'last' }, context);
    expect(monthly.ok && monthly.value.resetDay).toBe('last');
    const plain = prepareProjectGoal({ kind: 'monthly', nodeId: 'manuscript', comparator: 'at-least', target: 7000, resetDay: null }, context);
    expect(plain.ok && plain.value).not.toHaveProperty('resetDay');
  });

  it('refuses a reset day the kind cannot use', () => {
    const late = prepareProjectGoal({ kind: 'monthly', nodeId: 'manuscript', comparator: 'at-least', target: 7000, resetDay: 31 }, context);
    expect(late.ok).toBe(false);
    const project = prepareProjectGoal({ nodeId: 'act1', comparator: 'at-least', target: 7000, resetDay: 1 }, context);
    expect(project.ok).toBe(false);
  });
});

describe('loading a goal of either metric or kind (parseProjectGoals)', () => {
  const base = {
    id: GOAL_ID,
    nodeId: 'manuscript',
    metric: 'words',
    comparator: 'at-least',
    target: 7000,
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T10:00:00.000Z',
  };

  it('loads a chars goal with its metric, and a weekly goal with its kind', () => {
    const load = parseProjectGoals([{ ...base, metric: 'chars', nodeId: 'act1' }, { ...base, kind: 'weekly' }], BINDER);
    expect(load.goals.map((g) => [g.metric, g.kind])).toEqual([
      ['chars', undefined],
      ['words', 'weekly'],
    ]);
    expect(load.notices).toEqual([]);
  });

  it('drops a session goal that breaks its rules, and an unknown kind, each with a notice', () => {
    const load = parseProjectGoals(
      [
        { ...base, kind: 'monthly', deadline: '2026-10-31' },
        { ...base, kind: 'daily' },
      ],
      BINDER,
    );
    expect(load.goals).toEqual([]);
    expect(load.notices.map((n) => n.message)).toEqual([
      expect.stringContaining('recurs, so it takes no deadline'),
      expect.stringContaining('unknown kind "daily"'),
    ]);
  });

  it('loads a reset day, keeps a goal stored before reset days with none, and drops one with a reset day it cannot use', () => {
    const load = parseProjectGoals(
      [
        { ...base, kind: 'weekly', resetDay: 0 },
        { ...base, id: 'g_ABCDEFGHJM', kind: 'monthly' },
        { ...base, id: 'g_ABCDEFGHJN', kind: 'monthly', resetDay: 30 },
      ],
      BINDER,
    );
    expect(load.goals.map((g) => [g.kind, g.resetDay])).toEqual([
      ['weekly', 0],
      ['monthly', undefined],
    ]);
    expect(load.goals[1]).not.toHaveProperty('resetDay');
    expect(load.notices.map((n) => n.message)).toEqual([expect.stringContaining('a monthly goal resets on a day from 1 to 28')]);
  });

  it('reads an explicit project kind as the default, with no kind key', () => {
    const load = parseProjectGoals([{ ...base, kind: 'project' }], BINDER);
    expect(load.goals[0]).not.toHaveProperty('kind');
  });
});
