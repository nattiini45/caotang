import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export type DemoStartState = { readonly kind: 'idle' } | { readonly kind: 'opening'; readonly intent: string };
export type DemoStartEvent = { readonly type: 'start'; readonly intent: string } | { readonly type: 'settled' };

export const demoStartTable: MachineTable<DemoStartState, DemoStartEvent> = {
  id: 'demo.start', initial: 'idle', final: [],
  on: { idle: { start: ['opening'] }, opening: { settled: ['idle'] } },
};

export const demoStartMachine = defineMachine(demoStartTable, (state, event): DemoStartState => {
  switch (event.type) {
    case 'start': return state.kind === 'idle' ? { kind: 'opening', intent: event.intent } : state;
    case 'settled': return state.kind === 'opening' ? { kind: 'idle' } : state;
    default: return assertNever(event);
  }
});

export class DemoStart {
  private state: DemoStartState = { kind: 'idle' };
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = (): DemoStartState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start(intent: string): boolean {
    if (this.state.kind !== 'idle') return false;
    this.state = demoStartMachine.step(this.state, { type: 'start', intent });
    for (const listener of this.listeners) listener();
    return true;
  }
  settled(): void {
    this.state = demoStartMachine.step(this.state, { type: 'settled' });
    for (const listener of this.listeners) listener();
  }
}
