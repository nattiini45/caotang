/**
 * Undo groups — [command-bus.md §5](docs/architecture/command-bus.md).
 *
 * ## What §5 states, and what this file therefore is
 *
 * - *"One agent turn = one undo group; one user gesture = one undo group."*
 * - *"Undo executes compensations in reverse order within the group."*
 * - `inverse` — *"the descriptor generates the exact inverse command"*.
 * - `compensable` — *"the command captured a restore artifact at apply time"*.
 * - *"each agent turn renders in the activity log as a checkpoint row — 'restore
 *   to before this turn' … One click = undo the group. Redo = v0.2 nice-to-have
 *   (store group inverses; not required for v0.1's promise)."*
 *
 * The store is **in memory and per session**, which is A3's own statement
 * (*"Undo depth = whole session history in memory"*) and the reason group ids
 * are a counter rather than a random string: nothing here outlives the page, and
 * a test can name a group it just created.
 *
 * ## The two decisions this file makes, because §5 does not state them
 *
 * 1. **A group is opened by the first command that registers something, not by
 *    the first command of a turn.** A gesture whose command registers nothing
 *    (`view.*`, `undo: 'none'`) leaves no group at all, so §5's "one gesture = one
 *    group" cannot be read as a group per gesture regardless. An agent turn's
 *    group id is decided by that turn's first command and held until
 *    `endTurn`, so two commands of one turn cannot land in two groups.
 * 2. **A compensation that fails does not abandon the rest, and does not
 *    discard the group.** Every entry is attempted in reverse order; the ones
 *    that worked are dropped and the ones that failed are **kept, in their
 *    original order**, so a retry undoes exactly what is still undone. Dropping
 *    the group on any failure would leave a user with a half-undone turn and no
 *    way back, and stopping at the first failure would make the outcome depend
 *    on which entry happened to be first — both are the "silently partial"
 *    result §3 and §7 spend their whole length refusing. Logged in
 *    docs/decisions.md.
 *
 * ## Why `isReplaying` is not a detail
 *
 * Redo is v0.2, so undoing a group dispatches each `inverse` back through
 * `execute()`. Without a replay flag the inverse would register *its own* undo
 * entry — whose inverse is the command just undone — and Ctrl+Z would toggle
 * instead of undo. The flag is read by the pipeline's registration step, and the
 * entry that is appended to the log for a replayed command is stamped with the
 * group being undone, so §5's checkpoint row and the log agree.
 */

import { err, ok, type CommandError, type PerOpFailure, type Result } from './result.js';
import type { ActivityReport, ActivityScope } from './activity-log.js';
import type { ApplyContext, Command, CommandName, UndoPayload, UndoScope } from './command.js';

export type UndoGroupKind = 'user-gesture' | 'agent-turn';

/**
 * §5's checkpoint framing, as the group carries it. The turn sentence is §5's
 * verbatim; the gesture one is the same framing with a user subject, because §5
 * gives the two cases one sentence (*"one user gesture = one undo group"*).
 */
const GROUP_LABELS: Readonly<Record<UndoGroupKind, string>> = {
  'user-gesture': 'restore to before this action',
  'agent-turn': 'restore to before this turn',
};

/** One compensation inside a group. A union, so `inverse` cannot be read off an entry that has none. */
export type UndoEntry =
  | {
      readonly kind: 'inverse';
      readonly commandId: string;
      readonly name: CommandName;
      readonly label: string;
      readonly inverse: Command;
    }
  | {
      readonly kind: 'compensable';
      readonly commandId: string;
      readonly name: CommandName;
      readonly label: string;
      readonly restore: () => void;
    };

export interface UndoGroup {
  readonly id: string;
  readonly kind: UndoGroupKind;
  /** the agent turn, when the group is a turn's */
  readonly turnId?: string;
  /** the first command's `createdAt` — display only, like §2's own `createdAt` */
  readonly at: number;
  /** §5's checkpoint framing: what one click on this group does. */
  readonly label: string;
  readonly entries: readonly UndoEntry[];
}

/** Where a dispatch's entry belongs. Computed before apply, materialised by `register`. */
export interface UndoTarget {
  readonly id: string;
  readonly kind: UndoGroupKind;
  readonly turnId?: string;
  /** the dispatch's `createdAt` — display only, like §2's own `createdAt` */
  readonly at: number;
  /** true when this dispatch is an undo replay, so nothing may be registered into it. */
  readonly replay: boolean;
}

