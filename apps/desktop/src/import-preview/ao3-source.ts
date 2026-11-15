/**
 * **Import AO3…** through the shared preview (import-ao3.md, issue #297): the AO3 adapter (`@caotang/import-ao3`) reads
 * an Archive of Our Own work download — HTML or EPUB — into blocks and the work's own preface. The tags become
 * keywords, the characters are offered as codex rows, the summary becomes the synopsis and the work, chapter and end
 * notes go where they sat. Nothing is written until Import, which commits one `binder.importTree`.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts). Loaded on first use by the Import AO3 action
 * (ManuscriptImport.tsx), with the reader host and the splitter, so the first load carries neither.
 */
/* lingui-set comment="The AO3 import. Interpolated values: file (the file's name), count (pictures, tags, characters), size (megabytes), name (a tag), limit (the keyword limit)" */

import { plural, t } from '@lingui/core/macro';
import type { Ao3Import, Ao3Error } from '@caotang/import-ao3';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewCodexRow, PreviewNode, PreviewOption, PreviewPicture } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const AO3_OPTIONS = { pictures: 'pictures' } as const;

/** What a scene's keywords hold; the rest are listed in the report rather than dropped. */
const KEYWORD_LIMIT = 32;

/** Why the reader stopped, in words. */
export function ao3ErrorText(error: Ao3Error): string {
  switch (error.kind) {
    case 'not-ao3':
      return t`This is not an AO3 download. On the work's page, choose Download and then HTML or EPUB, and import that file.`;
    case 'ask-encoding':
      return t`Its text encoding could not be recognised. Save it as UTF-8 and import it again.`;
    case 'too-large':
      return t`It is larger than an AO3 import reads.`;
    case 'not-xml':
      return t`Its markup is not well-formed, so the import cannot read it.`;
    case 'no-opf':
      return t`It is not an EPUB: it has no package document.`;
    case 'empty':
      return t`Its reading order holds no text.`;
    case 'drm': {
      const file = error.message;
      return t`This book is protected by DRM (${file}), so Caotang cannot read it.`;
    }
    case 'archive':
      return error.message;
  }
}

/** The top-level node a note belongs to: the first, the last, or the one whose text it sat in. */
function ownerOf(tree: readonly PreviewNode[], blockIndex: number, where: 'first' | 'last' | 'at'): number {
  if (tree.length === 0) return -1;
  if (where === 'first') return 0;
  if (where === 'last') return tree.length - 1;
  const at = tree.findIndex((node) => blockIndex >= node.startBlock && blockIndex <= node.endBlock);
  return at < 0 ? 0 : at;
}

/** Put the preface on the tree: the synopsis and keywords on the first chapter, each note where it sat. */
function applyPreface(tree: readonly PreviewNode[], read: Ao3Import): readonly PreviewNode[] {
  if (tree.length === 0) return tree;
  const titles = new Map(read.chapters.map((chapter) => [chapter.unit, chapter.title]));
  const matter = new Map(read.matter.map((entry) => [entry.unit, entry]));
  const notesAt = new Map<number, string[]>();
  const synopsisAt = new Map<number, string>();
  const add = (index: number, text: string): void => {
    if (index < 0 || text === '') return;
    notesAt.set(index, [...(notesAt.get(index) ?? []), text]);
  };

  const first = ownerOf(tree, 0, 'first');
  const last = ownerOf(tree, 0, 'last');
  for (const note of read.notes) {
    if (note.kind === 'work-notes') add(first, note.text);
    else if (note.kind === 'end-notes') add(last, note.text);
    else if (note.kind === 'work-summary') synopsisAt.set(first, note.text);
    else {
      const owner = ownerOf(tree, note.blockIndex, 'at');
      if (note.kind === 'chapter-summary') synopsisAt.set(owner, note.text);
      else add(owner, note.text);
    }
  }
  if (read.summary !== '' && !synopsisAt.has(first)) synopsisAt.set(first, read.summary);
  if (read.seriesNote !== '') add(first, read.seriesNote);

  const unitAt = (node: PreviewNode): string | undefined => {
    const block = read.document.blocks[node.startBlock];
    return block !== undefined && 'src' in block ? block.src?.sourceUnit : undefined;
  };

  return tree.map((node, index) => {
    const unit = unitAt(node);
    const title = unit === undefined ? undefined : titles.get(unit);
    const isMatter = unit !== undefined && matter.has(unit);
    const notes = notesAt.get(index) ?? [];
    const synopsis = synopsisAt.get(index);
    const keywords = index === first ? read.keywords.slice(0, KEYWORD_LIMIT) : [];
    return {
      ...node,
      ...(title === undefined || title === '' || node.role === 'scene' ? {} : { title }),
      ...(isMatter ? { place: 'research' as const } : {}),
      ...(synopsis === undefined ? {} : { synopsis }),
      ...(keywords.length === 0 ? {} : { keywords: [...(node.keywords ?? []), ...keywords] }),
      ...(notes.length === 0 ? {} : { notes: [node.notes ?? '', ...notes].filter((text) => text !== '').join('\n\n') }),
    };
  });
}

