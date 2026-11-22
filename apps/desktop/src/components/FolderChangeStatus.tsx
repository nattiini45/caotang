/**
 * The offer a change another program made in the open project folder raises (desktop.md §External folder changes, #403). It is its
 * own module because only a session with a native folder needs it: the website loads neither these words nor the comparison behind
 * them, and the entry chunk stays where the bundle budget has it. The watch itself starts with the workspace (use-folder-watch),
 * so a change that lands while this module is still loading is not missed.
 */
/* lingui-set comment="Interpolated values: count, files" */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { listFormat } from '@caotang/i18n';
import type { ReactNode } from 'react';

import { changeSummary } from '../app/folder-watch.js';
import type { DirectoryHandleLike } from '../app/fs-access.js';
import { formatterLocale } from '../i18n/format-locale.js';

export interface FolderChangeStatusProps {
  readonly folder: DirectoryHandleLike;
  /** The folder files that changed outside Caotang. */
  readonly changed: readonly string[];
  /** Whether this tab has nothing unsaved: only then is reopening the folder offered. */
  readonly saved: boolean;
  readonly onDismiss: () => void;
  readonly onReopen: (folder: DirectoryHandleLike) => void;
  readonly onExport: () => void;
}

/**
 * The offer in the status line. It names the changed files and never acts by itself. Reopening is offered when this tab has
 * nothing unsaved; when it does, the copy that does not depend on a reload comes first, so taking the offer cannot drop words.
 */
export function FolderChangeStatus({ folder, changed, saved, onDismiss, onReopen, onExport }: FolderChangeStatusProps): ReactNode {
  const summary = changeSummary(changed, (path) => path.slice(path.lastIndexOf('/') + 1));
  const files = listFormat(formatterLocale()).format(summary.names);
  return (
    <div className="status-line is-info" role="status" data-testid="folder-change">
      <span>
        {summary.more === 0
          ? t`The project folder changed outside Caotang: ${{ files }}. Caotang has not reloaded the folder’s version.`
          : t`The project folder changed outside Caotang: ${{ files }} and ${{ count: summary.more }} more. Caotang has not reloaded the folder’s version.`}
      </span>
      {saved ? (
        <button type="button" className="button" onClick={() => onReopen(folder)}>
          <Trans>Reopen the folder’s version</Trans>
        </button>
      ) : (
        <button type="button" className="button" onClick={onExport}>
          <Trans>Export a backup</Trans>
        </button>
      )}
      <button type="button" className="button is-quiet" onClick={onDismiss}>
        <Trans>Keep writing</Trans>
      </button>
    </div>
  );
}
