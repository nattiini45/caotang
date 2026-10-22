/* global URL, console */
// The root lint config gives Node globals to tools/ and to TypeScript only. This script runs under Node, so it names the
// globals it reads here rather than widening the config for one file.
/**
 * Writes test/fixtures/shaping/devanagari-golden.json: what HarfBuzz (harfbuzzjs 1.6.3, a devDependency of this package that no
 * PDF writer loads) shapes for the Devanagari fixtures on the vendored Noto Sans Devanagari. The fixtures are the ones the
 * decision on issue #35 names (हिन्दी, क्षत्रिय, कि, र्क, श्री, द्ध, प्रेम, कार्यक्रम, स्त्री, क़ both ways, a Marathi and a Nepali
 * `locl` case), and more words of the same kinds.
 *
 *   node packages/pdf-fonts/scripts/indic-golden.mjs
 *
 * test/indic-shaper.test.ts shapes each fixture with fontkit 2.0.4 and with HarfBuzz again, and checks both against this file, so
 * a change of font, engine or fixture shows.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as hb from 'harfbuzzjs';

const FIXTURES = JSON.parse(readFileSync(new URL('../test/fixtures/shaping/devanagari-fixtures.json', import.meta.url), 'utf8'));
const bytes = readFileSync(new URL('../../../vendor/noto-sans-devanagari/NotoSansDevanagari-Regular.ttf', import.meta.url));
const font = new hb.Font(new hb.Face(new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))));

function shape(text, lang) {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.setDirection(hb.Direction.LTR);
  buffer.setScript('Deva');
  buffer.setLanguage(lang);
  hb.shape(font, buffer);
  const positions = buffer.getGlyphPositions();
  return buffer.getGlyphInfos().map((info, index) => ({
    gid: info.codepoint,
    xAdvance: positions[index].xAdvance,
    xOffset: positions[index].xOffset,
    yOffset: positions[index].yOffset,
  }));
}

const samples = FIXTURES.map(({ group, text, lang }) => ({ group, text, lang, harfbuzz: shape(text, lang) }));
writeFileSync(
  new URL('../test/fixtures/shaping/devanagari-golden.json', import.meta.url),
  `${JSON.stringify({ harfbuzzjs: '1.6.3', harfbuzz: hb.versionString(), font: 'NotoSansDevanagari-Regular.ttf 2.007', samples }, null, 1)}\n`,
);
console.log(`${samples.length} samples`);