export interface UndoOutcome {
  readonly groupId: string;
  /** entries that were compensated, in the order they were compensated (reverse) */
  readonly undone: readonly UndoEntry[];
  /** entries that were not, each with §7's error shape — the group keeps these */
  readonly failures: readonly PerOpFailure[];
}

export type UndoDispatch = (command: Command) => Result<unknown, CommandError>;

export interface UndoStore {
  /** §5's grouping rule, decided per dispatch. Does not create anything. */
  targetFor(command: Command, at: number): UndoTarget;
  /** Appends an entry to the target's group and returns the group id. */
  register(target: UndoTarget, entry: UndoEntry): string;
  group(id: string): UndoGroup | undefined;
  /** Creation order, oldest first. */
  groups(): readonly UndoGroup[];
  /** §6-adjacent: the turn is over, so the next command in it opens a new group. */
  endTurn(turnId: string): void;
  /** §5: compensate every entry in reverse order. */
  undo(id: string): Result<UndoOutcome, CommandError>;
  /**
   * Drops a group WITHOUT compensating it: its changes stay in the project, and no undo can take them back. For a change the
   * writer did not make and must not lose to Ctrl+Z, such as the one-time move of stored furniture into the manifest
   * (furniture-store.ts). Returns `false` when there is no such group. A dispatch made for such a change has its group
   * forgotten at once, before anything else can undo it.
   */
  forget(id: string): boolean;
  /** The group currently being undone, or `undefined`. */
  replayingGroupId(): string | undefined;
}

export interface UndoStoreOptions {
  /**
   * How an `inverse` entry gets executed. **Optional**, because §5's inverse is
   * a *command* and the bus has no way to dispatch one it was not handed — but a
   * group containing an inverse is refused entry-by-entry when it is missing,
   * never skipped silently.
   */
  readonly dispatch?: UndoDispatch;
  readonly newGroupId?: (ordinal: number) => string;
}

interface GroupRecord {
  id: string;
  kind: UndoGroupKind;
  turnId?: string;
  at: number;
  entries: UndoEntry[];
}

