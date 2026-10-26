/**
 * The goal runner (agent-harness §7.2) against a scripted session: what ends a run, in which order, and what it leaves behind. The
 * turns here are scripted; `test/eval/goal.test.ts` runs the same stops on the real session and the mock provider.
 */

import { describe, expect, it } from 'vitest';

import { err, ok } from '@caotang/bus';
import { createManualClock } from '@caotang/gateway';
import { emptyCoherenceFile } from '@caotang/coherence';
import { addDocument, addFolder, getRevision, setBody, type ProjectState } from '@caotang/store';

import {
  REGRESSION_OPTIONS,
  createBudgetMeter,
  createGoalRunner,
  evaluateRules,
  iterationIntent,
  restoreGoal,
  writeScopeRules,
  type AgentSession,
  type BudgetMeter,
  type CheckSpec,
  type Goal,
  type GoalOptions,
  type GoalRun,
  type RegressionChoice,
  type TurnReport,
} from '../../src/index.js';
import { CHAPTER_ONE, CHAPTER_TWO, FRIEND, LANDING, STORM, makeState, OPENED } from '../fixtures.js';

const FULL = { mode: 'full' } as const;
const NOW = new Date('2026-10-26T09:00:00.000Z');

type Edit = (state: ProjectState, n: number) => Partial<TurnReport> | void;

interface Scripted {
  readonly session: AgentSession;
  readonly intents: string[];
  readonly restored: string[];
  /** Turns whose restore leaves a write in place, as a bus undo does when a compensation fails. */
  readonly partial: Set<string>;
  readonly state: ProjectState;
}

/** A session whose nth turn runs the nth edit against the project, as the model's applied steps would, and reports it. */
function scripted(state: ProjectState, edits: readonly Edit[]): Scripted {
  const intents: string[] = [];
  const restored: string[] = [];
  const partial = new Set<string>();
  const gone = new Set<string>();
  const session = {
    submit: async (intent: string): Promise<TurnReport> => {
      intents.push(intent);
      const n = intents.length;
      const extra = edits[Math.min(n, edits.length) - 1]?.(state, n) ?? {};
      return report(`t${n}`, extra);
    },
    restore: (turnId: string) => {
      restored.push(turnId);
      // A bus undo deletes the group once nothing is left in it, so a second restore of it finds nothing.
      if (gone.has(turnId)) return err({ code: 'not-found', message: 'no such undo group' } as never);
      const left = partial.has(turnId) ? [{ target: 'doc.write', code: 'conflict', message: 'edited since', correctiveHint: 'read it again' }] : [];
      if (left.length === 0) gone.add(turnId);
      return ok({ groupId: turnId, undone: [], failures: left } as never);
    },
  } as unknown as AgentSession;
  return { session, intents, restored, partial, state };
}

function report(turnId: string, extra: Partial<TurnReport>): TurnReport {
  return {
    turnId,
    status: 'applied',
    summary: 'done',
    steps: [],
    cards: [],
    trace: [],
    undoGroupId: `g-${turnId}`,
    tokens: { promptTokens: 0, completionTokens: 0, requests: 0 },
    dropped: [],
    modelCalls: 1,
    mode: 'ask',
    budgetUse: { modelCalls: 1, tokens: 0, wordsChanged: 0, documents: 0, steps: 0 },
    ...extra,
  };
}

const synopsisOf = (state: ProjectState, id: string, synopsis: string): void => {
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  if (node !== undefined) node.synopsis = synopsis;
};

const statusOf = (state: ProjectState, id: string, status: string | null): void => {
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  if (node !== undefined) node.status = status;
};

const SYNOPSES: CheckSpec = { kind: 'synopsis.filled', scope: FULL };
const LANDING_DRAFT: CheckSpec = { kind: 'status.all', scope: { mode: 'doc', docIds: [LANDING] }, status: 'draft' };

function goalOf(checks: readonly CheckSpec[], extra: Partial<Goal> = {}): Goal {
  return { id: 'goal-1', intent: 'Fill every synopsis.', checks, limits: { maxModelCalls: 40 }, ...extra };
}

async function run(
  scripts: Scripted,
  goal: Goal,
  options: Partial<GoalOptions> & { readonly meter?: BudgetMeter } = {},
): Promise<GoalRun> {
  return createGoalRunner().start(goal, {
    session: scripts.session,
    state: scripts.state,
    meter: options.meter ?? createBudgetMeter(goal.limits),
    now: () => NOW,
    withheld: () => new Set<string>(),
    ...options,
  });
}

