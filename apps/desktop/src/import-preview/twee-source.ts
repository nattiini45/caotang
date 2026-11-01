/**
 * The Twee import on the shared preview (issue #267, migrated from `TweeImportDialog.tsx`). A Twine story is one dialogue container,
 * so the tree is that container and the writer only reads it: what the import strips is counted first (dialogue-narrative.md §4),
 * and **Import** writes it with `dialogue.importInk`, one undo step, as before. Nothing is written on Cancel.
 */

import { describeTweeReport, type TweeImportPlan } from '@caotang/dialogue';

import type { ImportPreviewSource, PreviewBlock, PreviewMarker, PreviewPlan } from './model.js';

/** The Ink knot heading the Twee planner writes for each passage. */
const KNOT = /^===\s*(.+?)\s*===\s*$/;

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

export function tweePreviewSource(options: {
  readonly fileName: string;
  readonly plan: TweeImportPlan;
  /** Writes the container (one `dialogue.importInk`); the caller reports what was made on the status line. */
  readonly write: () => void;
}): ImportPreviewSource {
  const { fileName, plan: twee } = options;
  const container = twee.container;
  const title = container?.title ?? fileName;
  const blocks: PreviewBlock[] = [];
  const markers: PreviewMarker[] = [];
  for (const line of (container?.body ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const knot = KNOT.exec(line);
    if (knot !== null) {
      markers.push({ blockIndex: blocks.length, kind: 'scene', reason: `passage “${knot[1] ?? ''}” becomes a knot` });
      blocks.push({ kind: 'heading', text: knot[1] ?? line });
    } else {
      blocks.push({ kind: 'para', text: line });
    }
  }
  const words = blocks.reduce((sum, block) => sum + (block.kind === 'para' ? wordsIn(block.text) : 0), 0);
  const preview: PreviewPlan = {
    blocks,
    markers,
    tree: [{ id: 'container', role: 'container', title, startBlock: 0, endBlock: Math.max(0, blocks.length - 1), words, body: container?.body ?? '' }],
    counts: { words, parts: 0, chapters: 0, scenes: twee.report.passages, images: 0, comments: 0, footnotes: 0 },
    losses: [],
    flags: [],
  };
  return {
    fileName,
    title: 'Import this Twee story?',
    intro: `${title} (${fileName}) will be one dialogue container. Read what the import changes first.`,
    readOnly: true,
    chips: () => [],
    options: () => [],
    plan: () => preview,
    report: () => [
      { heading: '', label: 'What the import does', lines: describeTweeReport(twee.report) },
      ...(twee.report.warnings.length === 0 ? [] : [{ heading: 'Warnings', label: 'Warnings', lines: twee.report.warnings }]),
    ],
    importLabel: () => 'Import',
    commit: () => {
      options.write();
      return Promise.resolve({ ok: true });
    },
  };
}
