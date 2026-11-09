import { describe, expect, expectTypeOf, it } from 'vitest';
import { assertNever, canMove, defineMachine } from '../src/index.js';
import type { MachineTable } from '../src/index.js';
import { checkMachine } from '../src/testing.js';

type State = { kind: 'idle' } | { kind: 'running'; count: number } | { kind: 'done' };
type Event = { type: 'start' } | { type: 'tick' } | { type: 'finish' } | { type: 'stale' };

const table: MachineTable<State, Event> = {
  id: 'fixture', initial: 'idle', final: ['done'],
  on: { idle: { start: ['running'] }, running: { tick: ['running'], finish: ['done'] }, done: {} },
};
const machine = defineMachine<State, Event>(table, (state, event) => {
  switch (event.type) {
    case 'start': return state.kind === 'idle' ? { kind: 'running', count: 0 } : state;
    case 'tick': return state.kind === 'running' ? { ...state, count: state.count + 1 } : state;
    case 'finish': return state.kind === 'running' ? { kind: 'done' } : state;
    case 'stale': return state;
    default: return assertNever(event);
  }
});
const states: State[] = [{ kind: 'idle' }, { kind: 'running', count: 0 }, { kind: 'done' }];
const events: Event[] = [{ type: 'start' }, { type: 'tick' }, { type: 'finish' }, { type: 'stale' }];

describe('the runtime leaf API', () => {
  it('keeps the supplied table and pure step, without a runtime or effects', () => {
    expect(machine.table).toBe(table);
    const before: State = { kind: 'running', count: 2 };
    expect(machine.step(before, { type: 'tick' })).toEqual({ kind: 'running', count: 3 });
    expect(before).toEqual({ kind: 'running', count: 2 });
    expectTypeOf(machine.step).parameter(0).toEqualTypeOf<State>();
    expectTypeOf(table.on).toEqualTypeOf<{
      readonly idle: { readonly [T in Event['type']]?: readonly State['kind'][] };
      readonly running: { readonly [T in Event['type']]?: readonly State['kind'][] };
      readonly done: { readonly [T in Event['type']]?: readonly State['kind'][] };
    }>();
  });

  it('allows listed transitions including self transitions, not unlisted or empty ones', () => {
    expect(canMove(table, 'idle', 'start')).toBe(true);
    expect(canMove(table, 'running', 'tick')).toBe(true);
    expect(canMove(table, 'idle', 'stale')).toBe(false);
    expect(canMove(table, 'done', 'start')).toBe(false);
    expect(canMove({ ...table, on: { ...table.on, idle: { start: [] } } }, 'idle', 'start')).toBe(false);
  });

  it('throws for an unexpected variant at an exhaustive switch boundary', () => {
    expect(() => assertNever('unexpected' as never)).toThrow('Unexpected machine variant: unexpected');
  });
});

describe('checkMachine', () => {
  it('runs every sample pair, including stale events, and accepts the matching table', () => {
    const visits: string[] = [];
    const checked = defineMachine(table, (state, event) => {
      visits.push(`${state.kind}:${event.type}`);
      return machine.step(state, event);
    });
    expect(checkMachine(checked, { states, events })).toEqual([]);
    expect(visits).toEqual(states.flatMap((state) => events.map((event) => `${state.kind}:${event.type}`)));
  });

  it('reports a step whose result disagrees with the listed targets', () => {
    const broken = defineMachine(table, (state) => state);
    expect(checkMachine(broken, { states, events })).toEqual([
      'fixture: idle + start returned idle; expected running',
      'fixture: running + finish returned running; expected done',
    ]);
  });

  it('requires object identity for unlisted events, even when the kind is unchanged', () => {
    const broken = defineMachine(table, (state, event) => event.type === 'stale' ? { ...state } : machine.step(state, event));
    expect(checkMachine(broken, { states, events })).toEqual(states.map((state) =>
      `fixture: ${state.kind} + stale is unlisted but did not return the same state`));
  });

  it('reports missing state and declared-event samples', () => {
    expect(checkMachine(machine, { states: states.filter((state) => state.kind !== 'done'), events: events.filter((event) => event.type !== 'finish') }))
      .toEqual(['fixture: missing event sample for finish', 'fixture: missing state sample for done']);
  });

  it('finds unreachable non-final states, including cycles with no path from initial', () => {
    const extended: MachineTable<State | { kind: 'orphan' }, Event> = {
      ...table, on: { ...table.on, orphan: { tick: ['orphan'] } },
    };
    expect(checkMachine(defineMachine(extended, (state, event) => state.kind === 'orphan' ? state : machine.step(state, event)), {
      states: [...states, { kind: 'orphan' }], events,
    })).toEqual(['fixture: non-final state orphan is unreachable']);
  });

  it('rejects exits from final states, including a self transition', () => {
    const broken = { ...table, on: { ...table.on, done: { stale: ['done'] as const } } };
    expect(checkMachine(defineMachine(broken, machine.step), { states, events }))
      .toEqual(['fixture: final state done has an exit on stale']);
  });

  it('accepts any listed target when payloads choose different branches', () => {
    const branching = { ...table, on: { ...table.on, running: { ...table.on.running, tick: ['running', 'done'] as const } } };
    const checked = defineMachine<State, Event>(branching, (state, event) => state.kind === 'running' && state.count === 2 && event.type === 'tick'
      ? { kind: 'done' } : machine.step(state, event));
    expect(checkMachine(checked, { states: [...states, { kind: 'running', count: 2 }], events })).toEqual([]);
  });

  it('returns diagnostics for a throwing step instead of stopping at the first pair', () => {
    const broken = defineMachine(table, () => { throw new Error('broken'); });
    const problems = checkMachine(broken, { states, events });
    expect(problems).toHaveLength(states.length * events.length);
    expect(problems[0]).toBe('fixture: idle + start threw broken');
  });

  it('diagnoses malformed tables and foreign samples at an untyped boundary', () => {
    const broken = {
      ...table, initial: 'missing', final: ['missing'],
      on: { ...table.on, idle: { start: ['missing'] } },
    } as unknown as MachineTable<State, Event>;
    const problems = checkMachine(defineMachine(broken, machine.step), {
      states: [...states, { kind: 'foreign' } as unknown as State], events,
    });
    expect(problems).toContain('fixture: initial state missing has no row');
    expect(problems).toContain('fixture: final state missing has no row');
    expect(problems).toContain('fixture: idle + start targets unknown state missing');
    expect(problems).toContain('fixture: state sample foreign has no row');
  });
});
