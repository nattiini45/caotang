import { t } from '@lingui/core/macro';
import type { AutosaveStatus } from '@caotang/store';

export function documentSaveState(status: Pick<AutosaveStatus, 'state' | 'revisionConflict'>): AutosaveStatus['state'] {
  return status.revisionConflict ? 'conflict' : status.state;
}

export function saveConflictWords(): string {
  return t`Newer text is already saved for this document. Your words are kept in this tab. Copy your unsaved text somewhere safe before reloading.`;
}
