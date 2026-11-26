/**
 * **Import Word…** through the shared preview (import-docx.md, issue #279): the Word reader (`@caotang/import-docx`) turns a
 * `.docx` — or a zip of them — into blocks, pictures and the text the scan must still read, and the splitter source shows them.
 * Tracked changes are a chip (accept, reject, keep); underline as italics, comments and the pictures are options. Nothing is
 * written until Import, which commits one `binder.importTree`, the pictures included.
 *
 * The reader runs in the preview's `'self'` Worker host, under the shared archive caps and the host's timeout and Cancel. The
 * bytes are handed over once; changing a chip or an option re-reads the Worker's cached copy.
 */
/* lingui-set comment="The Word import. Interpolated values: file (the file's name), count (pictures, changes, notes), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import type { DocxError, DocxImport, DocxOptions, TrackedMode } from '@caotang/import-docx';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewChip, PreviewOption, PreviewPicture, PreviewReportList, PreviewSettings, ScanExtra } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const DOCX_CHIPS = { tracked: 'docx-tracked' } as const;
export const DOCX_OPTIONS = { underline: 'underline-italic', comments: 'comments', pictures: 'pictures' } as const;

export function docxSizeRefusal(fileName: string, size: number, maxBytes: number): string | undefined {
  if (size <= maxBytes) return undefined;
  return t`${{ file: fileName }} is too large to import as a Word file (${{ limit: formatCount(Math.round(maxBytes / (1024 * 1024))) }} MB max).`;
}

/** Why the reader stopped, in words. */
export function docxErrorText(error: DocxError): string {
  switch (error.kind) {
    case 'not-docx':
      return t`This is not a Word .docx file. In Word, choose Save As and the .docx format; a .doc file cannot be read.`;
    case 'empty':
      return t`This Word file has no text.`;
    case 'not-xml':
    case 'archive':
      return error.message;
  }
}

function trackedOf(settings: PreviewSettings): TrackedMode {
  const value = settings.chips[DOCX_CHIPS.tracked];
  return value === 'reject' || value === 'keep' ? value : 'accept';
}

function optionsOf(settings: PreviewSettings): DocxOptions {
  return {
    tracked: trackedOf(settings),
    underlineAs: settings.options[DOCX_OPTIONS.underline] === false ? 'none' : 'italic',
    comments: settings.options[DOCX_OPTIONS.comments] !== false,
  };
}

const keyOf = (settings: PreviewSettings): string => `${trackedOf(settings)}|${settings.options[DOCX_OPTIONS.underline] === false ? 'none' : 'italic'}|${settings.options[DOCX_OPTIONS.comments] === false ? 'off' : 'on'}`;

/** A Word file, or a zip of Word files, in the preview. */
export function docxPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const host = new ReaderHost();
  const openReq: ReaderOpen = { kind: 'open', reader: 'docx', bytes };
  const reads = new Map<string, DocxImport>();
  let current: DocxImport | null = null;

  const readAs = async (settings: PreviewSettings, signal: AbortSignal): Promise<DocxImport> => {
    const key = keyOf(settings);
    const held = reads.get(key);
    if (held !== undefined) {
      current = held;
      return held;
    }
    const reply = await host.read({ kind: 'read', reader: 'docx', options: optionsOf(settings) }, signal);
    if (reply.kind !== 'docx') throw new Error(t`It is not a Word import.`);
    if (!reply.result.ok) throw new Error(docxErrorText(reply.result.error));
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
      id: DOCX_CHIPS.tracked,
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
      { id: DOCX_OPTIONS.underline, label: t`Underline becomes italics`, checked: true, detail: t`Off, underlined text is kept without its underline.` },
      ...(comments === 0 ? [] : [{ id: DOCX_OPTIONS.comments, label: plural(comments, { one: 'Comments become scene notes (#)', other: 'Comments become scene notes (#)' }), checked: true }]),
      ...(count === 0 ? [] : [{ id: DOCX_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${size} MB.` }]),
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
    if (read.changes.paragraphMarks > 0) {
      const marks = read.changes.paragraphMarks;
      carried.push(plural(marks, { one: '# changed paragraph mark was counted; the paragraphs were not merged', other: '# changed paragraph marks were counted; the paragraphs were not merged' }));
    }
    if (notes > 0) carried.push(plural(notes, { one: '# note became a footnote of its scene', other: '# notes became footnotes of their scenes' }));
    if (comments > 0) carried.push(plural(comments, { one: '# comment became a scene note', other: '# comments became scene notes' }));
    if (carried.length > 0) lists.push({ heading: t`Word`, label: t`What the file carried`, lines: carried });

    const removed: string[] = [];
    const dropped = read.dropped;
    const smallCaps = dropped.smallCaps;
    const fonts = dropped.fonts;
    const colours = dropped.colours + dropped.highlighting;
    const indents = dropped.indents;
    const underline = dropped.underline;
    const unsafeLinks = dropped.unsafeLinks;
    const textBoxes = dropped.textBoxes;
    const emf = dropped.emf;
    const svg = dropped.svg;
    const toc = dropped.toc;
    if (underline > 0) removed.push(plural(underline, { one: '# underlined run was read as italics', other: '# underlined runs were read as italics' }));
    if (smallCaps > 0) removed.push(plural(smallCaps, { one: '# small-caps run lost its capitals', other: '# small-caps runs lost their capitals' }));
    if (fonts > 0) removed.push(plural(fonts, { one: '# font choice was not kept', other: '# font choices were not kept' }));
    if (colours > 0) removed.push(plural(colours, { one: '# colour or highlight was not kept', other: '# colours or highlights were not kept' }));
    if (indents > 0) removed.push(plural(indents, { one: '# indent was not kept', other: '# indents were not kept' }));
    if (unsafeLinks > 0) removed.push(plural(unsafeLinks, { one: '# unsafe link kept its text only', other: '# unsafe links kept their text only' }));
    if (textBoxes > 0) removed.push(plural(textBoxes, { one: '# text box was read as a paragraph', other: '# text boxes were read as paragraphs' }));
    if (emf > 0) removed.push(plural(emf, { one: '# Windows metafile picture (EMF or WMF) was left out', other: '# Windows metafile pictures (EMF or WMF) were left out' }));
    if (svg > 0) removed.push(plural(svg, { one: '# SVG picture was refused, because it can carry script', other: '# SVG pictures were refused, because they can carry script' }));
    if (toc > 0) removed.push(plural(toc, { one: '# line of the generated contents was kept out of the chapters', other: '# lines of the generated contents were kept out of the chapters' }));
    if (removed.length > 0) lists.push({ heading: t`Word`, label: t`What the import removed`, lines: removed });

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
    picturesOption: DOCX_OPTIONS.pictures,
    pictures,
    scanExtra,
    report,
  });
}
