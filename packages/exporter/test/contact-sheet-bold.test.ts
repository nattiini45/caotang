/**
 * Bold CJK and emoji in the contact sheet (storyboard.md §6, embolden.ts in @caotang/pdf-fonts): the header title, the page label and the number chip are
 * set in bold. With `loadBoldFallbackFont` a CJK run there is set in Noto Sans Mono CJK SC Bold (#253); without it, or when the Bold cannot
 * be read, and for monochrome emoji always (Noto Emoji has no Bold), the run is drawn with the stroke (`2 Tr`) and a character spacing.
 * These tests read the content stream back: where the Bold and the stroke are, that the stroke never leaks past its run, that the width
 * the emitter cuts to is the width it draws, that the text a reader copies is the same, and that a sheet with no CJK in a bold place is
 * the same file with or without the Bold.
 */

import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { EMBOLDEN_RATIO } from '@caotang/pdf-fonts';
import type { FontLoader } from '@caotang/pdf-fonts';
import { loadCjkBoldFontInNode, loadCjkFontInNode, loadColourEmojiInNode, loadEmojiFontInNode } from '@caotang/pdf-fonts/node-loader';
import { planContactSheet, type SheetPlan } from '@caotang/storyboard';
import { CONTACT_SHEET_HEADER, drawContactSheet } from '../src/index.js';
import { COMPILED_AT } from './fixture.js';
import { makeMediaProject } from './media-fixture.js';

interface Texts {
  readonly title?: string;
  readonly label?: string;
  readonly chip?: string;
  readonly action?: string;
}

/** The media project's first page with the given texts put in its title, page label, first chip and first action line. */
function planWith(texts: Texts): SheetPlan {
  const { plan } = planContactSheet(makeMediaProject(), ['manuscript'], () => ({ drawn: false, note: 'none' }), { headerTemplate: CONTACT_SHEET_HEADER });
  const page = plan.pages[0];
  const card = page?.cards[0];
  if (page === undefined || card === undefined) throw new Error('the project plans no card');
  const action = card.action[0];
  return {
    ...plan,
    pages: [
      {
        ...page,
        title: { ...page.title, text: texts.title ?? page.title.text },
        pageLabel: { ...page.pageLabel, text: texts.label ?? page.pageLabel.text },
        cards: [
          {
            ...card,
            // The plan sizes a chip for its number; a longer chip text needs room to be drawn.
            chip: { ...card.chip, width: 60 },
            chipText: { ...card.chipText, text: texts.chip ?? card.chipText.text },
            action: action === undefined || texts.action === undefined ? card.action : [{ ...action, text: texts.action }, ...card.action.slice(1)],
          },
          ...page.cards.slice(1),
        ],
      },
      ...plan.pages.slice(1),
    ],
  };
}

async function draw(plan: SheetPlan, options: { colourEmoji?: boolean; loadBoldFallbackFont?: FontLoader } = {}) {
  const drawn = await drawContactSheet({
    plan,
    pictures: new Map(),
    readPicture: async () => null,
    title: 'T',
    at: new Date(COMPILED_AT),
    loadFallbackFont: loadCjkFontInNode,
    loadEmojiFont: loadEmojiFontInNode,
    loadColourEmoji: loadColourEmojiInNode,
    ...options,
  });
  const pdf = await PDFDocument.load(drawn.contents, { updateMetadata: false });
  const contents = pdf.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
  const content = streams.map((stream) => (stream instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()) : '')).join('\n');
  return { pdf, lines: content.split('\n'), contents: drawn.contents, notes: drawn.notes };
}

/** The text each Type 0 font's ToUnicode map gives back, in the order of the file's objects, less the entries that stand for no text. */
function copied(pdf: PDFDocument): string {
  let text = '';
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
    const stream = pdf.context.lookup(object.get(PDFName.of('ToUnicode')));
    if (!(stream instanceof PDFRawStream)) continue;
    for (const match of new TextDecoder().decode(decodePDFRawStream(stream).decode()).matchAll(/<[0-9a-fA-F]+>\s*<([0-9a-fA-F]+)>/g)) {
      const units = (match[1] ?? '').match(/.{4}/g) ?? [];
      text += String.fromCharCode(...units.map((unit) => Number.parseInt(unit, 16)).filter((unit) => unit !== 0xffff));
    }
  }
  return text;
}

