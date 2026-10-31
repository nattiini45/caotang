/**
 * An `.rtfd` package (TextEdit's "Rich Text with Graphics", Scrivener 2's `content.rtfd`): a folder holding `TXT.rtf` and the files
 * its `\NeXTGraphic` groups name. It arrives through the shared archive reader (`@caotang/import-read`), as a zip or as a picked
 * folder, so the caps and the path checks are the archive reader's. Attachments the text never names are reported, not dropped
 * silently.
 */

import type { ArchiveResult, ImportArchive, ImportArchiveError } from '@caotang/import-read/zip';

import type { LossWarning } from './model.js';
import { readRtf, type RtfReadOptions, type RtfReadResult } from './rtf.js';

export type RtfdReadResult = RtfReadResult | { readonly ok: false; readonly error: ImportArchiveError };

/** The path of the package's text: the shallowest `TXT.rtf` in the archive, or undefined when it holds none. */
export function rtfdTextPath(archive: Pick<ImportArchive, 'entries'>): string | undefined {
  let best: string | undefined;
  for (const { path } of archive.entries) {
    if (!/(^|\/)TXT\.rtf$/i.test(path)) continue;
    if (best === undefined || path.split('/').length < best.split('/').length) best = path;
  }
  return best;
}

/** Reads an `.rtfd` package: its `TXT.rtf` with the pictures it attaches. */
export async function readRtfd(archive: ImportArchive, options: Omit<RtfReadOptions, 'attachment'> = {}): Promise<RtfdReadResult> {
  const textPath = rtfdTextPath(archive);
  if (textPath === undefined) {
    return readRtf(new Uint8Array(0), options);
  }
  const dir = textPath.slice(0, textPath.length - 'TXT.rtf'.length);
  const siblings = archive.entries.map((e) => e.path).filter((p) => p !== textPath && p.startsWith(dir));
  const read: ArchiveResult<ReadonlyMap<string, Uint8Array>> = await archive.readMany([textPath, ...siblings]);
  if (!read.ok) return read;
  const text = read.value.get(textPath) as Uint8Array;
  const used = new Set<string>();
  const result = readRtf(text, {
    ...options,
    attachment: (name) => {
      const path = dir + name;
      const bytes = read.value.get(path);
      if (bytes !== undefined) used.add(path);
      return bytes;
    },
  });
  if (!result.ok) return result;
  const unused = siblings.filter((p) => !used.has(p));
  if (unused.length === 0) return result;
  const loss: LossWarning = {
    code: 'embedded-object',
    message: `Files in the package that the text does not show are not imported: ${unused.map((p) => p.slice(dir.length)).join(', ')}.`,
    count: unused.length,
  };
  const doc = { ...result.value.document, losses: [...(result.value.document.losses ?? []), loss] };
  return { ok: true, value: { ...result.value, document: doc } };
}
