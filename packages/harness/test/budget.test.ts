/**
 * The run-limit meter (agent-harness §7.1): a call's worst case is reserved before it is sent, settled with what it used, and a time
 * limit aborts the signal. The clock is injected, so time moves only when a test moves it.
 */

import { describe, expect, it } from 'vitest';

import { createManualClock } from '@caotang/gateway';

import { anySignal, createBudgetMeter, runLimitWords, stepLimitWords, type Reservation } from '../src/index.js';

const call = { promptTokens: 100, maxOutputTokens: 400 };

function reserved(result: ReturnType<ReturnType<typeof createBudgetMeter>['reserve']>): Reservation {
  if (!result.ok) throw new Error(`refused: ${result.error.dimension}`);
  return result.value;
}

describe('reserving a call', () => {
  it('refuses at exactly the boundary: the last token fits, one more does not', () => {
    const meter = createBudgetMeter({ maxTokens: 1_000 });
    const first = reserved(meter.reserve(call));
    meter.settle(first, { promptTokens: 100, completionTokens: 400 });
    expect(meter.reserve({ promptTokens: 100, maxOutputTokens: 400 }).ok).toBe(true);
    const refused = meter.reserve({ promptTokens: 100, maxOutputTokens: 301 });
    // 500 are spent and 500 are held by the second call, so a third that could use 401 more needs 1,401 in all.
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatchObject({ dimension: 'tokens', limit: 1_000, spent: 500, needed: 1_401 });
  });

  it('sums concurrent reservations, so two calls that fit alone are not both let through', () => {
    const meter = createBudgetMeter({ maxTokens: 1_000 });
    expect(meter.reserve({ promptTokens: 100, maxOutputTokens: 400 }).ok).toBe(true);
    expect(meter.reserve({ promptTokens: 100, maxOutputTokens: 400 }).ok).toBe(true);
    const third = meter.reserve({ promptTokens: 1, maxOutputTokens: 1 });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toMatchObject({ dimension: 'tokens', needed: 1_002 });
  });

  it('frees a reservation when it settles, so the room it held can be used again', () => {
    const meter = createBudgetMeter({ maxTokens: 1_000 });
    const first = reserved(meter.reserve({ promptTokens: 100, maxOutputTokens: 800 }));
    expect(meter.reserve({ promptTokens: 100, maxOutputTokens: 100 }).ok).toBe(false);
    meter.settle(first, { promptTokens: 100, completionTokens: 50 });
    expect(meter.reserve({ promptTokens: 100, maxOutputTokens: 100 }).ok).toBe(true);
  });

  it('settles a call with no usage at the estimate it is given, and counts those tokens as estimated', () => {
    const meter = createBudgetMeter({ maxTokens: 10_000 });
    meter.settle(reserved(meter.reserve(call)), undefined, { promptTokens: 100, completionTokens: 30 });
    expect(meter.spend()).toMatchObject({ promptTokens: 100, completionTokens: 30, estimatedTokens: 130, modelCalls: 1 });
  });

  it('settles a call with no usage and no estimate at its whole reservation, so the cap cannot be crossed by a silent provider', () => {
    const meter = createBudgetMeter({ maxTokens: 10_000 });
    meter.settle(reserved(meter.reserve(call)), undefined);
    expect(meter.spend()).toMatchObject({ promptTokens: 100, completionTokens: 400, estimatedTokens: 500 });
  });

  it('does not count tokens as estimated when the provider reported usage', () => {
    const meter = createBudgetMeter();
    meter.settle(reserved(meter.reserve(call)), { promptTokens: 90, completionTokens: 10 });
    expect(meter.spend()).toMatchObject({ promptTokens: 90, completionTokens: 10, estimatedTokens: 0 });
  });

  it('bounds model calls and counts a refused call as not made', () => {
    const meter = createBudgetMeter({ maxModelCalls: 2 });
    meter.settle(reserved(meter.reserve(call)), { promptTokens: 1, completionTokens: 1 });
    meter.settle(reserved(meter.reserve(call)), { promptTokens: 1, completionTokens: 1 });
    const third = meter.reserve(call);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toEqual({ dimension: 'model-calls', limit: 2, spent: 2 });
    expect(meter.spend().modelCalls).toBe(2);
  });
});

