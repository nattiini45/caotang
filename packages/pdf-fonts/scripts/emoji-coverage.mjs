/* global URL, console */
// The root lint config gives Node globals to tools/ and to TypeScript only. This script runs under Node, so it names the
// globals it reads here rather than widening the config for one file.
/**
 * Writes src/coverage/noto-emoji-coverage.ts, what the emoji fallback font prints, from the font file itself and the Unicode
 * emoji list its release supports (test/fixtures/emoji-test-17.0.txt).
 *
 *   node packages/pdf-fonts/scripts/emoji-coverage.mjs
 *
 * Four tables:
 *  - NOTO_EMOJI_RANGES: the code points the font's cmap maps (the CJK table's "gap.length" encoding).
 *  - NOTO_EMOJI_SEQUENCES: the sequences of two or more code points the font lays out as one glyph, written as their key
 *    (emoji.ts `emojiKey`: variation selectors and skin-tone modifiers after the first code point taken out). The
 *    monochrome font has no skin tones, so a toned sequence prints as its key's glyph.
 *  - NOTO_EMOJI_TONED: the keys that lay out as one glyph only with their skin-tone modifiers in place (the handshake and
 *    couple sequences with two tones).
 *  - NOTO_EMOJI_LAYOUT: the keys whose glyph fontkit does not reach though the font has one, each with the glyph HarfBuzz
 *    lays it out as (the woman and man walking, kneeling or running facing right, which fontkit 1.1.1 lays out as their parts).
 *    Both PDFs draw that glyph (coverage.ts `emojiFontLayoutGlyph`).
 *
 * HarfBuzz (harfbuzzjs 1.6.3, a devDependency of this package) runs here and in the tests, never when a PDF is written.
 *
 * test/coverage.test.ts reads the font again and checks the tables against it, so a font update without a rerun fails.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import * as hb from 'harfbuzzjs';

const woff = readFileSync(new URL('../../../vendor/noto-emoji/NotoEmoji-Regular.woff', import.meta.url));
const font = fontkit.create(woff);
const list = readFileSync(new URL('../test/fixtures/emoji-test-17.0.txt', import.meta.url), 'utf8');

// The same rule as emojiKey.
const MODIFIER = /(?<=.)[\u{1F3FB}-\u{1F3FF}]/gu;
const keyOf = (unit) => unit.replace(/[\uFE0E\uFE0F]/g, '').replace(MODIFIER, '') || unit;
const single = (text) => {
  const glyphs = font.layout(text).glyphs;
  return glyphs.length === 1 && glyphs[0].id !== 0;
};
const hexes = (text) => [...text].map((ch) => (ch.codePointAt(0) ?? 0).toString(36)).join('.');

/** The sfnt inside a WOFF 1.0 file: HarfBuzz reads an sfnt (font-bytes.ts `sfntFromWoff` does this for fontkit). */
function sfntFromWoff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(12);
  const tables = Array.from({ length: count }, (_, i) => {
    const at = 44 + i * 20;
    const [offset, packed, length, sum] = [4, 8, 12, 16].map((delta) => view.getUint32(at + delta));
    return { tag: bytes.subarray(at, at + 4), offset, packed, length, sum };
  });
  const padded = (n) => (n + 3) & ~3;
  const out = new Uint8Array(12 + 16 * count + tables.reduce((total, table) => total + padded(table.length), 0));
  const head = new DataView(out.buffer);
  head.setUint32(0, view.getUint32(4));
  head.setUint16(4, count);
  const log = Math.floor(Math.log2(count));
  head.setUint16(6, 16 << log);
  head.setUint16(8, log);
  head.setUint16(10, 16 * count - (16 << log));
  let at = 12 + 16 * count;
  tables.forEach((table, i) => {
    const entry = 12 + i * 16;
    out.set(table.tag, entry);
    head.setUint32(entry + 4, table.sum);
    head.setUint32(entry + 8, at);
    head.setUint32(entry + 12, table.length);
    const data = bytes.subarray(table.offset, table.offset + table.packed);
    out.set(table.packed === table.length ? data : inflateSync(data), at);
    at += padded(table.length);
  });
  return out;
}

