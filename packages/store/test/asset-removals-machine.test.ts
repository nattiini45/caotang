import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { assetRemovalHeld, assetRemovalHoldMachine, holdAssetRemoval, refuseReferenceToRemoval, type AssetRemovalHoldEvent, type AssetRemovalHoldState } from '../src/asset-removals.js';

const assetId = 'a_0123456789';
const path = `assets/${assetId}.png`;
const holder = {};
const other = {};
const unknown = {};

export const assetRemovalHoldSamples: { states: AssetRemovalHoldState[]; events: AssetRemovalHoldEvent[] } = {
  states: [
    { kind: 'clear' },
    { kind: 'held', holders: [holder] },
    { kind: 'held', holders: [holder, other] },
  ],
  events: [
    { type: 'acquire', holder },
    { type: 'acquire', holder: other },
    { type: 'release', holder },
    { type: 'release', holder: other },
    { type: 'release', holder: unknown },
  ],
};

describe('asset removal holds', () => {
  it('matches its table for empty, single and overlapping holds without changing its inputs', () => {
    for (const state of assetRemovalHoldSamples.states) {
      Object.freeze(state);
      if (state.kind === 'held') Object.freeze(state.holders);
    }
    for (const event of assetRemovalHoldSamples.events) Object.freeze(event);
    expect(checkMachine(assetRemovalHoldMachine, assetRemovalHoldSamples)).toEqual([]);
  });

  it('releases only its own holder and does not count the same holder twice', () => {
    const single: AssetRemovalHoldState = { kind: 'held', holders: [holder] };
    expect(assetRemovalHoldMachine.step(single, { type: 'release', holder: unknown })).toBe(single);
    expect(assetRemovalHoldMachine.step(single, { type: 'acquire', holder })).toBe(single);
    const overlapping = assetRemovalHoldMachine.step(single, { type: 'acquire', holder: other });
    expect(overlapping).toEqual({ kind: 'held', holders: [holder, other] });
    const remaining = assetRemovalHoldMachine.step(overlapping, { type: 'release', holder });
    expect(remaining).toEqual({ kind: 'held', holders: [other] });
    expect(assetRemovalHoldMachine.step(remaining, { type: 'release', holder: other })).toEqual({ kind: 'clear' });
  });

  it('keeps overlapping removals held until each holder releases, ignoring repeated releases', () => {
    const state = {};
    const first = holdAssetRemoval(state, assetId);
    const second = holdAssetRemoval(state, assetId);
    expect(assetRemovalHeld(state, assetId)).toBe(true);
    first();
    first();
    expect(assetRemovalHeld(state, assetId)).toBe(true);
    expect(() => refuseReferenceToRemoval(state, '', path)).toThrow(expect.objectContaining({
      error: expect.objectContaining({ code: 'revision-conflict', target: 'body' }),
    }));
    second();
    expect(assetRemovalHeld(state, assetId)).toBe(false);
    expect(() => refuseReferenceToRemoval(state, '', path)).not.toThrow();
    const third = holdAssetRemoval(state, assetId);
    second();
    expect(assetRemovalHeld(state, assetId)).toBe(true);
    third();
    expect(assetRemovalHeld(state, assetId)).toBe(false);
  });

  it('isolates holds by project and asset, and allows references already present', () => {
    const state = {};
    const otherState = {};
    const release = holdAssetRemoval(state, assetId);
    const releaseOther = holdAssetRemoval(state, 'a_ABCDEFGHIJ');
    expect(assetRemovalHeld(otherState, assetId)).toBe(false);
    expect(() => refuseReferenceToRemoval(otherState, '', path)).not.toThrow();
    expect(() => refuseReferenceToRemoval(state, path, `![Picture](../${path})`)).not.toThrow();
    expect(() => refuseReferenceToRemoval(state, '', 'assets/a_9876543210.webp')).not.toThrow();
    release();
    expect(assetRemovalHeld(state, 'a_ABCDEFGHIJ')).toBe(true);
    releaseOther();
  });
});
