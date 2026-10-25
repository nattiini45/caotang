// i18n: package-refs
/**
 * The model-facing refusal constructor, [command-bus.md §7](../../../docs/architecture/command-bus.md).
 *
 * A refusal is the bus's `CommandError`, so a plan card, an eval and the model all read one shape. It lives in the
 * bus, the leaf every tool package depends on, so a media module can refuse in the registry's own shape without
 * importing the harness, which imports the module. `@caotang/harness` re-exports it, so its callers are unchanged.
 *
 * Every constructor here takes a `correctiveHint`, and a refusal without one is a spec violation (§7: never a bare code).
 */

import type { MessageRef } from '@caotang/i18n';

import type { CommandError, CommandErrorCode, CommandErrorDetails } from './result.js';

export interface RefusalOptions {
  readonly correctiveHint?: string;
  readonly target?: string;
  readonly details?: CommandErrorDetails;
  readonly risk?: CommandError['risk'];
  /** I7: the refusal and its corrective path as message references, beside the English. */
  readonly messageRef?: MessageRef;
  readonly correctiveHintRef?: MessageRef;
}

export function refusal(code: CommandErrorCode, message: string, options: RefusalOptions = {}): CommandError {
  return {
    code,
    message,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.correctiveHint === undefined ? {} : { correctiveHint: options.correctiveHint }),
    ...(options.messageRef === undefined ? {} : { messageRef: options.messageRef }),
    ...(options.correctiveHintRef === undefined ? {} : { correctiveHintRef: options.correctiveHintRef }),
    ...(options.details === undefined ? {} : { details: options.details }),
    ...(options.risk === undefined ? {} : { risk: options.risk }),
  };
}
