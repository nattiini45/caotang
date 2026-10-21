/**
 * `execute()` — §3's pipeline, in the order §3 fixes it.
 *
 * ```
 * validate → permission gate (§4) → apply → postconditions → undo-group registration (§5)
 *         → activity-log append (§8) → subscriber notification
 * ```
 *
 * ## The order is the contract, and three things about it are not obvious
 *
 * 1. **Resolution runs before `validate`, and is not one of the seven steps.**
 *    §3's order starts at `validate`, but a name with no implementation cannot
 *    be run through a pipeline, and `resolveIn` already refuses it with §7's
 *    model-facing shape. Running it first means an unimplemented name is refused
 *    *before* a snapshot is read to feed a validator whose answer would be thrown
 *    away — and it is the one place a name that arrived as data (v0.2's
 *    `mcp.invoke`) gets a `not-found` rather than a crash.
 * 2. **A postcondition failure does not short-circuit steps 5 and 6.** §7:
 *    *"Postcondition failure is never silently auto-undone … the undo group stays
 *    intact and user-reversible either way."* So the postconditions are checked
 *    where §3 puts them — immediately after `apply`, before registration — and
 *    the *verdict* is carried to the end, past the registration and the log
 *    append. Returning at step 4 would leave a mutated document that nothing can
 *    undo, which is the outcome that sentence exists to prevent.
 * 3. **Subscriber notification is not attempted when a postcondition failed.**
 *    §3's seventh step is a *post-commit* notification, and a command whose
 *    postcondition failed did not commit cleanly: §7 hands the retry-vs-report
 *    decision to the harness's verify ladder, and a retry re-dispatches and
 *    notifies then. The log row is written either way, so nothing is hidden.
 * 4. **§8's row is written from the apply's report, and a missing one is a
 *    refusal rather than a row with an empty digest.** `summary` and `affected`
 *    are required fields of §8's interface and the bus can fill neither — it does
 *    not own project state (§1), and its snapshot was read *before* the apply, so
 *    a rename's row would carry the title the node used to have and a delete's
 *    row could not carry one at all. So the apply reports, once, and the check
 *    runs **after** step 5 for the same reason step 5 runs where it does: a
 *    refusal that fires before registration would strand a committed effect that
 *    nothing can reverse. One report feeds two consumers — the row and
 *    `ExecutionOutcome.affected`, §3's *"command id + affected node ids"* — and
 *    they are the **same array**, because two assemblies of one declaration is
 *    the drift this repo keeps finding.
 *
 * ## "Zero partial effects", stated to the step that can honour it
 *
 * §3: *"Failure at any step aborts with zero partial effects (validate-first
 * discipline)."* That is exactly true of steps 1–2 and of the two refusals in
 * step 5, and it cannot be true of step 7 — the effect is committed before a
 * subscriber runs. Where the bus *can* honour it, it does: a refusal at the
 * name, at `validate` or at the gate reads no state, writes nothing, appends no
 * row and registers nothing. After `apply` the bus's remaining duty is to leave
 * the user able to get back, so **every post-apply refusal carries the undo group
 * id in `details`** — §7's own `details` field, added.
 *
 * **One post-apply refusal cannot name a group, and it is the honest limit rather
 * than an oversight.** §5's registration refusal fires *because* the apply handed
 * over nothing to register, so there is no group to name and it behaves like a
 * pre-apply refusal on the `details` field. **§8's report refusal is not that
 * case** — it fires for a
 * missing `summary`, but it runs *after* step 5, so a dispatch whose apply
 * captured an `inverse` or a `compensate` has a real group and the refusal names
 * it. Measured, one captured `compensable`:
 * `details` is `{"commandId":…,"undoGroupId":"grp_1"}`; an uncaptured one is
 * `{"commandId":…}`. So the group is absent exactly when registration registered
 * nothing — `undo: 'none'`, or a `mutates: 'view'` command — and present for
 * every mutating project command, which is all of them except the view three.
 * The other four post-apply refusals — the thenable apply, the throwing apply,
 * the postcondition verdict and the throwing subscriber — all name the group
 * when there is one. **Five post-apply refusals exist**, and the one that cannot name a group is the
 * one that exists because a required hand-off was missing.
 *
 * ## §6 adds one step before the effect and one lookup before all of them
 *
 * `execute()` is §3's seven steps, plus two things §6 owns. Both sit outside the
 * seven because §3 does not mention them, and both are placed so that the
 * pipeline's stated guarantees keep their exact force:
 *
 * - **The `callId` lookup is the first thing that happens**, before resolution.
 *   A replay has already been decided, so there is nothing to validate, gate,
 *   compare, apply, register, log or notify. It returns the earlier result as-is,
 *   carrying that dispatch's own `commandId` and `undoGroupId` — a replay is not
 *   a second command and must not invent a group id that names no group.
 * - **The conflict check sits between the gate and `apply`**: the last point at
 *   which a refusal still has §3's *"zero partial effects"*. It reads the same
 *   snapshot `validate` read. The bus is synchronous (A2), so no writer can run
 *   between the two reads, and a second read would move a counter the ordering
 *   tests assert.
 *
 * **The cache boundary is the effect boundary, and it is one line wide.** `dispatch()`
 * is exactly the part that ran an apply; everything above it did not.
 * `idempotency.record` is called once, on `dispatch()`'s return, so no post-apply
 * path can forget to be recorded — recording at each of the six returns inside
 * `dispatch()` would be a guard with six chances to be missing one, which is the
 * shape of defect this repo has now found four times in guards and zero times in
 * "the one place that decides".
 *
 * ## Two entry points, one pipeline (extensibility §6)
 *
 * `execute()` is the synchronous bus, A2, and it refuses an apply that returns a
 * promise, as it always has. A command declared `asyncApply` is refused before
 * anything runs, because an apply that starts its effect and is only then found to
 * be asynchronous has already changed the world; the refusal names `executeAsync`.
 * `executeAsync()` runs the same steps and awaits that
 * promise. It exists for the one command whose apply reaches outside the process,
 * `mcp.invoke`, and the bus's own header said it would be widened "in the slice that
 * needs it". Both share `admit()` (steps 0–2 and the conflict check) and `finish()`
 * (steps 4–7), so the two cannot disagree about what a command is allowed to do.
 *
 * An apply that refuses on purpose throws an {@link ApplyRefusal}. The bus returns
 * the refusal it carries rather than an `internal` defect, and the report the apply
 * made, if any, is still written as the row for the attempt (command-bus §8).
 *
 * ## Per-call risk and the row's source
 *
 * A descriptor may declare `agentRiskOf`, and then the gate reads the risk of the
 * call the command names, from the normalized params `validate` returned. A
 * descriptor may also declare `activitySource`, which every row it writes carries
 * whatever the caller passed. Neither can be set by a caller's params.
 *
 * ## `bus` carries eight things, and none of them is the store
 *
 * `state`, `view`, `read`, `permission`, `undo`, `log`, `idempotency`, `notify`.
 * The bus does
 * not own project state (§1) and does not import `@caotang/store` (the dependency
 * runs store → bus), so `read` is a **seam** the caller closes over its own
 * state — the same move the store makes for the autosave clock, and for the same reason:
 * a clock read from a global is a clock no test can control.
 */

