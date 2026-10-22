/**
 * CJK text in the screenplay PDF (screenplay.md §5.3): the grid width rule, the line breaks between CJK characters, the
 * Noto Sans Mono CJK SC fallback subset, the text a reader extracts, and the Latin-only file that stays as it was.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fallbackCovers } from '@caotang/pdf-fonts';
import * as fontkitModule from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import type { FlatBlock } from '../src/index.js';
import {
  breakBetween,
  charColumns,
  createPdfRenderer,
  drawPdf,
  importFountainScript,
  layoutPdf,
  loadCjkFallback,
  loadCourierPrime,
  paginate,
  parseFountain,
  textColumns,
  LAYOUT,
} from '../src/index.js';
import { SCRIPT_ONE_ACT, SCRIPT_WITH_TITLE_PAGE, text } from './fixtures/corpus.js';
import { LOADERS, sourceCjk } from './fixtures/fonts.js';

const fontkit = ((fontkitModule as unknown as { default?: typeof fontkitModule }).default ?? fontkitModule) as typeof fontkitModule;

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const linesOf = (source: string) => paginate(parseFountain(source).elements).flatMap((page) => page.lines);

const CHINESE = text(
  'INT. 草堂 - NIGHT',
  '',
  '杜甫坐在窗前，灯火摇曳。他提笔写下第一行诗，又停了下来。窗外的风吹动竹叶，声音很轻。',
  '',
  'LI BAI',
  '你还没睡？明月已经升到山顶了。我们出去走走吧。',
);

const JAPANESE = text('INT. 東京のアパート - DAY', '', 'ユキはカーテンを開ける。朝の光が部屋に差し込む。', '', 'YUKI', '(小声で)', 'おはよう。今日は雨が降らないといいね。');

const KOREAN = text('EXT. 서울 거리 - DAY', '', '민준이 버스 정류장에서 기다린다.', '', 'MINJUN', '안녕하세요! 오늘 날씨가 정말 좋네요. 같이 커피 마실래요?');

const MIXED = text('INT. CAFÉ - DAY', '', 'Mixed text: Café 草堂 with 한글 and かな, then \uE000 and ꙮ.');

/**
 * The text a reader extracts from the file: each Tj's string through the font it is set in (WinAnsi for F1, the
 * ToUnicode map for F2), the runs of one baseline in x order. Enough of a PDF reader for the files this writer makes.
 */
function extract(pdf: string): string[] {
  const map = new Map<string, string>();
  for (const m of pdf.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) {
    const units = (m[2] ?? '').match(/.{4}/g)?.map((h) => parseInt(h, 16)) ?? [];
    map.set(m[1] ?? '', String.fromCharCode(...units));
  }
  const rows = new Map<string, { x: number; text: string }[]>();
  let page = 0;
  for (const stream of pdf.matchAll(/stream\nBT\n([\s\S]*?)\nET\nendstream/g)) {
    page += 1;
    let font = 'F1';
    let x = 0;
    let y = '';
    for (const op of (stream[1] ?? '').split('\n')) {
      const tf = /^\/(F\d) 12 Tf$/.exec(op);
      const tm = /^1 0 0 1 (\S+) (\S+) Tm$/.exec(op);
      if (tf !== null) font = tf[1] ?? 'F1';
      else if (tm !== null) {
        x = Number(tm[1]);
        y = `${page}:${tm[2]}`;
      } else if (op.endsWith(' Tj')) {
        const body = op.slice(0, -3);
        const textOf =
          font === 'F2'
            ? (body.slice(1, -1).match(/.{4}/g) ?? []).map((cid) => map.get(cid) ?? '\uFFFD').join('')
            : body
                .slice(1, -1)
                .replace(/\\([()\\])/g, '$1')
                .replace(/\\(\d{3})/g, (_m, oct: string) => new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(oct, 8)])));
        const row = rows.get(y) ?? [];
        row.push({ x, text: textOf });
        rows.set(y, row);
      }
    }
  }
  return [...rows.values()].map((row) => row.sort((a, b) => a.x - b.x).map((run) => run.text).join(''));
}

