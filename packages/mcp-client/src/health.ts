import { assertNever, canMove, defineMachine, type MachineTable } from '@caotang/machine';
import type { WireErrorKind } from './wire-error.js';

export type HealthFailureReason = WireErrorKind | 'connector-load' | 'token-missing';

export type ConnectionHealth = (
  | { readonly kind: 'configured' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'healthy' }
  | { readonly kind: 'failed'; readonly reason: HealthFailureReason }
) & {
  readonly detail?: string;
  readonly toolsDiscovered?: number;
  readonly pendingReview?: boolean;
};

export type HealthEvent =
  | { readonly type: 'connect' }
  | { readonly type: 'reset'; readonly detail: string }
  | { readonly type: 'fail'; readonly reason: HealthFailureReason; readonly detail: string }
  | { readonly type: 'listed'; readonly pendingReview: boolean; readonly toolsDiscovered: number; readonly detail?: string }
  | { readonly type: 'approve'; readonly toolsDiscovered: number; readonly detail?: string };

export const healthTable: MachineTable<ConnectionHealth, HealthEvent> = {
  id: 'mcp.health', initial: 'configured', final: [],
  on: {
    configured: { connect: ['connecting'], reset: ['configured'] },
    connecting: { listed: ['connected', 'healthy'], fail: ['failed'], reset: ['configured'] },
    connected: { connect: ['connecting'], approve: ['healthy'], fail: ['failed'], reset: ['configured'] },
    healthy: { connect: ['connecting'], approve: ['healthy'], fail: ['failed'], reset: ['configured'] },
    failed: { connect: ['connecting'], fail: ['failed'], reset: ['configured'] },
  },
};

export const healthMachine = defineMachine(healthTable, (state, event): ConnectionHealth => {
  if (!canMove(healthTable, state.kind, event.type)) return state;
  switch (event.type) {
    case 'connect': return { kind: 'connecting' };
    case 'reset': return { kind: 'configured', detail: event.detail };
    case 'fail': return { kind: 'failed', reason: event.reason, detail: event.detail };
    case 'listed':
    case 'approve':
      return {
        kind: event.type === 'listed' && event.pendingReview ? 'connected' : 'healthy',
        pendingReview: event.type === 'listed' && event.pendingReview,
        toolsDiscovered: event.toolsDiscovered,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      };
    default: return assertNever(event);
  }
});
