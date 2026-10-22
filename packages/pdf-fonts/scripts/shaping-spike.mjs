/* global console, process, URL */
// The root lint config gives Node globals to tools/ and to TypeScript only. This script runs under Node, so it names the
// globals it reads here rather than widening the config for one file.
/**
 * The spike that gated Arabic and Hebrew printing (issue #34): @pdf-lib/fontkit 1.1.1 against HarfBuzz on the vendored
 * Noto Sans Arabic and Noto Sans Hebrew. It is a scratch script, not part of any build: harfbuzzjs is NOT a dependency of
 * any package. To run it, install harfbuzzjs 1.6.3 in a directory of its own and point HARFBUZZJS at it:
 *
 *   mkdir /tmp/spike && cd /tmp/spike && npm init -y && npm install --save-exact harfbuzzjs@1.6.3
 *   HARFBUZZJS=/tmp/spike/node_modules/harfbuzzjs/dist/index.mjs node packages/pdf-fonts/scripts/shaping-spike.mjs
 *
 * It shapes every sample of SAMPLES with both engines and writes test/fixtures/shaping/golden.json: for each sample the
 * HarfBuzz result (the reference), the fontkit result, and whether they agree. Glyphs are listed left to right as drawn.
 * test/shaper.test.ts reads the file, so a change in the fontkit backend or in a font shows up as a diff against it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import fontkit from '@pdf-lib/fontkit';

const root = (path) => new URL(`../../../${path}`, import.meta.url);
const FONTS = {
  arabic: { file: 'vendor/noto-sans-arabic/NotoSansArabic-Regular.ttf', script: 'arab', hbScript: 'Arab', language: 'ar' },
  hebrew: { file: 'vendor/noto-sans-hebrew/NotoSansHebrew-Regular.ttf', script: 'hebr', hbScript: 'Hebr', language: 'he' },
};

/** [category, font, text]. A category is what the result decides: "plain" must match, "marks" decides the mark policy. */
const SAMPLES = [
  ['plain', 'arabic', 'السلام عليكم'],
  ['plain', 'arabic', 'السلام'],
  ['plain', 'arabic', 'عليكم'],
  ['plain', 'arabic', 'مرحبا بالعالم'],
  ['plain', 'arabic', 'مرحبا'],
  ['plain', 'arabic', 'بالعالم'],
  ['plain', 'arabic', 'كتاب جميل'],
  ['plain', 'arabic', 'لماذا تأخرت اليوم؟'],
  ['plain', 'arabic', 'هذا هو الفيلم الأول، وهو الأفضل.'],
  ['plain', 'arabic', 'ما اسمك'],
  ['plain', 'arabic', 'أنا بخير شكرا'],
  ['plain', 'arabic', 'يا سلام'],
  ['plain', 'arabic', 'مدرسة'],
  ['plain', 'arabic', 'ة'],
  ['plain', 'arabic', 'عائلة'],
  ['plain', 'arabic', 'مؤمن'],
  ['plain', 'arabic', 'الله'],
  ['lam-alef', 'arabic', 'لا'],
  ['lam-alef', 'arabic', 'لأ'],
  ['lam-alef', 'arabic', 'لإ'],
  ['lam-alef', 'arabic', 'لآ'],
  ['lam-alef', 'arabic', 'بلا'],
  ['lam-alef', 'arabic', 'كلا'],
  ['lam-alef', 'arabic', 'الأمل'],
  ['persian', 'arabic', 'پارسی'],
  ['persian', 'arabic', 'چطوری'],
  ['persian', 'arabic', 'گچپژ'],
  ['persian', 'arabic', 'می‌خواهم'],
  ['persian', 'arabic', 'سلام دنیا'],
  ['persian', 'arabic', 'کتاب'],
  ['persian', 'arabic', 'زندگی'],
  ['urdu', 'arabic', 'اردو'],
  ['urdu', 'arabic', 'ٹھیک ہے'],
  ['urdu', 'arabic', 'کیا حال ہے'],
  ['urdu', 'arabic', 'ڈاکٹر'],
  ['urdu', 'arabic', 'بڑا'],
  ['urdu', 'arabic', 'ہمارے'],
  ['urdu', 'arabic', 'پاکستان'],
  ['digits', 'arabic', '١٢٣٤٥٦٧٨٩٠'],
  ['digits', 'arabic', '۱۲۳۴۵۶۷۸۹۰'],
  ['digits', 'arabic', 'عام ٢٠٢٤'],
  ['marks', 'arabic', 'بِسْمِ اللّٰهِ'],
  ['marks', 'arabic', 'مُحَمَّد'],
  ['marks', 'arabic', 'كَتَبَ'],
  ['marks', 'arabic', 'شَدَّة'],
  ['marks', 'arabic', 'بِسْمِ'],
  ['marks', 'arabic', 'ٱلْحَمْدُ'],
  ['marks', 'arabic', 'قُرْآن'],
  ['marks', 'arabic', 'اللَّه'],
  ['marks', 'arabic', 'إِنَّ'],
  ['marks', 'arabic', 'عَلَيْكُم'],
  ['marks', 'arabic', 'ءٌ'],
  ['plain', 'hebrew', 'שלום'],
  ['plain', 'hebrew', 'עברית'],
  ['plain', 'hebrew', 'שלום עולם'],
  ['plain', 'hebrew', 'מה שלומך'],
  ['plain', 'hebrew', 'בשקט'],
  ['plain', 'hebrew', 'ךםןףץ'],
  ['plain', 'hebrew', 'אבגדהוזחטיכלמנסעפצקרשת'],
  ['plain', 'hebrew', 'לא'],
  ['plain', 'hebrew', 'ישראל'],
  ['plain', 'hebrew', 'מקף־מקף'],
  ['plain', 'hebrew', 'ש״ח'],
  ['plain', 'hebrew', 'צה״ל'],
  ['plain', 'hebrew', 'וואו'],
  ['marks', 'hebrew', 'שָׁלוֹם'],
  ['marks', 'hebrew', 'בְּרֵאשִׁית'],
  ['marks', 'hebrew', 'בְּרֵאשִׁ֖ית'],
  ['marks', 'hebrew', 'אֱלֹהִים'],
  ['marks', 'hebrew', 'שִׁמְךָ'],
  ['marks', 'hebrew', 'עִבְרִית'],
  ['marks', 'hebrew', 'וַיְהִי'],
  ['marks', 'hebrew', 'הָאָרֶץ'],
];