/** An AO3 work download in the preview, read in the Worker. */
export function ao3PreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  const openReq: ReaderOpen = { kind: 'open', reader: 'ao3', bytes, fileName };
  let current: Ao3Import | null = null;
  let loaded = false;

  const readAs = async (signal: AbortSignal): Promise<Ao3Import> => {
    if (current !== null) return current;
    const reply = await host.read({ kind: 'read', reader: 'ao3' }, signal);
    if (reply.kind !== 'ao3') throw new Error(t`It is not an AO3 import.`);
    if (!reply.result.ok) throw new Error(ao3ErrorText(reply.result.error));
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
    return [{ id: AO3_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }];
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
    readKey: () => 'ao3',
    readerOptions,
    picturesOption: AO3_OPTIONS.pictures,
    pictures,
    // The preface is the work's own text too: the scan reads it with the bodies.
    scanExtra: () => {
      const read = current;
      if (read === null) return [];
      const parts = [
        { label: t`Summary`, text: read.summary },
        { label: t`Tags`, text: read.keywords.join(', ') },
        { label: t`Series and stats`, text: read.seriesNote },
        ...read.notes.map((note) => ({ label: t`Notes`, text: note.text })),
        ...read.meta.characters.map((name) => ({ label: t`Character`, text: name })),
      ];
      return parts.filter((part) => part.text !== '');
    },
    report: () => {
      const read = current;
      if (read === null) return [];
      const lists = [];
      const kept: string[] = [];
      const tags = read.keywords.length;
      const characters = read.meta.characters.length;
      const notes = read.notes.length;
      if (tags > 0) kept.push(plural(tags, { one: '# tag became a keyword', other: '# tags became keywords' }));
      if (characters > 0) kept.push(plural(characters, { one: '# character is offered as a codex entry', other: '# characters are offered as codex entries' }));
      if (notes > 0) kept.push(plural(notes, { one: '# note from the work is kept', other: '# notes from the work are kept' }));
      if (read.summary !== '') kept.push(t`The summary became the synopsis.`);
      if (kept.length > 0) lists.push({ heading: t`AO3`, label: t`What the work carried`, lines: kept });

      if (tags > KEYWORD_LIMIT) {
        const limit = KEYWORD_LIMIT;
        const overflow = tags - KEYWORD_LIMIT;
        const rest = read.keywords.slice(KEYWORD_LIMIT).join(', ');
        lists.push({
          heading: t`Keywords`,
          label: t`What a scene cannot hold`,
          lines: [
            plural(overflow, { one: '# tag is past the limit of the keywords field', other: '# tags are past the limit of the keywords field' }),
            t`The first ${limit} are kept; the rest are listed here: ${rest}`,
          ],
        });
      }

      const dropped: string[] = [];
      const scripts = read.dropped.scripts;
      const styles = read.dropped.styles;
      const media = read.dropped.media;
      const unsafeLinks = read.dropped.unsafeLinks;
      if (scripts > 0) dropped.push(plural(scripts, { one: '# script was removed', other: '# scripts were removed' }));
      if (styles > 0) dropped.push(plural(styles, { one: '# stylesheet was removed', other: '# stylesheets were removed' }));
      if (media > 0) dropped.push(plural(media, { one: '# audio or video player was removed', other: '# audio or video players were removed' }));
      if (unsafeLinks > 0) dropped.push(plural(unsafeLinks, { one: '# unsafe link kept its text only', other: '# unsafe links kept their text only' }));
      if (dropped.length > 0) lists.push({ heading: t`AO3 safety`, label: t`What the import removed`, lines: dropped });

      const remote = read.remoteImages.length;
      if (remote > 0) lists.push({ heading: t`Remote pictures`, label: t`What was not downloaded`, lines: [plural(remote, { one: '# picture on the internet was not downloaded', other: '# pictures on the internet were not downloaded' })] });
      return lists;
    },
  });

  return {
    ...base,
    codexRows: (): PreviewCodexRow[] => {
      const read = current;
      if (read === null) return [];
      return read.meta.characters.map((name, index) => ({
        id: `ao3-character-${index}`,
        name,
        type: 'character',
        cite: { quote: name },
        page: { title: name, body: `# ${name}\n\n${read.meta.fandoms.join(', ')}`.trim() },
      }));
    },
    metadata: () => {
      const read = current;
      if (read === null) return {};
      return { title: read.meta.title, author: read.meta.author, ...(read.meta.language === '' ? {} : { language: read.meta.language }) };
    },
    plan: (settings, overrides) => {
      const plan = base.plan(settings, overrides);
      const read = current;
      if (read === null) return plan;
      return { ...plan, tree: applyPreface(plan.tree, read) };
    },
  };
}