import { err, ok, type CommandError, type PerOpFailure, type Result } from './result.js';
import type {
  ApplyContext,
  Command,
  CommandApply,
  CommandDescriptor,
  CommandName,
  CommandRegistry,
  CommandStateFor,
  UndoPayload,
  ValidationSnapshot,
  ViewState,
} from './command.js';
import { COMMAND_REGISTRY, lookupIn, resolveIn, type ResolvedRegistration } from './registry.js';
import { checkPermission, type PermissionContext, type PermissionGrant } from './permission.js';
import {
  applyContext,
  createUndoScope,
  type UndoEntry,
  type UndoStore,
  type UndoTarget,
} from './undo.js';
import { isViewState } from './view.js';
import { isRecord } from './params.js';
import { createActivityScope, type ActivityAffected, type ActivityReport, type ActivitySource } from './activity-log.js';
import type { ActivityLog } from './activity-log.js';
import type { IdempotencyCache } from './idempotency.js';

export interface BusContext<S = unknown> {
  /** what a `mutates: 'project'` apply mutates; the store-side caller narrows it */
  readonly state: S;
  /** what a `mutates: 'view'` apply mutates (§2: ephemeral, never persisted) */
  readonly view: ViewState;
  /**
   * The read seam. Called once for `validate` — the snapshot is **hoisted** and
   * reused by §6's conflict check, because the bus is synchronous (A2) — and a
   * second time only when the descriptor declares postconditions, so the
   * post-apply read cannot be a read of state the apply has not committed.
   */
  readonly read: () => ValidationSnapshot;
  /** §4's flow facts: an approved plan, a confirm card, an inherited grant */
  readonly permission?: PermissionContext;
  readonly undo: UndoStore;
  readonly log: ActivityLog;
  /**
   * §6's per-turn `callId` dedupe. **Required, not optional**, unlike
   * `permission`: §4's flow facts are legitimately absent, but §6's guarantee is
   * unconditional, and an optional field would let a caller build a bus that
   * silently drops it — the same trade `notify` makes explicit, for the same
   * reason.
   */
  readonly idempotency: IdempotencyCache;
  /** §3's seventh step. Required, not optional: see the module header. */
  readonly notify: (outcome: ExecutionOutcome) => void;
}

export interface ExecutionOutcome {
  readonly commandId: string;
  readonly name: CommandName;
  /** the *normalized* params `validate` returned, not what the caller submitted */
  readonly params: unknown;
  /** whatever `apply` returned */
  readonly result: unknown;
  /** §4's answer, carried so a log row or a plan card can say how it was allowed */
  readonly grant: PermissionGrant;
  /** §5's group, when one was registered into */
  readonly undoGroupId?: string;
  /**
   * §3's seventh step: the **same array** the log row carries, not a second
   * assembly of the apply's report. A subscriber re-renders *from the store* using
   * these ids (§3), so what it needs is the node list, not the titles and not the
   * params.
   */
  readonly affected: readonly ActivityAffected[];
  /** the `describe` of each postcondition that ran and held */
  readonly postconditions: readonly string[];
}

/**
 * A refusal an apply raises on purpose, as opposed to a defect it throws by accident.
 *
 * An apply that knows its refusal and its corrective path throws this with the error the caller should get, and the bus
 * returns that error unchanged. Both entry points do so: `execute()` for a synchronous apply (the exporter's refusals are
 * thrown from its compile plan, before anything is reserved) and `executeAsync()` for an awaited one (`mcp.invoke` reaches an
 * external server). Any other throw is a defect, and the bus reports it as `internal`.
 */
