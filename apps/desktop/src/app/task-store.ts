/**
 * Background tasks as the app database keeps them (agent-harness §2, "Background runs"; project-format §1).
 *
 * A task is a plan the writer sent to the background, the drafts staged for it so far, and what it cost. It is one record under
 * `task:<projectId>:<id>` in the `kv` store of `caotang-app`, so it needs no new store and no version bump. It holds text drawn from
 * the manuscript and never a credential. It is not part of the project: a folder, a bundle and an export carry none of it, and
 * removing the project removes its tasks.
 *
 * What is read back is untrusted: a record that is not shaped like a task is skipped, and the harness checks every stored draft again
 * before it reaches a card (`submitStaged`).
 */

import { MODEL_BACKED_TOOLS, contextOverridesOk, estimatedStepCalls, mergePreviews, stagedOf, type ContextOverrides, type PlanStep, type PromptPreview, type StepRevisions } from '@caotang/harness';
import { LLM_CATEGORIES, type ReviewCheckpoint } from '@caotang/coherence';
import { isIdWithPrefix, newId } from '@caotang/ids';
import type { MachineTable } from '@caotang/machine';

import { activeAppDb, type AppDb } from './app-db.js';
import type { QueuedReviewApproval } from './queued-review.js';

/**
 * `queued` waits for the runner, `running` is being staged, `ready` holds drafts to review, `failed` staged nothing, `cancelled` was
 * stopped by the writer, `interrupted` was cut short by a closed tab or project and can be resumed, and `applied` was reviewed and
 * approved.
 */
export type TaskStatus = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled' | 'interrupted' | 'applied' | 'completed';

export type TaskQueueStatus = TaskStatus | 'starting' | 'cancelling';
export type TaskStatusEvent = 'pump' | 'agent-ready' | 'cancel' | 'cancel-recovered' | 'close' | 'reload' | 'resume' | 'ready' | 'fail' | 'settle' | 'apply' | 'complete';

export const taskStatusTable: MachineTable<{ kind: TaskQueueStatus }, { type: TaskStatusEvent }> = {
  id: 'task.status',
  initial: 'queued',
  final: ['failed', 'cancelled', 'applied', 'completed'],
  on: {
    queued: { pump: ['starting'], cancel: ['cancelled'], close: ['interrupted'], reload: ['interrupted'] },
    starting: { 'agent-ready': ['running'], cancel: ['cancelling'], close: ['interrupted'], ready: ['ready'], fail: ['failed'], complete: ['completed'] },
    running: { cancel: ['cancelling'], close: ['interrupted'], reload: ['interrupted'], ready: ['ready'], fail: ['failed'], complete: ['completed'] },
    cancelling: { settle: ['cancelled'], complete: ['completed'], ready: ['ready'] },
    interrupted: { cancel: ['cancelling'], 'cancel-recovered': ['cancelled'], settle: ['interrupted'], resume: ['queued'] },
    ready: { apply: ['applied'] },
    failed: {},
    cancelled: {},
    applied: {},
    completed: {},
  },
};

/** The statuses of a task that is over. A finished task is kept for a while, then pruned. */
export const FINISHED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['failed', 'cancelled', 'applied', 'completed']);

const STATUSES: ReadonlySet<string> = new Set<TaskStatus>(['queued', 'running', 'ready', 'failed', 'cancelled', 'interrupted', 'applied', 'completed']);

export type TaskKind = 'draft' | 'review' | 'mixed';

export type TaskReviewPhase = 'extracting' | 'verifying' | 'publishing';

export type TaskUsageSource = 'reported' | 'estimated' | 'unknown';

export interface TaskReviewReport {
  readonly runId: string;
  readonly outcome: 'complete' | 'partial';
  readonly findingsCount: number;
  readonly scopeTitles: readonly string[];
  readonly routeLabel: string;
  readonly usage: {
    readonly modelCalls: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly source: TaskUsageSource;
  };
}

/** One unit of staging: a model-backed step, or one document of a synopsis step. `pending` is the only state a resume runs. */
export interface TaskItem {
  /** `${step}` for a step, `${step}:${ref}` for one document of a synopsis step. */
  readonly key: string;
  readonly step: number;
  /** The document a synopsis item drafts, as the plan named it. */
  readonly ref?: string;
  readonly state: 'pending' | 'staged' | 'failed';
  readonly proposal?: unknown;
  readonly revisions?: StepRevisions;
  /** Why a failed item failed, in words. */
  readonly error?: string;
}

