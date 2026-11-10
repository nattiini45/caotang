import { describe, expect, it } from 'vitest';

import { createManualClock } from '@caotang/gateway';
import { defineMachine } from '@caotang/machine';
import { checkMachine } from '@caotang/machine/testing';

import {
  budgetMeterTable,
  createBudgetMeter,
  stepBudgetMeter,
  type BudgetMeterEvent,
  type BudgetMeterState,
  type BudgetStop,
} from '../../src/agent/budget.js';

const reason: BudgetStop = { dimension: 'deadline', limit: 100, spent: 100 };
const call = { promptTokens: 10, maxOutputTokens: 20 };
const active = { kind: 'active', since: 0 } as const;
const paused = { kind: 'paused', depth: 1 } as const;

describe('the budget meter table', () => {
  it('agrees with the pure step for every lifecycle, timing branch and event', () => {
    const timings: Extract<BudgetMeterState, { kind: 'active' | 'paused' }>[] = [active, paused, { kind: 'paused', depth: 2 }];
    const lifecycles: Exclude<BudgetMeterState, { kind: 'disposed' }>[] = [
      ...timings, ...timings.map((timing) => ({ kind: 'stopped' as const, reason, timing })),
    ];
    const states: BudgetMeterState[] = [...lifecycles, ...lifecycles.map((lifecycle) => ({ kind: 'disposed' as const, lifecycle }))];
    const events: BudgetMeterEvent[] = [{ type: 'pause' }, { type: 'resume', now: 50 }, { type: 'stop', reason }, { type: 'dispose' }];
    const before = structuredClone(states);
    expect(checkMachine(defineMachine(budgetMeterTable, stepBudgetMeter), { states, events })).toEqual([]);
    expect(states).toEqual(before);
    expect(JSON.parse(JSON.stringify(budgetMeterTable))).toEqual(budgetMeterTable);
  });

  it('retains nested timing and the first stop reason through disposal', () => {
    let state: BudgetMeterState = active;
    const events: BudgetMeterEvent[] = [
      { type: 'pause' }, { type: 'pause' }, { type: 'stop', reason }, { type: 'dispose' },
      { type: 'resume', now: 20 }, { type: 'resume', now: 30 },
      { type: 'stop', reason: { dimension: 'steps', limit: 1, spent: 2 } },
    ];
    for (const event of events) state = stepBudgetMeter(state, event);
    expect(state).toEqual({ kind: 'disposed', lifecycle: { kind: 'stopped', reason, timing: { kind: 'active', since: 30 } } });
    expect(stepBudgetMeter(state, { type: 'dispose' })).toBe(state);
  });
});

describe('the meter owns clock and timer effects', () => {
  it('keeps accounting active time and nested pauses after stopping and disposing', () => {
    const clock = createManualClock();
    const meter = createBudgetMeter({ deadline: 100 }, { clock });
    clock.advance(10);
    meter.stop(reason);
    clock.advance(10);
    expect(meter.spend().activeMs).toBe(20);
    meter.pauseClock();
    meter.pauseClock();
    meter.dispose();
    clock.advance(200);
    meter.resumeClock();
    expect(meter.spend().activeMs).toBe(20);
    meter.resumeClock();
    clock.advance(30);
    expect(meter.spend().activeMs).toBe(50);
    expect(clock.pending).toBe(0);
    expect(meter.reserve(call)).toEqual({ ok: false, error: reason });
    expect(meter.stopped()).toBe(reason);
  });

  it('disposes only the timer, so calls, settlement, steps and active spend still work', () => {
    const clock = createManualClock();
    const meter = createBudgetMeter({ maxActiveMs: 100 }, { clock });
    meter.dispose();
    const reservation = meter.reserve(call);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error('The disposed meter refused an allowed call.');
    meter.settle(reservation.value, { promptTokens: 8, completionTokens: 12 });
    meter.countStep();
    clock.advance(150);
    expect(meter.signal.aborted).toBe(false);
    expect(meter.spend()).toMatchObject({ activeMs: 150, modelCalls: 1, promptTokens: 8, completionTokens: 12, steps: 1 });
    expect(meter.stopped()).toEqual({ dimension: 'active-time', limit: 100, spent: 150 });
    expect(meter.signal.aborted).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('continues to check the deadline from reserve while disposed and paused', () => {
    const clock = createManualClock();
    const meter = createBudgetMeter({ deadline: 100 }, { clock });
    meter.pauseClock();
    meter.dispose();
    clock.advance(150);
    expect(meter.signal.aborted).toBe(false);
    expect(meter.reserve(call)).toEqual({ ok: false, error: { dimension: 'deadline', limit: 100, spent: 150 } });
    expect(meter.spend().activeMs).toBe(0);
  });

  it('rearms after disposal only when a pause or resume actually toggles the clock', () => {
    const clock = createManualClock();
    const meter = createBudgetMeter({ deadline: 100 }, { clock });
    meter.pauseClock();
    meter.pauseClock();
    meter.dispose();
    meter.pauseClock();
    meter.resumeClock();
    meter.resumeClock();
    expect(clock.pending).toBe(0);
    meter.resumeClock();
    expect(clock.pending).toBe(1);
    meter.dispose();
    meter.resumeClock();
    expect(clock.pending).toBe(0);
    meter.pauseClock();
    expect(clock.pending).toBe(1);
    clock.advance(100);
    expect(meter.stopped()?.dimension).toBe('deadline');
    expect(meter.spend().activeMs).toBe(0);
    expect(clock.pending).toBe(0);
  });
});
