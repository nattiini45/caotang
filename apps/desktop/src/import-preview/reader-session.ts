/**
 * The reader dispatch the import preview's Worker runs (issues #283 / #274 / #390), as a DOM-free session factory. The Worker entry
 * (reader.worker.ts) creates one session and feeds it messages; the unit tests create one per fake Worker so the sources are exercised
 * on real reader output in Node, without a browser. Each session owns its cached input, so sessions never share state.
 *
 * The readers are imported on first use: the plain-text reader (`@caotang/import-read/text`), the captions reader
 * (`@caotang/import-captions`, which takes the text the plain-text reader decoded), the RTF and `.rtfd` readers
 * (`@caotang/import-rtf`), the archive reader (`@caotang/import-read/zip`) for a zipped `.rtfd`, the Inklewriter reader
 * (`@caotang/import-inklewriter`, issue #286) and the Highland reader (`@caotang/import-highland`, issue #284). None needs a DOM.
 * fflate is reached only through the archive reader's `unzipSync`, never its async blob workers.
 */

import type { ImportArchive } from '@caotang/import-read/zip';
import type { RtfReadResult, RtfdReadResult } from '@caotang/import-rtf';

import type { ReaderOpen, ReaderRead, ReaderResult, SerializableRtfResult } from './reader-protocol.js';

type State =
  | { readonly reader: 'text' | 'captions' | 'table' | 'xlsx' | 'rtf' | 'inklewriter' | 'highland'; readonly bytes: Uint8Array }
  | { readonly reader: 'rtfd'; readonly archive: ImportArchive }
  | { readonly reader: 'html'; readonly bytes: Uint8Array; readonly fileName: string }
  | { readonly reader: 'html-archive'; readonly archive: ImportArchive }
  | { readonly reader: 'epub'; readonly archive: ImportArchive }
  | { readonly reader: 'ao3'; readonly bytes: Uint8Array; readonly fileName: string }
  | { readonly reader: 'kanka'; readonly archive: ImportArchive }
  | { readonly reader: 'docx'; readonly bytes: Uint8Array; readonly archive: ImportArchive }
  | { readonly reader: 'odt'; readonly bytes: Uint8Array };

/** Flattens an RTF or archive refusal to a code and a message, so it survives the structured clone (an Error's own `code` does not). */
function serialiseRtf(result: RtfReadResult | RtfdReadResult): SerializableRtfResult {
  return result.ok ? { ok: true, value: result.value } : { ok: false, error: { code: result.error.code, message: result.error.message } };
}

