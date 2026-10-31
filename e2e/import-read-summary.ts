/**
 * What `import-read-worker.spec.ts` asks the shared readers, written once and run in three places: the Node test runner, the
 * page's main thread, and a module Worker. The readers are passed in rather than imported, so the same function runs against
 * whichever copy of the module each place loaded.
 */

import type * as Xml from '../packages/import-read/src/xml.js';
import type * as Zip from '../packages/import-read/src/zip.js';

export interface ReadersInput {
  /** A small OOXML-shaped document, as UTF-16 LE bytes with a byte-order mark. */
  readonly xml: readonly number[];
  /** A zip holding that document under `word/document.xml`, a `__MACOSX/` entry and a CP437-named file. */
  readonly zip: readonly number[];
  /** A zip with an entry that climbs out of the folder. */
  readonly traversal: readonly number[];
}

export interface ReadersSummary {
  readonly xml: { readonly encoding: string; readonly paragraphs: readonly string[]; readonly style: string | undefined };
  readonly malformed: string;
  readonly entries: readonly string[];
  readonly ignored: readonly string[];
  readonly fromZip: readonly string[];
  readonly traversal: string;
}

export interface Readers {
  readonly readXml: typeof Xml.readXml;
  readonly descendants: typeof Xml.descendants;
  readonly attr: typeof Xml.attr;
  readonly textOf: typeof Xml.textOf;
  readonly openZip: typeof Zip.openZip;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export async function readersSummary(input: ReadersInput, r: Readers): Promise<ReadersSummary> {
  const paragraphsOf = (bytes: Uint8Array): { encoding: string; paragraphs: string[]; style: string | undefined } => {
    const read = r.readXml(bytes);
    if (!read.ok) throw read.error;
    const style = [...r.descendants(read.document.root, 'pStyle', W)][0];
    return {
      encoding: read.document.encoding,
      paragraphs: [...r.descendants(read.document.root, 'p', W)].map(r.textOf),
      style: style === undefined ? undefined : r.attr(style, 'val', W),
    };
  };
  const malformed = r.readXml('<a><b></a>');
  const zip = await r.openZip(new Uint8Array(input.zip));
  if (!zip.ok) throw zip.error;
  const document = await zip.value.read('word/document.xml');
  if (!document.ok) throw document.error;
  const traversal = await r.openZip(new Uint8Array(input.traversal));
  return {
    xml: paragraphsOf(new Uint8Array(input.xml)),
    malformed: malformed.ok ? 'read' : `${malformed.error.name}:${malformed.error.code}`,
    entries: zip.value.entries.map((e) => e.path),
    ignored: zip.value.ignored,
    fromZip: paragraphsOf(document.value).paragraphs,
    traversal: traversal.ok ? 'opened' : `${traversal.error.name}:${traversal.error.code}`,
  };
}
