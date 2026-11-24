/**
 * What a page may put in the keychain — desktop.md §The keychain. The host parses every payload before it seals one, so this is
 * where a headers-only profile's payload was refused (#868): a generic endpoint that authenticates with its own headers alone has
 * no key to store, and an empty key with headers is a payload the vault holds.
 */

import { describe, expect, it } from 'vitest';
import { parseVaultHeaders, parseVaultPayload } from '../src/keys/vault-payload.js';

const HEADERS = { 'x-workspace': 'made-up' };

describe('a payload the page may store', () => {
  it('keeps a key, and the headers beside it', () => {
    expect(parseVaultPayload({ apiKey: 'sk-made-up-key-1' })).toEqual({ apiKey: 'sk-made-up-key-1' });
    expect(parseVaultPayload({ apiKey: 'sk-made-up-key-1', customHeaders: HEADERS }))
      .toEqual({ apiKey: 'sk-made-up-key-1', customHeaders: HEADERS });
  });

  it('keeps an empty key when headers come with it, so a profile can authenticate with its headers alone (#868)', () => {
    expect(parseVaultPayload({ apiKey: '', customHeaders: HEADERS })).toEqual({ apiKey: '', customHeaders: HEADERS });
  });

  it('refuses a payload that holds nothing at all, because there would be nothing to seal', () => {
    expect(parseVaultPayload({ apiKey: '' })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: '', customHeaders: {} })).toBeUndefined();
  });

  it('refuses a key that is not text, and a payload that is not an object', () => {
    expect(parseVaultPayload({ apiKey: 42 })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: null, customHeaders: HEADERS })).toBeUndefined();
    expect(parseVaultPayload({ customHeaders: HEADERS })).toBeUndefined();
    expect(parseVaultPayload(null)).toBeUndefined();
    expect(parseVaultPayload('sk-made-up-key-1')).toBeUndefined();
    expect(parseVaultPayload(undefined)).toBeUndefined();
  });

  it('keeps every bound it had: the key, the header count, the names and the values', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x-header-${index}`, 'value']));
    expect(parseVaultPayload({ apiKey: '', customHeaders: tooMany })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: 'k'.repeat(8193) })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: '', customHeaders: { ['x'.repeat(257)]: 'value' } })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: '', customHeaders: { '': 'value' } })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: '', customHeaders: { 'x-workspace': 'v'.repeat(8193) } })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: '', customHeaders: { 'x-workspace': 7 } })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: '', customHeaders: ['x-workspace'] })).toBeUndefined();
    expect(parseVaultPayload({ apiKey: '', customHeaders: null })).toBeUndefined();
    // The bounds are ceilings, not walls: what sits exactly on one is still the writer's to store.
    expect(parseVaultPayload({ apiKey: 'k'.repeat(8192) })?.apiKey).toHaveLength(8192);
  });
});

describe('the headers a page may hand back', () => {
  it('reads a name-to-value object and keeps the bound on how many', () => {
    expect(parseVaultHeaders(HEADERS)).toEqual(HEADERS);
    expect(parseVaultHeaders({})).toEqual({});
    const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x-header-${index}`, 'value']));
    expect(parseVaultHeaders(tooMany)).toBeUndefined();
  });

  it('refuses what is not a name-to-text object', () => {
    expect(parseVaultHeaders(null)).toBeUndefined();
    expect(parseVaultHeaders('x-workspace')).toBeUndefined();
    expect(parseVaultHeaders(['x-workspace'])).toBeUndefined();
    expect(parseVaultHeaders({ 'x-workspace': 7 })).toBeUndefined();
    expect(parseVaultHeaders({ '': 'value' })).toBeUndefined();
  });
});
