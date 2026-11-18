/**
 * The reader dispatch the import preview's Worker runs (issues #283 / #274 / #390), as a DOM-free session factory. The Worker entry
 * (reader.worker.ts) creates one session and feeds it messages; the unit tests create one per fake Worker so the sources are exercised
 * on real reader output in Node, without a browser. Each session owns its cached input, so sessions never share state.
 *
 * The readers are imported on first use: the plain-text reader (`@caotang/import-read/text`), the RTF and `.rtfd` readers
 * (`@caotang/import-rtf`), and the archive reader (`@caotang/import-read/zip`) for a zipped `.rtfd`. None needs a DOM. fflate is reached
 * only through the archive reader's `unzipSync`, never its async blob workers.
 */

import type { ImportArchive } from '@caotang/import-read/zip';
import type { RtfReadResult, RtfdReadResult } from '@caotang/import-rtf';

import type { ReaderOpen, ReaderRead, ReaderResult, SerializableRtfResult } from './reader-protocol.js';

type State =
  | { readonly reader: 'text' | 'rtf'; readonly bytes: Uint8Array }
  | { readonly reader: 'rtfd'; readonly archive: ImportArchive };

/** Flattens an RTF or archive refusal to a code and a message, so it survives the structured clone (an Error's own `code` does not). */
function serialiseRtf(result: RtfReadResult | RtfdReadResult): SerializableRtfResult {
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: { code: result.error.code, message: result.error.message } };
}

/** One reader session: `open` caches the input, `read` re-reads it with the given options. */
export function createReaderSession(): (req: ReaderOpen | ReaderRead) => Promise<ReaderResult> {
  let state: State | null = null;

  const open = async (req: ReaderOpen): Promise<void> => {
    if (req.reader === 'text' || req.reader === 'rtf') {
      state = { reader: req.reader, bytes: req.bytes };
      return;
    }
    const { openFolder, openZip } = await import('@caotang/import-read/zip');
    const archive =
      req.reader === 'rtfd-zip'
        ? await openZip(req.bytes)
        : openFolder(req.files.map((file) => ({ path: file.path, size: file.size, read: async () => file.bytes })));
    if (!archive.ok) throw new Error(archive.error.message);
    state = { reader: 'rtfd', archive: archive.value };
  };

  const read = async (req: ReaderRead): Promise<ReaderResult> => {
    if (state === null) throw new Error('The import reader was not opened.');
    if (req.reader === 'text') {
      if (state.reader !== 'text') throw new Error('The import reader is not a text reader.');
      const { decodePlainText, plainTextBlocks } = await import('@caotang/import-read/text');
      const decoded = decodePlainText(state.bytes, req.encoding === undefined ? {} : { encoding: req.encoding });
      if (decoded.status !== 'decoded') return { kind: 'text', result: decoded };
      const blocks = plainTextBlocks(decoded.text, {
        ...(req.paragraphs === undefined ? {} : { paragraphs: req.paragraphs }),
        ...(req.fileName === undefined ? {} : { fileName: req.fileName }),
      });
      return {
        kind: 'text',
        result: { status: 'read', ...blocks, encoding: decoded.encoding, guessed: decoded.guessed, candidates: decoded.candidates },
      };
    }
    const { readRtf, readRtfd } = await import('@caotang/import-rtf');
    const options = {
      ...(req.underlineAs === undefined ? {} : { underlineAs: req.underlineAs }),
      ...(req.assetPrefix === undefined ? {} : { assetPrefix: req.assetPrefix }),
    };
    if (req.reader === 'rtf') {
      if (state.reader !== 'rtf') throw new Error('The import reader is not an RTF reader.');
      return { kind: 'rtf', result: serialiseRtf(readRtf(state.bytes, options)) };
    }
    if (state.reader !== 'rtfd') throw new Error('The import reader is not an RTFD reader.');
    return { kind: 'rtf', result: serialiseRtf(await readRtfd(state.archive, options)) };
  };

  return async (req) => {
    if (req.kind === 'open') {
      await open(req);
      return { kind: 'opened' };
    }
    return read(req);
  };
}
