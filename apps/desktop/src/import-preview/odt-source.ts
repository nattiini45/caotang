/**
 * **Import OpenDocument…** through the shared preview (import-odt.md, issue #298): the ODF reader (`@caotang/import-odt`) turns an
 * `.odt` package or a flat `.fodt` into blocks, pictures and the text the scan must still read, and the splitter source shows them.
 * Tracked changes are a chip (accept, reject, keep), as for Word; underline as italics, annotations and the pictures are options.
 * Nothing is written until Import, which commits one `binder.importTree`, the pictures included.
 */
/* lingui-set comment="The OpenDocument import. Interpolated values: file (the file's name), count (pictures, changes, notes), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { OdtError, OdtImport, OdtOptions, OdtTrackedMode } from '@caotang/import-odt';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewChip, PreviewOption, PreviewPicture, PreviewReportList, PreviewSettings, ScanExtra } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const ODT_CHIPS = { tracked: 'odt-tracked' } as const;
export const ODT_OPTIONS = { underline: 'underline-italic', comments: 'comments', pictures: 'pictures' } as const;

/** Why a file of this size is not read at all, before its bytes are loaded; undefined when the reader takes it. */
export function odtSizeRefusal(fileName: string, size: number, maxBytes: number): string | undefined {
  if (size <= maxBytes) return undefined;
  return t`${{ file: fileName }} is too large to import as an OpenDocument file (${{ limit: formatCount(Math.round(maxBytes / (1024 * 1024))) }} MB max).`;
}

/** Why the reader stopped, in words. */
export function odtErrorText(error: OdtError): string {
  switch (error.kind) {
    case 'not-odt':
      return t`This is not an OpenDocument text file. In LibreOffice, choose Save As and the .odt format.`;
    case 'empty':
      return t`This OpenDocument file has no text.`;
    case 'not-xml':
    case 'archive':
      return error.message;
  }
}

function trackedOf(settings: PreviewSettings): OdtTrackedMode {
  const value = settings.chips[ODT_CHIPS.tracked];
  return value === 'reject' || value === 'keep' ? value : 'accept';
}

function optionsOf(settings: PreviewSettings): OdtOptions {
  return {
    tracked: trackedOf(settings),
    underlineAs: settings.options[ODT_OPTIONS.underline] === false ? 'none' : 'italic',
    comments: settings.options[ODT_OPTIONS.comments] !== false,
  };
}

const keyOf = (settings: PreviewSettings): string => `${trackedOf(settings)}|${settings.options[ODT_OPTIONS.underline] === false ? 'none' : 'italic'}|${settings.options[ODT_OPTIONS.comments] === false ? 'off' : 'on'}`;

