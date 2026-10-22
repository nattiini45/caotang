/**
 * The activity log — [command-bus.md §8](docs/architecture/command-bus.md).
 *
 * ## Which of §8's fields are filled, and by whom
 *
 * §8 declares ten fields. The pipeline fills the ones it can honestly fill at
 * append time and **leaves the rest out rather than defaulting them**, because a
 * log row that claimed a digest it had not computed is worse than a row without
 * one. Some fields cannot be filled by the pipeline alone:
 *
 * | §8 field | written | where it comes from |
 * |---|---|---|
 * | `at`, `command`, `issuedBy` | ✅ | §2's own envelope fields; `at` is `createdAt`, which §2 says is *"log/display only — never affects behavior"* |
 * | `turnId?`, `callId?` | ✅ | echoed from the envelope |
 * | `undoGroupId?` | ✅ | present exactly when §5 registered something into a group |
 * | `affected: {nodeId, title}[]` | ✅ | the **apply** — the only thing at the point of knowledge, and §8's *"human titles, not bare ids"* needs both a post-rename title and a pre-delete one |
 * | `summary` | ✅ | the apply, and the bus **refuses** a dispatch that reported none rather than inventing one |
 * | `source?` | ✅ | stamped `'native'`; §8 reserves `'mcp'` for the v0.2 client, which cannot reach `execute()` yet |
 * | `tokensSpent?` | declared, never written | the gateway ledger's, and the bus never writes it — the gateway owns the writer |
 * | `defect?` | ✅ on a defect row only | the bus, when it reports a defect it found after the fact; the row names a command it did **not** execute again |
 *
 * ## Why an apply reports, and not the pipeline
 *
 * Three of §8's own sentences put this in the apply, and none of them can be had
 * from params or from a read:
 *
 * - §8 wants **human titles, not bare ids**. A `binder.rename` row that shows the
 *   title the node had *before* the command is a row describing a different
 *   command; a `project.deleteNode` row cannot resolve a title at all afterwards,
 *   because the node is gone. Only the apply stands on both sides of its own
 *   effect.
 * - §8's example digest is *"moved 3 scenes into Chapter 4"* — a sentence about
 *   what changed, which no generic function of the command name can produce
 *   without fabricating.
 * - §3's subscribers re-render **from the store**, so they need ids and not
 *   titles. One declaration therefore feeds two consumers with different needs,
 *   and `ExecutionOutcome` carries the same list the row does rather than a
 *   second assembly of it.
 *
 * ## The refusal, and why it is not a default
 *
 * `summary` and `affected` are **required** fields of §8's interface. The bus
 * cannot fill either, so an apply that reported nothing leaves the pipeline with
 * two honest options — write a row whose digest is empty, or refuse — and this
 * file takes the second. That is the same shape as §5's registration refusal
 * a post-apply `internal` that carries the undo group in `details` and
 * says what is missing, rather than a required field silently defaulting to a
 * lie. The tripwire costs a committed-but-undone-in-principle command nothing:
 * the effect is registered and named, and every shipped apply reports.
 *
 * ## One entry per *executed* command
 *
 * A command refused at the name, at `validate` or at §4's gate was never
 * executed, so it leaves **no row**. That is the log's whole value as an audit
 * (*§1: "auditable (activity log)"*): a row means the bus did something.
 *
 * **And a defect row is not an execution.** A dispatch that made an effect can
 * leave two rows: the effect it made, and — after the fact — a defect the bus
 * found in the apply. **The pairing is not guaranteed.** The effect row is
 * written only when the dispatch registered an undo group or reported an
 * attempt (`pipeline.ts`), so a dispatch that registered neither — an apply
 * that threw before it captured anything — leaves the defect row on its own.
 * The defect row is marked (`defect`), reports nothing that ran, and
 * carries no undo group, so the rule this section states is the rule for the
 * **rows that report an effect**. A reader of the entries can tell the two
 * apart by the marker; a reader of a rendered surface cannot, until that
 * surface renders it (command-bus §8 says which do not yet).
 */

import type { CommandName } from './command.js';

/**
 * §8's `affected` element: the node id, and the **human title**, which is the
 * field the spec insists on (*"human titles, not bare ids"*). A store-side apply
 * resolves the title with the same rule `commands.ts` documents as *"§8's
 * `affected` rule"*.
 */
/**
 * Where a dispatch came from (command-bus §8). `'native'` is the in-process UI and
 * agent; `'mcp'` is reserved for the v0.2 external client. The caller names it when
 * it calls `execute()`, and the row stamps it.
 */
export type ActivitySource = 'native' | 'mcp';

export interface ActivityAffected {
  readonly nodeId: string;
  readonly title: string;
}

/**
 * What one dispatch hands the pipeline so §8's row can be written: the nodes whose
 * rendered content changed, and the digest that says what happened.
 *
 * **`affected` is empty when nothing's content changed, which is not the same as
 * "unknown".** A `codex.upsert` that creates an unattached entry changes no node;
 * a `view.setScroll` changes the view state the subscriber already holds. Both
 * report `[]`, and the digest is what carries the fact.
 */