describe('a run that passes', () => {
  it('works until the checks pass, naming only what still fails, and records one coherence run at the end', async () => {
    const state = makeState();
    const coherence: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] };
    const scripts = scripted(state, [
      (s) => {
        synopsisOf(s, STORM, 'The lamp fails.');
        setBody(s, FRIEND, 'The friend waited. Elena met Kestrel.');
      },
      (s) => synopsisOf(s, FRIEND, 'The friend arrives.'),
    ]);
    const finished = await run(scripts, goalOf([SYNOPSES, coherence, LANDING_DRAFT]));

    expect(finished.status).toBe('passed');
    expect(finished.iterations.map((record) => record.n)).toEqual([1, 2]);
    expect(finished.iterations.map((record) => record.distance)).toEqual([
      { before: 4, after: 1 },
      { before: 1, after: 0 },
    ]);
    // The second request names the one document still failing, and what already passes.
    expect(scripts.intents[0]).toContain('"The Storm"');
    expect(scripts.intents[0]).toContain('"The Friend"');
    expect(scripts.intents[1]).not.toContain('"The Storm"');
    expect(scripts.intents[1]).toContain('iteration 2 of at most 10');
    expect(scripts.intents[1]).toContain('Already passing, and to stay so: no open continuity findings');
    // Evaluating ran on copies; the goal recorded exactly one run, at the end.
    expect(state.coherence?.runs).toHaveLength(1);
    expect(finished.scanRunId).toBe(state.coherence?.runs[0]?.id);
  });

  it('runs no turn when the checks already pass, and records no coherence run for a goal without a coherence check', async () => {
    const state = makeState();
    const scripts = scripted(state, []);
    const finished = await run(scripts, goalOf([LANDING_DRAFT]));
    expect(finished).toMatchObject({ status: 'passed', iterations: [] });
    expect(scripts.intents).toEqual([]);
    expect(state.coherence?.runs ?? []).toEqual([]);
    expect(finished.scanRunId).toBeUndefined();
  });
});

describe('a run that stalls', () => {
  it('stops after stallAfter iterations in which the distance is no lower, default two', async () => {
    const scripts = scripted(makeState(), [() => undefined]);
    const finished = await run(scripts, goalOf([SYNOPSES]));
    expect(finished.status).toBe('stalled');
    expect(finished.iterations).toHaveLength(2);
    expect(finished.reason).toContain('no closer after 2 iterations');
  });

  it('counts from the best distance, so an up-and-down run is not progress', async () => {
    const edits: Edit[] = [
      (s) => synopsisOf(s, STORM, 'One.'),
      (s) => {
        synopsisOf(s, STORM, '');
        synopsisOf(s, FRIEND, '');
      },
      (s) => synopsisOf(s, STORM, 'One.'),
    ];
    const finished = await run(scripted(makeState(), edits), goalOf([SYNOPSES]));
    // 2 left, then 1 (best), then 2, then 1 again, which is not lower than the best.
    expect(finished.status).toBe('stalled');
    expect(finished.iterations).toHaveLength(3);
  });

  it('honours a longer stallAfter', async () => {
    const finished = await run(scripted(makeState(), [() => undefined]), goalOf([SYNOPSES], { stallAfter: 4, maxIterations: 20 }));
    expect(finished.status).toBe('stalled');
    expect(finished.iterations).toHaveLength(4);
  });
});

describe('a run that reaches its iteration limit', () => {
  it('stops at maxIterations while the checks still fail but the distance keeps falling', async () => {
    const docs = ['n_AAAAAAAAA1', 'n_AAAAAAAAA2', 'n_AAAAAAAAA3'];
    const state = makeState();
    for (const id of docs) addDocument(state, { parentId: CHAPTER_TWO, title: id, body: 'text', now: OPENED, id });
    const edits: Edit[] = docs.map((id) => (s) => synopsisOf(s, id, 'Filled.'));
    const finished = await run(scripted(state, edits), goalOf([{ kind: 'synopsis.filled', scope: { mode: 'doc', docIds: docs } }], { maxIterations: 2 }));
    expect(finished.status).toBe('max-iterations');
    expect(finished.iterations).toHaveLength(2);
    expect(finished.results[0]?.distance).toBe(1);
  });
});

