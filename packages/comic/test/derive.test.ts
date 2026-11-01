/**
 * `comic.derive` and `comic.letter` as pure functions (comics.md §3.2): a script becomes pages, panels and balloon text with
 * fresh anchors, a picture is never written or moved, and what the writer lettered by hand is never touched.
 */

import { describe, expect, it } from 'vitest';
import {
  captureAnchor,
  checkBalloonCoverage,
  defaultBalloonRect,
  panelRectsFor,
  planComicDerive,
  planComicLetter,
  speakerResolver,
  templateForPanelCount,
  validateComicPage,
  type ComicPage,
  type ComicPageInput,
  type DerivedPage,
} from '../src/index.js';
import { balloon, page, panel } from './fixtures.js';

const DOC = 'n_SCRIPT';
const BODY = [
  'PAGE ONE (2 panels)',
  '',
  'PANEL 1',
  'Mara on the pier.',
  '',
  '1. MARA: Who is there?',
  '2. CAPTION: Midnight.',
  '',
  'PANEL 2',
  '',
  '3. JONAH (OFF, WHISPER): Hold the line!',
  '',
  'PAGE 2',
  '',
  'PANEL 1',
  '',
  '1. SFX: BOOM',
  '',
].join('\n');

const speakerId = speakerResolver([
  { id: 'c_MARA', name: 'Mara' },
  { id: 'c_JONAH', name: 'Jonah', aliases: ['Jo'] },
]);

const input = (pages: readonly ComicPage[] = [], body = BODY) => ({
  docId: DOC,
  body,
  revision: 3,
  book: { readingDirection: 'ltr', pageSize: 'us-comic' },
  pages,
  speakerId,
});

function derive(pages: readonly ComicPage[] = [], body = BODY): DerivedPage[] {
  const plan = planComicDerive(input(pages, body));
  if (!plan.ok) throw new Error(plan.problems.map((p) => p.message.message).join(' '));
  return plan.pages;
}

const problemCodes = (pages: readonly ComicPage[], body = BODY): string[] => {
  const plan = planComicDerive(input(pages, body));
  return plan.ok ? [] : plan.problems.map((p) => p.code);
};

describe('planComicDerive on a book with no pages', () => {
  it('makes a page for each script page, with the panels and the lettering the script gives it', () => {
    const [one, two] = derive();
    expect(one).toMatchObject({ number: 1, created: true, changed: true, panels: 2, lines: 3, placed: 3, updated: 0, removed: 0 });
    expect(two).toMatchObject({ number: 2, created: true, panels: 1, lines: 1 });
    expect(one?.page).toMatchObject({ size: 'us-comic', layout: '2-tier' });
    expect(two?.page.layout).toBe('splash');

    const first = one?.page.panels[0];
    expect(first?.balloons.map((b) => [b.kind, b.text, b.speaker])).toEqual([
      ['speech', 'Who is there?', 'c_MARA'],
      ['caption', 'Midnight.', undefined],
    ]);
    const second = one?.page.panels[1]?.balloons[0];
    expect(second).toMatchObject({ kind: 'whisper', text: 'Hold the line!', speaker: 'c_JONAH', offPanel: true });
  });

  it('never writes a picture', () => {
    for (const d of derive()) {
      for (const p of d.page.panels) {
        expect(p.assetId).toBeUndefined();
        expect(p.crop).toBeUndefined();
      }
    }
  });

  it('captures each anchor over the exact line, at the revision it read', () => {
    const [one] = derive();
    const cover = one?.page.panels[1]?.script?.[0];
    expect(cover).toMatchObject({ kind: 'comic-script-line', docId: DOC, balloonId: one?.page.panels[1]?.balloons[0]?.id });
    expect(cover?.anchor.exact).toBe('3. JONAH (OFF, WHISPER): Hold the line!');
    expect(BODY.slice(cover?.anchor.from, cover?.anchor.to)).toBe(cover?.anchor.exact);
    expect(cover?.anchor.capturedRevision).toBe(3);
  });

  it('gives every balloon a rectangle inside its panel, and a page the strict write boundary accepts', () => {
    for (const d of derive()) {
      expect(validateComicPage(d.page).ok).toBe(true);
      for (const p of d.page.panels) {
        for (const b of p.balloons) {
          const [px, py, pw, ph] = p.rect;
          const [bx, by, bw, bh] = b.rect;
          expect(bx).toBeGreaterThanOrEqual(px);
          expect(by).toBeGreaterThanOrEqual(py);
          expect(bx + bw).toBeLessThanOrEqual(px + pw + 1e-9);
          expect(by + bh).toBeLessThanOrEqual(py + ph + 1e-9);
        }
      }
    }
  });

  it('leaves nothing for the coverage check to find in what it wrote', () => {
    const pages: ComicPageInput[] = derive().map((d) => ({ id: `n_P${d.number}`, number: d.number, page: d.page }));
    expect(checkBalloonCoverage({ docId: DOC, body: BODY, pages })).toEqual([]);
  });

  it('gives a page with no panel in the script one panel, and one that holds a page header only', () => {
    const [only] = derive([], 'PAGE 1\n\nA full-page splash of the lighthouse.\n');
    expect(only?.panels).toBe(1);
    expect(only?.lines).toBe(0);
  });

  it('refuses a script with no pages, and one whose pages are not numbered 1 to N in order', () => {
    expect(problemCodes([], 'Just a note.\n')).toEqual(['noPages']);
    expect(problemCodes([], 'PAGE 1\nPANEL 1\n\nPAGE 3\nPANEL 1\n')).toEqual(['pageNumbers']);
    expect(problemCodes([], 'PAGE 2\nPANEL 1\n\nPAGE 1\nPANEL 1\n')).toEqual(['pageNumbers']);
    expect(problemCodes([], 'PAGE 1\nPANEL 1\n\nPAGE 1\nPANEL 1\n')).toEqual(['pageNumbers']);
  });
});

