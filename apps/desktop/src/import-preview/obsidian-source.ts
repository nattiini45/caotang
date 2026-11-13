/**
 * **Import Obsidian…** through the shared preview (import-obsidian.md, issue #281): the Obsidian vault reader
 * (`@caotang/import-obsidian`) turns a vault folder or zip into blocks, codex notes and the Longform index over the Markdown
 * reader, and the splitter source shows them. Codex notes become preview rows the writer can confirm or fix; nothing is written
 * until Import, which commits one `binder.importTree`.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts). Loaded on first use by the Import Obsidian action
 * (ManuscriptImport.tsx), with the reader host and the splitter, so the first load carries neither.
 */
/* lingui-set comment="The Obsidian import. Interpolated values: file (the file's name), count (pictures), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { ObsidianImport, ObsidianError } from '@caotang/import-obsidian';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewCodexRow, PreviewNode, PreviewOption, PreviewPicture } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const OBSIDIAN_OPTIONS = { pictures: 'pictures' } as const;

/** Why the reader stopped, in words. */
export function obsidianErrorText(error: ObsidianError): string {
  switch (error.kind) {
    case 'no-markdown':
      return t`It holds no Markdown notes.`;
    case 'archive':
      return error.message;
  }
}

/** Attach each scene's front-matter facts, keyed by the note its first block came from. */
function attachFacts(tree: readonly PreviewNode[], read: ObsidianImport): readonly PreviewNode[] {
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

/** An Obsidian vault folder or zip in the preview, read in the Worker. */
function makeObsidianSource(fileName: string, openReq: ReaderOpen): ImportPreviewSource {
  const host = new ReaderHost();
  let current: ObsidianImport | null = null;
  let loaded = false;

  const readAs = async (signal: AbortSignal): Promise<ObsidianImport> => {
    if (current !== null) return current;
    const reply = await host.read({ kind: 'read', reader: 'obsidian' }, signal);
    if (reply.kind !== 'obsidian') throw new Error(t`It is not an Obsidian import.`);
    if (!reply.result.ok) throw new Error(obsidianErrorText(reply.result.error));
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
    return [{ id: OBSIDIAN_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }];
  };

  const codexRows = (): PreviewCodexRow[] => {
    const read = current;
    if (read === null) return [];
    return read.codex.map((note) => ({
      id: note.path,
      name: note.name,
      type: note.type,
      ...(note.aliases.length === 0 ? {} : { aliases: [...note.aliases] }),
      description: note.body.slice(0, 200),
      page: { title: note.name, body: note.body },
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
    readKey: () => 'obsidian',
    readerOptions,
    picturesOption: OBSIDIAN_OPTIONS.pictures,
    pictures,
    report: () => {
      const read = current;
      if (read === null) return [];
      const r = read.resolved;
      const lines: string[] = [];
      const wikilinks = r.wikilinks;
      if (wikilinks > 0) lines.push(plural(wikilinks, { one: '# wikilink became its display text', other: '# wikilinks became their display text' }));
      const comments = r.comments;
      if (comments > 0) lines.push(plural(comments, { one: '# comment became a note', other: '# comments became notes' }));
      const highlights = r.highlights;
      if (highlights > 0) lines.push(plural(highlights, { one: '# highlight kept its text', other: '# highlights kept their text' }));
      const callouts = r.callouts;
      if (callouts > 0) lines.push(plural(callouts, { one: '# callout stayed a labelled blockquote', other: '# callouts stayed labelled blockquotes' }));
      const dataview = r.dataview;
      if (dataview > 0) lines.push(plural(dataview, { one: '# Dataview field became metadata', other: '# Dataview fields became metadata' }));
      const blockIds = r.blockIds;
      if (blockIds > 0) lines.push(plural(blockIds, { one: '# block id was removed', other: '# block ids were removed' }));
      if (lines.length === 0) return [];
      return [{ heading: t`Obsidian syntax`, label: t`What the import resolved`, lines }];
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

/** An Obsidian vault folder the writer picked: its files' paths, sizes and bytes. */
export function obsidianPreviewSource(fileName: string, files: readonly { readonly path: string; readonly size: number; readonly bytes: Uint8Array }[]): ImportPreviewSource {
  return makeObsidianSource(fileName, { kind: 'open', reader: 'obsidian-folder', files });
}

/** A zipped Obsidian vault. */
export function obsidianZipPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  return makeObsidianSource(fileName, { kind: 'open', reader: 'obsidian-zip', bytes });
}
