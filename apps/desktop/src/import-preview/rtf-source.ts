/**
 * **Import RTF…** through the shared preview (import-rtf.md, issue #274): the RTF reader (`@caotang/import-rtf`) turns the file into
 * blocks, pictures and the text the scan must still read, and the splitter source shows them. Underline as italics and the pictures
 * are the reader's options. Nothing is written until Import, which commits one `binder.importTree`, the pictures included.
 *
 * The reader runs once when the preview opens, under its own size, depth and time limits and the dialog's Cancel; turning underline
 * off reads the file once more. Loaded on first use by the Import RTF action (ManuscriptImport.tsx), with the reader and the
 * splitter, so the first load carries neither.
 */
/* lingui-set comment="The RTF import. Interpolated values: file (the file's name), count (pictures), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import { readRtf, type RtfErrorCode, type RtfImport } from '@caotang/import-rtf';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewOption, PreviewPicture, PreviewSettings, ScanExtra } from './model.js';
import { splitterPreviewSource } from './splitter-source.js';

export const RTF_OPTIONS = { underline: 'underline-italic', pictures: 'pictures' } as const;

/** The refs the reader gives its pictures: `import:` tokens, as `binder.importTree` takes them (import-preview.md §5). */
export const RTF_ASSET_PREFIX = `import:rtf-image-`;

/** Why the reader stopped, in words. */
export function rtfErrorText(code: RtfErrorCode): string {
  switch (code) {
    case 'not-rtf':
      return t`It is not an RTF file.`;
    case 'too-large':
      return t`It is larger than an RTF import reads.`;
    case 'too-deep':
      return t`Its groups are nested deeper than an RTF import reads.`;
    case 'timeout':
      return t`Reading it took too long.`;
    case 'cancelled':
      return t`Reading it was cancelled.`;
  }
}

function underlineOf(settings: PreviewSettings): 'italic' | 'none' {
  return settings.options[RTF_OPTIONS.underline] === false ? 'none' : 'italic';
}

/** The RTF file in the preview. The file is read in `load`; the source's other parts read what it found. */
export function rtfPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  const reads = new Map<'italic' | 'none', RtfImport>();
  const readAs = (underlineAs: 'italic' | 'none', signal?: AbortSignal): RtfImport => {
    const held = reads.get(underlineAs);
    if (held !== undefined) return held;
    const result = readRtf(bytes, { underlineAs, assetPrefix: RTF_ASSET_PREFIX, ...(signal === undefined ? {} : { signal }) });
    if (!result.ok) throw new Error(rtfErrorText(result.error.code));
    reads.set(underlineAs, result.value);
    return result.value;
  };
  const first = (): RtfImport | undefined => reads.get('italic') ?? reads.get('none');

  const pictures = (): PreviewPicture[] => {
    const read = first();
    if (read === undefined) return [];
    const alts = new Map<string, string>();
    for (const block of read.document.blocks) if (block.kind === 'image' && block.alt.trim() !== '') alts.set(block.assetRef, block.alt);
    return (read.document.assets ?? []).flatMap((asset) => {
      const data = read.assetData.get(asset.ref);
      if (data === undefined) return [];
      const alt = alts.get(asset.ref);
      return [{ ref: asset.ref, name: asset.name ?? asset.ref.slice('import:'.length), bytes: data.length, ...(alt === undefined ? {} : { alt }), data: () => data }];
    });
  };

  const readerOptions = (): PreviewOption[] => {
    const shown = pictures();
    const count = shown.length;
    const megabytes = shown.reduce((sum, picture) => sum + picture.bytes, 0) / 1_000_000;
    return [
      { id: RTF_OPTIONS.underline, label: t`Underline becomes italics`, checked: true, detail: t`Off, underlined text is kept without its underline.` },
      ...(count === 0
        ? []
        : [{ id: RTF_OPTIONS.pictures, label: plural(count, { one: 'Import # picture', other: 'Import # pictures' }), checked: true, detail: t`About ${{ size: formatCount(Math.max(0.1, Math.round(megabytes * 10) / 10)) }} MB.` }]),
    ];
  };

  const scanExtra = (): ScanExtra[] => {
    const read = first();
    if (read === undefined) return [];
    const label = t`Text the import does not keep (hidden text, deleted revisions, field codes, link targets)`;
    return read.scanExtra.map((part) => ({ label, text: part.text }));
  };

  return splitterPreviewSource({
    fileName,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      // Let the progress line paint before the reader takes the thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal.aborted) return;
      readAs('italic', signal);
    },
    readerOptions,
    read: (settings) => ({ doc: readAs(underlineOf(settings)).document }),
    readKey: (settings) => underlineOf(settings),
    picturesOption: RTF_OPTIONS.pictures,
    pictures,
    scanExtra,
  });
}