describe('a run that regresses', () => {
  const breaks: Edit[] = [
    (s) => {
      synopsisOf(s, STORM, 'The lamp fails.');
      synopsisOf(s, FRIEND, 'The friend arrives.');
      statusOf(s, LANDING, 'final');
    },
    (s) => statusOf(s, LANDING, 'draft'),
  ];

  it('stops with the ask-back that offers restore, continue or stop', async () => {
    const scripts = scripted(makeState(), breaks);
    const finished = await run(scripts, goalOf([SYNOPSES, LANDING_DRAFT]));
    expect(finished.status).toBe('regressed');
    expect(finished.iterations).toHaveLength(1);
    expect(finished.askBack).toMatchObject({ code: 'needs_input', options: [...REGRESSION_OPTIONS] });
    expect(finished.askBack?.reason).toContain('every document in one named document has status "draft"');
    expect(scripts.restored).toEqual([]);
  });

  it('restores the iteration when the writer chooses to', async () => {
    const scripts = scripted(makeState(), breaks);
    const finished = await run(scripts, goalOf([SYNOPSES, LANDING_DRAFT]), { onRegression: () => 'restore' });
    expect(finished.status).toBe('regressed');
    expect(finished.reason).toContain('iteration 1 was restored');
    expect(scripts.restored).toEqual(['t1']);
  });

  it('says so when the restore left writes in place, instead of calling the iteration restored', async () => {
    const scripts = scripted(makeState(), breaks);
    scripts.partial.add('t1');
    const finished = await run(scripts, goalOf([SYNOPSES, LANDING_DRAFT]), { onRegression: () => 'restore' });
    expect(finished.status).toBe('regressed');
    expect(finished.reason).toContain('restoring iteration 1 left 1 write in place: doc.write');
    expect(finished.reason).not.toContain('was restored');
  });

  it('keeps the run when the ask-back cannot be answered: it stops, and restores nothing', async () => {
    const answers: GoalOptions['onRegression'][] = [
      async () => {
        throw new Error('the panel closed');
      },
      () => {
        throw new Error('the panel closed');
      },
    ];
    for (const onRegression of answers) {
      const scripts = scripted(makeState(), breaks);
      const finished = await run(scripts, goalOf([SYNOPSES, LANDING_DRAFT]), { onRegression });
      expect(finished.status).toBe('regressed');
      expect(finished.iterations).toHaveLength(1);
      expect(finished.askBack?.options).toEqual([...REGRESSION_OPTIONS]);
      expect(finished.reason).toContain('the question could not be answered (the panel closed)');
      expect(finished.reason).toContain('nothing was restored');
      expect(scripts.restored).toEqual([]);
    }
  });

  it('carries on when the writer chooses to continue, and does not ask again for the same break', async () => {
    const asked: number[] = [];
    const scripts = scripted(makeState(), breaks);
    const finished = await run(scripts, goalOf([SYNOPSES, LANDING_DRAFT]), {
      onRegression: (regression): RegressionChoice => {
        asked.push(regression.iteration);
        return 'continue';
      },
    });
    expect(finished.status).toBe('passed');
    expect(asked).toEqual([1]);
    expect(finished.iterations).toHaveLength(2);
  });

  it('counts a check that passed at the start, not only one an earlier iteration fixed', async () => {
    const scripts = scripted(makeState(), [(s) => statusOf(s, LANDING, null)]);
    const finished = await run(scripts, goalOf([SYNOPSES, LANDING_DRAFT]));
    expect(finished.status).toBe('regressed');
  });
});

describe('a run that reaches a limit', () => {
  it('ends on the limit the turn reports, and keeps the stop', async () => {
    const stop = { dimension: 'tokens', limit: 1000, spent: 900, needed: 400 } as const;
    const finished = await run(scripted(makeState(), [() => ({ status: 'failed', budgetStop: stop })]), goalOf([SYNOPSES]));
    expect(finished).toMatchObject({ status: 'budget', budgetStop: stop });
    expect(finished.iterations).toHaveLength(1);
  });

  it('does not start another turn once the meter has stopped', async () => {
    const clock = createManualClock(1_000);
    const limits = { maxActiveMs: 5_000 };
    const meter = createBudgetMeter(limits, { clock });
    const scripts = scripted(makeState(), [
      (s) => {
        synopsisOf(s, STORM, 'One.');
        clock.advance(6_000);
      },
    ]);
    const finished = await run(scripts, goalOf([SYNOPSES], { limits }), { meter });
    expect(finished.status).toBe('budget');
    expect(finished.budgetStop?.dimension).toBe('active-time');
    expect(scripts.intents).toHaveLength(1);
    meter.dispose();
  });
});

