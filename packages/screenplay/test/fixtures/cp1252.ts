/**
 * Windows-1252 written out for the tests that read WinAnsi strings back out of a PDF. WinAnsiEncoding is Windows-1252 (PDF 1.7
 * Annex D.2); the runtime's TextDecoder is not asked, because Node 22.13.0 to 22.22.0 decode `windows-1252` as ISO-8859-1
 * (nodejs/node#60888) and the Node 22 floor sits inside that range.
 */

/** WHATWG index-windows-1252 for 0x80 to 0x9F. The five empty codes (0x81, 0x8D, 0x8F, 0x90, 0x9D) stand for their C1 controls. */
export const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

/** The character a Windows-1252 byte decodes to. */
export function cp1252Char(byte: number): string {
  return byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : String.fromCharCode(byte);
}
