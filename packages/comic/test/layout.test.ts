import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAIL_RATIO,
  TEMPLATE_IDS,
  balloonGeometry,
  balloonReadingOrder,
  balloonStyleData,
  gutterNormalized,
  isNormalizedRect,
  isTemplateId,
  pageGeometry,
  panelReadingOrder,
  readingOrder,
  resolveTailTarget,
  snapMove,
  snapResize,
  starPoints,
  templatePanelCount,
  templateRects,
  type Rect,
} from '../src/index.js';
import { balloon, panel } from './fixtures.js';

const close = (a: readonly number[], b: readonly number[], digits = 9): void => {
  expect(a).toHaveLength(b.length);
  a.forEach((n, i) => expect(n).toBeCloseTo(b[i] as number, digits));
};

describe('pageGeometry', () => {
  it('gives each preset its trim and bleed', () => {
    expect(pageGeometry('us-comic')).toMatchObject({ bleedMm: 3.175 });
    expect(pageGeometry('us-comic').trimWidthMm).toBeCloseTo(168.275, 3);
    expect(pageGeometry('us-comic').trimHeightMm).toBeCloseTo(260.35, 3);
    expect(pageGeometry('manga-b5')).toMatchObject({ trimWidthMm: 182, trimHeightMm: 257, bleedMm: 3 });
    expect(pageGeometry('a4')).toMatchObject({ trimWidthMm: 210, trimHeightMm: 297, bleedMm: 3 });
    expect(pageGeometry('letter').trimWidthMm).toBeCloseTo(215.9, 3);
    expect(pageGeometry('letter').bleedMm).toBeCloseTo(3.175, 3);
  });

  it('keeps the live area inside the trim and draws an unknown size as the default', () => {
    for (const size of ['us-comic', 'manga-b5', 'a4', 'letter']) {
      const g = pageGeometry(size);
      expect(g.liveWidthMm).toBeCloseTo(g.trimWidthMm - 2 * g.liveMarginMm);
      expect(g.aspect).toBeCloseTo(g.liveWidthMm / g.liveHeightMm);
    }
    expect(pageGeometry('tabloid')).toEqual(pageGeometry('us-comic'));
  });
});

describe('templates', () => {
  it('knows its set and the panel count of each', () => {
    expect(TEMPLATE_IDS).toEqual(['splash', '2-tier', '3-tier', 'grid-4', 'grid-6', 'grid-9', 'tier-1-2', 'tier-2-1']);
    expect(TEMPLATE_IDS.map(templatePanelCount)).toEqual([1, 2, 3, 4, 6, 9, 3, 3]);
    expect(isTemplateId('grid-6')).toBe(true);
    expect(isTemplateId('grid-7')).toBe(false);
    expect(isTemplateId('toString')).toBe(false);
  });

  it.each(TEMPLATE_IDS)('%s fills the live area with valid, non-overlapping panels', (id) => {
    const rects = templateRects(id);
    expect(rects).toHaveLength(templatePanelCount(id));
    for (const r of rects) expect(isNormalizedRect(r)).toBe(true);
    for (const [i, a] of rects.entries()) {
      for (const b of rects.slice(i + 1)) {
        const overlap = a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
        expect(overlap).toBe(false);
      }
    }
    expect(Math.min(...rects.map((r) => r[0]))).toBeCloseTo(0);
    expect(Math.max(...rects.map((r) => r[0] + r[2]))).toBeCloseTo(1);
    expect(Math.max(...rects.map((r) => r[1] + r[3]))).toBeCloseTo(1);
  });

  it('puts exactly one gutter between panels on each axis', () => {
    const gutter = gutterNormalized(4, 'us-comic');
    const [a, b, c] = templateRects('grid-6', { gutterMm: 4 }) as [Rect, Rect, Rect];
    expect(b[0] - (a[0] + a[2])).toBeCloseTo(gutter.x);
    expect(c[1] - (a[1] + a[3])).toBeCloseTo(gutter.y);
  });

  it('is a single full-page panel for a splash, whatever the gutter', () => {
    expect(templateRects('splash', { gutterMm: 10 })).toEqual([[0, 0, 1, 1]]);
  });

  it('mirrors for a right-to-left book, so the first panel is top right', () => {
    const ltr = templateRects('grid-4');
    const rtl = templateRects('grid-4', { direction: 'rtl' });
    expect(ltr[0]?.[0]).toBe(0);
    expect(rtl[0]?.[0]).toBeGreaterThan(0.4);
    expect(rtl[0]?.[1]).toBe(0);
    expect(rtl[1]?.[0]).toBe(0);
    expect(panelReadingOrder(rtl.map((r, i) => panel(`p${i}`, [], r)), 'rtl')).toEqual([0, 1, 2, 3]);
    expect(panelReadingOrder(ltr.map((r, i) => panel(`p${i}`, [], r)), 'ltr')).toEqual([0, 1, 2, 3]);
  });

  it('keeps the unequal rows of tier-1-2', () => {
    const [top, left, right] = templateRects('tier-1-2') as [Rect, Rect, Rect];
    expect(top[2]).toBeCloseTo(1);
    expect(left[2]).toBeCloseTo(right[2]);
    expect(left[1]).toBeCloseTo(right[1]);
  });
});