describe('the cost limit', () => {
  const price = { prompt: 0.01, completion: 0.03 };

  it('counts cost as the context preview does, to 1e-9, and refuses a call whose worst case would pass the limit', () => {
    const meter = createBudgetMeter({ maxCostUsd: 0.05 });
    // 1,000 prompt tokens at 0.01 and 1,000 completion tokens at 0.03 per 1k is 0.04: it fits.
    const first = reserved(meter.reserve({ promptTokens: 1_000, maxOutputTokens: 1_000, price }));
    meter.settle(first, { promptTokens: 1_000, completionTokens: 1_000 });
    expect(Math.abs((meter.spend().costUsd ?? 0) - ((1_000 / 1_000) * 0.01 + (1_000 / 1_000) * 0.03))).toBeLessThan(1e-9);
    // 0.01 more fits (0.05 exactly); a hair more does not.
    expect(meter.reserve({ promptTokens: 1_000, maxOutputTokens: 0, price }).ok).toBe(true);
    const refused = meter.reserve({ promptTokens: 1_000, maxOutputTokens: 1, price });
    expect(refused.ok).toBe(false);
  });

  it('refuses a cost limit on a call with no price before anything is spent', () => {
    const meter = createBudgetMeter({ maxCostUsd: 1 });
    const refused = meter.reserve(call);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toMatchObject({ dimension: 'cost', unpriced: true });
      expect(runLimitWords(refused.error, 'Home server').reason).toBe(
        'This run has a cost limit, and the profile “Home server” has no prices, so its cost cannot be counted. Add its prices in Settings › Providers, or use a token limit.',
      );
    }
    expect(meter.spend().modelCalls).toBe(0);
  });
});

describe('steps', () => {
  it('counts steps, says how many are left, and refuses a count that passes the limit', () => {
    const meter = createBudgetMeter({ maxSteps: 3 });
    expect(meter.stepsLeft()).toBe(3);
    expect(meter.countStep(2).ok).toBe(true);
    expect(meter.stepsLeft()).toBe(1);
    const over = meter.countStep(2);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toEqual({ dimension: 'steps', limit: 3, spent: 4 });
    expect(meter.stepsLeft()).toBe(0);
  });

  it('has no step limit unless one is set', () => {
    expect(createBudgetMeter().stepsLeft()).toBe(Infinity);
  });

  it('words the planner’s refusal with the limit and what is left', () => {
    expect(stepLimitWords(5, 4, 1)).toBe(
      'the run’s limit is 5 applied steps and 4 are used, so a plan may have 1 more write step: send a plan within that, or tell the writer the run needs a larger step limit',
    );
  });
});

