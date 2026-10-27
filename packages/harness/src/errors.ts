/**
 * Model-facing refusals — [command-bus.md §7](../../../docs/architecture/command-bus.md),
 * which the harness reuses unchanged.
 *
 * A harness refusal is the bus's `CommandError`, so a plan card, an eval and the
 * model all read one shape. Every constructor here takes a `correctiveHint`, and
 * a refusal without one is a spec violation (§7: never a bare code).
 */

import { err, refusal, type CommandError, type Result } from '@caotang/bus';

// The constructor lives in the bus (refusal.ts) so a media module can refuse without importing this package. It is
// re-exported here, so the harness's own callers and its public surface are unchanged.
export { refusal, type RefusalOptions } from '@caotang/bus';

export function failure(error: CommandError): Result<never, CommandError> {
  return err(error);
}

/** A shape the caller got wrong: a bad type, an unknown key, a bad value. */
export function invalidParams(message: string, correctiveHint?: string, target?: string): CommandError {
  return refusal('invalid-params', message, { correctiveHint, target });
}

/** A limit from the spec or the format, not a malformed value. Says what to split or shorten. */
export function limitExceeded(message: string, correctiveHint?: string, target?: string): CommandError {
  return refusal('limit-exceeded', message, { correctiveHint, target });
}

export function notFound(message: string, correctiveHint?: string, target?: string): CommandError {
  return refusal('not-found', message, { correctiveHint, target });
}

/**
 * The refusal for a call or a plan step that names a hook command. A hook is a rule the agent is held to, so only the writer sets one
 * (hooks.md §6), and the agent has no tool for it.
 */
export function hooksAreTheWriters(name: string): CommandError {
  return refusal('not-found', `"${name}" is not a tool: hooks are set in Settings › Hooks, and the agent cannot add, change or remove one`, {
    target: name,
    correctiveHint: 'if a hook is in the way, tell the writer which one; do not try to change it',
  });
}

/** Whether a name is one of the two hook commands. */
export const isHookCommand = (name: string): boolean => name === 'hook.save' || name === 'hook.delete';

/**
 * The capability exists in the registry but has no implementation in this build.
 *
 * Worded as the bus words its own unimplemented names (`registry.ts`), because it
 * is the same situation one layer up: the name is known, nothing ran, nothing
 * was written, and the model should stop rather than retry.
 */
export function notWired(name: string): CommandError {
  return refusal(
    'internal',
    `"${name}" is registered but has no implementation in this build, so the harness refused it. It was not run and nothing was written.`,
    {
      target: name,
      correctiveHint: `do not retry ${name} — tell the user this action is not available in this build, and report what you set out to do instead`,
    },
  );
}
