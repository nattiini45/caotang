/**
 * Error shape — [command-bus.md §7](docs/architecture/command-bus.md).
 *
 * Errors are data, not exceptions. Every failure the harness or the UI can
 * encounter is representable as a `CommandError` so plan cards can render it and
 * evals can assert on it without string matching.
 *
 * **The nine codes are a logged supersession of §7's five, kept deliberately**
 *. §7's own union is a union of
 * *categories*; `not-found` and `cycle` are the two distinctions §9's rows
 * depend on — `binder.move`'s row requires a cycle check, and a cycle reported
 * as a plain `validation` is correct but lossy.
 *
 * **The two fields §7 requires are both here, and
 * they are the two that carry behaviour: §4 requires a refusal to name "the
 * corrective path" and §7 forbids "a bare code", which is exactly what
 * `correctiveHint` is; `details` is where §2's per-op batch failures go — and,
 * where a post-apply failure names the undo group that reverses it.
 *
 * **`postcondition` is the tenth code, added, and the one
 * place the supersession was not a refinement.** §7 lists `postcondition` as a
 * category of its own, §3 puts the check between `apply` and undo
 * registration, and so the code that reports it has to exist. Delegated 2
 * justified the finer enum as *"a strict refinement"* — and this is a category
 * the nine did not cover at all, so the pipeline either reports a failed
 * postcondition as `internal` — indistinguishable from a crash, and §7 hands the
 * retry-vs-report decision to the harness's verify ladder, which cannot make
 * that decision on a code that cannot say what failed — or adds the distinction
 * §7 already names. The ninth code's own docs/decisions.md had already ruled
 * `internal` out for this case: of a `resolveCommand` refusal it says "not a
 * validation failure … and **not a postcondition**".
 */

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  /** params path or node id the failure is attached to, when attributable */
  target?: string;
  /** present on permission-gate rejections (§4) */
  risk?: 'read' | 'write-auto' | 'write-confirm' | 'never';
  /**
   * §7: the corrective surface, model/user-facing. §4 makes this mandatory in
   * substance for a `never`-class refusal, and §7 forbids a bare code — so a
   * refusal without one is a spec violation, not a terse style choice.
   */
  correctiveHint?: string;
  /** §7: per-op failures for batch commands. */
  details?: CommandErrorDetails;
}

/** One failing op inside a batch command (`binder.restructure`, `codex.upsert`), or a failed
 * postcondition (§2), which §7 puts in the same place: per-item, named, and actionable. */
export interface PerOpFailure {
  /** the op's index in the submitted batch, or the id it addressed */
  target: string;
  code: CommandErrorCode;
  message: string;
  correctiveHint?: string;
  /**
   * The op's own details, when it has any — the candidates an ambiguous name
   * matched, for instance. A per-op failure that dropped them would lose what
   * the op's refusal said as data, and a caller that has to recover that by
   * reading the prose cannot build the retry loop §7 is meant to enable.
   */
  details?: CommandErrorDetails;
}

export interface CommandErrorDetails {
  /**
   * §2: "Batch commands ... validate the whole batch first and **list failures
   * per-op**". Every failure is listed, not just the first — a batch that
   * reports one bad op at a time makes the model resubmit N times.
   */
  failures?: PerOpFailure[];
  /**
   * §3's pipeline,: the command this refusal is about, and the §5 undo
   * group that reverses it. Both are present on every failure that happened
   * **after** `apply` **and had a capture to register** — a refusal that names no
   * way back leaves the caller with a committed effect it cannot undo, and §7's
   * remedy is that the group "stays intact and user-reversible". Absent on a
   * pre-apply refusal, where there is nothing to reverse, and on §5's
   * registration refusal, which is post-apply but fires *because* nothing was
   * captured.
   */
  commandId?: string;
  undoGroupId?: string;
  /**
   * §6's optimistic-concurrency refusal: the revision the caller planned
   * against and the one the document actually holds.
   *
   * **Declared rather than left to the index signature, because §7 is explicit
   * that an error is data**: *"plan cards can render it and evals can assert on it
   * without string matching."* The same numbers are in `message` — §6 fixes that
   * sentence — and a caller that has to recover them by parsing prose cannot build
   * the retry loop §6 is meant to enable.
   */
  expectedRevision?: number;
  actualRevision?: number;
  /**
   * A `changesNothing` refusal (params.ts): the machine-readable half of "this
   * request asks for no change at all".
   *
   * **Declared rather than left to the index signature, for the same reason as
   * `expectedRevision`**: undo.ts reads this key to decide that an inverse which
   * could not dispatch was a no-op rather than a kept failure, so the key
   * carries behaviour and deserves a declared, discoverable name.
   *
   * The index signature is still there, so a misspelled key (on either side)
   * still typechecks; what the declaration rules out is a writer that puts a
   * non-boolean under this name.
   */
  changesNothing?: boolean;
  /** anything else the refusing command wants the model to see */
  [key: string]: unknown;
}

export type CommandErrorCode =
  | 'invalid-params'
  | 'not-found'
  | 'cycle'
  | 'revision-conflict'
  | 'permission-denied'
  | 'hard-denied'
  | 'limit-exceeded'
  | 'io-error'
  | 'internal'
  /** §7's fifth category; §3's step 4 reports it. Added — see the header. */
  | 'postcondition';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