export class ApplyRefusal extends Error {
  readonly error: CommandError;

  constructor(error: CommandError) {
    super(error.message);
    this.name = 'ApplyRefusal';
    this.error = error;
  }
}

/** Everything a caller needs in order to get back to where it was, in §7's `details`. */
function recoverable(command: Command, groupId: string | undefined): CommandError['details'] {
  return { commandId: command.id, ...(groupId === undefined ? {} : { undoGroupId: groupId }) };
}

/**
 * The activity row for a post-apply refusal that left an effect in place
 * (command-bus §8). A refusal is not a reason to leave the log silent about a
 * change: the row is what the success path would have written for the same
 * dispatch, with the report if the apply made one and the bus's own words if it
 * did not. Nothing about it is a claim the apply did not make.
 */
function effectRow<S>(
  bus: BusContext<S>,
  command: Command,
  source: ActivitySource,
  groupId: string | undefined,
  report: ActivityReport | undefined,
  digest: string,
): void {
  bus.log.append({
    at: command.createdAt,
    command: command.name,
    issuedBy: command.issuedBy,
    turnId: command.turnId,
    callId: command.callId,
    undoGroupId: groupId,
    source,
    affected: report?.affected ?? [],
    summary: report?.summary ?? digest,
  });
}

/**
 * A capture that arrived after its dispatch settled: an apply that stashed the
 * undo scope and captured from a timer, an event or a floating continuation.
 * The registration for this dispatch is closed, so the payload cannot join any
 * group — and a raw throw from the capturing callback would escape as an
 * uncaught exception nobody routes back to the caller. The activity log is the
 * surface where the pipeline reports an apply's defects after the fact (§8), so
 * that is where the late capture is reported: dropped and named.
 *
 * **One row per dispatch, and the first late capture is the one reported.**
 * §8's "one entry per executed command" is about the rows that report an
 * effect, and a defect row is not an effect: it carries the `defect` marker,
 * so a reader counting command rows can tell the two apart. The cap is what
 * keeps a scope stashed on a high-frequency timer from writing a row per
 * capture into a session-lifetime log — the defect is the capture, not how
 * many there were.
 */
function lateCaptureReporter<S>(
  bus: BusContext<S>,
  command: Command,
  source: ActivitySource,
): (payload: UndoPayload) => void {
  let reported = false;
  return (payload) => {
    if (reported) return;
    reported = true;
    bus.log.append({
      at: command.createdAt,
      command: command.name,
      issuedBy: command.issuedBy,
      turnId: command.turnId,
      callId: command.callId,
      undoGroupId: undefined,
      source,
      affected: [],
      defect: 'late-undo-capture',
      summary: `the apply for "${command.name}" captured an undo payload of kind "${payload.kind}" after its dispatch settled; it was dropped, because this dispatch's undo registration is closed, and any further late capture for this dispatch is dropped the same way`,
    });
  };
}

/**
 * The one cast in this file, and it is TypeScript's limitation rather than the
 * design's: `CommandRegistry[K]` for an unresolved `K` is a union of eighteen
 * registrations, and **a union of call signatures is not callable**. The state
 * type (`CommandStateFor<K>`) is kept — that is the part a caller benefits from —
 * while the params are `unknown`, which is safe because they came out of
 * `validate`, and §2's own invariant is that a command which passed validation
 * cannot fail mid-apply for validation reasons. The runtime guarantee is
 * `resolveIn`'s: it returns a registration that has an `apply`.
 */
function runApply<K extends CommandName>(
  registration: ResolvedRegistration<K>,
  state: CommandStateFor<K>,
  params: unknown,
  context: ApplyContext,
): unknown {
  const apply = registration.apply as CommandApply<unknown, unknown>;
  return apply(state, params, context);
}

/** What `admit()` hands the apply step: the registration, the normalized params, the grant and the state to apply to. */
interface Admitted<K extends CommandName> {
  readonly resolved: ResolvedRegistration<K>;
  readonly params: unknown;
  readonly grant: PermissionGrant;
  readonly target: CommandStateFor<K>;
  /** The source the command's rows carry: the descriptor's fixed source when it has one, else the caller's. */
  readonly rowSource: ActivitySource;
}

/**
 * Steps 0–2, the conflict check and the view-state check: everything that runs before an apply, and every
 * refusal that leaves zero partial effects. Nothing is recorded here, because a refusal before the apply is
 * one a later call may legitimately answer differently.
 */
