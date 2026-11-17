import { checkpointReadable, getBody, type GOAL_VERIFIER_UNAVAILABLE_CODES, type ProjectState } from '@caotang/store';

import { canonicalJson } from '../util.js';
import type { Reservation } from './budget.js';
import { documentsInScope } from './checks.js';
import type { GoalVerifierAdmission, GoalVerifierCallResult } from './goal-verifier-call.js';
import type { GoalVerifierInput, GoalVerifierSpec, GoalVerifierVerdict } from './goal-verifier.js';
import type { GoalCheckpoint } from './goal.js';

export type GoalVerifierCheck = GoalVerifierSpec & { readonly kind: 'verifier' };
export type GoalVerifierUnavailableCode = (typeof GOAL_VERIFIER_UNAVAILABLE_CODES)[number];

export interface GoalVerifierSource {
  readonly docId: string;
  readonly hash: string;
}

export interface GoalVerificationResult {
  readonly key: string;
  readonly iteration: number;
  readonly status: 'complete' | 'unavailable';
  readonly verdict?: GoalVerifierVerdict;
  readonly reason?: string;
  readonly code?: GoalVerifierUnavailableCode;
  readonly omitted: number;
  readonly truncated: boolean;
  readonly sources: readonly GoalVerifierSource[];
  readonly uncertainUsage?: true;
}

export interface PendingGoalVerification {
  readonly key: string;
  readonly iteration: number;
  readonly phase: 'prepared' | 'reserved' | 'settled';
  readonly input: GoalVerifierInput;
  readonly sources: readonly GoalVerifierSource[];
  readonly reservation?: Reservation;
  readonly uncertainUsage?: true;
}

export type GoalVerifierPort = (
  input: GoalVerifierInput,
  save: (admission: GoalVerifierAdmission) => Promise<void>,
  fence: () => void,
) => Promise<GoalVerifierCallResult>;

export { goalVerifierDefinitionProblem as goalVerifierSpecProblem } from '@caotang/store';

export function recoverGoalVerifierCheckpoint(saved: GoalCheckpoint): { readonly checkpoint: GoalCheckpoint; readonly uncertainUsage: boolean } {
  if (!checkpointReadable(saved)) throw new Error('The saved goal checkpoint cannot be read safely.');
  const pending = saved.pendingVerification;
  if (pending?.phase !== 'reserved' || pending.reservation === undefined) {
    return { checkpoint: saved, uncertainUsage: pending?.uncertainUsage === true || saved.verification?.uncertainUsage === true };
  }
  const { reservation, ...settled } = pending;
  const spend = { ...saved.spend };
  spend.promptTokens += reservation.promptTokens;
  spend.completionTokens += reservation.maxOutputTokens;
  spend.estimatedTokens += reservation.promptTokens + reservation.maxOutputTokens;
  if (reservation.price !== undefined) spend.costUsd = (spend.costUsd ?? 0) + (reservation.promptTokens * reservation.price.prompt + reservation.maxOutputTokens * reservation.price.completion) / 1000;
  const limits = saved.goal.limits;
  if (limits.maxTokens !== undefined) {
    const prompt = Math.max(spend.promptTokens, limits.maxTokens - spend.completionTokens);
    spend.estimatedTokens += prompt - spend.promptTokens;
    spend.promptTokens = prompt;
  }
  if (limits.maxCostUsd !== undefined) spend.costUsd = Math.max(spend.costUsd ?? 0, limits.maxCostUsd);
  if (limits.maxActiveMs !== undefined) spend.activeMs = Math.max(spend.activeMs, limits.maxActiveMs);
  const checkpoint: GoalCheckpoint = { ...saved, spend, pendingVerification: { ...settled, phase: 'settled', uncertainUsage: true } };
  if (!checkpointReadable(checkpoint)) throw new Error('The verifier reservation cannot be recovered safely.');
  return { checkpoint, uncertainUsage: true };
}

export function snapshotGoalVerifierState(state: ProjectState): ProjectState {
  return {
    ...state,
    manifest: { ...state.manifest, tree: state.manifest.tree.map(node => ({ ...node })) },
    documents: new Map([...state.documents].map(([id, record]) => [id, { ...record }])),
    ...(state.coherence === undefined ? {} : { coherence: { ...state.coherence, reviewState: structuredClone(state.coherence.reviewState) } }),
  };
}

export async function goalVerifierSources(
  spec: GoalVerifierSpec,
  ids: readonly string[],
  state: ProjectState,
  withheld: () => ReadonlySet<string>,
): Promise<{ readonly sources: readonly GoalVerifierSource[]; readonly fence: () => void }> {
  const scope = spec.scope.mode === 'changed' ? { mode: 'full' } as const : spec.scope;
  const nodes = documentsInScope(state, scope, withheld()).nodes;
  const captured = [...new Set(ids)].map(docId => {
    const node = nodes.find(candidate => candidate.id === docId);
    if (node === undefined || !state.documents.has(docId)) throw new Error('The verifier passages are no longer readable in their scope.');
    return { docId, title: node.title, synopsis: node.synopsis, status: node.status, body: getBody(state, docId) };
  });
  const sources = await Promise.all(captured.map(async value => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value))));
    return { docId: value.docId, hash: [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  }));
  const fence = (): void => {
    const current = documentsInScope(state, scope, withheld()).nodes;
    for (const value of captured) {
      const node = current.find(candidate => candidate.id === value.docId);
      if (node === undefined || !state.documents.has(value.docId) || node.title !== value.title || node.synopsis !== value.synopsis || node.status !== value.status || getBody(state, value.docId) !== value.body) {
        throw new Error('The verifier passages changed or are no longer readable in their scope.');
      }
    }
  };
  fence();
  return { sources, fence };
}