describe('readingOrder', () => {
  const rects: Rect[] = [
    [0.5, 0.52, 0.5, 0.48], // bottom right
    [0, 0, 0.5, 0.5], // top left
    [0.5, 0, 0.5, 0.5], // top right
    [0, 0.52, 0.5, 0.48], // bottom left
  ];

  it('reads rows from the top, left to right', () => {
    expect(readingOrder(rects, (r) => r, 'ltr')).toEqual([1, 2, 3, 0]);
  });

  it('reads right to left for a right-to-left book', () => {
    expect(readingOrder(rects, (r) => r, 'rtl')).toEqual([2, 1, 0, 3]);
  });

  it('reads a tall panel before the two short ones beside it', () => {
    const tall: Rect[] = [
      [0.5, 0.52, 0.5, 0.48],
      [0, 0, 0.45, 1],
      [0.5, 0, 0.5, 0.5],
    ];
    expect(readingOrder(tall, (r) => r, 'ltr')).toEqual([1, 2, 0]);
  });

  it('is stable for an empty list and ties', () => {
    expect(readingOrder([], (r: Rect) => r, 'ltr')).toEqual([]);
    expect(readingOrder([[0, 0, 1, 1] as Rect, [0, 0, 1, 1] as Rect], (r) => r, 'ltr')).toEqual([0, 1]);
  });

  it('orders balloons inside a panel', () => {
    const balloons = [
      balloon('lower', 'b', { rect: [0.1, 0.6, 0.3, 0.1] }),
      balloon('right', 'a2', { rect: [0.6, 0.1, 0.3, 0.1] }),
      balloon('left', 'a1', { rect: [0.1, 0.1, 0.3, 0.1] }),
    ];
    expect(balloonReadingOrder(balloons, 'ltr').map((i) => balloons[i]?.id)).toEqual(['left', 'right', 'lower']);
    expect(balloonReadingOrder(balloons, 'rtl').map((i) => balloons[i]?.id)).toEqual(['right', 'left', 'lower']);
  });
});

