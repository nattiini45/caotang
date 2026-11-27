/* lingui-set comment="Interpolated values: storageSentence." */

import { useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { Durability } from '../app/session.js';
import { durabilitySentence } from '../app/storage.js';

export { PictureNotices } from './PictureNotices.js';

export function BrowserStorageBanner({ narrow, durability, onExport, onDismiss }: {
  readonly narrow: boolean;
  readonly durability: Durability;
  readonly onExport: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const [explain, setExplain] = useState(false);
  const storageSentence = durabilitySentence(durability);
  return (
    <div className="storage-banner notice-row" role="status" aria-label={t`Browser storage`} data-testid="storage-banner">
      <div>
        {narrow ? (
          <p>
            <Trans>
              Your words are kept in this browser, and the browser has not promised to keep them. A phone or tablet clears browser
              storage sooner than a computer when space runs short, and nothing syncs yet, so this copy is not your book’s only home.
              Export a backup often and keep it somewhere else.
            </Trans>
          </p>
        ) : (
          <p>
            <Trans>
              Your words are kept in this browser, and the browser has not promised to keep them. Export a backup to keep a copy you
              can open anywhere.
            </Trans>
          </p>
        )}
        {explain && (
          <p className="muted">
            <Trans>
              Browsers may remove stored data when a device runs short of space. Asking the browser to keep it lowers that risk, and
              the browser has not granted it here. {storageSentence} A bundle is the copy that does not depend on the browser.
            </Trans>
          </p>
        )}
      </div>
      <div className="storage-banner-actions">
        <button type="button" className="button" onClick={onExport}><Trans>Export a backup</Trans></button>
        <button type="button" className="button is-quiet" aria-expanded={explain} onClick={() => setExplain((on) => !on)}>
          <Trans>Learn why</Trans>
        </button>
        <button type="button" className="button is-quiet" onClick={onDismiss}><Trans>Dismiss</Trans></button>
      </div>
    </div>
  );
}
