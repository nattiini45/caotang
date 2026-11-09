export interface MachineTable<S extends { kind: string }, E extends { type: string }> {
  readonly id: string;
  readonly initial: S['kind'];
  readonly final: readonly S['kind'][];
  readonly on: {
    readonly [K in S['kind']]: { readonly [T in E['type']]?: readonly S['kind'][] };
  };
}

export interface Machine<S extends { kind: string }, E extends { type: string }> {
  readonly table: MachineTable<S, E>;
  step(state: S, event: E): S;
}

export function defineMachine<S extends { kind: string }, E extends { type: string }>(
  table: MachineTable<S, E>,
  step: (state: S, event: E) => S,
): Machine<S, E> {
  return { table, step };
}

export function canMove<S extends { kind: string }, E extends { type: string }>(
  table: MachineTable<S, E>,
  from: S['kind'],
  event: E['type'],
): boolean {
  return (table.on[from][event]?.length ?? 0) > 0;
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected machine variant: ${String(value)}`);
}
