/**
 * Hand-built zips for the archive reader's tests: names with or without the UTF-8 flag, declared sizes that lie, and any
 * method. fflate's own `zipSync` always writes honest headers, so the hostile shapes are written byte by byte here.
 */

import { deflateSync, zipSync } from 'fflate/browser';

export interface RawEntry {
  /** The name's bytes as stored. */
  readonly name: Uint8Array | string;
  /** The stored data: raw bytes for method 0, deflate output for method 8. */
  readonly data: Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  /** The uncompressed size the directory declares; defaults to `data.length` for method 0. */
  readonly size?: number;
}

const enc = new TextEncoder();

export interface RawZipOptions {
  /**
   * Write the zip64 records, as some archivers always do: every size in the central directory is 0xFFFFFFFF with the real sizes
   * in a zip64 extended-information field, and a zip64 end record and its locator sit before the end record.
   */
  readonly zip64?: boolean;
  /** With `zip64`, damage the zip64 end record's signature, so the locator points at nothing. */
  readonly breakZip64Record?: boolean;
}

/** A zip with exactly these entries, central directory and all. CRCs are written as zero: fflate's `unzipSync` does not check them. */
export function rawZip(entries: readonly RawEntry[], options: RawZipOptions = {}): Uint8Array {
  const zip64 = options.zip64 === true;
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = typeof e.name === 'string' ? enc.encode(e.name) : e.name;
    const method = e.method ?? 0;
    const size = e.size ?? e.data.length;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const extra = zip64 ? 20 : 0;
    const head = new Uint8Array(46 + name.length + extra);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, zip64 ? 0xffffffff : e.data.length, true);
    cv.setUint32(24, zip64 ? 0xffffffff : size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra, true);
    cv.setUint32(42, offset, true);
    head.set(name, 46);
    if (zip64) {
      // The zip64 extended-information field: id 1, then the uncompressed size and the compressed size, eight bytes each.
      const x = 46 + name.length;
      cv.setUint16(x, 1, true);
      cv.setUint16(x + 2, 16, true);
      cv.setBigUint64(x + 4, BigInt(size), true);
      cv.setBigUint64(x + 12, BigInt(e.data.length), true);
    }
    parts.push(local, e.data);
    central.push(head);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, zip64 ? 0xffff : entries.length, true);
  ev.setUint16(10, zip64 ? 0xffff : entries.length, true);
  ev.setUint32(12, zip64 ? 0xffffffff : cdSize, true);
  ev.setUint32(16, zip64 ? 0xffffffff : offset, true);
  const tail: Uint8Array[] = [];
  if (zip64) {
    const record = new Uint8Array(56);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, options.breakZip64Record === true ? 0x06064b51 : 0x06064b50, true);
    rv.setBigUint64(4, 44n, true);
    rv.setUint16(12, 45, true);
    rv.setUint16(14, 45, true);
    rv.setBigUint64(24, BigInt(entries.length), true);
    rv.setBigUint64(32, BigInt(entries.length), true);
    rv.setBigUint64(40, BigInt(cdSize), true);
    rv.setBigUint64(48, BigInt(offset), true);
    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setBigUint64(8, BigInt(offset + cdSize), true);
    lv.setUint32(16, 1, true);
    tail.push(record, locator);
  }
  const all = [...parts, ...central, ...tail, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An honest zip of text files, written by fflate. */
export function textZip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])));
}

export { deflateSync };
