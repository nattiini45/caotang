/**
 * The app's settings, typed (ui-modules §5.1), with the clamps §5.2 states and the rule §5.1 gives for a stored value that
 * is missing or wrong: it loads to its default, field by field, and the rest of the record is kept.
 *
 * What is not here, and why:
 * - **Theme** stays in the browser's local storage (app/theme.ts). The page must choose its colours before its first paint,
 *   which happens before any database is open, and the theme specs read that key directly.
 * - **Provider profiles** are not settings. They live in the app database with their own store (providers.ts), because the
 *   gateway owns their validation and their identity. The active profile is mirrored here only for the record §5.1 names.
 * - **Coherence** (the checks a scan runs, the default scope, the cap on a review) and **MCP** are slices here, each read by its
 *   own section (ui-modules §5.2). **Context budgets** are here too (the `context` record), and the assembler honours the
 *   layers they name: the codex, the story so far and the continuity tail (context-assembly §3).
 */

import { DETERMINISTIC_CHECK_IDS, MAX_FINDINGS_CAP, MAX_FINDINGS_DEFAULT, type DeterministicCheckId } from '@caotang/coherence';
import type { ThinkingLevel } from '@caotang/gateway';
import { isPermissionMode, type ContextConfig, type PermissionMode } from '@caotang/harness';
import { numberFormat } from '@caotang/i18n';
import { DEFAULT_RETENTION, resolveRetentionConfig, type RetentionConfig } from '@caotang/store';
import { EMPTY_MCP_SETTINGS, loadMcpSettings, type McpSettings } from '@caotang/mcp-client';

import { formatterLocale } from '../i18n/format-locale.js';

/** The scopes a review or a scan can start with (coherence.md §6.2): one document, what changed since the last pass, the whole manuscript. */
export const REVIEW_SCOPES = ['doc', 'changed', 'full'] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

/**
 * The Coherence slice (ui-modules §5.2): which deterministic checks run, the scope the Findings tab starts with, and the cap on
 * findings one review may add. App-level, never a project file: a writer's choices about their checks belong to them, not to
 * the book (the same reason the MCP slice is here).
 */
export interface CoherenceSettings {
  /** The checks a scan runs, in registry order. Absent from storage reads as every check; an explicit empty list runs none. */
  readonly enabledChecks: readonly DeterministicCheckId[];
  readonly defaultReviewScope: ReviewScope;
  /** The most findings one review run may add (coherence.md §7 tool 16). */
  readonly maxFindings: number;
}

export const DEFAULT_COHERENCE_SETTINGS: CoherenceSettings = Object.freeze({
  enabledChecks: Object.freeze([...DETERMINISTIC_CHECK_IDS]) as readonly DeterministicCheckId[],
  defaultReviewScope: 'full',
  maxFindings: MAX_FINDINGS_DEFAULT,
});

/** The autosave debounce the writer may choose (ui-modules §5.2: 100–5000 ms). The spec's own default is 800. */
export const DEBOUNCE_MIN_MS = 100;
export const DEBOUNCE_MAX_MS = 5000;
export const DEFAULT_DEBOUNCE_MS = 800;

/** The daily session target's range (goals-progress §2.1: clamp 0–100,000; zero is "no target"). */
export const TARGET_MAX_WORDS = 100_000;

/** The checkpoint limits the Data section lets a writer change. A value outside them loads to the default. */
export const CHECKPOINT_CAP_MAX = 10_000;
export const CHECKPOINT_DAYS_MAX = 3650;

/**
 * The context budgets the Context section lets a writer change (context-assembly §3, ui-modules §5.1). The total is the prompt's
 * whole budget in tokens, and each layer budget is one layer's own cap. A value outside its range is clamped into it.
 */
export const CONTEXT_TOTAL_MIN = 4_000;
export const CONTEXT_TOTAL_MAX = 200_000;
export const CONTEXT_LAYER_MIN = 200;
export const CONTEXT_LAYER_MAX = 50_000;

/** The layers whose budgets the spec names as config-exposed: the codex (L2), the story so far (L4) and the continuity tail (L5). */
export const CONTEXT_LAYERS = ['L2', 'L4', 'L5'] as const;
export type ContextLayerId = (typeof CONTEXT_LAYERS)[number];

export interface ContextSettings {
  /** The total prompt budget in tokens. Absent means the profile's own default. */
  readonly totalBudgetTokens?: number;
  /** One layer's cap in tokens, for each layer the writer set. A layer absent here keeps its profile budget. */
  readonly layerBudgets: Readonly<Partial<Record<ContextLayerId, number>>>;
}

