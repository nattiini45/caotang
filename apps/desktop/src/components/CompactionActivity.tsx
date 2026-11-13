/* lingui-set comment="Interpolated values: turns" */
import type { ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import type { CompactionActivity as Activity } from '@caotang/harness';
import { timeLabel } from '../app/activity-model.js';
import { groupUsage } from '../app/usage-model.js';
import { USAGE_ROLES, UsageBreakdown } from './UsageBreakdown.js';

export function CompactionActivity({ entries, profiles }: { readonly entries: readonly Activity[]; readonly profiles: readonly { readonly id: string; readonly name: string }[] }): ReactNode {
  const { i18n } = useLingui();
  return <ol className="activity-list" aria-label={t`Conversation compaction`}>
    {entries.map((entry, index) => {
      const turns = entry.covers.turns;
      return <li key={`${entry.at}:${index}`} className="activity-row is-agent" data-testid="compaction-activity" data-status={entry.status}>
        <p><strong>{entry.status === 'replied' ? <Trans>Conversation summarised</Trans> : entry.status === 'cancelled' ? <Trans>Compaction stopped</Trans> : <Trans>Summary request failed</Trans>}</strong></p>
        <p className="muted"><time dateTime={new Date(entry.at).toISOString()}>{timeLabel(entry.at)}</time> · {i18n._(USAGE_ROLES[entry.role])} · {entry.origin === 'auto' ? <Trans>Automatic</Trans> : <Trans>Manual</Trans>}</p>
        <p>{plural(turns, { one: 'Summary requested for # earlier turn.', other: 'Summary requested for # earlier turns.' })}</p>
        {entry.usage.length === 0 ? <p className="muted"><Trans>Usage was not recorded for this request.</Trans></p> : <UsageBreakdown rows={groupUsage(entry.usage)} names={new Map(profiles.map((profile) => [profile.id, profile.name]))} />}
        <p className="muted"><Trans>This request is already included in the turn and session totals.</Trans></p>
      </li>;
    })}
  </ol>;
}
