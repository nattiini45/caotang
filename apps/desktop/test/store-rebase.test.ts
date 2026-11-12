import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { isOwnWrite, stepStoreRebase, storeRebaseMachine, type StoreRebaseEvent, type StoreRebaseState } from '../src/app/store-rebase.js';

const opened = { body: 'Opened.', revision: 1 };
const next = { body: 'Undo.', revision: 2 };
const idle: StoreRebaseState = { kind: 'idle', token: 0, synced: null };
const synced = stepStoreRebase(idle, { type: 'acknowledge', mark: opened });
const rebasing = stepStoreRebase(synced, { type: 'begin', mark: next });

describe('store rebase ownership', () => {
  it('checks every phase and matching or obsolete completion against its table', () => {
    const states = [idle, synced, rebasing, stepStoreRebase(rebasing, { type: 'fail', token: rebasing.token })];
    const events: StoreRebaseEvent[] = [
      { type: 'begin', mark: next }, { type: 'acknowledge', mark: opened }, { type: 'invalidate' },
      ...[rebasing.token, -1].flatMap((token) => [{ type: 'land' as const, token }, { type: 'fail' as const, token }]),
    ];
    expect(checkMachine(storeRebaseMachine, { states, events })).toEqual([]);
  });

  it('does not call a requested or failed body synced before successful landing', () => {
    expect(rebasing.synced).toEqual(opened);
    expect(stepStoreRebase(rebasing, { type: 'fail', token: rebasing.token }).synced).toEqual(opened);
    expect(stepStoreRebase(rebasing, { type: 'land', token: rebasing.token }).synced).toEqual(next);
  });

  it('invalidates every old completion on own-write acknowledgment and teardown', () => {
    const own = stepStoreRebase(rebasing, { type: 'acknowledge', mark: { body: 'Typed.', revision: 3 } });
    const closed = stepStoreRebase(rebasing, { type: 'invalidate' });
    for (const state of [own, closed]) {
      expect(stepStoreRebase(state, { type: 'land', token: rebasing.token })).toBe(state);
      expect(stepStoreRebase(state, { type: 'fail', token: rebasing.token })).toBe(state);
    }
  });

  it('requires both body and revision for an own write', () => {
    expect(isOwnWrite(opened, opened.body, opened.revision)).toBe(true);
    expect(isOwnWrite(opened, next.body, opened.revision)).toBe(false);
    expect(isOwnWrite(opened, opened.body, next.revision)).toBe(false);
    expect(isOwnWrite(null, opened.body, opened.revision)).toBe(false);
  });
});
