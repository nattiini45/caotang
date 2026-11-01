/**
 * Where the shared import preview opens (import-preview.md §6). The workspace mounts this; an import action hands its source to
 * `openImportPreview`, and the dialog's code loads then, on first use, so the first load carries only this file and the request store.
 */

import type { ReactNode } from 'react';

import type { ProjectSession } from '../app/session.js';
import { LazyBoundary, lazyView } from '../components/lazy-view.js';
import { PREVIEW_HELPERS } from './helpers.js';
import { closeImportPreview, useImportPreviewRequest } from './requests.js';

const ImportPreviewDialog = lazyView(() => import('./ImportPreviewDialog.js'));

export function ImportPreviewHost({ session }: { session: ProjectSession }): ReactNode {
  const request = useImportPreviewRequest();
  if (request === null) return null;
  return (
    <LazyBoundary label="the import preview" variant="toast" onDismiss={() => closeImportPreview(false)}>
      {/* A new request is a new dialog: its edits and answers start fresh. */}
      <ImportPreviewDialog key={request.id} session={session} request={request} helpers={PREVIEW_HELPERS} />
    </LazyBoundary>
  );
}