export interface TaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly intent: string;
  readonly steps: readonly PlanStep[];
  readonly contextOverrides?: ContextOverrides;
  readonly status: TaskStatus;
  readonly items: readonly TaskItem[];
  /** The most model calls the task may make: the plan's estimate. */
  readonly cap: number;
  /** The model calls made so far, over every run of the task. */
  readonly used: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** How many times the runner has started the task: a resume is another run, and names its session apart so the ledger's turns stay distinct. */
  readonly runs: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly kind?: TaskKind;
  readonly review?: QueuedReviewApproval;
  readonly reviewCheckpoint?: ReviewCheckpoint;
  readonly reviewPhase?: TaskReviewPhase;
  readonly reviewProgress?: { readonly done: number; readonly total: number };
  readonly report?: TaskReviewReport;
  readonly reviewRunId?: string;
  readonly acknowledged?: boolean;
  /** The recurring task this queued run came from, when a consented due task staged it (agent-harness §12). Its cap is the task's call cap. */
  readonly recurringTaskId?: string;
  readonly recurringHash?: string;
  readonly recurringPermission?: 'read-only' | 'ask';
  readonly reservedCalls?: number;
}

/** Finished tasks kept for a project, newest first; the rest are pruned when the project opens. */
export const TASK_KEEP_FINISHED = 50;
/** A task not touched for this long is pruned whatever its state. */
export const TASK_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

export const taskPrefix = (projectId: string): string => `task:${projectId}:`;
export const taskKey = (projectId: string, id: string): string => `${taskPrefix(projectId)}${id}`;

/** A fresh id: `task_` and ten Crockford base32 characters. */
export const newTaskId = (): string => newId('task');

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isCategory = (value: unknown): boolean => typeof value === 'string' && (LLM_CATEGORIES as readonly string[]).includes(value);
const categoriesOk = (value: unknown): boolean => isStrings(value) && value.length > 0 && value.every(isCategory);
const sameStrings = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);
const isVerdict = (value: unknown): boolean => value === 'contradictory' || value === 'consistent' || value === 'unclear';

function plannedDocumentOk(value: unknown): boolean {
  return isObject(value) && typeof value['docId'] === 'string' && typeof value['title'] === 'string' && isCount(value['estimatedTokens']) && typeof value['truncated'] === 'boolean' && isStrings(value['codexDropped']) && isStrings(value['storyDropped']);
}

function spanOk(value: unknown): boolean {
  return isObject(value) && typeof value['docId'] === 'string' && isCount(value['from']) && isCount(value['to']) && value['from'] <= value['to'] && typeof value['quote'] === 'string' && isCategory(value['category']) && typeof value['note'] === 'string';
}

function evidenceOk(value: unknown): boolean {
  return isObject(value) && typeof value['docId'] === 'string' && typeof value['quote'] === 'string' && isCount(value['from']) && isCount(value['to']) && value['from'] <= value['to'] && (value['paraHash'] === undefined || typeof value['paraHash'] === 'string');
}

function verdictOk(value: unknown): boolean {
  if (!isObject(value) || typeof value['pairId'] !== 'string' || !isVerdict(value['verdict']) || typeof value['reasoning'] !== 'string' || typeof value['entity'] !== 'string' || typeof value['attribute'] !== 'string') return false;
  return value['evidence'] === undefined || (Array.isArray(value['evidence']) && value['evidence'].every(evidenceOk));
}

