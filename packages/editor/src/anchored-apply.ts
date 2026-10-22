/**
 * [edit-anchors.md] §4 — **the application path**, and the one place the ladder is
 * allowed to change a document.
 *
 * ## What this module is
 *
 * §4, in full: *"The resolved range is applied through the command bus
 * `editor.replaceRange` primitive inside `scene.draft`'s compound apply (command-bus
 * §4 grant inheritance); the whole turn is one undo group (agent-harness §5), and the
 * doc body snapshot (project-format §8 write-ahead) is taken before the mutation."*
 *
 * **So this function does three things and delegates the fourth.**
 *
 * 1. **Resolve** the anchor, after awaiting the lazy library so step 3 is available
 *    (§4's lazy boundary — the apply path is the only caller for which "two rungs
 *    short" would be a real product defect).
 * 2. **Refuse or dispatch.** An `unresolvable` resolution becomes the §3 step 5
 *    ask-back payload and **dispatches nothing at all** — §3's zero-partial-effects
 *    and the sentence "never a silent fallback, never a guess", which is why this
 *    module has no branch that "tries the closest candidate anyway".
 * 3. **Carry the turn.** One `turnId` per agent turn, which is what §5's *"One agent
 *    turn = one undo group"* is mechanically: `undo.ts`'s `targetFor` keys a group's
 *    id on `(issuedBy: 'agent', turnId)` and hands the same id to every command in
 *    that turn. The identity is therefore not decoration — drop `turnId` and this
 *    dispatch mints its own group, and two anchored edits in one turn become two
 *    checkpoints the user has to press twice.
 * 4. **Delegated: the mutation, the write-ahead snapshot, and the lane.** All three
 *    belong to shipped code and are **not** re-implemented here, because a second
 *    implementation of one rule is how a format drifts:
 *    - `editor.replaceRange` is `undo: 'compensable'` and `guardsRevision: true`, so
 *      the store's apply (`packages/store/src/commands.ts`) captures the **prior
 *      body before it writes**, and the undo writes that body back as a new write,
 *      so the revision moves up and never back (command-bus.md §5). Taking a snapshot here as well would be a second capture of the same fact.
 *    - `expectedRevision` rides the params, which is §6's optimistic concurrency and
 *      §9's revision guard — the pipeline compares it before the apply, so a turn
 *      resolved against a body the document has since left is **refused**, not
 *      applied to the wrong text.
 *    - `issuedBy: 'agent'` is what makes this Lane 2. `lanes.ts` owns the
 *      transaction-side mark (`addToHistory: false` + `closeHistory`), and the
 *      agent-issued identity is the half the bus can see; the adapter's binding of
 *      that identity to `markLane` is the Tiptap adapter's row, not this one.
 *
 * ## Why the bus types are not imported
 *
 * `src/` imports nothing from `@caotang/bus` or `@caotang/store`, so the dependency
 * direction the corpus states — *"the bus never depends on the store; the store
 * depends on the bus"* — is not disturbed by a module that has to name a command's
 * shape. {@link AnchoredEditCommand} declares the fields this path sets, and the
 * test file pins it to the bus's own `Command<EditorReplaceRangeParams>` and drives
 * the whole apply path through a **real** `execute()` over a **real** store state,
 * so the declaration cannot drift from the thing it claims to be: a declaration
 * nothing dispatches satisfies every test written about it. Both packages are
 * `devDependencies` of `packages/editor` for that reason, and only for that.
 */
import {
  preloadAnchorLibraries,
  resolveAnchor,
  type AnchorCandidate,
  type AnchorMethod,
  type AnchorRange,
} from './edit-anchors.js';
import type { TextAnchor } from './seam.js';

/**
 * The command this path issues: §9's `editor.replaceRange` params, and the four
 * identity fields of [command-bus.md §2]'s `Command`.
 *
 * **`expectedRevision` is always present** — §6's guard is not optional for an
 * agent apply, because the whole point of the ladder is that the text may have
 * moved since the plan, and a dispatch that declined to check is the case the
 * ladder cannot help with.
 */
export interface AnchoredEditCommand {
  readonly id: string;
  readonly name: 'editor.replaceRange';
  readonly params: {
    readonly docId: string;
    readonly range: AnchorRange;
    readonly text: string;
    readonly expectedRevision: number;
  };
  readonly issuedBy: 'agent';
  readonly turnId: string;
  readonly callId?: string;
  readonly createdAt: number;
}

/**
 * The bus's `Result`, narrowed to the two arms a caller must distinguish: applied,
 * or refused with the refusal intact. **A refusal is returned, never swallowed and
 * never retried here** — §7's error shape and its corrective hint reach the model
 * through the harness, and a path that re-dispatched a refusal would be a second
 * opinion on a decision the pipeline already made.
 */
