import { expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { stepTurnMarker, turnMarkerFields, turnMarkerTable, type TurnMarker, type TurnMarkerEvent } from '../../src/agent/turn-marker.js';

it('checks live, whole/partial restored and rewound markers against the table', () => {
  const states: TurnMarker[] = [{ kind: 'live' }, { kind: 'restored', at: 1 }, { kind: 'restored', at: 1, fromStep: 2 },
    { kind: 'rewound' }, { kind: 'rewound', restored: { at: 1, fromStep: 2 } }];
  const events: TurnMarkerEvent[] = [{ type: 'rewind' }, { type: 'restore', at: 2 }, { type: 'restore', at: 2, fromStep: 3 },
    ...states.map((previous): TurnMarkerEvent => ({ type: 'undo-restore', previous }))];
  expect(checkMachine({ table: turnMarkerTable, step: stepTurnMarker }, { states, events })).toEqual([]);
});

it('rewind wins without forgetting the previous project restore', () => {
  const restored = stepTurnMarker({ kind: 'live' }, { type: 'restore', at: 2, fromStep: 3 });
  const rewound = stepTurnMarker(restored, { type: 'rewind' });
  expect(turnMarkerFields(rewound)).toEqual({ rewound: true, restoredAt: 2, restoredFromStep: 3 });
  expect(stepTurnMarker(rewound, { type: 'restore', at: 5 })).toBe(rewound);
});

it('a whole restore clears a previous partial marker', () => {
  expect(turnMarkerFields(stepTurnMarker({ kind: 'restored', at: 2, fromStep: 3 }, { type: 'restore', at: 5 })))
    .toEqual({ rewound: false, restoredAt: 5 });
});

it('undoes the project restoration without rewinding a conversation back into view', () => {
  expect(stepTurnMarker({ kind: 'restored', at: 5 }, { type: 'undo-restore', previous: { kind: 'live' } })).toEqual({ kind: 'live' });
  expect(stepTurnMarker({ kind: 'rewound', restored: { at: 5 } }, { type: 'undo-restore', previous: { kind: 'live' } })).toEqual({ kind: 'rewound' });
  expect(stepTurnMarker({ kind: 'rewound', restored: { at: 5 } }, { type: 'undo-restore', previous: { kind: 'restored', at: 2, fromStep: 3 } })).toEqual({ kind: 'rewound', restored: { at: 2, fromStep: 3 } });
});
