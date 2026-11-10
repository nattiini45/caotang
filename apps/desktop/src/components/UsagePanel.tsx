import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { sumUsage } from '@caotang/gateway';
import type { AppServices } from '../app/services.js';
import { downloadBytes } from '../app/download.js';
import { formatUsd } from '../app/plan-preview.js';
import { usageCsv } from '../app/usage-export.js';
import { useFormat } from '../i18n/use-format.js';
import { UsageNotes, USAGE_ROLES } from './UsageBreakdown.js';

/* lingui-set comment="Interpolated values: cost, prompt, completion, requestsTotal" */

export function UsagePanel({ services }: { services: AppServices }): ReactNode {
  const format = useFormat();
  const ledger = services.providers.ledger;
  useSyncExternalStore((notify) => ledger.subscribe(notify), () => ledger.revision);
  const [detail, setDetail] = useState(false);
  const [error, setError] = useState(false);
  const rows = ledger.dayRows();
  const names = new Map(services.providers.list().map((profile) => [profile.id, profile.name]));
  const totals = sumUsage(rows);
  const requestsTotal = totals.requests;
  const exportUsage = (): void => {
    try {
      downloadBytes(new TextEncoder().encode(usageCsv(rows, names)), 'caotang-usage.csv', 'text/csv');
      setError(false);
    } catch {
      setError(true);
    }
  };
  return <section className="usage" aria-labelledby="settings-usage">
    <h4 id="settings-usage"><Trans>Usage on this device</Trans></h4>
    {rows.length === 0 ? <p className="muted"><Trans>No requests yet. Usage is counted by day, per profile, model and role, and stays in this browser.</Trans></p> : <>
      <p>{t`${plural(requestsTotal, { one: '# request', other: '# requests' })}, about ${{ prompt: format.number(totals.promptTokens) }} tokens in and ${{ completion: format.number(totals.completionTokens) }} out.`}</p>
      {totals.costUsd === undefined ? null : <p>{t`About ${{ cost: formatUsd(totals.costUsd) }} in recorded costs.`}</p>}
      <UsageNotes totals={totals} />
      <div className="usage-actions">
        <label><input type="checkbox" checked={detail} onChange={(event) => setDetail(event.currentTarget.checked)} /><Trans>Show token detail</Trans></label>
        <button type="button" className="button" onClick={exportUsage}><Trans>Export usage (CSV)</Trans></button>
      </div>
      {error ? <p role="alert"><Trans>The usage file could not be downloaded. Try exporting it again.</Trans></p> : null}
      <p className="muted"><Trans>Scroll the table to see all columns. Cache and reasoning counts are already included in the input and output totals.</Trans></p>
      <div className="usage-table-scroll" role="region" aria-label={t`Usage by day, profile, model and role`} tabIndex={0}>
        <table className="usage-table">
          <caption className="visually-hidden"><Trans>Usage by day, profile, model and role</Trans></caption>
          <thead><tr>
            <th scope="col"><Trans>Day</Trans></th><th scope="col"><Trans>Profile</Trans></th>
            <th scope="col"><Trans>Model</Trans></th><th scope="col"><Trans>Role</Trans></th>
            <th scope="col"><Trans>Requests</Trans></th><th scope="col"><Trans>Tokens in</Trans></th>
            <th scope="col"><Trans>Tokens out</Trans></th><th scope="col"><Trans>Cost</Trans></th>
            {detail ? <><th scope="col"><Trans>Cache reads</Trans></th><th scope="col"><Trans>Cache writes</Trans></th><th scope="col"><Trans>Reasoning</Trans></th></> : null}
          </tr></thead>
          <tbody>{rows.map((row) => <tr key={JSON.stringify([row.date, row.profileId, row.model, row.role])}>
            <td>{row.date}</td><td><bdi>{names.get(row.profileId) ?? t`Removed profile`}</bdi></td>
            <td><bdi>{row.model}</bdi></td><td>{i18n._(USAGE_ROLES[row.role])}</td>
            <td>{format.number(row.requests)}</td><td>{format.number(row.promptTokens)}</td><td>{format.number(row.completionTokens)}</td>
            <td>{row.costUsd === undefined ? t`No recorded cost.` : t`About ${{ cost: formatUsd(row.costUsd) }}`}<UsageNotes totals={row} /></td>
            {detail ? <><td>{format.number(row.cachedPromptTokens)}</td><td>{format.number(row.cacheWritePromptTokens)}</td><td>{format.number(row.reasoningTokens)}</td></> : null}
          </tr>)}</tbody>
        </table>
      </div>
    </>}
    <p className="muted"><Trans>Costs use recorded call prices or provider-reported amounts. Your provider’s bill is authoritative.</Trans></p>
    <p className="muted"><Trans>This history stays in this browser. The CSV contains daily accounting, not prompts, replies or keys.</Trans></p>
  </section>;
}