describe('the order the stops are checked in (agent-harness §7.2)', () => {
  const stop = { dimension: 'tokens', limit: 1000, spent: 900, needed: 400 } as const;
  const outside: TurnReport['trace'] = [{ tool: 'meta.set', callId: 'c1', outcome: 'ok', params: { targets: [FRIEND], status: 'final' } }];
  const fillBoth: Edit = (s) => {
    synopsisOf(s, STORM, 'One.');
    synopsisOf(s, FRIEND, 'Two.');
  };

  it('out-of-scope comes before passed', async () => {
    const finished = await run(scripted(makeState(), [(s) => ({ ...fillBoth(s, 1), trace: outside })]), goalOf([SYNOPSES], { writeScope: { mode: 'doc', docIds: [STORM] } }));
    expect(finished.status).toBe('out-of-scope');
  });

  it('passed comes before budget, cancelled and failed', async () => {
    for (const extra of [{ budgetStop: stop }, { status: 'cancelled' }, { status: 'failed' }] as const) {
      const finished = await run(scripted(makeState(), [(s) => ({ ...fillBoth(s, 1), ...extra })]), goalOf([SYNOPSES]));
      expect(finished.status).toBe('passed');
    }
  });

  it('budget comes before cancelled and failed', async () => {
    for (const status of ['cancelled', 'failed'] as const) {
      const finished = await run(scripted(makeState(), [() => ({ status, budgetStop: stop })]), goalOf([SYNOPSES]));
      expect(finished.status).toBe('budget');
    }
  });

  it('budget includes the meter’s time limit passing during the iteration, and comes before a stall', async () => {
    const clock = createManualClock(1_000);
    const limits = { maxActiveMs: 5_000 };
    const meter = createBudgetMeter(limits, { clock });
    const scripts = scripted(makeState(), [() => undefined, () => void clock.advance(6_000)]);
    const finished = await run(scripts, goalOf([SYNOPSES], { limits }), { meter });
    expect(finished.status).toBe('budget');
    expect(finished.iterations).toHaveLength(2);
    meter.dispose();
  });

  it('cancelled comes before failed and regressed', async () => {
    const regress: Edit = (s) => statusOf(s, LANDING, 'final');
    const finished = await run(scripted(makeState(), [(s) => ({ ...regress(s, 1), status: 'cancelled' })]), goalOf([SYNOPSES, LANDING_DRAFT]));
    expect(finished.status).toBe('cancelled');
  });

  it('failed comes before regressed and stalled', async () => {
    const regress: Edit = (s) => statusOf(s, LANDING, 'final');
    const finished = await run(scripted(makeState(), [(s) => ({ ...regress(s, 1), status: 'failed' })]), goalOf([SYNOPSES, LANDING_DRAFT]));
    expect(finished.status).toBe('failed');
    const second = await run(scripted(makeState(), [() => undefined, () => ({ status: 'failed' })]), goalOf([SYNOPSES]));
    expect(second.status).toBe('failed');
    expect(second.iterations).toHaveLength(2);
  });

  it('regressed comes before stalled and max-iterations', async () => {
    const edits: Edit[] = [() => undefined, (s) => statusOf(s, LANDING, 'final')];
    const finished = await run(scripted(makeState(), edits), goalOf([SYNOPSES, LANDING_DRAFT], { maxIterations: 2 }));
    // The landing is already "draft"; iteration 2 breaks it as the run would also stall and reach its limit.
    expect(finished.status).toBe('regressed');
    expect(finished.iterations).toHaveLength(2);
  });

  it('stalled comes before max-iterations', async () => {
    const finished = await run(scripted(makeState(), [() => undefined]), goalOf([SYNOPSES], { maxIterations: 2 }));
    expect(finished.status).toBe('stalled');
  });
});

describe('a run the writer ends', () => {
  it('ends cancelled on the writer’s Stop, and on a declined card', async () => {
    const stopped = await run(scripted(makeState(), [() => ({ status: 'cancelled', stop: { by: 'user', during: 'planning' } })]), goalOf([SYNOPSES]));
    expect(stopped.status).toBe('cancelled');
    expect(stopped.reason).toBe('the writer stopped the run');
    const declined = await run(scripted(makeState(), [() => ({ status: 'cancelled' })]), goalOf([SYNOPSES]));
    expect(declined.status).toBe('cancelled');
    expect(declined.reason).toContain('a card was declined');
  });

  it('does not start a turn when the signal is already aborted', async () => {
    const scripts = scripted(makeState(), [() => undefined]);
    const controller = new AbortController();
    controller.abort();
    const finished = await run(scripts, goalOf([SYNOPSES]), { signal: controller.signal });
    expect(finished.status).toBe('cancelled');
    expect(scripts.intents).toEqual([]);
  });

  it('ends failed without a turn when every check it still has to meet is turned off in Settings', async () => {
    const coherence: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] };
    const scripts = scripted(makeState(), [() => undefined]);
    const finished = await run(scripts, goalOf([coherence]), { checks: { enabled: ['pov.coverage'] } });
    expect(finished.status).toBe('failed');
    expect(finished.reason).toContain('turned off in Settings');
    expect(scripts.intents, 'no model turn was paid for').toEqual([]);
  });

  it('works the checks it can, then ends failed when only a turned-off one is left', async () => {
    const coherence: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] };
    const state = makeState();
    const scripts = scripted(state, [(s) => { for (const node of s.manifest.tree) node.synopsis = 'Filled.'; }, () => undefined]);
    const finished = await run(scripts, goalOf([SYNOPSES, coherence]), { checks: { enabled: ['pov.coverage'] } });
    expect(finished.status).toBe('failed');
    expect(finished.reason).toContain('turned off in Settings');
    expect(scripts.intents).toHaveLength(1);
  });

  it('ends failed on a turn that failed without a limit', async () => {
    const finished = await run(scripted(makeState(), [() => ({ status: 'failed', summary: 'the provider refused' })]), goalOf([SYNOPSES]));
    expect(finished).toMatchObject({ status: 'failed', reason: 'iteration 1 failed: the provider refused' });
  });
});

