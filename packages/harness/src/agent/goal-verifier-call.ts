import { tokensForChars } from '@caotang/context';
import { usageFor, type ChatRequest, type Gateway, type ThinkingLevel, type Usage } from '@caotang/gateway';

import { canonicalJson } from '../util.js';
import { anySignal, type BudgetMeter, type BudgetSpend, type BudgetStop, type Reservation } from './budget.js';
import type { ContextPort, LanguagePolicy } from './context.js';
import type { GoalVerifierPort } from './goal-verification.js';
import { assembleGoalVerifierCall, GOAL_VERIFIER_REPLY_CHARS_MAX } from './goal-verifier.js';
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
  constructor(phase: 'reservation' | 'settlement' | 'iteration') {
    super(phase === 'iteration'
      ? 'The goal’s saved iteration could not be verified, so no verifier request was sent.'
      : phase === 'reservation'
      ? 'The verifier reservation could not be saved, so its request was not sent.'
      : 'The verifier settlement could not be saved, so the goal cannot continue.');
    this.name = 'GoalVerifierPersistenceError';
  }
}

export interface GoalVerifierModelOptions {
  readonly gateway: Gateway;
  readonly context: ContextPort;
  readonly meter: BudgetMeter;
  readonly route: () => { readonly profileId: string; readonly model: string; readonly thinking?: ThinkingLevel } | undefined;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly languages?: () => LanguagePolicy;
  readonly fence: () => void;
}

export function createGoalVerifierPort(options: GoalVerifierModelOptions): GoalVerifierPort {
  const resolveRoute = (): ReturnType<GoalVerifierModelOptions['route']> => {
    const route = options.route();
    return route === undefined ? undefined : { profileId: route.profileId, model: route.model, ...(route.thinking === undefined ? {} : { thinking: route.thinking }) };
  };
  return async (input, save, liveFence) => {
    const route = resolveRoute();
    if (route === undefined) return { kind: 'failed', reason: 'Choose a Background provider before using independent verification.' };
    const profile = options.gateway.profiles.get(route.profileId);
    if (profile === undefined) return { kind: 'failed', reason: 'The Background provider is no longer available.' };
    const routeKey = canonicalJson({ route, kind: profile.kind, preset: profile.preset, baseUrl: profile.baseUrl, fields: profile.fields });
    const call = assembleGoalVerifierCall(input, options.context, options.languages?.());
    const limits = options.gateway.modelLimits(route.profileId, route.model, route.thinking, { role: 'background' });
    return runGoalVerifierCall({
      gateway: options.gateway, meter: options.meter, save,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      request: {
        ...route, messages: [...call.messages], sessionId: options.sessionId, turnId: options.turnId, role: 'background', temperature: 0,
        maxOutputTokens: Math.min(limits.maxOutputTokens, 2048),
      },
      fence: () => {
        const currentRoute = resolveRoute();
        const currentProfile = currentRoute === undefined ? undefined : options.gateway.profiles.get(currentRoute.profileId);
        if (currentProfile === undefined || canonicalJson({ route: currentRoute, kind: currentProfile.kind, preset: currentProfile.preset, baseUrl: currentProfile.baseUrl, fields: currentProfile.fields }) !== routeKey) {
          throw new Error('The Background route changed before verification could be sent.');
        }
        options.fence();
        liveFence();
      },
    });
  };
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
  const asked: ChatRequest = { ...structuredClone(request), role: 'background' };
  const limits = gateway.modelLimits(asked.profileId, asked.model, asked.thinking, asked);
  const reserved = meter.reserve({
    promptTokens: usageFor(asked.messages, '').promptTokens,
    maxOutputTokens: transmittedOutputCap(limits, asked.maxOutputTokens),
    ...(limits.pricePer1k === undefined ? {} : { price: limits.pricePer1k }),
  });
  if (!reserved.ok) return { kind: 'budget', stop: reserved.error };
  const reservation = reserved.value;
  const fence = (): void => {
    signal.throwIfAborted();
    const current = gateway.modelLimits(asked.profileId, asked.model, asked.thinking, asked);
    if (transmittedOutputCap(current, asked.maxOutputTokens) !== reservation.maxOutputTokens || canonicalJson(current.pricePer1k) !== canonicalJson(limits.pricePer1k)) {
      throw new Error('The verifier route limits changed after admission.');
    }
    options.fence();
  };
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
  let reasoningChars = 0;
  let terminalReasoningChars = 0;
  let terminal = false;
  let persistenceFailure: GoalVerifierPersistenceError | undefined;
  let usage: Usage | undefined;
  let failureReason = 'The verifier request could not finish under the current route and read boundary.';
  try {
    fence();
    for await (const chunk of gateway.complete(asked, signal, () => {
      fence();
      sent = true;
    })) {
      completionChars += chunk.delta?.length ?? 0;
      reasoningChars += chunk.reasoningDelta?.length ?? 0;
      terminalReasoningChars = Math.max(terminalReasoningChars, chunk.reasoning?.reduce((total, block) => total + block.text.length, 0) ?? 0);
      if (chunk.usage !== undefined) usage = chunk.usage;
      if (content.length + (chunk.delta?.length ?? 0) > GOAL_VERIFIER_REPLY_CHARS_MAX) {
        failureReason = 'The verifier reply exceeded its size limit, so no verdict was used.';
        throw new Error(failureReason);
      }
      content += chunk.delta ?? '';
      if (chunk.finishReason !== undefined) {
        terminal = chunk.finishReason === 'stop';
        if (!terminal) failed = true;
      }
      if ((chunk.toolCalls?.length ?? 0) > 0) failed = true;
    }
    if (!terminal) failed = true;
    completed = terminal && !failed && !signal.aborted;
  } catch (error) {
    failed = true;
    if (error instanceof GoalVerifierPersistenceError) persistenceFailure = error;
  }
  if (sent) {
    const reported = usage?.source === 'estimate' ? undefined : usage;
    const estimated = usage?.source === 'estimate' && Number.isFinite(usage.promptTokens) && usage.promptTokens >= 0 && Number.isFinite(usage.completionTokens) && usage.completionTokens >= 0 ? usage : undefined;
    meter.settle(reservation, reported, completed ? {
      promptTokens: Math.max(reservation.promptTokens, estimated?.promptTokens ?? 0),
      completionTokens: Math.max(tokensForChars(completionChars + Math.max(reasoningChars, terminalReasoningChars)), estimated?.completionTokens ?? 0),
    } : undefined);
  } else {
    meter.release(reservation);
  }
  try {
    await options.save({ phase: sent ? 'settled' : 'released', spend: meter.spend() });
  } catch {
    throw new GoalVerifierPersistenceError('settlement');
  }
  if (persistenceFailure !== undefined) throw persistenceFailure;
  const ended = meter.stopped();
  if (ended !== undefined) return { kind: 'budget', stop: ended };
  if (signal.aborted) return { kind: 'cancelled' };
  if (failed) return { kind: 'failed', reason: failureReason };
  return { kind: 'complete', content };
}