/** The `Tj` lines drawn while a `2 Tr` is in force: a `q` clears the mode, as the writer's push of the graphics state does. */
function strokedRuns(lines: readonly string[]): string[] {
  const runs: string[] = [];
  let stroked = false;
  for (const line of lines) {
    if (line === 'q') stroked = false;
    if (line.endsWith(' Tr')) stroked = line === '2 Tr';
    if (stroked && line.endsWith(' Tj')) runs.push(line);
  }
  return runs;
}

/** The glyph codes of each run set in the CJK font (the Regular, or with `resource` another), in order, whether or not it is stroked. */
function cjkRuns(lines: readonly string[], resource = 'NotoCjk'): string[] {
  const runs: string[] = [];
  let font = '';
  for (const line of lines) {
    if (line.endsWith(' Tf')) font = line;
    else if (line.endsWith(' Tj') && new RegExp(`^/${resource}-?\\d* `).test(font)) runs.push(line);
  }
  return runs;
}

/** The base fonts of a file's Type 0 fonts, in the order of its objects. */
function type0Fonts(pdf: PDFDocument): string[] {
  const names: string[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.get(PDFName.of('Subtype')) === PDFName.of('Type0')) names.push(String(object.get(PDFName.of('BaseFont'))));
  }
  return names;
}

