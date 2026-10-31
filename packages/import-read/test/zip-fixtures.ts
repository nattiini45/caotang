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

/** A zip with exactly these entries, central directory and all. CRCs are written as zero: fflate's `unzipSync` does not check them. */
export function rawZip(entries: readonly RawEntry[]): Uint8Array {
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
    const head = new Uint8Array(46 + name.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    head.set(name, 46);
    parts.push(local, e.data);
    central.push(head);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
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
