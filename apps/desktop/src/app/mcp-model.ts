/**
 * The MCP & tools panel's view model: what a server card says, in words, from its config, its health and its review. Pure
 * functions, so the words the panel shows are testable without a page (extensibility §3.2, §8).
 */

import type { HealthState, McpServerConfig, McpServerHealth, ReviewCard } from '@caotang/mcp-client';

/** §3.2's three states, as the card names them. A connection and a usable tool list are different signals. */
export const STATE_LABEL: Readonly<Record<HealthState, string>> = {
  configured: 'Configured',
  connected: 'Connected',
  healthy: 'Healthy',
};

/** The words for a tool's status in a review or a row. A changed or new tool is never called "verified". */
export function toolStatusLabel(status: 'new' | 'changed' | 'unchanged' | 'verified'): string {
  switch (status) {
    case 'new':
      return 'New, not reviewed';
    case 'changed':
      return 'Changed since review';
    case 'unchanged':
      return 'Unchanged';
    case 'verified':
      return 'Verified';
  }
}

/** What one server card shows beyond its name and address. */
export interface ServerView {
  /** The detail line under the state: the named corrective path for a failure, or what the server's state means. */
  readonly detail: string;
  /** Whether the trust toggle may be switched on: only after a review has left the server healthy (extensibility §3.4 step 4a). */
  readonly trustAvailable: boolean;
  /** The review to show, when the tool list has something to review. */
  readonly review: ReviewCard | undefined;
}

export function mcpServerView(server: McpServerConfig, health: McpServerHealth, review: ReviewCard | undefined): ServerView {
  const pendingReview = health.pendingReview === true;
  const reviewed = Object.keys(server.pinnedTools).length > 0 && health.state === 'healthy' && !pendingReview;
  return {
    detail: detailOf(health),
    trustAvailable: reviewed,
    review: review === undefined || review.kind === 'current' ? undefined : review,
  };
}

function detailOf(health: McpServerHealth): string {
  if (health.detail !== undefined && health.detail !== '') return health.detail;
  switch (health.state) {
    case 'configured':
      return 'Not connected this session. Connect it to list its tools; nothing is searchable until then.';
    case 'connected':
      return 'Connected. Its tools are waiting for a review.';
    case 'healthy':
      return `Healthy. ${health.toolsDiscovered ?? 0} tool${health.toolsDiscovered === 1 ? '' : 's'} listed and verified.`;
  }
}

/** Whether the tools of a review have anything to approve: a new or changed tool, or one that is gone. */
function toolsPending(review: ReviewCard): boolean {
  return review.tools.some((tool) => tool.status !== 'unchanged') || review.removed.length > 0;
}

/**
 * The words around a review. Its tools hold the server until they are approved; its prompts and resource templates do not, so a
 * review that has only those to approve says so and does not say that the tools wait.
 */
export function reviewHeading(review: ReviewCard): { readonly title: string; readonly approve: string; readonly approved: string } {
  if (toolsPending(review) || review.kind === 'first-connect') {
    return {
      title: 'Review the tool list',
      approve: 'Approve this tool list',
      approved: 'Approved. The tools are searchable now, and the pins are updated to this list.',
    };
  }
  return {
    title: 'Review the prompts and resource templates',
    approve: 'Approve these prompts and templates',
    approved: 'Approved. The prompts and resource templates are pinned as listed.',
  };
}

/** The one-line count a review opens with. */
export function reviewSummary(review: ReviewCard): string {
  const count = (status: 'new' | 'changed' | 'unchanged'): number => review.tools.filter((tool) => tool.status === status).length;
  const parts = [`${count('new')} new`, `${count('changed')} changed`, `${count('unchanged')} unchanged`];
  if (review.removed.length > 0) parts.push(`${review.removed.length} removed`);
  const listed = review.prompts.length + review.resourceTemplates.length;
  const catalog =
    listed + review.removedPrompts.length + review.removedTemplates.length === 0
      ? ''
      : ` The server also lists ${review.prompts.length} prompt${review.prompts.length === 1 ? '' : 's'} and ${review.resourceTemplates.length} resource template${review.resourceTemplates.length === 1 ? '' : 's'}, shown in full below. They are pinned when you approve, and a changed one is shown again.`;
  if (!toolsPending(review) && review.kind !== 'first-connect') {
    return `The tools are unchanged and stay as they are.${catalog}`;
  }
  return `${parts.join(', ')}. Every tool stays confirm-only until you approve this list.${catalog}`;
}
