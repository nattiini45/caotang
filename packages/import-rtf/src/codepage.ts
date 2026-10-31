/**
 * Code pages for RTF's 8-bit text (`\'hh` escapes and raw bytes over 127).
 *
 * RTF names the document's code page in the header (`\ansicpg1252`, `\mac`) and a font's character set in the font table
 * (`\fcharset134` is GBK, `\fcharset128` Shift-JIS, `\fcharset136` Big5). The text is decoded with the host's own `TextDecoder`,
 * which knows every legacy encoding of the WHATWG Encoding Standard (windows-125x, macintosh, shift_jis, gbk, big5, euc-kr,
 * windows-874), in browsers, Workers and Node alike, so no conversion table is bundled. A code page the standard does not name
 * (DOS 437 and 850, Johab) falls back to windows-1252 and is reported, because a wrong guess there is visible in the text.
 */

/** `\ansicpgN` and `\cpgN` values → WHATWG encoding labels. */
const CODE_PAGES: Readonly<Record<number, string>> = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  10000: 'macintosh',
  10001: 'shift_jis',
  10003: 'euc-kr',
  10008: 'gbk',
  10002: 'big5',
  10007: 'x-mac-cyrillic',
  20936: 'gbk',
  54936: 'gb18030',
  65001: 'utf-8',
  28591: 'iso-8859-1',
  28592: 'iso-8859-2',
  28595: 'iso-8859-5',
  28597: 'iso-8859-7',
  28605: 'iso-8859-15',
  866: 'ibm866',
};

/** `\fcharsetN` values → code pages (RTF 1.9.1, `\fcharset`). 0 and 1 mean "the document's code page". */
const CHARSETS: Readonly<Record<number, number>> = {
  77: 10000,
  78: 10001,
  79: 10003,
  80: 10008,
  81: 10002,
  89: 10007,
  128: 932,
  129: 949,
  134: 936,
  136: 950,
  161: 1253,
  162: 1254,
  163: 1258,
  177: 1255,
  178: 1256,
  186: 1257,
  204: 1251,
  222: 874,
  238: 1250,
};

/** The charsets whose bytes are not text: Symbol (2) and the OEM set (255). Their bytes decode as windows-1252 and are counted. */
export const SYMBOL_CHARSET = 2;

export const DEFAULT_CODE_PAGE = 1252;

/** The code page a font's `\fcharset` names, or undefined for "the document's own". */
export function codePageOfCharset(charset: number): number | undefined {
  return CHARSETS[charset];
}

const decoders = new Map<string, TextDecoder | null>();

function decoderFor(label: string): TextDecoder | null {
  let decoder = decoders.get(label);
  if (decoder === undefined) {
    try {
      decoder = new TextDecoder(label, { fatal: false });
    } catch {
      decoder = null;
    }
    decoders.set(label, decoder);
  }
  return decoder;
}

/** Whether this host can decode the code page (a Node without full ICU lacks the CJK ones). */
export function canDecode(codePage: number): boolean {
  const label = CODE_PAGES[codePage];
  return label !== undefined && decoderFor(label) !== null;
}

/**
 * Bytes in a code page → text. A code page the host cannot decode is read as windows-1252, and `known` is false so the caller
 * can report it.
 */
export function decodeCodePage(bytes: Uint8Array, codePage: number): { readonly text: string; readonly known: boolean } {
  const label = CODE_PAGES[codePage];
  const decoder = label === undefined ? null : decoderFor(label);
  if (decoder !== null) return { text: decoder.decode(bytes), known: true };
  return { text: (decoderFor('windows-1252') as TextDecoder).decode(bytes), known: false };
}