/** One reader session: `open` caches the input, `read` re-reads it with the given options. */
export function createReaderSession(): (req: ReaderOpen | ReaderRead) => Promise<ReaderResult> {
  let state: State | null = null;

  const open = async (req: ReaderOpen): Promise<void> => {
    if (req.reader === 'text' || req.reader === 'captions' || req.reader === 'table' || req.reader === 'xlsx' || req.reader === 'rtf' || req.reader === 'inklewriter' || req.reader === 'highland') {
      state = { reader: req.reader, bytes: req.bytes };
      return;
    }
    if (req.reader === 'html') {
      state = { reader: 'html', bytes: req.bytes, fileName: req.fileName };
      return;
    }
    if (req.reader === 'ao3') {
      state = { reader: 'ao3', bytes: req.bytes, fileName: req.fileName };
      return;
    }
    if (req.reader === 'odt') {
      state = { reader: 'odt', bytes: req.bytes };
      return;
    }
    const { openFolder, openZip } = await import('@caotang/import-read/zip');
    const archive =
      req.reader === 'rtfd-zip' || req.reader === 'html-zip' || req.reader === 'epub' || req.reader === 'kanka' || req.reader === 'docx'
        ? await openZip(req.bytes)
        : openFolder(req.files.map((file) => ({ path: file.path, size: file.size, read: async () => file.bytes })));
    if (!archive.ok) throw new Error(archive.error.message);
    if (req.reader === 'html-zip') state = { reader: 'html-archive', archive: archive.value };
    else if (req.reader === 'epub') state = { reader: 'epub', archive: archive.value };
    else if (req.reader === 'kanka') state = { reader: 'kanka', archive: archive.value };
    else if (req.reader === 'docx') state = { reader: 'docx', bytes: req.bytes, archive: archive.value };
    else state = { reader: 'rtfd', archive: archive.value };
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
    if (req.reader === 'captions') {
      if (state.reader !== 'captions') throw new Error('The import reader is not a captions reader.');
      const { decodePlainText } = await import('@caotang/import-read/text');
      const { parseCaptions } = await import('@caotang/import-captions');
      const decoded = decodePlainText(state.bytes, req.encoding === undefined ? {} : { encoding: req.encoding });
      if (decoded.status !== 'decoded') return { kind: 'captions', result: { status: 'undecoded', decode: decoded } };
      return {
        kind: 'captions',
        result: { status: 'read', encoding: decoded.encoding, guessed: decoded.guessed, candidates: decoded.candidates, parse: parseCaptions(decoded.text) },
      };
    }
    if (req.reader === 'table') {
      if (state.reader !== 'table') throw new Error('The import reader is not a table reader.');
      const { decodePlainText, normalisePlainText } = await import('@caotang/import-read/text');
      const { parseTableText } = await import('@caotang/import-table');
      const decoded = decodePlainText(state.bytes, req.encoding === undefined ? {} : { encoding: req.encoding });
      if (decoded.status !== 'decoded') return { kind: 'table', result: { status: 'undecoded', decode: decoded } };
      const text = normalisePlainText(decoded.text).text;
      const parse = parseTableText(text, req.delimiter === undefined ? {} : { delimiter: req.delimiter });
      return {
        kind: 'table',
        result: { status: 'read', encoding: decoded.encoding, guessed: decoded.guessed, candidates: decoded.candidates, parse },
      };
    }
    if (req.reader === 'xlsx') {
      if (state.reader !== 'xlsx') throw new Error('The import reader is not an Excel workbook reader.');
      const { readXlsx } = await import('@caotang/import-xlsx');
      return { kind: 'xlsx', result: await readXlsx(state.bytes, req.sheet === undefined ? {} : { sheet: req.sheet }) };
    }
    if (req.reader === 'inklewriter') {
      if (state.reader !== 'inklewriter') throw new Error('The import reader is not an Inklewriter reader.');
      const { readInklewriter } = await import('@caotang/import-inklewriter');
      return { kind: 'inklewriter', result: readInklewriter(state.bytes, req.fileName ?? '') };
    }
    if (req.reader === 'html') {
      const { readHtmlFile, readHtmlArchive } = await import('@caotang/import-html');
      if (state.reader === 'html') return { kind: 'html', result: readHtmlFile(state.bytes, state.fileName) };
      if (state.reader === 'html-archive') return { kind: 'html', result: await readHtmlArchive(state.archive) };
      throw new Error('The import reader is not an HTML reader.');
    }
    if (req.reader === 'highland') {
      if (state.reader !== 'highland') throw new Error('The import reader is not a Highland reader.');
      const { readHighland } = await import('@caotang/import-highland');
      return { kind: 'highland', result: await readHighland(state.bytes, req.fileName ?? '') };
    }
    if (req.reader === 'epub') {
      if (state.reader !== 'epub') throw new Error('The import reader is not an EPUB reader.');
      const { readEpubArchive } = await import('@caotang/import-epub');
      return { kind: 'epub', result: await readEpubArchive(state.archive) };
    }
    if (req.reader === 'ao3') {
      if (state.reader !== 'ao3') throw new Error('The import reader is not an AO3 reader.');
      const { readAo3Html, readAo3Epub } = await import('@caotang/import-ao3');
      // An AO3 download is a page or a zip; the bytes say which, whatever the file was named.
      const zipped = state.bytes[0] === 0x50 && state.bytes[1] === 0x4b;
      return { kind: 'ao3', result: zipped ? await readAo3Epub(state.bytes) : readAo3Html(state.bytes, state.fileName) };
    }
    if (req.reader === 'kanka') {
      if (state.reader !== 'kanka') throw new Error('The import reader is not a Kanka reader.');
      const { readKankaArchive } = await import('@caotang/import-kanka');
      return { kind: 'kanka', result: await readKankaArchive(state.archive, req.labels === undefined ? {} : { labels: req.labels }) };
    }
    if (req.reader === 'odt') {
      if (state.reader !== 'odt') throw new Error('The import reader is not an OpenDocument reader.');
      const { readOdt } = await import('@caotang/import-odt');
      return { kind: 'odt', result: await readOdt(state.bytes, req.options ?? {}) };
    }
    if (req.reader === 'docx') {
      if (state.reader !== 'docx') throw new Error('The import reader is not a Word reader.');
      const { readDocxArchive, readDocxZip } = await import('@caotang/import-docx');
      // One Word file, or a zip of them: the archive's own entries say which.
      const single = state.archive.entry('word/document.xml') !== undefined;
      return { kind: 'docx', result: single ? await readDocxArchive(state.archive, req.options ?? {}) : await readDocxZip(state.bytes, req.options ?? {}) };
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
