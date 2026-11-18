/**
 * **Import NovelCrafter…** through the shared preview (import-novelcrafter.md, issue #292): the NovelCrafter reader
 * (`@caotang/import-novelcrafter`) turns an export zip into codex entries and any manuscript Markdown over the Markdown
 * reader, and the splitter source shows them. Codex entries become preview rows the writer can confirm or fix; their
 * relations, custom fields and notes are kept in the research text. Nothing is written until Import, which commits one
 * `binder.importTree`.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts). Loaded on first use by the Import NovelCrafter
 * action (ManuscriptImport.tsx), with the reader host and the splitter, so the first load carries neither.
 */
/* lingui-set comment="The NovelCrafter import. Interpolated values: file (the file's name), count (pictures), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import { buildResearchPage, type NovelCrafterImport, type NovelCrafterError } from '@caotang/import-novelcrafter';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewCodexRow, PreviewNode, PreviewOption, PreviewPicture } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const NOVELCRAFTER_OPTIONS = { pictures: 'pictures' } as const;

/** Why the reader stopped, in words. */
export function novelcrafterErrorText(error: NovelCrafterError): string {
  switch (error.kind) {
    case 'empty':
      return t`It holds no codex entries and no manuscript.`;
    case 'archive':
      return error.message;
  }
}

/** Attach each manuscript scene's front-matter facts, keyed by the file its first block came from. */
function attachFacts(tree: readonly PreviewNode[], read: NovelCrafterImport): readonly PreviewNode[] {
  const factsFor = (node: PreviewNode): PreviewNode => {
    const block = read.document.blocks[node.startBlock];
    const unit = block !== undefined && 'src' in block ? block.src?.sourceUnit : undefined;
    const facts = unit === undefined ? undefined : read.frontMatter[unit];
    const children = node.children === undefined ? undefined : attachFacts(node.children, read);
    if (facts === undefined) return children === undefined ? node : { ...node, children };
    const { scene, notes } = facts;
    const fields: Record<string, string | readonly string[]> = { ...(node.fields ?? {}) };
    if (scene.status !== undefined) fields['status'] = scene.status;
    if (scene.label !== undefined) fields['label'] = scene.label;
    return {
      ...node,
      ...(children === undefined ? {} : { children }),
      ...(scene.synopsis === undefined ? {} : { synopsis: scene.synopsis }),
      ...(scene.keywords === undefined ? {} : { keywords: [...(node.keywords ?? []), ...scene.keywords] }),
      ...(notes === '' ? {} : { notes: node.notes === undefined || node.notes === '' ? notes : `${node.notes}\n\n${notes}` }),
      ...(scene.pov === undefined ? {} : { pov: scene.pov }),
      ...(scene.dayOffset === undefined ? {} : { dayOffset: scene.dayOffset }),
      ...(scene.storyPart === undefined ? {} : { storyPart: scene.storyPart }),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
    };
  };
  return tree.map(factsFor);
}