/** An OpenDocument text file in the preview, read in the Worker. */
export function odtPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  const openReq: ReaderOpen = { kind: 'open', reader: 'odt', bytes };
  const reads = new Map<string, OdtImport>();
  let current: OdtImport | null = null;
  let lastSettings: PreviewSettings | null = null;

  const readAs = async (settings: PreviewSettings, signal: AbortSignal): Promise<OdtImport> => {
    const key = keyOf(settings);
    const held = reads.get(key);
    lastSettings = settings;
    if (held !== undefined) {
      current = held;
      return held;
    }
    const reply = await host.read({ kind: 'read', reader: 'odt', options: optionsOf(settings) }, signal);
    if (reply.kind !== 'odt') throw new Error(t`It is not an OpenDocument import.`);
    if (!reply.result.ok) throw new Error(odtErrorText(reply.result.error));
    reads.set(key, reply.result.value);
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

  const readerChips = (): PreviewChip[] => {
    const read = current;
    const changes = (read?.changes.insertions ?? 0) + (read?.changes.deletions ?? 0);
    if (changes === 0) return [];
    return [{
      id: ODT_CHIPS.tracked,
      label: t`Tracked changes`,
      value: 'accept',
      options: [
        { value: 'accept', label: t`Accept them` },
        { value: 'reject', label: t`Reject them` },
        { value: 'keep', label: t`Accept, and list what was deleted` },
      ],
    }];
  };

  const readerOptions = (): PreviewOption[] => {
    const read = current;
    const shown = pictures();
    const count = shown.length;
    const comments = read?.document.comments?.length ?? 0;
    const megabytes = shown.reduce((sum, picture) => sum + picture.bytes, 0) / 1_000_000;
    const size = formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10));
    return [
      { id: ODT_OPTIONS.underline, label: t`Underline becomes italics`, checked: true, detail: t`Off, underlined text is kept without its underline.` },
      ...(comments === 0 ? [] : [{ id: ODT_OPTIONS.comments, label: plural(comments, { one: 'Annotations become scene notes (#)', other: 'Annotations become scene notes (#)' }), checked: true }]),
      ...(count === 0 ? [] : [{ id: ODT_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${size} MB.` }]),
    ];
  };

  const report = (): PreviewReportList[] => {
    const read = current;
    if (read === null) return [];
    const lists: PreviewReportList[] = [];
    const carried: string[] = [];
    const insertions = read.changes.insertions;
    const deletions = read.changes.deletions;
    const notes = read.document.footnotes?.length ?? 0;
    const comments = read.document.comments?.length ?? 0;
    if (insertions > 0) carried.push(plural(insertions, { one: '# insertion was read', other: '# insertions were read' }));
    if (deletions > 0) carried.push(plural(deletions, { one: '# deletion was read', other: '# deletions were read' }));
    if (notes > 0) carried.push(plural(notes, { one: '# note became a footnote of its scene', other: '# notes became footnotes of their scenes' }));
    if (comments > 0) carried.push(plural(comments, { one: '# annotation became a scene note', other: '# annotations became scene notes' }));
    if (carried.length > 0) lists.push({ heading: t`OpenDocument`, label: t`What the file carried`, lines: carried });

    const removed: string[] = [];
    const underline = read.dropped.underline;
    const unsafeLinks = read.dropped.unsafeLinks;
    const textBoxes = read.dropped.textBoxes;
    const svg = read.dropped.svg;
    const other = read.dropped.otherPictures;
    if (underline > 0) {
      removed.push(lastSettings?.options[ODT_OPTIONS.underline] === false
        ? plural(underline, { one: '# underlined run was kept without its underline', other: '# underlined runs were kept without their underline' })
        : plural(underline, { one: '# underlined run was read as italics', other: '# underlined runs were read as italics' }));
    }
    const fonts = read.dropped.fonts;
    const coloursIndents = read.dropped.colours + read.dropped.indents;
    if (fonts > 0) removed.push(plural(fonts, { one: '# font choice was not kept', other: '# font choices were not kept' }));
    if (coloursIndents > 0) removed.push(plural(coloursIndents, { one: '# colour, highlight or indent was not kept', other: '# colours, highlights or indents were not kept' }));
    if (unsafeLinks > 0) removed.push(plural(unsafeLinks, { one: '# unsafe link kept its text only', other: '# unsafe links kept their text only' }));
    if (textBoxes > 0) removed.push(plural(textBoxes, { one: '# text box was read as a paragraph', other: '# text boxes were read as paragraphs' }));
    if (svg > 0) removed.push(plural(svg, { one: '# SVG picture was refused, because it can carry script', other: '# SVG pictures were refused, because they can carry script' }));
    if (other > 0) removed.push(plural(other, { one: '# picture in a format Caotang does not keep was left out', other: '# pictures in formats Caotang does not keep were left out' }));
    if (removed.length > 0) lists.push({ heading: t`OpenDocument`, label: t`What the import removed`, lines: removed });

    if (read.remoteImages.length > 0) {
      const remote = read.remoteImages.length;
      lists.push({ heading: t`Remote pictures`, label: t`What was not downloaded`, lines: [plural(remote, { one: '# picture on the internet was not downloaded', other: '# pictures on the internet were not downloaded' })] });
    }
    return lists;
  };

  const scanExtra = (): ScanExtra[] => {
    const read = current;
    if (read === null) return [];
    const parts: ScanExtra[] = [];
    const deleted = t`Deleted text the import keeps in the notes`;
    for (const deletion of read.deletions) parts.push({ label: deleted, text: deletion.text });
    const links = t`Link targets`;
    for (const target of read.remoteImages) parts.push({ label: links, text: target });
    return parts;
  };

  const first: PreviewSettings = { chips: {}, options: {} };

  return splitterPreviewSource({
    fileName,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open(openReq, signal);
      await readAs(first, signal);
    },
    prepare: async (settings, signal) => {
      await readAs(settings, signal);
    },
    prepared: (settings) => reads.has(keyOf(settings)),
    dispose: () => host.dispose(),
    readerChips,
    readerOptions,
    read: (settings) => ({ doc: (reads.get(keyOf(settings)) ?? current)?.document ?? { blocks: [] } }),
    readKey: keyOf,
    picturesOption: ODT_OPTIONS.pictures,
    pictures,
    scanExtra,
    report,
  });
}
