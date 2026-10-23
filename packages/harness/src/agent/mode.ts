/**
 * Permission modes (agent-harness §4): how much of a card's decision the writer hands to a policy.
 *
 * - `plan-only` runs reads and refuses every write before it is drafted. The planner's steps are kept so the writer can run them later.
 * - `ask` is the default: every card is the writer's.
 * - `accept-edits` approves the cards of native text and field edits (`ACCEPT_EDITS_TOOLS`) as shown.
 * - `auto` approves any card of native tools as shown, inside the turn's budgets.
 *
 * A mode answers a card; it never reaches the bus gate. An external write, a card the preflight refuses, a stale or cut draft, a
 * scan over the document guard and everything on the hard-deny list stay the writer's (or the bus's) in every mode. There is no
 * classifier and no per-primitive toggle (rules are #52's layer), and a mode lives in app settings and a session override, never in
 * `caotang.json`.
 *
 * `noHuman` is the switch for a caller with nobody to ask (the SDK, the CLI): a card the policy does not approve is cancelled
 * instead of being forwarded to `decide`.
 */

import { canonicalJson } from '../util.js';

export const PERMISSION_MODES = ['plan-only', 'ask', 'accept-edits', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask';

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** The words a mode is shown in, in the panel and on every turn and checkpoint row. */
export const MODE_LABELS: Readonly<Record<PermissionMode, string>> = Object.freeze({
  'plan-only': 'Plan only',
  ask: 'Ask',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
});

/**
 * The write tools `accept-edits` approves: native tools that change the text or the fields of documents the writer named. Anything
 * that restructures the binder, imports, exports, reviews or reaches outside the project is not here and stays a card the writer decides.
 */
export const ACCEPT_EDITS_TOOLS: ReadonlySet<string> = new Set([
  'scene.draft',
  'synopsis.fill',
  'synopsis.set',
  'notes.replace',
  'notes.append',
  'meta.set',
  'codex.write',
  'dialogue.draft',
  'prompt.draft',
  'shots.derive',
  'shots.annotate',
]);

/** What a turn may spend before it stops on a question. A missing limit is not enforced. */
export interface TurnBudget {
  /** Model requests, retries and drafts included. */
  readonly maxModelCalls: number;
  /** Prompt plus completion tokens, as the gateway's ledger counts them. */
  readonly maxTokens?: number;
  /** Dollars, at the price the session reads (`AgentSessionOptions.price`). A turn with no price is not held to it. */
  readonly maxCostUsd?: number;
  /** The words a turn changes across documents, counted as the sum of each touched document's change in length. */
  readonly maxWordsChanged?: number;
  readonly maxDocuments?: number;
  /** Plan steps applied. */
  readonly maxSteps?: number;
  /** The same tool with the same parameters, proposed this many times in one turn, stops it. */
  readonly doomLoopRepeats: number;
}

/** What a session may spend across all its turns; the dimensions are the turn's, cumulatively. */
export type SessionBudget = Partial<Omit<TurnBudget, 'doomLoopRepeats'>>;

export const DEFAULT_TURN_BUDGET: TurnBudget = Object.freeze({
  maxModelCalls: 8,
  maxTokens: 150_000,
  maxWordsChanged: 6_000,
  maxDocuments: 30,
  maxSteps: 40,
  doomLoopRepeats: 3,
});

export type BudgetDimension = 'model-calls' | 'tokens' | 'cost' | 'words' | 'documents' | 'steps' | 'repeats';

/** What a turn has used so far. `costUsd` is absent while the session has no price to read. */
export interface BudgetUse {
  readonly modelCalls: number;
  readonly tokens: number;
  readonly costUsd?: number;
  readonly wordsChanged: number;
  readonly documents: number;
  readonly steps: number;
}

export const EMPTY_BUDGET_USE: BudgetUse = Object.freeze({ modelCalls: 0, tokens: 0, wordsChanged: 0, documents: 0, steps: 0 });

/** The dimension a turn ran into, what it had used, and the limit. */
export interface BudgetHit {
  readonly dimension: BudgetDimension;
  readonly used: number;
  readonly limit: number;
  /** `session` when the cumulative limit was the one reached. */
  readonly scope: 'turn' | 'session';
}

const DIMENSIONS: readonly { readonly dimension: Exclude<BudgetDimension, 'repeats'>; readonly limit: keyof SessionBudget; readonly use: (use: BudgetUse) => number | undefined }[] = [
  { dimension: 'model-calls', limit: 'maxModelCalls', use: (use) => use.modelCalls },
  { dimension: 'tokens', limit: 'maxTokens', use: (use) => use.tokens },
  { dimension: 'cost', limit: 'maxCostUsd', use: (use) => use.costUsd },
  { dimension: 'words', limit: 'maxWordsChanged', use: (use) => use.wordsChanged },
  { dimension: 'documents', limit: 'maxDocuments', use: (use) => use.documents },
  { dimension: 'steps', limit: 'maxSteps', use: (use) => use.steps },
];

/** The dimensions a model call spends; the others are what a card changes. */
const SPENT: ReadonlySet<BudgetDimension> = new Set(['model-calls', 'tokens', 'cost']);

/**
 * The first dimension whose use has reached its limit, or `undefined`. `reached` is the check before a model call: a turn that has
 * used exactly what it may spend may not spend more (only the spent dimensions count, since a call changes nothing). With
 * `reached: false` the check is for a card about to apply, where `use` already includes what the card would add, so only an excess is
 * a hit and a turn may end exactly on its limit.
 */
export function budgetHit(use: BudgetUse, budget: Partial<TurnBudget>, reached: boolean, scope: 'turn' | 'session' = 'turn'): BudgetHit | undefined {
  for (const row of DIMENSIONS) {
    const limit = budget[row.limit];
    const used = row.use(use);
    if (limit === undefined || used === undefined || (reached && !SPENT.has(row.dimension))) continue;
    if (reached ? used >= limit : used > limit) return { dimension: row.dimension, used, limit, scope };
  }
  return undefined;
}

/** The sum of two uses, for a session's running total. */
export function addUse(a: BudgetUse, b: BudgetUse): BudgetUse {
  const costUsd = a.costUsd === undefined && b.costUsd === undefined ? undefined : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    modelCalls: a.modelCalls + b.modelCalls,
    tokens: a.tokens + b.tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    wordsChanged: a.wordsChanged + b.wordsChanged,
    documents: a.documents + b.documents,
    steps: a.steps + b.steps,
  };
}

