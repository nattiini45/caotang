import { assertNever, canMove, defineMachine, type MachineTable } from '@caotang/machine';

import type { DirectoryHandleLike } from './fs-access.js';
import type { FolderFileChange, FolderFilePreview, FolderOverwriteSnapshot, FolderSaveAnswers } from './lifecycle.js';

export interface FolderOffer {
  readonly folder: DirectoryHandleLike;
  readonly reason: 'locked' | 'changed' | 'unknown' | 'earlier' | 'files';
  readonly overwriteSnapshot: FolderOverwriteSnapshot;
  readonly files: readonly FolderFileChange[];
  readonly previews: readonly FolderFilePreview[];
  readonly omittedPreviews: number;
  readonly partial: boolean;
  readonly after: boolean;
  readonly removed: boolean;
  readonly answers: FolderSaveAnswers;
}

export type FolderSaveQuestion = { readonly kind: 'overwrite'; readonly offer: FolderOffer }
  | { readonly kind: 'not-empty'; readonly name: string };

export type FolderSaveState = { readonly kind: 'idle' } | { readonly kind: 'picking' }
  | { readonly kind: 'saving' } | { readonly kind: 'asking'; readonly question: FolderSaveQuestion }
  | { readonly kind: 'saved' };

export type FolderSaveEvent = { readonly type: 'pick' } | { readonly type: 'save' }
  | { readonly type: 'ask'; readonly question: FolderSaveQuestion }
  | { readonly type: 'saved' } | { readonly type: 'fail' } | { readonly type: 'cancel' };

export const folderSaveTable: MachineTable<FolderSaveState, FolderSaveEvent> = {
  id: 'folder.save', initial: 'idle', final: [],
  on: {
    idle: { pick: ['picking'], save: ['saving'] },
    picking: { save: ['saving'], ask: ['asking'], cancel: ['idle'], fail: ['idle'] },
    saving: { ask: ['asking'], saved: ['saved'], fail: ['idle'] },
    asking: { pick: ['picking'], save: ['saving'], cancel: ['idle'] },
    saved: { pick: ['picking'], save: ['saving'] },
  },
};

export function stepFolderSave(state: FolderSaveState, event: FolderSaveEvent): FolderSaveState {
  if (!canMove(folderSaveTable, state.kind, event.type)) return state;
  switch (event.type) {
    case 'pick': return { kind: 'picking' };
    case 'save': return { kind: 'saving' };
    case 'ask': return { kind: 'asking', question: event.question };
    case 'saved': return { kind: 'saved' };
    case 'fail':
    case 'cancel': return { kind: 'idle' };
    default: return assertNever(event);
  }
}

export const folderSaveMachine = defineMachine(folderSaveTable, stepFolderSave);
