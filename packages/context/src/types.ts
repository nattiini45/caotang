/**
 * The shapes context assembly reads and returns — [context-assembly.md](../../../docs/architecture/context-assembly.md)
 * §2–§5.
 *
 * The inputs are the store's project state, the codex mention cache, the bus's activity
 * rows and the gateway's chat message. Each is imported rather than redefined, so a
 * change to any of them is a type error here and not a silent drift.
 */

import type { ActivityEntry } from '@caotang/bus';
import type { MentionIndex } from '@caotang/codex';
import type { ChatMessage } from '@caotang/gateway';
import type { ProjectState } from '@caotang/store';

/** §2's fixed layer order. Rendering and the prompt preview both follow it. */
export const LAYER_IDS = ['L0', 'LI', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] as const;
export type LayerId = (typeof LAYER_IDS)[number];

/** The name each layer carries in the prompt's headings and in the preview. */
export const LAYER_NAMES: Readonly<Record<LayerId, string>> = {
  L0: 'System',
  LI: 'Instructions',
  L1: 'Project',
  L2: 'Codex',
  L3: 'Structure',
  L4: 'Story so far',
  L5: 'Focus',
  L6: 'Recent turns',
  L7: 'Task',
};

/**
 * The tools with a context profile (§3). Every other tool assembles as `meta`. `dialogue.draft`'s focus is a dialogue container, not a
 * document (dialogue-narrative.md §7): its L4 is the container's prior beats and its L2 the codex of its speakers. `delegate` is a
 * delegated agent's call (agent-harness.md §2): a fresh context with no L6, whose L3 to L5 are built from the `scope` it was given.
 */
export type AssemblyTool = 'scene.draft' | 'continuity.scan' | 'synopsis.fill' | 'dialogue.draft' | 'delegate' | 'meta';

/** scene.draft's text modes (agent-harness.md §3, row 8). */
export type DraftMode = 'draft' | 'continue' | 'rewrite_selection';

/** A selection as the editor captured it: body-projection offsets and the text found there. */
export interface SelectionSpan {
  readonly from: number;
  readonly to: number;
  readonly exact: string;
}

/** One model call's task: the tool, its instruction and parameters, and what it is about. */
export interface AgentTask {
  readonly tool: AssemblyTool;
  /** L7's instruction. Sent verbatim. */
  readonly instruction: string;
  /** L7's compact tool parameters. Serialised with sorted keys, so their order never matters. */
  readonly params?: Readonly<Record<string, unknown>>;
  /** The focus's node id: a document for `scene.draft` and `synopsis.fill`, a dialogue container for `dialogue.draft`. Required for those. */
  readonly focus?: string;
  /** scene.draft only. Defaults to `draft`. */
  readonly mode?: DraftMode;
  /** Required for `rewrite_selection`. */
  readonly selection?: SelectionSpan;
  /** continuity.scan: the scope's document ids. Default: every manuscript document. `delegate`: the same, and default none. */
  readonly scope?: readonly string[];
  /** §4's per-call opt-in: include the synopses of later scenes. Default false. */
  readonly includeForwardOutline?: boolean;
  /** §7's retry rung: halves the L2 and L4 budgets. */
  readonly compact?: boolean;
}

/** One tool of the registry, as the system prompt lists it. */
export interface ToolSignature {
  readonly name: string;
  /** One line, for example `scene.draft(doc, instruction, mode?)`. */
  readonly signature: string;
}

/** A past agent turn, oldest first. Its outcome and undo group come from the activity rows, else from the fields below. */
export interface RecentTurn {
  readonly turnId: string;
  /** The instruction the writer gave for the turn. */
  readonly intent: string;
  /** The turn's outcome in one line, for when its activity rows are gone (a reload) or it wrote none (a reply). */
  readonly outcome?: string;
  /** The turn's undo group, for the same cases. */
  readonly undoGroupId?: string;
  /** Epoch ms of the writer's restore of the turn's project changes, with the conversation kept. L6 says so in the outcome line. */
  readonly restoredAt?: number;
  /** With `restoredAt`: the 1-based step the restore began at, when the restore took back that step and the later ones only. */
  readonly restoredFromStep?: number;
  /** The writer rewound the conversation past this turn: L6 leaves it out before the turn limit applies. */
  readonly rewound?: boolean;
  /** A turn the planner is never told of (a macro run): L6 leaves it out, intent and outcome both, before the turn limit applies. */
  readonly hidden?: boolean;
}

