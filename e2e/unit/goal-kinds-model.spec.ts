import { expect, test } from '@playwright/test';

import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type CommandName,
} from '../../packages/bus/src/index.js';
import { newId } from '../../packages/ids/src/index.js';
import { createProjectCommandRegistry, type ProjectState, type SessionRecord } from '../../packages/store/src/index.js';

import { goalProgress, localeFirstWeekday } from '../../packages/furniture/src/index.js';
import { goalSentence, paceCountOf, resetSentence, unitOf } from '../../apps/desktop/src/app/footer-model.js';
import { FurnitureStore, goalProbeOf } from '../../apps/desktop/src/app/furniture-store.js';
import type { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { project } from './fixtures.js';

/**
 * The goal kinds and metrics a writer sees in the binder footer (goals-progress §9.2, §9.3): the sentence a goal reads as, the unit it
 * counts in, the probe that reads its progress, and a save through the bus. The fixture's bodies hold 19, 8 and 15 non-whitespace
 * characters in the three scenes that have text, so a characters total is one figure a test can check.
 */

const PROJECT_ID = 'p_GOALKINDS1';
const NOW = Date.parse('2026-10-08T09:00:00.000Z');

/** The part of a session the furniture store and the goal probe read, over the real bus, with a fixed open sitting. */
function sessionOver(state: ProjectState, sittingWords = 0): ProjectSession {
  const registry = createProjectCommandRegistry({ clock: { now: () => NOW } });
  const listeners = new Set<() => void>();
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo: createUndoStore({ dispatch: (command) => execute(command, bus, registry) }),
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  return {
    projectId: PROJECT_ID,
    state,
    undo: bus.undo,
    sittingWords: () => sittingWords,
    settle: async () => {},
    saveState: () => 'saved',
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (name: CommandName, params: Record<string, unknown>) => {
      const result = execute({ id: newId('cmd'), name, params, issuedBy: 'user', createdAt: NOW }, bus, registry);
      for (const listener of listeners) listener();
      return result;
    },
  } as unknown as ProjectSession;
}

test.describe('the sentence and the unit a goal reads in (goals-progress §2.2, §9.2, §9.3)', () => {
  test('a characters goal reads in characters, on the node it attaches to, and keeps its date', () => {
    expect(goalSentence({ comparator: 'at-least', target: 12_000, metric: 'chars', deadline: '2026-10-31' }, 'The Manuscript', 'en-GB')).toBe(
      'at least 12,000 characters on The Manuscript by 31 Oct 2026',
    );
  });

  test('a session goal reads as its window, and takes no node title or date', () => {
    expect(goalSentence({ comparator: 'at-least', target: 7_000, metric: 'words', kind: 'weekly' }, 'The Manuscript', 'en-GB')).toBe(
      'at least 7,000 words this week',
    );
    expect(goalSentence({ comparator: 'at-least', target: 30_000, metric: 'words', kind: 'monthly' }, 'The Manuscript', 'en-GB')).toBe(
      'at least 30,000 words this month',
    );
  });

  test('a words project goal reads as it did before the metric existed', () => {
    expect(goalSentence({ comparator: 'at-most', target: 2_000, deadline: undefined }, 'Act 1', 'en-GB')).toBe('at most 2,000 words on Act 1');
  });

  test('the unit and the pace count follow the metric, singular for one', () => {
    expect(unitOf({ metric: 'chars' })).toBe('characters');
    expect(unitOf({})).toBe('words');
    expect(paceCountOf({ metric: 'chars' }, 1, 'en-GB')).toBe('1 character');
    expect(paceCountOf({ metric: 'chars' }, 850, 'en-GB')).toBe('850 characters');
    expect(paceCountOf({}, 1, 'en-GB')).toBe('1 word');
    expect(paceCountOf({}, 850, 'en-GB')).toBe('850 words');
  });

  test('the pace count groups the number the way the formatter locale does', () => {
    expect(paceCountOf({}, 1_200, 'en-US')).toBe('1,200 words');
    expect(paceCountOf({}, 1_200, 'de-DE')).toBe('1.200 words');
    expect(paceCountOf({ metric: 'chars' }, 1_200, 'de-DE')).toBe('1.200 characters');
  });
});

test.describe('the probe a goal reads its progress through (goals-progress §2.2, §9.2, §9.3)', () => {
  test('a characters goal is saved in characters, and its probe counts the non-whitespace characters of the subtree', () => {
    const state = project();
    const session = sessionOver(state);
    const store = new FurnitureStore(session, null);

    const outcome = store.saveGoal({ nodeId: 'manuscript', metric: 'chars', comparator: 'at-least', target: 40 });
    expect(outcome.ok).toBe(true);
    expect(store.snapshot().goals[0]).toMatchObject({ metric: 'chars', nodeId: 'manuscript', target: 40 });

    const probe = goalProbeOf(session, []);
    // Scene A holds 19 characters, Scene B 8, and the deep scene 15; the empty scenes hold none. Words are counted apart.
    expect(probe.charsOf?.('manuscript')).toBe(42);
    expect(probe.charsOf?.('n_CH100000AA')).toBe(42);
    expect(probe.wordsOf('manuscript')).toBe(9);
  });

  test('a weekly goal is saved on the manuscript with its kind, and counts the window of the sessions plus the open sitting', () => {
    const state = project();
    const session = sessionOver(state, 25);
    const store = new FurnitureStore(session, null);

    const outcome = store.saveGoal({ nodeId: 'manuscript', kind: 'weekly', comparator: 'at-least', target: 1_000, metric: 'words' });
    expect(outcome.ok).toBe(true);
    expect(store.snapshot().goals[0]).toMatchObject({ kind: 'weekly', nodeId: 'manuscript', metric: 'words', comparator: 'at-least' });

    // The log holds two sessions: one that ended in the week of 5 to 11 October and one that did not.
    const sessions: SessionRecord[] = [
      { startedAt: '2026-10-08T11:30:00', endedAt: '2026-10-08T12:00:00', wordsWritten: 300, docIds: [] },
      { startedAt: '2026-10-20T11:30:00', endedAt: '2026-10-20T12:00:00', wordsWritten: 900, docIds: [] },
    ];
    const probe = goalProbeOf(session, sessions);
    expect(probe.wordsWrittenIn?.({ from: '2026-10-05', to: '2026-10-11' })).toBe(325);
  });

  // goals-progress §9.3: each recurring goal picks its own reset day, and the window it paces over follows it.
  test('a weekly goal saved with a Saturday reset keeps it through the bus, and paces over the Saturday-to-Friday week', () => {
    const state = project();
    const session = sessionOver(state);
    const store = new FurnitureStore(session, null);
    const outcome = store.saveGoal({ nodeId: 'manuscript', kind: 'weekly', resetDay: 6, comparator: 'at-least', target: 1_000 });
    expect(outcome.ok).toBe(true);
    expect(state.manifest.goals?.[0]).toMatchObject({ kind: 'weekly', resetDay: 6 });
    const [goal] = store.snapshot().goals;
    if (goal === undefined) throw new Error('the goal was not saved');
    expect(goal.resetDay).toBe(6);
    const spans: string[] = [];
    const probe = { ...goalProbeOf(session, []), wordsWrittenIn: (span: { from: string; to: string }) => (spans.push(`${span.from}..${span.to}`), 0) };
    // Thursday 8 October 2026: the week began on Saturday the 3rd and ends on Friday the 9th, so 2 days are left.
    expect(goalProgress(goal, probe, '2026-10-08', { firstWeekday: 0 }).pace).toEqual({ perDay: 500, daysLeft: 2 });
    expect(spans).toEqual(['2026-10-03..2026-10-09']);
    expect(resetSentence(goal, 0)).toBe('The week starts on Saturday.');
  });

  test('a weekly goal with no reset day starts on the locale\'s first day, and a monthly one on the 1st', () => {
    const weekly = { kind: 'weekly' as const };
    expect(resetSentence(weekly, localeFirstWeekday('en-US'))).toBe('The week starts on Sunday.');
    expect(resetSentence(weekly, localeFirstWeekday('de-DE'))).toBe('The week starts on Monday.');
    expect(resetSentence({ kind: 'monthly' }, 1)).toBe('The month starts on the 1st.');
    expect(resetSentence({ kind: 'monthly', resetDay: 22 }, 1)).toBe('The month starts on the 22nd.');
    expect(resetSentence({ kind: 'monthly', resetDay: 'last' }, 1)).toBe('The month starts on its last day.');
    expect(resetSentence({ kind: 'project' }, 1)).toBeUndefined();
  });

  test('a monthly goal refuses a reset day past the 28th, and the store keeps no goal', () => {
    const store = new FurnitureStore(sessionOver(project()), null);
    const outcome = store.saveGoal({ nodeId: 'manuscript', kind: 'monthly', resetDay: 31, comparator: 'at-least', target: 1_000 });
    expect(outcome.ok).toBe(false);
    expect(store.snapshot().goals).toEqual([]);
  });

  test('a weekly goal cannot be saved with a metric it does not count, and the store keeps the goal it had', () => {
    const state = project();
    const store = new FurnitureStore(sessionOver(state), null);
    const outcome = store.saveGoal({ nodeId: 'manuscript', kind: 'weekly', metric: 'chars', comparator: 'at-least', target: 1_000 });
    expect(outcome.ok).toBe(false);
    expect(store.snapshot().goals).toEqual([]);
  });

  test('the sessions the footer loads are kept on the store, so the footer and the inspector read the same windows', () => {
    const store = new FurnitureStore(sessionOver(project()), null);
    expect(store.snapshot().sessions).toEqual([]);
    const sessions: SessionRecord[] = [{ startedAt: '2026-10-08T11:30:00', endedAt: '2026-10-08T12:00:00', wordsWritten: 300, docIds: [] }];
    store.setSessions(sessions);
    expect(store.snapshot().sessions).toEqual(sessions);
  });
});
