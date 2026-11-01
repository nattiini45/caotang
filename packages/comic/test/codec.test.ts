import { describe, expect, it } from 'vitest';
import {
  BALLOON_ID_PATTERN,
  DEFAULT_BOOK_SETTINGS,
  PANEL_ID_PATTERN,
  isNormalizedRect,
  loadComicBook,
  loadComicPage,
  mintBalloonId,
  mintPanelId,
  serializeComicBook,
  serializeComicPage,
  validateComicBook,
  validateComicPage,
  type ComicPage,
} from '../src/index.js';
import { balloon, page, panel } from './fixtures.js';

const anchor = { from: 3, to: 9, exact: 'Hello.', prefix: '', suffix: '', capturedRevision: 2 };

const rich = {
  size: 'manga-b5',
  layout: 'grid-6',
  futurePageKey: { nested: [1, 2, 3] },
  panels: [
    {
      id: 'pn_AAAAAAAAAA',
      rect: [0, 0, 0.5, 0.5],
      assetId: 'a_BBBBBBBBBB',
      crop: [0.1, 0.1, 0.8, 0.8],
      border: 'bold',
      futurePanelKey: 'x',
      script: [{ kind: 'comic-script-line', docId: 'n_DOC', anchor, balloonId: 'bl_CCCCCCCCCC', note: 'kept' }],
      balloons: [
        {
          id: 'bl_CCCCCCCCCC',
          kind: 'whisper',
          text: 'Hello.',
          speaker: 'c_SPEAKER000',
          rect: [0.05, 0.05, 0.3, 0.12],
          tail: [0.3, 0.4],
          offPanel: true,
          fontSize: 11,
          style: 'lettering',
          futureBalloonKey: 7,
        },
      ],
    },
  ],
};

describe('loadComicBook', () => {
  it('fills defaults and keeps unknown keys', () => {
    const { value, issues } = loadComicBook({ readingDirection: 'rtl', newerKey: { a: 1 } });
    expect(issues).toEqual([]);
    expect(value).toMatchObject({ ...DEFAULT_BOOK_SETTINGS, readingDirection: 'rtl', newerKey: { a: 1 } });
    expect(value.scriptDocId).toBeUndefined();
  });

  it('keeps a script link that resolves to nothing, and an unknown enum value', () => {
    const { value, issues } = loadComicBook({ scriptDocId: 'n_GONE', pageSize: 'tabloid' });
    expect(issues).toEqual([]);
    expect(value.scriptDocId).toBe('n_GONE');
    expect(value.pageSize).toBe('tabloid');
  });

  it('reports a field of the wrong type and uses the default', () => {
    const { value, issues } = loadComicBook({ capsTransform: 'yes', scriptDocId: 12 });
    expect(issues.map((i) => i.path).sort()).toEqual(['capsTransform', 'scriptDocId']);
    expect(value.capsTransform).toBe(true);
    expect('scriptDocId' in value).toBe(false);
  });

  it('survives a value that is not an object', () => {
    const { value, issues } = loadComicBook(null);
    expect(issues).toHaveLength(1);
    expect(value.readingDirection).toBe('ltr');
  });

  it('round-trips unknown keys through serialize', () => {
    const { value } = loadComicBook({ ...DEFAULT_BOOK_SETTINGS, scriptDocId: 'n_X', extra: [1] });
    expect(serializeComicBook(value)).toEqual({ ...DEFAULT_BOOK_SETTINGS, scriptDocId: 'n_X', extra: [1] });
  });
});