describe('time', () => {
  it('aborts the signal when the deadline passes, and answers with the deadline', () => {
    const clock = createManualClock(1_000);
    const meter = createBudgetMeter({ deadline: 5_000 }, { clock });
    expect(meter.signal.aborted).toBe(false);
    clock.advance(3_999);
    expect(meter.signal.aborted).toBe(false);
    clock.advance(1);
    expect(meter.signal.aborted).toBe(true);
    expect(meter.stopped()).toEqual({ dimension: 'deadline', limit: 5_000, spent: 5_000 });
  });

  it('aborts the signal when active time is used up', () => {
    const clock = createManualClock(0);
    const meter = createBudgetMeter({ maxActiveMs: 600_000 }, { clock });
    clock.advance(599_999);
    expect(meter.signal.aborted).toBe(false);
    clock.advance(1);
    expect(meter.signal.aborted).toBe(true);
    expect(meter.stopped()).toEqual({ dimension: 'active-time', limit: 600_000, spent: 600_000 });
  });

  it('does not count the time a card waits: a paused clock is not work', () => {
    const clock = createManualClock(0);
    const meter = createBudgetMeter({ maxActiveMs: 10_000 }, { clock });
    clock.advance(4_000);
    meter.pauseClock();
    clock.advance(60_000);
    expect(meter.signal.aborted).toBe(false);
    expect(meter.spend().activeMs).toBe(4_000);
    meter.resumeClock();
    clock.advance(5_999);
    expect(meter.signal.aborted).toBe(false);
    clock.advance(1);
    expect(meter.signal.aborted).toBe(true);
  });

  it('keeps counting the deadline while paused, because a deadline is the wall clock', () => {
    const clock = createManualClock(0);
    const meter = createBudgetMeter({ maxActiveMs: 10_000, deadline: 30_000 }, { clock });
    meter.pauseClock();
    clock.advance(30_000);
    expect(meter.stopped()?.dimension).toBe('deadline');
  });

  it('nests pauses', () => {
    const clock = createManualClock(0);
    const meter = createBudgetMeter({ maxActiveMs: 1_000 }, { clock });
    meter.pauseClock();
    meter.pauseClock();
    meter.resumeClock();
    clock.advance(5_000);
    expect(meter.signal.aborted).toBe(false);
    meter.resumeClock();
    clock.advance(1_000);
    expect(meter.signal.aborted).toBe(true);
  });

  it('refuses a call once a time limit has passed, even if no timer ran', () => {
    const clock = createManualClock(0);
    const meter = createBudgetMeter({ deadline: 100 }, { clock });
    meter.dispose();
    clock.advance(200);
    const refused = meter.reserve(call);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.dimension).toBe('deadline');
    expect(meter.signal.aborted).toBe(true);
  });

  it('leaves no timer behind once it is disposed or has fired', () => {
    const clock = createManualClock(0);
    const meter = createBudgetMeter({ maxActiveMs: 1_000, deadline: 2_000 }, { clock });
    expect(clock.pending).toBe(1);
    meter.dispose();
    expect(clock.pending).toBe(0);
    const fired = createBudgetMeter({ deadline: 10 }, { clock });
    clock.advance(10);
    expect(fired.signal.aborted).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('can be stopped on a limit by its owner', () => {
    const meter = createBudgetMeter();
    meter.stop({ dimension: 'deadline', limit: 1, spent: 2 });
    expect(meter.signal.aborted).toBe(true);
    expect(meter.stopped()).toEqual({ dimension: 'deadline', limit: 1, spent: 2 });
  });
});

describe('saving a meter', () => {
  it('round-trips through toJSON and a restore, spend and limits both', () => {
    const clock = createManualClock(0);
    const limits = { maxTokens: 5_000, maxCostUsd: 2, maxSteps: 9, maxActiveMs: 60_000 };
    const meter = createBudgetMeter(limits, { clock });
    meter.settle(reserved(meter.reserve({ ...call, price: { prompt: 0.01, completion: 0.03 } })), { promptTokens: 80, completionTokens: 20 });
    meter.settle(reserved(meter.reserve({ ...call, price: { prompt: 0.01, completion: 0.03 } })), undefined);
    meter.countStep(3);
    clock.advance(12_000);
    const saved = JSON.parse(JSON.stringify(meter.toJSON())) as ReturnType<typeof meter.toJSON>;

    const later = createBudgetMeter(saved.limits, { clock: createManualClock(500_000), restored: saved.spend });
    expect(later.spend()).toEqual(saved.spend);
    expect(later.toJSON()).toEqual(saved);
    // The restored run keeps its place: it still has the room the saved one had.
    expect(later.stepsLeft()).toBe(6);
  });
});

describe('combining signals', () => {
  it('aborts when either does, and at once when one already has', () => {
    const a = new AbortController();
    const b = new AbortController();
    const both = anySignal([a.signal, b.signal]);
    expect(both.aborted).toBe(false);
    b.abort();
    expect(both.aborted).toBe(true);
    const done = new AbortController();
    done.abort();
    expect(anySignal([new AbortController().signal, done.signal]).aborted).toBe(true);
  });
});
