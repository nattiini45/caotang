import { t } from '@lingui/core/macro';
import { RevisionConflictError, type AutosaveStatus } from '@caotang/store';

export function documentSaveState(status: Pick<AutosaveStatus, 'state' | 'lastError'>): AutosaveStatus['state'] {
  return status.lastError instanceof RevisionConflictError ? 'conflict' : status.state;
}

export function saveConflictWords(): string {
  return t`Newer text is already saved for this document. Your words are kept in this tab. Copy them somewhere safe before reloading.`;
}