describe('a goal that is refused', () => {
  const refused = async (goal: Goal, options: Partial<GoalOptions> = {}, state = makeState()): Promise<string> => {
    const scripts = scripted(state, [() => undefined]);
    const finished = await run(scripts, goal, options);
    expect(finished.status).toBe('refused');
    expect(scripts.intents, 'no turn ran').toEqual([]);
    return finished.reason;
  };

  it('has no limit', async () => {
    expect(await refused(goalOf([SYNOPSES], { limits: {} }))).toContain('needs at least one limit');
  });

  it('is run on a meter that does not carry its limits', async () => {
    expect(await refused(goalOf([SYNOPSES]), { meter: createBudgetMeter({ maxTokens: 5 }) })).toContain('does not carry this goal’s limits');
  });

  it('asks for more iterations than the hard maximum, or none', async () => {
    expect(await refused(goalOf([SYNOPSES], { maxIterations: 51 }))).toContain('at most 50');
    expect(await refused(goalOf([SYNOPSES], { maxIterations: 0 }))).toContain('at least one iteration');
  });

  it('has no checks, or a check that cannot run', async () => {
    expect(await refused(goalOf([]))).toContain('no checks');
    expect(await refused(goalOf([{ kind: 'words.between', scope: FULL }]))).toContain('neither a minimum nor a maximum');
    expect(await refused(goalOf([{ kind: 'coherence.clean', scope: FULL, checks: [] }]))).toContain('names no checks');
  });

  it('reads no document: a words, status or synopsis check over a scope that holds nothing a goal can read', async () => {
    const state = makeState();
    addFolder(state, { parentId: 'manuscript', title: 'Chapter 3', now: OPENED, id: 'n_CHAPTR0003' });
    addFolder(state, { parentId: 'manuscript', title: 'Chapter 4', now: OPENED, id: 'n_CHAPTR0004' });
    addDocument(state, { parentId: 'n_CHAPTR0004', title: 'Old draft', now: OPENED, id: 'n_OLDDRAFT01', status: 'archived' });
    for (const folder of ['n_CHAPTR0003', 'n_CHAPTR0004']) {
      const reason = await refused(goalOf([{ kind: 'status.all', scope: { mode: 'doc', docIds: [folder] }, status: 'draft' }]), {}, state);
      expect(reason).toContain('reads no document');
    }
    // A project with no live document at all.
    const bare = makeState();
    for (const node of bare.manifest.tree) if (node.type === 'document') node.status = 'archived';
    expect(await refused(goalOf([{ kind: 'words.between', scope: FULL, min: 1 }]), {}, bare)).toContain('reads no document');
  });

  it('starts when the scope holds a live document, and ends a `changed` scope with nothing changed as passed without a turn', async () => {
    const live = scripted(makeState(), [() => undefined]);
    const started = await run(live, goalOf([{ kind: 'status.all', scope: { mode: 'doc', docIds: [LANDING] }, status: 'draft' }]));
    expect(started.status).toBe('passed');

    // Every document reviewed at its current revision: nothing has changed since the last review, and the empty scope is not a mistake.
    const quiet = makeState();
    const file = emptyCoherenceFile();
    for (const node of quiet.manifest.tree) {
      if (node.type === 'document') file.reviewState[node.id] = { lastReviewedRevision: getRevision(quiet, node.id), lastReviewedAt: NOW.toISOString() };
    }
    quiet.coherence = file;
    const unchanged = scripted(quiet, [() => undefined]);
    const finished = await run(unchanged, goalOf([{ kind: 'status.all', scope: { mode: 'changed' }, status: 'final' }]));
    expect(finished.status).toBe('passed');
    expect(unchanged.intents, 'no turn was needed').toEqual([]);
  });

  it('names a write scope with no document', async () => {
    expect(await refused(goalOf([SYNOPSES], { writeScope: { mode: 'doc', docIds: [] } }))).toContain('could write nothing');
  });

  it('reads a coherence scope over the document guard, unless the writer approved it when setting the goal', async () => {
    const state = makeState();
    for (let index = 0; index < 20; index += 1) {
      addDocument(state, { parentId: CHAPTER_TWO, title: `Extra ${index}`, body: `Words ${index}.`, now: OPENED, id: `n_EXTRA${String(index).padStart(5, '0')}` });
    }
    const goal = goalOf([{ kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] }]);
    expect(await refused(goal, {}, state)).toContain('over the guard');
    const scripts = scripted(state, [(s) => setBody(s, LANDING, 'Elena met Kestrel.')]);
    const approved = await run(scripts, goal, { approvedLargeScope: true });
    expect(approved.status).toBe('passed');
  });
});

