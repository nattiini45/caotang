import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export type SessionPhase =
  | { readonly kind: 'opening' }
  | { readonly kind: 'open' }
  | { readonly kind: 'closing' }
  | { readonly kind: 'closed' };

export type SessionEvent = { readonly type: 'opened' | 'close' | 'closed' };

export const sessionTable: MachineTable<SessionPhase, SessionEvent> = {
  id: 'project.session', initial: 'opening', final: ['closed'],
  on: {
    opening: { opened: ['open'], close: ['closing'] },
    open: { close: ['closing'] },
    closing: { closed: ['closed'] },
    closed: {},
  },
};

export const sessionMachine = defineMachine(sessionTable, (state, event): SessionPhase => {
  switch (event.type) {
    case 'opened': return state.kind === 'opening' ? { kind: 'open' } : state;
    case 'close': return state.kind === 'open' || state.kind === 'opening' ? { kind: 'closing' } : state;
    case 'closed': return state.kind === 'closing' ? { kind: 'closed' } : state;
    default: return assertNever(event.type);
  }
});

export class SessionHandle {
  private phase: SessionPhase = { kind: 'opening' };
  private closing: Promise<void> | null = null;

  getSnapshot(): SessionPhase { return this.phase; }

  opened(): void { this.phase = sessionMachine.step(this.phase, { type: 'opened' }); }

  closeSafely(settle: () => Promise<void>, close: () => Promise<void>): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.phase = sessionMachine.step(this.phase, { type: 'close' });
    this.closing = Promise.resolve().then(async () => {
      const settled = await Promise.allSettled([Promise.resolve().then(settle)]);
      const closed = await Promise.allSettled([Promise.resolve().then(close)]);
      this.phase = sessionMachine.step(this.phase, { type: 'closed' });
      for (const result of [...settled, ...closed]) if (result.status === 'rejected') throw result.reason;
    });
    return this.closing;
  }
}
