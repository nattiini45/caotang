/**
 * The contact sheet — storyboard.md §6. The page plan is the part with structure, so most of this file checks
 * positions: what fits on a page, what sits inside the margins, what overlaps, and in what order cards read.
 * The PDF port is exercised with a stand-in emitter: no package wires one into `ContactSheetPdfRenderer`; the PDF the app writes is the exporter's (`contact-sheet-pdf`, which draws the plan over pdf-lib itself), tested there.
 */

import { describe, expect, it } from 'vitest';

import {
  ContactSheetPdfRenderer,
  SHEET_LAYOUT,
  planContactSheet,
  sheetSpecRowOf,
  specRowOf,
  sheetSummaryOf,
  addShotNode,
  fillTemplate,
  importImage,
  isWide,
  measureText,
  paperCaptionOf,
  shotsInBinderOrder,
  paginate,
  wrapText,
  type ContactSheetDocument,
  type PlacedCard,
  type SheetCard,
  type SheetPlan,
} from '../src/index.js';

import { addFolder } from '@caotang/store';

import { setNodeKind } from '../src/nodes.js';
import { CountingFs, NOW, buildFixture, pngBytes } from './fixtures.js';

const MARGIN = SHEET_LAYOUT.margin;
const EPS = 1e-6;

function card(index: number, overrides: Partial<SheetCard> = {}): SheetCard {
  return {
    shotId: `n_CARD${String(index).padStart(5, '0')}`,
    shotNumber: index + 1,
    specRow: 'WS · eye',
    action: `Action ${index + 1}.`,
    image: true,
    placeholder: 'No image',
    ...overrides,
  };
}

function cards(count: number): SheetCard[] {
  return Array.from({ length: count }, (_, index) => card(index));
}

/** Every card on every page, in the order the plan lists them. */
function allCards(plan: SheetPlan): PlacedCard[] {
  return plan.pages.flatMap((page) => [...page.cards]);
}

function intersects(a: PlacedCard['frame'], b: PlacedCard['frame']): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('capacity: how many cards fit a page', () => {
  it('fits 15 cards on an A4 page of three columns, by the layout’s arithmetic', () => {
    const plan = paginate(cards(1));
    expect(plan.pageSize).toBe('A4');
    expect(plan.cardsPerPage).toBe(15);
    expect(plan.cardWidth).toBeCloseTo((595.28 - 2 * 36 - 2 * 12) / 3, 6);
  });

  it('keeps 15 cards on A4 although the spec row takes two lines: the card is 136.62 pt tall and the fifth row ends inside the page', () => {
    const plan = paginate(cards(1));
    const { margin, headerHeight, gutter } = SHEET_LAYOUT;
    expect(plan.cardHeight).toBeCloseTo(plan.cardWidth * (9 / 16) + 3 + 2 * 8.5 + 2 * 10 + 3, 6);
    expect(plan.cardHeight).toBeCloseTo(136.62, 2);
    // Five rows end at or above the bottom margin, and a sixth does not fit.
    const bottom = 841.89 - margin;
    expect(margin + headerHeight + 5 * plan.cardHeight + 4 * gutter).toBeLessThanOrEqual(bottom);
    expect(margin + headerHeight + 6 * plan.cardHeight + 5 * gutter).toBeGreaterThan(bottom);
  });

  it('fits 12 cards on a Letter page of three columns, which is shorter', () => {
    expect(paginate(cards(1), { pageSize: 'Letter' }).cardsPerPage).toBe(12);
  });

  it('refuses a column count outside 1 to 6, and a fractional one', () => {
    expect(() => paginate(cards(1), { columns: 0 })).toThrow('from 1 to 6');
    expect(() => paginate(cards(1), { columns: 7 })).toThrow('from 1 to 6');
    expect(() => paginate(cards(1), { columns: 2.5 })).toThrow('from 1 to 6');
  });
});

describe('page count', () => {
  it('is one page for an empty sheet, which carries a note rather than nothing', () => {
    const plan = paginate([]);
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]?.cards).toEqual([]);
    expect(plan.pages[0]?.emptyNote?.text).toBe('No shots yet.');
    expect(plan.pages[0]?.pageLabel.text).toBe('Page 1 of 1');
  });

  it('is one page when the cards exactly fill it, and two when one card more does not fit', () => {
    expect(paginate(cards(15)).pages).toHaveLength(1);
    expect(paginate(cards(16)).pages).toHaveLength(2);
    expect(paginate(cards(31)).pages).toHaveLength(3);
  });

  it('puts every card on exactly one page, in the order given', () => {
    const input = cards(33);
    const plan = paginate(input);
    expect(allCards(plan).map((placed) => placed.shotId)).toEqual(input.map((item) => item.shotId));
  });

  it('labels each page with its number and the count, right-aligned in the header', () => {
    const plan = paginate(cards(20));
    expect(plan.pages.map((page) => page.pageLabel.text)).toEqual(['Page 1 of 2', 'Page 2 of 2']);
    const label = plan.pages[0]?.pageLabel;
    expect((label?.x ?? 0) + measureText(label?.text ?? '', SHEET_LAYOUT.headerFontSize)).toBeCloseTo(595.28 - MARGIN, 6);
  });
});

