import { t } from '@lingui/core/macro';
import type { PromptPreview } from '@caotang/harness';
import { formatCount } from './shared.js';

type DropReason = PromptPreview['layers'][number]['drops'][number]['reason'];

/* lingui-set comment="Interpolated values: limit (document count), layer (stable context layer ID), budget and total (token budgets), rank (pruning rank), file (instruction file name), sent and tokens (token counts), need (required tokens)" */

export function contextLayerLabel(id: string, fallback = id): string {
  switch (id) {
    case 'L0': return t`System`;
    case 'LI': return t`Instructions (CAOTANG.md and memory)`;
    case 'L1': return t`Project summary`;
    case 'L2': return t`Codex entries`;
    case 'L3': return t`Structure around the focus document`;
    case 'L4': return t`Story so far, from the synopses`;
    case 'L5': return t`Focus document text`;
    case 'L6': return t`Recent turns of the conversation`;
    case 'L7': return t`Current task`;
    default: return fallback;
  }
}

export function contextDropText(drop: { readonly reason?: DropReason; readonly text: string }): string {
  const reason = drop.reason;
  if (reason === undefined) return drop.text;
  switch (reason.kind) {
    case 'writer-excluded': return t`Left out of optional context for this request.`;
    case 'pin-limit': return t`Beyond the ${{ limit: formatCount(reason.limit) }}-document pin limit.`;
    case 'never': return t`The entry's include policy is Never.`;
    case 'empty-description': return t`The description is empty.`;
    case 'manual-unattached': return t`The entry uses Manual policy and is not attached to the focus.`;
    case 'withheld': return t`withheld by a read rule`;
    case 'forward-outline': return t`The forward outline is turned off.`;
    case 'scope-limit': return t`Beyond the ${{ limit: formatCount(reason.limit) }}-document scope limit. Split the scope.`;
    case 'budget': return t`The ${{ layer: reason.layer }} budget of ${{ budget: formatCount(reason.budget) }} tokens is full (rank ${{ rank: formatCount(reason.rank) }}).`;
    case 'total-budget': return t`The total budget of ${{ total: formatCount(reason.total) }} tokens is full (${{ layer: reason.layer }}, rank ${{ rank: formatCount(reason.rank) }}).`;
    case 'instructions-cap': return t`${{ file: reason.file }} has ${{ tokens: formatCount(reason.totalTokens) }} tokens; the first ${{ sent: formatCount(reason.sentTokens) }} were sent.`;
    case 'reserve-overflow': return reason.pinned === true
      ? t`Always and pinned codex entries need ${{ need: formatCount(reason.need) }} tokens; the layer budget is ${{ budget: formatCount(reason.budget) }}.`
      : t`Always codex entries need ${{ need: formatCount(reason.need) }} tokens; the layer budget is ${{ budget: formatCount(reason.budget) }}.`;
    default: return drop.text;
  }
}
