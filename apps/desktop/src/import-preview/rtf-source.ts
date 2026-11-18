/**
 * **Import RTF…** and **Import RTFD…** through the shared preview (import-rtf.md, issues #274 and #390): the RTF reader
 * (`@caotang/import-rtf`) turns the file into blocks, pictures and the text the scan must still read, and the splitter source shows
 * them. Underline as italics and the pictures are the reader's options. Nothing is written until Import, which commits one
 * `binder.importTree`, the pictures included.
 *
 * The reader runs in the preview's `'self'` Worker host (reader-host.ts), under the reader's own size, depth and time limits and the
 * host's hard timeout and the dialog's Cancel. The bytes (or the `.rtfd` package's files) are handed to the Worker once; turning
 * underline off re-reads the Worker's cached copy. An `.rtfd` package arrives as a picked folder or a zip, through the shared archive
 * reader's caps (import-rtf.md §4).
 *
 * Loaded on first use by the Import RTF / RTFD actions (ManuscriptImport.tsx), with the reader host and the splitter, so the first
 * load carries neither.
 */
/* lingui-set comment="The RTF import. Interpolated values: file (the file's name), count (pictures), size (megabytes)" */

import { plural, t } from '@lingui/core/macro';
import { RTF_LIMITS, type RtfErrorCode, type RtfImport } from '@caotang/import-rtf';

import { formatCount } from '../i18n/locale.js';
import type { ImportPreviewSource, PreviewOption, PreviewPicture, PreviewSettings, ScanExtra } from './model.js';
import { ReaderHost } from './reader-host.js';
import type { ReaderOpen } from './reader-protocol.js';
import { splitterPreviewSource } from './splitter-source.js';

export const RTF_OPTIONS = { underline: 'underline-italic', pictures: 'pictures' } as const;

/** The refs the reader gives its pictures: `import:` tokens, as `binder.importTree` takes them (import-preview.md §5). */
export const RTF_ASSET_PREFIX = `import:rtf-image-`;

const RTF_CODES: readonly string[] = ['not-rtf', 'too-large', 'too-deep', 'timeout', 'cancelled'];

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

/** A reader or archive refusal in words: the RTF codes have their own wording, an archive refusal keeps the reader's message. */
function readErrorText(error: { readonly code: string; readonly message: string }): string {
  return RTF_CODES.includes(error.code) ? rtfErrorText(error.code as RtfErrorCode) : error.message;
}

/** Why a file of this size is not read at all, before its bytes are loaded; undefined when the reader takes it. */
export function rtfSizeRefusal(fileName: string, size: number): string | undefined {
  if (size <= RTF_LIMITS.maxInputBytes) return undefined;
  return t`${{ file: fileName }} is too large to import as RTF: the import reads files up to ${{ size: formatCount(RTF_LIMITS.maxInputBytes / (1024 * 1024)) }} MB.`;
}

function underlineOf(settings: PreviewSettings): 'italic' | 'none' {
  return settings.options[RTF_OPTIONS.underline] === false ? 'none' : 'italic';
}

/** The RTF file in the preview, read in the Worker. The same source serves a standalone `.rtf` and an `.rtfd` package. */
function makeRtfSource(fileName: string, openReq: ReaderOpen): ImportPreviewSource {
  const host = new ReaderHost();
  const reads = new Map<'italic' | 'none', RtfImport>();
  let current: RtfImport | null = null;
  const readReader = openReq.reader === 'rtf' ? 'rtf' : 'rtfd';

  const pictures = (): PreviewPicture[] => {
    const read = current;
    if (read === null) return [];
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
    const read = current;
    if (read === null) return [];
    const label = t`Text the import does not keep (hidden text, deleted revisions, field codes, link targets)`;
    return read.scanExtra.map((part) => ({ label, text: part.text }));
  };

  const readAs = async (underlineAs: 'italic' | 'none', signal: AbortSignal): Promise<RtfImport> => {
    const held = reads.get(underlineAs);
    if (held !== undefined) return held;
    const reply = await host.read({ kind: 'read', reader: readReader, underlineAs, assetPrefix: RTF_ASSET_PREFIX }, signal);
    if (reply.kind !== 'rtf') throw new Error(t`It is not an RTF file.`);
    if (!reply.result.ok) throw new Error(readErrorText(reply.result.error));
    reads.set(underlineAs, reply.result.value);
    current = reply.result.value;
    return reply.result.value;
  };

  return splitterPreviewSource({
    fileName,
    load: async (progress, signal) => {
      progress(t`Reading ${{ file: fileName }}…`);
      await host.open(openReq, signal);
      await readAs('italic', signal);
    },
    prepare: async (settings, signal) => {
      await readAs(underlineOf(settings), signal);
    },
    prepared: (settings) => reads.has(underlineOf(settings)),
    dispose: () => host.dispose(),
    readerOptions,
    read: (settings) => ({ doc: (reads.get(underlineOf(settings)) ?? current)?.document ?? { blocks: [] } }),
    readKey: (settings) => underlineOf(settings),
    picturesOption: RTF_OPTIONS.pictures,
    pictures,
    scanExtra,
  });
}

/** A standalone `.rtf` file. */
export function rtfPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  return makeRtfSource(fileName, { kind: 'open', reader: 'rtf', bytes });
}

/** An `.rtfd` package the writer picked as a folder: its files' paths, sizes and bytes (read on the main thread, parsed in the Worker). */
export function rtfdPreviewSource(fileName: string, files: readonly { readonly path: string; readonly size: number; readonly bytes: Uint8Array }[]): ImportPreviewSource {
  return makeRtfSource(fileName, { kind: 'open', reader: 'rtfd', files });
}

/** An `.rtfd` package that arrived as a zip. */
export function rtfdZipPreviewSource(fileName: string, bytes: Uint8Array): ImportPreviewSource {
  return makeRtfSource(fileName, { kind: 'open', reader: 'rtfd-zip', bytes });
}
