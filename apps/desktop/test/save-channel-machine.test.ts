import { expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';

import { aggregateSaveState, channelSource, SaveChannel, saveChannelMachine, type SaveChannelEvent, type SaveChannelState } from '../src/app/save-channel.js';

it('agrees with every table entry, including both queued settlements', () => {
  const states: SaveChannelState[] = [
    { kind: 'idle', failure: null }, { kind: 'failed', failure: 'disk' },
    { kind: 'writing', pending: 1, failure: null }, { kind: 'writing', pending: 2, failure: 'disk' },
  ];
  const events: SaveChannelEvent[] = [{ type: 'enqueue' }, { type: 'settle', failure: null }, { type: 'settle', failure: 'disk' }];
  expect(checkMachine(saveChannelMachine, { states, events })).toEqual([]);
});

it('serializes saves and stays in flight until the last queued write lands', async () => {
  const channel = new SaveChannel('tasks');
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = channel.enqueue(async () => { order.push('first'); await gate; return null; });
  const second = channel.enqueue(async () => { order.push('second'); return null; });
  expect(channel.getSnapshot()).toEqual({ kind: 'writing', pending: 2, failure: null });
  await Promise.resolve();
  expect(order).toEqual(['first']);
  release();
  await first;
  expect(channel.getSnapshot().kind).toBe('writing');
  await channel.settled();
  expect(await second).toBeNull();
  expect(order).toEqual(['first', 'second']);
  expect(channel.getSnapshot()).toEqual({ kind: 'idle', failure: null });
});

it('keeps a refusal visible until a later write succeeds and does not poison the chain', async () => {
  const channel = new SaveChannel('settings');
  const seen: string[] = [];
  const detach = channel.subscribe(() => seen.push(channelSource(channel).state));
  expect(await channel.enqueue(async () => { throw new Error('disk'); })).toBe('disk');
  expect(channelSource(channel).state).toBe('failed');
  const retry = channel.enqueue(async () => null);
  expect(channelSource(channel).state).toBe('failed');
  await retry;
  expect(seen).toEqual(['saving', 'failed', 'failed', 'saved']);
  detach();
});

it('gives conflicts priority, then failures, then any pending source', () => {
  expect(aggregateSaveState([{ state: 'saved' }, { state: 'saving' }])).toBe('saving');
  expect(aggregateSaveState([{ state: 'saving' }, { state: 'failed' }])).toBe('failed');
  expect(aggregateSaveState([{ state: 'failed' }, { state: 'conflict' }])).toBe('conflict');
  expect(aggregateSaveState([{ state: 'saved' }])).toBe('saved');
});