function admit<K extends CommandName>(
  command: Command,
  bus: BusContext<CommandStateFor<K>>,
  registry: CommandRegistry,
  source: ActivitySource,
): { readonly refused: Result<ExecutionOutcome, CommandError> } | { readonly admitted: Admitted<K> } {
  // Step 0 — resolution. Not one of §3's seven; see the module header.
  const resolved = resolveIn(registry, command.name);
  if (!resolved.ok) return { refused: resolved };
  const { descriptor } = resolved.value;

  // Step 1 — validate. Pure, total, before any effect (§2). The snapshot is
  // hoisted so §6's conflict check compares against the same read, which is the
  // only read the common path makes.
  const snapshot = bus.read();
  const validated = descriptor.validate(command.params, snapshot);
  if (!validated.ok) return { refused: validated };

  // Step 2 — the permission gate (§4). No I/O, no clock, no registry read. The risk it reads is the
  // command's, or the risk of the one call it names when the descriptor says so (`agentRiskOf`).
  const risk = descriptor.agentRiskOf?.(validated.value) ?? descriptor.agentRisk;
  const granted = checkPermission({ agentRisk: risk }, command, bus.permission);
  if (!granted.ok) return { refused: granted };

  // §6's optimistic concurrency: the last refusal that still has §3's zero
  // partial effects. Disjoint from the wiring check below — only a
  // `guardsRevision` command reaches this one, only `mutates: 'view'` that one.
  if (descriptor.guardsRevision !== undefined) {
    const conflict = revisionConflict(command, validated.value, snapshot);
    if (conflict !== undefined) return { refused: err(conflict) };
  }

  // Which state an apply receives. §2's `mutates` is the only value that changes
  // it, and the cast is guarded by `isViewState` on the line above it: a type is
  // not a runtime guarantee, and the alternative is a project state being handed
  // a `view.setSelection`.
  let target: CommandStateFor<K> = bus.state;
  if (descriptor.mutates === 'view') {
    if (!isViewState(bus.view)) {
      return {
        refused: err({
          code: 'internal',
          message: `"${command.name}" mutates view state and the bus was given something that is not a view state, so it was not applied and nothing was written.`,
          target: command.name,
          correctiveHint:
            "build the bus context with createViewState() from @caotang/bus and pass it as `view`; a project state here would be written to by a selection or a scroll offset",
        }),
      };
    }
    target = bus.view as CommandStateFor<K>;
  }

  // The same limitation as `runApply`'s cast: the name is `CommandName` here, and the `K` the caller carries
  // is the one its own state type was written for. The runtime guarantee is `resolveIn`'s.
  return {
    admitted: {
      resolved: resolved.value as unknown as ResolvedRegistration<K>,
      params: validated.value,
      grant: granted.value,
      target,
      rowSource: descriptor.activitySource ?? source,
    },
  };
}

/**
 * `execute()` — the synchronous bus (A2). An apply that returns a promise is refused, as §3 requires, and the
 * refusal says what to do instead. Use {@link executeAsync} for a command whose apply is asynchronous.
 */
export function execute<K extends CommandName>(
  command: Command,
  bus: BusContext<CommandStateFor<K>>,
  registry: CommandRegistry = COMMAND_REGISTRY,
  source: ActivitySource = 'native',
): Result<ExecutionOutcome, CommandError> {
  // §6's callId dedupe, before everything including resolution. A replay has
  // already been decided; see the module header.
  const replay = bus.idempotency.lookup(command);
  if (replay !== undefined) return replay;

  // A command declared asynchronous is refused before admission, so nothing is gated, validated or applied. Were it
  // admitted, its apply would start (and, for `mcp.invoke`, reach the server) before the promise it returns was seen.
  const declared = lookupIn(registry, command.name);
  if (declared.ok && declared.value.descriptor.asyncApply === true) return err(asyncApplyRefusal(command.name));

  const admission = admit(command, bus, registry, source);
  if ('refused' in admission) return admission.refused;

  // §3's step 3 onward: from this line the dispatch can have effects, and only
  // this line's return is recorded by §6's cache.
  const { resolved, params, grant, target, rowSource } = admission.admitted;
  const result = dispatch(command, resolved, params, grant, target, bus, rowSource);
  bus.idempotency.record(command, result);
  return result;
}

/**
 * `executeAsync()` — the same pipeline, awaiting an apply that returns a promise (extensibility
 * §6). The apply is the only async boundary, so everything before it is decided synchronously, exactly as in
 * {@link execute}. A caller that dispatches the same `callId` again while the first dispatch is still running
 * gets the first one's answer only once that answer is recorded: the in-flight case is not deduplicated.
 */
export async function executeAsync<K extends CommandName>(
  command: Command,
  bus: BusContext<CommandStateFor<K>>,
  registry: CommandRegistry = COMMAND_REGISTRY,
  source: ActivitySource = 'native',
): Promise<Result<ExecutionOutcome, CommandError>> {
  const replay = bus.idempotency.lookup(command);
  if (replay !== undefined) return replay;

  const admission = admit(command, bus, registry, source);
  if ('refused' in admission) return admission.refused;

  const { resolved, params, grant, target, rowSource } = admission.admitted;
  const result = await dispatchAsync(command, resolved, params, grant, target, bus, rowSource);
  bus.idempotency.record(command, result);
  return result;
}

