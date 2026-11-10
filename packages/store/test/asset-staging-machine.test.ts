import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { assetStagingMachine, createAssetStaging, StagingError, type AssetStagingEvent, type AssetStagingState } from '../src/asset-staging.js';

const bytes = Uint8Array.of(1, 2, 3);

export const assetStagingSamples: { states: AssetStagingState[]; events: AssetStagingEvent[] } = {
  states: [
    { kind: 'staged' },
    { kind: 'staged-cancelled' },
    { kind: 'reserved', reservationId: 'reservation' },
    { kind: 'reserved-cancelled', reservationId: 'reservation' },
    { kind: 'removed' },
    { kind: 'removed-cancelled' },
  ],
  events: [
    { type: 'reserve', reservationId: 'reservation' },
    { type: 'reserve', reservationId: 'other' },
    { type: 'commit', reservationId: 'reservation' },
    { type: 'commit', reservationId: 'other' },
    { type: 'release', reservationId: 'reservation' },
    { type: 'release', reservationId: 'other' },
    { type: 'take' },
    { type: 'discard' },
    { type: 'cancel' },
  ],
};

describe('staged picture reservations', () => {
  it('matches its table for every state and event without changing its inputs', () => {
    for (const state of assetStagingSamples.states) Object.freeze(state);
    for (const event of assetStagingSamples.events) Object.freeze(event);
    expect(checkMachine(assetStagingMachine, assetStagingSamples)).toEqual([]);
  });

  it('keeps another reservation from committing or releasing a token', () => {
    for (const kind of ['reserved', 'reserved-cancelled'] as const) {
      const state = { kind, reservationId: 'owner' };
      for (const type of ['commit', 'release'] as const) {
        expect(assetStagingMachine.step(state, { type, reservationId: 'other' })).toBe(state);
      }
    }
  });

  it('copies staged bytes and keeps take single-use, including after cancellation', () => {
    const staging = createAssetStaging();
    const source = bytes.slice();
    const id = staging.stage(source);
    source[0] = 9;
    staging.cancel([id]);
    expect(staging.take(id)).toEqual(bytes);
    expect(staging.take(id)).toBeUndefined();
  });

  it('reserves every id or none for unknown, duplicate, reserved and foreign ids', () => {
    const staging = createAssetStaging('project');
    const first = staging.stage(bytes);
    const second = staging.stage(bytes);
    const reserved = staging.reserve([second]);
    for (const [ids, scope, reason] of [
      [[first, 'unknown'], 'project', 'unknown'],
      [[first, first], 'project', 'reserved'],
      [[first, second], 'project', 'reserved'],
      [[first], 'other', 'scope'],
    ] as const) {
      expect(() => staging.reserve(ids, scope)).toThrow(expect.objectContaining({ reason }));
    }
    expect(staging.take(first)).toEqual(bytes);
    expect(staging.take(second)).toBeUndefined();
    staging.release(reserved.id);
    expect(staging.take(second)).toEqual(bytes);
  });

  it('keeps cancellation on reserve and clears it on release for a retry', () => {
    const staging = createAssetStaging();
    const id = staging.stage(bytes);
    staging.cancel([id]);
    const first = staging.reserve([id]);
    expect(first.isCancelled()).toBe(true);
    staging.release(first.id);
    expect(first.isCancelled()).toBe(false);
    const retry = staging.reserve([id]);
    expect(retry.isCancelled()).toBe(false);
    staging.cancel([id]);
    expect(retry.isCancelled()).toBe(true);
    expect(first.isCancelled()).toBe(true);
    staging.commit(first.id);
    staging.release(first.id);
    expect(staging.take(id)).toBeUndefined();
    staging.release(retry.id);
    expect(staging.take(id)).toEqual(bytes);
  });

  for (const finish of ['commit', 'discard'] as const) {
    for (const cancelled of [false, true]) {
      it(`keeps an existing reservation's cancellation after ${finish} (${cancelled})`, () => {
        const staging = createAssetStaging();
        const id = staging.stage(bytes);
        const reservation = staging.reserve([id]);
        if (cancelled) staging.cancel([id]);
        if (finish === 'commit') staging.commit(reservation.id);
        else staging.discard([id]);
        staging.release(reservation.id);
        staging.cancel([id]);
        expect(reservation.isCancelled()).toBe(cancelled);
        expect(staging.take(id)).toBeUndefined();
        expect(() => staging.reserve([id])).toThrow(StagingError);
      });
    }
  }

  it('reports cancellation of any batch member and releases the others after a discard', () => {
    const staging = createAssetStaging();
    const first = staging.stage(bytes);
    const second = staging.stage(bytes);
    const reservation = staging.reserve([first, second]);
    staging.cancel([second]);
    expect(reservation.isCancelled()).toBe(true);
    staging.discard([second]);
    staging.release(reservation.id);
    expect(reservation.isCancelled()).toBe(true);
    expect(staging.take(first)).toEqual(bytes);
    expect(staging.take(second)).toBeUndefined();
  });
});
