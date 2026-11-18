/**
 * The Inklewriter import on the shared preview (issue #286). inkle's converter (vendored in `@caotang/import-inklewriter`) turns a
 * story export into Ink, and the shared planner turns that into dialogue containers, one per knot-cluster. The tree is those
 * containers and the writer only reads it: what the import cannot keep (the editor's stitch positions), the stitch images
 * listed by URL, the planner's own notes (which knot the story starts at, and any line it could not read) and every section
 * or flag name the reader had to change are reported first, and **Import** writes them with `dialogue.importInk`, one undo
 * step. Nothing is written on Cancel. The JSON is parsed and converted in the preview's `'self'` Worker host (reader-host.ts),
 * under its hard timeout and the dialog's Cancel; the images are never fetched (this import offers no download control).
 *
 * Loaded on first use by the Import Inklewriter action (ScriptImport.tsx), with the reader host, so the first load carries neither.
 */
/* lingui-set comment="The Inklewriter import. Interpolated values: file (the file's name), count (containers or images), title (the story's title), url (an image's address), stitch (the stitch an image sits in), from (a section label or Inklewriter flag name as written), to (the name it is imported under)" */

import { plural, t } from '@lingui/core/macro';
import type { InklewriterImport } from '@caotang/import-inklewriter';

import type { ImportPreviewSource, PreviewBlock, PreviewMarker, PreviewNode, PreviewOption, PreviewPlan, PreviewSettings } from './model.js';
import { ReaderHost } from './reader-host.js';

/** The Ink knot heading the planner writes for each section. */
const KNOT = /^={2,}\s*(.+?)\s*={2,}\s*$/;

const LINE_IDS_OPTION = 'line-ids';

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** One container as a read-only tree node, with its body's lines as the text pane's blocks. */
function containerPlan(containers: InklewriterImport['plan']['containers']): {
  readonly blocks: PreviewBlock[];
  readonly markers: PreviewMarker[];
  readonly tree: PreviewNode[];
  readonly words: number;
} {
  const blocks: PreviewBlock[] = [];
  const markers: PreviewMarker[] = [];
  const tree: PreviewNode[] = [];
  let words = 0;
  containers.forEach((container, index) => {
    const startBlock = blocks.length;
    for (const line of container.body.split('\n')) {
      if (line.trim() === '') continue;
      const knot = KNOT.exec(line);
      if (knot !== null) {
        markers.push({ blockIndex: blocks.length, kind: 'scene', reason: t`the knot “${{ name: knot[1] ?? '' }}”` });
        blocks.push({ kind: 'heading', text: knot[1] ?? line });
      } else {
        blocks.push({ kind: 'para', text: line });
        words += wordsIn(line);
      }
    }
    tree.push({
      id: `container-${index}`,
      role: 'container',
      title: container.title,
      startBlock,
      endBlock: Math.max(startBlock, blocks.length - 1),
      words: wordsIn(container.body),
      body: container.body,
    });
  });
  return { blocks, markers, tree, words };
}

export function inklewriterPreviewSource(options: {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** Writes the containers (one `dialogue.importInk`), minting line ids first when asked; the caller reports what was made. */
  readonly write: (containers: InklewriterImport['plan']['containers'], addIds: boolean) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
}): ImportPreviewSource {
  const { fileName, bytes } = options;
  const host = new ReaderHost();
  let read: InklewriterImport | null = null;
  let addIds = false;

  const plan = (settings: PreviewSettings): PreviewPlan => {
    addIds = settings.options[LINE_IDS_OPTION] === true;
    const imported = read;
    const containers = imported?.plan.containers ?? [];
    const built = containerPlan(containers);
    return {
      blocks: built.blocks,
      markers: built.markers,
      tree: built.tree,
      counts: { words: built.words, parts: 0, chapters: 0, scenes: containers.length, images: imported?.images.length ?? 0, comments: 0, footnotes: 0 },
      losses: (imported?.losses ?? []).map((message) => ({ message })),
      flags: [],
    };
  };

  return {
    fileName,
    title: t`Import “${{ file: fileName }}”`,
    intro: t`This Inklewriter story becomes one dialogue container for each knot-cluster. Read what the import does not keep first.`,
    readOnly: true,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open({ kind: 'open', reader: 'inklewriter', bytes }, signal);
      const reply = await host.read({ kind: 'read', reader: 'inklewriter', fileName }, signal);
      if (reply.kind !== 'inklewriter') throw new Error(t`The file could not be read as an Inklewriter story.`);
      if (!reply.result.ok) throw new Error(reply.result.error.message);
      read = reply.result.value;
    },
    dispose: () => host.dispose(),
    chips: () => [],
    options: (): readonly PreviewOption[] => [
      { id: LINE_IDS_OPTION, label: t`Add line ids`, checked: false, detail: t`Each choice and divert gets a stable id, so a later import can find the same line.` },
    ],
    plan: (settings) => plan(settings),
    metadata: () => ({ title: read?.title ?? '' }),
    report: () => {
      const imported = read;
      if (imported === null) return [];
      const lists = [];
      if (imported.images.length > 0) {
        lists.push({
          heading: t`Images`,
          label: t`Images, listed by address; the import does not download them`,
          lines: imported.images.map((image) => t`${{ url: image.url }} (in “${{ stitch: image.stitch }}”)`),
        });
      }
      // The planner's own notes belong here: which knot the story starts at (an entry that is not a container, so the
      // writer has to recreate it), and any line it could not read. Without them the entry point was dropped in silence.
      const notes = [
        ...imported.plan.notes,
        ...imported.notices,
        ...imported.renames.map((rename) =>
          rename.kind === 'section'
            ? t`The section “${{ from: rename.from }}” has no letters or digits ink can use in a name, so it is imported as “${{ to: rename.to }}”.`
            : t`The variable “${{ from: rename.from }}” has no letters or digits ink can use in a name, so it is imported as “${{ to: rename.to }}”.`,
        ),
      ];
      if (notes.length > 0) {
        lists.push({ heading: t`Notes`, label: t`Notes`, lines: notes });
      }
      return lists;
    },
    importLabel: (preview) => {
      const containers = preview.counts.scenes;
      return plural(containers, { one: 'Import # container', other: 'Import # containers' });
    },
    commit: () => options.write(read?.plan.containers ?? [], addIds),
  };
}