/** §3's steps 3–7 for a synchronous apply, and nothing else (see the module header). */
function dispatch<K extends CommandName>(
  command: Command,
  resolved: ResolvedRegistration<K>,
  params: unknown,
  grant: PermissionGrant,
  target: CommandStateFor<K>,
  bus: BusContext<CommandStateFor<K>>,
  source: ActivitySource,
): Result<ExecutionOutcome, CommandError> {
  const { descriptor } = resolved;

  // Step 3 — apply.
  const scope = createUndoScope(descriptor.undo, lateCaptureReporter(bus, command, source));
  const activity = createActivityScope(command.name);
  const undoTarget: UndoTarget = bus.undo.targetFor(command, command.createdAt);

  // An apply that *threw* is after the effect and past every guarantee the bus
  // has. The one thing still within its power is to leave the user able to get
  // back, so the capture is registered and the group is named in the error.
  let applied: unknown;
  try {
    applied = runApply(resolved, target, params, applyContext(command, scope, activity));
  } catch (thrown) {
    // A refusal the apply raised on purpose is the refusal it carries, on both entry points (see `ApplyRefusal`).
    if (thrown instanceof ApplyRefusal) return applyRefused(command, descriptor, scope, activity, undoTarget, bus, source, thrown);
    return applyThrew(command, descriptor, scope, activity, undoTarget, bus, source, thrown);
  }

  // An apply that returned a thenable is *after* the effect and outside A2
  // ("Synchronous in-process bus; async only inside command apply"). §3 says the
  // async boundary inside an apply "is awaited by it" — which an `async` apply
  // cannot be from here — so the bus refuses loudly, registers whatever the apply
  // managed to capture, and hands both back. Dropping the compensation here would
  // leave a half-applied effect that nothing can reverse.
  if (isThenable(applied)) {
    // The promise is dropped here. Its rejection gets a handler, because an unhandled rejection would fail the process
    // and the refusal below already tells the caller what went wrong. (The effect is the apply's; see above.)
    void Promise.resolve(applied).catch(() => undefined);
    return applyReturnedPromise(command, descriptor, scope, activity, undoTarget, bus, source);
  }

  return finish(command, descriptor, params, grant, applied, scope, activity, undoTarget, bus, source);
}

/**
 * The refusal for an asynchronous command dispatched through the synchronous bus. It is returned before any work, so
 * nothing was validated, approved, applied or written, and there is no row or undo entry to name.
 */
function asyncApplyRefusal(name: CommandName): CommandError {
  return {
    code: 'internal',
    message: `"${name}" has an asynchronous apply, which execute() cannot await, so it was refused before anything ran. Its call must go through executeAsync, which awaits the apply. Nothing was validated, approved, applied or written.`,
    target: name,
    correctiveHint: `dispatch "${name}" through executeAsync(), which awaits its apply; do not retry it through execute()`,
  };
}

/** §3's steps 3–7 for an apply that may be asynchronous: the same steps, with the apply awaited. */
async function dispatchAsync<K extends CommandName>(
  command: Command,
  resolved: ResolvedRegistration<K>,
  params: unknown,
  grant: PermissionGrant,
  target: CommandStateFor<K>,
  bus: BusContext<CommandStateFor<K>>,
  source: ActivitySource,
): Promise<Result<ExecutionOutcome, CommandError>> {
  const { descriptor } = resolved;

  const scope = createUndoScope(descriptor.undo, lateCaptureReporter(bus, command, source));
  const activity = createActivityScope(command.name);
  const undoTarget: UndoTarget = bus.undo.targetFor(command, command.createdAt);

  let applied: unknown;
  try {
    applied = await runApply(resolved, target, params, applyContext(command, scope, activity));
  } catch (thrown) {
    if (thrown instanceof ApplyRefusal) return applyRefused(command, descriptor, scope, activity, undoTarget, bus, source, thrown);
    return applyThrew(command, descriptor, scope, activity, undoTarget, bus, source, thrown);
  }

  return finish(command, descriptor, params, grant, applied, scope, activity, undoTarget, bus, source);
}

/**
 * An apply that refused on purpose, after the apply ran. The refusal it carries is what the caller gets. If the
 * apply reported what it did, that is the row for the attempt, and an effect it captured is registered and named
 * (the same discipline as a throw), so the refusal never hides a change the user could not undo.
 */
function applyRefused<S>(
  command: Command,
  descriptor: Pick<CommandDescriptor, 'mutates' | 'undo'>,
  scope: ReturnType<typeof createUndoScope>,
  activity: ReturnType<typeof createActivityScope>,
  undoTarget: UndoTarget,
  bus: BusContext<S>,
  source: ActivitySource,
  refusal: ApplyRefusal,
): Result<ExecutionOutcome, CommandError> {
  // The apply window is closed before the registration, not after it:
  // `bus.undo` is caller-supplied, so a registration that threw would escape
  // with the scope still open, and a capture arriving later would hit exactly
  // the raw second-capture throw the settle exists to prevent. `captured()`
  // cannot throw, so the read is safe and the settle sits right behind it — the
  // order `finish` uses.
  const payload = scope.captured();
  scope.settle();
  const groupId = registerIfCaptured(command, descriptor, payload, undoTarget, bus.undo);
  const report = activity.reported();
  if (groupId !== undefined || report !== undefined) {
    effectRow(bus, command, source, groupId, report, `${command.name} was refused after it reported an attempt`);
  }
  const details = refusal.error.details ?? {};
  return err({ ...refusal.error, details: { ...details, ...recoverable(command, groupId) } });
}

/**
 * An apply that threw. It is after the effect and past every guarantee the bus has, so the one thing still
 * within its power is to leave the user able to get back: the capture is registered, and the group is named.
 */
