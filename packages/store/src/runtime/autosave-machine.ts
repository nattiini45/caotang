import { assertNever, type Machine, type MachineTable } from '@caotang/machine';
import type { BodySource } from './autosave.js';

interface PendingBody {
  readonly source: BodySource;
  readonly body: string | null;
  readonly attempts: number;
  readonly failure: unknown | null;
}

interface SlotData {
  readonly revision: number;
  readonly persistedBody: string;
  readonly latestBody: string;
  readonly pending: PendingBody | null;
  readonly scheduled: boolean;
  readonly producing: boolean;
  readonly reseating: number;
  readonly lastError: unknown | null;
  readonly revisionConflict: boolean;
}

export type AutosaveSlot = SlotData & (
  | { readonly kind: 'clean' | 'pending' | 'error' | 'conflict' }
  | { readonly kind: 'saving'; readonly writing: { readonly body: string; readonly before: string } }
);

export type Production = { readonly ok: true; readonly body: string } | { readonly ok: false; readonly error: unknown };
export type AutosaveSlotEvent =
  | { readonly type: 'open' | 'reseated'; readonly body: string; readonly revision: number }
  | { readonly type: 'edit'; readonly source: BodySource }
  | { readonly type: 'cancel-window' | 'window-fired' | 'reset-budget' | 'reseat' }
  | { readonly type: 'produce'; readonly forWrite: boolean }
  | { readonly type: 'produced'; readonly source: BodySource; readonly result: Production }
  | { readonly type: 'read-failed' | 'producer-failed'; readonly error: unknown }
  | { readonly type: 'take'; readonly source: BodySource; readonly body: string }
  | { readonly type: 'written'; readonly revision: number }
  | { readonly type: 'write-failed'; readonly error: unknown; readonly conflict: boolean };

export type AutosaveEffect =
  | { readonly type: 'arm-window' | 'cancel-window' | 'notify' | 'drain' }
  | { readonly type: 'write'; readonly body: string; readonly before: string; readonly revision: number };

export function autosaveSlot(body: string, revision: number): AutosaveSlot {
  return {
    kind: 'clean', revision, persistedBody: body, latestBody: body, pending: null,
    scheduled: false, producing: false, reseating: 0, lastError: null, revisionConflict: false,
  };
}

export function stepAutosave(slot: AutosaveSlot, event: AutosaveSlotEvent): {
  slot: AutosaveSlot; effects: readonly AutosaveEffect[];
} {
  const quiet = (next = slot): { slot: AutosaveSlot; effects: readonly AutosaveEffect[] } => ({ slot: next, effects: [] });
  switch (event.type) {
    case 'open':
      if (slot.pending !== null || slot.kind === 'saving') return quiet();
      return {
        slot: { ...autosaveSlot(event.body, event.revision), producing: slot.producing, reseating: slot.reseating },
        effects: [{ type: 'cancel-window' }, { type: 'notify' }],
      };
    case 'edit': {
      const body = typeof event.source === 'string' ? event.source : null;
      const next = { ...slot, pending: { source: event.source, body, attempts: 0, failure: null },
        latestBody: body ?? slot.latestBody, scheduled: true };
      return {
        slot: next.kind === 'saving' ? next : { ...next, kind: 'pending' },
        effects: [{ type: 'arm-window' }, { type: 'notify' }],
      };
    }
    case 'cancel-window':
      return { slot: { ...slot, scheduled: false }, effects: [{ type: 'cancel-window' }] };
    case 'window-fired':
      return quiet({ ...slot, scheduled: false });
    case 'reset-budget':
      return quiet(slot.pending === null ? slot : { ...slot, pending: { ...slot.pending, attempts: 0 } });
    case 'produce':
      if (slot.pending === null || slot.producing) return quiet();
      return quiet({ ...slot, producing: true, pending: {
        ...slot.pending, attempts: slot.pending.attempts + (event.forWrite ? 1 : 0),
      } });
    case 'produced': {
      const result = event.result;
      if (slot.pending?.source !== event.source) return quiet({ ...slot, producing: false });
      return quiet(result.ok
        ? { ...slot, producing: false, pending: { ...slot.pending, body: result.body, failure: null }, latestBody: result.body }
        : { ...slot, producing: false, pending: { ...slot.pending, failure: result.error } });
    }
    case 'read-failed':
      return slot.lastError === event.error ? quiet() : {
        slot: { ...slot, lastError: event.error }, effects: [{ type: 'notify' }],
      };
    case 'producer-failed': {
      const retry = (slot.pending?.attempts ?? 0) < 2;
      return {
        slot: { ...slot, kind: retry ? 'pending' : 'error', lastError: event.error, scheduled: retry },
        effects: [...(retry ? [{ type: 'arm-window' } as const] : []), { type: 'notify' }],
      };
    }
    case 'take': {
      if (slot.pending === null || slot.kind === 'saving' || slot.reseating > 0) return quiet();
      const pending = slot.pending.source === event.source ? null : slot.pending;
      if (event.body === slot.persistedBody) return {
        slot: { ...slot, kind: pending === null ? 'clean' : 'pending', pending }, effects: [{ type: 'notify' }],
      };
      return {
        slot: { ...slot, kind: 'saving', pending, writing: { body: event.body, before: slot.persistedBody } },
        effects: [{ type: 'notify' }, { type: 'write', body: event.body, before: slot.persistedBody, revision: slot.revision }],
      };
    }
    case 'written': {
      if (slot.kind !== 'saving') return quiet();
      const { writing, ...data } = slot;
      return {
        slot: { ...data, kind: slot.pending === null ? 'clean' : 'pending', revision: event.revision,
          persistedBody: writing.body, latestBody: slot.pending?.body ?? writing.body, lastError: null, revisionConflict: false },
        effects: [{ type: 'notify' }, ...(slot.pending !== null && !slot.scheduled ? [{ type: 'drain' } as const] : [])],
      };
    }
    case 'write-failed': {
      if (slot.kind !== 'saving') return quiet();
      const { writing, ...data } = slot;
      return {
        slot: { ...data, kind: event.conflict ? 'conflict' : slot.pending === null ? 'error' : 'pending',
          pending: slot.pending ?? { source: writing.body, body: writing.body, attempts: 0, failure: null },
          lastError: event.error, revisionConflict: slot.revisionConflict || event.conflict },
        effects: [{ type: 'notify' }],
      };
    }
    case 'reseat': {
      const next = { ...slot, pending: null, scheduled: false, reseating: slot.reseating + 1 };
      return {
        slot: next.kind === 'saving' ? next : { ...next, kind: 'clean' },
        effects: [{ type: 'cancel-window' }],
      };
    }
    case 'reseated':
      if (slot.reseating === 0) return quiet();
      return {
        slot: { ...autosaveSlot(event.body, Math.max(slot.revision, event.revision)),
          producing: slot.producing, reseating: slot.reseating - 1 },
        effects: [{ type: 'cancel-window' }, { type: 'notify' }],
      };
    default: return assertNever(event);
  }
}

