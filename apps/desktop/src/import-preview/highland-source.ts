/**
 * The Highland import on the shared preview (issue #284). A `.highland` package is a zip of a customised TextBundle; the reader
 * (`@caotang/import-highland`) unzips it, routes the script to the Fountain importer and collects the `assets/` pictures. The
 * scenes become screenplay documents under their sections, and the pictures ride along in the same undo step. What the import
 * cannot keep (the bin, the revisions, the planning metadata) is reported first. **Import** commits one `binder.importTree`, the
 * pictures included; nothing is written on Cancel. The package is unzipped and parsed in the preview's `'self'` Worker host
 * (reader-host.ts), under the archive reader's size and entry caps, the host's hard timeout and the dialog's Cancel.
 *
 * Loaded on first use by the Import Highland action (ScriptImport.tsx), with the reader host, so the first load carries neither.
 */
/* lingui-set comment="The Highland import. Interpolated values: file (the file's name), count (scenes or pictures), size (megabytes), name (a section, scene or picture)" */

import { plural, t } from '@lingui/core/macro';
import type { HighlandAsset, HighlandImport } from '@caotang/import-highland';
import { ARCHIVE_LIMITS } from '@caotang/import-read/zip';
import type { ImportedScript } from '@caotang/screenplay';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewBlock, PreviewMarker, PreviewNode, PreviewOption, PreviewPicture, PreviewPlan } from './model.js';
import { ReaderHost } from './reader-host.js';

export const HIGHLAND_OPTIONS = { pictures: 'pictures' } as const;

/** The refs the source gives its pictures: `import:` tokens over the package's `assets/` paths (import-preview.md §5). */
const ASSET_PREFIX = 'import:';

/** Why a file of this size is not read at all, before its bytes are loaded; undefined when the archive reader takes it. */
export function highlandSizeRefusal(fileName: string, size: number): string | undefined {
  if (size <= ARCHIVE_LIMITS.maxArchiveBytes) return undefined;
  return t`${{ file: fileName }} is too large to import as Highland: the import reads files up to ${{ size: formatCount(ARCHIVE_LIMITS.maxArchiveBytes / (1024 * 1024)) }} MB.`;
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** How many missing pictures the report names before it counts the rest. */
const NAMED_LIMIT = 20;

/** An image whose path points into the package's `assets/` folder, with `./` or `../` in front of it as Highland writes them. */
const ASSET_IMAGE = /!\[([^\]]*)\]\((?:\.{1,2}\/)*assets\/([^)]+)\)/g;

/**
 * A scene's body with the package's picture references rewritten to the import's `import:` refs. A picture the package does not
 * carry keeps its alt text and is named as a loss: leaving `import:assets/…` behind would put a token that resolves to nothing in
 * the writer's screenplay.
 */
function rewriteAssetRefs(body: string, carried: ReadonlySet<string>, missing: Map<string, string>): string {
  return body.replace(ASSET_IMAGE, (_whole, alt: string, name: string) => {
    const path = `assets/${name}`;
    if (carried.has(path)) return `![${alt}](${ASSET_PREFIX}${path})`;
    missing.set(path, alt);
    return alt;
  });
}

/** A node while the tree is being built; the finished tree is handed over as `PreviewNode`s. */
interface DraftNode {
  id: string;
  role: 'part' | 'chapter' | 'scene';
  title: string;
  startBlock: number;
  endBlock: number;
  words: number;
  children: DraftNode[];
  body?: string;
  synopsis?: string;
  kind?: 'screenplay';
}