export function createUndoStore(options: UndoStoreOptions = {}): UndoStore {
  const newGroupId = options.newGroupId ?? ((ordinal: number) => `grp_${ordinal}`);
  const records = new Map<string, GroupRecord>();
  const order: string[] = [];
  /** turnId → the group id that turn's commands share. Held until `endTurn`. */
  const turnGroups = new Map<string, string>();
  const replaying: string[] = [];
  let ordinal = 0;

  function mint(): string {
    ordinal += 1;
    return newGroupId(ordinal);
  }

  function targetFor(command: Command, at: number): UndoTarget {
    const active = replaying[replaying.length - 1];
    if (active !== undefined) {
      const record = records.get(active);
      return {
        id: active,
        kind: record?.kind ?? 'user-gesture',
        turnId: record?.turnId,
        at,
        replay: true,
      };
    }
    // §5: "One agent turn = one undo group". A turn's id is decided by its first
    // command and held, so a second command cannot open a second group for it.
    if (command.issuedBy === 'agent' && command.turnId !== undefined) {
      const existing = turnGroups.get(command.turnId);
      const id = existing ?? mint();
      if (existing === undefined) turnGroups.set(command.turnId, id);
      return { id, kind: 'agent-turn', turnId: command.turnId, at, replay: false };
    }
    // §5: "one user gesture = one undo group" — and §2 says a gesture that
    // registers nothing (a `view.*`) makes no group at all, so the id is minted
    // here and only becomes a group if an entry is registered into it.
    return { id: mint(), kind: 'user-gesture', at, replay: false };
  }

  function register(target: UndoTarget, entry: UndoEntry): string {
    if (target.replay) return target.id;
    let record = records.get(target.id);
    if (record === undefined) {
      record = {
        id: target.id,
        kind: target.kind,
        turnId: target.turnId,
        at: target.at,
        entries: [],
      };
      records.set(target.id, record);
      order.push(target.id);
    }
    record.entries.push(entry);
    return target.id;
  }

  function snapshot(record: GroupRecord): UndoGroup {
    return {
      id: record.id,
      kind: record.kind,
      turnId: record.turnId,
      at: record.at,
      label: GROUP_LABELS[record.kind],
      entries: [...record.entries],
    };
  }

  function compensate(entry: UndoEntry, groupId: string): PerOpFailure | undefined {
    if (entry.kind === 'compensable') {
      entry.restore();
      return undefined;
    }
    if (options.dispatch === undefined) {
      return {
        target: entry.name,
        code: 'internal',
        message: `the undo of "${entry.name}" is an inverse command and no dispatcher is attached to this store, so it was not executed. The group is intact and the other compensations in it were attempted.`,
        correctiveHint:
          'attach a dispatcher with createUndoStore({ dispatch }) that routes the command back through execute() — an inverse is a Command, not a state change this store can make',
      };
    }
    replaying.push(groupId);
    try {
      const result = options.dispatch(entry.inverse);
      if (result.ok) return undefined;
      // An inverse that changes nothing has nothing to undo, and that is a
      // guarantee on the registering side rather than a hope: an apply that
      // wrote a field mints an inverse carrying that field's previous value,
      // and an apply that wrote none stamps nothing, remembers no restore
      // entry and registers a field-less inverse (the store's `binderSetMeta`
      // writes `updatedAt` only for a value it actually changed), so that
      // inverse has nothing to put back — not even the node's stamp.
      // Dispatching it can only refuse, with a refusal that says the work is
      // already done. That is a no-op, not a failure of the undo, so the group
      // keeps its other entries and reports nothing for this one.
      if (result.error.details?.changesNothing === true) return undefined;
      return {
        target: entry.name,
        code: result.error.code,
        message: result.error.message,
        correctiveHint: result.error.correctiveHint,
      };
    } finally {
      replaying.pop();
    }
  }

  function undo(id: string): Result<UndoOutcome, CommandError> {
    const record = records.get(id);
    if (record === undefined) {
      return err({
        code: 'not-found',
        message: `there is no undo group "${id}" to undo. Nothing was changed.`,
        target: id,
        correctiveHint: 'list the groups with undoStore.groups() and undo one of those ids',
      });
    }
    // A copy, because a successful compensation mutates `record.entries` at the end.
    const ordered = [...record.entries].reverse();
    const undone: UndoEntry[] = [];
    const failures: PerOpFailure[] = [];
    /** Positions in `ordered`, not names: two commands of one turn can share a name. */
    const failedAt: number[] = [];
    ordered.forEach((entry, position) => {
      try {
        const failure = compensate(entry, id);
        if (failure === undefined) undone.push(entry);
        else {
          failures.push(failure);
          failedAt.push(position);
        }
      } catch (thrown) {
        failedAt.push(position);
        failures.push({
          target: entry.name,
          code: 'internal',
          message: `the compensation for "${entry.name}" threw: ${thrown instanceof Error ? thrown.message : String(thrown)}. The rest of the group was still attempted.`,
          correctiveHint:
            'this is a defect in the restore artifact the apply captured; the entry is kept so the undo can be retried',
        });
      }
    });
    if (failures.length === 0) {
      records.delete(id);
      const at = order.indexOf(id);
      if (at !== -1) order.splice(at, 1);
      if (record.turnId !== undefined) turnGroups.delete(record.turnId);
    } else {
      // Keep only what is still undone, back in registration order.
      record.entries = failedAt.map((position) => ordered[position]!).reverse();
    }
    return ok({ groupId: id, undone, failures });
  }

  return {
    targetFor,
    register,
    group: (id) => {
      const record = records.get(id);
      return record === undefined ? undefined : snapshot(record);
    },
    groups: () => order.map((id) => snapshot(records.get(id)!)),
    endTurn: (turnId) => {
      turnGroups.delete(turnId);
    },
    undo,
    forget: (id) => {
      const record = records.get(id);
      if (record === undefined) return false;
      records.delete(id);
      const at = order.indexOf(id);
      if (at !== -1) order.splice(at, 1);
      if (record.turnId !== undefined) turnGroups.delete(record.turnId);
      return true;
    },
    replayingGroupId: () => replaying[replaying.length - 1],
  };
}

/**
 * A per-dispatch registration surface (§3's undo-registration step).
 *
 * **Handed to the apply, read by the pipeline.** A scope that outlives a dispatch
 * would let one command's compensation land in another's group, so this is
 * created fresh per `execute()` and the pipeline holds the only reference to the
 * captured payload.
 *
 * **The scope's window is the apply's window.** The pipeline calls
 * {@link SettledUndoScope.settle} once it has read the payload, and a capture
 * that arrives after that — from an apply that stashed the scope and captured
 * from a timer, an event or a floating continuation — cannot join any group: the
 * dispatch's registration is closed. Throwing there would reach no caller
 * either; it would escape as an uncaught exception, or an unhandled rejection
 * on the async path. So a late capture is handed to the scope's
 * `onLateCapture` — the pipeline wires it to an activity-log row — and
 * dropped: a defect in the apply stays visible without detonating outside the
 * bus.
 */
