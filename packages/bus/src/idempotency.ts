/**
 * §6's `callId` dedupe — [command-bus.md](docs/architecture/command-bus.md).
 *
 * §6: *"**callId dedupe:** replays of the same `callId` within a turn return the
 * cached result without re-execution. Cache is per turn, cleared at turn
 * end."* agent-harness §3 restates it from the other end: *"every call carries a
 * turn-scoped `callId`; the command bus dedupes replays."*
 *
 * ## The key is the turn, and that is not bookkeeping
 *
 * `Command.callId` is optional and `Command.turnId` is optional, so "replays of
 * the same callId **within a turn**" has to answer a case the spec does not spell
 * out: a `callId` with no turn. It is **not** a key.
 *
 * The alternative — treat "no turn" as its own bucket — makes the entry immortal,
 * because there is no turn end to clear it, and §6's sentence pairs the cache with
 * *"cleared at turn end"* as a matched clause. A user gesture carries no `callId`
 * at all (it is a *tool-call* id), so the case that would be lost is a harness
 * that invented one, and an immortal entry under a reused id is a write the caller
 * can never perform again.
 *
 * ## What gets stored, and the one line that decides it
 *
 * `record` is called by `execute()` **after §3's step 2**, so the cache holds every
 * dispatch that reached `apply` — successes *and* the post-apply failures — and
 * holds no refusal at all. That split is §3's own sentence applied to §6:
 *
 * | The dispatch | Re-run it? | Why |
 * |---|---|---|
 * | refused at resolution, `validate`, the §4 gate or §6's conflict check | **yes, freely** | §3: *"Failure at any step aborts with zero partial effects."* Nothing ran, and the gate's answer is a function of context (`approvedPlan`, `confirmed`), so the *same* command can legitimately succeed a moment later — that is the confirm-card flow, and caching the refusal would make a confirmed write permanently unconfirmable. |
 * | reached `apply` — ok, or a postcondition / `internal` failure | **no** | The effect is committed. The pipeline's own message for a throwing subscriber says it outright: *"the command is committed, so retrying it would apply the effect twice."* |
 *
 * So "return the cached result" is honoured where re-execution is a double-apply,
 * and deliberately **not** honoured where re-execution is free.
 *
 * ## A `callId` under which two different commands arrive is refused, not merged
 *
 * Rejected first: return the first result anyway. A harness that reuses one id for
 * two calls would then have its second write **silently swallowed** — the model is
 * told the second write happened and it did not, which is the worst outcome
 * available and the one §7's *"never a bare code"* is written against.
 *
 * Rejected second: run the second command and overwrite the entry. That is not
 * wrong in itself, but it leaves the reuse invisible, and §6's guarantee is about
 * the id. So a mismatch is an `internal` refusal naming both calls — the same trade
 * as the store's `DocumentExistsError`, which refuses a replayed `create`
 * rather than overwriting a body the author has.
 *
 * ## The fingerprint is order-insensitive, and that is load-bearing
 *
 * Two submissions of one call are equal as *values*, not as *text*: a JSON round
 * trip through a model does not promise a key order. A fingerprint taken over
 * `JSON.stringify(params)` alone would raise the mismatch refusal above on a
 * genuine replay whose keys arrived shuffled — failing loudly on the correct
 * path, which is worse than not checking at all. Hence the sorted-key
 * stringify. **Array order is preserved**, because it is data
 * (`attachTo: [a, b]` and `[b, a]` are different commands).
 */

import type { Command } from './command.js';
import { canMove, type MachineTable } from '@caotang/machine';
import type { ExecutionOutcome } from './pipeline.js';
import { err, type CommandError, type Result } from './result.js';

/** One `callId` inside one turn: what it was, and what it answered. */
interface CacheEntry {
  /** `name` + canonical params, so a reused id is caught rather than merged. */
  readonly fingerprint: string;
  readonly result: Result<ExecutionOutcome, CommandError>;
}

type CallState = { readonly kind: 'unseen' } | { readonly kind: 'in-flight' } | { readonly kind: 'recorded' };
type CallEvent = { readonly type: 'apply' | 'settle' | 'end-turn' };

export const callIdTable: MachineTable<CallState, CallEvent> = {
  id: 'bus.call-id', initial: 'unseen', final: [],
  on: {
    unseen: { apply: ['in-flight', 'recorded'] },
    'in-flight': { settle: ['recorded'], 'end-turn': ['unseen'] },
    recorded: { 'end-turn': ['unseen'] },
  },
};

type CallEntry =
  | ({ readonly kind: 'recorded' } & CacheEntry)
  | { readonly kind: 'in-flight'; readonly fingerprint: string; readonly result: Promise<Result<ExecutionOutcome, CommandError>> };

export interface IdempotencyCache {
  /**
   * The earlier answer for this turn-scoped `callId`, or `undefined` when the id
   * is new, absent or has no turn to be scoped to.
   *
   * A non-`undefined` return is the *whole* result, including a post-apply
   * failure: `execute()` hands it back as-is, so a replay of a committed command
   * reports the same refusal instead of applying the effect twice.
   */
  lookup(command: Command): Result<ExecutionOutcome, CommandError> | undefined;
  lookupAsync(command: Command): Result<ExecutionOutcome, CommandError> | Promise<Result<ExecutionOutcome, CommandError>> | undefined;
  runAsync(command: Command, apply: () => Promise<Result<ExecutionOutcome, CommandError>>): Promise<Result<ExecutionOutcome, CommandError>>;
  /**
   * Record a dispatch that reached `apply`. A command without both a `turnId` and
   * a `callId` records nothing — the one place that decision is made.
   */
  record(command: Command, result: Result<ExecutionOutcome, CommandError>): void;
  /** §6: *"cleared at turn end."* */
  endTurn(turnId: string): void;
  /** How many ids are cached — per turn, or across every live turn. For tests and UI. */
  size(turnId?: string): number;
}

