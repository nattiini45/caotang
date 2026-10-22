/**
 * Helpers the native tools share. Every function here is pure: none dispatches,
 * none writes, and none reads the clock.
 */

import {
  type CommandError,
  type CommandName,
  type Result,
  type ValidationSnapshot,
  ok,
  err,
} from '@caotang/bus';
import { countBody, getBody, type ProjectState, type TreeNode } from '@caotang/store';

import type { CallParams, CommandDone, PrepareContext } from '../types.js';

/**
 * The bus's own descriptors, under their registered names.
 *
 * `commands` is the descriptor namespace the bus exports for exactly this use: a
 * tool that prepares a batch needs each command's `validate`, and it must be the
 * bus's, not a copy of it. A registry passed in may swap an apply but not a
 * descriptor, so this reads from the harness's registry, which is the one the
 * runtime will dispatch through.
 */
export function descriptorOf(context: PrepareContext, name: CommandName) {
  return context.registry[name].descriptor;
}

/**
 * Run the bus's `validate` for one command, before any effect.
 *
 * Returns the bus's normalised params on success. On refusal, the bus's
 * `CommandError` comes back unchanged, which is the point: a tool reports what the
 * bus said, not a paraphrase of it.
 */
export function checkCommand(
  context: PrepareContext,
  name: CommandName,
  params: CallParams,
  snapshot: ValidationSnapshot = context.state,
): Result<CallParams, CommandError> {
  const result = descriptorOf(context, name).validate(params, snapshot);
  if (!result.ok) return err(result.error);
  return ok(result.value as CallParams);
}

/**
 * A snapshot that reflects the batch's earlier ops, for validating a later one.
 *
 * `binder.restructure` checks each op against the tree **as the ops before it
 * leave it**, so a move that would close a cycle created by an earlier move is
 * refused before anything runs. The projection changes only what a batch changes
 * (parents and titles); every other field is the project's own.
 */
export function projectedSnapshot(
  state: ProjectState,
  tree: readonly TreeNode[],
  documents: ValidationSnapshot['documents'] = state.documents,
): ValidationSnapshot {
  return {
    manifest: {
      tree,
      vocabulary: state.manifest.vocabulary,
      codex: state.manifest.codex,
    },
    documents,
  };
}

/**
 * A batch's per-op refusal, in the bus's shape (`batchRefusal` is not exported by
 * the bus, and this is the same envelope: `invalid-params`, the failures in
 * `details`, and a hint that says nothing was written).
 *
 * Each per-op failure keeps the details of the failure it reports, so what the op
 * said as data — the candidates an ambiguous name matched — survives the wrapping.
 * A caller that cannot see it can only read the prose, which §7 does not ask of
 * anyone.
 */
export function batchRefusal(
  failures: readonly { readonly target: string; readonly error: CommandError }[],
  total: number,
  correctiveHint: string,
): CommandError {
  const first = failures[0];
  return {
    code: 'invalid-params',
    message:
      failures.length === 1 && first !== undefined
        ? `batch refused: ${first.error.message}`
        : `batch refused: ${failures.length} of ${total} submitted ${total === 1 ? 'op' : 'ops'} failed validation`,
    correctiveHint,
    details: {
      failures: failures.map(({ target, error }) => ({
        target,
        code: error.code,
        message: error.message,
        ...(error.correctiveHint === undefined ? {} : { correctiveHint: error.correctiveHint }),
        ...(error.details === undefined ? {} : { details: error.details }),
      })),
    },
  };
}

/**
 * The plan-card line for an `always` include policy (codex.md §7): an always-included entry rides along
 * in every generation call, so the card says so before the writer approves it.
 */
export const ALWAYS_INCLUDE_FLAG = 'always-include affects every generation call';

/**
 * The flags a policy change carries onto a plan card. Called only when a create or an update sets
 * `includePolicy`, with the policy before it (`undefined` for a create). Flagged when the change sets
 * `always` or moves an entry off it, and empty otherwise.
 */
export function policyFlags(before: unknown, after: unknown): string[] {
  return before === 'always' || after === 'always' ? [ALWAYS_INCLUDE_FLAG] : [];
}

/** The words of a node. A document's count is the store's cache, falling back to a count of its body. */
export function wordsOfDocument(state: ProjectState, id: string): number {
  const cached = state.manifest.derived.wordCounts[id];
  if (cached !== undefined) return cached;
  return countBody(getBody(state, id)).words;
}

/** A document's body, read through the store's accessor, which answers `''` for an unknown id. */
export function bodyOf(state: ProjectState, id: string): string {
  return getBody(state, id);
}

export function titleOf(state: ProjectState, id: string): string {
  return state.manifest.tree.find((node) => node.id === id)?.title ?? id;
}

export function doneWith(done: readonly CommandDone[], name: CommandName): CommandDone | undefined {
  return done.find((entry) => entry.name === name);
}

/** The node id a `binder.create` reported. The bus names it in `affected`, which is always its first entry. */
export function createdNodeId(done: readonly CommandDone[]): string | undefined {
  const create = doneWith(done, 'binder.create');
  return create?.outcome.affected[0]?.nodeId;
}

