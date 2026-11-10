import { describe, expect, it, vi } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { emptyCoherenceFile, planReview, runReview, type ReviewRunResult } from '@caotang/coherence';
import { buildState, NOW } from '../../../packages/coherence/test/fixtures.js';
import { CoherenceReviewSession, reviewMachine, type ReviewEvent, type ReviewState } from '../src/app/coherence-review-state.js';
import { panelState } from '../src/app/panel-state.js';

const state = buildState({ scenes: [{ id: 'n_SCENE00001', title: 'Scene', body: 'The ferry arrived.' }] });
const file = emptyCoherenceFile();
const plan = planReview(state, file, { scope: { mode: 'full' }, maxFindings: 10 });
const outcome = { added: 2, notes: ['A provider stopped.'] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('the session-owned findings review', () => {
  it('agrees with its table for every state and event, including both stop outcomes', () => {
    const states: ReviewState[] = [
      { kind: 'idle' }, { kind: 'idle', outcome }, { kind: 'planned', plan },
      { kind: 'running', plan, completedCalls: 0, stopRequested: false },
      { kind: 'running', plan, completedCalls: 1, stopRequested: true },
      { kind: 'cancelled' }, { kind: 'partial', outcome }, { kind: 'failed', message: 'Offline.' },
    ];
    const events: ReviewEvent[] = [
      { type: 'plan', plan }, { type: 'dismiss' }, { type: 'start' }, { type: 'stop' },
      { type: 'progress', completedCalls: 1 }, { type: 'done', status: 'complete', outcome },
      { type: 'done', status: 'partial', outcome }, { type: 'fail', message: 'Offline.' },
    ];
    expect(checkMachine(reviewMachine, { states, events })).toEqual([]);
    for (const value of ['loading', 'empty', 'error', 'off', 'partial', 'conflict'] as const) {
      expect(panelState(value)).toEqual({ 'data-panel-state': value });
    }
  });

  it('starts once synchronously and keeps progress and completion without a panel subscriber', async () => {
    const reply = deferred<ReviewRunResult>();
    const apply = vi.fn();
    const changed = vi.fn();
    const review = new CoherenceReviewSession(changed, apply);
    const run = vi.fn((_plan, _signal, progress: (calls: number) => void) => {
      progress(1);
      return reply.promise;
    });
    review.plan(plan);
    review.start(run);
    review.start(run);
    review.plan(plan);
    review.dismiss();
    expect(run).toHaveBeenCalledTimes(1);
    expect(review.snapshot()).toMatchObject({ kind: 'running', completedCalls: 1 });
    const result = await runReview(state, file, plan, { approved: true, now: NOW, model: { model: 'mock', complete: async () => ({ content: '{"spans":[]}' }) } });
    reply.resolve(result);
    await review.settled();
    expect(apply).toHaveBeenCalledExactlyOnceWith(result);
    expect(review.snapshot()).toEqual({ kind: 'idle', outcome: { added: 0, notes: [] } });
    expect(changed).toHaveBeenCalled();
  });

  it('aborts the model, keeps the partial run, and publishes stopped rather than failure', async () => {
    const entered = deferred<void>();
    const apply = vi.fn();
    const review = new CoherenceReviewSession(() => {}, apply);
    review.plan(plan);
    review.start((_plan, signal) => runReview(state, file, plan, {
      approved: true, now: NOW, signal,
      model: { model: 'mock', complete: () => {
        entered.resolve();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted.')), { once: true }));
      } },
    }));
    await entered.promise;
    review.stop();
    expect(review.snapshot()).toMatchObject({ kind: 'running', stopRequested: true });
    await review.settled();
    expect(review.snapshot()).toMatchObject({ kind: 'cancelled', outcome: { added: 0 } });
    expect(apply.mock.calls[0]?.[0].run.status).toBe('partial');
    review.plan(plan);
    expect(review.snapshot().kind).toBe('planned');
    review.dismiss();
    expect(review.snapshot().kind).toBe('idle');
  });

  it('distinguishes a partial provider run, a failed run, and a rejection after Stop', async () => {
    const review = new CoherenceReviewSession(() => {}, () => {});
    review.plan(plan);
    review.start(() => runReview(state, file, plan, {
      approved: true, now: NOW, model: { model: 'mock', complete: () => Promise.reject(new Error('Provider offline.')) },
    }));
    await review.settled();
    expect(review.snapshot()).toMatchObject({ kind: 'partial', outcome: { added: 0 } });
    review.plan(plan);
    review.start(() => Promise.reject(new Error('Cannot run.')));
    await review.settled();
    expect(review.snapshot()).toEqual({ kind: 'failed', message: 'Cannot run.' });
    review.plan(plan);
    review.start(() => Promise.reject(new Error('Aborted.')));
    review.stop();
    await review.settled();
    expect(review.snapshot()).toEqual({ kind: 'cancelled' });
  });
});