export const autosaveTable: MachineTable<AutosaveSlot, AutosaveSlotEvent> = {
  id: 'document.autosave', initial: 'clean', final: [],
  on: {
    clean: {
      'cancel-window': ['clean'], 'window-fired': ['clean'], 'reset-budget': ['clean'],
      produce: ['clean'], produced: ['clean'], 'read-failed': ['clean'],
      open: ['clean'], edit: ['pending'], 'producer-failed': ['pending', 'error'],
      take: ['clean', 'pending', 'saving'], reseat: ['clean'], reseated: ['clean'],
    },
    pending: {
      'cancel-window': ['pending'], 'window-fired': ['pending'], 'reset-budget': ['pending'],
      produce: ['pending'], produced: ['pending'], 'read-failed': ['pending'],
      open: ['pending', 'clean'], edit: ['pending'], 'producer-failed': ['pending', 'error'],
      take: ['clean', 'pending', 'saving'], reseat: ['clean'], reseated: ['pending', 'clean'],
    },
    saving: {
      'cancel-window': ['saving'], 'window-fired': ['saving'], 'reset-budget': ['saving'],
      produce: ['saving'], produced: ['saving'], 'read-failed': ['saving'],
      edit: ['saving'], 'producer-failed': ['pending', 'error'],
      written: ['clean', 'pending'], 'write-failed': ['error', 'pending', 'conflict'],
      reseat: ['saving'], reseated: ['saving', 'clean'],
    },
    error: {
      'cancel-window': ['error'], 'window-fired': ['error'], 'reset-budget': ['error'],
      produce: ['error'], produced: ['error'], 'read-failed': ['error'],
      open: ['error', 'clean'], edit: ['pending'], 'producer-failed': ['pending', 'error'],
      take: ['error', 'clean', 'pending', 'saving'], reseat: ['clean'], reseated: ['error', 'clean'],
    },
    conflict: {
      'cancel-window': ['conflict'], 'window-fired': ['conflict'], 'reset-budget': ['conflict'],
      produce: ['conflict'], produced: ['conflict'], 'read-failed': ['conflict'],
      open: ['conflict', 'clean'], edit: ['pending'], 'producer-failed': ['pending', 'error'],
      take: ['conflict', 'clean', 'pending', 'saving'], reseat: ['clean'], reseated: ['conflict', 'clean'],
    },
  },
};

export const autosaveMachine: Machine<AutosaveSlot, AutosaveSlotEvent> = {
  table: autosaveTable, step: (slot, event) => stepAutosave(slot, event).slot,
};
