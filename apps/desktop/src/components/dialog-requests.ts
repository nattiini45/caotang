/**
 * The dialogs a control deep in the workspace can open: the project panel (opened from the project's name in the
 * toolbar), the Skills panel (opened from its toolbar button, or from the agent panel's note about skills waiting), the Agent instructions
 * panel (CAOTANG.md and the memory notes, opened from its toolbar button) and the vocabulary editor (opened from a status or label picker's "+ Add" entry). The picker lives in the binder
 * or the inspector, and the dialog belongs to the workspace, so the request travels through this small store rather than a
 * prop chain every panel would have to carry. This request family has one open request; other families belong to the shared modal stack.
 */

import { useSyncExternalStore } from 'react';

import type { VocabularyKind } from '@caotang/bus';
import { modalStack } from './modal-stack.js';

export type DialogRequest =
  | { readonly kind: 'project' }
  | { readonly kind: 'skills' }
  | { readonly kind: 'agent-instructions' }
  | { readonly kind: 'vocabulary'; readonly term: VocabularyKind };

/** Opens a dialog. Opening one while another is open replaces it: the writer asked for the newer one. */
export function openDialog(request: DialogRequest): void {
  modalStack.write('feature', request);
}

/** Closes whatever is open. A close with nothing open changes nothing, and tells nobody. */
export function closeDialog(): void {
  modalStack.write('feature', null);
}

/** The request now open, or `null`. */
export function currentDialog(): DialogRequest | null {
  return modalStack.read<DialogRequest>('feature');
}

/** Calls `listener` whenever a request opens or closes. Returns the unsubscribe. */
export function subscribeDialog(listener: () => void): () => void {
  return modalStack.subscribe(listener);
}

/** The open request, as a React value. Its identity changes only when a request opens or closes. */
export function useDialogRequest(): DialogRequest | null {
  return useSyncExternalStore(subscribeDialog, currentDialog, currentDialog);
}
