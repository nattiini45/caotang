/**
 * Registers the objects of `@caotang/pdf-fonts` (`PdfObject`: dictionaries and streams that refer to each other by their index
 * in a list) with pdf-lib. The CID fonts (cid-embedding.ts) and the colour emoji's Type 3 fonts (colour-emoji-font.ts) are written
 * by libraries-free writers there and registered here.
 */

import type { PdfObject, PdfValue } from '@caotang/pdf-fonts';
import type * as PdfLib from 'pdf-lib';

/**
 * Registers `objects` in the document and returns their references. Object `i` takes `fixed[i]` when the host reserved a reference
 * for it (a font a page already points at), and a new one otherwise. A `raw` value or object is PDF syntax from a pinned asset, parsed
 * by pdf-lib's own object parser.
 */
export function registerPdfObjects(lib: typeof PdfLib, doc: PdfLib.PDFDocument, objects: readonly PdfObject[], fixed: ReadonlyMap<number, PdfLib.PDFRef> = new Map()): PdfLib.PDFRef[] {
  const { PDFName, PDFNumber, PDFString, PDFObjectParser } = lib;
  const context = doc.context;
  const refs = objects.map((_, index) => fixed.get(index) ?? context.nextRef());
  const parse = (text: string): PdfLib.PDFObject => PDFObjectParser.forBytes(new TextEncoder().encode(text), context).parseObject();
  const convert = (value: PdfValue): PdfLib.PDFObject => {
    if (typeof value === 'number') return PDFNumber.of(value);
    if (Array.isArray(value)) return context.obj((value as readonly PdfValue[]).map(convert));
    const object = value as Exclude<PdfValue, number | readonly PdfValue[]>;
    if ('name' in object) return PDFName.of(object.name);
    if ('string' in object) return PDFString.of(object.string);
    if ('ref' in object) return refs[object.ref] as PdfLib.PDFRef;
    if ('raw' in object) return parse(object.raw);
    return convertDict(object.dict);
  };
  const convertDict = (dict: { readonly [key: string]: PdfValue }): PdfLib.PDFDict =>
    context.obj(Object.fromEntries(Object.entries(dict).map(([key, item]) => [key, convert(item)]))) as PdfLib.PDFDict;
  objects.forEach((object, index) => {
    const ref = refs[index] as PdfLib.PDFRef;
    if (object.raw !== undefined) {
      context.assign(ref, parse(object.raw));
      return;
    }
    const entries = Object.fromEntries(Object.entries(object.dict).map(([key, item]) => [key, convert(item)]));
    if (object.stream === undefined) context.assign(ref, context.obj(entries));
    else context.assign(ref, context.flateStream(object.stream, entries));
  });
  return refs;
}
