import type { Clock } from './clock.js';
import { ProviderError } from './errors.js';
import type { GatewayTraceEvent } from './gateway.js';
import { redactDeep } from './redact.js';
import type { RequestLogEntry, RequestOutcome } from './request-log.js';
import type { StreamStats } from './transport.js';
import type { ChatChunk, ChatRequest, FinishReason, ProfileView, Usage } from './types.js';

const ZERO: Usage = { promptTokens: 0, completionTokens: 0 };

/**
 * The observer's view of one call (`GatewayOptions.observe`). Every event is scrubbed with the secrets known when it is told,
 * and a throwing observer is swallowed, so nothing here can change what the caller gets. `request` is told once the key
 * is revealed, so a call refused before that still reports a request, with nothing to scrub.
 */
export function startTrace(
  observe: (event: GatewayTraceEvent) => void,
  req: ChatRequest,
  profile: ProfileView,
  model: string,
  id: number,
  clock: Clock,
  iteratorAbandoned: symbol,
) {
  let secrets: readonly string[] = [];
  let requested = false;
  let first = false;
  let responded = false;
  let content = '';
  let reasoningText = '';
  let failure: { kind: string; message: string } | undefined;
  const tell = (event: GatewayTraceEvent): void => {
    try {
      observe(redactDeep(event, secrets));
    } catch {
      // display only: the call is the writer's, the trace is not
    }
  };
  const request = (revealed: readonly string[]): void => {
    if (requested) return;
    requested = true;
    secrets = revealed;
    const { expectedRoute: _approval, ...display } = req;
    tell({ type: 'request', id, req: display, profileId: profile.id, ...(profile.preset === undefined ? {} : { preset: profile.preset }), model, at: clock.now() });
  };
  const respond = (stats: StreamStats, terminal: ChatChunk | undefined, signal: AbortSignal | undefined): void => {
    if (responded) return;
    responded = true;
    request([]);
    const finishReason: FinishReason = terminal?.finishReason ?? 'error';
    const abandoned = signal?.aborted === true && signal.reason === iteratorAbandoned;
    const cancelled = signal?.aborted === true && !abandoned;
    if (profile.kind === 'mock') {
      const outcome: RequestOutcome = finishReason !== 'error' ? 'ok' : cancelled ? 'cancelled' : 'failed';
      tell({ type: 'attempt', id, attempt: 0, outcome, at: clock.now() });
    }
    if (failure === undefined && finishReason === 'error') {
      failure =
        cancelled
          ? { kind: 'cancelled', message: 'The call was stopped.' }
          : abandoned || terminal === undefined
            ? { kind: 'abandoned', message: 'The caller stopped reading before the reply finished.' }
            : { kind: 'error', message: 'The reply ended with an error.' };
    }
    tell({
      type: 'response',
      id,
      finishReason,
      content,
      reasoningText,
      ...(terminal?.reasoning === undefined ? {} : { reasoning: terminal.reasoning }),
      ...(terminal?.toolCalls === undefined ? {} : { toolCalls: terminal.toolCalls }),
      usage: terminal?.usage ?? stats.usage ?? ZERO,
      usageSource: stats.usageSource ?? 'estimate',
      attempts: stats.attempts,
      ...(failure === undefined ? {} : { error: failure }),
      at: clock.now(),
    });
  };
  return {
    request,
    attempt: (entry: RequestLogEntry): void =>
      tell({
        type: 'attempt',
        id,
        attempt: entry.attempt,
        outcome: entry.outcome,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        ...(entry.errorKind === undefined ? {} : { errorKind: entry.errorKind }),
        ...(entry.note === undefined ? {} : { note: entry.note }),
        at: entry.at,
      }),
    chunk: (chunk: ChatChunk, stats: StreamStats, signal: AbortSignal | undefined): void => {
      const text = (chunk.delta ?? '') + (chunk.reasoningDelta ?? '');
      if (!first && text !== '') {
        first = true;
        tell({ type: 'first-token', id, at: clock.now() });
      }
      content += chunk.delta ?? '';
      reasoningText += chunk.reasoningDelta ?? '';
      if (chunk.finishReason !== undefined) respond(stats, chunk, signal);
    },
    fail: (error: unknown): void => {
      failure = {
        kind: error instanceof ProviderError ? error.kind : error instanceof Error ? error.name : 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    },
    end: (stats: StreamStats, signal: AbortSignal | undefined): void => respond(stats, undefined, signal),
  };
}
