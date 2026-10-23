/** What the command writes to stdout in each output format, and the exit codes a script branches on. */

import type { AgentEvent, FileChange, TurnReport } from '@caotang/sdk';

export const ExitCode = {
  Ok: 0, // replied or applied
  Internal: 1,
  Usage: 2, // bad flags, no project, no key for a provider that needs one
  Locked: 3, // another writer holds the folder (as caotang-mcp)
  NeedsInput: 4, // a card the policy cancelled, the model-call bound or a run limit, a provider failure
  Conflict: 5, // askBack conflict or anchor_unresolvable, or a folder another program changed
  VerifyFailed: 6, // askBack verify_failed
  Interrupted: 130, // SIGINT
  Terminated: 143, // SIGTERM
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** `--output-format json`: one object on stdout when the turn ends. */
export interface AgentResultJson {
  readonly type: 'result';
  readonly version: 1;
  /** Absolute path. */
  readonly project: string;
  readonly provider: { readonly preset: string; readonly model: string } | { readonly preset: 'mock' };
  readonly permission: 'read-only' | 'auto' | 'approve-all';
  readonly written: boolean;
  readonly report: TurnReport;
  readonly changes: readonly FileChange[];
  readonly exitCode: ExitCode;
}

/** `--output-format stream-json`: one line per event, then the result line. */
export type StreamLine =
  | { readonly type: 'start'; readonly version: 1; readonly project: string; readonly permission: string }
  | { readonly type: 'event'; readonly event: AgentEvent }
  | { readonly type: 'decision'; readonly turnId: string; readonly kind: 'plan' | 'confirm'; readonly action: 'approve' | 'cancel'; readonly reason: string }
  | AgentResultJson;

/** One line of stream-json, or the whole of json: a single JSON text and a newline, with nothing else on the line. */
export function jsonLine(value: StreamLine): string {
  return `${JSON.stringify(value)}\n`;
}

/** What the exit code says about a turn that ended with this report. */
export function exitCodeOf(report: TurnReport): ExitCode {
  if (report.status === 'replied' || report.status === 'applied') return ExitCode.Ok;
  switch (report.askBack?.code) {
    case 'needs_input':
    case 'budget_exhausted':
      return ExitCode.NeedsInput;
    case 'conflict':
    case 'anchor_unresolvable':
      return ExitCode.Conflict;
    case 'verify_failed':
      return ExitCode.VerifyFailed;
    case undefined:
      // A turn the writer stopped has no ask-back; one a script stopped (a signal) is given its own code by the caller.
      return report.status === 'cancelled' ? ExitCode.NeedsInput : ExitCode.Internal;
  }
}
