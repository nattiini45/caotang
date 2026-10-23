/**
 * The scan's findings file as the exporter's report reads it — [coherence.md §8, §10](../../../docs/architecture/coherence.md).
 *
 * The report is written by `@caotang/exporter/coherence-report` from the store's `CoherenceState`, and the coherence module holds a
 * `CoherenceFile`. The file is assignable to the state (coherence-state.ts says so), so the mapping is the assignment and nothing else;
 * it sits here so the one place that relies on that is named, and a change to either side fails this function's type check.
 */

import type { CoherenceFile } from '@caotang/coherence';
import type { CoherenceReportInput } from '@caotang/exporter/coherence-report';
import type { CoherenceState, ProjectState } from '@caotang/store';

export function coherenceStateOf(file: CoherenceFile): CoherenceState {
  return file;
}

/** The input to `coherenceReportMarkdown` and `coherenceReportJson` for a scan's file, dated `YYYY-MM-DD`. */
export function reportInputOf(state: ProjectState, file: CoherenceFile, date: string): CoherenceReportInput {
  const titles = new Map(state.manifest.tree.map((node) => [node.id, node.title] as const));
  return {
    title: state.manifest.project.name,
    date,
    file: coherenceStateOf(file),
    docTitle: (docId) => titles.get(docId) ?? '(a document that is no longer in the project)',
  };
}
