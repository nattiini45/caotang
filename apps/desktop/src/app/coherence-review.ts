/**
 * The model-backed coherence review, run from the Findings tab (coherence.md §5.3, §7 tool 16).
 *
 * The engine (`@caotang/coherence`) plans a review and runs an approved plan, and it takes its model through a port. This module
 * is the app's side of that: the port over the provider gateway, the context the review reads (the codex entries and the story
 * so far, in the budgets the engine sets), and the two steps the writer sees. Planning is pure and free. Running is the model
 * calls, and it happens only after the writer approves the plan the Findings tab shows, with its cost estimate and its prompt.
 *
 * Nothing here writes the manuscript. A run changes the findings file only, and the caller saves it.
 */

import {
  estimateTokens,
  planReview,
  runReview,
  type CoherenceFile,
  type CoherenceModel,
  type ContextBlock,
  type LlmCategory,
  type ModelReply,
  type ModelRequest,
  type ReviewContext,
  type ReviewPlan,
  type ReviewRunResult,
  type ScopeSpec,
} from '@caotang/coherence';
import { detect, selectCandidates } from '@caotang/codex';
import { type ProfileView, type ProviderGateway, type TaskRole, type ThinkingLevel } from '@caotang/gateway';
import { reviewCostAt, type ReviewLimitsSource, type StepCost } from '@caotang/harness';
import { getBody, type ProjectState, type TreeNode } from '@caotang/store';

/** The manuscript's documents in binder order, the order the story-so-far layer reads them in. */
function manuscriptDocuments(state: ProjectState): TreeNode[] {
  const byParent = new Map<string, TreeNode[]>();
  for (const node of state.manifest.tree) {
    if (node.parentId === null) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: TreeNode[] = [];
  const walk = (parentId: string): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (child.type === 'document' && child.status !== 'archived') out.push(child);
      walk(child.id);
    }
  };
  walk('manuscript');
  return out;
}

/** The first words of a document, when it has no synopsis, so the story-so-far block says what the scene is about. */
function gist(state: ProjectState, node: TreeNode): string {
  if (node.synopsis.trim() !== '') return node.synopsis.trim();
  return getBody(state, node.id).trim().slice(0, 160);
}

/**
 * The codex entries one document's review may send (codex.md §5 and §6, the L2 layer): the candidates the include-policy rule
 * selects for this document, in codex order. A `never` entry is never sent. A `manual` entry is sent only when it is attached
 * to the document or an ancestor folder. A `detected` entry is sent only when its name or alias is in the document's text, which
 * is the same scan `continuity.scan` makes (codex.md §4 rule 6). An empty description is dropped (codex.md §2).
 */
function codexBlocksOf(state: ProjectState, docId: string): ContextBlock[] {
  const entries = state.manifest.codex ?? [];
  const detected = detect([{ id: docId, text: getBody(state, docId) }], entries);
  const { candidates } = selectCandidates({ entries, tree: state.manifest.tree, focusDocId: docId, detected });
  return candidates.map(({ entry }) => ({ key: entry.name, text: `${entry.name} (${entry.type}): ${entry.description}` }));
}

/**
 * The context a review reads: the codex for one document (the L2 layer, selected as the context assembly selects it), and the
 * story so far as one block per earlier document (the L4 layer). The engine fits both to its budgets and names what it left out
 * on the plan card.
 */
export function reviewContextOf(state: ProjectState): ReviewContext {
  const documents = manuscriptDocuments(state);
  return {
    codex: (docId: string) => codexBlocksOf(state, docId),
    storySoFar: (docId: string) => {
      const index = documents.findIndex((node) => node.id === docId);
      if (index <= 0) return [];
      return documents.slice(0, index).map((node) => ({ key: node.title, text: `${node.title}: ${gist(state, node)}` }));
    },
  };
}

/**
 * The provider gateway as the engine's model port. The reply is the model's text; the token counts are the engine's own estimate
 * (`ceil(chars/4)`, context-assembly §3), because a one-shot reply carries no usage. The run says so in its notes.
 */
export function gatewayCoherenceModel(
  gateway: ProviderGateway,
  profile: ProfileView,
  defaults?: { readonly model?: string; readonly thinking?: ThinkingLevel },
): CoherenceModel {
  return {
    model: defaults?.model ?? profile.defaultModel,
    async complete(request: ModelRequest): Promise<ModelReply> {
      const message = await gateway.completeOnce(
        {
          profileId: profile.id,
          // The review is a 'chat'-role task (provider-gateway §6): the role rides the ledger row, while the
          // profile stays pinned to the one the caller resolved.
          role: 'chat',
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          responseFormat: { jsonSchemaHint: request.jsonSchemaHint },
          temperature: 0,
          ...(defaults?.model === undefined ? {} : { model: defaults.model }),
          ...(defaults?.thinking === undefined ? {} : { thinking: defaults.thinking }),
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        },
        request.signal,
      );
      return {
        content: message.content,
        usage: {
          promptTokens: estimateTokens(request.system + request.user),
          completionTokens: estimateTokens(message.content),
        },
      };
    },
  };
}

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