/**
 * The Agent slice (agent-harness §3). The planner declares a small core of tools and loads the rest on demand; `loadEveryTool`
 * declares every tool on every request instead, for a model that searches poorly. App settings only, never a project file.
 */
export interface AgentSettings {
  readonly loadEveryTool: boolean;
  /** The permission mode a session starts in (agent-harness §4). `auto` reads as `ask` while `lockAuto` is on. */
  readonly defaultMode: PermissionMode;
  /** Turns Auto mode off: the panel does not offer it and a stored `auto` reads as Ask. */
  readonly lockAuto: boolean;
  /** The limits a turn is held to. A limit left out keeps the harness's default, or is not enforced (agent-harness §4, §7.1). */
  readonly budget: AgentBudgetSettings;
}

/**
 * The writer's limits on their own key. Model calls, tokens, cost, steps and active time are run limits (agent-harness §7.1): held in
 * every mode, each model call's worst case reserved before it is sent. Words changed and documents touched are measured after a card
 * applies and are held only while Accept edits or Auto decides (§4). A tokens, cost or steps limit left empty is not a run limit; Accept
 * edits and Auto still hold a turn to the harness's default for tokens and steps.
 */
export interface AgentBudgetSettings {
  readonly maxModelCalls?: number;
  /** Minutes of work per turn, excluding the time a card waits for the writer. Default `DEFAULT_ACTIVE_MS`. */
  readonly maxActiveMinutes?: number;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxWordsChanged?: number;
  readonly maxDocuments?: number;
  readonly maxSteps?: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = Object.freeze({ loadEveryTool: false, defaultMode: 'ask', lockAuto: false, budget: Object.freeze({}) });

/** The whole numbers a budget field may hold. A field outside them reads as unset. */
export const AGENT_BUDGET_RANGES = {
  maxModelCalls: [1, 100],
  maxActiveMinutes: [1, 1_440],
  maxTokens: [1_000, 10_000_000],
  maxWordsChanged: [1, 1_000_000],
  maxDocuments: [1, 1_000],
  maxSteps: [1, 500],
} as const;

/** The agent slice as it loads, field by field: a wrong type or an out-of-range limit takes its default, and `auto` is never the mode of a locked slice. */
export function normalizeAgent(raw: unknown): AgentSettings {
  const source = isRecord(raw) ? raw : {};
  const lockAuto = source['lockAuto'] === true;
  const stored = isPermissionMode(source['defaultMode']) ? source['defaultMode'] : DEFAULT_AGENT_SETTINGS.defaultMode;
  const budget = isRecord(source['budget']) ? source['budget'] : {};
  const limits: { -readonly [K in keyof AgentBudgetSettings]: AgentBudgetSettings[K] } = {};
  for (const key of ['maxModelCalls', 'maxActiveMinutes', 'maxTokens', 'maxWordsChanged', 'maxDocuments', 'maxSteps'] as const) {
    const [min, max] = AGENT_BUDGET_RANGES[key];
    const value = budget[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) limits[key] = value;
  }
  const cost = budget['maxCostUsd'];
  if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0 && cost <= 1_000_000) limits.maxCostUsd = cost;
  return {
    loadEveryTool: source['loadEveryTool'] === true,
    defaultMode: stored === 'auto' && lockAuto ? 'ask' : stored,
    lockAuto,
    budget: limits,
  };
}

/** The thinking levels a role may pin, as the gateway's normalised set (provider-gateway §3). */
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * One role's own assignment (provider-gateway §6): the profile it sends through, and the model and thinking level its
 * requests default to. A `profileId` that names no current profile is tolerated here — resolution (providers.ts
 * `resolveForRole`) treats it as "follow" when the named profile is gone.
 */