/** The Fountain structure as the preview's tree: sections nest by depth, each scene is a screenplay document under its section. */
function scriptPlan(script: ImportedScript, assets: readonly HighlandAsset[]): {
  readonly blocks: PreviewBlock[];
  readonly markers: PreviewMarker[];
  readonly tree: PreviewNode[];
  readonly scenes: number;
  readonly chapters: number;
  readonly parts: number;
  readonly words: number;
  readonly pictureLosses: readonly string[];
} {
  const blocks: PreviewBlock[] = [];
  const markers: PreviewMarker[] = [];
  const root: DraftNode[] = [];
  const open: { readonly depth: number; readonly node: DraftNode }[] = [];
  const carried = new Set(assets.map((asset) => asset.path));
  const missing = new Map<string, string>();
  let loose: DraftNode | null = null;
  let scenes = 0;
  let chapters = 0;
  let parts = 0;
  let words = 0;
  let sectionIndex = 0;
  let sceneIndex = 0;
  let bodyText = '';

  const siblingsAt = (depth: number): DraftNode[] => {
    while (open.length > 0 && (open[open.length - 1]?.depth ?? 0) >= depth) open.pop();
    return open.length > 0 ? (open[open.length - 1] as { node: DraftNode }).node.children : root;
  };

  for (const node of script.nodes) {
    if (node.kind === 'section') {
      const siblings = siblingsAt(node.depth);
      const startBlock = blocks.length;
      blocks.push({ kind: 'heading', text: node.title });
      markers.push({ blockIndex: startBlock, kind: node.depth === 1 ? 'part' : 'chapter', reason: t`the section “${{ name: node.title }}”` });
      if (node.synopsis !== '') blocks.push({ kind: 'para', text: node.synopsis });
      const chapter: DraftNode = {
        id: `section-${sectionIndex++}`,
        role: node.depth === 1 ? 'part' : 'chapter',
        title: node.title,
        startBlock,
        endBlock: Math.max(startBlock, blocks.length - 1),
        words: 0,
        children: [],
        ...(node.synopsis === '' ? {} : { synopsis: node.synopsis }),
      };
      siblings.push(chapter);
      open.push({ depth: node.depth, node: chapter });
      chapters += 1;
      if (node.depth === 1) parts += 1;
      continue;
    }

    // A scene: under the innermost open section, or one chapter the import makes for the scenes before the first section.
    let siblings: DraftNode[];
    if (open.length > 0) siblings = (open[open.length - 1] as { node: DraftNode }).node.children;
    else {
      if (loose === null) {
        loose = { id: 'loose-scenes', role: 'chapter', title: t`Imported scenes`, startBlock: blocks.length, endBlock: blocks.length, words: 0, children: [] };
        root.push(loose);
        chapters += 1;
      }
      siblings = loose.children;
    }
    const body = rewriteAssetRefs(node.body, carried, missing);
    bodyText += `${body}\n`;
    const startBlock = blocks.length;
    const lines = body.split('\n').filter((line) => line.trim() !== '');
    lines.forEach((line, i) => {
      blocks.push({ kind: i === 0 && node.heading !== null ? 'heading' : 'para', text: line });
    });
    if (node.heading !== null) markers.push({ blockIndex: startBlock, kind: 'scene', reason: t`the scene heading “${{ name: node.heading }}”` });
    const sceneWords = wordsIn(body);
    words += sceneWords;
    const scene: DraftNode = {
      id: `scene-${sceneIndex++}`,
      role: 'scene',
      title: node.nodeTitle ?? node.title,
      startBlock,
      endBlock: Math.max(startBlock, blocks.length - 1),
      words: sceneWords,
      children: [],
      body,
      kind: 'screenplay',
      ...(node.synopsis === '' ? {} : { synopsis: node.synopsis }),
    };
    siblings.push(scene);
    scenes += 1;
  }

  // The pictures the script does not place: a chapter of their own, so they ride along too (the keep-everything rule).
  const unplaced = assets.filter((asset) => !bodyText.includes(`](${ASSET_PREFIX}${asset.path})`));
  if (unplaced.length > 0) {
    const startBlock = blocks.length;
    blocks.push({ kind: 'heading', text: t`Pictures` });
    for (const asset of unplaced) blocks.push({ kind: 'image', text: asset.path.slice('assets/'.length) });
    const body = unplaced.map((asset) => `![${asset.path.slice('assets/'.length)}](${ASSET_PREFIX}${asset.path})`).join('\n\n');
    const scene: DraftNode = { id: 'pictures-scene', role: 'scene', title: t`Pictures`, startBlock, endBlock: Math.max(startBlock, blocks.length - 1), words: 0, children: [], body, kind: 'screenplay' };
    root.push({ id: 'pictures', role: 'chapter', title: t`Pictures`, startBlock, endBlock: Math.max(startBlock, blocks.length - 1), words: 0, children: [scene] });
    chapters += 1;
    scenes += 1;
  }

  const named = [...missing.keys()].slice(0, NAMED_LIMIT);
  const rest = missing.size - named.length;
  const total = missing.size;
  const paths = named.join(', ');
  const pictureLosses = total === 0
    ? []
    : [
        rest > 0
          ? t`${{ paths }} and ${{ count: formatCount(rest) }} more ${plural(total, { one: 'picture is named', other: 'pictures are named' })} in the script but not carried in the package; the words beside each one are kept.`
          : t`${{ paths }} ${plural(total, { one: 'is named', other: 'are named' })} in the script but not carried in the package; the words beside each one are kept.`
      ];

  return { blocks, markers, tree: root, scenes, chapters, parts, words, pictureLosses };
}