function applyThrew<S>(
  command: Command,
  descriptor: Pick<CommandDescriptor, 'mutates' | 'undo'>,
  scope: ReturnType<typeof createUndoScope>,
  activity: ReturnType<typeof createActivityScope>,
  undoTarget: UndoTarget,
  bus: BusContext<S>,
  source: ActivitySource,
  thrown: unknown,
): Result<ExecutionOutcome, CommandError> {
  // When a group was registered the effect is known to exist and reversible, so the
  // refusal also writes the row its success would have written (command-bus §8):
  // a change the log does not show is the one the user cannot find.
  const payload = scope.captured();
  scope.settle();
  const groupId = registerIfCaptured(command, descriptor, payload, undoTarget, bus.undo);
  if (groupId !== undefined) {
    effectRow(bus, command, source, groupId, activity.reported(), `${command.name} threw after changing the project`);
  }
  return err({
    code: 'internal',
    message: `the apply for "${command.name}" threw: ${thrown instanceof Error ? thrown.message : String(thrown)}. ${groupId === undefined ? 'Nothing was written to the activity log.' : `Whatever it changed before throwing is registered for undo as ${groupId}, and the activity log has a row for it.`}`,
    target: command.name,
    details: recoverable(command, groupId),
    correctiveHint:
      'this is a defect in the apply, not a refusal the bus made — inspect the store before retrying, because the command may already have written part of its effect',
  });
}

/** A synchronous apply that returned a promise: refused, after registering whatever it captured (see `dispatch`). */
function applyReturnedPromise<S>(
  command: Command,
  descriptor: Pick<CommandDescriptor, 'mutates' | 'undo'>,
  scope: ReturnType<typeof createUndoScope>,
  activity: ReturnType<typeof createActivityScope>,
  undoTarget: UndoTarget,
  bus: BusContext<S>,
  source: ActivitySource,
): Result<ExecutionOutcome, CommandError> {
  const payload = scope.captured();
  scope.settle();
  const groupId = registerIfCaptured(command, descriptor, payload, undoTarget, bus.undo);
  if (groupId !== undefined) {
    effectRow(bus, command, source, groupId, activity.reported(), `${command.name} returned a promise after changing the project`);
  }
  return err({
    code: 'internal',
    message: `the apply for "${command.name}" returned a promise, and the command bus is synchronous, so the pipeline could not check its postconditions or finish the dispatch. ${groupId === undefined ? 'Nothing was written to the activity log.' : `Whatever it changed is registered for undo as ${groupId}, and the activity log has a row for it.`}`,
    target: command.name,
    details: recoverable(command, groupId),
    correctiveHint:
      'make the apply synchronous and await its own async boundary inside it (§3), or dispatch it through executeAsync — do not retry: the effect may already be half applied',
  });
}

/**
 * §3's steps 4–7, after an apply has returned a value. The same code for both entry points, so a command's
 * postconditions, undo registration, row and notification cannot differ between the synchronous and the
 * asynchronous bus.
 */