async function cjkPdf(source: string, title = 'T'): Promise<string> {
  const blob = await createPdfRenderer(LOADERS).emit(blocksOf(source), { title });
  return decode(new Uint8Array(await blob.arrayBuffer()));
}

describe('the grid width rule', () => {
  it('gives a CJK character two columns and every other character one', () => {
    for (const ch of ['草', 'あ', 'ア', '한', '，', '。', '「', 'Ａ', '　', '𠀋']) expect(charColumns(ch), ch).toBe(2);
    for (const ch of ['a', 'É', '—', '“', 'ж', 'λ', 'ｱ', '?']) expect(charColumns(ch), ch).toBe(1);
    expect(textColumns('INT. 草堂 - DAY')).toBe(15);
    expect(textColumns('Café')).toBe(4);
  });

  it('breaks between Chinese or Japanese characters, but not before a closing mark or after an opening one', () => {
    expect(breakBetween('草', '堂')).toBe(true);
    expect(breakBetween('は', 'カ')).toBe(true);
    expect(breakBetween('前', '，')).toBe(false);
    expect(breakBetween('前', '。')).toBe(false);
    expect(breakBetween('カ', 'ー')).toBe(false);
    expect(breakBetween('「', '你')).toBe(false);
    expect(breakBetween('说', 'O')).toBe(true);
    expect(breakBetween('a', 'b')).toBe(false);
  });

  it('breaks Korean at spaces only, as Latin text', () => {
    expect(breakBetween('안', '녕')).toBe(false);
    expect(breakBetween('요', '!')).toBe(false);
  });
});

describe('paginate — CJK wrapping on the 10-cpi grid', () => {
  it('fills an action line to 60 columns: 30 Hanzi, broken with no space', () => {
    const action = linesOf(CHINESE).filter((line) => line.kind === 'action');
    expect(action.map((line) => line.text)).toEqual([
      '杜甫坐在窗前，灯火摇曳。他提笔写下第一行诗，又停了下来。窗外',
      '的风吹动竹叶，声音很轻。',
    ]);
    expect(textColumns(action[0]?.text ?? '')).toBe(60);
    expect(action[0]?.x).toBe(LAYOUT.marginLeft);
  });

  it('fills a dialogue line to its 35 columns, so 17 Hanzi, at the dialogue indent', () => {
    const dialogue = linesOf(CHINESE).filter((line) => line.kind === 'dialogue');
    expect(dialogue.map((line) => line.text)).toEqual(['你还没睡？明月已经升到山顶了。我们', '出去走走吧。']);
    for (const line of dialogue) expect(line.x).toBe(LAYOUT.marginLeft + LAYOUT.indent.dialogue * LAYOUT.charWidth);
  });

  it('never starts a line with a closing mark: the character before it moves down with it', () => {
    // 29 Hanzi and a full stop is 60 columns. One more Hanzi pushes the line over, and the full stop may not open the next.
    const source = text(`${'字'.repeat(30)}。后`);
    const lines = linesOf(source).map((line) => line.text);
    expect(lines).toEqual([`${'字'.repeat(29)}`, '字。后']);
  });

  it('wraps Korean at the spaces, each syllable two columns', () => {
    const dialogue = linesOf(KOREAN).filter((line) => line.kind === 'dialogue');
    expect(dialogue.map((line) => line.text)).toEqual(['안녕하세요! 오늘 날씨가 정말', '좋네요. 같이 커피 마실래요?']);
    for (const line of dialogue) expect(textColumns(line.text)).toBeLessThanOrEqual(35);
  });

  it('wraps mixed Latin and CJK by columns, and breaks between them without a space', () => {
    const lines = linesOf(text(`${'a'.repeat(55)} 草堂草堂草堂`)).map((line) => line.text);
    expect(lines).toEqual([`${'a'.repeat(55)} 草堂`, '草堂草堂']);
  });

  it('splits a CJK speech after a sentence end, which needs no space after it', () => {
    const filler = Array.from({ length: 25 }, (_, i) => `Filler ${i}.`).join('\n\n');
    const speech = Array.from({ length: 6 }, () => `${'说'.repeat(16)}。`).join('');
    const pages = paginate(parseFountain(`${filler}\n\nANNA\n${speech}\n`).elements);
    expect(pages).toHaveLength(2);
    const foot = pages[0]?.lines.filter((line) => line.kind === 'dialogue').at(-1);
    expect(foot?.text.endsWith('。')).toBe(true);
    expect(pages[0]?.lines.some((line) => line.text === '(MORE)')).toBe(true);
    expect(pages[1]?.lines[0]?.text).toBe("ANNA (CONT'D)");
  });

  it('rewraps a CJK speech to a dual-dialogue column without inserting spaces', () => {
    const source = text('INT. A - DAY', '', 'ANNA', '你还没睡？明月已经升到山顶了。我们出去走走吧。', '', 'BOB ^', 'Fine.');
    const left = linesOf(source).filter((line) => line.kind === 'dialogue' && line.x < 300);
    expect(left.map((line) => line.text).join('')).toBe('你还没睡？明月已经升到山顶了。我们出去走走吧。');
    for (const line of left) expect(textColumns(line.text)).toBeLessThanOrEqual(LAYOUT.dual.width.dialogue);
  });
});