/** A shaped glyph as the fixture states it. */
const glyph = (id, advance, dx, dy) => ({ id, advance, dx, dy });

function withFontkit(font, text, spec) {
  try {
    const run = font.layout(text, undefined, spec.script, spec.language, 'rtl');
    return {
      glyphs: run.glyphs.map((g, i) => glyph(g.id, run.positions[i].xAdvance, run.positions[i].xOffset, run.positions[i].yOffset)),
    };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** What differs, in a line: the glyph ids, the advances, or the offsets. */
function differs(reference, kit) {
  if (kit.error) return `fontkit threw: ${kit.error}`;
  const a = reference.glyphs;
  const b = kit.glyphs;
  if (a.length !== b.length) return `glyph count ${a.length} (HarfBuzz) vs ${b.length} (fontkit)`;
  const parts = [];
  if (a.some((g, i) => g.id !== b[i].id)) parts.push('glyph ids');
  if (a.some((g, i) => g.advance !== b[i].advance)) parts.push('advances');
  if (a.some((g, i) => g.dx !== b[i].dx || g.dy !== b[i].dy)) parts.push('offsets');
  return parts.length === 0 ? 'unknown' : parts.join(', ');
}

/** HarfBuzz and fontkit on one text, and whether they agree. */
function compare(hb, engine, spec, text) {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.setDirection(hb.Direction.RTL);
  buffer.setScript(spec.hbScript);
  buffer.setLanguage(spec.language);
  hb.shape(engine.hbFont, buffer);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();
  // HarfBuzz returns an RTL run in visual order, left to right as drawn.
  const reference = { glyphs: infos.map((info, i) => glyph(info.codepoint, positions[i].xAdvance, positions[i].xOffset, positions[i].yOffset)) };
  const kit = withFontkit(engine.font, text, spec);
  const same = JSON.stringify(reference) === JSON.stringify(kit);
  return { harfbuzz: reference, fontkit: kit, same, ...(same ? {} : { differs: differs(reference, kit) }) };
}

async function main() {
  const location = process.env.HARFBUZZJS;
  if (!location) throw new Error('set HARFBUZZJS to the harfbuzzjs dist/index.mjs of a scratch install (see the header)');
  const hb = await import(pathToFileURL(location).href);
  const engines = {};
  for (const [name, spec] of Object.entries(FONTS)) {
    const bytes = readFileSync(root(spec.file));
    const font = fontkit.create(bytes);
    const face = new hb.Face(new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    engines[name] = { font, hbFont: new hb.Font(face), upem: font.unitsPerEm };
  }
  const samples = [];
  for (const [category, name, text] of SAMPLES) {
    const spec = FONTS[name];
    const result = compare(hb, engines[name], spec, text);
    // The mark policy leaves marks out of the shaped text, so the text without its marks is compared too.
    const bare = text.replace(/\p{Mn}/gu, '');
    samples.push({
      category,
      font: name,
      text,
      codePoints: [...text].map((ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')),
      ...result,
      ...(category === 'marks' ? { withoutMarks: { text: bare, ...compare(hb, engines[name], spec, bare) } } : {}),
    });
  }
  const golden = {
    note: 'Generated by scripts/shaping-spike.mjs. harfbuzz is the reference (harfbuzzjs 1.6.3); fontkit is @pdf-lib/fontkit 1.1.1. Glyphs are listed left to right as drawn; advance and offsets are in font units.',
    fonts: Object.fromEntries(Object.entries(FONTS).map(([name, spec]) => [name, { file: spec.file, unitsPerEm: engines[name].upem }])),
    samples,
  };
  writeFileSync(new URL('../test/fixtures/shaping/golden.json', import.meta.url), `${JSON.stringify(golden, null, 1)}\n`);
  const summary = {};
  for (const sample of samples) {
    const key = `${sample.font}/${sample.category}`;
    summary[key] ??= { samples: 0, same: 0, threw: 0 };
    summary[key].samples += 1;
    if (sample.same) summary[key].same += 1;
    if (sample.fontkit.error) summary[key].threw += 1;
  }
  console.log(JSON.stringify(summary, null, 1));
  for (const sample of samples.filter((s) => !s.same)) console.log(sample.font, sample.category, sample.text, '->', sample.differs);
  const bare = samples.filter((s) => s.withoutMarks);
  console.log(`without marks: ${bare.filter((s) => s.withoutMarks.same).length} of ${bare.length} agree`);
}

await main();