describe('placement: every card is inside the page, and no two cards overlap', () => {
  it('keeps every card and its picture within the margins and below the header', () => {
    const plan = paginate(cards(33), { pageSize: 'Letter' });
    const width = 612;
    const height = 792;
    for (const placed of allCards(plan)) {
      expect(placed.frame.x).toBeGreaterThanOrEqual(MARGIN - EPS);
      expect(placed.frame.x + placed.frame.width).toBeLessThanOrEqual(width - MARGIN + EPS);
      expect(placed.frame.y).toBeGreaterThanOrEqual(MARGIN + SHEET_LAYOUT.headerHeight - EPS);
      expect(placed.frame.y + placed.frame.height).toBeLessThanOrEqual(height - MARGIN + EPS);
      expect(placed.image.width).toBeCloseTo(placed.frame.width, 6);
    }
  });

  it('keeps the chip and the text inside the card', () => {
    for (const placed of allCards(paginate(cards(4)))) {
      expect(placed.chip.x).toBeGreaterThanOrEqual(placed.frame.x);
      expect(placed.chip.x + placed.chip.width).toBeLessThanOrEqual(placed.frame.x + placed.frame.width);
      for (const line of placed.action) expect(line.x + measureText(line.text, line.fontSize)).toBeLessThanOrEqual(placed.frame.x + placed.frame.width + EPS);
    }
  });

  it('never lets two cards on one page overlap', () => {
    for (const page of paginate(cards(31), { pageSize: 'A4' }).pages) {
      for (let i = 0; i < page.cards.length; i += 1) {
        for (let j = i + 1; j < page.cards.length; j += 1) {
          expect(intersects(page.cards[i]?.frame ?? { x: 0, y: 0, width: 0, height: 0 }, page.cards[j]?.frame ?? { x: 0, y: 0, width: 0, height: 0 })).toBe(false);
        }
      }
    }
  });

  it('reads left to right, then down, so the fourth card starts the second row', () => {
    const plan = paginate(cards(6));
    const [first, second, third, fourth] = plan.pages[0]?.cards ?? [];
    expect(first?.frame.x).toBeCloseTo(MARGIN, 6);
    expect(first?.frame.y).toBeCloseTo(MARGIN + SHEET_LAYOUT.headerHeight, 6);
    expect(second?.frame.x).toBeGreaterThan(first?.frame.x ?? 0);
    expect(second?.frame.y).toBeCloseTo(first?.frame.y ?? -1, 6);
    expect(third?.frame.x).toBeGreaterThan(second?.frame.x ?? 0);
    expect(fourth?.frame.x).toBeCloseTo(MARGIN, 6);
    expect(fourth?.frame.y).toBeCloseTo((first?.frame.y ?? 0) + plan.cardHeight + SHEET_LAYOUT.gutter, 6);
  });
});

describe('the text on a card', () => {
  it('shows the number on the chip and the spec row beneath the picture', () => {
    const placed = allCards(paginate([card(6, { specRow: 'CU · eye · 4 s' })]))[0];
    expect(placed?.chipText.text).toBe('7');
    expect(placed?.spec.map((line) => line.text)).toEqual(['CU · eye · 4 s']);
    expect(placed?.spec[0]?.y).toBeGreaterThan((placed?.image.y ?? 0) + (placed?.image.height ?? 0));
  });

  it('cuts a long action to the two lines the card has, with an ellipsis on the last', () => {
    const long = 'word '.repeat(200).trim();
    const placed = allCards(paginate([card(0, { action: long })]))[0];
    expect(placed?.action).toHaveLength(SHEET_LAYOUT.actionLines);
    expect(placed?.action[1]?.text.endsWith('…')).toBe(true);
    for (const line of placed?.action ?? []) expect(measureText(line.text, line.fontSize)).toBeLessThanOrEqual(placed?.frame.width ?? 0);
  });

  it('shows no action line for an empty action, and the card keeps its height', () => {
    const plan = paginate([card(0, { action: '' })]);
    const placed = allCards(plan)[0];
    expect(placed?.action).toEqual([]);
    expect(placed?.frame.height).toBeCloseTo(plan.cardHeight, 6);
  });

  it('cuts a spec row that is too long for its two lines, with an ellipsis on the second', () => {
    const placed = allCards(paginate([card(0, { specRow: 'x'.repeat(200) })]))[0];
    expect(placed?.spec).toHaveLength(SHEET_LAYOUT.specLines);
    expect(placed?.spec[1]?.text.endsWith('…')).toBe(true);
  });

  it('puts the longest all-set row in words on two lines with no ellipsis, on A4 and on Letter', () => {
    const row = sheetSpecRowOf({
      shotSize: 'MCU',
      cameraAngle: 'birds',
      cameraMovement: 'dolly-in',
      durationSec: 4,
      lens: '35mm',
      transition: 'match-on-action',
    });
    expect(row).toBe('Medium close-up (MCU) · Bird’s-eye view · Dolly in · 4 s · 35mm · Match on action');
    for (const pageSize of ['A4', 'Letter'] as const) {
      const plan = paginate([card(0, { specRow: row })], { pageSize });
      const placed = allCards(plan)[0];
      expect(placed?.spec).toHaveLength(2);
      expect(placed?.spec.map((line) => line.text).join(' ')).toBe(row);
      for (const line of placed?.spec ?? []) {
        expect(measureText(line.text, line.fontSize)).toBeLessThanOrEqual(plan.cardWidth + EPS);
      }
    }
  });

  it('sets the second spec line below the first and the action below both, inside the card', () => {
    const placed = allCards(paginate([card(0, { specRow: 'Medium close-up (MCU) · Bird’s-eye view · Dolly in · 4 s', action: 'one two three' })]))[0];
    const [first, second] = placed?.spec ?? [];
    expect(second?.y).toBeCloseTo((first?.y ?? 0) + SHEET_LAYOUT.specLineHeight, 6);
    expect(placed?.action[0]?.y).toBeGreaterThan((second?.y ?? 0) + SHEET_LAYOUT.specFontSize * 0.2);
    const frame = placed?.frame;
    const last = placed?.action[placed.action.length - 1] ?? second;
    expect(last?.y ?? 0).toBeLessThanOrEqual((frame?.y ?? 0) + (frame?.height ?? 0));
  });

  it('draws a placeholder with the alt text for a card with no picture, and none for one with a picture', () => {
    const plan = paginate([card(0, { image: false, placeholder: 'the empty quay' }), card(1)]);
    const [without, withPicture] = allCards(plan);
    expect(without?.hasImage).toBe(false);
    expect(without?.placeholder?.text).toBe('the empty quay');
    expect(withPicture?.hasImage).toBe(true);
    expect(withPicture?.placeholder).toBeUndefined();
  });

  it('fills the header from its text and cuts it to one line that leaves room for the label', () => {
    const plan = paginate(cards(1), { headerText: 'Fixture — '.repeat(40) });
    const title = plan.pages[0]?.title;
    expect(title?.text.length ?? 0).toBeLessThan(120);
    expect(title?.text.endsWith('…')).toBe(true);
  });
});

