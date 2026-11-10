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
import { useNarrow } from './narrow.js';

/* lingui-set comment="Interpolated values: cost, prompt, completion, requestsTotal" */

export function UsagePanel({ services }: { services: AppServices }): ReactNode {
  const format = useFormat();
  const narrow = useNarrow();
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
      <p className="muted"><Trans>Cache and reasoning counts are already included in the input and output totals.</Trans></p>
      {narrow ? <ul className="usage-records" aria-label={t`Usage by day, profile, model and role`}>
        {rows.map((row) => <li key={JSON.stringify([row.date, row.profileId, row.model, row.role])}>
          <h5><bdi>{row.model}</bdi> · {i18n._(USAGE_ROLES[row.role])}</h5>
          <dl className="usage-record-values">
            <div><dt><Trans>Day</Trans></dt><dd>{row.date}</dd></div>
            <div><dt><Trans>Profile</Trans></dt><dd><bdi>{names.get(row.profileId) ?? t`Removed profile`}</bdi></dd></div>
            <div><dt><Trans>Requests</Trans></dt><dd>{format.number(row.requests)}</dd></div>
            <div><dt><Trans>Tokens in</Trans></dt><dd>{format.number(row.promptTokens)}</dd></div>
            <div><dt><Trans>Tokens out</Trans></dt><dd>{format.number(row.completionTokens)}</dd></div>
            <div><dt><Trans>Cost</Trans></dt><dd>{row.costUsd === undefined ? t`No recorded cost.` : t`About ${{ cost: formatUsd(row.costUsd) }}`}<UsageNotes totals={row} /></dd></div>
          </dl>
          {detail ? <TokenDetail row={row} /> : null}
        </li>)}
      </ul> : <table className="usage-table">
          <caption className="visually-hidden"><Trans>Usage by day, profile, model and role</Trans></caption>
          <colgroup><col /><col /><col /><col /><col /><col /><col /><col /></colgroup>
          <thead><tr>
            <th scope="col"><Trans>Day</Trans></th><th scope="col"><Trans>Profile</Trans></th>
            <th scope="col"><Trans>Model</Trans></th><th scope="col"><Trans>Role</Trans></th>
            <th scope="col"><Trans>Requests</Trans></th><th scope="col"><Trans>Tokens in</Trans></th>
            <th scope="col"><Trans>Tokens out</Trans></th><th scope="col"><Trans>Cost</Trans></th>
          </tr></thead>
          {rows.map((row) => <tbody key={JSON.stringify([row.date, row.profileId, row.model, row.role])}><tr>
            <td>{row.date}</td><td><bdi>{names.get(row.profileId) ?? t`Removed profile`}</bdi></td>
            <td><bdi>{row.model}</bdi></td><td>{i18n._(USAGE_ROLES[row.role])}</td>
            <td>{format.number(row.requests)}</td><td>{format.number(row.promptTokens)}</td><td>{format.number(row.completionTokens)}</td>
            <td>{row.costUsd === undefined ? t`No recorded cost.` : t`About ${{ cost: formatUsd(row.costUsd) }}`}<UsageNotes totals={row} /></td>
          </tr>{detail ? <tr className="usage-detail-row"><td colSpan={8}><TokenDetail row={row} /></td></tr> : null}</tbody>)}
        </table>}
    </>}
    <p className="muted"><Trans>Costs use recorded call prices or provider-reported amounts. Your provider’s bill is authoritative.</Trans></p>
    <p className="muted"><Trans>This history stays in this browser. The CSV contains daily accounting, not prompts, replies or keys.</Trans></p>
  </section>;
}

function TokenDetail({ row }: { row: { cachedPromptTokens: number; cacheWritePromptTokens: number; reasoningTokens: number } }): ReactNode {
  const format = useFormat();
  return <dl className="usage-token-detail">
    <div><dt><Trans>Cache reads</Trans></dt><dd>{format.number(row.cachedPromptTokens)}</dd></div>
    <div><dt><Trans>Cache writes</Trans></dt><dd>{format.number(row.cacheWritePromptTokens)}</dd></div>
    <div><dt><Trans>Reasoning</Trans></dt><dd>{format.number(row.reasoningTokens)}</dd></div>
  </dl>;
}
