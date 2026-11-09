import type { Machine } from './index.js';

export function checkMachine<S extends { kind: string }, E extends { type: string }>(
  machine: Machine<S, E>,
  samples: { states: S[]; events: E[] },
): string[] {
  const { table } = machine;
  const problems: string[] = [];
  const kinds = Object.keys(table.on) as S['kind'][];
  const known = new Set(kinds);
  const stateKinds = new Set(samples.states.map((state) => state.kind));
  const eventTypes = new Set(samples.events.map((event) => event.type));
  const finals = new Set(table.final);
  const report = (problem: string): void => { problems.push(`${table.id}: ${problem}`); };

  if (!known.has(table.initial)) report(`initial state ${table.initial} has no row`);
  for (const kind of finals) {
    if (!known.has(kind)) report(`final state ${kind} has no row`);
  }
  for (const kind of kinds) {
    if (!stateKinds.has(kind)) report(`missing state sample for ${kind}`);
    const row = table.on[kind];
    for (const type of Object.keys(row) as E['type'][]) {
      const targets = row[type] ?? [];
      if (!eventTypes.has(type)) report(`missing event sample for ${type}`);
      if (finals.has(kind) && targets.length > 0) report(`final state ${kind} has an exit on ${type}`);
      for (const target of targets) {
        if (!known.has(target)) report(`${kind} + ${type} targets unknown state ${target}`);
      }
    }
  }

  const reachable = new Set<S['kind']>();
  const pending = [table.initial];
  while (pending.length > 0) {
    const kind = pending.pop()!;
    if (reachable.has(kind) || !known.has(kind)) continue;
    reachable.add(kind);
    const row = table.on[kind];
    for (const type of Object.keys(row) as E['type'][]) pending.push(...(row[type] ?? []));
  }
  for (const kind of kinds) {
    if (!finals.has(kind) && !reachable.has(kind)) report(`non-final state ${kind} is unreachable`);
  }

  for (const state of samples.states) {
    if (!known.has(state.kind)) {
      report(`state sample ${state.kind} has no row`);
      continue;
    }
    for (const event of samples.events) {
      const label = `${state.kind} + ${event.type}`;
      try {
        const result = machine.step(state, event);
        const targets = table.on[state.kind as S['kind']][event.type as E['type']];
        if (!targets?.length) {
          if (result !== state) report(`${label} is unlisted but did not return the same state`);
        } else if (!targets.includes(result.kind)) {
          report(`${label} returned ${result.kind}; expected ${targets.join(' | ')}`);
        }
      } catch (error) {
        report(`${label} threw ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return problems;
}
