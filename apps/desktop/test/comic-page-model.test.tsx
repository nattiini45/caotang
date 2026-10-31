/**
 * The comic page editor's pure model (apps/desktop/src/media/comic-model.ts): the drawn geometry of all seven balloon
 * kinds, gutter snapping, and every gesture's whole-page edit — each planned as one guarded `comic.setPage`
 * (comics.md §3.3). No DOM: the model is tested without a renderer.
 */

import { describe, expect, it } from 'vitest';

import { loadComicPage, pageFromTemplate, serializeComicPage, type Balloon, type ComicPage, type Panel } from '@caotang/comic';

import {
  KEY_STEP,
  drawnPageOf,
  liveOfMm,
  mmOfLive,
  movedPanelRect,
  pageSourceLinksOf,
  resizedPanelRect,
  scriptFromPagesCommand,
  scriptLinkOf,
  setPageCommand,
  withBalloonAdded,
  withBalloonMoved,
  withBalloonPatch,
  withBalloonRemoved,
  withPanelAdded,
  withPanelMoved,
  withPanelPicture,
  withPanelPictureCleared,
  withPanelRect,
  withPanelRemoved,
  withTemplate,
  type DrawnPage,
} from '../src/media/comic-model.js';

const BOOK = { readingDirection: 'ltr', letteringFace: 'comic-neue', capsTransform: true, esszett: false, pageSize: 'us-comic' };

function pageOf(panels: Panel[]): ComicPage {
  return { size: 'us-comic', layout: 'grid-6', panels };
}

function gridPage(): ComicPage {
  return pageFromTemplate({ size: 'us-comic', direction: 'ltr' });
}

function drawnOf(page: ComicPage): DrawnPage {
  return drawnPageOf(serializeComicPage(page), BOOK);
}

function balloonOf(kind: string, over: Partial<Balloon> = {}): Balloon {
  return { id: 'bl_test0001', kind, text: 'Hello', rect: [0.1, 0.1, 0.3, 0.15], ...over } as Balloon;
}

