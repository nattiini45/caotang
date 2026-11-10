/**
 * The open import preview, as a small store (the `dialog-requests.ts` pattern): an import action anywhere in the workspace hands
 * its source here, and the workspace's `ImportPreviewHost` loads the dialog's code on first use and shows it. One preview is open at
 * a time, as one modal is; opening another replaces it, since the writer asked for the newer one.
 *
 * This module is small and in the first load; the dialog and its model are the lazy chunk (import-preview.md §6).
 */

import { useSyncExternalStore } from 'react';

import type { ImportPreviewSource } from './model.js';

export interface ImportPreviewRequest {
  readonly source: ImportPreviewSource;
  /** Called once the preview is closed, with whether it committed. */
  readonly onClose?: (committed: boolean) => void;
}

/** An open request, numbered, so a second import while one is open starts a fresh dialog. */
export type OpenImportPreview = ImportPreviewRequest & { readonly id: number };

let current: OpenImportPreview | null = null;
let opened = 0;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** Opens the preview over this source. Nothing is written until the writer presses Import in it. */
export function openImportPreview(request: ImportPreviewRequest): void {
  const replaced = current;
  opened += 1;
  current = { ...request, id: opened };
  announce();
  replaced?.onClose?.(false);
}

/** Closes the open preview, if any. */
export function closeImportPreview(committed = false, expectedId?: number): void {
  const closing = current;
  if (closing === null || (expectedId !== undefined && closing.id !== expectedId)) return;
  current = null;
  announce();
  closing.onClose?.(committed);
}

export function currentImportPreview(): OpenImportPreview | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useImportPreviewRequest(): OpenImportPreview | null {
  return useSyncExternalStore(subscribe, currentImportPreview, currentImportPreview);
}
