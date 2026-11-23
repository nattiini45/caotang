/**
 * **Import EPUB…** through the shared preview (import-epub.md, issue #296): the EPUB reader (`@caotang/import-epub`)
 * turns a book's spine, navigation and XHTML into blocks, and the splitter source shows them. The navigation's own
 * chapter titles name the proposed chapters, the matter the book marks is offered as Research, and the cover and the
 * pictures come in. Nothing is written until Import, which commits one `binder.importTree`.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts). Loaded on first use by the Import EPUB action
 * (ManuscriptImport.tsx), with the reader host and the splitter, so the first load carries neither.
 */
/* lingui-set comment="The EPUB import. Interpolated values: file (the file's name), count (pictures, chapters), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { EpubImport, EpubError } from '@caotang/import-epub';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewNode, PreviewOption, PreviewPicture } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const EPUB_OPTIONS = { pictures: 'pictures' } as const;

/** Why the reader stopped, in words. */
export function epubErrorText(error: EpubError): string {
  switch (error.kind) {
    case 'ask-encoding':
      return t`Its text encoding could not be recognised. Save it as UTF-8 and import it again.`;
    case 'too-large':
      return t`It is larger than an EPUB import reads.`;
    case 'no-opf':
      return t`It is not an EPUB: it has no package document.`;
    case 'not-xml':
      return t`Its markup is not well-formed, so the import cannot read it.`;
    case 'drm': {
      const file = error.message;
      return t`This book is protected by DRM (${file}), so Caotang cannot read it. Remove the protection with the tool you bought it from, then import it again.`;
    }
    case 'empty':
      return t`Its reading order holds no text.`;
    case 'archive':
      return error.message;
  }
}

/**
 * Why a file of this size is not read at all, before its bytes are loaded; undefined when the reader takes it. `maxBytes` is the
 * archive reader's cap for the book, as the HTML and captions actions check their own before reading.
 */
export function epubSizeRefusal(fileName: string, size: number, maxBytes: number): string | undefined {
  if (size <= maxBytes) return undefined;
  return t`${{ file: fileName }} is too large to import as an EPUB (${{ limit: formatCount(Math.round(maxBytes / (1024 * 1024))) }} MB max).`;
}

/** Name the proposed chapters with the book's own contents, and offer the matter it marks as Research. */
function applyNavigation(tree: readonly PreviewNode[], read: EpubImport): readonly PreviewNode[] {
  const titleOf = new Map(read.chapters.map((chapter) => [chapter.unit, chapter.title]));
  const matterOf = new Map(read.matter.map((matter) => [matter.unit, matter]));
  const unitAt = (node: PreviewNode): string | undefined => {
    const block = read.document.blocks[node.startBlock];
    return block !== undefined && 'src' in block ? block.src?.sourceUnit : undefined;
  };
  const walk = (nodes: readonly PreviewNode[]): readonly PreviewNode[] =>
    nodes.map((node) => {
      const unit = unitAt(node);
      const title = unit === undefined ? undefined : titleOf.get(unit);
      const matter = unit === undefined ? undefined : matterOf.get(unit);
      const children = node.children === undefined ? undefined : walk(node.children);
      return {
        ...node,
        ...(children === undefined ? {} : { children }),
        ...(title === undefined || title === '' || node.role === 'scene' ? {} : { title }),
        ...(matter === undefined ? {} : { place: 'research' as const }),
      };
    });
  return walk(tree);
}

/** An EPUB in the preview, read in the Worker. */
export function epubPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  const openReq: ReaderOpen = { kind: 'open', reader: 'epub', bytes };
  let current: EpubImport | null = null;
  let loaded = false;

  const readAs = async (signal: AbortSignal): Promise<EpubImport> => {
    if (current !== null) return current;
    const reply = await host.read({ kind: 'read', reader: 'epub' }, signal);
    if (reply.kind !== 'epub') throw new Error(t`It is not an EPUB import.`);
    if (!reply.result.ok) throw new Error(epubErrorText(reply.result.error));
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
    return [{ id: EPUB_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }];
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
    readKey: () => 'epub',
    readerOptions,
    picturesOption: EPUB_OPTIONS.pictures,
    pictures,
    // The contents' own titles are the book's text too, so they are scanned with the bodies.
    scanExtra: () => {
      const read = current;
      if (read === null) return [];
      return read.chapters
        .filter((chapter) => chapter.title !== '')
        .map((chapter) => {
          const title = chapter.title;
          return { label: t`Contents: ${title}`, text: title };
        });
    },
    report: () => {
      const read = current;
      if (read === null) return [];
      const lists = [];
      const kept: string[] = [];
      const named = read.chapters.filter((chapter) => chapter.title !== '').length;
      const matter = read.matter.length;
      if (named > 0) kept.push(plural(named, { one: '# chapter title came from the book’s contents', other: '# chapter titles came from the book’s contents' }));
      if (matter > 0) kept.push(plural(matter, { one: '# section the book marks as matter is offered as Research', other: '# sections the book marks as matter are offered as Research' }));
      if (read.cover !== null) kept.push(t`The cover came in as a picture; setting it as the project’s cover is not part of this import.`);
      if (kept.length > 0) lists.push({ heading: t`EPUB`, label: t`What the book named`, lines: kept });

      const dropped: string[] = [];
      const scripts = read.dropped.scripts;
      const styles = read.dropped.styles;
      const iframes = read.dropped.iframes;
      const media = read.dropped.media;
      const eventAttrs = read.dropped.eventAttrs;
      const unsafeLinks = read.dropped.unsafeLinks;
      if (scripts > 0) dropped.push(plural(scripts, { one: '# script was removed', other: '# scripts were removed' }));
      if (styles > 0) dropped.push(plural(styles, { one: '# stylesheet was removed', other: '# stylesheets were removed' }));
      if (iframes > 0) dropped.push(plural(iframes, { one: '# iframe was removed', other: '# iframes were removed' }));
      if (media > 0) dropped.push(plural(media, { one: '# audio or video player was removed', other: '# audio or video players were removed' }));
      if (eventAttrs > 0) dropped.push(plural(eventAttrs, { one: '# event handler was removed', other: '# event handlers were removed' }));
      if (unsafeLinks > 0) dropped.push(plural(unsafeLinks, { one: '# unsafe link kept its text only', other: '# unsafe links kept their text only' }));
      if (dropped.length > 0) lists.push({ heading: t`EPUB safety`, label: t`What the import removed`, lines: dropped });

      const remote = read.remoteImages.length;
      if (remote > 0) lists.push({ heading: t`Remote pictures`, label: t`What was not downloaded`, lines: [plural(remote, { one: '# picture on the internet was not downloaded', other: '# pictures on the internet were not downloaded' })] });
      return lists;
    },
  });

  return {
    ...base,
    plan: (settings, overrides) => {
      const plan = base.plan(settings, overrides);
      const read = current;
      if (read === null) return plan;
      return { ...plan, tree: applyNavigation(plan.tree, read) };
    },
  };
}