export interface ActivityReport {
  readonly affected: readonly ActivityAffected[];
  /** §8's digest: *"moved 3 scenes into Chapter 4"*. Never empty, never a restatement of the command name. */
  readonly summary: string;
}

/**
 * The defects §8's log carries a row for.
 *
 * A defect row reports something the bus found **after** the fact — an apply
 * that did what the spec does not allow. It is not an execution of the command
 * it names, and the marker is what says so: a reader that counts command rows
 * can tell a defect row from an effect row without reading the summary.
 *
 * - `late-undo-capture`: an apply stashed its undo scope and captured from a
 *   timer, an event or a floating continuation, after its dispatch settled. The
 *   dispatch's registration is closed, so the payload was dropped.
 */
export type ActivityDefect = 'late-undo-capture';

export interface ActivityEntry {
  /** §2's `createdAt` — epoch ms, log/display only */
  readonly at: number;
  /** the command name, from §9's closed set */
  readonly command: string;
  readonly issuedBy: 'user' | 'agent';
  readonly turnId?: string;
  readonly callId?: string;
  /** §5's group, when one was registered into — absent for a `view.*` event */
  readonly undoGroupId?: string;
  /**
   * §8 reserves `'mcp'` for the v0.2 external client and says *"default
   * `native`"*. **Stamped rather than omitted**, so the distinction is in the
   * data and a reader never has to apply a default to tell a native row from a
   * future external one. Every command that reaches `execute()` in v0.1 came
   * through the in-process native UI/agent, so the pipeline writes exactly this.
   */
  readonly source: ActivitySource;
  /** §8: the nodes this command changed, with their titles. Empty is a real answer; see `ActivityReport`. */
  readonly affected: readonly ActivityAffected[];
  /** §8's digest. Required, and the pipeline refuses a dispatch that reported none. */
  readonly summary: string;
  /**
   * §8's agent-turn token cost, fed by the gateway ledger. **Declared and never
   * written by the bus**: the cost is the gateway's to measure, so a row that carried
   * a `0` would claim a measurement nobody took. The pipeline omits the key
   * entirely rather than writing `undefined`, because there is no envelope field
   * to echo — `turnId` and `callId` have one and `tokensSpent` does not.
   */
  readonly tokensSpent?: number;
  /**
   * §8's defect marker. Set on a row that reports a defect the bus found after
   * the fact, and absent on every row that reports a command's effect — so a
   * row that carries it names a command that was **not** executed a second time.
   */
  readonly defect?: ActivityDefect;
}

export interface ActivityLog {
  append(entry: ActivityEntry): void;
  /** Append order, oldest first. A copy: a subscriber cannot rewrite the log. */
  entries(): readonly ActivityEntry[];
  readonly length: number;
  /** The entries of one group, in append order — §5's checkpoint row is this slice. */
  entriesForGroup(groupId: string): readonly ActivityEntry[];
}

export function createActivityLog(): ActivityLog {
  const entries: ActivityEntry[] = [];

  return {
    append(entry) {
      entries.push(entry);
    },
    entries: () => [...entries],
    get length() {
      return entries.length;
    },
    entriesForGroup: (groupId) => entries.filter((entry) => entry.undoGroupId === groupId),
  };
}

/**
 * §3's step-6 surface, handed to an apply for the duration of one dispatch.
 *
 * **The reason this exists rather than a comment asking nicely** is §8's own
 * shape: the row is written after the apply, so the bus can only ask. `undo` is
 * the precedent — §5 makes registration a pipeline step, and a pipeline that
 * trusts an apply to remember produces a command that reports success and cannot
 * be undone. Here the failure is a row with an empty digest.
 */
export interface ActivityScope {
  /** Hand over §8's `affected` and `summary` for this dispatch. Once. */
  report(report: ActivityReport): void;
  /** What the apply handed over — `undefined` if it handed over nothing, which the pipeline refuses. */
  readonly reported: () => ActivityReport | undefined;
}

/**
 * One report per dispatch, and the second one **throws** rather than overwriting.
 *
 * `undo.ts`'s scope holds a single payload too, and a second `compensate()`
 * overwrites the first — which is exactly how the batch registered a group
 * restoring one entry out of five. The failure mode is the same here, so it is
 * closed the only way that is not silent: §8 writes **one entry per executed
 * command**, so a second report is an apply that disagrees with the spec about
 * its own dispatch, and it says so at the point of the mistake.
 *
 * The throw lands in `dispatch()`'s existing apply-threw path, which registers
 * whatever the apply captured and names the group — so a report written *before*
 * an undo capture would lose the compensation. Every shipped apply therefore
 * reports **last**, after its capture.
 */
export function createActivityScope(name: CommandName): ActivityScope {
  let report: ActivityReport | undefined;

  return {
    report(next: ActivityReport) {
      if (report !== undefined) {
        throw new Error(
          `the apply for "${name}" reported to the activity log twice, and §8 writes one entry per executed command. The first report is kept; the second is refused.`,
        );
      }
      // Copied, so an apply that keeps the array and mutates it afterwards cannot
      // rewrite a row that was already appended.
      report = { affected: [...next.affected], summary: next.summary };
    },
    reported: () => report,
  };
}