describe('wrapText', () => {
  // At 10 points a character is 5.5 units wide, so a 60-unit line holds 10 characters.
  it('wraps on spaces, keeping each line within the width', () => {
    expect(wrapText('alpha beta gamma delta', 60, 10, 3)).toEqual(['alpha beta', 'gamma', 'delta']);
  });

  it('cuts the text past the last line with an ellipsis, so the reader sees that more follows', () => {
    expect(wrapText('alpha beta gamma delta', 60, 10, 2)).toEqual(['alpha beta', 'gamma…']);
  });

  it('breaks a word longer than a line, and leaves no empty line', () => {
    expect(wrapText('abcdefghijklmnopqrstu', 60, 10, 5)).toEqual(['abcdefghij', 'klmnopqrst', 'u']);
  });

  it('returns no lines for empty text, and is deterministic', () => {
    expect(wrapText('', 60, 10, 2)).toEqual([]);
    expect(wrapText('same every time here', 60, 10, 2)).toEqual(wrapText('same every time here', 60, 10, 2));
  });
});

describe('wrapText and measureText with CJK text', () => {
  // At 10 points a wide character is one em, 10 units, so a 60-unit line holds 6 of them.
  it('counts a wide character as one em, and a narrow one as 0.55 em', () => {
    expect(measureText('草堂', 10)).toBe(20);
    expect(measureText('ひら', 10)).toBe(20);
    expect(measureText('한국', 10)).toBe(20);
    expect(measureText('ab', 10)).toBeCloseTo(11, 9);
    expect(measureText('a草', 10)).toBeCloseTo(15.5, 9);
  });

  it('counts every East Asian Wide character that is no emoji as one em, outside the main CJK blocks too', () => {
    // The angle brackets, an ideographic symbol, Tangut, Khitan, kana supplement, Nüshu and the enclosed ideographic supplement.
    for (const char of ['\u2329', '\u232A', '\u{16FE0}', '\u{17000}', '\u{18B00}', '\u{1B000}', '\u{1B170}', '\u{1F200}']) {
      expect(isWide(char), char).toBe(true);
      expect(measureText(char, 10), char).toBe(10);
    }
    // Their narrow neighbours stay narrow.
    for (const char of ['\u2328', '\u232B', 'A', 'é']) expect(isWide(char), char).toBe(false);
  });

  it('breaks between CJK characters, which have no spaces between words', () => {
    expect(wrapText('草堂的早晨很安静茶馆还没开门', 60, 10, 3)).toEqual(['草堂的早晨很', '安静茶馆还没', '开门']);
    expect(wrapText('ひらがなとカタカナです', 60, 10, 2)).toEqual(['ひらがなとカ', 'タカナです']);
  });

  it('wraps Korean on its spaces, as it is written', () => {
    expect(wrapText('한국어 문장을 씁니다', 60, 10, 3)).toEqual(['한국어', '문장을', '씁니다']);
    // A Hangul word longer than the line is still broken, so nothing overflows.
    expect(wrapText('가나다라마바사아', 60, 10, 2)).toEqual(['가나다라마바', '사아']);
  });

  it('keeps a closing mark on the line before it, and an opening mark with the text after it', () => {
    // 。would start the second line; it stays with 很, and 很 moves down with it.
    expect(wrapText('草堂的早晨很。安静', 60, 10, 2)).toEqual(['草堂的早晨', '很。安静']);
    // 「 would end the first line; it moves down with 茶.
    expect(wrapText('他走进了一「茶馆」', 60, 10, 2)).toEqual(['他走进了一', '「茶馆」']);
  });

  it('wraps mixed text, breaking at spaces and between CJK characters, and keeps every line within the width', () => {
    const lines = wrapText('Mei 走进茶馆, orders 龙井 tea and waits for the ferry', 60, 10, 6);
    for (const line of lines) expect(measureText(line, 10)).toBeLessThanOrEqual(60 + 1e-9);
    expect(lines[0]).toBe('Mei 走进茶');
    // The comma stays with 馆: it does not start a line.
    expect(lines[1]?.startsWith('馆,')).toBe(true);
    expect(lines.join(' ').replace(/\s+/g, '')).toBe('Mei走进茶馆,orders龙井teaandwaitsfortheferry');
  });

  it('cuts CJK text past the last line with an ellipsis inside the width', () => {
    const lines = wrapText('山'.repeat(30), 60, 10, 2);
    expect(lines).toEqual(['山山山山山山', '山山山山山…']);
    for (const line of lines) expect(measureText(line, 10)).toBeLessThanOrEqual(60 + 1e-9);
  });
});

