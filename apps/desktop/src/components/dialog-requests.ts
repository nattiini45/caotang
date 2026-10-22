/**
 * The dialogs a control deep in the workspace can open: the project panel (opened from the project's name in the
 * toolbar), the Skills panel (opened from its toolbar button, or from the agent panel's note about skills waiting) and the vocabulary editor (opened from a status or label picker's "+ Add" entry). The picker lives in the binder
 * or the inspector, and the dialog belongs to the workspace, so the request travels through this small store rather than a
 * prop chain every panel would have to carry. One request is open at a time, as one modal is.
 */

import { useSyncExternalStore } from 'react';

import type { VocabularyKind } from '@caotang/bus';

export type DialogRequest =
  | { readonly kind: 'project' }
  | { readonly kind: 'skills' }
  | { readonly kind: 'vocabulary'; readonly term: VocabularyKind };

let current: DialogRequest | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** Opens a dialog. Opening one while another is open replaces it: the writer asked for the newer one. */
export function openDialog(request: DialogRequest): void {
  current = request;
  announce();
}

/** Closes whatever is open. A close with nothing open changes nothing, and tells nobody. */
export function closeDialog(): void {
  if (current === null) return;
  current = null;
  announce();
}

/** The request now open, or `null`. */
export function currentDialog(): DialogRequest | null {
  return current;
}

/** Calls `listener` whenever a request opens or closes. Returns the unsubscribe. */
export function subscribeDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open request, as a React value. Its identity changes only when a request opens or closes. */
export function useDialogRequest(): DialogRequest | null {
  return useSyncExternalStore(subscribeDialog, currentDialog, currentDialog);
}