describe('bold CJK and emoji in the contact sheet', () => {
  it('strokes CJK in the title, the page label and the chip, in the ink of each, and not in a regular line', async () => {
    const { lines } = await draw(planWith({ title: '第一场', label: '第 1 页', chip: '一', action: '草堂的早晨' }));
    // The label holds two CJK runs, 第 and 页, with the digit between them in Helvetica.
    expect(lines.filter((line) => line === '2 Tr')).toHaveLength(4);
    expect(strokedRuns(lines)).toHaveLength(4);
    // Each stroked run's stroke colour is its fill: the title in ink, the label muted, the chip's text white.
    for (const ink of ['0.1 0.1 0.1', '0.4 0.4 0.4', '1 1 1']) {
      expect(lines).toContain(`${ink} rg`);
      expect(lines).toContain(`${ink} RG`);
    }
    expect(lines).toContain(`${EMBOLDEN_RATIO * 11} w`);
    expect(lines).toContain('1 j');
    expect(lines).toContain(`${EMBOLDEN_RATIO * 11} Tc`);
    // The action line is in the CJK font too, and is not among the stroked runs.
    expect(cjkRuns(lines)).toHaveLength(5);
  });

  it('keeps the stroke inside its run: pushed before it and popped after it, so the Helvetica text after has none', async () => {
    const { lines } = await draw(planWith({ title: '第一场 Lighthouse', label: '第 1 页', chip: '一' }));
    lines.forEach((line, index) => {
      if (line !== '2 Tr') return;
      const end = lines.indexOf('ET', index);
      expect(lines[end + 1]).toBe('Q');
      expect(lines.slice(index, end)).not.toContain('BT');
    });
    expect(lines.filter((line) => line === 'q')).toHaveLength(lines.filter((line) => line === 'Q').length);
    // After the last bold run, the page's remaining text is Helvetica with none of the state set.
    const last = lines.lastIndexOf('2 Tr');
    const rest = lines.slice(lines.indexOf('Q', last));
    expect(rest.some((line) => line.endsWith(' Tr') || line.endsWith(' Tc') || line === '1 j')).toBe(false);
  });

  it('strokes the monochrome emoji of a bold run and not a colour emoji, which is a picture', async () => {
    const plan = planWith({ chip: '一🎬' });
    const mono = await draw(plan, { colourEmoji: false });
    expect(strokedRuns(mono.lines)).toHaveLength(2);
    const colour = await draw(plan, { colourEmoji: true });
    // Only the 一 is stroked; the 🎬 is a Type 3 glyph in a push and pop of its own, with no mode and no spacing.
    expect(strokedRuns(colour.lines)).toHaveLength(1);
    const type3 = colour.lines.findIndex((line) => line.startsWith('/CE1'));
    expect(type3).toBeGreaterThan(0);
    const around = colour.lines.slice(colour.lines.lastIndexOf('q', type3), colour.lines.indexOf('Q', type3));
    expect(around.some((line) => line.endsWith(' Tr') || line.endsWith(' Tc') || line.endsWith(' w'))).toBe(false);
  });

  it('draws the regular run’s glyphs and copies the regular run’s text', async () => {
    const text = '第一场 草堂 🎬';
    const bold = await draw(planWith({ title: text }));
    const regular = await draw(planWith({ action: text }));
    expect(copied(bold.pdf)).toBe(copied(regular.pdf));
    expect(copied(bold.pdf)).toBe('第一场草堂🎬');
    expect(cjkRuns(bold.lines)).toEqual(cjkRuns(regular.lines));
    // 第一场, 草堂 and 🎬 are three runs, with a space of Helvetica between each.
    expect(strokedRuns(bold.lines)).toHaveLength(3);
    expect(strokedRuns(regular.lines)).toHaveLength(0);
  });

  it('measures what it draws: a long CJK title is cut with an ellipsis inside its box, the spacing counted', async () => {
    const plan = planWith({ title: '山'.repeat(120) });
    const { lines } = await draw(plan);
    const run = strokedRuns(lines)[0] ?? '';
    const count = (run.match(/^<([0-9A-F]+)> Tj$/)?.[1] ?? '').length / 4;
    const page = plan.pages[0];
    if (page === undefined) throw new Error('no page');
    const bold = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold);
    const size = page.title.fontSize;
    const room = plan.geometry.width - 2 * plan.geometry.margin - bold.widthOfTextAtSize(page.pageLabel.text, page.pageLabel.fontSize) - 12;
    // A 山 is one em wide and the stroke adds one spacing after it; the ellipsis is Helvetica-Bold's.
    const each = size * (1 + EMBOLDEN_RATIO);
    const ellipsis = bold.widthOfTextAtSize('…', size);
    expect(count).toBeGreaterThan(10);
    expect(count * each + ellipsis).toBeLessThanOrEqual(room + 1e-6);
    expect((count + 1) * each + ellipsis).toBeGreaterThan(room);
  });

  it('draws no stroke when no CJK or emoji is in a bold place, in a sheet with them elsewhere or none at all', async () => {
    const elsewhere = await draw(planWith({ title: 'The Lighthouse Keeper', action: '草堂 🎬 at dawn' }));
    expect(elsewhere.lines.some((line) => line.endsWith(' Tr') || line.endsWith(' Tc') || line === '1 j')).toBe(false);
    const latin = await draw(planWith({}));
    expect(latin.lines.some((line) => line.endsWith(' Tr'))).toBe(false);
  });
});

