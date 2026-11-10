import { assertNever, type MachineTable } from '@caotang/machine';

interface Restoration { readonly at: number; readonly fromStep?: number }
export type TurnMarker = { readonly kind: 'live' }
  | ({ readonly kind: 'restored' } & Restoration)
  | { readonly kind: 'rewound'; readonly restored?: Restoration };
export type TurnMarkerEvent = { readonly type: 'restore'; readonly at: number; readonly fromStep?: number }
  | { readonly type: 'rewind' };

export const turnMarkerTable: MachineTable<TurnMarker, TurnMarkerEvent> = {
  id: 'turn.marker', initial: 'live', final: ['rewound'],
  on: {
    live: { restore: ['restored'], rewind: ['rewound'] },
    restored: { restore: ['restored'], rewind: ['rewound'] },
    rewound: {},
  },
};

export function stepTurnMarker(state: TurnMarker, event: TurnMarkerEvent): TurnMarker {
  if (state.kind === 'rewound') return state;
  switch (event.type) {
    case 'restore':
      return { kind: 'restored', at: event.at, ...(event.fromStep === undefined ? {} : { fromStep: event.fromStep }) };
    case 'rewind':
      return { kind: 'rewound', ...(state.kind === 'restored' ? { restored: { at: state.at, ...(state.fromStep === undefined ? {} : { fromStep: state.fromStep }) } } : {}) };
    default:
      return assertNever(event);
  }
}

export function turnMarkerFields(state: TurnMarker): { readonly rewound: boolean; readonly restoredAt?: number; readonly restoredFromStep?: number } {
  const restored = state.kind === 'restored' ? state : state.kind === 'rewound' ? state.restored : undefined;
  return { rewound: state.kind === 'rewound', ...(restored === undefined ? {} : { restoredAt: restored.at,
    ...(restored.fromStep === undefined ? {} : { restoredFromStep: restored.fromStep }) }) };
}