const DIMENSION_WORDS: Readonly<Record<BudgetDimension, { readonly name: string; readonly setting: string }>> = {
  'model-calls': { name: 'model-call', setting: 'model calls' },
  tokens: { name: 'token', setting: 'tokens' },
  cost: { name: 'cost', setting: 'cost' },
  words: { name: 'words-changed', setting: 'words changed' },
  documents: { name: 'documents-touched', setting: 'documents touched' },
  steps: { name: 'step', setting: 'steps' },
  repeats: { name: 'repeated-call', setting: 'repeated calls' },
};

/** The reason an ask-back gives for a hit, and the options it offers. The model-call wording is the one a turn has always used. */
export function budgetStop(hit: BudgetHit): { readonly reason: string; readonly options: readonly string[] } {
  if (hit.dimension === 'model-calls' && hit.scope === 'turn') {
    return {
      reason: `the turn made ${hit.limit} model calls without finishing, so it stopped`,
      options: ['ask for a smaller change, and send it again', 'split the work across two turns'],
    };
  }
  const words = DIMENSION_WORDS[hit.dimension];
  const amount = hit.dimension === 'cost' ? `$${hit.used.toFixed(4)} of $${hit.limit.toFixed(4)}` : `${hit.used} of ${hit.limit}`;
  return {
    reason: `the ${hit.scope === 'session' ? 'session' : 'turn'} reached its ${words.name} budget (${amount}), so it stopped before going further`,
    options: [`raise the ${words.setting} budget in Settings › Agent, then send the request again`, 'stop here and keep what was applied'],
  };
}

/** The reason and options for a turn that proposed the same call too often. */
export function repeatStop(tool: string, repeats: number): { readonly reason: string; readonly options: readonly string[] } {
  return {
    reason: `the turn proposed ${tool} with the same parameters ${repeats} times, so it stopped instead of going round again`,
    options: ['say what should change, and send the request again', 'stop here and keep what was applied'],
  };
}

/** A call's identity for the repeat guard: the tool and a digest of its parameters. */
export function callDigest(tool: string, params: Readonly<Record<string, unknown>>): string {
  return `${tool}:${canonicalJson(params)}`;
}

/** What a policy is told about a card to decide it. `tools` are the steps still to run that are not reads. */
export interface CardFacts {
  readonly tools: readonly string[];
  /** A step of the card is a loaded external tool. */
  readonly external: boolean;
}

export interface ModePolicy {
  readonly mode: PermissionMode;
  /** Writes are refused before they are drafted. */
  readonly readOnly: boolean;
  /** The policy answers cards it approves, so the extended budgets and the repeat guard apply. False while `taint` holds. */
  readonly decides: boolean;
  /** A card the policy does not approve is cancelled instead of forwarded. */
  readonly noHuman: boolean;
  /** Whether the policy approves this card as shown. The loop still requires the card to be approvable. */
  approves(card: CardFacts): boolean;
}

export interface ModePolicyOptions {
  /** `auto` is refused: the writer turned it off in settings. */
  readonly lockAuto?: boolean;
  /** The project holds text from outside the writer (#54); while true, accept-edits and auto behave as ask. Default false. */
  readonly taint?: () => boolean;
  readonly noHuman?: boolean;
}

export class ModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeError';
  }
}

/** The policy of a mode. `auto` while `lockAuto` is set is refused, so no code path can reach it by a stored value. */
export function modePolicy(mode: PermissionMode, options: ModePolicyOptions = {}): ModePolicy {
  if (mode === 'auto' && options.lockAuto === true) throw new ModeError('auto mode is turned off in Settings › Agent');
  const noHuman = options.noHuman === true;
  const tainted = (): boolean => options.taint?.() === true;
  const decides = mode === 'accept-edits' || mode === 'auto';
  return {
    mode,
    readOnly: mode === 'plan-only',
    get decides() {
      return decides && !tainted();
    },
    noHuman,
    approves(card) {
      if (!decides || tainted() || card.external) return false;
      return mode === 'auto' || card.tools.every((tool) => ACCEPT_EDITS_TOOLS.has(tool));
    },
  };
}
