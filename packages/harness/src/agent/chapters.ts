import { err, ok, type CommandError, type Result } from '@caotang/bus';
import { entryWithheld } from '@caotang/context';
import type { ProjectState } from '@caotang/store';

import { refusal } from '../errors.js';
import { childrenOf, descendantsOf, resolveNode } from '../resolve.js';

interface Chapter {
  readonly id: string;
  readonly scope: readonly string[];
  readonly state: ProjectState;
}

export function chaptersOf(state: ProjectState, scope: readonly string[] | undefined, hidden: ReadonlySet<string>, excludedCodex: ReadonlySet<string>): Result<readonly Chapter[], CommandError> {
  const isChapter = (node: ProjectState['manifest']['tree'][number]): boolean =>
    node.parentId === 'manuscript' && node.type === 'folder' && !hidden.has(node.id);
  const chosen = new Set<string>();
  for (const [index, ref] of (scope ?? []).entries()) {
    const chapter = resolveNode(state, ref, isChapter, 'top-level Manuscript folder', `scope[${index}]`);
    if (!chapter.ok) return err(chapter.error);
    chosen.add(chapter.value.id);
  }
  const codex = state.manifest.codex?.filter((entry) => !entryWithheld(entry, hidden) && !excludedCodex.has(entry.id));
  const chapters = childrenOf(state, 'manuscript').filter((node) => isChapter(node) && (scope === undefined || chosen.has(node.id))).flatMap((chapter) => {
    const visible = new Set(['root', 'manuscript', chapter.id]);
    const docs: string[] = [];
    for (const node of descendantsOf(state, chapter.id)) {
      if (node.parentId === null || !visible.has(node.parentId) || hidden.has(node.id)) continue;
      visible.add(node.id);
      if (node.type === 'document') docs.push(node.id);
    }
    if (docs.length === 0) return [];
    const tree = state.manifest.tree.filter((node) => visible.has(node.id));
    return [{ id: chapter.id, scope: docs, state: { ...state, manifest: { ...state.manifest, tree, ...(codex === undefined ? {} : { codex }) } } }];
  });
  if (chapters.length === 0 || (scope !== undefined && chapters.length !== chosen.size)) {
    return err(refusal('invalid-params', 'Chapter delegation needs readable documents in each selected chapter.', {
      target: 'agent.delegate',
      correctiveHint: 'choose nonempty top-level folders under Manuscript',
    }));
  }
  return ok(chapters);
}
