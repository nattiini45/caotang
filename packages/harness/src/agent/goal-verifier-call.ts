import { tokensForChars } from '@caotang/context';
import { usageFor, type ChatRequest, type Gateway, type Usage } from '@caotang/gateway';

import { anySignal, type BudgetMeter, type BudgetSpend, type BudgetStop, type Reservation } from './budget.js';
import { GOAL_VERIFIER_REPLY_CHARS_MAX } from './goal-verifier.js';
import { transmittedOutputCap } from './output-cap.js';

export interface GoalVerifierAdmission {
  readonly phase: 'reserved' | 'settled' | 'released';
  readonly spend: BudgetSpend;
  readonly reservation?: Reservation;
}

export type GoalVerifierCallResult =
  | { readonly kind: 'complete'; readonly content: string }
  | { readonly kind: 'budget'; readonly stop: BudgetStop }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface GoalVerifierCallOptions {
  readonly gateway: Gateway;
  readonly request: ChatRequest;
  readonly meter: BudgetMeter;
  readonly signal?: AbortSignal;
  readonly fence: () => void;
  readonly save: (admission: GoalVerifierAdmission) => Promise<void>;
}

export class GoalVerifierPersistenceError extends Error {
  constructor(phase: 'reservation' | 'settlement') {
    super(phase === 'reservation'
      ? 'The verifier reservation could not be saved, so its request was not sent.'
      : 'The verifier settlement could not be saved, so the goal cannot continue.');
    this.name = 'GoalVerifierPersistenceError';
  }
}

export async function runGoalVerifierCall(options: GoalVerifierCallOptions): Promise<GoalVerifierCallResult> {
  const { gateway, meter, request } = options;
  if (request.messages.length !== 2 || request.messages[0]?.role !== 'system' || request.messages[1]?.role !== 'user' || request.tools !== undefined || request.toolChoice !== undefined) {
    throw new Error('The verifier requires an isolated system and user request without tools.');
  }
  const stopped = meter.stopped();
  if (stopped !== undefined) return { kind: 'budget', stop: stopped };
  const signal = anySignal([meter.signal, ...(options.signal === undefined ? [] : [options.signal])]);
  if (signal.aborted) return { kind: 'cancelled' };
  const asked: ChatRequest = { ...request, role: 'background' };
  const limits = gateway.modelLimits(asked.profileId, asked.model, asked.thinking, asked);
  const reserved = meter.reserve({
    promptTokens: usageFor(asked.messages, '').promptTokens,
    maxOutputTokens: transmittedOutputCap(limits, asked.maxOutputTokens),
    ...(limits.pricePer1k === undefined ? {} : { price: limits.pricePer1k }),
  });
  if (!reserved.ok) return { kind: 'budget', stop: reserved.error };
  const reservation = reserved.value;
  try {
    await options.save({ phase: 'reserved', reservation, spend: meter.spend() });
  } catch {
    meter.release(reservation);
    throw new GoalVerifierPersistenceError('reservation');
  }

  let sent = false;
  let completed = false;
  let failed = false;
  let content = '';
  let completionChars = 0;
  let usage: Usage | undefined;
  let failureReason = 'The verifier request could not finish under the current route and read boundary.';
  try {
    signal.throwIfAborted();
    options.fence();
    for await (const chunk of gateway.complete(asked, signal, () => {
      signal.throwIfAborted();
      options.fence();
      sent = true;
    })) {
      completionChars += (chunk.delta?.length ?? 0) + (chunk.reasoningDelta?.length ?? 0);
      if (chunk.usage !== undefined) usage = chunk.usage;
      if (content.length + (chunk.delta?.length ?? 0) > GOAL_VERIFIER_REPLY_CHARS_MAX) {
        failureReason = 'The verifier reply exceeded its size limit, so no verdict was used.';
        throw new Error(failureReason);
      }
      content += chunk.delta ?? '';
      if (chunk.finishReason === 'error') failed = true;
    }
    completed = !failed && !signal.aborted;
  } catch {
    failed = true;
  }
  if (sent) {
    const reported = usage?.source === 'estimate' ? undefined : usage;
    const estimated = usage?.source === 'estimate' && Number.isFinite(usage.promptTokens) && usage.promptTokens >= 0 && Number.isFinite(usage.completionTokens) && usage.completionTokens >= 0 ? usage : undefined;
    meter.settle(reservation, reported, completed ? {
      promptTokens: Math.max(reservation.promptTokens, estimated?.promptTokens ?? 0),
      completionTokens: Math.max(tokensForChars(completionChars), estimated?.completionTokens ?? 0),
    } : undefined);
  } else {
    meter.release(reservation);
  }
  try {
    await options.save({ phase: sent ? 'settled' : 'released', spend: meter.spend() });
  } catch {
    throw new GoalVerifierPersistenceError('settlement');
  }
  const ended = meter.stopped();
  if (ended !== undefined) return { kind: 'budget', stop: ended };
  if (signal.aborted) return { kind: 'cancelled' };
  if (failed) return { kind: 'failed', reason: failureReason };
  return { kind: 'complete', content };
}