describe('the CJK fallback font', () => {
  it('covers Hanzi, kana and Hangul', () => {
    for (const ch of '草堂東京のアパート서울거리，。「」') expect(fallbackCovers(ch), ch).toBe(true);
  });

  it('subsets to the glyphs the script uses, each drawn as the font draws it', async () => {
    const layout = layoutPdf(blocksOf(CHINESE + JAPANESE + KOREAN), { title: 'T' });
    const subset = await loadCjkFallback(layout, LOADERS.cjk);
    if (subset === undefined) throw new Error('no subset');
    const font = await sourceCjk();
    expect(subset.glyphs.size).toBe(layout.fallbackCharacters.length);
    expect(subset.baseFont).toMatch(/^[A-Z]{6}\+NotoSansMonoCJKsc-Regular$/);
    // TrueType outlines, so the subset is a glyf font and the CFF subset bugs of fontkit 1.1.1 do not apply.
    expect(['true', String.fromCharCode(0, 1, 0, 0)]).toContain(String.fromCharCode(...subset.program.subarray(0, 4)));
    // The subset read back through fontkit: every character's CID names a glyph whose outline is the source glyph's.
    const read = fontkit.create(subset.program as Buffer);
    for (const [ch, glyph] of subset.glyphs) {
      const expected = font.glyphForCodePoint(ch.codePointAt(0) ?? 0).path.toSVG();
      const entry = subset.entries[glyph.cid - 1];
      expect(read.getGlyph(entry?.gid ?? 0).path.toSVG(), ch).toBe(expected);
      expect(entry?.width, ch).toBe(charColumns(ch) * 600);
      expect(entry?.text, ch).toBe(ch);
    }
    // A subset, not the whole font: a few hundred KB at most against the font's 7 MB.
    expect(subset.program.length).toBeLessThan(400_000);
  });
});