export interface RoleRef {
  readonly profileId: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

/**
 * The task-role routing: which profile a role's calls run on. `chat` is the root: a request under it resolves to
 * its `RoleRef`, else to the active profile. `drafting` and `background` may hold `'follow'` — which is also what
 * an absent entry means — and then resolve through `chat`.
 */
export interface RoleSettings {
  readonly chat?: RoleRef;
  readonly drafting?: RoleRef | 'follow';
  readonly background?: RoleRef | 'follow';
}

export interface AppSettings {
  readonly provider: {
    /** The active profile's id, mirrored from the profile store. `null` when no profile exists yet. */
    readonly activeProfileId: string | null;
    /**
     * The task-role routing (provider-gateway §6). Absent reads as every role following — which is also what a
     * record written before roles existed carries, so no fixup is needed: the previous active profile was already
     * what 'chat' resolves to, and drafting and background follow it.
     */
    readonly roles?: RoleSettings;
  };
  readonly editor: {
    /** The autosave debounce in milliseconds, clamped to 100–5000. */
    readonly autosaveDebounceMs: number;
    /** Whether focus mode hides the binder and the inspector (ui-modules §5.2). On unless the writer turns it off. */
    readonly focusModeHideRails: boolean;
  };
  readonly session: {
    /** The writer's daily target. Absent means no target is set (goals-progress §2.1). */
    readonly dailyTargetWords?: number;
  };
  /** The checkpoint retention limits (command-bus §5.1, config-exposed). */
  readonly retention: RetentionConfig;
  readonly firstRun: {
    /** Whether the first-run card has been dismissed. It is shown until the writer dismisses it. */
    readonly dismissed: boolean;
  };
  /** The projects made by the first-run card, which the agent panel offers the demo intents for. */
  readonly sampleProjectIds: readonly string[];
  /**
   * The MCP & tools slice (extensibility §3.1): the master switch and the server list. App-level, never a project file:
   * a repository cannot carry it. Loaded entry by entry, so one broken server never blocks the rest of the settings.
   */
  readonly mcp: McpSettings;
  /** The Coherence slice (ui-modules §5.2): the checks a scan runs, the default scope, and the cap on a review's findings. */
  readonly coherence: CoherenceSettings;
  /** The context budgets (context-assembly §3). Empty means the spec's defaults, which is what an unset record means. */
  readonly context: ContextSettings;
  /** The Agent slice: whether every tool is declared on every request. Absent in a record written before it existed, which reads as off. */
  readonly agent: AgentSettings;
}

export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  provider: Object.freeze({ activeProfileId: null }),
  editor: Object.freeze({ autosaveDebounceMs: DEFAULT_DEBOUNCE_MS, focusModeHideRails: true }),
  session: Object.freeze({}),
  retention: DEFAULT_RETENTION,
  firstRun: Object.freeze({ dismissed: false }),
  sampleProjectIds: Object.freeze([]) as readonly string[],
  mcp: EMPTY_MCP_SETTINGS,
  coherence: DEFAULT_COHERENCE_SETTINGS,
  context: Object.freeze({ layerBudgets: Object.freeze({}) }),
  agent: DEFAULT_AGENT_SETTINGS,
});

/** A patch: any field may be given, and the rest keep their values. A `dailyTargetWords` of 0 clears the target. */
export interface SettingsPatch {
  /**
   * `roles` replaces the whole routing record: a role set to `'follow'` follows 'chat' again, and `null` (or an
   * empty record) clears every assignment, so each role follows the chat/active choice.
   */
  readonly provider?: { readonly activeProfileId?: string | null; readonly roles?: RoleSettings | null };
  readonly editor?: { readonly autosaveDebounceMs?: number; readonly focusModeHideRails?: boolean };
  readonly session?: { readonly dailyTargetWords?: number };
  readonly retention?: Partial<RetentionConfig>;
  readonly firstRun?: { readonly dismissed?: boolean };
  readonly sampleProjectIds?: readonly string[];
  readonly mcp?: McpSettings;
  readonly coherence?: Partial<CoherenceSettings>;
  /** The whole context record: the Context section saves both budgets together, so a patch replaces them. */
  readonly context?: ContextSettings;
  /** `budget` replaces the whole record, as the Agent section saves its limits together. */
  readonly agent?: Partial<AgentSettings>;
}

/**
 * The checks a stored list names, in registry order, with unknown and repeated names dropped. Absent (or not a list) reads
 * as every check, so a record written before the section existed runs what it always ran.
 */
export function enabledChecksOf(value: unknown): readonly DeterministicCheckId[] {
  if (!Array.isArray(value)) return DEFAULT_COHERENCE_SETTINGS.enabledChecks;
  const named = new Set(value.filter((id): id is string => typeof id === 'string'));
  return DETERMINISTIC_CHECK_IDS.filter((id) => named.has(id));
}

