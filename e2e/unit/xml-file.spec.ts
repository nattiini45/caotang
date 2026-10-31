import { expect, test } from '@playwright/test';

import { readXmlFileText } from '../../apps/desktop/src/app/xml-file.js';

/** The script import's XML decoding (#268): an FDX file is read as its byte-order mark and declaration say, not always as UTF-8. */

const utf16 = (text: string, bigEndian: boolean): Uint8Array => {
  const out = new Uint8Array(2 + text.length * 2);
  out.set(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = bigEndian ? c >> 8 : c & 0xff;
    out[3 + i * 2] = bigEndian ? c & 0xff : c >> 8;
  }
  return out;
};

const FDX = '<?xml version="1.0" encoding="UTF-16"?><FinalDraft><Content><Paragraph Type="Action"><Text>Café 草堂</Text></Paragraph></Content></FinalDraft>';

test('reads UTF-16 either way round, and UTF-8 with or without a mark, to the same text', async () => {
  for (const bytes of [utf16(FDX, false), utf16(FDX, true)]) expect(await readXmlFileText(bytes)).toEqual({ text: FDX });
  const utf8 = FDX.replace('UTF-16', 'UTF-8');
  expect(await readXmlFileText(new TextEncoder().encode(utf8))).toEqual({ text: utf8 });
  expect(await readXmlFileText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(utf8)]))).toEqual({ text: utf8 });
});

test('reads a declared windows-1252 file, and refuses bytes that are not valid in their encoding with the reason', async () => {
  const head = new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?><t>');
  expect(await readXmlFileText(new Uint8Array([...head, 0x93, 0x41, 0x94, ...new TextEncoder().encode('</t>')]))).toEqual({
    text: '<?xml version="1.0" encoding="windows-1252"?><t>\u201cA\u201d</t>',
  });
  const result = await readXmlFileText(new Uint8Array([...new TextEncoder().encode('<t>'), 0xff, 0xfe, 0x41]));
  expect(result).toEqual({ problem: 'The file holds bytes that are not valid utf-8' });
});
