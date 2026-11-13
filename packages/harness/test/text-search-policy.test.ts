import { expect, it } from 'vitest';
import { memoryReadPolicy } from '../src/rules.js';
import { ENTRY, ENTRY_TWO, makeState } from './fixtures.js';

it('fingerprints Never membership rather than codex order or content, retaining the unrestricted encoding', () => {
  const state = makeState();
  const rules = { rules: [] };
  expect(memoryReadPolicy(rules, state)).toBeUndefined();
  state.manifest.codex!.find((entry) => entry.id === ENTRY)!.includePolicy = 'never';
  const first = memoryReadPolicy(rules, state);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  state.manifest.codex!.reverse();
  state.manifest.codex!.find((entry) => entry.id === ENTRY)!.description = 'Changed private words.';
  expect(memoryReadPolicy(rules, state)).toBe(first);
  state.manifest.codex!.find((entry) => entry.id === ENTRY_TWO)!.includePolicy = 'never';
  expect(memoryReadPolicy(rules, state)).not.toBe(first);
  for (const entry of state.manifest.codex!) entry.includePolicy = 'detected';
  expect(memoryReadPolicy(rules, state)).toBeUndefined();
});
