import { DEFAULT_RECIPE_NAME } from '@caotang/bus';
import type { ExportRecipe, Manifest, TreeNode } from './manifest.js';
import { FIXED_ROOT_IDS, FORMAT_VERSION } from './manifest.js';
import { defaultLanguage, mintIdentifier, type BackfillOptions } from './project-identity.js';
import { newId } from '@caotang/ids';
import { WORD_RULE_VERSION, wordRuleInUse } from './word-count.js';

export type { Manifest, TreeNode };
// The bus's constant, under the name the store has always exported it (index.ts re-exports it from here).
export { DEFAULT_RECIPE_NAME };

/**
 * The recipe every new project starts with (exporter.md §2: "default recipe auto-created per project"), and the one a project that
 * stores no recipes holds (exporter.md §4): it compiles the whole manuscript to Word, the format the launch contract names first. Its
 * name is the bus's `DEFAULT_RECIPE_NAME`, which the bus checks an export against. Its template is the default one (exporter.md §4:
 * "docx, the manuscript root, the default template"), so the record a save or a delete stores is the one the exporter offered before it.
 */
export function defaultRecipe(): ExportRecipe {
  // `default` is the exporter's DEFAULT_TEMPLATE_ID; the store sits below the exporter, so it names the id rather than importing it.
  return { name: DEFAULT_RECIPE_NAME, includeRootIds: ['manuscript'], format: 'docx', templateId: 'default', options: {} };
}

/** Fresh, empty project: the three fixed roots and nothing else. */
export function createEmptyManifest(name: string, now: Date = new Date(), options: BackfillOptions = {}): Manifest {
  const ts = now.toISOString();
  const base = { status: null, label: null, keywords: [], synopsis: '', notes: '' };
  return {
    app: 'caotang',
    formatVersion: FORMAT_VERSION,
    project: {
      id: newId('p'),
      name,
      createdAt: ts,
      modifiedAt: ts,
      // epub-metadata.md: minted once here, never again. A project that predates the slots gets them on open instead.
      language: defaultLanguage(options.locale),
      identifier: { uuid: mintIdentifier(options.uuid) },
    },
    vocabulary: {
      statuses: [
        { id: 'draft', name: 'Draft', color: '#8a8a8a' },
        { id: 'revised', name: 'Revised', color: '#4a90d9' },
        { id: 'final', name: 'Final', color: '#3fa66a' },
      ],
      labels: [],
    },
    tree: [
      { ...base, id: 'root', parentId: null, type: 'root', title: name, order: 0 },
      { ...base, id: 'manuscript', parentId: 'root', type: 'folder', title: 'Manuscript', order: 10 },
      { ...base, id: 'research', parentId: 'root', type: 'folder', title: 'Research', order: 20 },
    ],
    derived: { wordCounts: {}, computedAt: ts, ...(wordRuleInUse() === WORD_RULE_VERSION ? { ruleVersion: WORD_RULE_VERSION } : {}) },
    codex: [],
    recipes: [defaultRecipe()],
  };
}

/** True for the three reserved root ids, which the UI may not delete. */
export function isFixedRoot(id: string): boolean {
  return (FIXED_ROOT_IDS as readonly string[]).includes(id);
}

/** Next sibling order for a create: `maxSiblingOrder + 10` (gap-encoded). */
export function nextSiblingOrder(tree: readonly TreeNode[], parentId: string | null): number {
  const siblings = tree.filter((n) => n.parentId === parentId);
  const max = siblings.reduce((acc, n) => Math.max(acc, n.order), 0);
  return max + 10;
}