/** The turn the id lives in, plus the id — or `undefined` when §6 does not apply. */
function keyOf(command: Command): { turnId: string; callId: string } | undefined {
  if (command.turnId === undefined || command.callId === undefined) return undefined;
  return { turnId: command.turnId, callId: command.callId };
}

/**
 * The command's identity as a value.
 *
 * The key-sorted replacer runs at every depth, so `{docId, body}` and
 * `{body, docId}` are one command. `JSON.stringify` drops `undefined`-valued keys
 * already, which is the behaviour wanted here: a param the caller left `undefined`
 * is the same call as one that never mentioned it.
 */
function fingerprintOf(command: Command): string {
  try {
    const params = JSON.stringify(command.params, (_key, value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value,
    );
    return command.name + (params ?? 'undefined');
  } catch {
    // JSON.stringify throws on a BigInt and on a cycle. `record` runs after the
    // apply, so a throw here would leave an effect applied and the caller holding
    // an exception rather than a result — the worst half-state available. A
    // command whose params have no JSON form therefore gets a fingerprint nothing
    // else can equal: a replay of it is refused as a mismatch, never merged.
    unserialisableCount += 1;
    return `${command.name}#unserialisable-${unserialisableCount}`;
  }
}

/** Distinguishes the fingerprints of commands whose params have no JSON form. */
let unserialisableCount = 0;

/**
 * The cache itself. One map per turn, so `endTurn` is a delete rather than a sweep
 * — §6's clause is about a turn's entries, and an entry whose turn is over has no
 * turn to answer for.
 *
 * **Unbounded within a turn, deliberately.** §6 names no cap, and the retained
 * values are references the dispatch already held (an outcome's `result` is the
 * apply's own return value, and its `params` are the normalized params), so a long
 * turn costs one small object per call rather than a second copy of the project.
 * A cap would be a guess against a spec that does not ask for one.
 */
export function createIdempotencyCache(): IdempotencyCache {
  const byTurn = new Map<string, Map<string, CallEntry>>();

  function lookupAsync(command: Command) {
    const key = keyOf(command);
    if (key === undefined) return undefined;
    const entry = byTurn.get(key.turnId)?.get(key.callId);
    if (entry === undefined) return undefined;
    if (entry.fingerprint !== fingerprintOf(command)) return err(mismatch(command, entry.fingerprint));
    return entry.result;
  }

  return {
    lookup(command) {
      const replay = lookupAsync(command);
      if (replay instanceof Promise) return err({
        code: 'internal',
        message: 'This callId is still applying. Await executeAsync() to receive its result; nothing was applied again.',
        target: command.name,
        correctiveHint: 'await executeAsync() for this callId instead of retrying it synchronously',
      });
      return replay;
    },

    lookupAsync,

    runAsync(command, apply) {
      const replay = lookupAsync(command);
      if (replay !== undefined) return Promise.resolve(replay);
      const key = keyOf(command);
      if (key === undefined) return apply();
      let turn = byTurn.get(key.turnId);
      if (turn === undefined) {
        turn = new Map();
        byTurn.set(key.turnId, turn);
      }
      const activeTurn = turn;
      const fingerprint = fingerprintOf(command);
      let resolve!: (answer: Result<ExecutionOutcome, CommandError>) => void;
      let reject!: (reason: unknown) => void;
      const result = new Promise<Result<ExecutionOutcome, CommandError>>((accept, refuse) => { resolve = accept; reject = refuse; });
      const entry: CallEntry = { kind: 'in-flight', fingerprint, result };
      activeTurn.set(key.callId, entry);
      void apply().then((answer) => {
        if (byTurn.get(key.turnId) === activeTurn && activeTurn.get(key.callId) === entry && canMove(callIdTable, entry.kind, 'settle')) {
          activeTurn.set(key.callId, { kind: 'recorded', fingerprint, result: answer });
        }
        resolve(answer);
      }, reject);
      return result;
    },

    record(command, result) {
      const key = keyOf(command);
      if (key === undefined) return;
      let turn = byTurn.get(key.turnId);
      if (turn === undefined) {
        turn = new Map();
        byTurn.set(key.turnId, turn);
      }
      turn.set(key.callId, { kind: 'recorded', fingerprint: fingerprintOf(command), result });
    },

    endTurn(turnId) {
      byTurn.delete(turnId);
    },

    size(turnId) {
      if (turnId !== undefined) return byTurn.get(turnId)?.size ?? 0;
      let total = 0;
      for (const turn of byTurn.values()) total += turn.size;
      return total;
    },
  };
}

/**
 * The mismatch refusal. `internal` because nothing in the bus can produce it: §2's
 * envelope promises one command per `id`, so two commands under one `id` is the
 * harness's defect to fix, and `internal` is the code this codebase already uses
 * for "a caller broke a contract the bus cannot repair" (see `pipeline.ts`'s
 * apply-throws and subscriber-throws refusals).
 *
 * The message names **both** commands, because the actionable half is the second
 * one: the caller has to decide which of the two it meant.
 */
function mismatch(command: Command, first: string): CommandError {
  const second = fingerprintOf(command);
  return {
    code: 'internal',
    message:
      'callId "' + command.callId + '" in turn "' + command.turnId + '" was already used by a different command, so "' +
      command.name + '" was not applied and nothing was written. That id answered for ' + first + ' and now claims ' + second + '.',
    target: command.name,
    correctiveHint:
      'give the second call its own callId — one id names one command; reusing an id would either apply a write twice or silently drop this one',
  };
}
