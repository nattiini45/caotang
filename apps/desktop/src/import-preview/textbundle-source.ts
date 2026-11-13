/**
 * **Import TextBundle…** through the shared preview (import-textbundle.md, issue #282): the TextBundle/TextPack reader
 * (`@caotang/import-textbundle`) turns a Ulysses, Bear or iA Writer bundle into blocks and per-file facts over the Markdown reader,
 * and the splitter source shows them. The app's comments, tags and Content Blocks are mapped by the reader; nothing is written until
 * Import, which commits one `binder.importTree`.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts). Loaded on first use by the Import TextBundle action
 * (ManuscriptImport.tsx), with the reader host and the splitter, so the first load carries neither.
 */
/* lingui-set comment="The TextBundle import. Interpolated values: file (the file's name), count (pictures), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { TextBundleImport, TextBundleError } from '@caotang/import-textbundle';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewNode, PreviewOption, PreviewPicture, PreviewReportList } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const TEXTBUNDLE_OPTIONS = { pictures: 'pictures' } as const;

/** Why the reader stopped, in words. */
export function textbundleErrorText(error: TextBundleError): string {
  switch (error.kind) {
    case 'no-text':
      return t`It holds no Markdown text file.`;
    case 'fountain':
      return t`It is a Fountain script. Use Import script to import it.`;
    case 'ask-encoding':
      return t`Its text encoding could not be recognised. Save it as UTF-8 and import it again.`;
    case 'too-large':
      return t`It is larger than a TextBundle import reads.`;
    case 'too-many-lines':
      return t`It has more lines than a TextBundle import reads.`;
    case 'archive':
      return error.message;
  }
}

/** Attach each scene's front-matter facts, keyed by the file its first block came from. */
function attachFacts(tree: readonly PreviewNode[], read: TextBundleImport): readonly PreviewNode[] {
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

/** A TextBundle folder or TextPack zip in the preview, read in the Worker. */
function makeTextBundleSource(fileName: string, openReq: ReaderOpen): ImportPreviewSource {
  const host = new ReaderHost();
  let current: TextBundleImport | null = null;
  let loaded = false;

  const readAs = async (signal: AbortSignal): Promise<TextBundleImport> => {
    if (current !== null) return current;
    const reply = await host.read({ kind: 'read', reader: 'textbundle' }, signal);
    if (reply.kind !== 'textbundle') throw new Error(t`It is not a TextBundle import.`);
    if (!reply.result.ok) throw new Error(textbundleErrorText(reply.result.error));
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
    return [{ id: TEXTBUNDLE_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }];
  };

  const report = (): PreviewReportList[] => {
    const read = current;
    if (read === null || read.notices.length === 0) return [];
    const lines = read.notices.map((notice) => {
      if (notice.kind === 'ulysses-comments') {
        const count = notice.count;
        return plural(count, { one: '# Ulysses comment kept as a note.', other: '# Ulysses comments kept as notes.' });
      }
      if (notice.kind === 'bear-tags') {
        const count = notice.count;
        return plural(count, { one: '# Bear tag kept as a keyword.', other: '# Bear tags kept as keywords.' });
      }
      return t`The iA Writer Authorship block was kept out of the body.`;
    });
    return [{ heading: t`What the import mapped`, label: t`Notices`, lines }];
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
    readKey: () => 'textbundle',
    readerOptions,
    picturesOption: TEXTBUNDLE_OPTIONS.pictures,
    pictures,
    report,
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

/** A `.textbundle` folder the writer picked: its files' paths, sizes and bytes. */
export function textbundlePreviewSource(fileName: string, files: readonly { readonly path: string; readonly size: number; readonly bytes: Uint8Array }[]): ImportPreviewSource {
  return makeTextBundleSource(fileName, { kind: 'open', reader: 'textbundle-folder', files });
}

/** A TextPack (`.textpack` zip) or a zipped bundle. */
export function textbundleZipPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  return makeTextBundleSource(fileName, { kind: 'open', reader: 'textbundle-zip', bytes });
}