describe('characters the CJK font draws with one glyph', () => {
  // ‧ U+2027 (one column) and ・ U+30FB (two), and ① U+2460 and ➀ U+2780: each pair is one glyph in Noto Sans Mono CJK SC.
  const SHARED = ['‧', '・', '①', '➀'];

  it('are one glyph in the font, so the test is about them', async () => {
    const font = await sourceCjk();
    const gid = (ch: string): number => font.glyphForCodePoint(ch.codePointAt(0) ?? 0).id;
    expect(gid('‧')).toBe(gid('・'));
    expect(gid('①')).toBe(gid('➀'));
    expect(SHARED.every(fallbackCovers)).toBe(true);
    expect([charColumns('‧'), charColumns('・')]).toEqual([1, 2]);
  });

  it('get a CID each, with each one’s own width and outline', async () => {
    const layout = layoutPdf(blocksOf(text('INT. ROOM - DAY', '', 'Dots ‧ and ・, circled ① and ➀.')), { title: 'T' });
    expect(layout.fallbackCharacters).toEqual(SHARED);
    const subset = await loadCjkFallback(layout, LOADERS.cjk);
    if (subset === undefined) throw new Error('no subset');
    const cids = SHARED.map((ch) => subset.glyphs.get(ch)?.cid);
    expect(new Set(cids).size).toBe(SHARED.length);
    for (const ch of SHARED) expect(subset.entries[(subset.glyphs.get(ch)?.cid ?? 0) - 1]?.width, ch).toBe(charColumns(ch) * 600);
    const font = await sourceCjk();
    const read = fontkit.create(subset.program as Buffer);
    for (const [ch, glyph] of subset.glyphs) {
      const entry = subset.entries[glyph.cid - 1];
      expect(read.getGlyph(entry?.gid ?? 0).path.toSVG(), ch).toBe(font.glyphForCodePoint(ch.codePointAt(0) ?? 0).path.toSVG());
    }
    // The glyph is stored once however many CIDs name it.
    expect(subset.entries[(subset.glyphs.get('‧')?.cid ?? 0) - 1]?.gid).toBe(subset.entries[(subset.glyphs.get('・')?.cid ?? 0) - 1]?.gid);
  });

  it('copy out of the PDF as the characters that were typed', async () => {
    const pdf = await cjkPdf(text('INT. ROOM - DAY', '', 'Dots ‧ and ・, circled ① and ➀.'));
    expect(extract(pdf)).toContain('Dots ‧ and ・, circled ① and ➀.');
    for (const ch of SHARED) expect(pdf, ch).toContain(`<${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>\n`);
  });
});

