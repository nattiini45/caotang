/**
 * The command line's permission modes, as the SDK's approval policies (agent-harness §11).
 *
 * The names are the headless vocabulary of #43. When the interactive permission modes land (plan-only, ask, accept-edits), the left
 * column of this table is what changes, and nothing else: no card is shown to a person here, so `ask` means "cancel every card".
 * The hard-deny list is the command bus's and is not consulted here, so no mode can widen it.
 */

import type { ApprovalPolicy } from '@caotang/sdk';

import type { PermissionMode } from './agent-args.js';

const POLICY_OF: Readonly<Record<PermissionMode, 'read-only' | 'auto' | 'approve-all'>> = {
  'read-only': 'read-only',
  auto: 'auto',
  'approve-all': 'approve-all',
};

/** The SDK policy for a mode, narrowed to a list of tools when `--approve-tools` names one. */
export function policyFor(mode: PermissionMode, approveTools: readonly string[] | undefined): ApprovalPolicy {
  return approveTools === undefined ? POLICY_OF[mode] : { approveTools };
}