describe('loadComicPage', () => {
  it('keeps every unknown field at every level and round-trips exactly', () => {
    const { value, issues } = loadComicPage(rich);
    expect(issues).toEqual([]);
    expect(serializeComicPage(value)).toEqual(rich);
  });

  it('keeps an unknown balloon kind and page size instead of dropping the page', () => {
    const { value, issues } = loadComicPage({
      size: 'tabloid',
      panels: [{ id: 'p1', rect: [0, 0, 1, 1], balloons: [{ id: 'b1', kind: 'telepathy', text: 'hm', rect: [0, 0, 0.2, 0.1] }] }],
    });
    expect(issues).toEqual([]);
    expect(value.size).toBe('tabloid');
    expect(value.panels[0]?.balloons[0]?.kind).toBe('telepathy');
  });

  it('replaces an unreadable rectangle with a drawable one and reports where', () => {
    const { value, issues } = loadComicPage({
      size: 'a4',
      panels: [{ id: 'p1', rect: [0, 0, 'wide', 1], balloons: [{ id: 'b1', kind: 'speech', text: 'x', rect: [0, 0, 2, 2] }] }],
    });
    expect(issues).toHaveLength(2);
    expect(issues).toContainEqual({ path: 'panels[0].rect', code: 'badRect' });
    expect(issues).toContainEqual({ path: 'panels[0].balloons[0].rect', code: 'badRect' });
    expect(isNormalizedRect(value.panels[0]?.rect)).toBe(true);
    expect(isNormalizedRect(value.panels[0]?.balloons[0]?.rect)).toBe(true);
  });

  it('gives a missing id a placeholder and reports it, and reports a repeated id', () => {
    const { value, issues } = loadComicPage({
      size: 'a4',
      panels: [{ rect: [0, 0, 1, 1], balloons: [] }, { id: 'panel-1', rect: [0, 0, 1, 1], balloons: [] }],
    });
    expect(value.panels[0]?.id).toBe('panel-1');
    expect(issues).toContainEqual({ path: 'panels[0].id', code: 'missing' });
    expect(issues).toContainEqual({ path: 'panels[1].id', code: 'duplicateId' });
  });

  it('survives garbage without throwing', () => {
    expect(loadComicPage(undefined).value.panels).toEqual([]);
    expect(loadComicPage({ panels: 'no' }).issues).toContainEqual({ path: 'panels', code: 'wrongType' });
    const { value } = loadComicPage({ size: 'a4', panels: [42, { id: 'p', rect: [0, 0, 1, 1], balloons: [null] }] });
    expect(value.panels).toHaveLength(1);
    expect(value.panels[0]?.balloons).toEqual([]);
  });

  it('drops a script entry it cannot read and keeps the rest', () => {
    const { value, issues } = loadComicPage({
      size: 'a4',
      panels: [
        {
          id: 'p',
          rect: [0, 0, 1, 1],
          balloons: [],
          script: [{ kind: 'comic-script-line', docId: 'd', anchor }, { docId: 'd' }],
        },
      ],
    });
    expect(value.panels[0]?.script).toHaveLength(1);
    expect(issues).toContainEqual({ path: 'panels[0].script[1]', code: 'dropped' });
  });
});

