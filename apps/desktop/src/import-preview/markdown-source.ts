/**
 * **Import Markdown…** through the shared preview (import-markdown.md, issue #280): the Markdown reader
 * (`@caotang/import-markdown`) turns a file, folder or zip into blocks and per-file front-matter facts, and the splitter source
 * shows them. The front matter's scene facts (synopsis, keywords, point of view, day, story part, notes) are attached to the scene
 * they came from; every other key is kept in notes. Nothing is written until Import, which commits one `binder.importTree`.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts). Loaded on first use by the Import Markdown action
 * (ManuscriptImport.tsx), with the reader host and the splitter, so the first load carries neither.
 */
/* lingui-set comment="The Markdown import. Interpolated values: file (the file's name), count (pictures), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { MarkdownImport, MarkdownError } from '@caotang/import-markdown';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewNode, PreviewOption, PreviewPicture } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const MARKDOWN_OPTIONS = { pictures: 'pictures' } as const;

/** Why the reader stopped, in words. */
export function markdownErrorText(error: MarkdownError): string {
  switch (error.kind) {
    case 'ask-encoding':
      return t`Its text encoding could not be recognised. Save it as UTF-8 and import it again.`;
    case 'too-large':
      return t`It is larger than a Markdown import reads.`;
    case 'too-many-lines':
      return t`It has more lines than a Markdown import reads.`;
    case 'no-markdown':
      return t`It holds no Markdown files.`;
    case 'archive':
      return error.message;
  }
}

/** Attach each scene's front-matter facts, keyed by the file its first block came from. */
function attachFacts(tree: readonly PreviewNode[], read: MarkdownImport): readonly PreviewNode[] {
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

/** A Markdown file, folder or zip in the preview, read in the Worker. */
function makeMarkdownSource(fileName: string, openReq: ReaderOpen): ImportPreviewSource {
  const host = new ReaderHost();
  let current: MarkdownImport | null = null;
  let loaded = false;

  const readAs = async (signal: AbortSignal): Promise<MarkdownImport> => {
    if (current !== null) return current;
    const reply = await host.read({ kind: 'read', reader: 'markdown' }, signal);
    if (reply.kind !== 'markdown') throw new Error(t`It is not a Markdown import.`);
    if (!reply.result.ok) throw new Error(markdownErrorText(reply.result.error));
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
    return [{ id: MARKDOWN_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }];
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
    readKey: () => 'markdown',
    readerOptions,
    picturesOption: MARKDOWN_OPTIONS.pictures,
    pictures,
  });

  return {
    ...base,
    plan: (settings, overrides) => {
      const plan = base.plan(settings, overrides);
      const read = current;
      if (read === null) return plan;
      return { ...plan, tree: attachFacts(plan.tree, read) };
    },
  };
}

/** A single `.md` file. */
export function markdownPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  return makeMarkdownSource(fileName, { kind: 'open', reader: 'markdown', bytes, fileName });
}

/** A folder of Markdown files the writer picked: their paths, sizes and bytes. */
export function markdownFolderPreviewSource(fileName: string, files: readonly { readonly path: string; readonly size: number; readonly bytes: Uint8Array }[]): ImportPreviewSource {
  return makeMarkdownSource(fileName, { kind: 'open', reader: 'markdown-folder', files });
}

/** A zip of Markdown files. */
export function markdownZipPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  return makeMarkdownSource(fileName, { kind: 'open', reader: 'markdown-zip', bytes });
}