/** A NovelCrafter export in the preview, read in the Worker. */
function makeNovelCrafterSource(fileName: string, openReq: ReaderOpen): ImportPreviewSource {
  const host = new ReaderHost();
  let current: NovelCrafterImport | null = null;
  let loaded = false;

  const readAs = async (signal: AbortSignal): Promise<NovelCrafterImport> => {
    if (current !== null) return current;
    const reply = await host.read({ kind: 'read', reader: 'novelcrafter' }, signal);
    if (reply.kind !== 'novelcrafter') throw new Error(t`It is not a NovelCrafter import.`);
    if (!reply.result.ok) throw new Error(novelcrafterErrorText(reply.result.error));
    current = reply.result.value;
    return reply.result.value;
  };

  const pictures = (): PreviewPicture[] => {
    const read = current;
    if (read === null) return [];
    const alts = new Map<string, string>();
    for (const block of read.document.blocks) if (block.kind === 'image' && block.alt.trim() !== '') alts.set(block.assetRef, block.alt);
    return (read.document.assets ?? []).flatMap((asset) => {
      const data = read.assetData.get(asset.ref);
      if (data === undefined) return [];
      const alt = alts.get(asset.ref);
      return [{ ref: asset.ref, name: asset.name ?? asset.ref, bytes: data.length, ...(alt === undefined ? {} : { alt }), data: () => data }];
    });
  };

  const readerOptions = (): PreviewOption[] => {
    const shown = pictures();
    const count = shown.length;
    if (count === 0) return [];
    const megabytes = shown.reduce((sum, picture) => sum + picture.bytes, 0) / 1_000_000;
    return [{ id: NOVELCRAFTER_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }];
  };

  const codexRows = (): PreviewCodexRow[] => {
    const read = current;
    if (read === null) return [];
    return read.codex.map((entry) => ({
      id: entry.path,
      name: entry.name,
      type: entry.type,
      ...(entry.aliases.length === 0 ? {} : { aliases: [...entry.aliases] }),
      ...(entry.keywords.length === 0 ? {} : { keywords: [...entry.keywords] }),
      description: entry.description.slice(0, 200),
      page: { title: entry.name, body: buildResearchPage(entry) },
    }));
  };

  const base = splitterPreviewSource({
    fileName,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open(openReq, signal);
      await readAs(signal);
      loaded = true;
    },
    prepare: async (_settings, signal) => {
      await readAs(signal);
      loaded = true;
    },
    prepared: () => loaded,
    dispose: () => host.dispose(),
    read: () => ({ doc: current?.document ?? { blocks: [] } }),
    readKey: () => 'novelcrafter',
    readerOptions,
    picturesOption: NOVELCRAFTER_OPTIONS.pictures,
    pictures,
    report: () => {
      const read = current;
      if (read === null) return [];
      const lists = [];
      // A manuscript picked beside the zip wins, so the export's own Markdown is named rather than dropped in silence.
      if (read.leftOut.length > 0) {
        lists.push({
          heading: t`Not in this import`,
          label: t`Left out for the manuscript you chose`,
          lines: read.leftOut.map((path) => t`${{ file: path }} — the export’s own text; the file you picked is the manuscript.`),
        });
      }
      if (read.codex.length === 0) return lists;
      const kept: string[] = [];
      const relations = read.codex.reduce((sum, entry) => sum + entry.relations.length, 0);
      if (relations > 0) kept.push(plural(relations, { one: '# relation listed as a Connection', other: '# relations listed as Connections' }));
      const fields = read.codex.reduce((sum, entry) => sum + Object.keys(entry.fields).length, 0);
      if (fields > 0) kept.push(plural(fields, { one: '# custom field kept in the research text', other: '# custom fields kept in the research text' }));
      const withNotes = read.codex.filter((entry) => entry.notes.trim() !== '').length;
      if (withNotes > 0) kept.push(plural(withNotes, { one: '# entry’s notes kept as research notes', other: '# entries’ notes kept as research notes' }));
      const thumbnails = read.codex.filter((entry) => entry.thumbnail !== undefined).length;
      if (thumbnails > 0) kept.push(plural(thumbnails, { one: '# thumbnail kept as a picture', other: '# thumbnails kept as pictures' }));
      if (kept.length > 0) lists.push({ heading: t`NovelCrafter codex`, label: t`What the import kept`, lines: kept });
      const lost: string[] = [];
      const progressions = read.lost.progressions;
      if (progressions > 0) lost.push(plural(progressions, { one: '# progression stays in NovelCrafter', other: '# progressions stay in NovelCrafter' }));
      lost.push(t`Chats, snippets and prompts are not part of the export.`);
      lists.push({ heading: t`Not in this import`, label: t`What stays in NovelCrafter`, lines: lost });
      return lists;
    },
  });

  return {
    ...base,
    codexRows,
    plan: (settings, overrides) => {
      const plan = base.plan(settings, overrides);
      const read = current;
      if (read === null) return plan;
      return { ...plan, tree: attachFacts(plan.tree, read) };
    },
  };
}

/** A NovelCrafter export folder the writer picked: its files' paths, sizes and bytes. */
export function novelcrafterFolderPreviewSource(fileName: string, files: readonly { readonly path: string; readonly size: number; readonly bytes: Uint8Array }[]): ImportPreviewSource {
  return makeNovelCrafterSource(fileName, { kind: 'open', reader: 'novelcrafter-folder', files });
}

/** A zipped NovelCrafter export (the codex, and the manuscript when it is there). */
export function novelcrafterZipPreviewSource(
  fileName: string,
  bytes: Uint8Array,
  manuscript?: { readonly path: string; readonly bytes: Uint8Array },
): ImportPreviewSource {
  return makeNovelCrafterSource(fileName, {
    kind: 'open',
    reader: 'novelcrafter-zip',
    bytes,
    ...(manuscript === undefined ? {} : { manuscript }),
  });
}