describe('validateComicPage', () => {
  it('accepts the stored page and keeps unknown fields', () => {
    const result = validateComicPage(rich);
    expect(result.ok).toBe(true);
    if (result.ok) expect(serializeComicPage(result.value)).toEqual(rich);
  });

  it('accepts an empty page and a panel with no balloons', () => {
    expect(validateComicPage(page([])).ok).toBe(true);
    expect(validateComicPage(page([panel('p1')])).ok).toBe(true);
  });

  const bad = (rect: unknown): boolean => validateComicPage({ size: 'a4', panels: [{ id: 'p1', rect, balloons: [] }] }).ok;

  it.each([
    ['NaN', [0, 0, Number.NaN, 1]],
    ['Infinity', [0, 0, Number.POSITIVE_INFINITY, 1]],
    ['negative start', [-0.1, 0, 0.5, 0.5]],
    ['start past 1', [1.5, 0, 0.1, 0.1]],
    ['zero width', [0, 0, 0, 0.5]],
    ['negative height', [0, 0, 0.5, -0.2]],
    ['far edge past 1', [0.6, 0, 0.5, 0.5]],
    ['three numbers', [0, 0, 1]],
    ['strings', ['0', '0', '1', '1']],
    ['not an array', { x: 0 }],
  ])('refuses a panel rectangle that is %s', (_name, rect) => {
    expect(bad(rect)).toBe(false);
  });

  it('accepts a rectangle that touches the edge, within float noise', () => {
    expect(bad([0.7, 0.1, 0.3, 0.9])).toBe(true);
    expect(bad([0.1 + 0.2, 0, 0.7, 1])).toBe(true);
  });

  it('refuses a bad crop, tail and font size, with the path of each', () => {
    const result = validateComicPage(
      page([
        panel('p1', [balloon('b1', 'x', { tail: [2, 0], fontSize: -1 })], [0, 0, 1, 1], { crop: [0, 0, 0, 1] }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.path).sort()).toEqual([
        'panels[0].balloons[0].fontSize',
        'panels[0].balloons[0].tail',
        'panels[0].crop',
      ]);
      expect(result.errors[0]?.message.id).toMatch(/^comic\.invalid\./);
    }
  });

  it('refuses a malformed or repeated id, across panels and balloons alike', () => {
    expect(validateComicPage(page([panel('has space')])).ok).toBe(false);
    expect(validateComicPage(page([panel('p1'), panel('p1')])).ok).toBe(false);
    expect(validateComicPage(page([panel('p1', [balloon('p1', 'x')])])).ok).toBe(false);
    expect(validateComicPage(page([panel('p1', [balloon('b', 'x')]), panel('p2', [balloon('b', 'y')])])).ok).toBe(false);
    expect(validateComicPage(page([panel('')])).ok).toBe(false);
  });

  it('refuses a value outside a closed list', () => {
    expect(validateComicPage(page([panel('p1', [balloon('b1', 'x', { kind: 'telepathy' })])])).ok).toBe(false);
    expect(validateComicPage({ ...page([]), size: 'tabloid' }).ok).toBe(false);
    expect(validateComicPage(page([panel('p1', [], [0, 0, 1, 1], { border: 'dashed' })])).ok).toBe(false);
  });

  it('lets an unknown value be written back unchanged, but not introduced or changed', () => {
    const stored = loadComicPage({
      size: 'tabloid',
      panels: [{ id: 'p1', rect: [0, 0, 1, 1], balloons: [{ id: 'b1', kind: 'telepathy', text: 'hm', rect: [0, 0, 0.2, 0.1] }] }],
    }).value;
    expect(validateComicPage(stored, stored).ok).toBe(true);
    expect(validateComicPage(stored).ok).toBe(false);
    const moved = structuredClone(stored) as ComicPage;
    (moved.panels[0] as { balloons: { kind: string }[] }).balloons[0]!.kind = 'dream';
    expect(validateComicPage(moved, stored).ok).toBe(false);
  });

  it('refuses a coverage entry with a bad anchor', () => {
    const p = panel('p1', [], [0, 0, 1, 1], {
      script: [{ kind: 'comic-script-line', docId: 'd', anchor: { ...anchor, to: 3 } }],
    });
    expect(validateComicPage(page([p])).ok).toBe(false);
  });

  it('refuses a page that is not an object', () => {
    expect(validateComicPage(null).ok).toBe(false);
    expect(validateComicPage({ size: 'a4' }).ok).toBe(false);
  });

  it('keeps text of any script, including Han and right-to-left', () => {
    const result = validateComicPage(page([panel('p1', [balloon('b1', '你好，世界'), balloon('b2', 'مرحبا بالعالم')])]));
    expect(result.ok).toBe(true);
  });
});

describe('validateComicBook', () => {
  it('accepts a full book and keeps unknown keys', () => {
    const result = validateComicBook({ ...DEFAULT_BOOK_SETTINGS, readingDirection: 'rtl', future: true });
    expect(result.ok && result.value['future']).toBe(true);
  });

  it('refuses an unknown direction unless it is already stored', () => {
    expect(validateComicBook({ ...DEFAULT_BOOK_SETTINGS, readingDirection: 'ttb' }).ok).toBe(false);
    const previous = loadComicBook({ readingDirection: 'ttb' }).value;
    expect(validateComicBook({ ...DEFAULT_BOOK_SETTINGS, readingDirection: 'ttb' }, previous).ok).toBe(true);
  });

  it('refuses an empty script link: absent means no script', () => {
    expect(validateComicBook({ ...DEFAULT_BOOK_SETTINGS, scriptDocId: '' }).ok).toBe(false);
    expect(validateComicBook({ ...DEFAULT_BOOK_SETTINGS, scriptDocId: null }).ok).toBe(false);
    expect(validateComicBook({ ...DEFAULT_BOOK_SETTINGS }).ok).toBe(true);
  });
});

describe('ids', () => {
  it('mints a panel and a balloon id that match their patterns and avoid taken ids', () => {
    const fixed = (): Uint8Array => new Uint8Array(8).fill(7);
    const first = mintPanelId(new Set(), fixed);
    expect(first).toMatch(PANEL_ID_PATTERN);
    expect(() => mintPanelId(new Set([first]), fixed)).toThrow();
    expect(mintBalloonId(new Set())).toMatch(BALLOON_ID_PATTERN);
  });
});