/** The app state assembly reads. Assembly never writes any of it. */
export interface AppSnapshot {
  readonly state: ProjectState;
  /** The tool surface for L0. Absent renders as "no tools in this call". */
  readonly tools?: readonly ToolSignature[];
  /** Today's writing progress for L1 (goals-progress.md §2.1). Absent renders as unavailable. */
  readonly session?: { readonly todayWords: number; readonly target?: number };
  /** The codex mention cache. Used for continuity.scan's scope bodies when present. */
  readonly mentions?: MentionIndex;
  /** Agent turns, oldest first. L6 keeps the last two. */
  readonly turns?: readonly RecentTurn[];
  /** Activity rows, for the turns' outcome and undo-group lines. */
  readonly activity?: readonly ActivityEntry[];
  /**
   * Binder nodes a read-deny keeps out of the prompt (agent-harness §4). Assembly works on a view of the project without them and
   * lists each in the preview as withheld; see `withhold`.
   */
  readonly withheld?: ReadonlySet<string>;
  /**
   * The writer's instructions for layer LI: `CAOTANG.md`, or the `AGENTS.md` it falls back to. Absent means the project's own
   * (`state.agentFiles.instructions`), which is what the app and the MCP server both send.
   */
  readonly instructions?: { readonly source: 'CAOTANG.md' | 'AGENTS.md'; readonly text: string };
  /** The memory index for layer LI (`memory/MEMORY.md`). Absent means the project's own (`state.agentFiles.index`). */
  readonly memoryIndex?: string;
}

/** A model's limits and prices, as the gateway's profile and `listModels` report them. */
export interface ModelLimits {
  readonly contextWindow?: number;
  /** Display-only (provider-gateway §6, D4): the preview's cost estimate, nothing more. */
  readonly pricePer1k?: { readonly prompt: number; readonly completion: number };
  /** The tool's default output cap. The completion estimate on the plan card uses it. */
  readonly maxOutputTokens?: number;
  /** What one call may spend on thinking at the level the caller asked for; the completion estimate adds it to the cap. */
  readonly thinkingTokens?: number;
}

export interface ContextConfig {
  /** Total prompt budget in tokens. Default: 12,000 for scene.draft (§3), see profiles.ts. */
  readonly contextBudget?: number;
  /** Overrides for the base layer budgets, in tokens. Layers with no budget ignore them. */
  readonly layerBudgets?: Readonly<Partial<Record<LayerId, number>>>;
  /** L5's nominal tail, in characters. Default 3,000. */
  readonly continuationChars?: number;
  /**
   * Let the focus text take the budget that L3 and L4 passed up (context-assembly §3). Off by
   * default: the continue tail is `continuationChars` and the rewrite antecedent is 1,500
   * characters, and flowed-in budget only raises the layer's cap. On, each unused token adds
   * four characters to both, up to the cap.
   */
  readonly focusFlowUp?: boolean;
  /** When an object, L0 carries the JSON protocol line (provider-gateway §5). */
  readonly responseFormat?: 'text' | { readonly jsonSchemaHint: object };
  readonly model?: ModelLimits;
  /** How a restore time is written in L6 (`HH:MM`). Default: UTC, so a golden does not depend on the machine's zone. */
  readonly formatTime?: (epochMs: number) => string;
}

/**
 * Why an item is not in the prompt. The taxonomy names the budget that dropped an item
 * (D8 in context-assembly.md §8), so the preview can say which limit was reached.
 */
export type DropReason =
  /** The codex entry's policy is `never`. Listed only when the entry was mentioned. */
  | { readonly kind: 'never' }
  /** The entry matched, but its description is blank (codex.md §2). */
  | { readonly kind: 'empty-description' }
  /** A `manual` entry that was mentioned but is not attached to the focus scope. */
  | { readonly kind: 'manual-unattached' }
  /** A later scene's synopsis, withheld because `includeForwardOutline` is off (§4). */
  | { readonly kind: 'forward-outline' }
  /** A continuity scope longer than the document limit. */
  | { readonly kind: 'scope-limit'; readonly limit: number }
  /** A read rule keeps this item from the agent (agent-harness §4), so it is not in the prompt. Listed for the writer only. */
  | { readonly kind: 'withheld' }
  /** The layer's own budget was full. `budget` is the effective budget in tokens. */
  | { readonly kind: 'budget'; readonly layer: LayerId; readonly budget: number; readonly rank: number }
  /** The whole prompt was over `contextBudget`, and this item was in the prune order (§2). */
  | { readonly kind: 'total-budget'; readonly layer: LayerId; readonly total: number; readonly rank: number }
  /** LI was over its cap: it sent whole lines up to it, and the first `sentTokens` of `totalTokens` reached the model. */
  | { readonly kind: 'instructions-cap'; readonly file: string; readonly sentTokens: number; readonly totalTokens: number }
  /** The codex's `always` entries alone need more than the layer's budget; they are sent whole. */
  | { readonly kind: 'reserve-overflow'; readonly layer: LayerId; readonly need: number; readonly budget: number };