export interface SettledUndoScope extends UndoScope {
  /**
   * Ends the apply window. Captures after this are late: they are reported to
   * the scope's `onLateCapture` and dropped, never registered and never thrown.
   * Called by the pipeline when it reads the payload back; an apply has no
   * reason to call it and no way to undo it.
   */
  settle(): void;
}

/**
 * A scope for one dispatch, and the factory's own rules.
 *
 * **One capture per dispatch, and the second one throws** rather than overwriting
 * the first. §5 registers one entry per command, so a second capture is an apply
 * that disagrees with the spec about its own dispatch — and the overwrite was
 * silent: the pipeline saw a capture of the right kind and registered a group
 * that reversed only the last effect. `createActivityScope` refuses its second
 * report the same way.
 *
 * **Where the throw lands depends on when the capture happens.** A capture the
 * apply makes synchronously, while the pipeline awaits it, lands in the
 * pipeline's apply-threw path — which registers whatever was captured first and
 * names the group. A capture from an independent timer during an *asynchronous*
 * apply is outside the awaited promise: it escapes as an uncaught exception or
 * an unhandled rejection, because the pipeline only starts protecting the scope
 * once it reads the payload back. The message does not name the command: the
 * pipeline's refusal already prefixes it with `the apply for "<name>" threw: `,
 * so a second naming would only make the surfaced error stutter.
 *
 * `onLateCapture` is **required**, so a late capture is always handed to a
 * surface that can report it. What the requirement buys is that one is
 * *wired* — not that every late capture leaves a trace:
 *
 * - **A reporter that throws is swallowed.** There is no second surface to
 *   write to (see `capture` below), so a late capture whose reporter fails
 *   leaves nothing behind.
 * - **Only the first late capture of a dispatch is reported.** The pipeline's
 *   own reporter writes one §8 defect row per dispatch and drops the rest the
 *   same way, and that row says so.
 *
 * So the promise is that a late capture *reaches* a surface that can say it
 * happened — the defect stays visible rather than escaping the bus — and not
 * that each one leaves a row of its own.
 */
export function createUndoScope(
  kind: ApplyContext['undo']['kind'],
  onLateCapture: (payload: UndoPayload) => void,
): SettledUndoScope {
  let payload: UndoPayload | undefined;
  let settled = false;

  const capture = (next: UndoPayload): void => {
    if (settled) {
      // The reporter is the last line of defence, and it runs wherever the
      // apply's timer fires — so a reporter that throws must not become the
      // uncaught exception this mechanism exists to prevent.
      try {
        onLateCapture(next);
      } catch {
        // A reporter that cannot report is a defect in the defect reporter, and
        // there is no second surface to write to. Swallowing it is what keeps
        // the promise the interface makes: a late capture never escapes the bus.
      }
      return;
    }
    if (payload !== undefined) {
      throw new Error(
        'a second undo payload was captured, and §5 registers one entry per command. The first capture is kept; the second is refused.',
      );
    }
    payload = next;
  };

  return {
    kind,
    inverse(command) {
      capture({ kind: 'inverse', inverse: command });
    },
    compensate(label, restore) {
      capture({ kind: 'compensable', label, restore });
    },
    captured: () => payload,
    settle: () => {
      settled = true;
    },
  };
}

/**
 * §3's per-dispatch context object. Three of its fields are the command's own
 * identity.
 *
 * **`report` is the and it lives here for the same reason `undo` does**: both
 * are per-dispatch surfaces the pipeline creates, hands to the apply, and reads
 * back afterwards. Splitting them across two files would put the object that
 * assembles an apply's whole context in neither.
 */
export function applyContext(
  command: Command,
  scope: UndoScope,
  activity: ActivityScope,
): ApplyContext {
  return {
    commandId: command.id,
    name: command.name,
    turnId: command.turnId,
    issuedBy: command.issuedBy,
    // Carried only when set, so an apply that never reads it sees the same context as before.
    ...(command.provenance === undefined ? {} : { provenance: command.provenance }),
    undo: scope,
    report: (report: ActivityReport) => activity.report(report),
  };
}
