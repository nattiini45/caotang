/**
 * The read half of every model call — context-assembly.md §2–§5, assembled by `@caotang/context`.
 *
 * The loop depends on a `ContextPort`, and the product's port is {@link createContextPort}: it runs
 * `@caotang/context`'s `assemble`, renders the request with `toChatMessages`, and builds the card's view
 * with `buildPreview`. Three things are the harness's own, and each is here for a reason the spec states:
 *
 * - **The role text is L0.** The system message of every call is the harness's text: the planner's reply
 *   protocol and the tool list it must follow, or a drafting call's role. The planner's replies and the
 *   mock scripts depend on that text (agent/protocol.ts), and the reply schema is part of the harness, not
 *   of the context package. So `assemble()` renders L1–L7 and this port replaces the system message with
 *   the role text, measuring L0 on the text that is sent. The preview is built from that replaced prompt,
 *   so the card and the request are still one value (context-assembly §5, "zero drift").
 * - **The turns are L6.** The session records each turn's intent and passes the earlier turns, with their
 *   activity rows, so the last two turns reach the next drafting call (context-assembly §2, L6).
 * - **The model's limits are the caller's.** The config carries the active model's window, output cap and
 *   price (context-assembly §5), filled from the gateway (provider-gateway §3). Nothing here guesses them.
 */

import type { ActivityEntry } from '@caotang/bus';
import {
  assemble,
  buildPreview,
  tokensForChars,
  toChatMessages,
  UNTRUSTED_RULE,
  type AgentTask,
  type AppSnapshot,
  type AssembledPrompt,
  type ContextConfig,
  type PreviewLayer,
  type PromptPreview,
  type RecentTurn,
} from '@caotang/context';
import type { ChatMessage } from '@caotang/gateway';
import type { ProjectState } from '@caotang/store';

/** One model call to assemble: its task, the role text that is its system message, and the history it may draw on. */
export interface ContextRequest {
  /** The call's tool, instruction, parameters and focus (context-assembly §2, L7 and L5). */
  readonly task: AgentTask;
  /** The harness's text for the system message (L0): the protocol and tool list, or a drafting role. */
  readonly role: string;
  /** The project to assemble from, when it is not the port's own: a view the caller made of it (synopsis.fill's `source`). */
  readonly state?: ProjectState;
  /** The turns before this one, oldest first. L6 keeps the last two (context-assembly §2). */
  readonly turns?: readonly RecentTurn[];
  /** The activity rows of those turns, which give L6 its outcome lines. */
  readonly activity?: readonly ActivityEntry[];
  /** The id of the call's untrusted envelopes: the turn's (`nonceFor`). Absent, the fixed one (context `untrusted.ts`). */
  readonly nonce?: string;
}

/** One model call, assembled: what it sends, and what the card shows of it. */
export interface AssembledCall {
  /** The assembly, with the role text as its system message. What `messages` and `preview` describe. */
  readonly prompt: AssembledPrompt;
  /** The wire messages: the role text, then the assembled user message. */
  readonly messages: readonly ChatMessage[];
  /** The card's view of the prompt (context-assembly §5): each layer against its budget, and every drop with its reason. */
  readonly preview: PromptPreview;
}

/** The seam the agent loop depends on. Pure: the same request and state give the same bytes. */
export interface ContextPort {
  assemble(request: ContextRequest): AssembledCall;
}

export interface ContextPortOptions {
  /** The project to assemble from: a state, or a function that reads the current state at each call. */
  readonly state: ProjectState | (() => ProjectState);
  /**
   * Budgets, the total, and the model's limits (context-assembly §3, §5). Absent means the spec's defaults. A
   * function is read at each call, as the state is, so the limits follow the active model as it changes.
   */
  readonly config?: ContextConfig | (() => ContextConfig);
  /**
   * The binder nodes a read-deny keeps out of a call's prompt, by the tool the call is for (agent-harness §4, "Rules"). Read at each
   * call. Absent, nothing is withheld.
   */
  readonly withheld?: (tool: string) => ReadonlySet<string>;
}

/**
 * The assembled prompt with `role` as its system message. The L0 layer and the prompt estimate are
 * re-measured on the text that is sent, so the report describes the request. `assemble` always renders
 * its system message first, so the rest of the messages are the user message.
 */
