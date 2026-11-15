/**
 * Proves the WASM hash loads only on derive, not when the adapter is constructed or the package is imported —
 * the structural half of the promise that hash-wasm never enters the first-load bundle. The bundle measurement
 * is the other half.
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loaded: false }));
vi.mock('hash-wasm', async (importOriginal) => {
  state.loaded = true;
  return importOriginal();
});

import { createArgon2idKdf } from '../src/index.js';

describe('lazy loading', () => {
  it('does not load hash-wasm until derive is called', async () => {
    const kdf = createArgon2idKdf({ memoryKiB: 64, iterations: 1, parallelism: 1 });
    expect(state.loaded).toBe(false);
    await kdf.derive(new Uint8Array(8).fill(1), new Uint8Array(16).fill(2));
    expect(state.loaded).toBe(true);
  });
});