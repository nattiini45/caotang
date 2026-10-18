/**
 * The fallback font for text the PDF's built-in Helvetica cannot encode ([storyboard.md](../../../docs/architecture/storyboard.md) §6).
 *
 * The font is Noto Sans CJK SC Regular (OFL-1.1), as a TrueType WOFF file in `@caotang/font-noto-cjk` (vendor/noto-sans-cjk,
 * where its source, checksum and build are written down). It covers Chinese (simplified and traditional), Japanese kana and
 * kanji, Korean Hangul, Greek and Cyrillic.
 *
 * The exporter names no place to read it from. The host passes a {@link FontLoader}: the app fetches the file from its own
 * origin (Vite emits it as a separate asset), and Node reads it from the package (`./fallback-fonts-node.ts`). The emitter calls the
 * loader only when a file holds a character Helvetica cannot encode, so a Latin-only export never reads the font.
 */

/** Reads the fallback font's bytes: WOFF 1.0 or a bare TrueType/OpenType file. */
export type FontLoader = () => Promise<Uint8Array>;

/** The fallback font's file name in `@caotang/font-noto-cjk`. */
export const CJK_FONT_FILE = 'NotoSansCJKsc-Regular.woff';

/** The fallback font's name, as the compile log names it. */
export const CJK_FONT_NAME = 'Noto Sans CJK SC';

const WOFF_SIGNATURE = 0x774f4646; // 'wOFF'
const WOFF_HEADER = 44;
const WOFF_ENTRY = 20;
const SFNT_HEADER = 12;
const SFNT_ENTRY = 16;

/**
 * The largest font file a WOFF may unpack to. The fonts Caotang ships unpack to about 12 MB (Noto Sans CJK SC) and under
 * 1 MB (Noto Emoji); a file that says it unpacks to more is refused before anything is inflated.
 */
export const MAX_SFNT_BYTES = 64 * 1024 * 1024;

/** The first four bytes of a font file: WOFF, WOFF2, TrueType (`00 01 00 00`, `true`), OpenType CFF (`OTTO`) and a collection (`ttcf`). */
const FONT_SIGNATURES = new Set([WOFF_SIGNATURE, 0x774f4632, 0x00010000, 0x74727565, 0x4f54544f, 0x74746366]);

/** Whether bytes start as a font file does (see {@link FONT_SIGNATURES}). */
export function looksLikeFont(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return FONT_SIGNATURES.has(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0));
}

/**
 * The bytes, when they start as a font file does; otherwise an error that says what `source` served instead, so an HTML page
 * served in a font's place (a dev server's fallback, a proxy's error page) is named as such and not as a font parse error.
 */
export function checkFontBytes(bytes: Uint8Array, source: string): Uint8Array {
  if (looksLikeFont(bytes)) return bytes;
  const head = Array.from(bytes.subarray(0, 16), (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');
  throw new Error(`${source} did not serve a font file (${bytes.byteLength} bytes, starting "${head}")`);
}

/**
 * A WOFF 1.0 file unpacked to the TrueType/OpenType file it wraps; any other bytes are returned as they are. fontkit reads
 * WOFF itself, but it inflates the whole glyph table again for every glyph it subsets, so the exporter unpacks the file once.
 * `fflate`'s browser build is loaded with a dynamic `import()` here, as the EPUB renderer loads it (exporter.md §3a).
 */
export async function sfntFromWoff(bytes: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < WOFF_HEADER || view.getUint32(0) !== WOFF_SIGNATURE) return bytes;
  const flavor = view.getUint32(4);
  const numTables = view.getUint16(12);
  const totalSfntSize = view.getUint32(16);
  if (bytes.byteLength < WOFF_HEADER + numTables * WOFF_ENTRY) throw new Error('the WOFF table directory is cut short');
  if (totalSfntSize > MAX_SFNT_BYTES) throw new Error(`the WOFF file says it unpacks to ${totalSfntSize} bytes, more than a font may (${MAX_SFNT_BYTES})`);
  const { unzlibSync } = await import('fflate/browser');

  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  // Every table's stated length counts against the file's stated size before any table is inflated, and each table inflates
  // into a buffer one byte longer than it says it is, so a stream that decodes to more stops there and is refused.
  let unpacked = SFNT_HEADER + numTables * SFNT_ENTRY;
  for (let i = 0; i < numTables; i += 1) {
    unpacked += view.getUint32(WOFF_HEADER + i * WOFF_ENTRY + 12);
    if (unpacked > totalSfntSize) throw new Error('the WOFF tables unpack to more than the file says it holds');
  }
  for (let i = 0; i < numTables; i += 1) {
    const entry = WOFF_HEADER + i * WOFF_ENTRY;
    const tag = view.getUint32(entry);
    const offset = view.getUint32(entry + 4);
    const compLength = view.getUint32(entry + 8);
    const origLength = view.getUint32(entry + 12);
    const checksum = view.getUint32(entry + 16);
    if (offset + compLength > bytes.byteLength) throw new Error('a WOFF table runs past the end of the file');
    const stored = bytes.subarray(offset, offset + compLength);
    const data = compLength < origLength ? unzlibSync(stored, { out: new Uint8Array(origLength + 1) }) : stored;
    if (data.byteLength !== origLength) throw new Error('a WOFF table did not inflate to its stated length');
    tables.push({ tag, checksum, data });
  }

  const padded = (length: number): number => (length + 3) & ~3;
  let size = SFNT_HEADER + numTables * SFNT_ENTRY;
  for (const table of tables) size += padded(table.data.byteLength);
  const out = new Uint8Array(size);
  const write = new DataView(out.buffer);
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= numTables) entrySelector += 1;
  const searchRange = 2 ** entrySelector * 16;
  write.setUint32(0, flavor);
  write.setUint16(4, numTables);
  write.setUint16(6, searchRange);
  write.setUint16(8, entrySelector);
  write.setUint16(10, numTables * 16 - searchRange);
  let at = SFNT_HEADER + numTables * SFNT_ENTRY;
  tables.forEach((table, i) => {
    const entry = SFNT_HEADER + i * SFNT_ENTRY;
    write.setUint32(entry, table.tag);
    write.setUint32(entry + 4, table.checksum);
    write.setUint32(entry + 8, at);
    write.setUint32(entry + 12, table.data.byteLength);
    out.set(table.data, at);
    at += padded(table.data.byteLength);
  });
  return out;
}