export function withRole(prompt: AssembledPrompt, role: string): AssembledPrompt {
  // A call whose user message carries an envelope (layer LI) is told what the markers mean, whatever its role text is (system prompt v2).
  const enveloped = prompt.layers.some((layer) => layer.id === 'LI' && layer.included);
  const sent = enveloped && !role.includes(UNTRUSTED_RULE) ? `${role}\n\n${UNTRUSTED_RULE}` : role;
  const messages: ChatMessage[] = [{ role: 'system', content: sent }, ...prompt.messages.slice(1)];
  const roleTokens = tokensForChars(sent.length);
  const layers = prompt.layers.map((layer) => (layer.id === 'L0' ? { ...layer, tokens: roleTokens } : layer));
  const promptTokens = tokensForChars(messages.reduce((sum, message) => sum + message.content.length, 0));
  return {
    ...prompt,
    messages,
    layers,
    estimate: { promptTokens, byLayer: { ...prompt.estimate.byLayer, L0: roleTokens } },
  };
}

/**
 * What the model was not sent, layer by layer in §2's order: each drop, then each note a layer makes about a
 * cut it made (a clipped tail, a cut document). This is the turn's record of the prompt, so a read that has no
 * card still says what it did not see.
 */
export function dropLinesOf(prompt: AssembledPrompt): string[] {
  return prompt.layers.flatMap((layer) => [...layer.dropped, ...layer.notes.map((note) => `${layer.name}: ${note}`)]);
}

/**
 * The product's `ContextPort`: `@caotang/context` assembles each call, and the role text is its L0.
 *
 * A state given as a function is read at each call, so a session on a live project sees the project as
 * it is when the call is made, and not as it was when the session was created.
 */
export function createContextPort(options: ContextPortOptions): ContextPort {
  const source = options.state;
  const stateOf: () => ProjectState = typeof source === 'function' ? source : () => source;
  const given = options.config;
  const configOf: () => ContextConfig = typeof given === 'function' ? given : () => given ?? {};
  return {
    assemble(request: ContextRequest): AssembledCall {
      const withheld = options.withheld?.(request.task.tool);
      const app: AppSnapshot = {
        state: request.state ?? stateOf(),
        ...(withheld === undefined || withheld.size === 0 ? {} : { withheld }),
        ...(request.turns === undefined ? {} : { turns: request.turns }),
        ...(request.activity === undefined ? {} : { activity: request.activity }),
        ...(request.nonce === undefined ? {} : { nonce: request.nonce }),
      };
      const prompt = withRole(assemble(request.task, app, configOf()), request.role);
      return { prompt, messages: toChatMessages(prompt), preview: buildPreview(prompt) };
    },
  };
}

/**
 * Several calls shown as one card entry. The synopsis batch is one call per document (drafting.ts), and the
 * card shows what the whole batch sends: tokens and drops summed, the messages of each call in order.
 * `undefined` for no calls. A single call is returned as it is.
 */
export function mergePreviews(previews: readonly PromptPreview[]): PromptPreview | undefined {
  const [first] = previews;
  if (first === undefined) return undefined;
  if (previews.length === 1) return first;

  const layers = new Map<string, PreviewLayer>();
  for (const preview of previews) {
    for (const layer of preview.layers) {
      const prior = layers.get(layer.id);
      if (prior === undefined) {
        layers.set(layer.id, { ...layer, fraction: undefined, drops: [...layer.drops], notes: [...layer.notes] });
      } else {
        layers.set(layer.id, {
          ...prior,
          included: prior.included || layer.included,
          tokens: prior.tokens + layer.tokens,
          fraction: undefined,
          drops: [...prior.drops, ...layer.drops],
          notes: [...prior.notes, ...layer.notes],
        });
      }
    }
  }

  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  const costs = previews.map((preview) => preview.cost);
  const cost =
    costs.every((item) => item !== undefined)
      ? {
          promptUsd: sum(costs.map((item) => item?.promptUsd ?? 0)),
          completionUsd: sum(costs.map((item) => item?.completionUsd ?? 0)),
          totalUsd: sum(costs.map((item) => item?.totalUsd ?? 0)),
          ...(costs.some((item) => item?.includesThinking === true) ? { includesThinking: true as const } : {}),
        }
      : undefined;

  return {
    payload: previews.flatMap((preview) => preview.payload),
    promptTokens: sum(previews.map((preview) => preview.promptTokens)),
    completionTokens: sum(previews.map((preview) => preview.completionTokens)),
    layers: [...layers.values()],
    codex: {
      included: previews.flatMap((preview) => preview.codex.included),
      dropped: previews.flatMap((preview) => preview.codex.dropped),
    },
    storySoFar: {
      included: previews.flatMap((preview) => preview.storySoFar.included),
      omittedOlder: sum(previews.map((preview) => preview.storySoFar.omittedOlder)),
    },
    ...(first.window === undefined ? {} : { window: first.window }),
    ...(cost === undefined ? {} : { cost }),
  };
}