describe('the write scope', () => {
  it('ends a run whose iteration applied a write outside it, naming the document', async () => {
    const trace: TurnReport['trace'] = [{ tool: 'meta.set', callId: 'c1', outcome: 'ok', params: { targets: [FRIEND], status: 'final' } }];
    const scripts = scripted(makeState(), [() => ({ trace })]);
    const finished = await run(scripts, goalOf([SYNOPSES], { writeScope: { mode: 'doc', docIds: [STORM] } }));
    expect(finished.status).toBe('out-of-scope');
    expect(finished.iterations[0]?.outOfScope).toEqual(['meta.set: The Friend']);
  });

  it('keeps the run when the iteration observer throws, and still judges the write scope', async () => {
    const trace: TurnReport['trace'] = [{ tool: 'meta.set', callId: 'c1', outcome: 'ok', params: { targets: [FRIEND], status: 'final' } }];
    const scripts = scripted(makeState(), [() => ({ trace })]);
    const finished = await run(scripts, goalOf([SYNOPSES], { writeScope: { mode: 'doc', docIds: [STORM] } }), {
      onIteration: () => {
        throw new Error('the panel closed');
      },
    });
    expect(finished.status).toBe('out-of-scope');
    expect(finished.iterations).toHaveLength(1);
    expect(finished.notes).toContain('the iteration observer failed: the panel closed');
    expect(finished.reason).toContain('the iteration observer failed');
  });

  it('lets a write inside the scope through, a folder scope covering the documents under it, and ignores reads and refused calls', async () => {
    const trace: TurnReport['trace'] = [
      { tool: 'meta.set', callId: 'c1', outcome: 'ok', params: { targets: [STORM], status: 'final' } },
      { tool: 'doc.read', callId: 'c2', outcome: 'ok', params: { doc: FRIEND } },
      { tool: 'meta.set', callId: 'c3', outcome: 'refused', params: { targets: [FRIEND], status: 'final' } },
    ];
    const scripts = scripted(makeState(), [() => ({ trace })]);
    const finished = await run(scripts, goalOf([SYNOPSES], { writeScope: { mode: 'doc', docIds: [CHAPTER_ONE] }, maxIterations: 1 }));
    expect(finished.status).toBe('max-iterations');
    expect(finished.iterations[0]?.outOfScope).toEqual([]);
  });

  it('fails closed on an external call that ran under a card, whose documents cannot be worked out, and lets a trusted external read through', async () => {
    const write: TurnReport['trace'] = [{ tool: 'mcp__notes__append', callId: 'c1', outcome: 'ok', params: { text: 'x' } }];
    const cards: TurnReport['cards'] = [{ kind: 'confirm', tools: ['mcp__notes__append'], decision: 'approved', edits: 0, retries: 0 }];
    const scripts = scripted(makeState(), [() => ({ trace: write, cards })]);
    const finished = await run(scripts, goalOf([SYNOPSES], { writeScope: { mode: 'doc', docIds: [STORM] } }));
    expect(finished.status).toBe('out-of-scope');
    expect(finished.iterations[0]?.outOfScope).toEqual(['mcp__notes__append: its documents could not be worked out']);

    const read: TurnReport['trace'] = [{ tool: 'mcp__notes__search', callId: 'c2', outcome: 'ok', params: { q: 'x' } }];
    const trusted = await run(scripted(makeState(), [() => ({ trace: read })]), goalOf([SYNOPSES], { writeScope: { mode: 'doc', docIds: [STORM] }, maxIterations: 1 }));
    expect(trusted.iterations[0]?.outOfScope).toEqual([]);
  });

  it('is judged against the tree as it was before the turn, so a rename does not hide the target', async () => {
    const trace: TurnReport['trace'] = [{ tool: 'meta.set', callId: 'c1', outcome: 'ok', params: { targets: ['The Friend'], status: 'final' } }];
    const scripts = scripted(makeState(), [
      (s) => {
        const node = s.manifest.tree.find((candidate) => candidate.id === FRIEND);
        if (node !== undefined) node.title = 'The Visitor';
        return { trace };
      },
    ]);
    const finished = await run(scripts, goalOf([SYNOPSES], { writeScope: { mode: 'doc', docIds: [STORM] } }));
    expect(finished.iterations[0]?.outOfScope).toEqual(['meta.set: The Friend']);
  });

  it('becomes write-deny rules over every subtree that holds nothing of the scope, which the harness refuses at the preflight', () => {
    const state = makeState();
    const rules = writeScopeRules({ mode: 'doc', docIds: [STORM] }, state);
    expect(rules.map((rule) => (rule.scope !== undefined && 'subtree' in rule.scope ? rule.scope.subtree : '')).sort()).toEqual(['research', CHAPTER_TWO, LANDING].sort());
    expect(rules.every((rule) => rule.effect === 'deny' && rule.access === 'write' && rule.source === 'session')).toBe(true);
    const set = { rules };
    const meta = { tool: 'meta.set', external: false, writes: true };
    expect(evaluateRules(set, meta, { reads: [], writes: [FRIEND] }, state).effect).toBe('deny');
    expect(evaluateRules(set, meta, { reads: [], writes: [STORM] }, state).effect).toBe('none');
    expect(evaluateRules(set, { ...meta, tool: 'doc.read', writes: false }, { reads: [FRIEND], writes: [] }, state).effect).toBe('none');
    expect(writeScopeRules({ mode: 'full' }, state)).toEqual([]);
  });
});

