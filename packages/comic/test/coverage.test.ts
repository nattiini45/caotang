import { describe, expect, it } from 'vitest';
import {
  checkBalloonCoverage,
  parseComicScript,
  resolveAnchorExact,
  scriptFromPages,
  type ComicPage,
  type ComicPageInput,
  type TextAnchor,
} from '../src/index.js';
import { balloon, page, panel } from './fixtures.js';

const DOC = 'n_SCRIPT';
const speakerName = (id: string): string | undefined => ({ c_MARA: 'Mara', c_JONAH: 'Jonah' })[id];

function build(): { pages: ComicPageInput[]; body: string; anchors: Record<string, TextAnchor> } {
  const pages: ComicPage[] = [
    page([
      panel('p1', [balloon('b1', 'Who is there?', { speaker: 'c_MARA' }), balloon('b2', 'Midnight.', { kind: 'caption' })]),
      panel('p2', [balloon('b3', 'Hold the line!', { speaker: 'c_JONAH' })]),
    ]),
  ];
  const generated = scriptFromPages(pages.map((p) => ({ page: p })), { speakerName });
  const anchors: Record<string, TextAnchor> = {};
  for (const l of generated.lines) {
    anchors[l.balloonId] = {
      from: l.from,
      to: l.to,
      exact: generated.body.slice(l.from, l.to),
      prefix: generated.body.slice(Math.max(0, l.from - 32), l.from),
      suffix: generated.body.slice(l.to, l.to + 32),
      capturedRevision: 1,
    };
  }
  for (const p of pages) {
    for (const pn of p.panels) {
      pn.script = pn.balloons.map((b) => ({ kind: 'comic-script-line', docId: DOC, anchor: anchors[b.id] as TextAnchor, balloonId: b.id }));
    }
  }
  return { pages: pages.map((p, i) => ({ id: `n_PAGE${i}`, number: i + 1, page: p })), body: generated.body, anchors };
}

