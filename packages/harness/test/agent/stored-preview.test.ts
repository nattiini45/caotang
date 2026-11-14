import { expect, it } from 'vitest';
import { createContextPort, stagedOf } from '../../src/index.js';
import { LANDING, makeState } from '../fixtures.js';

const preview = () => createContextPort({ state: makeState() }).assemble({ task: { tool: 'scene.draft', focus: LANDING, instruction: 'Continue.' }, role: 'Draft.' }).preview;

it('keeps a valid stored preview byte-for-byte, including cache parts', () => {
  const context = { ...preview(), cache: { key: 'Cached prefix.', prefixTokens: 12, readMultiplier: 0.1 },
    cost: { promptUsd: 0.01, completionUsd: 0.02, totalUsd: 0.03, includesThinking: true, cachedTokens: 0 },
    window: { contextWindow: 32_000, warning: 'A window warning.' },
    images: [{ hash: '0'.repeat(64), size: 24, mime: 'image/png', caption: 'A placeholder.' }],
  };
  context.payload[0]!.parts = [{ text: 'Cached role.', cacheBoundary: true }];
  context.payload[1]!.content = [{ type: 'text', text: 'A placeholder, never image bytes.' }];
  expect(stagedOf({ context }).context).toEqual(context);
});

it('omits malformed stored preview metadata before a card or batch can use it', () => {
  const context = preview();
  for (const damaged of [
    {}, { ...context, payload: null }, { ...context, promptTokens: NaN }, { ...context, images: 'image' },
    { ...context, layers: [{}] }, { ...context, layers: [{ ...context.layers[0], drops: [null] }] },
    { ...context, layers: [{ ...context.layers[0], kept: [{ label: 'Entry', reason: 'Pinned', tokens: 1, ref: { kind: 'asset', id: 'asset' } }] }] },
    { ...context, codex: {} }, { ...context, storySoFar: {} }, { ...context, focus: { summary: {} } },
    { ...context, cache: { key: 'cache' } }, { ...context, cost: { promptUsd: 'free' } },
  ]) expect(stagedOf({ context: damaged }).context).toBeUndefined();
});
