import { describe, expect, it } from 'vitest';

import { scrollEdges } from '../apps/desktop/src/app/scroll-edges.js';

const box = { scrollTop: 0, scrollLeft: 0, scrollHeight: 600, scrollWidth: 900, clientHeight: 200, clientWidth: 300 };

describe('directional scroll cues', () => {
  it('shows only the edges with content left to read', () => {
    expect(scrollEdges(box)).toBe('bottom end');
    expect(scrollEdges({ ...box, scrollTop: 100, scrollLeft: 100 })).toBe('top bottom start end');
    expect(scrollEdges({ ...box, scrollTop: 400, scrollLeft: 600 })).toBe('top start');
  });

  it('uses logical start and end for negative RTL scroll offsets', () => {
    expect(scrollEdges({ ...box, scrollLeft: -100 })).toBe('bottom start end');
    expect(scrollEdges({ ...box, scrollLeft: -600 })).toBe('bottom start');
  });

  it('ignores rounding, hidden surfaces and non-overflowing content', () => {
    expect(scrollEdges({ ...box, scrollTop: 399.5, scrollLeft: 599.5 })).toBe('top start');
    expect(scrollEdges({ ...box, clientHeight: 600, clientWidth: 900 })).toBe('');
    expect(scrollEdges({ ...box, clientHeight: 0, clientWidth: 0 })).toBe('');
  });
});