describe('iterationIntent', () => {
  it('lists the worst documents first and no more than one turn can do, counting the rest', async () => {
    const state = makeState();
    setBody(state, LANDING, 'one two three four five six seven eight nine ten eleven twelve');
    const goal = goalOf([{ kind: 'words.between', scope: FULL, max: 5 }, SYNOPSES], { perIteration: 2 });
    const finished = await run(scripted(state, []), goal, { meter: createBudgetMeter(goal.limits) });
    // The checks already fail at the start, so the first request is what the model is shown.
    expect(finished.status).toBe('stalled');
    const results = finished.iterations[0]?.before ?? [];
    const text = iterationIntent(goal, results, 1);
    expect(text.startsWith('Fill every synopsis.\n')).toBe(true);
    expect(text).toContain('"The Landing"');
    expect(text.indexOf('"The Landing"')).toBeLessThan(text.indexOf('"The Friend"'));
    expect(text).toContain('more item');
    expect(text.split('\n').filter((line) => line.startsWith('  - ')).length).toBe(2);
  });
});

describe('restoreGoal', () => {
  it('restores every iteration, newest first, so the whole run goes back at once', async () => {
    const scripts = scripted(makeState(), [() => undefined]);
    const finished = await run(scripts, goalOf([SYNOPSES]));
    expect(finished.iterations).toHaveLength(2);
    const restored = restoreGoal(scripts.session, finished);
    expect(restored.map((entry) => entry.turnId)).toEqual(['t2', 't1']);
    expect(restored.every((entry) => entry.result.ok)).toBe(true);
    expect(scripts.restored).toEqual(['t2', 't1']);
  });
});

describe('restoreGoal, when an iteration cannot be taken back completely', () => {
  it('stops at the first partial iteration, so an older one is not undone under newer writes', async () => {
    const scripts = scripted(makeState(), [() => undefined]);
    const finished = await run(scripts, goalOf([SYNOPSES]));
    expect(finished.iterations).toHaveLength(2);
    scripts.partial.add('t2');
    const restored = restoreGoal(scripts.session, finished);
    expect(restored.map((entry) => [entry.turnId, entry.complete])).toEqual([['t2', false]]);
    expect(scripts.restored).toEqual(['t2']);
  });

  it('carries on with the older iterations on a second call, skipping the one that was already taken back', async () => {
    const scripts = scripted(makeState(), [() => undefined]);
    const finished = await run(scripts, goalOf([SYNOPSES]));
    expect(finished.iterations).toHaveLength(2);
    scripts.partial.add('t1');
    expect(restoreGoal(scripts.session, finished).map((entry) => [entry.turnId, entry.complete])).toEqual([['t2', true], ['t1', false]]);
    scripts.partial.delete('t1');
    scripts.restored.length = 0;
    expect(restoreGoal(scripts.session, finished).map((entry) => [entry.turnId, entry.complete])).toEqual([['t1', true]]);
    expect(scripts.restored).toEqual(['t2', 't1']);
  });

  it('marks every iteration complete when nothing was left in place', async () => {
    const scripts = scripted(makeState(), [() => undefined]);
    const finished = await run(scripts, goalOf([SYNOPSES]));
    expect(restoreGoal(scripts.session, finished).map((entry) => entry.complete)).toEqual([true, true]);
  });
});

