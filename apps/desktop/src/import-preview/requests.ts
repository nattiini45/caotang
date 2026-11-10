/**
 * The open import preview, as a small store (the `dialog-requests.ts` pattern): an import action anywhere in the workspace hands
 * its source here, and the workspace's `ImportPreviewHost` loads the dialog's code on first use and shows it. One preview is open at
 * a time in this request family; opening another replaces it, since the writer asked for the newer one. Other dialog families stay in the shared stack.
 *
 * This module is small and in the first load; the dialog and its model are the lazy chunk (import-preview.md §6).
 */

import { useSyncExternalStore } from 'react';

import type { ImportPreviewSource } from './model.js';
import { modalStack } from '../components/modal-stack.js';

export interface ImportPreviewRequest {
  readonly source: ImportPreviewSource;
  /** Called once the preview is closed, with whether it committed. */
  readonly onClose?: (committed: boolean) => void;
}

/** An open request, numbered, so a second import while one is open starts a fresh dialog. */
export type OpenImportPreview = ImportPreviewRequest & { readonly id: number };

let opened = 0;

/** Opens the preview over this source. Nothing is written until the writer presses Import in it. */
export function openImportPreview(request: ImportPreviewRequest): void {
  const replaced = currentImportPreview();
  opened += 1;
  modalStack.write('import', { ...request, id: opened });
  replaced?.onClose?.(false);
}

/** Closes the open preview, if any. */
export function closeImportPreview(committed = false, expectedId?: number): void {
  const closing = currentImportPreview();
  if (closing === null || (expectedId !== undefined && closing.id !== expectedId)) return;
  modalStack.write('import', null);
  closing.onClose?.(committed);
}

export function currentImportPreview(): OpenImportPreview | null {
  return modalStack.read<OpenImportPreview>('import');
}

function subscribe(listener: () => void): () => void {
  return modalStack.subscribe(listener);
}

export function useImportPreviewRequest(): OpenImportPreview | null {
  return useSyncExternalStore(subscribe, currentImportPreview, currentImportPreview);
}
