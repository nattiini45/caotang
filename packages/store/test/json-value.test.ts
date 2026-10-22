/**
 * The JSON-safety rule the loader and the writer share — `json-value.ts`.
 *
 * The rule is one sentence: a value JSON cannot hold is dropped by the load and
 * refused by the writer, so a project that loads can be saved and a value that
 * cannot be saved never changes quietly on the way to the file.
 *
 * **The walk is checked all the way down**, because a value that cannot be
 * written is often inside another value: a media note is an object, and a
 * number that is not finite sits in it.
 *
 * The three holes this file pins are the ones JSON hides rather than refuses:
 * a value that refers to itself (the walk would run until the stack ran out),
 * a Map or a Set (JSON writes them as `{}`, so their contents are dropped
 * without a word), and a Date (JSON writes it as a string, so the value
 * changes). None of them can arrive from a file — `JSON.parse` makes none of
 * them — but all of them can reach a hand-built state, and the rule promises
 * that a value JSON cannot hold is named rather than written.
 */

import { describe, expect, it } from 'vitest';
import { isJsonNumber, jsonValueProblem } from '../src/json-value.js';

describe('what JSON can hold (json-value.ts)', () => {
  it('has no problem with plain objects, arrays and scalars', () => {
    expect(jsonValueProblem({ a: [1, 'two', null, true], b: { c: {} } })).toBeUndefined();
    expect(jsonValueProblem('text')).toBeUndefined();
    expect(jsonValueProblem(null)).toBeUndefined();
  });

  it('names the value JSON cannot hold, and where it sits', () => {
    expect(jsonValueProblem({ duration: Number.POSITIVE_INFINITY })).toEqual({
      path: '.duration',
      reason: 'Infinity is not a JSON number',
    });
    expect(jsonValueProblem({ at: undefined })).toEqual({
      path: '.at',
      reason: 'the value is not there, and a field that is not there cannot be written as JSON',
    });
    expect(jsonValueProblem({ big: 10n })).toEqual({ path: '.big', reason: 'a BigInt is not JSON' });
  });

  it('refuses a value that refers to itself, instead of running until the stack runs out', () => {
    const shot: Record<string, unknown> = { duration: 3 };
    shot['self'] = shot;

    expect(jsonValueProblem(shot)).toEqual({
      path: '.self',
      reason: 'the value refers to itself, and JSON cannot write that',
    });
  });

  it('refuses an array that holds itself', () => {
    const list: unknown[] = [1];
    list.push(list);

    expect(jsonValueProblem(list)).toEqual({
      path: '[1]',
      reason: 'the value refers to itself, and JSON cannot write that',
    });
  });

  it('keeps a value that appears twice, because that is not a cycle', () => {
    const shared = { duration: 3 };

    expect(jsonValueProblem({ a: shared, b: shared })).toBeUndefined();
  });

  it('refuses a Map or a Set, which JSON writes as {} and drops the contents of', () => {
    const map = jsonValueProblem({ tags: new Map([['a', 1]]) });
    expect(map?.path).toBe('.tags');
    expect(map?.reason).toMatch(/written as \{\}/);

    const set = jsonValueProblem({ tags: new Set(['a']) });
    expect(set?.path).toBe('.tags');
    expect(set?.reason).toMatch(/written as \{\}/);
  });

  it('refuses a Date, which JSON writes as a string', () => {
    const problem = jsonValueProblem({ when: new Date(0) });

    expect(problem?.path).toBe('.when');
    expect(problem?.reason).toMatch(/a Date is written as a string/);
  });

  it('knows a number JSON can hold from one it cannot', () => {
    expect(isJsonNumber(0)).toBe(true);
    expect(isJsonNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonNumber(Number.NaN)).toBe(false);
    expect(isJsonNumber('1')).toBe(false);
  });
});