describe('planComicDerive over pages the book already has', () => {
  const existing = (): ComicPage[] => {
    const [one] = derive();
    return [one?.page as ComicPage];
  };

  it('is a no-op over what it wrote', () => {
    const plan = planComicDerive(input(existing()));
    expect(plan.ok && plan.pages[0]).toMatchObject({ created: false, changed: false, placed: 0, updated: 0, removed: 0 });
    expect(plan.ok && plan.pages[1]).toMatchObject({ created: true });
  });

  it('updates a script balloon in place, keeping its id, rectangle and tail, and its picture and panel with it', () => {
    const pages = existing();
    const target = pages[0]?.panels[0];
    if (target === undefined) throw new Error('fixture');
    target.assetId = 'a_7K2QX9M4A1';
    target.crop = [0, 0, 1, 1];
    target.border = 'bold';
    (target as Record<string, unknown>)['future'] = { keep: true };
    const lettered = target.balloons[0];
    if (lettered === undefined) throw new Error('fixture');
    lettered.rect = [0.01, 0.02, 0.3, 0.1];
    lettered.tail = [0.5, 0.5];
    lettered.text = 'Hand-edited.';

    const body = BODY.replace('Who is there?', 'Who goes there?');
    const plan = planComicDerive(input(pages, body));
    if (!plan.ok) throw new Error('refused');
    const out = plan.pages[0]?.page.panels[0];
    expect(plan.pages[0]).toMatchObject({ changed: true, placed: 0, updated: 1 });
    expect(out).toMatchObject({ id: target.id, assetId: 'a_7K2QX9M4A1', crop: [0, 0, 1, 1], border: 'bold', future: { keep: true } });
    expect(out?.rect).toEqual(target.rect);
    expect(out?.balloons[0]).toMatchObject({ id: lettered.id, text: 'Who goes there?', rect: [0.01, 0.02, 0.3, 0.1], tail: [0.5, 0.5] });
    expect(out?.script?.[0]?.anchor.exact).toBe('1. MARA: Who goes there?');
  });

  it('never touches a balloon the writer lettered by hand', () => {
    const pages = existing();
    const hand = balloon('bl_hand', 'My own note.', { rect: [0.2, 0.2, 0.2, 0.1] });
    pages[0]?.panels[1]?.balloons.unshift(hand);
    const plan = planComicDerive(input(pages, BODY.replace('Hold the line!', 'Hold it!')));
    if (!plan.ok) throw new Error('refused');
    const balloons = plan.pages[0]?.page.panels[1]?.balloons;
    expect(balloons?.map((b) => b.id)).toContain('bl_hand');
    expect(balloons?.find((b) => b.id === 'bl_hand')).toEqual(hand);
    expect(balloons?.find((b) => b.id !== 'bl_hand')?.text).toBe('Hold it!');
  });

  it('removes a script balloon whose line left the script, and its coverage with it', () => {
    const pages = existing();
    const body = BODY.replace('2. CAPTION: Midnight.\n', '');
    const plan = planComicDerive(input(pages, body));
    if (!plan.ok) throw new Error('refused');
    expect(plan.pages[0]).toMatchObject({ removed: 1, lines: 2 });
    const out = plan.pages[0]?.page.panels[0];
    expect(out?.balloons.map((b) => b.text)).toEqual(['Who is there?']);
    expect(out?.script).toHaveLength(1);
  });

  it('re-lays a page whose panel count changed and keeps the panels that remain', () => {
    const pages = existing();
    const body = BODY.replace('PANEL 2\n\n3. JONAH (OFF, WHISPER): Hold the line!\n', '');
    const plan = planComicDerive(input(pages, body));
    if (!plan.ok) throw new Error('refused');
    const out = plan.pages[0]?.page;
    expect(out?.panels.map((p) => p.id)).toEqual([pages[0]?.panels[0]?.id]);
    expect(out?.layout).toBe('splash');
    expect(out?.panels[0]?.rect).toEqual(panelRectsFor(1, { size: 'us-comic' })[0]);
  });

  it('refuses to move panels under a picture, and to drop lettering the script did not give', () => {
    const withPicture = existing();
    (withPicture[0]?.panels[0] as { assetId?: string }).assetId = 'a_7K2QX9M4A1';
    expect(problemCodes(withPicture, 'PAGE 1\nPANEL 1\n\nMARA: Hi.\n')).toEqual(['picturesInTheWay']);

    const withHand = existing();
    withHand[0]?.panels[1]?.balloons.push(balloon('bl_hand', 'Mine.'));
    const body = 'PAGE 1\nPANEL 1\n\nMARA: Hi.\n';
    expect(problemCodes(withHand, body)).toEqual(['dropsLettering']);
  });

  it('keeps a page it was given a size for, and reads the book for new ones', () => {
    const pages = existing();
    pages[0] = { ...pages[0], size: 'a4' } as ComicPage;
    const plan = planComicDerive({ ...input(pages), book: { readingDirection: 'rtl', pageSize: 'manga-b5' } });
    if (!plan.ok) throw new Error('refused');
    expect(plan.pages[0]?.page.size).toBe('a4');
    expect(plan.pages[1]?.page.size).toBe('manga-b5');
    // A right-to-left book starts its first panel at the right edge of the page.
    expect((plan.pages[1]?.page.panels[0]?.rect[0] ?? 1) + (plan.pages[1]?.page.panels[0]?.rect[2] ?? 0)).toBeCloseTo(1);
  });
});

