/**
 * The Knowledge list's and the Inspector's Knowledge section's view models (coherence.md §4.4, §8). Pure functions over the
 * coherence file and the project, so what the panels say is testable without a page. No React here.
 *
 * The ledger is derived, as the spec says: each fact's lines are read from the scenes' `learns` and `knows`, in binder order,
 * and a scene in a mode that does not teach (a dream, a myth) is listed and marked, because the check does not count it.
 */

import { effectiveMode, knowledgeTreatmentOf, type CoherenceFile, type KnowledgeFact } from '@caotang/coherence';
import type { CodexEntry, ProjectState, TreeNode } from '@caotang/store';

import { projectCollator } from '../i18n/project-collator.js';
import { childrenOf } from './binder-model.js';

/** A document in binder order: the depth-first walk, siblings by their order. */
export interface BinderScene {
  readonly docId: string;
  readonly title: string;
}

export function binderScenes(state: ProjectState): BinderScene[] {
  const scenes: BinderScene[] = [];
  const visit = (node: TreeNode): void => {
    if (node.type === 'document') scenes.push({ docId: node.id, title: node.title || node.id });
    for (const child of childrenOf(state, node.id)) visit(child);
  };
  for (const top of state.manifest.tree.filter((node) => node.parentId === null)) visit(top);
  return scenes;
}

/** One line of a fact's ledger: a character and the scene they learn it in, or are shown knowing it in. */
export interface LedgerLine {
  readonly entryId: string;
  /** The character's name, or a phrase for one that is gone. */
  readonly who: string;
  readonly docId: string;
  readonly title: string;
  /** False for a `learns` in a scene whose mode does not teach the character (coherence.md §4.4), which the check leaves out. */
  readonly counts: boolean;
}

export interface KnowledgeRow {
  readonly fact: KnowledgeFact;
  /** The codex entry the fact is about, by name, when it is linked and still there. */
  readonly about?: string;
  readonly learns: readonly LedgerLine[];
  readonly knows: readonly LedgerLine[];
  /** How many `learns` and `knows` pairs name the fact: what removing it takes with it. */
  readonly declarations: number;
}

const GONE_CHARACTER = 'a character that is gone';

/** The Knowledge list: each fact with the lines of its ledger, in the order the file keeps the facts. */
export function knowledgeRows(state: ProjectState, file: CoherenceFile | undefined): KnowledgeRow[] {
  if (file === undefined) return [];
  const entries = new Map((state.manifest.codex ?? []).map((entry) => [entry.id, entry.name] as const));
  const scenes = binderScenes(state);
  return file.knowledge.map((fact) => {
    const lines = (field: 'learns' | 'knows'): LedgerLine[] =>
      scenes.flatMap((scene) => {
        const meta = file.sceneMeta[scene.docId] ?? {};
        const counts = field === 'knows' || knowledgeTreatmentOf(effectiveMode(meta)).teaches;
        return (meta[field] ?? [])
          .filter((link) => link.factId === fact.id)
          .map((link) => ({ entryId: link.entryId, who: entries.get(link.entryId) ?? GONE_CHARACTER, docId: scene.docId, title: scene.title, counts }));
      });
    const learns = lines('learns');
    const knows = lines('knows');
    const about = fact.entryId === undefined ? undefined : entries.get(fact.entryId);
    return { fact, ...(about !== undefined ? { about } : {}), learns, knows, declarations: learns.length + knows.length };
  });
}

/**
 * The characters a Learns or Knows row may name: codex entries of type character, by name. Names are writer content and sort
 * by the **project language** (i18n.md §4.3, D9); a project that names no language yet falls back to the formatter locale.
 */
export function characterCandidates(entries: readonly CodexEntry[], projectLanguage?: string): CodexEntry[] {
  const byName = projectCollator(projectLanguage);
  return entries.filter((entry) => entry.type === 'character').sort((a, b) => byName.compare(a.name, b.name));
}

/** A declared pair in words, for a list in the Inspector: the character and the fact, each by name. */
export function pairWords(
  link: { readonly entryId: string; readonly factId: string },
  entries: readonly CodexEntry[],
  facts: readonly { readonly id: string; readonly text: string }[],
): string {
  const who = entries.find((entry) => entry.id === link.entryId)?.name ?? GONE_CHARACTER;
  const what = facts.find((fact) => fact.id === link.factId)?.text ?? 'a fact that is gone';
  return `${who}: ${what}`;
}