describe('gutter snapping', () => {
  const gutter = { x: 0.02, y: 0.015 };
  const options = { gutter, threshold: 0.02 };
  const left: Rect = [0, 0, 0.48, 0.5];

  it('snaps a dragged panel a gutter away from its neighbour', () => {
    const snapped = snapMove([0.505, 0.01, 0.45, 0.4], [left], options);
    expect(snapped[0]).toBeCloseTo(0.48 + gutter.x);
  });

  it('snaps to the edge of the live area', () => {
    const snapped = snapMove([0.52, 0.595, 0.47, 0.4], [], options);
    expect(snapped[0] + snapped[2]).toBeCloseTo(1);
    expect(snapped[1] + snapped[3]).toBeCloseTo(1);
  });

  it('aligns an edge with a neighbour edge', () => {
    const snapped = snapMove([0.015, 0.5 + gutter.y, 0.3, 0.3], [left], options);
    expect(snapped[0]).toBeCloseTo(0);
    expect(snapped[1]).toBeCloseTo(0.5 + gutter.y);
  });

  it('leaves a panel alone that is outside the threshold', () => {
    const rect: Rect = [0.6, 0.1, 0.3, 0.3];
    expect(snapMove(rect, [left], options)).toEqual(rect);
  });

  it('ignores a gutter against a neighbour it does not face', () => {
    const above: Rect = [0, 0, 0.3, 0.2];
    const rect: Rect = [0.31, 0.7, 0.2, 0.2];
    expect(snapMove(rect, [above], options)).toEqual(rect);
  });

  it('keeps a moved rect inside the page', () => {
    const out = snapMove([0.9, 0.9, 0.3, 0.3] as unknown as Rect, [], options);
    expect(out[0] + out[2]).toBeLessThanOrEqual(1 + 1e-12);
  });

  it('snaps only the edges being resized and holds a minimum size', () => {
    const resized = snapResize([0.51, 0, 0.3, 0.5], { left: true }, [left], options);
    expect(resized[0]).toBeCloseTo(0.5);
    expect(resized[0] + resized[2]).toBeCloseTo(0.81);
    expect(resized[1]).toBe(0);
    const tiny = snapResize([0.5, 0, 0.1, 0.5], { right: true }, [{ ...left } as Rect, [0.5, 0, 0.1, 0.5]], {
      ...options,
      minSize: 0.05,
    });
    expect(tiny[2]).toBeGreaterThanOrEqual(0.05);
  });
});

