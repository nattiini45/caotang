import type { ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { TaskRole, UsageTotals } from '@caotang/gateway';
import { formatUsd } from '../app/plan-preview.js';
import type { UsageGroup } from '../app/usage-model.js';
import { useFormat } from '../i18n/use-format.js';

/* lingui-set comment="Interpolated values: cost, prompt, completion, requestsTotal, estimated, unpriced, provider" */

export const USAGE_ROLES: Readonly<Record<TaskRole, MessageDescriptor>> = {
  chat: msg`Chat`, drafting: msg({ message: 'Drafting', context: 'usage role' }), background: msg`Background`,
};

export function UsageNotes({ totals }: { totals: UsageTotals }): ReactNode {
  const estimated = totals.estimatedRequests;
  const unpriced = totals.unpricedRequests;
  const provider = totals.providerCostRequests;
  return <span className="usage-notes">
    {estimated > 0 ? <span data-testid="usage-estimated">{plural(estimated, { one: '# request used estimated token counts.', other: '# requests used estimated token counts.' })}</span> : null}
    {unpriced > 0 ? <span data-testid="usage-unpriced">{totals.costUsd === undefined
      ? plural(unpriced, { one: '# request has no recorded cost.', other: '# requests have no recorded cost.' })
      : plural(unpriced, { one: 'Partial cost total: # request has no recorded cost.', other: 'Partial cost total: # requests have no recorded cost.' })}</span> : null}
    {provider > 0 ? <span>{plural(provider, { one: '# request has a provider-reported cost.', other: '# requests have a provider-reported cost.' })}</span> : null}
  </span>;
}

export function UsageBreakdown({ rows, names }: { rows: readonly UsageGroup[]; names: ReadonlyMap<string, string> }): ReactNode {
  const format = useFormat();
  return <ul className="usage-breakdown">
    {rows.map((row) => {
      const requestsTotal = row.requests;
      return <li key={JSON.stringify([row.profileId, row.model, row.role])}>
      <p><strong><bdi>{names.get(row.profileId) ?? t`Removed profile`}</bdi></strong> · <bdi>{row.model}</bdi> · {i18n._(USAGE_ROLES[row.role])}</p>
      <p>{t`${plural(requestsTotal, { one: '# request', other: '# requests' })}, about ${{ prompt: format.number(row.promptTokens) }} tokens in and ${{ completion: format.number(row.completionTokens) }} out.`}</p>
      <p>{row.costUsd === undefined ? t`No recorded cost.` : t`About ${{ cost: formatUsd(row.costUsd) }}.`}</p>
      <UsageNotes totals={row} />
      <dl className="usage-token-detail">
        <div><dt><Trans>Cache reads</Trans></dt><dd>{format.number(row.cachedPromptTokens)}</dd></div>
        <div><dt><Trans>Cache writes</Trans></dt><dd>{format.number(row.cacheWritePromptTokens)}</dd></div>
        <div><dt><Trans>Reasoning</Trans></dt><dd>{format.number(row.reasoningTokens)}</dd></div>
      </dl>
    </li>; })}
  </ul>;
}

export function SessionUsage({ usage, names }: { usage: { readonly totals: UsageTotals; readonly rows: readonly UsageGroup[] }; names: ReadonlyMap<string, string> }): ReactNode {
  const format = useFormat();
  const { totals, rows } = usage;
  const requestsTotal = totals.requests;
  if (totals.requests === 0) return null;
  return <details className="agent-session-usage" data-testid="agent-session-usage" data-requests={totals.requests} data-input-tokens={totals.promptTokens} data-output-tokens={totals.completionTokens} data-cost-usd={totals.costUsd}>
    <summary title={t`Show usage by profile, model and role.`}>
      <span>{t`This session: ${plural(requestsTotal, { one: '# request', other: '# requests' })}, about ${{ prompt: format.number(totals.promptTokens) }} tokens in and ${{ completion: format.number(totals.completionTokens) }} out.`}</span>
      {totals.costUsd === undefined ? null : <span>{t`About ${{ cost: formatUsd(totals.costUsd) }} for this session.`}</span>}
      <UsageNotes totals={totals} />
    </summary>
    <p className="muted"><Trans>This counts calls made in this session, including its roles and background tasks, across visits. A fork’s copied turns keep their original accounting; they are not charged again. Device history stays in Settings.</Trans></p>
    <UsageBreakdown rows={rows} names={names} />
  </details>;
}
