import { describe, expect, it } from 'vitest';

import { pageGeometry, proposedPanelCrop, pageNumberOfFileName, planPhotoReturn, clampUnitRect } from '../src/index.js';

describe('pageNumberOfFileName', () => {
  it('reads the leading number of a photographed page', () => {
    expect(pageNumberOfFileName('0012.jpg')).toBe(12);
    expect(pageNumberOfFileName('1.png')).toBe(1);
    expect(pageNumberOfFileName('007.jpeg')).toBe(7);
    expect(pageNumberOfFileName('0000.jpg')).toBe(0);
  });

  it('leaves a name without a number alone', () => {
    expect(pageNumberOfFileName('page.jpg')).toBeUndefined();
    expect(pageNumberOfFileName('12.jpg.txt')).toBeUndefined();
    expect(pageNumberOfFileName('scan 12.jpg')).toBeUndefined();
    expect(pageNumberOfFileName('')).toBeUndefined();
  });
});

describe('planPhotoReturn', () => {
  it('maps each numbered photograph to its page, in page order', () => {
    const plan = planPhotoReturn(['0003.jpg', '0001.jpg', '0002.png'], 3);
    expect(plan).toEqual({
      ok: true,
      assignments: [
        { name: '0001.jpg', pageNumber: 1 },
        { name: '0002.png', pageNumber: 2 },
        { name: '0003.jpg', pageNumber: 3 },
      ],
    });
  });

  it('refuses the whole batch on a duplicate number and names the later file', () => {
    const plan = planPhotoReturn(['0001.jpg', '0001.png', '0002.jpg'], 3);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals).toEqual([{ name: '0001.png', reason: 'duplicate-page', pageNumber: 1 }]);
  });

  it('refuses a number the book has no page for, including zero and past the end', () => {
    const plan = planPhotoReturn(['0000.jpg', '0009.jpg', '0002.jpg'], 3);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals).toEqual([
      { name: '0000.jpg', reason: 'no-such-page', pageNumber: 0 },
      { name: '0009.jpg', reason: 'no-such-page', pageNumber: 9 },
    ]);
  });

  it('refuses a file with no page number, and reports every refusal together', () => {
    const plan = planPhotoReturn(['drawing.png', '0002.jpg', '0002.jpg'], 2);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals).toEqual([
      { name: 'drawing.png', reason: 'no-number' },
      { name: '0002.jpg', reason: 'duplicate-page', pageNumber: 2 },
    ]);
  });

  it('takes a whole book in one batch', () => {
    const names = Array.from({ length: 12 }, (_, index) => `00${String(index + 1).padStart(2, '0')}.jpg`);
    const plan = planPhotoReturn(names, 12);
    expect(plan.ok && plan.assignments).toHaveLength(12);
  });
});

describe('proposedPanelCrop', () => {
  it('maps a panel rect from live-area space into the photographed trim', () => {
    const geometry = pageGeometry('us-comic');
    const crop = proposedPanelCrop([0, 0, 0.5, 0.5], 'us-comic');
    // The top-left quarter of the live area, moved in by the live margin and scaled to the trim.
    expect(crop[0]).toBeCloseTo((geometry.liveMarginMm + 0) / geometry.trimWidthMm, 6);
    expect(crop[1]).toBeCloseTo(geometry.liveMarginMm / geometry.trimHeightMm, 6);
    expect(crop[2]).toBeCloseTo((0.5 * geometry.liveWidthMm) / geometry.trimWidthMm, 6);
    expect(crop[3]).toBeCloseTo((0.5 * geometry.liveHeightMm) / geometry.trimHeightMm, 6);
  });

  it('keeps a full-page panel inside the photograph', () => {
    const crop = proposedPanelCrop([0, 0, 1, 1], 'a4');
    expect(crop[0]).toBeGreaterThan(0);
    expect(crop[1]).toBeGreaterThan(0);
    expect(crop[0] + crop[2]).toBeLessThan(1);
    expect(crop[1] + crop[3]).toBeLessThan(1);
  });
});

describe('clampUnitRect', () => {
  it('clamps into 0..1 and keeps a minimum size', () => {
    expect(clampUnitRect([-0.5, 2, 0.001, 9])).toEqual([0, 1, 0.02, 0.02]);
    expect(clampUnitRect([0.4, 0.4, 0.3, 0.3])).toEqual([0.4, 0.4, 0.3, 0.3]);
  });
});