describe('checkBalloonCoverage', () => {
  it('finds nothing when every line is lettered and every anchor resolves', () => {
    const { pages, body } = build();
    expect(checkBalloonCoverage({ docId: DOC, body, pages })).toEqual([]);
  });

  it('finds a script line no balloon covers, in the script-to-balloon direction', () => {
    const { pages, body } = build();
    const longer = `${body}\nPANEL 3\n\n4. MARA: A new line.\n`;
    const findings = checkBalloonCoverage({ docId: DOC, body: longer, pages });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ checkId: 'comic.balloon-coverage', code: 'unletteredLine', severity: 'warning' });
    expect(findings[0]?.evidence).toBe('A new line.');
    expect(findings[0]?.where).toMatchObject({ docId: DOC, pageNumber: 1 });
    const range = findings[0]?.where.scriptRange;
    expect(longer.slice(range?.from, range?.to)).toBe('4. MARA: A new line.');
    expect(findings[0]?.message.values).toMatchObject({ speaker: 'MARA', page: 1, panel: 3 });
  });

  it('keeps the same key for the same line across runs', () => {
    const { pages, body } = build();
    const longer = `${body}\nPANEL 3\n\n4. MARA: A new line.\n`;
    const a = checkBalloonCoverage({ docId: DOC, body: longer, pages });
    const b = checkBalloonCoverage({ docId: DOC, body: longer, pages });
    expect(a[0]?.key).toBe(b[0]?.key);
  });

  it('counts a line lettered by hand when the panel holds a balloon with the same text', () => {
    const { pages, body } = build();
    for (const p of pages) for (const pn of p.page.panels) delete pn.script;
    expect(checkBalloonCoverage({ docId: DOC, body, pages })).toEqual([]);
    (pages[0]?.page.panels[0]?.balloons[0] as { text: string }).text = 'Something else.';
    const findings = checkBalloonCoverage({ docId: DOC, body, pages });
    expect(findings.map((f) => f.code)).toEqual(['unletteredLine']);
    expect(findings[0]?.evidence).toBe('Who is there?');
  });

  it('reports every line of a script page the book does not have', () => {
    const { pages, body } = build();
    const findings = checkBalloonCoverage({ docId: DOC, body: `${body}\nPAGE 2\nPANEL 1\n\nMARA: Hi.\n`, pages });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where.pageNumber).toBe(2);
    expect(findings[0]?.where.pageId).toBeUndefined();
  });

  it('finds a covered line whose balloon is gone, in the balloon-to-script direction', () => {
    const { pages, body } = build();
    pages[0]!.page.panels[0]!.balloons.splice(1, 1);
    const findings = checkBalloonCoverage({ docId: DOC, body, pages });
    expect(findings.map((f) => f.code).sort()).toEqual(['brokenBalloon', 'unletteredLine']);
    const broken = findings.find((f) => f.code === 'brokenBalloon');
    expect(broken?.where).toMatchObject({ balloonId: 'b2', panelId: 'p1' });
  });

  it('finds a balloon whose script text was edited away', () => {
    const { pages, body } = build();
    const edited = body.replace('Who is there?', 'Who goes there?');
    const findings = checkBalloonCoverage({ docId: DOC, body: edited, pages });
    const stale = findings.filter((f) => f.code === 'staleAnchor');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.where.balloonId).toBe('b1');
    expect(stale[0]?.evidence).toContain('Who is there?');
    expect(findings.some((f) => f.code === 'unletteredLine' && f.evidence === 'Who goes there?')).toBe(true);
  });

  it('follows an anchor whose text moved when the text is still unique', () => {
    const { pages, body } = build();
    const moved = `Preamble about the book.\n\n${body}`;
    expect(checkBalloonCoverage({ docId: DOC, body: moved, pages })).toEqual([]);
  });

  it('never guesses between two identical lines', () => {
    const anchor: TextAnchor = { from: 0, to: 5, exact: 'Hello', prefix: '', suffix: '', capturedRevision: 1 };
    expect(resolveAnchorExact(anchor, 'xx Hello yy Hello zz')).toBeUndefined();
    expect(resolveAnchorExact({ ...anchor, prefix: 'yy ', suffix: ' zz' }, 'xx Hello yy Hello zz')).toEqual({ from: 12, to: 17 });
    expect(resolveAnchorExact(anchor, 'Hello world')).toEqual({ from: 0, to: 5 });
  });

  it('finds a line lettered from a different script', () => {
    const { pages, body } = build();
    const findings = checkBalloonCoverage({ docId: 'n_OTHER', body, pages });
    expect(findings.filter((f) => f.code === 'staleDocument')).toHaveLength(3);
  });

  it('accepts an injected anchor resolver', () => {
    const { pages, body } = build();
    const findings = checkBalloonCoverage({ docId: DOC, body, pages, resolveAnchor: () => undefined });
    expect(findings.filter((f) => f.code === 'staleAnchor')).toHaveLength(3);
  });

  it('treats a covered line with no balloon named as covered but not lettered', () => {
    const { pages, body } = build();
    const cover = pages[0]!.page.panels[1]!.script![0]!;
    delete cover.balloonId;
    pages[0]!.page.panels[1]!.balloons.length = 0;
    const findings = checkBalloonCoverage({ docId: DOC, body, pages });
    expect(findings.map((f) => f.code)).toEqual(['unletteredLine']);
  });

  it('returns nothing for an empty script and an empty book', () => {
    expect(checkBalloonCoverage({ docId: DOC, body: '', pages: [] })).toEqual([]);
    expect(parseComicScript('').pages).toEqual([]);
  });

  it('reads Han and right-to-left script lines', () => {
    const pages: ComicPageInput[] = [
      { id: 'n_P', number: 1, page: page([panel('p1', [balloon('b1', '你好，世界！'), balloon('b2', 'مرحبا بالعالم')])]) },
    ];
    const body = 'PAGE 1\nPANEL 1\n玛拉: 你好，世界！\nسارة: مرحبا بالعالم\nCAPTION: 另一行\n';
    const findings = checkBalloonCoverage({ docId: DOC, body, pages });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toBe('另一行');
  });
});