describe('emoji in the plan: one unit per grapheme cluster', () => {
  // At 10 points an emoji is 1.3 em, 13 units, so a 60-unit line holds 4 of them.
  const FAMILY = '👨‍👩‍👧‍👦';

  it('measures and wraps a letter with VS15 as the text it is, with no break opened inside the word', () => {
    expect(measureText('cafe\uFE0E', 10)).toBeCloseTo(measureText('cafe', 10) + 5.5, 9);
    expect(wrapText('cafe\uFE0E cafe', 1000, 10, 1)).toEqual(['cafe\uFE0E cafe']);
    expect(wrapText('cafe\uFE0E', 28, 10, 2)).toEqual(['cafe\uFE0E']);
  });

  it('counts an emoji as 1.3 em however many code points it has', () => {
    for (const emoji of ['🎬', FAMILY, '👍🏽', '🇩🇪', '1️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿']) expect(measureText(emoji, 10)).toBeCloseTo(13, 9);
    expect(measureText(`ab${FAMILY}`, 10)).toBeCloseTo(24, 9);
    // © stays a narrow Latin character.
    expect(measureText('©', 10)).toBeCloseTo(5.5, 9);
  });

  it('breaks between emoji, never inside one, and keeps every line within the width', () => {
    const lines = wrapText(FAMILY.repeat(10), 60, 10, 3);
    expect(lines).toEqual([FAMILY.repeat(4), FAMILY.repeat(4), FAMILY.repeat(2)]);
    expect(wrapText(`Go ${'🇩🇪'.repeat(6)}`, 60, 10, 3)).toEqual(['Go 🇩🇪🇩🇪🇩🇪', '🇩🇪🇩🇪🇩🇪']);
    for (const line of wrapText(`Cut to ${FAMILY}${'👍🏽'.repeat(5)} then 1️⃣#️⃣`, 60, 10, 6)) expect(measureText(line, 10)).toBeLessThanOrEqual(60 + 1e-9);
  });

  it('cuts emoji past the last line with an ellipsis, dropping whole clusters', () => {
    const lines = wrapText('🏴󠁧󠁢󠁳󠁣󠁴󠁿'.repeat(20), 60, 10, 2);
    // Four flags and the ellipsis (4 × 13 + 5.5) still fit the 60-unit line.
    expect(lines).toEqual(['🏴󠁧󠁢󠁳󠁣󠁴󠁿'.repeat(4), `${'🏴󠁧󠁢󠁳󠁣󠁴󠁿'.repeat(4)}…`]);
    for (const line of lines) expect(measureText(line, 10)).toBeLessThanOrEqual(60 + 1e-9);
  });
});

describe('fillTemplate: the exporter’s placeholder rule', () => {
  it('fills the names it has, and leaves a name it does not have as written, so a typo shows', () => {
    expect(fillTemplate('{project} — {storyboard} — {date} {nope}', { project: 'P', storyboard: 'S', date: '2026-10-08' })).toBe(
      'P — S — 2026-10-08 {nope}',
    );
  });
});