function finish<S>(
  command: Command,
  descriptor: CommandDescriptor<unknown>,
  params: unknown,
  grant: PermissionGrant,
  applied: unknown,
  scope: ReturnType<typeof createUndoScope>,
  activity: ReturnType<typeof createActivityScope>,
  undoTarget: UndoTarget,
  bus: BusContext<S>,
  source: ActivitySource,
): Result<ExecutionOutcome, CommandError> {
  const payload = scope.captured();
  // The payload is read, so the apply window is closed: a capture arriving after
  // this point belongs to no dispatch and is reported rather than registered.
  scope.settle();

  // Step 4 — postconditions (§2), where §3 puts them: straight after apply.
  const postconditions = descriptor.postconditions ?? [];
  const failedPostconditions =
    postconditions.length === 0
      ? []
      : postconditions.filter((check) => !check.assert(bus.read())).map((check) => check.describe);

  // Step 5 — undo-group registration (§5). A project command whose descriptor
  // declares a compensation, and nothing else. §2's view clause and §9's
  // `undo: 'none'` are two ways of saying the same thing, and the view clause
  // wins: a view command is never persisted, so there is nothing to restore.
  let groupId: string | undefined;
  if (descriptor.mutates !== 'view' && descriptor.undo !== 'none') {
    const declared = descriptor.undo;
    const refusal = registrationRefusal(command.name, declared, payload);
    if (refusal !== undefined) {
      // The apply ran, so the effect is in place whether or not it can be undone:
      // the row says so, with what the apply reported (command-bus §8).
      effectRow(bus, command, source, undefined, activity.reported(), `${command.name} changed the project without registering an undo`);
      // A replayed refusal names the group it was replaying into, because that group
      // exists; a fresh one names no group, because none was registered.
      return err({ ...refusal, details: recoverable(command, undoTarget.replay ? undoTarget.id : undefined) });
    }
    groupId = bus.undo.register(undoTarget, entryFor(command, payload!));
  } else if (undoTarget.replay) {
    // A replayed command that registers nothing still belongs to the group being
    // undone, so §5's checkpoint row and the log agree about it.
    groupId = undoTarget.id;
  }

  // Step 6 — the activity-log append's precondition. §8 types `summary` and
  // `affected` as required and the bus can fill neither, so a dispatch whose apply
  // reported nothing has no honest row to write. It runs **here**, after step 5,
  // for the reason step 5 runs where it does: a refusal placed before
  // registration would strand a committed effect nothing can reverse. The two
  // refusals are the same shape — a required hand-off the apply did not make — and
  // neither can name a group, because the one that is missing is why it fired.
  const report = activity.reported();
  if (report === undefined) {
    // The apply completed, so the effect is in place: the row records it with the
    // one thing the bus can say honestly — that nothing was reported about it.
    effectRow(bus, command, source, groupId, undefined, `${command.name} changed the project and did not report what it changed`);
    return err({
      code: 'internal',
      message: `the apply for "${command.name}" ran and changed something, but it did not report what it changed, so the activity log's row for it has no affected list and says nothing was reported. ${groupId === undefined ? 'Nothing was registered for undo.' : `Whatever it changed is registered for undo as ${groupId}.`}`,
      target: command.name,
      details: recoverable(command, groupId),
      correctiveHint:
        "this is a defect in the apply, not a refusal the bus made — call context.report({ affected, summary }) once, after the undo capture, or §8's digest and affected list are missing from the log",
    });
  }

  // Step 6 — activity-log append (§8). One entry per *executed* command.
  bus.log.append({
    at: command.createdAt,
    command: command.name,
    issuedBy: command.issuedBy,
    turnId: command.turnId,
    callId: command.callId,
    undoGroupId: groupId,
    // The caller's source, as `execute()` was given it. §8 reserves `'mcp'` for the
    // v0.2 external client; the default is `'native'`. Stamped, not omitted.
    source,
    // The *same array* the outcome carries, so §8's row and §3's notification
    // cannot disagree about what the command touched.
    affected: report.affected,
    summary: report.summary,
  });

  // Step 4's verdict, reported here for §7's reason — the group is intact above.
  if (failedPostconditions.length > 0) {
    const failure: PerOpFailure = {
      target: failedPostconditions[0]!,
      code: 'postcondition',
      message: `"${command.name}" ran and left its effect in place, but ${failedPostconditions.length} of its postconditions did not hold: ${failedPostconditions.join('; ')}. The undo group is registered and intact, so this is reversible.`,
      correctiveHint:
        'do not retry the same command blindly — undo the group first, or report the failed postcondition to the user as a structured failure',
    };
    return err({
      code: 'postcondition',
      message: failure.message,
      target: command.name,
      details: { ...recoverable(command, groupId), failures: [failure] },
      correctiveHint: failure.correctiveHint,
    });
  }

  const outcome: ExecutionOutcome = {
    commandId: command.id,
    name: command.name,
    params,
    result: applied,
    grant,
    undoGroupId: groupId,
    affected: report.affected,
    postconditions: postconditions.map((check) => check.describe),
  };

  // Step 7 — subscriber notification. A subscriber that throws is a defect in the
  // subscriber; swallowing it leaves a UI rendering pre-commit state with no
  // signal, and rethrowing invites a retry of a command that *did* run. So it is
  // reported as `internal`, carrying the group that reverses the command.
  try {
    bus.notify(outcome);
  } catch (thrown) {
    return err({
      code: 'internal',
      message: `"${command.name}" ran, was registered for undo and was written to the activity log, but a subscriber threw while being notified: ${thrown instanceof Error ? thrown.message : String(thrown)}. Do not retry it — the effect is already committed and the undo group named below reverses it.`,
      target: command.name,
      details: recoverable(command, groupId),
      correctiveHint:
        'a subscriber must re-render from the store and must not throw (§3); the command is committed, so retrying it would apply the effect twice',
    });
  }

  return ok(outcome);
}

/**
 * §6's optimistic concurrency: *"document-writing commands carry optional
 * `expectedRevision` (per-doc `revision` counter, project-format §4). Mismatch →
 * `CommandError('conflict', 'doc was modified since plan (rev N → M)')`; the
 * edit-anchor ladder (edit-anchors.md §3) is the first line of defense, revisions
 * are the backstop."*
 *
 * The backstop is only a backstop if a number that matches means the text the plan
 * saw. The counter only rises: an undo writes the earlier body back as a write of its
 * own (command-bus §5, project-format §4), so a document never reaches a number it had
 * before newer text, and a match is the revision the plan was made against.
 *
 * ## `revision-conflict`, not `conflict`
 *
 * §6 writes the code as `'conflict'`, which is §7's *category*. The bus's
 * `CommandErrorCode` is the ten-value supersession docs/decisions.md
 * settled, and `revision-conflict` is exactly §7's `conflict` category refined —
 * declared for this and used by nothing until now. The category is the
 * thing the supersession kept; the specific code is the thing it added. Logged in
 * docs/decisions.md.
 *
 * ## Three unreachable shapes, all refused loudly
 *
 * A guarded command whose validated params carry a non-number `expectedRevision`,
 * no `docId`, or name a document the snapshot has no row for, is a defect rather
 * than a decision. The tempting alternative for the last one is to compare against
 * `undefined`, which passes every time and turns the backstop into a no-op — so it
 * is `internal`, naming the fix. §7's *"errors are data, not exceptions"* is why
 * the numbers also ride in `details` rather than only in `message`: §6 fixes that
 * sentence, and a caller recovering them from prose cannot build a retry loop.
 */