/** The review scope a stored value names, or the default when it names none. */
export function reviewScopeOf(value: unknown): ReviewScope {
  return (REVIEW_SCOPES as readonly unknown[]).includes(value) ? (value as ReviewScope) : DEFAULT_COHERENCE_SETTINGS.defaultReviewScope;
}

/**
 * The MCP slice's load warnings for a stored record: one named line per entry the loader dropped. The settings themselves
 * are loaded by {@link normalizeSettings}; this is what the start-up says about them, so nothing is dropped in silence.
 */
export function mcpLoadWarnings(raw: unknown, now: string = new Date().toISOString()): readonly string[] {
  const source = isRecord(raw) ? raw : {};
  return loadMcpSettings(source['mcp'], now).warnings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A whole number within `[min, max]`, or the fallback. */
export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const whole = Math.round(value);
  return Math.min(max, Math.max(min, whole));
}

/** The daily target: a whole number of words from 0 to the maximum, with 0 read as no target. */
export function targetOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const whole = Math.min(TARGET_MAX_WORDS, Math.max(0, Math.round(value)));
  return whole === 0 ? undefined : whole;
}

/**
 * One role entry as it loads: `'follow'` is valid only where the role may follow (drafting and background — 'chat'
 * has no one to follow but the active profile), and a `RoleRef` keeps the fields it recognises. A malformed entry
 * is dropped to absent, which is what following reads as.
 */
function normalizeRoleRef(value: unknown, followAllowed: boolean): RoleRef | 'follow' | undefined {
  if (value === 'follow') return followAllowed ? 'follow' : undefined;
  if (!isRecord(value)) return undefined;
  const profileId = value['profileId'];
  if (typeof profileId !== 'string' || profileId.length === 0) return undefined;
  const model = value['model'];
  const thinking = value['thinking'];
  return {
    profileId,
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
    ...(typeof thinking === 'string' && (THINKING_LEVELS as readonly string[]).includes(thinking)
      ? { thinking: thinking as ThinkingLevel }
      : {}),
  };
}

/**
 * The `provider.roles` record as it loads: unknown keys are ignored, a malformed entry is dropped, and a role left
 * absent — or set to `'follow'` — follows the chat/active choice. An entry's `profileId` is kept even when no
 * profile matches it, since resolution tolerates a missing profile. An empty record normalises to absent.
 */
export function normalizeRoleSettings(value: unknown): RoleSettings | undefined {
  if (!isRecord(value)) return undefined;
  // A mutable shape while it fills; the record that is returned is the schema's `RoleSettings`.
  const roles: { chat?: RoleRef; drafting?: RoleRef | 'follow'; background?: RoleRef | 'follow' } = {};
  const chat = normalizeRoleRef(value['chat'], false);
  if (typeof chat === 'object') roles.chat = chat;
  for (const role of ['drafting', 'background'] as const) {
    const ref = normalizeRoleRef(value[role], true);
    if (ref !== undefined) roles[role] = ref;
  }
  return roles.chat === undefined && roles.drafting === undefined && roles.background === undefined ? undefined : roles;
}

/**
 * Settings as they load from storage or are patched in: unknown keys are ignored, a wrong type or an out-of-range number
 * takes its default, and nothing throws. The result is always a complete `AppSettings`.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const source = isRecord(raw) ? raw : {};
  const provider = isRecord(source['provider']) ? source['provider'] : {};
  const editor = isRecord(source['editor']) ? source['editor'] : {};
  const session = isRecord(source['session']) ? source['session'] : {};
  const retention = isRecord(source['retention']) ? source['retention'] : {};
  const firstRun = isRecord(source['firstRun']) ? source['firstRun'] : {};
  const samples = Array.isArray(source['sampleProjectIds']) ? source['sampleProjectIds'] : [];

  const cap = clampInteger(retention['checkpointCap'], 1, CHECKPOINT_CAP_MAX, DEFAULT_RETENTION.checkpointCap);
  const days = clampInteger(retention['checkpointDays'], 1, CHECKPOINT_DAYS_MAX, DEFAULT_RETENTION.checkpointDays);
  const target = targetOf(session['dailyTargetWords']);
  const coherence = isRecord(source['coherence']) ? source['coherence'] : {};
  const roles = normalizeRoleSettings(provider['roles']);

  return {
    provider: {
      activeProfileId: typeof provider['activeProfileId'] === 'string' ? provider['activeProfileId'] : null,
      ...(roles === undefined ? {} : { roles }),
    },
    editor: {
      autosaveDebounceMs: clampInteger(editor['autosaveDebounceMs'], DEBOUNCE_MIN_MS, DEBOUNCE_MAX_MS, DEFAULT_DEBOUNCE_MS),
      focusModeHideRails: typeof editor['focusModeHideRails'] === 'boolean' ? editor['focusModeHideRails'] : true,
    },
    session: target === undefined ? {} : { dailyTargetWords: target },
    retention: resolveRetentionConfig({ checkpointCap: cap, checkpointDays: days }),
    firstRun: { dismissed: firstRun['dismissed'] === true },
    sampleProjectIds: samples.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 50),
    mcp: loadMcpSettings(source['mcp'], new Date().toISOString()).settings,
    coherence: {
      enabledChecks: enabledChecksOf(coherence['enabledChecks']),
      defaultReviewScope: reviewScopeOf(coherence['defaultReviewScope']),
      maxFindings: clampInteger(coherence['maxFindings'], 1, MAX_FINDINGS_CAP, MAX_FINDINGS_DEFAULT),
    },
    context: normalizeContext(source['context']),
    agent: normalizeAgent(source['agent']),
  };
}

/** A budget as a whole number clamped into its range, or undefined when the stored value is not a number at all. */
function budgetOf(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return clampInteger(value, min, max, min);
}