function reviewApprovalOk(value: unknown): boolean {
  if (!isObject(value)) return false;
  const plan = value['plan'];
  if (!isObject(plan) || !isStrings(plan['scopeDocIds']) || !Array.isArray(plan['documents']) || !isStrings(plan['categories']) || !isCount(plan['maxFindings']) || (plan['promptPreview'] !== undefined && typeof plan['promptPreview'] !== 'string') || typeof plan['overGuard'] !== 'boolean' || !isObject(plan['estimate'])) return false;
  if (!categoriesOk(plan['categories']) || plan['maxFindings'] < 1 || !plan['documents'].every(plannedDocumentOk)) return false;
  const estimate = plan['estimate'];
  if (!['extractCalls', 'extractTokens', 'verifyCallsAtMost', 'verifyTokensAtMost', 'totalTokensAtMost'].every((key) => isCount(estimate[key]))) return false;
  const route = value['route'];
  if (!isObject(route) || typeof route['profileId'] !== 'string' || typeof route['model'] !== 'string' || typeof route['label'] !== 'string') return false;
  if (route['thinking'] !== undefined && typeof route['thinking'] !== 'string') return false;
  const bound = value['callBound'];
  if (!isObject(bound) || !isCount(bound['extractCalls']) || !isCount(bound['verifyCallsAtMost'])) return false;
  if (bound['extractCalls'] !== estimate['extractCalls'] || bound['verifyCallsAtMost'] !== estimate['verifyCallsAtMost']) return false;
  if (!isStrings(value['scopeDocIds']) || !isStrings(value['categories']) || !isCount(value['maxFindings']) || typeof value['fingerprint'] !== 'string' || value['fingerprint'] === '') return false;
  if (!categoriesOk(value['categories']) || value['maxFindings'] < 1) return false;
  if (!sameStrings(value['scopeDocIds'], plan['scopeDocIds']) || !sameStrings(value['categories'], plan['categories']) || value['maxFindings'] !== plan['maxFindings']) return false;
  if (value['contextOverrides'] !== undefined && !contextOverridesOk(value['contextOverrides'])) return false;
  return true;
}

function reviewCheckpointOk(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!isStrings(value['extractedDocIds']) || !isCount(value['verifiedBatches']) || !isCount(value['promptTokens']) || !isCount(value['completionTokens']) || !isStrings(value['notes']) || !isStrings(value['evaluated'])) return false;
  if (value['status'] !== 'complete' && value['status'] !== 'partial') return false;
  if (value['verifiedPairs'] !== undefined && !isStrings(value['verifiedPairs'])) return false;
  if (!Array.isArray(value['spans']) || !value['spans'].every(spanOk)) return false;
  if (!Array.isArray(value['verdicts']) || !value['verdicts'].every(verdictOk)) return false;
  const usage = value['usageByPair'];
  if (!isObject(usage) || !Object.values(usage).every((entry) => isObject(entry) && isCount(entry['promptTokens']) && isCount(entry['completionTokens']))) return false;
  const hasCalls = value['modelCalls'] !== undefined;
  const hasSource = value['usageSource'] !== undefined;
  if (hasCalls !== hasSource) return false;
  if (hasCalls && !isCount(value['modelCalls'])) return false;
  if (hasSource && value['usageSource'] !== 'reported' && value['usageSource'] !== 'estimated' && value['usageSource'] !== 'unknown') return false;
  return true;
}

function reviewReportOk(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (typeof value['runId'] !== 'string' || (value['outcome'] !== 'complete' && value['outcome'] !== 'partial') || !isCount(value['findingsCount']) || !isStrings(value['scopeTitles']) || typeof value['routeLabel'] !== 'string') return false;
  const usage = value['usage'];
  if (!isObject(usage) || !isCount(usage['modelCalls']) || !isCount(usage['promptTokens']) || !isCount(usage['completionTokens'])) return false;
  return usage['source'] === 'reported' || usage['source'] === 'estimated' || usage['source'] === 'unknown';
}