const hbFont = new hb.Font(new hb.Face(new hb.Blob(sfntFromWoff(woff).buffer)));
const hbBuffer = new hb.Buffer();
/** The glyphs HarfBuzz draws for a text: those it gives room, not the variation selectors and joiners it hides. */
function harfbuzzGlyphs(text) {
  hbBuffer.reset();
  hbBuffer.addText(text);
  hbBuffer.guessSegmentProperties();
  hb.shape(hbFont, hbBuffer);
  const positions = hbBuffer.getGlyphPositions();
  return hbBuffer.getGlyphInfos().filter((_, i) => positions[i].xAdvance > 0).map((info) => info.codepoint);
}

const sequences = new Set();
const toned = new Set();
const layout = new Map();
for (const line of list.split('\n')) {
  if (!/^[0-9A-F]/.test(line)) continue;
  const unit = line
    .split(';')[0]
    .trim()
    .split(/\s+/)
    .map((hex) => String.fromCodePoint(parseInt(hex, 16)))
    .join('');
  const key = keyOf(unit);
  if (line.split(';')[1]?.trim().startsWith('fully-qualified')) {
    // Both PDFs draw the glyph fontkit lays the cluster, its form without variation selectors or its key out as; where that is
    // not HarfBuzz's one glyph, HarfBuzz's is the answer.
    const reference = harfbuzzGlyphs(unit);
    if (reference.length !== 1) throw new Error(`HarfBuzz lays ${hexes(unit)} out as ${reference.length} glyphs`);
    const drawn = [unit, unit.replace(/️/g, ''), key].map((form) => font.layout(form).glyphs).find((glyphs) => glyphs.length === 1 && glyphs[0].id !== 0);
    if (drawn?.[0].id !== reference[0]) {
      if (layout.get(key) !== undefined && layout.get(key) !== reference[0]) throw new Error(`${hexes(key)} has more than one glyph, by its skin tones`);
      layout.set(key, reference[0]);
    }
  }
  if ([...key].length < 2) continue;
  if (single(key)) sequences.add(key);
  else if (single(unit) || single(unit.replace(/\uFE0F/g, ''))) toned.add(key);
}
for (const key of sequences) toned.delete(key);

const points = [...font.characterSet].sort((a, b) => a - b);
const tokens = [];
let previousEnd = -1;
for (let i = 0; i < points.length; ) {
  let j = i;
  while (j + 1 < points.length && points[j + 1] === points[j] + 1) j++;
  tokens.push(`${(points[i] - previousEnd - 1).toString(36)}.${(j - i + 1).toString(36)}`);
  previousEnd = points[j];
  i = j + 1;
}

/** A long space-separated table as string literals of about 116 characters, joined with `+`. */
function literal(body) {
  const lines = body.match(/.{1,116}(?: |$)/g).map((line) => `  '${line.trimEnd()} ' +`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/ ' \+$/, "';");
  return lines.join('\n');
}

const seqBody = [...sequences].sort().map(hexes).join(' ');
const tonedBody = [...toned].sort().map(hexes).join(' ');
const layoutBody = [...layout.keys()].sort().map((key) => `${hexes(key)}=${layout.get(key).toString(36)}`).join(' ');
writeFileSync(
  new URL('../src/coverage/noto-emoji-coverage.ts', import.meta.url),
  `/**
 * What Noto Emoji prints, so the layout knows before the font loads which emoji print and which print as "?". Generated by
 * scripts/emoji-coverage.mjs from the font file and the Unicode 17.0 emoji list; do not edit.
 */

/** The code points the font maps (its cmap). Each range is "gap.length" in base 36, as in noto-cjk-coverage.ts. */
export const NOTO_EMOJI_RANGES =
${literal(tokens.join(' '))}

/** How many code points the font maps. */
export const NOTO_EMOJI_CODE_POINTS = ${points.length};

/**
 * The sequences the font lays out as one glyph, by key (emoji.ts): space-separated, each one's code points in base 36
 * joined by dots.
 */
export const NOTO_EMOJI_SEQUENCES =
${literal(seqBody)}

/** The keys that lay out as one glyph only with their skin-tone modifiers in place. Same encoding. */
export const NOTO_EMOJI_TONED =
${literal(tonedBody)}

/**
 * The keys fontkit lays out as more than one glyph though the font has one for them, each with the glyph HarfBuzz lays it out
 * as: the key as in NOTO_EMOJI_SEQUENCES, "=", the glyph id in base 36.
 */
export const NOTO_EMOJI_LAYOUT =
${literal(layoutBody)}
`,
);
console.log(`${points.length} code points in ${tokens.length} ranges, ${sequences.size} sequences, ${toned.size} toned keys, ${layout.size} layout keys`);