describe('planComicLetter', () => {
  const emptyPage = (): ComicPage => page([panel('pn_1', [], [0, 0, 1, 0.5]), panel('pn_2', [], [0, 0.5, 1, 0.5])]);
  const letter = (p: ComicPage, extra: { panel?: number; line?: number } = {}, body = BODY) =>
    planComicLetter({ docId: DOC, body, revision: 3, readingDirection: 'ltr', page: p, pageNumber: 1, speakerId, ...extra });

  it('places the lettering of every line a script page names, over a page with panels and no balloons', () => {
    const plan = letter(emptyPage());
    if (!plan.ok) throw new Error('refused');
    expect(plan).toMatchObject({ changed: true, placed: 3, updated: 0, lines: 3 });
    expect(plan.page.panels.map((p) => p.balloons.length)).toEqual([2, 1]);
    expect(plan.page.panels[0]?.rect).toEqual([0, 0, 1, 0.5]);
  });

  it('updates a balloon the script already lettered, and is a no-op when nothing changed', () => {
    const first = letter(emptyPage());
    if (!first.ok) throw new Error('refused');
    const again = letter(first.page);
    expect(again).toMatchObject({ ok: true, changed: false, placed: 0, updated: 0 });
    const edited = letter(first.page, {}, BODY.replace('Midnight.', 'Almost dawn.'));
    if (!edited.ok) throw new Error('refused');
    expect(edited).toMatchObject({ changed: true, placed: 0, updated: 1 });
    expect(edited.page.panels[0]?.balloons[1]?.id).toBe(first.page.panels[0]?.balloons[1]?.id);
  });

  it('never removes a balloon, and keeps its coverage when its line has left the script', () => {
    const first = letter(emptyPage());
    if (!first.ok) throw new Error('refused');
    const shorter = letter(first.page, {}, BODY.replace('2. CAPTION: Midnight.\n', ''));
    if (!shorter.ok) throw new Error('refused');
    expect(shorter.page.panels[0]?.balloons).toHaveLength(2);
    const ids = shorter.page.panels[0]?.balloons.map((b) => b.id);
    expect([...(shorter.page.panels[0]?.script?.map((e) => e.balloonId) ?? [])].sort()).toEqual([...(ids ?? [])].sort());
  });

  it('letters one panel, or one line, and nothing else', () => {
    const one = letter(emptyPage(), { panel: 2 });
    if (!one.ok) throw new Error('refused');
    expect(one.page.panels.map((p) => p.balloons.length)).toEqual([0, 1]);
    const line = letter(emptyPage(), { panel: 1, line: 2 });
    if (!line.ok) throw new Error('refused');
    expect(line).toMatchObject({ placed: 1, lines: 1 });
    expect(line.page.panels[0]?.balloons.map((b) => b.text)).toEqual(['Midnight.']);
    expect(line.page.panels[0]?.script).toHaveLength(1);
    expect(line.page.panels[1]?.balloons).toHaveLength(0);
  });

  it('refuses where there is no script page, panel or line, or too few panels on the page', () => {
    const codes = (plan: ReturnType<typeof letter>): string[] => (plan.ok ? [] : plan.problems.map((p) => p.code));
    expect(codes(planComicLetter({ docId: DOC, body: BODY, revision: 3, readingDirection: 'ltr', page: emptyPage(), pageNumber: 9 }))).toEqual(['noScriptPage']);
    expect(codes(letter(page([panel('pn_1')])))).toEqual(['panelsMissing']);
    expect(codes(letter(emptyPage(), { panel: 5 }))).toEqual(['noScriptPanel']);
    expect(codes(letter(emptyPage(), { panel: 1, line: 9 }))).toEqual(['noScriptLine']);
  });
});

