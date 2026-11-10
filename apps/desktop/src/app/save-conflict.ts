import { t } from '@lingui/core/macro';

export function saveConflictWords(): string {
  return t`Newer text is already saved for this document. Your words are kept in this tab. Export a backup before reloading.`;
}
