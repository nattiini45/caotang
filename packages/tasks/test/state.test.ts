import { describe, expect, it } from 'vitest';

import { corruptStateFile, emptyTaskState, parseTaskState, serializeTaskState, withHandled } from '../src/state.js';

const ID = 't_5H8QK2M9RT';
const AT = '2026-11-16T01:00:00.000Z';

describe('the machine task state', () => {
  it('round-trips, sorts ids and keeps the trailing newline', () => {
    const file = withHandled(withHandled(emptyTaskState(), 't_ZZZZZZZZZZ', AT), ID, AT);
    const text = serializeTaskState(file);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('t_5H8QK2M9RT')).toBeLessThan(text.indexOf('t_ZZZZZZZZZZ'));
    const parsed = parseTaskState(text);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') expect(parsed.file).toEqual(file);
  });

  it('a missing file is an empty state', () => {
    const parsed = parseTaskState(undefined);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') expect(parsed.file).toEqual(emptyTaskState());
  });

  it('not JSON, a bad lastRuns entry, or a bad version is corrupt', () => {
    expect(parseTaskState('{').kind).toBe('corrupt');
    expect(parseTaskState(JSON.stringify({ formatVersion: 1, lastRuns: { nope: AT } })).kind).toBe('corrupt');
    expect(parseTaskState(JSON.stringify({ formatVersion: 1, lastRuns: { [ID]: 'yesterday' } })).kind).toBe('corrupt');
    expect(parseTaskState(JSON.stringify({ formatVersion: 0, lastRuns: {} })).kind).toBe('corrupt');
    expect(parseTaskState(JSON.stringify({ formatVersion: 1, lastRuns: [] })).kind).toBe('corrupt');
  });

  it('a newer format is named, and a file that claims nothing is foreign', () => {
    const newer = parseTaskState(JSON.stringify({ formatVersion: 2, lastRuns: {} }));
    expect(newer.kind).toBe('newer');
    if (newer.kind === 'newer') expect(newer.formatVersion).toBe(2);
    expect(parseTaskState(JSON.stringify({ hello: 'world' })).kind).toBe('foreign');
  });

  it('withHandled keeps the other entries and the corrupt name is filesystem-safe', () => {
    const file = withHandled(withHandled(emptyTaskState(), ID, AT), 't_ZZZZZZZZZZ', AT);
    expect(file.lastRuns[ID]).toBe(AT);
    expect(corruptStateFile(new Date(AT))).toBe('.corrupt-2026-11-16T01-00-00-000Z');
  });
});
