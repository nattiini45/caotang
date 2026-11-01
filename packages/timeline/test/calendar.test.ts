import { describe, expect, it } from 'vitest';

import { MAX_TICKS, buildTimeline, createDayLens, dayLens, type DayLensMessages } from '../src/index.js';

import { coherence, project } from './fixtures.js';

const GERMAN: DayLensMessages = {
  day: (n) => `Tag ${n}`,
  week: (n) => `Woche ${n}`,
  month: (n) => `Monat ${n}`,
  year: (n) => `Jahr ${n}`,
  days: (n) => `${n} Tage`,
  months: (n) => `${n} Monate`,
  years: (n) => `${n} Jahre`,
  about: (text) => `etwa ${text}`,
};

describe('dayLens (§3.8)', () => {
  it('is a version-1 lens', () => {
    expect(dayLens).toMatchObject({ id: 'day', lensApi: 1 });
  });

  it('reads back what it writes, in either form, and in the words and digits of its locale', () => {
    for (const day of [0, 12, -14, 4380, -3650, -10_000_000, 10_000_000]) {
      for (const form of ['short', 'long'] as const) expect(dayLens.parse(dayLens.label(day, form))).toBe(day);
    }
    const german = createDayLens({ locale: 'de', messages: GERMAN });
    expect(german.parse('Tag 4.380')).toBe(4380);
    expect(german.parse(german.label(-3650, 'long'))).toBe(-3650);
    expect(dayLens.parse('day -14')).toBe(-14);
    expect(dayLens.parse('12')).toBe(12);
    for (const bad of ['', 'Day', 'Day 1,2', 'Day 12x', 'Tomorrow', 'Day 1.5']) expect(dayLens.parse(bad)).toBeNull();
  });

  it('labels days with a real minus sign for negative days, grouped in the long form', () => {
    expect(dayLens.label(12, 'short')).toBe('Day 12');
    expect(dayLens.label(0, 'short')).toBe('Day 0');
    expect(dayLens.label(-14, 'short')).toBe('Day \u221214');
    expect(dayLens.label(4380, 'long')).toBe('Day 4,380');
    expect(dayLens.label(-3650, 'long')).toBe('Day \u22123,650');
    expect(dayLens.label(-10_000_000, 'short')).toBe('Day \u221210000000');
  });

  it('measures spans in days, months of 30 and years of 365, and says "about" only when it rounds', () => {
    expect(dayLens.span(0, 1)).toBe('1 day');
    expect(dayLens.span(0, 29)).toBe('29 days');
    expect(dayLens.span(0, 60)).toBe('2 months');
    expect(dayLens.span(0, 75)).toBe('about 3 months');
    expect(dayLens.span(0, 350)).toBe('about 1 year');
    expect(dayLens.span(0, 365)).toBe('1 year');
    expect(dayLens.span(0, 3650)).toBe('10 years');
    expect(dayLens.span(0, 3649)).toBe('about 10 years');
  });

  it('does not care which end comes first, or whether the days are negative', () => {
    expect(dayLens.span(3650, 0)).toBe('10 years');
    expect(dayLens.span(-3650, 0)).toBe('10 years');
    expect(dayLens.span(-100, -40)).toBe('2 months');
    expect(dayLens.span(-5, 5)).toBe('10 days');
  });

  it('takes its digits from the locale and its words from the messages it is given', () => {
    const german = createDayLens({ locale: 'de', messages: GERMAN });
    expect(german.label(4380, 'long')).toBe('Tag 4.380');
    expect(german.span(0, 3649)).toBe('etwa 10 Jahre');
  });

  it('ticks weeks every 7 days from day 0, including across it', () => {
    const ticks = dayLens.ticks([-20, 20], 8);
    expect(ticks.map((tick) => tick.day)).toEqual([-14, -7, 0, 7, 14]);
    expect(ticks.map((tick) => tick.level)).toEqual([1, 1, 3, 1, 1]);
    expect(ticks.map((tick) => tick.label)).toEqual(['Week \u22122', 'Week \u22121', 'Day 0', 'Week 1', 'Week 2']);
  });

  it('ticks every day at day zoom and marks week and year boundaries above it', () => {
    const ticks = dayLens.ticks([-3, 10], 48);
    expect(ticks).toHaveLength(14);
    expect(ticks.find((tick) => tick.day === 5)).toMatchObject({ level: 0, label: 'Day 5' });
    expect(ticks.find((tick) => tick.day === 7)).toMatchObject({ level: 1, label: 'Week 1' });
    expect(ticks.find((tick) => tick.day === -3)?.level).toBe(0);
  });

  it('ticks months and years at coarse zoom, negative years included', () => {
    expect(dayLens.ticks([0, 100], 1.5).map((tick) => [tick.day, tick.label])).toEqual([[0, 'Day 0'], [30, 'Month 1'], [60, 'Month 2'], [90, 'Month 3']]);
    const years = dayLens.ticks([-800, 800], 0.1);
    expect(years.map((tick) => tick.day)).toEqual([-730, -365, 0, 365, 730]);
    expect(years.map((tick) => tick.label)).toEqual(['Year \u22122', 'Year \u22121', 'Day 0', 'Year 1', 'Year 2']);
  });

  it('bounds the ticks whatever the range', () => {
    for (const range of [[-10_000_000, 10_000_000], [0, 100_000], [-500, 100_000_000]] as const) {
      const ticks = dayLens.ticks(range, 48);
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
      expect(ticks.every((tick) => tick.day >= range[0] && tick.day <= range[1])).toBe(true);
    }
    expect(dayLens.ticks([0, 10], 0)).toEqual([]);
    expect(dayLens.ticks([10, 0], 48)).toHaveLength(11);
  });

  it('never writes -0 as a tick day', () => {
    expect(Object.is(dayLens.ticks([-3, 3], 8).find((tick) => tick.day === 0)?.day, 0)).toBe(true);
  });
});

describe('lens in the model', () => {
  it('puts ticks on each axis segment, and a swapped lens changes labels without changing a stored value', () => {
    const state = project({ scenes: [{ id: 'a' }, { id: 'b' }] });
    const file = coherence({ a: { dayOffset: -21 }, b: { dayOffset: 21 } });
    const before = structuredClone(file);
    const model = buildTimeline(state, file, { axis: 'story', zoom: 'week' });
    expect(model.axis.ticks.length).toBeGreaterThan(0);
    expect(model.axis.ticks.every((tick) => tick.segment >= 0 && tick.part === 'main')).toBe(true);
    const custom = createDayLens({ id: 'x', name: 'X', messages: { ...GERMAN, day: (n) => `D${n}` } });
    const other = buildTimeline(state, file, { axis: 'story', zoom: 'week', lens: custom });
    expect(other.items[0]?.a11yLabel).toContain('D\u221221');
    expect(model.items[0]?.a11yLabel).toContain('Day \u221221');
    expect(file).toEqual(before);
    expect(other.items.map((item) => [item.start, item.end])).toEqual(model.items.map((item) => [item.start, item.end]));
  });

  it('is bounded for the widest legal story', () => {
    const state = project({ scenes: [{ id: 'a' }, { id: 'b' }] });
    const model = buildTimeline(state, coherence({ a: { dayOffset: -10_000_000 }, b: { dayOffset: 10_000_000 } }), { axis: 'story', zoom: 'day' });
    expect(model.axis.ticks.length).toBeLessThanOrEqual(MAX_TICKS * 2);
    expect(model.axis.breaks).toMatchObject([{ days: 19_999_999 }]);
    expect(model.axis.folds).toEqual([]);
  });
});