export interface DropRecord {
  /** The entry's name or the document's title, or a summary label. */
  readonly label: string;
  readonly reason: DropReason;
  /** The line the preview shows, from `describeDrop`. */
  readonly text: string;
  /** Which kind of entry the record is about, so the preview can separate older scenes. */
  readonly group?: string;
}

/** One kept entry and why it is in the prompt. */
export interface LayerItemReport {
  readonly label: string;
  readonly reason: string;
  readonly tokens: number;
}

export interface LayerReport {
  readonly id: LayerId;
  readonly name: string;
  readonly included: boolean;
  /** The layer's base budget in tokens, before any flow-up. Absent for L0 and L7, which have no cap. */
  readonly baseBudget?: number;
  /** The effective budget in tokens, after flow-up. The cap the layer was held to. */
  readonly budget?: number;
  /** The layer's estimate, on the text it contributes to the prompt. */
  readonly tokens: number;
  readonly kept: readonly LayerItemReport[];
  /** One line per dropped item: `label: reason`. */
  readonly dropped: readonly string[];
  readonly drops: readonly DropRecord[];
  readonly notes: readonly string[];
}

/** The focus document, as far as the preview needs it. */
export interface FocusReport {
  readonly doc: string;
  readonly title: string;
  readonly mode: DraftMode | 'full';
  /** Characters of the document's text that were sent. Zero when only the stand-in was. */
  readonly chars: number;
  /** The first characters of the text sent (§5 shows 120). */
  readonly head: string;
  /** The document's full length in characters. */
  readonly documentChars: number;
}

export interface AssembledPrompt {
  readonly tool: AssemblyTool;
  /** The wire shape for `ProviderGateway.complete`: a system message, then one user message. */
  readonly messages: readonly ChatMessage[];
  /** Every layer, L0 to L7, in order. */
  readonly layers: readonly LayerReport[];
  readonly estimate: {
    readonly promptTokens: number;
    readonly byLayer: Readonly<Record<LayerId, number>>;
  };
  /** The total prompt budget the assembly was held to, in tokens. */
  readonly totalBudget: number;
  /** True when even dropping every droppable entry leaves the prompt over `totalBudget`. */
  readonly overBudget: boolean;
  readonly focus?: FocusReport;
  /** A copy of the model limits the assembly was run with, so the preview needs nothing else. */
  readonly model: ModelLimits;
}

/** One item a layer dropped, as the preview shows it: the line, and the reason in structure. */
export interface PreviewDrop {
  readonly label: string;
  /** The line from `describeDrop`: it names the budget that dropped the item (D8). */
  readonly text: string;
  readonly reason: DropReason;
}

export interface PreviewLayer {
  readonly id: LayerId;
  readonly name: string;
  readonly included: boolean;
  readonly tokens: number;
  readonly budget?: number;
  /** tokens ÷ budget, for a budgeted layer that is included. */
  readonly fraction?: number;
  /** Every item the layer dropped, whatever the layer: suppressions first, then budget cuts. */
  readonly drops: readonly PreviewDrop[];
  /** The layer's own notes: what was cut, and that it was cut. */
  readonly notes: readonly string[];
}

export interface PromptPreview {
  /** The execution payload. The same messages `toChatMessages` returns, byte for byte. */
  readonly payload: ChatMessage[];
  readonly promptTokens: number;
  /** The completion estimate: the model's `maxOutputTokens`, or the 4,096 default. */
  readonly completionTokens: number;
  readonly layers: readonly PreviewLayer[];
  readonly codex: {
    readonly included: readonly { readonly name: string; readonly reason: string }[];
    readonly dropped: readonly { readonly name: string; readonly reason: string }[];
  };
  readonly storySoFar: {
    readonly included: readonly string[];
    /** Older synopses that a budget dropped. Later scenes withheld by policy are not counted. */
    readonly omittedOlder: number;
  };
  readonly focus?: { readonly head: string; readonly summary: string };
  readonly window?: { readonly contextWindow: number; readonly warning?: string };
  /** Display-only estimate from `pricePer1k` (provider-gateway §6). */
  readonly cost?: {
    readonly promptUsd: number;
    readonly completionUsd: number;
    readonly totalUsd: number;
    /** The reply side counts the thinking a set level can spend as well as the output cap; the card says "including thinking". */
    readonly includesThinking?: true;
  };
}
