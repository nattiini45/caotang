import type { ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { UserText } from '../i18n/UserText.js';

export function RestoreResult({ summary, restoration }: {
  readonly summary: string;
  readonly restoration?: 'whole' | 'partial';
}): ReactNode {
  return <>
    {restoration === 'whole' ? <><Trans>This turn’s project changes were taken back.</Trans>{' '}</> : null}
    {restoration === 'partial' ? <><Trans>Some of this turn’s project changes were taken back.</Trans>{' '}</> : null}
    <Trans>Original result: <UserText value={summary} /></Trans>
  </>;
}