export type AnchoredEditResult =
  | { readonly ok: true; readonly value?: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly correctiveHint?: string;
        readonly details?: unknown;
      };
    };

/** `execute()`'s signature, narrowed. The harness passes the bus's own `execute`. */
export type AnchoredEditDispatch = (command: AnchoredEditCommand) => AnchoredEditResult;

export interface AnchoredEditRequest {
  /** edit-anchors §2's `TextAnchor`, captured at plan time. */
  readonly anchor: TextAnchor;
  readonly docId: string;
  /** The body as it stands **now** — the projection §3 resolves against. */
  readonly body: string;
  /** §9's `doc.revision` at apply time; the drift baseline and the revision guard. */
  readonly applyRevision: number;
  /** The agent's replacement text for the resolved range. */
  readonly text: string;
  /** agent-harness §5: one turn, one undo group. */
  readonly turnId: string;
  /** §6's idempotency key within the turn. */
  readonly callId?: string;
  /** Command ids belong to whoever mints them (`cmd_` + Crockford base32); the
   *  harness owns that namespace, exactly as it owns the revision a capture reads. */
  readonly id: string;
  readonly createdAt: number;
}

/**
 * Three outcomes, because §3's step 5 and §7's refusal are **different events** and
 * a caller that cannot tell them apart will render a recoverable drift as a crash.
 *
 * - `applied` — the range resolved and the command landed.
 * - `ask-back` — §3 step 5: nothing was written, and the payload is the one the
 *   structured ask-back offers to the user.
 * - `refused` — the bus refused (§7), carrying the command that was refused so the
 *   group id in `error.details` can be named.
 */
export type AnchoredEditOutcome =
  | {
      readonly status: 'applied';
      readonly method: AnchorMethod;
      readonly range: AnchorRange;
      readonly revisionDrift: number;
      readonly command: AnchoredEditCommand;
    }
  | {
      readonly status: 'ask-back';
      readonly reason: string;
      readonly candidates: readonly AnchorCandidate[];
      readonly revisionDrift: number;
    }
  | {
      readonly status: 'refused';
      readonly command: AnchoredEditCommand;
      readonly error: Extract<AnchoredEditResult, { ok: false }>['error'];
    };

/**
 * The apply path, §4's three sentences in order.
 *
 * **The library load happens before the resolution, not inside it**, so
 * `resolveAnchor` stays the synchronous function §3 declares and the one rung that
 * needs 30 KB is the only thing that pays for it. A caller who resolves without
 * awaiting the preload gets step 5's *named* two-rungs-short refusal instead of a
 * silent downgrade — and this function is the reason a product caller never sees it.
 */
export const applyAnchoredEdit = async (
  request: AnchoredEditRequest,
  dispatch: AnchoredEditDispatch,
): Promise<AnchoredEditOutcome> => {
  await preloadAnchorLibraries();
  const resolution = resolveAnchor(request.anchor, request.body, request.applyRevision);
  if (resolution.status === 'unresolvable') {
    return {
      status: 'ask-back',
      reason: resolution.reason,
      candidates: resolution.candidates,
      revisionDrift: resolution.revisionDrift,
    };
  }

  const command: AnchoredEditCommand = {
    id: request.id,
    name: 'editor.replaceRange',
    params: {
      docId: request.docId,
      // **The resolved range, never the anchor's own offsets.** A dispatch carrying
      // `anchor.from`/`anchor.to` would splice the right text into the wrong place,
      // which is the one outcome the ladder exists to prevent and the only bug here
      // that would be invisible in every other assertion.
      range: resolution.range,
      text: request.text,
      expectedRevision: request.applyRevision,
    },
    issuedBy: 'agent',
    turnId: request.turnId,
    ...(request.callId === undefined ? {} : { callId: request.callId }),
    createdAt: request.createdAt,
  };

  const result = dispatch(command);
  if (!result.ok) {
    return { status: 'refused', command, error: result.error };
  }
  return {
    status: 'applied',
    method: resolution.method,
    range: resolution.range,
    revisionDrift: resolution.revisionDrift,
    command,
  };
};

/**
 * §3 step 5's ask-back options, as data — agent-harness §3 tool 8's error column
 * names all three ("re-select in the editor / re-read via `doc.read` / drop the
 * step"), and §2 step 4 is the structured ask-back that renders them. Exported so
 * the option list is one declaration rather than three strings assembled at each
 * call site, which is the drift the corpus's own "two implementations of one rule"
 * argument is about.
 */
export const ASK_BACK_OPTIONS = [
  're-select the range in the editor',
  're-read the document with `doc.read` and re-plan the step',
  'drop the step',
] as const;