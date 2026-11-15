import { describe, expect, it } from 'vitest';

import { readShotMeta, writeShotMeta } from '../src/index.js';

describe('unknown shot metadata properties', () => {
  it.each(['__proto__', 'constructor', 'prototype', 'toString'])('keeps %s as owned data without inheriting its values', (key) => {
    const raw: unknown = JSON.parse(`{"${key}":{"fixtureMarker":true},"durationSec":2}`);
    const read = readShotMeta(raw);

    expect(Object.hasOwn(read.unknownFields, key)).toBe(true);
    expect(Object.keys(read.unknownFields)).toEqual([key]);
    expect(read.unknownFields[key]).toEqual({ fixtureMarker: true });
    expect(read.unknownFields['fixtureMarker']).toBeUndefined();
    expect(read.notices).toContain(`unknown field "${key}" is kept in memory and dropped on the next save`);
    expect(writeShotMeta(read)).toEqual({ durationSec: 2 });
    expect(Object.hasOwn(Object.prototype, 'fixtureMarker')).toBe(false);
  });
});
