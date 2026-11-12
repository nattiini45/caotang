import { assertNever, canMove, defineMachine, type MachineTable } from '@caotang/machine';
import type { ProfileVerification } from './types.js';

export type VerificationEvent =
  | { readonly type: 'check'; readonly attempt: number }
  | { readonly type: 'passed'; readonly attempt: number; readonly checkedAt: number }
  | { readonly type: 'failed'; readonly attempt: number; readonly checkedAt: number }
  | { readonly type: 'invalidate' };

export const providerVerificationTable: MachineTable<ProfileVerification, VerificationEvent> = {
  id: 'provider.verification', initial: 'unknown', final: [],
  on: {
    unknown: { check: ['checking'], invalidate: ['unknown'] },
    checking: { check: ['checking'], passed: ['checking', 'verified'], failed: ['checking', 'failed'], invalidate: ['unknown'] },
    verified: { check: ['checking'], invalidate: ['unknown'] },
    failed: { check: ['checking'], invalidate: ['unknown'] },
  },
};

export const providerVerificationMachine = defineMachine(providerVerificationTable, (state, event): ProfileVerification => {
  if (!canMove(providerVerificationTable, state.kind, event.type)) return state;
  switch (event.type) {
    case 'check': return { kind: 'checking', attempt: event.attempt };
    case 'invalidate': return { kind: 'unknown' };
    case 'passed':
    case 'failed':
      if (state.kind !== 'checking' || state.attempt !== event.attempt) return state;
      return { kind: event.type === 'passed' ? 'verified' : 'failed', checkedAt: event.checkedAt };
    default: return assertNever(event);
  }
});

export function readVerification(value: unknown): ProfileVerification {
  if (typeof value !== 'object' || value === null) return { kind: 'unknown' };
  const record = value as Record<string, unknown>;
  if ((record['kind'] === 'verified' || record['kind'] === 'failed') && typeof record['checkedAt'] === 'number' && Number.isFinite(record['checkedAt']) && record['checkedAt'] >= 0) {
    return { kind: record['kind'], checkedAt: record['checkedAt'] };
  }
  return { kind: 'unknown' };
}