function reviewMetadataOk(value: Record<string, unknown>): boolean {
  const kind = value['kind'];
  if (kind !== undefined && kind !== 'draft' && kind !== 'review' && kind !== 'mixed') return false;
  if (value['review'] !== undefined && !reviewApprovalOk(value['review'])) return false;
  if (value['reviewCheckpoint'] !== undefined && !reviewCheckpointOk(value['reviewCheckpoint'])) return false;
  if (value['report'] !== undefined && !reviewReportOk(value['report'])) return false;
  if (value['reviewPhase'] !== undefined && value['reviewPhase'] !== 'extracting' && value['reviewPhase'] !== 'verifying' && value['reviewPhase'] !== 'publishing') return false;
  if (value['reviewProgress'] !== undefined && (!isObject(value['reviewProgress']) || !isCount(value['reviewProgress']['done']) || !isCount(value['reviewProgress']['total']))) return false;
  if (value['reviewRunId'] !== undefined && typeof value['reviewRunId'] !== 'string') return false;
  if (value['acknowledged'] !== undefined && typeof value['acknowledged'] !== 'boolean') return false;
  if (value['recurringTaskId'] !== undefined) {
    if (typeof value['recurringTaskId'] !== 'string' || !isIdWithPrefix('t', value['recurringTaskId'])) return false;
    if (typeof value['recurringHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['recurringHash'])) return false;
    if (value['recurringPermission'] !== 'read-only' && value['recurringPermission'] !== 'ask') return false;
    if (value['reservedCalls'] !== undefined && (!isCount(value['reservedCalls']) || (value['reservedCalls'] as number) + (value['used'] as number) > (value['cap'] as number))) return false;
  } else if (value['recurringHash'] !== undefined || value['recurringPermission'] !== undefined || value['reservedCalls'] !== undefined) return false;
  if ((kind === 'review' || kind === 'mixed') && !reviewApprovalOk(value['review'])) return false;
  const carriesReview = value['review'] !== undefined || value['reviewCheckpoint'] !== undefined || value['report'] !== undefined || value['reviewPhase'] !== undefined || value['reviewProgress'] !== undefined || value['reviewRunId'] !== undefined;
  if (carriesReview && kind !== 'review' && kind !== 'mixed') return false;
  return true;
}

/** A stored value as a task record, or `undefined` when it is not shaped like one. */
export function asTaskRecord(value: unknown, projectId: string): TaskRecord | undefined {
  if (!isObject(value)) return undefined;
  const { id, status, steps, items } = value;
  if (typeof id !== 'string' || value['projectId'] !== projectId || typeof status !== 'string' || !STATUSES.has(status)) return undefined;
  if (typeof value['intent'] !== 'string' || !Array.isArray(steps) || !Array.isArray(items)) return undefined;
  if (value['contextOverrides'] !== undefined && !contextOverridesOk(value['contextOverrides'])) return undefined;
  for (const field of ['cap', 'used', 'promptTokens', 'completionTokens', 'runs', 'createdAt', 'updatedAt']) {
    if (!isCount(value[field])) return undefined;
  }
  if (!['createdAt', 'updatedAt'].every((field) => Number.isFinite(new Date(value[field] as number).getTime()))) return undefined;
  const stepsOk = steps.every((step) => isObject(step) && typeof step['tool'] === 'string' && isObject(step['params']) && typeof step['expect'] === 'string' && (step['contextOverrides'] === undefined || contextOverridesOk(step['contextOverrides'])));
  const itemsOk = items.every(
    (item) =>
      isObject(item) &&
      typeof item['key'] === 'string' &&
      isCount(item['step']) &&
      (item['state'] === 'pending' || item['state'] === 'staged' || item['state'] === 'failed'),
  );
  return stepsOk && itemsOk && reviewMetadataOk(value) ? (value as unknown as TaskRecord) : undefined;
}

/**
 * The items a plan is staged in: one for each model-backed step, and for a synopsis step one for each document, so a failure or a stop
 * costs only the documents after it. A step that drafts nothing has no item: it runs at review, under the card.
 */
export function itemsOf(steps: readonly PlanStep[]): TaskItem[] {
  const items: TaskItem[] = [];
  for (const [index, step] of steps.entries()) {
    if (!MODEL_BACKED_TOOLS.has(step.tool)) continue;
    const docs = step.params['docs'];
    if (step.tool === 'synopsis.fill' && Array.isArray(docs) && docs.length > 0 && docs.every((ref) => typeof ref === 'string')) {
      for (const ref of new Set(docs as string[])) items.push({ key: `${index}:${ref}`, step: index, ref, state: 'pending' });
    } else {
      items.push({ key: `${index}`, step: index, state: 'pending' });
    }
  }
  return items;
}

/** The step one item stages: the plan's step, or for a synopsis item the step narrowed to its document. */
export function stepOfItem(task: Pick<TaskRecord, 'steps'>, item: TaskItem): PlanStep {
  const step = task.steps[item.step] as PlanStep;
  return item.ref === undefined ? step : { ...step, params: { ...step.params, docs: [item.ref] } };
}

/** The model calls one item makes when it is staged. */
export const callsOfItem = (task: Pick<TaskRecord, 'steps'>, item: TaskItem): number => estimatedStepCalls(stepOfItem(task, item));

/** What a review of the task is given: the plan as it will be shown, and the drafts and revisions staged for it. */
export interface TaskReview {
  readonly steps: readonly PlanStep[];
  readonly proposals: readonly unknown[];
  readonly revisions: readonly StepRevisions[];
  /** Documents of a synopsis step that could not be drafted and are left out of the review. */
  readonly omitted: number;
}

/**
 * The task's staged items as a plan to review. The documents of a synopsis step come back together as one batch; a document that was
 * not drafted is left out of the step, so the card shows the work that was done, and the omission is counted. A step with nothing
 * staged keeps its own parameters and no draft, so the card shows it as out of date.
 */
export function reviewOf(task: TaskRecord): TaskReview {
  const proposals: unknown[] = [];
  const revisions: StepRevisions[] = [];
  const steps: PlanStep[] = [];
  let omitted = 0;
  for (const [index, step] of task.steps.entries()) {
    if (step.tool === 'coherence.review') continue;
    const own = task.items.filter((item) => item.step === index);
    const staged = own.filter((item) => item.state === 'staged');
    if (own.length === 0 || staged.length === 0) {
      steps.push(step);
      proposals.push(undefined);
      revisions.push({});
      continue;
    }
    if (step.tool === 'synopsis.fill' && own.some((item) => item.ref !== undefined)) {
      omitted += own.length - staged.length;
      const merged: { docId: string; synopsis: string }[] = [];
      const previews: PromptPreview[] = [];
      let cut = false;
      let reads: Record<string, number> = {};
      for (const item of staged) {
        const part = item.proposal as { items?: { docId: string; synopsis: string }[]; cut?: boolean } | undefined;
        merged.push(...(Array.isArray(part?.items) ? part.items : []));
        const context = stagedOf(item.proposal).context;
        if (context !== undefined) previews.push(context);
        cut ||= part?.cut === true;
        reads = { ...reads, ...(item.revisions ?? {}) };
      }
      steps.push({ ...step, params: { ...step.params, docs: staged.flatMap((item) => (item.ref === undefined ? [] : [item.ref])) } });
      const context = mergePreviews(previews);
      proposals.push({ items: merged, ...(cut ? { cut: true } : {}), ...(context === undefined ? {} : { context }) });
      revisions.push(reads);
      continue;
    }
    const only = staged[0] as TaskItem;
    steps.push(step);
    proposals.push(only.proposal);
    revisions.push(only.revisions ?? {});
  }
  return { steps, proposals, revisions, omitted };
}

/** The tasks of the app database. A store with no database keeps none, and the queue is then unavailable. */
export class TaskStore {
  constructor(private readonly db: AppDb | null = activeAppDb()) {}

  get available(): boolean {
    return this.db !== null;
  }

  /** The project's tasks, oldest first. A record that is not shaped like a task is skipped. */
  async list(projectId: string): Promise<TaskRecord[]> {
    if (this.db === null) return [];
    const rows = await this.db.list<unknown>(taskPrefix(projectId));
    const tasks: TaskRecord[] = [];
    for (const row of rows) {
      const task = asTaskRecord(row.value, projectId);
      if (task !== undefined) tasks.push(task);
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  async save(task: TaskRecord): Promise<void> {
    await this.db?.put(taskKey(task.projectId, task.id), task);
  }

  async remove(projectId: string, id: string): Promise<void> {
    await this.db?.delete(taskKey(projectId, id));
  }

  /**
   * Removes the tasks no one will open: any not touched for 14 days, and the finished ones past the newest 50. A task that is
   * running or waiting is never pruned by count. Returns the ids removed.
   */
  async prune(projectId: string, now: number): Promise<string[]> {
    const tasks = await this.list(projectId);
    const stale = tasks.filter((task) => now - task.updatedAt > TASK_KEEP_MS);
    const left = tasks.filter((task) => !stale.includes(task));
    const finished = left.filter((task) => FINISHED_STATUSES.has(task.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    const over = finished.slice(TASK_KEEP_FINISHED);
    const doomed = [...stale, ...over];
    for (const task of doomed) await this.remove(projectId, task.id);
    return doomed.map((task) => task.id);
  }
}

/** Removes every task kept for a project, when the project is removed. A database that cannot be reached leaves them: they name no project that exists. */
export async function dropTasksOf(projectId: string, db: AppDb | null = activeAppDb()): Promise<void> {
  if (db === null) return;
  try {
    for (const row of await db.list(taskPrefix(projectId))) await db.delete(row.key);
  } catch {
    // A task of a project that is gone is never read, so a failed sweep costs a few bytes and nothing else.
  }
}
