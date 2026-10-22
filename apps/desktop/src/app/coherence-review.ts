/**
 * The model-backed coherence review, run from the Findings tab (coherence.md §5.3, §7 tool 16).
 *
 * The engine (`@caotang/coherence`) plans a review and runs an approved plan, and it takes its model through a port. This module
 * is the app's side of that: the model that follows the writer's active provider and role, and the two steps the writer sees. The
 * port over the provider gateway and the context the review reads (the codex entries and the story so far, in the budgets the
 * engine sets) are the harness's, shared with the SDK. Planning is pure and free. Running is the model
 * calls, and it happens only after the writer approves the plan the Findings tab shows, with its cost estimate and its prompt.
 *
 * Nothing here writes the manuscript. A run changes the findings file only, and the caller saves it.
 */

import {
  planReview,
  runReview,
  type CoherenceFile,
  type CoherenceModel,
  type LlmCategory,
  type ReviewPlan,
  type ReviewRunResult,
  type ScopeSpec,
} from '@caotang/coherence';
import { type ProfileView, type ProviderGateway, type TaskRole, type ThinkingLevel } from '@caotang/gateway';
import { gatewayCoherenceModel, reviewContextOf, reviewCostAt, type ReviewLimitsSource, type StepCost } from '@caotang/harness';
import type { ProjectState } from '@caotang/store';

// The review's context and its model port moved to the harness, which wires them for the agent; the Findings tab uses the same ones.
export { gatewayCoherenceModel, reviewContextOf };

/**
 * The model a review runs through: the profile the 'chat' role resolves to — the active one unless the writer pinned
 * chat to another — read at each call so a change of provider or of role applies to the next review (provider-gateway
 * §2, §6). Undefined when no provider resolves, and then the agent's review is refused with the sentence that names it.
 */
export function activeCoherenceModel(providers: {
  readonly active: () => ProfileView | undefined;
  readonly gateway: ProviderGateway;
  /** The provider service's role resolution. A test double without it falls back to the active profile. */
  readonly resolveForRole?: (role: TaskRole) => { readonly profile: ProfileView; readonly model: string; readonly thinking?: ThinkingLevel } | undefined;
}): CoherenceModel | undefined {
  const resolved = providers.resolveForRole?.('chat');
  const profile = resolved?.profile ?? providers.active();
  return profile === undefined ? undefined : gatewayCoherenceModel(providers.gateway, profile, resolved);
}

/** What the writer chose for a review, from the Findings tab and the Settings section. */
export interface ReviewChoice {
  readonly scope: ScopeSpec;
  readonly categories?: readonly LlmCategory[];
  readonly maxFindings: number;
}

/** The plan the writer approves. Pure: nothing is sent to a model until {@link runCoherenceReview} is called with it. */
export function planCoherenceReview(state: ProjectState, file: CoherenceFile, choice: ReviewChoice): ReviewPlan {
  return planReview(state, file, {
    scope: choice.scope,
    ...(choice.categories === undefined ? {} : { categories: choice.categories }),
    maxFindings: choice.maxFindings,
  }, reviewContextOf(state));
}

/**
 * A review plan's cost in dollars for a profile, when its model has a price. Display only (provider-gateway §6): an estimate, never a
 * bill. This is the harness's own figure at the harness's own limits (`reviewCostAt`, which the agent's plan card shows for the same
 * review): the role's model when it pins one, else the profile's default — the one a review call under it is sent with. So the
 * Findings tab and the card cannot disagree.
 */
export function reviewCostFor(
  plan: ReviewPlan,
  gateway: ReviewLimitsSource,
  profileId: string,
  model?: string,
  thinking?: ThinkingLevel,
): number | undefined {
  return reviewCostDetailFor(plan, gateway, profileId, model, thinking)?.totalUsd;
}

/** The same figure with its parts, so the Findings tab can say when it counts the thinking the role's level asks for. */
export function reviewCostDetailFor(
  plan: ReviewPlan,
  gateway: ReviewLimitsSource,
  profileId: string,
  model?: string,
  thinking?: ThinkingLevel,
): StepCost | undefined {
  return reviewCostAt(plan, gateway, profileId, model, thinking);
}

/**
 * Runs an approved plan. The caller passes `approved: true` only after the writer pressed the plan's own button; the engine
 * refuses to run without it. The result carries the new findings file, which the caller hands to the session.
 */
export async function runCoherenceReview(input: {
  readonly state: ProjectState;
  readonly file: CoherenceFile;
  readonly plan: ReviewPlan;
  readonly model: CoherenceModel;
  readonly maxFindings: number;
  readonly signal?: AbortSignal;
  readonly now?: Date;
  /** The findings file as it stands now. The run is written into it when the model has answered, so a scan made meanwhile is kept. */
  readonly currentFile?: () => CoherenceFile;
}): Promise<ReviewRunResult> {
  return runReview(input.state, input.file, input.plan, {
    model: input.model,
    approved: true,
    now: input.now ?? new Date(),
    context: reviewContextOf(input.state),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.currentFile === undefined ? {} : { currentFile: input.currentFile }),
  });
}
