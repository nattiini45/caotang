import { assertNever, type Machine, type MachineTable } from '@caotang/machine';

export type MenuState =
  | { readonly kind: 'closed'; readonly opening: number }
  | { readonly kind: 'open'; readonly opening: number }
  | { readonly kind: 'closing'; readonly opening: number };

export type MenuEvent =
  | { readonly type: 'open' }
  | { readonly type: 'close' }
  | { readonly type: 'toggle' }
  | { readonly type: 'closed'; readonly opening: number };

export const menuTable: MachineTable<MenuState, MenuEvent> = {
  id: 'modern.menu',
  initial: 'closed',
  final: [],
  on: {
    closed: { open: ['open'], toggle: ['open'] },
    open: { open: ['open'], close: ['closing'], toggle: ['closing'] },
    closing: { open: ['open'], toggle: ['open'], closed: ['closed', 'closing'] },
  },
};

export function menuStep(state: MenuState, event: MenuEvent): MenuState {
  switch (event.type) {
    case 'open':
      return { kind: 'open', opening: state.opening + 1 };
    case 'toggle':
      return state.kind === 'open' ? { kind: 'closing', opening: state.opening } : { kind: 'open', opening: state.opening + 1 };
    case 'close':
      return state.kind === 'open' ? { kind: 'closing', opening: state.opening } : state;
    case 'closed':
      return state.kind === 'closing' && event.opening === state.opening ? { kind: 'closed', opening: state.opening } : state;
    default:
      return assertNever(event);
  }
}

export const menuMachine: Machine<MenuState, MenuEvent> = { table: menuTable, step: menuStep };
