/**
 * **Import HTML…** through the shared preview (import-html.md, issue #299): the HTML reader (`@caotang/import-html`)
 * turns a saved page or a Google Docs web-page zip into blocks with its own XHTML walker, and the splitter source shows
 * them. Scripts, styles and event handlers are dropped and counted; remote images are listed, not fetched. Nothing is
 * written until Import, which commits one `binder.importTree`.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts). Loaded on first use by the Import HTML action
 * (ManuscriptImport.tsx), with the reader host and the splitter, so the first load carries neither.
 */
/* lingui-set comment="The HTML import. Interpolated values: file (the file's name), count (pictures), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { HtmlImport, HtmlError } from '@caotang/import-html';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewOption, PreviewPicture } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const HTML_OPTIONS = { pictures: 'pictures' } as const;

/** Why the reader stopped, in words. */
export function htmlErrorText(error: HtmlError): string {
  switch (error.kind) {
    case 'ask-encoding':
      return t`Its text encoding could not be recognised. Save it as UTF-8 and import it again.`;
    case 'too-large':
      return t`It is larger than an HTML import reads.`;
    case 'too-many-lines':
      return t`It has more lines than an HTML import reads.`;
    case 'no-html':
      return t`It holds no HTML page.`;
    case 'not-xml':
      return t`Its markup is not well-formed, so the import cannot read it.`;
    case 'archive':
      return error.message;
  }
}

/**
 * Why a file of this size is not read at all, before its bytes are loaded; undefined when the reader takes it. `maxBytes` is the
 * cap for what was picked: the text reader's for a page, the archive's for a web-page zip.
 */
export function htmlSizeRefusal(fileName: string, size: number, maxBytes: number): string | undefined {
  if (size <= maxBytes) return undefined;
  return t`${{ file: fileName }} is too large to import as HTML: the import reads files up to ${{ limit: formatCount(Math.round(maxBytes / (1024 * 1024))) }} MB.`;
}

/** A saved HTML page or a web-page zip in the preview, read in the Worker. */
function makeHtmlSource(fileName: string, openReq: ReaderOpen): ImportPreviewSource {
  const host = new ReaderHost();
  let current: HtmlImport | null = null;
  let loaded = false;

  const readAs = async (signal: AbortSignal): Promise<HtmlImport> => {
    if (current !== null) return current;
    const reply = await host.read({ kind: 'read', reader: 'html' }, signal);
    if (reply.kind !== 'html') throw new Error(t`It is not an HTML import.`);
    if (!reply.result.ok) throw new Error(htmlErrorText(reply.result.error));
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
    return [{ id: HTML_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }];
  };

  return splitterPreviewSource({
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
    readKey: () => 'html',
    readerOptions,
    picturesOption: HTML_OPTIONS.pictures,
    pictures,
    report: () => {
      const read = current;
      if (read === null) return [];
      const lists = [];
      const dropped: string[] = [];
      const scripts = read.dropped.scripts;
      const styles = read.dropped.styles;
      const iframes = read.dropped.iframes;
      const forms = read.dropped.forms;
      const eventAttrs = read.dropped.eventAttrs;
      const unsafeLinks = read.dropped.unsafeLinks;
      if (scripts > 0) dropped.push(plural(scripts, { one: '# script was removed', other: '# scripts were removed' }));
      if (styles > 0) dropped.push(plural(styles, { one: '# stylesheet was not kept; only alignment, bold and page breaks come through', other: '# stylesheets were not kept; only alignment, bold and page breaks come through' }));
      if (iframes > 0) dropped.push(plural(iframes, { one: '# iframe was removed', other: '# iframes were removed' }));
      if (forms > 0) dropped.push(plural(forms, { one: '# form control was removed', other: '# form controls were removed' }));
      if (eventAttrs > 0) dropped.push(plural(eventAttrs, { one: '# event handler was removed', other: '# event handlers were removed' }));
      if (unsafeLinks > 0) dropped.push(plural(unsafeLinks, { one: '# unsafe link kept its text only', other: '# unsafe links kept their text only' }));
      if (dropped.length > 0) lists.push({ heading: t`HTML safety`, label: t`What the import removed`, lines: dropped });
      const remote = read.remoteImages.length;
      if (remote > 0) lists.push({ heading: t`Remote pictures`, label: t`What was not downloaded`, lines: [plural(remote, { one: '# picture on the internet was not downloaded', other: '# pictures on the internet were not downloaded' })] });
      return lists;
    },
  });
}

/** A single saved `.html` page. */
export function htmlPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  return makeHtmlSource(fileName, { kind: 'open', reader: 'html', bytes, fileName });
}

/** A Google Docs "Web page" zip (one `.html` plus its images). */
export function htmlZipPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  return makeHtmlSource(fileName, { kind: 'open', reader: 'html-zip', bytes });
}