describe('the renderer: the page plan, the images, and the PDF port', () => {
  async function project() {
    const fixture = buildFixture();
    const fs = new CountingFs();
    const imported = await importImage(fs, pngBytes(), {});
    if (!imported.ok) throw new Error('import failed');
    addShotNode(fixture.state, {
      parentId: 'board1',
      title: 'one',
      stored: { image: imported.value.assetId, shotSize: 'WS', cameraAngle: 'low', action: 'Elena crosses the quay in the grey light before the rain comes in.', durationSec: 2.5 },
      id: 'n_SHOTONE001',
      now: NOW,
    });
    addShotNode(fixture.state, {
      parentId: 'board1',
      title: 'two',
      stored: { image: 'a_7K2QX9M4A1', imageAlt: 'the empty quay', action: 'Short.' },
      id: 'n_SHOTTWO001',
      now: NOW,
    });
    return { fixture, fs, assetId: imported.value.assetId };
  }

  it('builds a plan with each card’s picture loaded from assets/, and a placeholder where the file is absent', async () => {
    const { fixture, fs, assetId } = await project();
    const document = await new ContactSheetPdfRenderer().build(fs, fixture.state, ['board1']);
    const [first, second] = allCards(document.plan);
    expect(first?.hasImage).toBe(true);
    expect(second?.hasImage).toBe(false);
    expect(second?.placeholder?.text).toBe('the empty quay');
    expect(document.images.get(assetId)?.format).toBe('png');
    expect(document.notes.join('\n')).toContain('image a_7K2QX9M4A1 could not be read from assets/');
  });

  it('writes the spec row the card shows, from the same values the CSV reads', async () => {
    const { fixture, fs } = await project();
    const document = await new ContactSheetPdfRenderer().build(fs, fixture.state, ['board1']);
    expect(allCards(document.plan)[0]?.spec.map((line) => line.text)).toEqual(['Wide shot (WS) · Low angle · 2.5 s']);
  });

  it('numbers the chips the way the CSV does, from 1 in binder order', async () => {
    const { fixture, fs } = await project();
    const document = await new ContactSheetPdfRenderer().build(fs, fixture.state);
    expect(allCards(document.plan).map((placed) => placed.chipText.text)).toEqual(['1', '2']);
  });

  it('names the header after the one storyboard it draws, or the one its shots sit in, and after all shots otherwise', async () => {
    const { fixture, fs } = await project();
    const single = await new ContactSheetPdfRenderer().build(fs, fixture.state, ['board1'], { headerTemplate: '{storyboard}' });
    const whole = await new ContactSheetPdfRenderer().build(fs, fixture.state, undefined, { headerTemplate: '{storyboard}' });
    expect(single.plan.pages[0]?.title.text).toBe('Board');
    expect(whole.plan.pages[0]?.title.text).toBe('Board');
    const second = addFolder(fixture.state, { id: 'board2', parentId: 'manuscript', title: 'Second board', now: NOW });
    setNodeKind(second, 'storyboard');
    addShotNode(fixture.state, { parentId: 'board2', title: 'three', stored: {}, id: 'n_SHOTTRE001', now: NOW });
    const both = await new ContactSheetPdfRenderer().build(fs, fixture.state, undefined, { headerTemplate: '{storyboard}' });
    expect(both.plan.pages[0]?.title.text).toBe('All shots');
  });

  it('fills the header template with the project and the date it is given', async () => {
    const { fixture, fs } = await project();
    const document = await new ContactSheetPdfRenderer().build(fs, fixture.state, undefined, {
      headerTemplate: '{project} · {storyboard} · {date}',
      project: 'Lighthouse',
      now: new Date('2026-10-08T12:00:00.000Z'),
    });
    expect(document.plan.pages[0]?.title.text).toBe('Lighthouse · Board · 2026-10-08');
  });

  it('says so, and draws nothing, when a selection names a node the project does not hold', async () => {
    const { fixture, fs } = await project();
    const document = await new ContactSheetPdfRenderer().build(fs, fixture.state, ['n_NOPE00001']);
    expect(allCards(document.plan)).toEqual([]);
    expect(document.notes.join('\n')).toContain('no node "n_NOPE00001"');
  });

  it('refuses to render a PDF with no engine wired, naming the reason, and never writes an empty file', async () => {
    const { fixture, fs } = await project();
    const result = await new ContactSheetPdfRenderer().render(fs, fixture.state, ['board1']);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'pdf-engine-not-wired' } });
    expect(result.ok === false && result.refusal.message).toContain('no PDF engine is wired into this renderer');
  });

  it('hands the plan and the images to the emitter, and returns what the emitter wrote', async () => {
    const { fixture, fs, assetId } = await project();
    const seen: ContactSheetDocument[] = [];
    const emitter = {
      emit: async (document: ContactSheetDocument): Promise<Uint8Array> => {
        seen.push(document);
        return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      },
    };
    const result = await new ContactSheetPdfRenderer(emitter).render(fs, fixture.state, ['board1']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.images.has(assetId)).toBe(true);
    expect(result).toMatchObject({ ok: true, value: { pages: 1 } });
    if (result.ok) expect([...result.value.bytes]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('identifies itself as the contact-sheet recipe the exporter will name', () => {
    expect(new ContactSheetPdfRenderer()).toMatchObject({ id: 'contact-sheet-pdf', mime: 'application/pdf' });
  });
});

describe('the header summary: the shot count and the animatic total', () => {
  it('puts the summary on every page, below the title and inside the header', () => {
    const plan = paginate(cards(31), { headerText: 'Board', summaryText: '31 shots · 62 s of animatic' });
    expect(plan.pages).toHaveLength(3);
    for (const page of plan.pages) {
      expect(page.summary?.text).toBe('31 shots · 62 s of animatic');
      expect(page.summary?.y ?? 0).toBeGreaterThan(page.title.y);
      expect(page.summary?.y ?? Infinity).toBeLessThanOrEqual(MARGIN + SHEET_LAYOUT.headerHeight);
      for (const placed of page.cards) expect(placed.frame.y).toBeGreaterThanOrEqual(MARGIN + SHEET_LAYOUT.headerHeight);
    }
  });

  it('leaves the summary out when none is given', () => {
    expect(paginate(cards(1)).pages[0]?.summary).toBeUndefined();
  });

  it('sums the timed shots and counts the untimed ones, as the board header does', () => {
    const fixture = buildFixture();
    addShotNode(fixture.state, { parentId: 'board1', title: 'a', stored: { durationSec: 2.5 }, id: 'n_SUMONE0001', now: NOW });
    addShotNode(fixture.state, { parentId: 'board1', title: 'b', stored: { durationSec: 4 }, id: 'n_SUMTWO0001', now: NOW });
    addShotNode(fixture.state, { parentId: 'board1', title: 'c', stored: {}, id: 'n_SUMTRE0001', now: NOW });
    expect(sheetSummaryOf(fixture.state, ['n_SUMONE0001', 'n_SUMTWO0001', 'n_SUMTRE0001'])).toBe(
      '3 shots · 6.5 s of animatic (1 shot without a duration left out)',
    );
    expect(sheetSummaryOf(fixture.state, ['n_SUMONE0001'])).toBe('1 shot · 2.5 s of animatic');
  });

  it('counts the same shots it sums: a folder as the shots under it, each shot once, and no id that is no shot', () => {
    const fixture = buildFixture();
    addShotNode(fixture.state, { parentId: 'board1', title: 'a', stored: { durationSec: 2.5 }, id: 'n_SUMONE0001', now: NOW });
    addShotNode(fixture.state, { parentId: 'board1', title: 'c', stored: {}, id: 'n_SUMTRE0001', now: NOW });
    // A duplicate id and an id no node has: the count does not grow, as the total does not.
    expect(sheetSummaryOf(fixture.state, ['n_SUMONE0001', 'n_SUMONE0001', 'n_NOSUCHNODE1'])).toBe('1 shot · 2.5 s of animatic');
    // A folder stands for its shots, so its summary is the summary of those shots named one by one.
    const inBoard = shotsInBinderOrder(fixture.state, ['board1']).map((node) => node.id);
    expect(inBoard.length).toBeGreaterThan(1);
    expect(sheetSummaryOf(fixture.state, ['board1'])).toBe(sheetSummaryOf(fixture.state, inBoard));
    expect(sheetSummaryOf(fixture.state, ['board1']).startsWith(`${inBoard.length} shots · `)).toBe(true);
  });
});

describe('the card spec row on the sheet', () => {
  it('is the board’s M-size row in the editor’s words: the camera values and the duration, then the lens and the transition when set', () => {
    expect(sheetSpecRowOf({ shotSize: 'CU', cameraAngle: 'low', cameraMovement: 'pan', durationSec: 3, lens: '35mm', transition: 'cut' })).toBe(
      'Close-up (CU) · Low angle · Pan · 3 s · 35mm · Cut',
    );
    expect(sheetSpecRowOf({ lens: '  ' })).toBe('');
    expect(sheetSpecRowOf({ transition: 'dissolve' })).toBe('Dissolve');
    expect(sheetSpecRowOf({ transition: 'wobble' })).toBe('wobble');
  });

  it('starts with the same words the board’s row has, so the two surfaces read alike', () => {
    const stored = { shotSize: 'WS', cameraAngle: 'high', cameraMovement: 'crane', durationSec: 2, lens: '50mm', transition: 'wipe' };
    expect(sheetSpecRowOf(stored)).toBe(`${specRowOf(stored)} · 50mm · Wipe`);
  });
});

describe('planContactSheet: the plan with no reads', () => {
  function projectWithPictures() {
    const fixture = buildFixture();
    addShotNode(fixture.state, { parentId: 'board1', title: 'one', stored: { image: 'a_7K2QX9M4A1', durationSec: 2 }, id: 'n_PLNONE0001', now: NOW });
    addShotNode(fixture.state, {
      parentId: 'board1',
      title: 'two',
      stored: { image: 'a_7K2QX9M4A2', imageAlt: 'the empty quay' },
      id: 'n_PLNTWO0001',
      now: NOW,
    });
    addShotNode(fixture.state, { parentId: 'board1', title: 'three', stored: { image: 'a_7K2QX9M4A2' }, id: 'n_PLNTRE0001', now: NOW });
    return fixture;
  }

  it('draws the pictures the caller says can be drawn, and gives the others their caption with one note per picture', () => {
    const fixture = projectWithPictures();
    const asked: string[] = [];
    const planned = planContactSheet(fixture.state, ['board1'], (assetId) => {
      asked.push(assetId);
      return assetId === 'a_7K2QX9M4A1' ? { drawn: true } : { drawn: false, note: `cannot draw ${assetId}` };
    });
    const [one, two, three] = allCards(planned.plan);
    expect(one?.hasImage).toBe(true);
    expect(two?.hasImage).toBe(false);
    expect(two?.placeholder?.text).toBe('the empty quay');
    expect(three?.placeholder?.text).toBe('No image');
    expect([...planned.pictures]).toEqual([['n_PLNONE0001', 'a_7K2QX9M4A1']]);
    expect(planned.notes).toEqual(['cannot draw a_7K2QX9M4A2']);
    // Each picture is asked about once, however many cards show it.
    expect(asked).toEqual(['a_7K2QX9M4A1', 'a_7K2QX9M4A2']);
    expect(planned.shotCount).toBe(3);
  });

  it('gives every card a fallback in the picture box, so an emitter that cannot draw a planned picture still shows the caption', () => {
    const planned = planContactSheet(projectWithPictures().state, ['board1'], () => ({ drawn: true }));
    for (const placed of allCards(planned.plan)) {
      expect(placed.fallback.y).toBeGreaterThan(placed.image.y);
      expect(placed.fallback.y).toBeLessThan(placed.image.y + placed.image.height);
    }
    expect(allCards(planned.plan)[1]?.fallback.text).toBe('the empty quay');
  });

  it('fills the header with the date it is given, and names the one storyboard every shot sits in', () => {
    const planned = planContactSheet(projectWithPictures().state, undefined, () => ({ drawn: true }), {
      headerTemplate: '{project} — {storyboard} — {date}',
      project: 'Lighthouse',
      date: '2026-10-17',
    });
    expect(planned.plan.pages[0]?.title.text).toBe('Lighthouse — Board — 2026-10-17');
    expect(planned.plan.pages[0]?.summary?.text).toBe('3 shots · 2 s of animatic (2 shots without a duration left out)');
  });

  it('lays the sheet out on Letter when asked', () => {
    const planned = planContactSheet(projectWithPictures().state, ['board1'], () => ({ drawn: true }), { pageSize: 'Letter' });
    expect(planned.plan.pageSize).toBe('Letter');
    expect(planned.plan.geometry.height).toBe(792);
  });

  describe('a paper sheet (paperFrames): blank numbered frames to draw in, storyboard.md §6', () => {
    function paperPlan(overrides: Partial<Parameters<typeof planContactSheet>[3]> = {}) {
      const asked: string[] = [];
      const planned = planContactSheet(
        projectWithPictures().state,
        ['board1'],
        (assetId) => {
          asked.push(assetId);
          return { drawn: true };
        },
        { paperFrames: true, ...overrides },
      );
      return { planned, asked };
    }

    it('plans one empty frame box per shot, with no picture drawn and none read, whatever the shot holds', () => {
      const { planned, asked } = paperPlan();
      const placed = allCards(planned.plan);
      expect(placed).toHaveLength(3);
      for (const one of placed) {
        expect(one.paper).toBe(true);
        expect(one.hasImage).toBe(false);
        expect(one.image.width).toBeCloseTo(planned.plan.cardWidth, 6);
        expect(one.image.height).toBeCloseTo(planned.plan.cardWidth * (9 / 16), 6);
      }
      expect(planned.pictures.size).toBe(0);
      expect(asked).toEqual([]);
      expect(planned.notes).toEqual([]);
    });

    it('does not place the placeholder text in the frame: a box to draw in must not say there is no picture', () => {
      const { planned } = paperPlan();
      for (const one of allCards(planned.plan)) {
        expect(one.placeholder).toBeUndefined();
        expect(one.fallback.text).toBe('');
      }
      // The picture sheet of the same shots still has it.
      const picture = planContactSheet(projectWithPictures().state, ['board1'], () => ({ drawn: false, note: 'n' }));
      expect(allCards(picture.plan)[2]?.placeholder?.text).toBe('No image');
    });

    it('keeps the number chip and prints a caption with the zero-padded number and the title, on the chip’s line', () => {
      const { planned } = paperPlan();
      const [one, two, three] = allCards(planned.plan);
      expect(one?.chipText.text).toBe('1');
      expect(one?.caption?.text).toBe('001 — one');
      expect(two?.caption?.text).toBe('002 — two');
      expect(three?.caption?.text).toBe('003 — three');
      for (const placed of [one, two, three]) {
        expect(placed?.caption?.y).toBe(placed?.chipText.y);
        expect(placed?.caption?.x).toBeGreaterThanOrEqual((placed?.chip.x ?? 0) + (placed?.chip.width ?? 0));
      }
    });

    it('keeps the spec row and the action lines, and the geometry of the picture sheet', () => {
      const fixture = buildFixture();
      addShotNode(fixture.state, {
        parentId: 'board1',
        title: 'The Ferry',
        stored: { shotSize: 'MCU', durationSec: 4, action: 'The lamp goes out.', image: 'a_7K2QX9M4A1' },
        id: 'n_PAPFER0001',
        now: NOW,
      });
      const paper = planContactSheet(fixture.state, ['board1'], () => ({ drawn: true }), { paperFrames: true });
      const picture = planContactSheet(fixture.state, ['board1'], () => ({ drawn: true }));
      const [onPaper] = allCards(paper.plan);
      const [onPicture] = allCards(picture.plan);
      expect(onPaper?.spec.map((line) => line.text).join(' ')).toContain('4 s');
      expect(onPaper?.action.map((line) => line.text)).toEqual(['The lamp goes out.']);
      expect(onPaper?.spec).toEqual(onPicture?.spec);
      expect(onPaper?.action).toEqual(onPicture?.action);
      expect(onPaper?.frame).toEqual(onPicture?.frame);
      expect(onPaper?.chip).toEqual(onPicture?.chip);
      expect(paper.plan.cardsPerPage).toBe(picture.plan.cardsPerPage);
      expect(paper.plan.pages).toHaveLength(picture.plan.pages.length);
      expect(paper.plan.pages[0]?.summary).toEqual(picture.plan.pages[0]?.summary);
    });

    it('pads the number to three digits, keeps four when there are that many, and cuts a long title to the room the chip leaves', () => {
      expect(paperCaptionOf(7, 'The Ferry')).toBe('007 — The Ferry');
      expect(paperCaptionOf(1234, 'x')).toBe('1234 — x');
      expect(paperCaptionOf(5, '')).toBe('005');
      expect(paperCaptionOf(5, '  two\nlines \t here ')).toBe('005 — two lines here');
      const long = paginate([card(0, { caption: paperCaptionOf(1, 'A very long title that cannot possibly fit on the line beside the number chip of one card') })]);
      const placed = allCards(long)[0];
      expect(placed?.caption?.text.endsWith('…')).toBe(true);
      expect(measureText(placed?.caption?.text ?? '', SHEET_LAYOUT.chipFontSize) + (placed?.caption?.x ?? 0)).toBeLessThanOrEqual(
        (placed?.frame.x ?? 0) + (placed?.frame.width ?? 0),
      );
    });

    it('is off by default and when false: a picture sheet has no caption and is not paper', () => {
      for (const options of [{}, { paperFrames: false }]) {
        const planned = planContactSheet(projectWithPictures().state, ['board1'], () => ({ drawn: true }), options);
        for (const one of allCards(planned.plan)) {
          expect(one.paper).toBe(false);
          expect(one.caption).toBeUndefined();
        }
      }
    });
  });
});

describe('measureText — Arabic and Hebrew', () => {
  it('counts an Arabic letter at half an em, a Hebrew letter at 0.55 em, and a mark of either at none', () => {
    expect(measureText('مرحبا', 10)).toBeCloseTo(5 * 0.5 * 10, 6);
    expect(measureText('שלום', 10)).toBeCloseTo(4 * 0.55 * 10, 6);
    expect(measureText('بِسْمِ', 10)).toBeCloseTo(3 * 0.5 * 10, 6);
    expect(measureText('שָׁלוֹם', 10)).toBeCloseTo(4 * 0.55 * 10, 6);
    // Latin text is measured as before.
    expect(measureText('abc', 10)).toBeCloseTo(3 * 0.55 * 10, 6);
  });

  it('wraps Arabic in logical order at spaces and never inside a letter with its marks', () => {
    const lines = wrapText(Array.from({ length: 12 }, () => 'بِسْمِ').join(' '), 60, 10, 6);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureText(line, 10)).toBeLessThanOrEqual(60 + 1e-6);
    expect(lines.join(' ').startsWith('بِسْمِ')).toBe(true);
  });
});

