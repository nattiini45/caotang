/**
 * An `.rtfd` package (TextEdit's "Rich Text with Graphics", Scrivener 2's `content.rtfd`): a folder holding `TXT.rtf` and the files
 * its `\NeXTGraphic` groups name. It arrives through the shared archive reader (`@caotang/import-read`), as a zip or as a picked
 * folder, so the caps and the path checks are the archive reader's. Only the files the text names are read, and only when the
 * package declares them no larger than the picture cap; files the text never names are reported from the entry list, never read.
 */

import type { ImportArchive, ImportArchiveError } from '@caotang/import-read/zip';

import type { LossWarning } from './model.js';
import { readRtf, rtfLimitsOf, type RtfReadOptions, type RtfReadResult } from './rtf.js';

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
  const textRead = await archive.read(textPath);
  if (!textRead.ok) return textRead;
  const text = textRead.value;

  // First the names the text attaches, read the way the reader reads them (escapes, code pages); nothing else is opened.
  const named = new Set<string>();
  let result = readRtf(text, {
    ...options,
    attachment: (name) => {
      named.add(name);
      return undefined;
    },
  });
  if (!result.ok) return result;

  const used = new Set<string>();
  if (named.size > 0) {
    const cap = rtfLimitsOf(options.limits).maxImageBytes;
    const tooLarge = new Set<string>();
    const wanted: string[] = [];
    for (const name of named) {
      const entry = archive.entry(dir + name);
      if (entry === undefined || entry.path === textPath) continue;
      used.add(entry.path);
      if (entry.size > cap) tooLarge.add(entry.path);
      else wanted.push(entry.path);
    }
    const read = wanted.length > 0 ? await archive.readMany(wanted) : ({ ok: true, value: new Map<string, Uint8Array>() } as const);
    if (!read.ok) return read;
    result = readRtf(text, {
      ...options,
      attachment: (name) => {
        const path = dir + name;
        if (tooLarge.has(path)) return 'too-large';
        return read.value.get(path);
      },
    });
    if (!result.ok) return result;
  }

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
