import type { LlmCategory, ReviewExecutionPlan, ReviewPlan } from '@caotang/coherence';
import type { ContextOverrides, StepCost } from '@caotang/harness';
import type { ThinkingLevel } from '@caotang/gateway';

export interface QueuedReviewRoute {
  readonly profileId: string;
  readonly model: string;
  readonly thinking?: ThinkingLevel;
  readonly label: string;
}

export interface QueuedReviewCallBound {
  readonly extractCalls: number;
  readonly verifyCallsAtMost: number;
}

export interface QueuedReviewPreview {
  readonly id: string;
  readonly plan: ReviewPlan;
  readonly route: QueuedReviewRoute;
  readonly callBound: QueuedReviewCallBound;
  readonly cost: StepCost | undefined;
  readonly costUnknownReason: string | null;
  readonly scopeTitles: readonly string[];
  readonly exclusions: readonly string[];
}

export type QueuedReviewPrepared =
  | { readonly ok: true; readonly preview: QueuedReviewPreview }
  | { readonly ok: false; readonly reason: string };

export interface QueuedReviewApproval {
  readonly plan: ReviewExecutionPlan;
  readonly route: QueuedReviewRoute;
  readonly callBound: QueuedReviewCallBound;
  readonly scopeDocIds: readonly string[];
  readonly categories: readonly LlmCategory[];
  readonly maxFindings: number;
  readonly fingerprint: string;
  readonly contextOverrides?: ContextOverrides;
}

export const reviewCallCap = (bound: QueuedReviewCallBound): number => bound.extractCalls + bound.verifyCallsAtMost;

export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) freezeDeep((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