describe('balloon geometry', () => {
  const aspect = pageGeometry('us-comic').aspect;

  it('ends a tail at 55% of the way from the balloon edge to the speaker', () => {
    expect(DEFAULT_TAIL_RATIO).toBe(0.55);
    const b = balloon('b', 'x', { rect: [0.1, 0.1, 0.2, 0.1], tail: [0.7, 0.15] });
    const g = balloonGeometry(b, { aspect });
    expect(g.tail).toBeDefined();
    close(g.tail?.tip ?? [], [0.3 + 0.55 * (0.7 - 0.3), 0.15], 9);
  });

  it('puts the tail base on the balloon outline, either side of the aim', () => {
    const b = balloon('b', 'x', { rect: [0.1, 0.1, 0.2, 0.1], tail: [0.7, 0.15] });
    const [p, q] = balloonGeometry(b, { aspect }).tail?.base ?? [];
    for (const point of [p, q]) {
      const nx = ((point?.[0] ?? 0) - 0.2) / 0.1;
      const ny = ((point?.[1] ?? 0) - 0.15) / 0.05;
      expect(nx * nx + ny * ny).toBeCloseTo(1, 6);
    }
    expect(p?.[1]).not.toBeCloseTo(q?.[1] ?? 0);
  });

  it('honours a custom ratio', () => {
    const b = balloon('b', 'x', { rect: [0.1, 0.1, 0.2, 0.1], tail: [0.7, 0.15] });
    close(balloonGeometry(b, { aspect, tailRatio: 0.5 }).tail?.tip ?? [], [0.5, 0.15], 9);
  });

  it('has no tail without a target, or when the target is inside the balloon', () => {
    expect(balloonGeometry(balloon('b', 'x'), { aspect }).tail).toBeUndefined();
    expect(balloonGeometry(balloon('b', 'x', { rect: [0.1, 0.1, 0.4, 0.2], tail: [0.3, 0.2] }), { aspect }).tail).toBeUndefined();
  });

  it('draws three circles toward the head for a thought, shrinking away from the balloon', () => {
    const b = balloon('b', 'x', { kind: 'thought', rect: [0.1, 0.1, 0.3, 0.12], tail: [0.4, 0.6] });
    const g = balloonGeometry(b, { aspect });
    expect(g.tail).toBeUndefined();
    expect(g.circles).toHaveLength(3);
    const [a, m, z] = g.circles ?? [];
    expect(a!.ry).toBeGreaterThan(m!.ry);
    expect(m!.ry).toBeGreaterThan(z!.ry);
    expect(a!.cy).toBeLessThan(m!.cy);
    expect(m!.cy).toBeLessThan(z!.cy);
    expect(z!.cy).toBeLessThan(0.6);
    expect(a!.rx * aspect).toBeCloseTo(a!.ry);
    expect(g.outline.shape).toBe('cloud');
    expect(g.outline.lobes).toBeGreaterThanOrEqual(8);
  });

  it('describes each kind distinctly', () => {
    const styles = ['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout', 'radio'].map((k) => balloonStyleData(k));
    expect(balloonStyleData('whisper').dash).toEqual([4, 3]);
    expect(balloonStyleData('speech').dash).toBeUndefined();
    expect(balloonStyleData('radio')).toMatchObject({ italic: true, outline: 'spiky' });
    expect(balloonStyleData('shout')).toMatchObject({ outline: 'burst', stroke: 'bold' });
    expect(balloonStyleData('caption')).toMatchObject({ outline: 'rect', tail: 'none' });
    expect(balloonStyleData('sfx')).toMatchObject({ fontRole: 'sfx', outline: 'none' });
    expect(balloonStyleData('thought').tail).toBe('circles');
    expect(new Set(styles.map((s) => JSON.stringify(s))).size).toBe(7);
  });

  it('draws an unknown kind as speech', () => {
    expect(balloonGeometry(balloon('b', 'x', { kind: 'telepathy' }), { aspect }).kind).toBe('speech');
  });

  it('gives a caption and an sfx no tail even with a target', () => {
    expect(balloonGeometry(balloon('b', 'x', { kind: 'caption', tail: [0.9, 0.9] }), { aspect }).tail).toBeUndefined();
    expect(balloonGeometry(balloon('b', 'x', { kind: 'sfx', tail: [0.9, 0.9] }), { aspect }).tail).toBeUndefined();
  });

  it('keeps an on-panel tail inside its panel but lets an off-panel one leave', () => {
    const panelRect: Rect = [0, 0, 0.5, 0.5];
    const inside = balloon('b', 'x', { rect: [0.05, 0.05, 0.2, 0.1], tail: [0.9, 0.2] });
    expect(resolveTailTarget(inside, panelRect)).toEqual([0.5, 0.2]);
    expect(resolveTailTarget({ ...inside, offPanel: true }, panelRect)).toEqual([0.9, 0.2]);
    expect(resolveTailTarget(balloon('b', 'x'), panelRect)).toBeUndefined();
  });

  it('builds burst and spiky outlines as points', () => {
    expect(starPoints([0, 0, 1, 1], 12, 0.2)).toHaveLength(24);
    const g = balloonGeometry(balloon('b', 'x', { kind: 'shout' }), { aspect });
    expect(g.outline.points).toHaveLength(24);
    expect(balloonGeometry(balloon('b', 'x', { kind: 'radio' }), { aspect }).outline.points).toHaveLength(36);
  });

  it('gives a text box inside the balloon', () => {
    const b = balloon('b', 'x', { rect: [0.2, 0.2, 0.4, 0.2] });
    const [x, y, w, h] = balloonGeometry(b, { aspect }).textBox;
    expect(x).toBeGreaterThan(0.2);
    expect(y).toBeGreaterThan(0.2);
    expect(x + w).toBeLessThan(0.6);
    expect(y + h).toBeLessThan(0.4);
  });
});