describe('a closing coherence run that goes wrong', () => {
  const coherence: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] };
  const named = (): ProjectState => {
    const state = makeState();
    setBody(state, LANDING, 'Elena met Kestrel.');
    return state;
  };

  it('says the scan ran but could not be recorded, in notes and in the reason, and keeps the status', async () => {
    const scripts = scripted(named(), [() => undefined]);
    const finished = await run(scripts, goalOf([coherence]), {
      recordCoherence: () => {
        throw new Error('disk full');
      },
    });
    expect(finished.status).toBe('passed');
    expect(finished.scanRunId).toBeUndefined();
    expect(finished.notes).toHaveLength(1);
    expect(finished.notes[0]).toMatch(/could not be recorded/);
    expect(finished.notes[0]).not.toMatch(/did not run/);
    expect(finished.reason).toContain(finished.notes[0]);
  });

  it('says the scan did not run when it could not be made, in notes and in the reason', async () => {
    let calls = 0;
    const scripts = scripted(named(), [() => undefined]);
    // The first call is the evaluation at the start, the second the closing scan.
    const finished = await run(scripts, goalOf([coherence]), {
      checks: {
        dialogue: () => {
          calls += 1;
          if (calls > 1) throw new Error('the dialogue facts are unavailable');
          return undefined;
        },
      },
    });
    expect(finished.status).toBe('passed');
    expect(finished.scanRunId).toBeUndefined();
    expect(finished.notes).toEqual(['the closing coherence scan did not run: the dialogue facts are unavailable']);
    expect(finished.reason).toContain('the closing coherence scan did not run');
  });
});

describe('a read rule', () => {
  const synopses: CheckSpec = { kind: 'synopsis.filled', scope: FULL };

  it('keeps a withheld document out of every request: not named, not counted, not measured', async () => {
    const state = makeState();
    const scripts = scripted(state, [(s) => synopsisOf(s, FRIEND, 'The friend arrives.')]);
    const finished = await run(scripts, goalOf([synopses, { kind: 'words.between', scope: FULL, max: 1 }]), { withheld: () => new Set([STORM]) });

    expect(scripts.intents.length).toBeGreaterThan(0);
    for (const intent of scripts.intents) {
      expect(intent).not.toContain('The Storm');
      expect(intent).not.toContain(STORM);
    }
    const results = finished.iterations.flatMap((record) => [...record.before, ...record.after]).concat([...finished.results]);
    expect(JSON.stringify(results)).not.toContain('The Storm');
    expect(JSON.stringify(results)).not.toContain(STORM);
    // The count of what is left out is a note, never a name.
    expect(finished.results.flatMap((result) => result.notes)).toContain('1 document is withheld from the agent by a rule and not checked.');
  });

  it('does not let a withheld document stand in the way of the goal: the checks pass over what the agent may read', async () => {
    const state = makeState();
    synopsisOf(state, LANDING, 'Elena returns.');
    const scripts = scripted(state, [(s) => synopsisOf(s, FRIEND, 'The friend arrives.')]);
    const finished = await run(scripts, goalOf([synopses]), { withheld: () => new Set([STORM]) });
    expect(finished.status).toBe('passed');
    expect(scripts.intents.join(' ')).not.toContain('The Storm');
  });

  it('reads the rule afresh: a document withheld mid-run leaves the next request', async () => {
    const state = makeState();
    const hidden = new Set<string>();
    const scripts = scripted(state, [() => void hidden.add(STORM), () => undefined]);
    await run(scripts, goalOf([synopses]), { withheld: () => hidden });
    expect(scripts.intents[0]).toContain('"The Storm"');
    expect(scripts.intents[1]).not.toContain('"The Storm"');
  });

  it('ends with a coherence run that leaves the withheld document out, as the scan port would', async () => {
    const state = makeState();
    setBody(state, STORM, 'Rain. Elena and Kestrel at the lamp.');
    const coherence: CheckSpec = { kind: 'coherence.clean', scope: FULL, checks: ['codex.never-mentioned'] };
    const scripts = scripted(state, [() => undefined]);
    const finished = await run(scripts, goalOf([coherence]), { withheld: () => new Set([STORM]) });
    const held = state.coherence;
    expect(finished.scanRunId).toBe(held?.runs[0]?.id);
    // Elena and Kestrel are named only in the withheld document, so with it left out they are still never mentioned.
    expect(finished.results[0]?.pass).toBe(false);
    expect(JSON.stringify(held)).not.toContain(STORM);
  });
});
