/**
 * Whether the import scan flags a row of a script's codex seeds as reading like instructions to an AI (issue #54).
 *
 * Such a row is added with the include policy `manual`, as `codex.importBatch` adds a flagged row, so it reaches a generation only in
 * the documents it is attached to until the writer has read it. The import action and the Final Draft dialog both ask this, so the rule
 * lives here rather than in either of them: the dialog is a chunk of its own, loaded when a Final Draft file is read.
 */

import { scanImport } from '@caotang/harness';

import type { FdxCodexSeed } from '@caotang/screenplay';

export function seedFlagged(seed: Pick<FdxCodexSeed, 'name' | 'description'>): boolean {
  return scanImport([
    { where: 'name', text: seed.name },
    { where: 'description', text: seed.description },
  ]).total > 0;
}