describe('drawnPageOf', () => {
  it('numbers the panels in the stored array order, the order the comic PDF numbers by', () => {
    const page = gridPage();
    // Move the first panel last in the array: its number is 6 now, not its geometric place.
    const reordered = { ...page, panels: [...page.panels.slice(1), page.panels[0] as Panel] };
    const drawn = drawnOf(reordered);
    expect(drawn.panels.map((panel) => panel.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(drawn.panels[5]?.id).toBe(page.panels[0]?.id);
  });

  it('draws the trim and live area in millimetres from the same pageGeometry the PDF reads', () => {
    const drawn = drawnOf(gridPage());
    expect(drawn.width).toBeCloseTo(6.625 * 25.4, 3);
    expect(drawn.height).toBeCloseTo(10.25 * 25.4, 3);
    expect(drawn.live.x).toBeCloseTo(0.3125 * 25.4, 3);
    expect(drawn.live.width).toBeCloseTo(drawn.width - 2 * drawn.live.x, 6);
  });

  it('draws all seven balloon kinds distinctly, from the same balloonGeometry the PDF reads', () => {
    const kinds = ['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout', 'radio'] as const;
    const page = pageOf([{ id: 'pn_1', rect: [0, 0, 1, 1], border: 'thin', balloons: kinds.map((kind, index) => balloonOf(kind, { id: `bl_k${index}`, tail: [0.5, 0.9] })) }]);
    const drawn = drawnOf(page);
    const balloons = drawn.panels[0]?.balloons ?? [];
    const byKind = new Map(balloons.map((balloon) => [balloon.kind, balloon]));

    expect(byKind.get('speech')?.shape).toBe('ellipse');
    expect(byKind.get('speech')?.tail).toBeDefined();
    expect(byKind.get('speech')?.circles).toBeUndefined();

    expect(byKind.get('thought')?.shape).toBe('cloud');
    expect(byKind.get('thought')?.lobes).toBeGreaterThanOrEqual(8);
    // Three thought circles, largest nearest the balloon.
    const circles = byKind.get('thought')?.circles ?? [];
    expect(circles).toHaveLength(3);
    expect(circles[0]?.rx).toBeGreaterThan(circles[1]?.rx ?? 0);
    expect(circles[1]?.rx).toBeGreaterThan(circles[2]?.rx ?? 0);

    expect(byKind.get('caption')?.shape).toBe('rect');
    expect(byKind.get('caption')?.tail).toBeUndefined();

    expect(byKind.get('sfx')?.shape).toBe('none');
    expect(byKind.get('sfx')?.fontRole).toBe('sfx');

    expect(byKind.get('whisper')?.shape).toBe('ellipse');
    expect(byKind.get('whisper')?.dash).toEqual([4, 3]);

    expect(byKind.get('shout')?.shape).toBe('burst');
    expect(byKind.get('shout')?.points).toHaveLength(24);
    expect(byKind.get('shout')?.stroke).toBe('bold');

    expect(byKind.get('radio')?.shape).toBe('spiky');
    expect(byKind.get('radio')?.points).toHaveLength(36);
    expect(byKind.get('radio')?.italic).toBe(true);
  });

  it('ends a speech tail at 55% of the way from the outline edge to its target by default', () => {
    const page = pageOf([{ id: 'pn_1', rect: [0, 0, 1, 1], border: 'thin', balloons: [balloonOf('speech', { rect: [0.1, 0.1, 0.3, 0.15], tail: [0.9, 0.9] })] }]);
    const drawn = drawnOf(page);
    const balloon = drawn.panels[0]?.balloons[0];
    const tail = balloon?.tail;
    expect(tail).toBeDefined();
    if (tail === undefined || balloon === undefined) return;
    // The same edge point the geometry leaves the ellipse at, in the square working space the geometry uses.
    const aspect = drawn.geometry.aspect;
    const [x, y, w, h] = [0.1, 0.1, 0.3, 0.15];
    const a = (w / 2) * aspect;
    const b = h / 2;
    const cx = (x + w / 2) * aspect;
    const cy = y + h / 2;
    const dx = 0.9 * aspect - cx;
    const dy = 0.9 - cy;
    const k = Math.hypot(dx / a, dy / b);
    const ex = cx + dx / k;
    const ey = cy + dy / k;
    const tipX = (ex + (0.9 * aspect - ex) * 0.55) / aspect;
    const tipY = ey + (0.9 - ey) * 0.55;
    const expected = mmOfLive(drawn, [tipX, tipY]);
    expect(tail.tip[0]).toBeCloseTo(expected[0], 6);
    expect(tail.tip[1]).toBeCloseTo(expected[1], 6);
    // And the tip is strictly between the edge and the target, never past it.
    const target = mmOfLive(drawn, [0.9, 0.9]);
    const edge = mmOfLive(drawn, [ex / aspect, ey]);
    const along = (tail.tip[0] - edge[0]) / (target[0] - edge[0]);
    expect(along).toBeCloseTo(0.55, 6);
  });

  it('keeps an off-panel tail aimed outside its panel', () => {
    const page = pageOf([
      {
        id: 'pn_1',
        rect: [0, 0, 0.4, 0.4],
        border: 'thin',
        balloons: [balloonOf('speech', { rect: [0.05, 0.05, 0.2, 0.1], tail: [0.9, 0.9], offPanel: true })],
      },
    ]);
    const drawn = drawnOf(page);
    const tail = drawn.panels[0]?.balloons[0]?.tail;
    expect(tail).toBeDefined();
    if (tail === undefined) return;
    const targetX = drawn.live.x + 0.9 * drawn.live.width;
    expect(tail.tip[0]).toBeGreaterThan(drawn.live.x + 0.4 * drawn.live.width);
    expect(tail.tip[0]).toBeLessThanOrEqual(targetX + 0.001);
  });
});

describe('coordinate space', () => {
  it('maps live-area fractions to millimetres and back', () => {
    const drawn = drawnOf(gridPage());
    const mm = mmOfLive(drawn, [0.5, 0.5]);
    expect(mm[0]).toBeCloseTo(drawn.live.x + 0.5 * drawn.live.width, 6);
    expect(liveOfMm(drawn, mm[0], mm[1])).toEqual([0.5, 0.5]);
    expect(liveOfMm(drawn, -100, 99999)).toEqual([0, 1]);
  });
});

describe('gutter snapping', () => {
  it('snaps a moved panel a gutter away from its neighbour', () => {
    const page = gridPage();
    const first = page.panels[0] as Panel;
    const second = page.panels[1] as Panel;
    const gutterX = 4 / drawnOf(page).geometry.liveWidthMm;
    // Drag the first panel so its right edge comes near the gutter position beside the second: it snaps there.
    const dragged = movedPanelRect(page, first.id, [second.rect[0] - gutterX - first.rect[2] - 0.005, first.rect[1], first.rect[2], first.rect[3]]);
    expect(dragged[0] + dragged[2]).toBeCloseTo(second.rect[0] - gutterX, 6);
  });

  it('snaps a resize edge to the neighbour and never below the minimum size', () => {
    const page = gridPage();
    const first = page.panels[0] as Panel;
    const second = page.panels[1] as Panel;
    const gutterX = 4 / drawnOf(page).geometry.liveWidthMm;
    const resized = resizedPanelRect(page, first.id, { right: true }, [first.rect[0], first.rect[1], second.rect[0] - gutterX - first.rect[0] - 0.005, first.rect[3]]);
    expect(resized[0] + resized[2]).toBeCloseTo(second.rect[0] - gutterX, 6);
    const tiny = resizedPanelRect(page, first.id, { right: true, bottom: true }, [first.rect[0], first.rect[1], 0.001, 0.001]);
    expect(tiny[2]).toBeGreaterThanOrEqual(0.02);
    expect(tiny[3]).toBeGreaterThanOrEqual(0.02);
  });

  it('keeps a one per cent keyboard nudge off a gutter-aligned edge, which the pointer reach would pull straight back', () => {
    const page = gridPage();
    const second = page.panels[1] as Panel;
    const [x, y, width, height] = second.rect;

    const pulled = resizedPanelRect(page, second.id, { left: true }, [x - KEY_STEP, y, width + KEY_STEP, height]);
    expect(pulled[0]).toBeCloseTo(x, 6);

    const widened = resizedPanelRect(page, second.id, { left: true }, [x - KEY_STEP, y, width + KEY_STEP, height], true);
    expect(widened[0]).toBeCloseTo(x - KEY_STEP, 6);
    expect(widened[2]).toBeCloseTo(width + KEY_STEP, 6);

    const moved = movedPanelRect(page, second.id, [x, y + KEY_STEP, width, height], true);
    expect(moved[1]).toBeCloseTo(y + KEY_STEP, 6);
  });
});

describe('page edits', () => {
  it('applies a template as a starting point, keeping the layout id', () => {
    const page = withTemplate(gridPage(), 'splash', 'ltr', 'us-comic');
    expect(page.layout).toBe('splash');
    expect(page.panels).toHaveLength(1);
    expect(page.panels[0]?.rect).toEqual([0, 0, 1, 1]);
    const six = withTemplate(page, 'grid-6', 'ltr', 'us-comic');
    expect(six.panels).toHaveLength(6);
  });

  it('mirrors a template for a right-to-left book', () => {
    const page = withTemplate(gridPage(), 'grid-6', 'rtl', 'us-comic');
    // The first panel of an RTL grid is the top right one.
    expect(page.panels[0]?.rect[0]).toBeGreaterThan(0.5);
  });

  it('moves a panel in the stored reading order', () => {
    const page = gridPage();
    const firstId = (page.panels[0] as Panel).id;
    const moved = withPanelMoved(page, firstId, 1);
    expect(moved.panels[1]?.id).toBe(firstId);
    expect(withPanelMoved(page, firstId, -1).panels[0]?.id).toBe((page.panels[0] as Panel).id);
  });

  it('adds and removes panels, keeping ids unique', () => {
    const page = withPanelAdded(gridPage(), [0.2, 0.2, 0.3, 0.3]);
    expect(page.panels).toHaveLength(7);
    const added = page.panels[6] as Panel;
    expect(added.id.startsWith('pn_')).toBe(true);
    expect(withPanelRemoved(page, added.id).panels).toHaveLength(6);
  });

  it('sets, moves and clears a panel rect and picture', () => {
    const page = gridPage();
    const id = (page.panels[0] as Panel).id;
    expect(withPanelRect(page, id, [0.1, 0.1, 0.2, 0.2]).panels[0]?.rect).toEqual([0.1, 0.1, 0.2, 0.2]);
    const pictured = withPanelPicture(page, id, 'a_ABC123', [0, 0, 0.5, 1]);
    expect(pictured.panels[0]?.assetId).toBe('a_ABC123');
    expect(pictured.panels[0]?.crop).toEqual([0, 0, 0.5, 1]);
    const cleared = withPanelPictureCleared(pictured, id);
    expect(cleared.panels[0]?.assetId).toBeUndefined();
    expect(cleared.panels[0]?.crop).toBeUndefined();
  });

  it('adds, patches, moves and removes balloons on a panel', () => {
    const page = gridPage();
    const panelId = (page.panels[0] as Panel).id;
    const withOne = withBalloonAdded(page, panelId, 'speech');
    const balloon = (withOne.panels[0]?.balloons[0] ?? {}) as Balloon;
    expect(balloon.id.startsWith('bl_')).toBe(true);
    expect(balloon.kind).toBe('speech');

    const patched = withBalloonPatch(withOne, panelId, balloon.id, { kind: 'whisper', text: 'psst', tail: [0.5, 0.8] });
    const edited = patched.panels[0]?.balloons[0] as Balloon;
    expect(edited.kind).toBe('whisper');
    expect(edited.text).toBe('psst');
    expect(edited.tail).toEqual([0.5, 0.8]);

    const withTwo = withBalloonAdded(patched, panelId, 'thought');
    const second = withTwo.panels[0]?.balloons[1] as Balloon;
    const moved = withBalloonMoved(withTwo, panelId, second.id, -1);
    expect(moved.panels[0]?.balloons[0]?.id).toBe(second.id);
    expect(withBalloonRemoved(withTwo, panelId, second.id).panels[0]?.balloons).toHaveLength(1);
  });
});

describe('the one guarded command', () => {
  it('sends the whole page with the stored value as expect', () => {
    const node = { id: 'pg_1', parentId: 'bk_1', type: 'comic-page', title: 'Page 1', order: 10, comicPage: serializeComicPage(gridPage()) } as never;
    const command = setPageCommand(node, withPanelAdded(loadComicPage(node.comicPage).value, [0.2, 0.2, 0.3, 0.3]));
    expect(command.name).toBe('comic.setPage');
    expect(command.params.nodeId).toBe('pg_1');
    expect(command.params.expect).toEqual(node.comicPage);
    expect(loadComicPage(command.params.stored).value.panels).toHaveLength(7);
  });

  it('takes an explicit expect, the value the photo return read when its review opened', () => {
    const node = { id: 'pg_1', parentId: 'bk_1', type: 'comic-page', title: 'Page 1', order: 10, comicPage: serializeComicPage(gridPage()) } as never;
    const stale = { size: 'us-comic', panels: [] };
    const command = setPageCommand(node, gridPage(), stale);
    expect(command.params.expect).toEqual(stale);
  });
});

describe('the page-level source links', () => {
  it('reads the source-role links of one page and no other role', () => {
    const links = [
      { id: 'l_1', assetId: 'a_1', role: 'source', target: { kind: 'node', nodeId: 'pg_1' } },
      { id: 'l_2', assetId: 'a_2', role: 'reference', target: { kind: 'node', nodeId: 'pg_1' } },
      { id: 'l_3', assetId: 'a_3', role: 'source', target: { kind: 'node', nodeId: 'pg_2' } },
      { id: 'l_4', assetId: 'a_4', role: 'card', target: { kind: 'node', nodeId: 'pg_1' } },
    ];
    expect(pageSourceLinksOf(links, 'pg_1')).toEqual([{ linkId: 'l_1', assetId: 'a_1', note: undefined }]);
    expect(pageSourceLinksOf(undefined, 'pg_1')).toEqual([]);
  });
});

describe('the script link and writing the script from the pages', () => {
  const book = (comic?: unknown) => ({ id: 'bk_1', type: 'folder', kind: 'comic', title: 'Book', parentId: null, order: 0, comic }) as never;
  const doc = (kind: string | undefined) => ({ id: 'sc_1', type: 'document', kind, title: 'The script', parentId: null, order: 1 });
  const stateOf = (nodes: unknown[], revisions: [string, number][] = []) =>
    ({ manifest: { tree: nodes }, documents: new Map(revisions.map(([id, revision]) => [id, { revision }])) }) as never;
  const linkedBook = book({ ...BOOK, scriptDocId: 'sc_1' });

  it('reads no link, a link to a comic script with its revision, and a broken link', () => {
    expect(scriptLinkOf(stateOf([]), book(BOOK))).toEqual({ kind: 'none' });
    expect(scriptLinkOf(stateOf([doc('comic-script')], [['sc_1', 4]]), linkedBook)).toEqual({ kind: 'linked', docId: 'sc_1', title: 'The script', revision: 4 });
    expect(scriptLinkOf(stateOf([doc('comic-script')]), linkedBook)).toEqual({ kind: 'linked', docId: 'sc_1', title: 'The script', revision: 0 });
    expect(scriptLinkOf(stateOf([]), linkedBook)).toEqual({ kind: 'broken', docId: 'sc_1' });
  });

  it('treats a linked document that is not a comic script as broken, never re-matching by title', () => {
    expect(scriptLinkOf(stateOf([doc(undefined)]), linkedBook)).toEqual({ kind: 'broken', docId: 'sc_1' });
    expect(scriptLinkOf(stateOf([{ ...doc('comic-script'), id: 'other' }]), linkedBook)).toEqual({ kind: 'broken', docId: 'sc_1' });
  });

  it('sends the revision it read when the book has a script, and none when it does not', () => {
    const linked = { kind: 'linked', docId: 'sc_1', title: 'The script', revision: 4 } as const;
    expect(scriptFromPagesCommand(linkedBook, linked, 3)).toEqual({ name: 'comic.scriptFromPages', params: { nodeId: 'bk_1', expectedRevision: 4 } });
    expect(scriptFromPagesCommand(book(BOOK), { kind: 'none' }, 3)).toEqual({ name: 'comic.scriptFromPages', params: { nodeId: 'bk_1' } });
  });

  it('sends the revision 0 of a script that has never been written, so a write since is still refused', () => {
    const linked = { kind: 'linked', docId: 'sc_1', title: 'The script', revision: 0 } as const;
    expect(scriptFromPagesCommand(linkedBook, linked, 1)?.params).toEqual({ nodeId: 'bk_1', expectedRevision: 0 });
  });

  it('offers nothing for a broken link or a book with no pages', () => {
    expect(scriptFromPagesCommand(linkedBook, { kind: 'broken', docId: 'sc_1' }, 3)).toBeNull();
    expect(scriptFromPagesCommand(book(BOOK), { kind: 'none' }, 0)).toBeNull();
  });
});