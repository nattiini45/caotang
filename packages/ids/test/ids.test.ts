import { describe, expect, it } from 'vitest';
import { CROCKFORD_ALPHABET, isFixedRoot, isGeneratedId, isIdWithPrefix, newId, seededId } from '../src/index.js';

describe('ids', () => {
  it('emits the documented prefix + 10 Crockford base32 chars', () => {
    const id = newId('n');
    expect(id).toMatch(/^n_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
  });

  it('never emits I, L, O or U', () => {
    for (let i = 0; i < 500; i += 1) {
      const body = newId('p').slice(2);
      for (const ch of body) expect(CROCKFORD_ALPHABET).toContain(ch);
    }
  });

  it('re-rolls on collision when a taken set is supplied', () => {
    const first = newId('n');
    const taken = new Set([first]);
    const second = newId('n', { taken });
    expect(second).not.toBe(first);
  });

  // The exhaustion path is the one that is supposed to keep the uniqueness
  // guarantee airtight, so it has to keep the *shape* too: every consumer in the
  // system checks ten Crockford chars after the prefix, and an id of another
  // length is an id no consumer accepts.
  it('re-rolls at the same length when every candidate is taken, and still mints a usable id', () => {
    let draw = 0;
    const source = (n: number): Uint8Array => new Uint8Array(n).fill(draw++ < 8 ? 0 : 1);
    const id = newId('n', { randomBytes: source, taken: new Set(['n_0000000000']) });
    expect(id).toMatch(/^n_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    expect(isGeneratedId(id)).toBe(true);
    expect(id).not.toBe('n_0000000000');
  });

  it('fails loudly when every draw is taken, rather than handing back a duplicate or a malformed id', () => {
    const source = (n: number): Uint8Array => new Uint8Array(n).fill(0);
    expect(() => newId('n', { randomBytes: source, taken: new Set(['n_0000000000']) })).toThrow(
      /could not mint a unique n_ id/,
    );
  });

  it('is deterministic under a seeded generator', () => {
    expect(seededId('c', 42)).toBe(seededId('c', 42));
    expect(seededId('c', 42)).not.toBe(seededId('c', 43));
  });

  it('recognises the three fixed roots as reserved, not generated', () => {
    expect(isFixedRoot('manuscript')).toBe(true);
    expect(isGeneratedId('manuscript')).toBe(false);
    expect(isGeneratedId(newId('n'))).toBe(true);
  });

  // coherence.md §3/§4.1/§4.3 and provider-gateway's `prv_` ids are minted by this family now,
  // so each new prefix must come out in the documented shape. Before this list grew, the
  // coherence module borrowed `c` and swapped the prefix, and this test would fail on that.
  it('mints the coherence and provider prefixes in the documented shape', () => {
    for (const prefix of ['f', 'r', 'w', 'prv'] as const) {
      const id = newId(prefix);
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$`));
      expect(isIdWithPrefix(prefix, id)).toBe(true);
    }
  });

  it('refuses an id of another family even when the body is well formed', () => {
    expect(isIdWithPrefix('f', newId('c'))).toBe(false);
    expect(isIdWithPrefix('prv', newId('p'))).toBe(false);
  });

  it('rejects malformed ids', () => {
    expect(isGeneratedId('n_short')).toBe(false);
    expect(isGeneratedId('n_7K2QX9M4AI')).toBe(false); // trailing I is out of alphabet
    expect(isGeneratedId('nope')).toBe(false);
  });
});