/** The Highland file in the preview, read in the Worker. */
export function highlandPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  let read: HighlandImport | null = null;

  const pictures = (): PreviewPicture[] => {
    const imported = read;
    if (imported === null) return [];
    return imported.assets.map((asset) => ({
      ref: `${ASSET_PREFIX}${asset.path}`,
      name: asset.path.slice('assets/'.length),
      bytes: asset.bytes.length,
      data: () => asset.bytes,
    }));
  };

  const options = (): readonly PreviewOption[] => {
    const shown = pictures();
    const count = shown.length;
    const megabytes = shown.reduce((sum, picture) => sum + picture.bytes, 0) / 1_000_000;
    return count === 0
      ? []
      : [{ id: HIGHLAND_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }];
  };

  const plan = (): PreviewPlan => {
    const imported = read;
    if (imported === null) return { blocks: [], markers: [], tree: [], counts: { words: 0, parts: 0, chapters: 0, scenes: 0, images: 0, comments: 0, footnotes: 0 }, losses: [], flags: [] };
    const built = scriptPlan(imported.script, imported.assets);
    return {
      blocks: built.blocks,
      markers: built.markers,
      tree: built.tree,
      counts: { words: built.words, parts: built.parts, chapters: built.chapters, scenes: built.scenes, images: imported.assets.length, comments: 0, footnotes: 0 },
      losses: [...imported.losses.map((message) => ({ message })), ...built.pictureLosses.map((message) => ({ message }))],
      flags: [],
    };
  };

  return {
    fileName,
    title: t`Import “${{ file: fileName }}”`,
    intro: t`This Highland script becomes screenplay documents under its sections. Read what the import does not keep first.`,
    readOnly: true,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open({ kind: 'open', reader: 'highland', bytes }, signal);
      const reply = await host.read({ kind: 'read', reader: 'highland', fileName }, signal);
      if (reply.kind !== 'highland') throw new Error(t`The file could not be read as a Highland script.`);
      if (!reply.result.ok) throw new Error(reply.result.error.message);
      read = reply.result.value;
    },
    dispose: () => host.dispose(),
    chips: () => [],
    options,
    plan: () => plan(),
    picturesOption: HIGHLAND_OPTIONS.pictures,
    pictures,
    metadata: () => ({ title: read?.title ?? '' }),
    report: () => {
      const imported = read;
      if (imported === null) return [];
      const lists = [];
      if (imported.assets.length > 0) {
        lists.push({
          heading: t`Pictures`,
          label: t`Pictures from the package's assets folder`,
          lines: imported.assets.map((asset) => asset.path),
        });
      }
      if (imported.notices.length > 0) {
        lists.push({ heading: t`Notes`, label: t`Notes`, lines: imported.notices });
      }
      return lists;
    },
    importLabel: (preview) => {
      const scenes = preview.counts.scenes;
      return plural(scenes, { one: 'Import # scene', other: 'Import # scenes' });
    },
  };
}