describe('bold CJK in the Bold face (#253)', () => {
  const withBold = { loadBoldFallbackFont: loadCjkBoldFontInNode };

  it('sets CJK in the title, the page label and the chip in the Bold, with no stroke, and a regular line in the Regular', async () => {
    const { lines, pdf, notes } = await draw(planWith({ title: '第一场', label: '第 1 页', chip: '一', action: '草堂的早晨' }), withBold);
    // The label holds two CJK runs, 第 and 页, with the digit between them in Helvetica.
    expect(cjkRuns(lines, 'NotoCjkBold')).toHaveLength(4);
    expect(cjkRuns(lines)).toHaveLength(1);
    expect(strokedRuns(lines)).toHaveLength(0);
    expect(lines.some((line) => line.endsWith(' Tr') || line.endsWith(' Tc') || line === '1 j')).toBe(false);
    expect(type0Fonts(pdf).sort()).toEqual(['/CAOTCB+NotoSansMonoCJKsc-Bold', '/CAOTCJ+NotoSansMonoCJKsc-Regular']);
    expect(notes).toContain('contact sheet: bold text outside Latin script is set in Noto Sans Mono CJK SC Bold, embedded with only the glyphs it uses');
  });

  it('copies the same text as the Regular run and as the stroked run', async () => {
    const text = '第一场 草堂';
    const inBold = await draw(planWith({ title: text }), withBold);
    const stroked = await draw(planWith({ title: text }));
    expect(copied(inBold.pdf)).toBe('第一场草堂');
    expect(copied(stroked.pdf)).toBe('第一场草堂');
  });

  it('keeps the stroke for monochrome emoji in a bold place, which Noto Emoji has no Bold for', async () => {
    const { lines } = await draw(planWith({ chip: '一🎬' }), { ...withBold, colourEmoji: false });
    expect(cjkRuns(lines, 'NotoCjkBold')).toHaveLength(1);
    expect(strokedRuns(lines)).toHaveLength(1);
  });

  it('reads the Bold only when a bold place holds CJK, so such a sheet is the same file with or without it', async () => {
    let calls = 0;
    const counting = Object.assign(async () => {
      calls += 1;
      return loadCjkBoldFontInNode();
    }, { common: async () => {
      calls += 1;
      return loadCjkBoldFontInNode.common();
    } });
    for (const texts of [{ title: 'The Lighthouse Keeper', action: '草堂 🎬 at dawn' }, {}]) {
      const plan = planWith(texts);
      const a = await draw(plan, { loadBoldFallbackFont: counting });
      const b = await draw(plan);
      expect(Buffer.from(a.contents).equals(Buffer.from(b.contents))).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it('reads the Bold’s common file for common characters and its full file for a rare one', async () => {
    const read: string[] = [];
    const tracking = Object.assign(async () => {
      read.push('full');
      return loadCjkBoldFontInNode();
    }, { common: async () => {
      read.push('common');
      return loadCjkBoldFontInNode.common();
    } });
    await draw(planWith({ title: '第一场' }), { loadBoldFallbackFont: tracking });
    // 龘 is only in the full file, in an action line (a regular place): the Bold is still read from its common file.
    await draw(planWith({ title: '第一场', action: '龘' }), { loadBoldFallbackFont: tracking });
    await draw(planWith({ title: '龘' }), { loadBoldFallbackFont: tracking });
    expect(read).toEqual(['common', 'common', 'full']);
  }, 60_000);

  it('falls back to the stroked Regular when the Bold cannot be read, and says so', async () => {
    const failing = async (): Promise<Uint8Array> => {
      throw new Error('offline');
    };
    const plan = planWith({ title: '第一场', label: '第 1 页', chip: '一' });
    const { lines, notes, contents } = await draw(plan, { loadBoldFallbackFont: failing });
    expect(strokedRuns(lines)).toHaveLength(4);
    expect(cjkRuns(lines, 'NotoCjkBold')).toHaveLength(0);
    expect(notes).toContain('contact sheet: the bold fallback font could not be read (offline), so bold text outside Latin script is the regular weight thickened by a stroke');
    // The drawing is the stroked sheet's; only the log differs.
    expect(Buffer.from(contents).equals(Buffer.from((await draw(plan)).contents))).toBe(true);
  });

  it('measures what it draws: a long CJK title is cut with an ellipsis inside its box, at the Bold’s advance and no spacing', async () => {
    const plan = planWith({ title: '山'.repeat(120) });
    const { lines } = await draw(plan, withBold);
    const run = cjkRuns(lines, 'NotoCjkBold')[0] ?? '';
    const count = (run.match(/^<([0-9A-F]+)> Tj$/)?.[1] ?? '').length / 4;
    const page = plan.pages[0];
    if (page === undefined) throw new Error('no page');
    const bold = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold);
    const size = page.title.fontSize;
    const room = plan.geometry.width - 2 * plan.geometry.margin - bold.widthOfTextAtSize(page.pageLabel.text, page.pageLabel.fontSize) - 12;
    // A 山 is one em wide in the Bold too; the ellipsis is Helvetica-Bold's.
    const ellipsis = bold.widthOfTextAtSize('…', size);
    expect(count).toBeGreaterThan(10);
    expect(count * size + ellipsis).toBeLessThanOrEqual(room + 1e-6);
    expect((count + 1) * size + ellipsis).toBeGreaterThan(room);
  });
});