describe('what derive and letter share', () => {
  it('resolves a speaker by name or alias, case-insensitively, and never between two entries', () => {
    expect(speakerId('MARA')).toBe('c_MARA');
    expect(speakerId('JO')).toBe('c_JONAH');
    expect(speakerId('NOBODY')).toBeUndefined();
    const twice = speakerResolver([{ id: 'c_A', name: 'Sam' }, { id: 'c_B', name: 'SAM' }]);
    expect(twice('SAM')).toBeUndefined();
  });

  it('captures an anchor inside the bounds, and none outside them', () => {
    expect(captureAnchor('abcdef', 1, 3, 2)).toEqual({ from: 1, to: 3, exact: 'bc', prefix: 'a', suffix: 'def', capturedRevision: 2 });
    expect(captureAnchor('abc', 2, 2, 1)).toBeUndefined();
    expect(captureAnchor('abc', 0, 9, 1)).toBeUndefined();
    expect(captureAnchor('x'.repeat(2001), 0, 2001, 1)).toBeUndefined();
  });

  it('lays out any panel count, matching the templates where there is one', () => {
    expect(templateForPanelCount(6)).toBe('grid-6');
    expect(templateForPanelCount(5)).toBeUndefined();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13]) expect(panelRectsFor(n)).toHaveLength(n);
    expect(panelRectsFor(0)).toEqual([]);
    const five = panelRectsFor(5);
    expect(five[4]?.[2]).toBeGreaterThan(five[0]?.[2] ?? 1);
  });

  it('mirrors the stack for a right-to-left book', () => {
    const ltr = defaultBalloonRect([0, 0, 1, 1], 0, 2, 'ltr');
    const rtl = defaultBalloonRect([0, 0, 1, 1], 0, 2, 'rtl');
    expect(ltr[0]).toBeLessThan(rtl[0]);
  });
});
