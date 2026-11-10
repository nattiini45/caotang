/**
 * The MCP & tools panel's view model: what a server card says, in words, from its config, its health and its review. Pure
 * functions, so the words the panel shows are testable without a page (extensibility §3.2, §8).
 */

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import type { HealthFailureReason, HealthState, McpServerConfig, McpServerHealth, PinState, ReviewCard } from '@caotang/mcp-client';

/* lingui-set comment="Interpolated values: added, catalog, changed, prompts, removed, summary, templates, unchanged" */

/** §3.2's runtime states, as the card names them. A connection and a usable tool list are different signals. */
const STATE_LABELS: Readonly<Record<HealthState, MessageDescriptor>> = {
  configured: msg`Configured`,
  connecting: msg`Connecting`,
  failed: msg`Failed`,
  connected: msg`Connected`,
  healthy: msg`Healthy`,
};

const FAILURE_MESSAGES: Readonly<Record<HealthFailureReason, MessageDescriptor>> = {
  network: msg`The server did not answer. Check the address above, then choose Connect to try again.`,
  cors: msg`This server does not allow connections from a browser. Ask its administrator to allow this app, then choose Connect again.`,
  timeout: msg`The server took too long to answer. Choose Connect to try again.`,
  abort: msg`The connection was cancelled. Choose Connect to try again.`,
  auth: msg`The server rejected the sign-in. Check the token for this server, then choose Connect again.`,
  http: msg`The server returned an HTTP error. Check the address above, then choose Connect again.`,
  protocol: msg`The server returned an error Caotang could not classify. Check the server details, then choose Connect again.`,
  result: msg`The server sent a tool list Caotang could not read. Ask its administrator to check the tool list, then choose Connect again.`,
  revision: msg`This server uses an MCP version Caotang cannot use. Ask its maker for an update, then choose Connect again.`,
  'not-found': msg`The server has no tool list at this address. Check the address above, then choose Connect again.`,
  'input-required': msg`The server asked for more input to connect. Caotang cannot provide it here. Check the server’s sign-in requirements, then choose Connect again.`,
  'connector-load': msg`The MCP connector could not be loaded. Check your internet connection, then choose Connect again.`,
  'token-missing': msg`The bearer token is missing. Enter it on this card, save it, then choose Connect again.`,
};

/** The card's word for a server's state. */
export function stateLabel(state: HealthState): string {
  return i18n._(STATE_LABELS[state]);
}

/** The words for a tool's status in a review or a row. A changed or new tool is never called "verified". */
export function toolStatusLabel(status: PinState, review = false): string {
  switch (status) {
    case 'new':
      return t`New, not reviewed`;
    case 'changed':
      return t`Changed since review`;
    case 'verified':
      return review ? t`Unchanged` : t`Verified`;
  }
}

/** What one server card shows beyond its name and address. */
export interface ServerView {
  /** The status line, or the localized failure alert with an action on this card. */
  readonly detail: string;
  readonly failureDetail?: string;
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
    ...(health.state === 'failed' && health.reason === 'protocol' && health.detail !== undefined ? { failureDetail: health.detail } : {}),
    trustAvailable: reviewed,
    review: review === undefined || review.kind === 'current' ? undefined : review,
  };
}

function detailOf(health: McpServerHealth): string {
  if (health.state === 'failed') return i18n._(FAILURE_MESSAGES[health.reason]);
  if (health.detail !== undefined && health.detail !== '') return health.detail;
  switch (health.state) {
    case 'configured':
      return t`Not connected this session. Connect it to list its tools; nothing is searchable until then.`;
    case 'connecting':
      return t`Connecting to the server and checking its tool list…`;
    case 'connected':
      return t`Connected. Its tools are waiting for a review.`;
    case 'healthy': {
      const tools = health.toolsDiscovered ?? 0;
      return t`Healthy. ${{ count: tools }} ${plural(tools, { one: 'tool', other: 'tools' })} listed and verified.`;
    }
  }
}

/** Whether the tools of a review have anything to approve: a new or changed tool, or one that is gone. */
function toolsPending(review: ReviewCard): boolean {
  return review.tools.some((tool) => tool.status !== 'verified') || review.removed.length > 0;
}

/**
 * The words around a review. Its tools hold the server until they are approved; its prompts and resource templates do not, so a
 * review that has only those to approve says so and does not say that the tools wait.
 */
export function reviewHeading(review: ReviewCard): { readonly title: string; readonly approve: string; readonly approved: string } {
  if (toolsPending(review) || review.kind === 'first-connect') {
    return {
      title: t`Review the tool list`,
      approve: t`Approve this tool list`,
      approved: t`Approved. The tools are searchable now, and the pins are updated to this list.`,
    };
  }
  return {
    title: t`Review the prompts and resource templates`,
    approve: t`Approve these prompts and templates`,
    approved: t`Approved. The prompts and resource templates are pinned as listed.`,
  };
}

/** The one-line count a review opens with. */
export function reviewSummary(review: ReviewCard): string {
  const count = (status: PinState): number => review.tools.filter((tool) => tool.status === status).length;
  const added = count('new');
  const changed = count('changed');
  const unchanged = count('verified');
  const removed = review.removed.length;
  const summary =
    removed > 0
      ? t`${{ added }} new, ${{ changed }} changed, ${{ unchanged }} unchanged, ${{ removed }} removed. Every tool stays confirm-only until you approve this list.`
      : t`${{ added }} new, ${{ changed }} changed, ${{ unchanged }} unchanged. Every tool stays confirm-only until you approve this list.`;
  const prompts = review.prompts.length;
  const templates = review.resourceTemplates.length;
  const listed = prompts + templates;
  const catalog =
    listed + review.removedPrompts.length + review.removedTemplates.length === 0
      ? ''
      : t`The server also lists ${{ prompts }} ${plural(prompts, { one: 'prompt', other: 'prompts' })} and ${{ templates }} ${plural(templates, { one: 'resource template', other: 'resource templates' })}, shown in full below. They are pinned when you approve, and a changed one is shown again.`;
  if (!toolsPending(review) && review.kind !== 'first-connect') {
    return catalog === ''
      ? t`The tools are unchanged and stay as they are.`
      : t`The tools are unchanged and stay as they are. ${{ catalog }}`;
  }
  return catalog === '' ? summary : t`${{ summary }} ${{ catalog }}`;
}
