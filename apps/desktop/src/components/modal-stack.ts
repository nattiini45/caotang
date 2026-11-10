import { assertNever, defineMachine } from '@caotang/machine';

export type ModalPriority = 'dialog' | 'confirm' | 'notice';
export interface ModalEntry {
  readonly id: number;
  readonly priority: ModalPriority;
}
export type ModalState =
  | { readonly kind: 'empty'; readonly entries: readonly [] }
  | { readonly kind: 'open'; readonly entries: readonly [ModalEntry, ...ModalEntry[]] };
export type ModalEvent =
  | { readonly type: 'open'; readonly entry: ModalEntry }
  | { readonly type: 'close'; readonly id: number };

const priority: Record<ModalPriority, number> = { dialog: 0, confirm: 1, notice: 2 };
export const modalMachine = defineMachine<ModalState, ModalEvent>({
  id: 'ui.modal-stack', initial: 'empty', final: [],
  on: {
    empty: { open: ['open'] },
    open: { open: ['open'], close: ['empty', 'open'] },
  },
}, (state, event) => {
  switch (event.type) {
    case 'open': {
      if (state.entries.some((entry) => entry.id === event.entry.id)) return state;
      const entries = [...state.entries, event.entry].sort((a, b) => priority[a.priority] - priority[b.priority]);
      return { kind: 'open', entries: entries as [ModalEntry, ...ModalEntry[]] };
    }
    case 'close': {
      if (!state.entries.some((entry) => entry.id === event.id)) return state;
      const entries = state.entries.filter((entry) => entry.id !== event.id);
      return entries.length === 0 ? { kind: 'empty', entries: [] } : { kind: 'open', entries: entries as [ModalEntry, ...ModalEntry[]] };
    }
    default: return assertNever(event);
  }
});

export class ModalStack {
  private state: ModalState = { kind: 'empty', entries: [] };
  private readonly requests = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = (): ModalState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  send(event: ModalEvent): void {
    const next = modalMachine.step(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.announce();
  }
  read<T>(slot: string): T | null {
    return (this.requests.get(slot) as T | undefined) ?? null;
  }
  write<T>(slot: string, value: T | null): void {
    if (Object.is(this.read(slot), value)) return;
    if (value === null) this.requests.delete(slot);
    else this.requests.set(slot, value);
    this.announce();
  }
  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

export const modalStack = new ModalStack();
