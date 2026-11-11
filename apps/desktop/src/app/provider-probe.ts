import { ProviderError } from '@caotang/gateway';
import { assertNever } from '@caotang/machine';

export interface ProbeFailure {
  readonly cause: 'auth' | 'models' | 'network' | 'timeout' | 'unreadable' | 'rate-limit' | 'provider' | 'unknown';
  readonly providerReply?: string;
  readonly guidance?: string;
}

export function probeFailureOf(error: unknown): ProbeFailure {
  if (!(error instanceof ProviderError)) return { cause: 'unknown' };
  let cause: ProbeFailure['cause'];
  switch (error.kind) {
    case 'auth': cause = 'auth'; break;
    case 'endpoint':
    case 'protocol': cause = 'models'; break;
    case 'network':
      cause = error.reason === 'timeout' ? 'timeout' : error.reason === 'model-list-unreadable' ? 'unreadable' : 'network';
      break;
    case 'rate_limit': cause = 'rate-limit'; break;
    case 'provider':
    case 'context_length': cause = 'provider'; break;
    default: return assertNever(error.kind);
  }
  return {
    cause,
    ...(error.providerReply === undefined ? {} : { providerReply: error.providerReply }),
    ...(error.kind === 'network' && error.permanent ? { guidance: error.message } : {}),
  };
}
