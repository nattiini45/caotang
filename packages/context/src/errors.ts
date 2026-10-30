/**
 * The refusals assembly makes. Each one is a contract violation by the caller: the
 * harness resolves ids and validates selections before it asks for a prompt, so a
 * refusal here means that step was skipped. An empty synopsis or an empty codex is not a
 * refusal; those degrade with a reason in the layer (context-assembly §7).
 */

export type ContextErrorCode =
  | 'missing-focus'
  | 'unknown-focus'
  | 'focus-not-document'
  | 'unknown-scope'
  | 'missing-selection'
  | 'withheld';

export class ContextError extends Error {
  readonly code: ContextErrorCode;

  constructor(code: ContextErrorCode, message: string) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
  }
}