describe('the PDF with CJK text', () => {
  it('prints Chinese action and dialogue as text a reader extracts', async () => {
    const pdf = await cjkPdf(CHINESE);
    const lines = extract(pdf);
    expect(lines).toContain('INT. 草堂 - NIGHT');
    expect(lines).toContain('杜甫坐在窗前，灯火摇曳。他提笔写下第一行诗，又停了下来。窗外');
    expect(lines).toContain('你还没睡？明月已经升到山顶了。我们');
    expect(pdf).toContain('/Subtype /Type0');
    expect(pdf).toContain('/Encoding /Identity-H');
    // TrueType outlines (CIDFontType2, FontFile2) with a CIDToGIDMap, as the emoji font is written.
    expect(pdf).toContain('/Subtype /CIDFontType2');
    expect(pdf).toContain('/FontFile2 ');
    expect(pdf).toContain('/CIDToGIDMap ');
    expect(pdf).not.toContain('CIDFontType0');
    expect(pdf).toContain('/ToUnicode ');
  });

  it('prints Japanese, a parenthetical included', async () => {
    const lines = extract(await cjkPdf(JAPANESE));
    expect(lines).toContain('ユキはカーテンを開ける。朝の光が部屋に差し込む。');
    expect(lines).toContain('(小声で)');
    expect(lines).toContain('おはよう。今日は雨が降らないといい');
    expect(lines).toContain('ね。');
  });

  it('prints Korean', async () => {
    const lines = extract(await cjkPdf(KOREAN));
    expect(lines).toContain('EXT. 서울 거리 - DAY');
    expect(lines).toContain('안녕하세요! 오늘 날씨가 정말');
  });

  it('places each run of mixed text at its grid column, Latin in Courier Prime and CJK in the fallback', async () => {
    const pdf = await cjkPdf(MIXED);
    expect(extract(pdf)).toContain('Mixed text: Café 草堂 with 한글 and かな, then ? and ?.');
    // "Mixed text: Café " is 17 columns, so 草 starts 17 × 7.2 points right of the margin.
    expect(pdf).toContain(`1 0 0 1 ${(LAYOUT.marginLeft + 17 * 7.2).toFixed(2)} `);
    expect(pdf).toContain('/F2 12 Tf');
  });

  it('prints a character neither font has as "?", and the log names it', () => {
    const layout = layoutPdf(blocksOf(MIXED), { title: 'T' });
    expect(layout.notes).toEqual(['pdf: neither Courier Prime nor the CJK or emoji fallback font can print these 2 characters, so they are printed as "?": \uE000 ꙮ']);
    expect(layout.fallbackCharacters).toEqual(['草', '堂', '한', '글', 'か', 'な']);
  });

  it('writes a CJK title into the info dictionary as UTF-16', async () => {
    expect(await cjkPdf(CHINESE, '草堂')).toContain('/Title <FEFF83495802>');
  });

  it('keeps every byte ASCII and every xref offset exact with both fonts in the file', async () => {
    const pdf = await cjkPdf(CHINESE + JAPANESE + KOREAN);
    expect([...pdf].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
    const xref = Number(/startxref\n(\d+)\n/.exec(pdf)?.[1]);
    const count = Number(/^0 (\d+)$/m.exec(pdf.slice(xref, xref + 40))?.[1]);
    const rows = pdf.slice(xref).split('\n');
    for (let object = 1; object < count; object++) {
      const offset = Number(rows[2 + object]?.slice(0, 10));
      expect(pdf.slice(offset).startsWith(`${object} 0 obj\n`), `object ${object}`).toBe(true);
    }
  });
});

describe('a Latin-only script', () => {
  // The SHA-256 of each file as the writer made it before the CJK fallback existed (commit 32e3ed0).
  const BEFORE: readonly [string, string, boolean, Record<string, unknown>][] = [
    ['one act, Courier Prime', SCRIPT_ONE_ACT, true, {}],
    ['one act, base-14 Courier', SCRIPT_ONE_ACT, false, {}],
    ['title page and scene numbers', SCRIPT_WITH_TITLE_PAGE, true, { sceneNumbers: 'both', titlePage: true }],
  ];
  const HASHES = [
    '993f7c9ad93c53ad71daf2dc120a199b1150e481eff41e057870efd966c9b46e',
    '7d412410e99b12128d61b1eb5c6305e00f449dfc4be0da3a459be05bc52a48d0',
    '21f4fe6591176c4e933a473d0efb7d2dff1d2f1f099c6b2343269d77ddc03748',
  ];

  it.each(BEFORE.map((row, i) => [...row, HASHES[i]] as const))('is byte for byte the file it was: %s', async (_name, source, embed, opts, hash) => {
    const layout = layoutPdf(blocksOf(source), { title: 'T', author: 'A', ...opts });
    const bytes = drawPdf(layout, embed ? await loadCourierPrime() : undefined, await loadCjkFallback(layout, LOADERS.cjk));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
  });

  it('needs no fallback, so none is loaded and the file names one font', async () => {
    const layout = layoutPdf(blocksOf(text('INT. CAFÉ - DAY', '', 'Crème brûlée — “twice”.')), { title: 'T' });
    expect(layout.fallbackCharacters).toEqual([]);
    expect(await loadCjkFallback(layout, LOADERS.cjk)).toBeUndefined();
    const pdf = await cjkPdf(text('INT. CAFÉ - DAY', '', 'Crème brûlée — “twice”.'));
    expect(pdf).not.toContain('/F2');
    expect(pdf).not.toContain('NotoSans');
  });

  it('reaches the fallback module only by the dynamic import in render-pdf.ts', () => {
    const source = readFileSync(new URL('../src/render-pdf.ts', import.meta.url), 'utf8');
    expect(source).toContain("await import('./cjk-font.js')");
    expect(source).not.toMatch(/^import .*cjk-font/m);
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).not.toContain('cjk-font');
  });
});
