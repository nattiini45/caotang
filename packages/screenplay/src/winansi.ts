/**
 * The characters Courier Prime prints: the WinAnsi encoding the screenplay PDF sets it in ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 * Its own module so the width rule (width.ts) and the writer (pdf.ts) read the same test.
 */

/**
 * Characters WinAnsi encodes above 0x7F that the Latin-1 range does not cover: all 27 of them, the code points
 * 0x80 to 0x9F hold in Windows-1252 (PDF 1.7 Annex D.2). 0x81, 0x8D, 0x8F, 0x90 and 0x9D encode nothing.
 */
export const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = {
  '€': 0x80,
  '‚': 0x82,
  'ƒ': 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  'ˆ': 0x88,
  '‰': 0x89,
  'Š': 0x8A,
  '‹': 0x8B,
  'Œ': 0x8C,
  'Ž': 0x8E,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  'š': 0x9A,
  '›': 0x9B,
  'œ': 0x9C,
  'ž': 0x9E,
  'Ÿ': 0x9F,
};

/** Whether WinAnsi can encode a character, so the font can print it. */
export function isPrintable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA[ch] !== undefined;
}

