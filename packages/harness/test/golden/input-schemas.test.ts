/**
 * Every registry row's input JSON Schema, as it was before `number` and `nullable` joined the vocabulary. Widening the vocabulary
 * must not change what any existing tool advertises, byte for byte (the key order included), because a host pins what it saw.
 * An input schema that changes on purpose is rewritten with `CAOTANG_UPDATE_GOLDEN=1` and reviewed like a context golden.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeHarness } from '../fixtures.js';

const PATH = resolve(__dirname, 'input-schemas.json');

describe('the input schemas', () => {
  it('are byte-identical to the stored schemas of every row', () => {
    const current: Record<string, unknown> = {};
    for (const tool of makeHarness().tools()) current[tool.name] = tool.schema;
    const text = `${JSON.stringify(current, null, 2)}\n`;
    if (process.env['CAOTANG_UPDATE_GOLDEN'] === '1') writeFileSync(PATH, text);
    const stored = readFileSync(PATH, 'utf8').replace(/\r\n/g, '\n');
    expect(text).toBe(stored);
  });
});