function revisionConflict(
  command: Command,
  params: unknown,
  snapshot: ValidationSnapshot,
): CommandError | undefined {
  if (!isRecord(params)) return undefined;
  const expected = params['expectedRevision'];
  // Omitted is §6's "no opinion", not a match against zero: a caller that sends
  // no revision is trusting the anchor ladder alone, which is the documented path.
  if (expected === undefined) return undefined;
  if (typeof expected !== 'number') {
    return unguardable(command, `its expectedRevision is a ${typeof expected}, not a number`);
  }
  const docId = params['docId'];
  if (typeof docId !== 'string') {
    return unguardable(command, `its docId is ${docId === undefined ? 'absent' : `a ${typeof docId}`}, so there is no document to compare a revision against`);
  }
  const actual = snapshot.documents.get(docId)?.revision;
  if (actual === undefined) {
    return unguardable(command, `the snapshot holds no revision for "${docId}", so a revision cannot be compared without guessing`);
  }
  if (actual === expected) return undefined;
  return {
    code: 'revision-conflict',
    message: `doc was modified since plan (rev ${expected} → ${actual})`,
    target: docId,
    details: { expectedRevision: expected, actualRevision: actual },
    correctiveHint:
      're-read the document and re-resolve the edit anchor against its current text (edit-anchors.md §3 is the first line of defense and runs before this check), then send the write with that revision; resending the same expectedRevision will refuse again, and nothing was written',
  };
}

/** A guarded command the guard cannot honestly judge — `internal`, never a pass. */
function unguardable(command: Command, why: string): CommandError {
  return {
    code: 'internal',
    message: `"${command.name}" declares guardsRevision, so its expectedRevision was meant to be compared against the document's revision, but ${why}. Nothing was written, and the revision was not treated as matching.`,
    target: command.name,
    correctiveHint:
      'the descriptor declares the guard, so the descriptor\'s validate must produce a numeric expectedRevision and a docId naming a document the snapshot carries — fix the descriptor, do not retry the command',
  };
}

/**
 * The group entry for one dispatch. The command's identity comes from the
 * envelope; the payload's own shape decides the kind, and §5's label asymmetry
 * holds — an inverse names itself, an artifact is given a label by the apply.
 */
function entryFor(command: Command, payload: UndoPayload): UndoEntry {
  return payload.kind === 'inverse'
    ? {
        kind: 'inverse',
        commandId: command.id,
        name: command.name,
        label: `undo ${command.name}`,
        inverse: payload.inverse,
      }
    : {
        kind: 'compensable',
        commandId: command.id,
        name: command.name,
        label: payload.label,
        restore: payload.restore,
      };
}

/**
 * Best-effort registration, for the two paths where the bus is **already**
 * failing and a reversal beats none: an apply that threw, and an apply that
 * returned a thenable. It skips §5's kind check on purpose — refusing a
 * mismatched capture while the command is half applied would trade a wrong
 * compensation for an irreversible effect — and it creates nothing when there is
 * nothing to capture, so the id it returns always names a group that exists.
 */
function registerIfCaptured(
  command: Command,
  descriptor: Pick<CommandDescriptor, 'mutates' | 'undo'>,
  payload: UndoPayload | undefined,
  target: UndoTarget,
  undo: UndoStore,
): string | undefined {
  if (payload === undefined) return undefined;
  if (descriptor.mutates === 'view' || descriptor.undo === 'none') return undefined;
  return undo.register(target, entryFor(command, payload));
}

/**
 * §5's registration obligation, checked rather than trusted.
 *
 * A pipeline that reads a comment asking its applies to be reversible produces
 * commands that report success and cannot be undone — the same defect class as
 * The `ProjectCommit` comment, one layer up. So a project command whose
 * descriptor declares `inverse`/`compensable` and whose apply handed over
 * nothing, or handed over the *other* kind, is refused before the log is written.
 *
 * **This runs after `apply`, so it is a post-apply refusal — a fourth one, and the
 * only one with nothing to name.** The three docs/decisions.md
 * (13:0x) enumerates — a thenable, a throwing apply, a throwing subscriber — all
 * happen after the effect exists *and* have a capture to register, so each of them
 * can hand back a group id. Here there may be nothing captured at all, so there
 * is no group to name and `details.undoGroupId` is absent, exactly as it is on a
 * pre-apply refusal. What differs from a pre-apply refusal is the one thing the
 * refusal cannot undo: **the apply already ran.** §3's zero-partial-effects does
 * not reach this step, so the message says what is actually true rather than the
 * reassuring thing. (Measured, not reasoned: an apply that mutates a `Map` and
 * captures nothing leaves the mutation in place while this refusal returns.)
 */
function registrationRefusal(
  name: CommandName,
  declared: 'inverse' | 'compensable',
  payload: UndoPayload | undefined,
): CommandError | undefined {
  const what = declared === 'inverse' ? 'inverse command' : 'restore artifact';
  const nothing =
    `Its apply had already run before this step, so whatever it changed is still in place and, ` +
    `with no ${what} captured, there is no undo group that reverses it — inspect the project before retrying. ` +
    `The activity log has a row for the change, with no undo group on it.`;
  if (payload === undefined) {
    return {
      code: 'internal',
      message: `"${name}" declares undo: '${declared}' and its apply handed the bus no ${what}. The dispatch stopped at §3's registration step; ${nothing}`,
      target: name,
      correctiveHint: `the apply must call context.undo.${declared === 'inverse' ? 'inverse(command)' : "compensate(label, restore)"} — §5 makes registration a pipeline step, and an unregistrable command reports a success it cannot honour`,
    };
  }
  if (payload.kind !== declared) {
    return {
      code: 'internal',
      message: `"${name}" declares undo: '${declared}' but its apply captured a '${payload.kind}' compensation. The dispatch stopped at §3's registration step; ${nothing}`,
      target: name,
      correctiveHint: `capture a '${declared}' compensation — the two are not interchangeable: an inverse is a command to dispatch, a restore artifact is state to put back`,
    };
  }
  return undefined;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