describe('measureText — Devanagari', () => {
  it('counts a letter at 0.63 em and a combining mark of a Brahmic script at none, so a vowel sign, a nukta or a virama adds no width', () => {
    expect(measureText('कखग', 10)).toBeCloseTo(3 * 0.63 * 10, 6);
    expect(measureText('कि', 10)).toBeCloseTo(0.63 * 10, 6);
    expect(measureText('हिन्दी', 10)).toBeCloseTo(3 * 0.63 * 10, 6);
    expect(measureText('क़', 10)).toBeCloseTo(0.63 * 10, 6);
    expect(measureText('क़', 10)).toBeCloseTo(0.63 * 10, 6);
    // Tamil has no font and prints as "?", but its marks are marks too.
    expect(measureText('தமி', 10)).toBeCloseTo(2 * 0.63 * 10, 6);
    expect(measureText('abc', 10)).toBeCloseTo(3 * 0.55 * 10, 6);
  });

  it('wraps at spaces and cuts a word wider than its box between clusters, never inside a conjunct', () => {
    const lines = wrapText(Array.from({ length: 12 }, () => 'हिन्दी').join(' '), 60, 10, 6);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measureText(line, 10)).toBeLessThanOrEqual(60 + 1e-6);
    const cut = wrapText('क्षत्रिय'.repeat(10), 40, 10, 6);
    expect(cut.length).toBeGreaterThan(1);
    for (const line of cut) {
      expect(line.endsWith('्'), line).toBe(false);
      expect(line.replace('…', '').replace(/क्ष|त्रि|य/gu, ''), line).toBe('');
    }
  });
});