/** The context record as it loads: the total and each layer's cap clamped into range, and a missing value left unset. */
export function normalizeContext(raw: unknown): ContextSettings {
  const source = isRecord(raw) ? raw : {};
  const layers = isRecord(source['layerBudgets']) ? source['layerBudgets'] : {};
  const total = budgetOf(source['totalBudgetTokens'], CONTEXT_TOTAL_MIN, CONTEXT_TOTAL_MAX);
  const layerBudgets: Partial<Record<ContextLayerId, number>> = {};
  for (const id of CONTEXT_LAYERS) {
    const value = budgetOf(layers[id], CONTEXT_LAYER_MIN, CONTEXT_LAYER_MAX);
    if (value !== undefined) layerBudgets[id] = value;
  }
  return { ...(total === undefined ? {} : { totalBudgetTokens: total }), layerBudgets };
}

/** The assembler's config for these settings: the total and the layer caps the writer set. An unset value keeps the spec's default. */
export function contextConfigOf(context: ContextSettings): ContextConfig {
  return {
    ...(context.totalBudgetTokens === undefined ? {} : { contextBudget: context.totalBudgetTokens }),
    ...(Object.keys(context.layerBudgets).length === 0 ? {} : { layerBudgets: { ...context.layerBudgets } }),
  };
}

/**
 * The Context section's warn line (ui-modules §5.2): when the total is below the layer caps the writer set, together, the total
 * cuts a layer before that layer reaches its own cap. Undefined when no total is set, or the total covers the caps. The two
 * figures are grouped in the formatter locale (i18n.md §4.2).
 */
export function contextWarningOf(context: ContextSettings, locale: string = formatterLocale()): string | undefined {
  if (context.totalBudgetTokens === undefined) return undefined;
  const caps = Object.values(context.layerBudgets).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (caps === 0 || context.totalBudgetTokens >= caps) return undefined;
  const count = numberFormat(locale);
  return `The total (${count.format(context.totalBudgetTokens)} tokens) is below the layer caps together (${count.format(caps)} tokens), so a layer can be cut before it reaches its own cap.`;
}

/** Applies a patch to settings and normalises the result, so a patch cannot leave the record outside its clamps. */
export function applyPatch(current: AppSettings, patch: SettingsPatch): AppSettings {
  const next: Record<string, unknown> = {
    provider: { ...current.provider, ...(patch.provider ?? {}) },
    editor: { ...current.editor, ...(patch.editor ?? {}) },
    session: {
      ...current.session,
      ...(patch.session === undefined
        ? {}
        : { dailyTargetWords: patch.session.dailyTargetWords ?? current.session.dailyTargetWords }),
    },
    retention: { ...current.retention, ...(patch.retention ?? {}) },
    firstRun: { ...current.firstRun, ...(patch.firstRun ?? {}) },
    sampleProjectIds: patch.sampleProjectIds ?? current.sampleProjectIds,
    mcp: patch.mcp ?? current.mcp,
    coherence: { ...current.coherence, ...(patch.coherence ?? {}) },
    context: patch.context ?? current.context,
    agent: { ...current.agent, ...(patch.agent ?? {}) },
  };
  return normalizeSettings(next);
}
