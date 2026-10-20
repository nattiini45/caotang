/**
 * The key vault — provider-gateway.md §7. The round trip runs on the real WebCrypto
 * implementation (`globalThis.crypto.subtle`, which Node 24 provides), and the IndexedDB
 * binding runs on the store's headless IDB, which the store's README argues is the honest
 * stand-in for browser storage in tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryIndexedDb } from '@caotang/store';
import {
  createIndexedDbVaultPort,
  createKeyStore,
  createMemoryVaultPort,
  type KeyVaultPort,
} from '../src/index.js';
import { KEY } from './helpers.js';

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** True when `needle`'s bytes appear contiguously inside `haystack`. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe('AES-GCM key store on WebCrypto', () => {
  it('round-trips a key: what is put is what reveal returns', async () => {
    const store = createKeyStore(createMemoryVaultPort());
    await store.put('prv_AAAAAAAAAA', KEY);
    expect(await store.reveal('prv_AAAAAAAAAA')).toBe(KEY);
    expect(await store.has('prv_AAAAAAAAAA')).toBe(true);
  });

  it('reveals nothing for an id it never stored, and nothing after removal', async () => {
    const store = createKeyStore(createMemoryVaultPort());
    expect(await store.reveal('prv_BBBBBBBBBB')).toBeUndefined();
    await store.put('prv_BBBBBBBBBB', KEY);
    await store.remove('prv_BBBBBBBBBB');
    expect(await store.reveal('prv_BBBBBBBBBB')).toBeUndefined();
    expect(await store.has('prv_BBBBBBBBBB')).toBe(false);
  });

  it('generates the wrapping key non-extractable, so script cannot export it', async () => {
    const port = createMemoryVaultPort();
    const store = createKeyStore(port);
    await store.put('prv_CCCCCCCCCC', KEY);
    const wrapping = await port.getWrappingKey();
    expect(wrapping).toBeDefined();
    expect(wrapping!.extractable).toBe(false);
    expect(wrapping!.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(globalThis.crypto.subtle.exportKey('raw', wrapping!)).rejects.toThrow();
  });

  it('stores ciphertext that contains neither the key text nor its bytes', async () => {
    const port = createMemoryVaultPort();
    const store = createKeyStore(port);
    await store.put('prv_DDDDDDDDDD', KEY);
    const entry = await port.getEntry('prv_DDDDDDDDDD');
    expect(entry).toBeDefined();
    expect(containsBytes(entry!.ciphertext, bytesOf(KEY))).toBe(false);
    expect(containsBytes(entry!.ciphertext, bytesOf('CAOTANG'))).toBe(false);
    // v2 plaintext is the JSON envelope {"v":2,"apiKey":"…"} plus the 16-byte GCM tag.
    const envelope = bytesOf(JSON.stringify({ v: 2, apiKey: KEY }));
    expect(entry!.ciphertext.length).toBe(envelope.length + 16);
    expect(entry!.iv.length).toBe(12);
  });

  it('keeps custom header values out of the ciphertext too', async () => {
    const port = createMemoryVaultPort();
    const store = createKeyStore(port);
    await store.putPayload('prv_DDDDDDDDDD', { apiKey: KEY, customHeaders: { 'x-proxy-secret': 'hunter2-value' } });
    const entry = await port.getEntry('prv_DDDDDDDDDD');
    expect(containsBytes(entry!.ciphertext, bytesOf('hunter2-value'))).toBe(false);
    expect(containsBytes(entry!.ciphertext, bytesOf('x-proxy-secret'))).toBe(false);
  });

  it('seals the same key differently each time, because every seal takes a fresh IV', async () => {
    const port = createMemoryVaultPort();
    const store = createKeyStore(port);
    await store.put('prv_EEEEEEEEEE', KEY);
    const first = await port.getEntry('prv_EEEEEEEEEE');
    await store.put('prv_EEEEEEEEEE', KEY);
    const second = await port.getEntry('prv_EEEEEEEEEE');
    expect(Buffer.from(first!.iv).equals(Buffer.from(second!.iv))).toBe(false);
    expect(Buffer.from(first!.ciphertext).equals(Buffer.from(second!.ciphertext))).toBe(false);
    expect(await store.reveal('prv_EEEEEEEEEE')).toBe(KEY);
  });

  it('refuses to open an entry moved to another profile, because the profile id is authenticated', async () => {
    const port = createMemoryVaultPort();
    const store = createKeyStore(port);
    await store.put('prv_FFFFFFFFFF', KEY);
    const stolen = await port.getEntry('prv_FFFFFFFFFF');
    await port.putEntry('prv_GGGGGGGGGG', stolen!);
    expect(await store.reveal('prv_GGGGGGGGGG')).toBeUndefined();
    expect(await store.reveal('prv_FFFFFFFFFF')).toBe(KEY);
  });

  it('returns nothing for a corrupted entry rather than a partial key', async () => {
    const port = createMemoryVaultPort();
    const store = createKeyStore(port);
    await store.put('prv_HHHHHHHHHH', KEY);
    const entry = await port.getEntry('prv_HHHHHHHHHH');
    const flipped = new Uint8Array(entry!.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await port.putEntry('prv_HHHHHHHHHH', { iv: entry!.iv, ciphertext: flipped });
    expect(await store.reveal('prv_HHHHHHHHHH')).toBeUndefined();
  });

  it('returns nothing when the wrapping key is gone, as after a cleared site-data store', async () => {
    const port = createMemoryVaultPort();
    await createKeyStore(port).put('prv_IIIIIIIIII', KEY);
    const replacement = createKeyStore(createMemoryVaultPort());
    // A fresh port has no wrapping key, but it also has no entry, so copy the entry across.
    const entry = await port.getEntry('prv_IIIIIIIIII');
    const orphan = createMemoryVaultPort();
    await orphan.putEntry('prv_IIIIIIIIII', entry!);
    expect(await createKeyStore(orphan).reveal('prv_IIIIIIIIII')).toBeUndefined();
    expect(await replacement.reveal('prv_IIIIIIIIII')).toBeUndefined();
  });

  it('shares one wrapping key between two saves that race, so neither entry is stranded', async () => {
    const port = createMemoryVaultPort();
    const store = createKeyStore(port);
    await Promise.all([store.put('prv_JJJJJJJJJJ', 'sk-first-key-111111'), store.put('prv_KKKKKKKKKK', 'sk-second-key-22222')]);
    expect(await store.reveal('prv_JJJJJJJJJJ')).toBe('sk-first-key-111111');
    expect(await store.reveal('prv_KKKKKKKKKK')).toBe('sk-second-key-22222');
  });

  it('does not keep a failed wrapping-key lookup, so the next save tries the vault again', async () => {
    const inner = createMemoryVaultPort();
    let lookups = 0;
    const port: KeyVaultPort = {
      ...inner,
      async getWrappingKey() {
        lookups += 1;
        if (lookups === 1) throw new Error('the vault is briefly unavailable');
        return inner.getWrappingKey();
      },
    };
    const store = createKeyStore(port);

    await expect(store.put('prv_RRRRRRRRRR', KEY)).rejects.toThrow('the vault is briefly unavailable');
    await expect(store.put('prv_RRRRRRRRRR', KEY)).resolves.toBeUndefined();
    expect(lookups).toBe(2);
    expect(await store.reveal('prv_RRRRRRRRRR')).toBe(KEY);
  });

  it('lets two tabs sharing one vault converge on one wrapping key, so neither strands the other’s entries', async () => {
    const port = createMemoryVaultPort();
    const tabA = createKeyStore(port);
    const tabB = createKeyStore(port);
    await Promise.all([tabA.put('prv_PPPPPPPPPP', 'sk-tab-a-key-111111'), tabB.put('prv_QQQQQQQQQQ', 'sk-tab-b-key-222222')]);
    expect(await tabB.reveal('prv_PPPPPPPPPP')).toBe('sk-tab-a-key-111111');
    expect(await tabA.reveal('prv_QQQQQQQQQQ')).toBe('sk-tab-b-key-222222');
  });

  it('round-trips a v2 payload: the key and its sealed custom headers', async () => {
    const store = createKeyStore(createMemoryVaultPort());
    await store.putPayload('prv_TTTTTTTTTT', { apiKey: KEY, customHeaders: { 'x-team': 'blue-42' } });
    expect(await store.revealPayload('prv_TTTTTTTTTT')).toEqual({ apiKey: KEY, customHeaders: { 'x-team': 'blue-42' } });
    // The string seam reads the key half, unchanged — the shape MCP's token store relies on.
    expect(await store.reveal('prv_TTTTTTTTTT')).toBe(KEY);
  });

  it('opens a v1 entry transparently and lazily rewrites it as v2 under a fresh IV', async () => {
    const port = createMemoryVaultPort();
    const store = createKeyStore(port);
    // Plant a genuine v1 entry: the bare key bytes, sealed the way the pre-payload store sealed them.
    await store.put('prv_V111111111', KEY); // establishes the wrapping key
    const wrapping = (await port.getWrappingKey())!;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const sealed = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('caotang:provider-key:prv_V111111111') },
      wrapping,
      bytesOf('sk-legacy-key-000001'),
    );
    await port.putEntry('prv_V111111111', { iv, ciphertext: new Uint8Array(sealed) });
    const v1Entry = await port.getEntry('prv_V111111111');

    // The reveal answers the key, and rewrites the entry as a v2 envelope.
    expect(await store.reveal('prv_V111111111')).toBe('sk-legacy-key-000001');
    const migrated = await port.getEntry('prv_V111111111');
    expect(Buffer.from(migrated!.iv).equals(Buffer.from(v1Entry!.iv))).toBe(false);
    const opened = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: migrated!.iv, additionalData: new TextEncoder().encode('caotang:provider-key:prv_V111111111') },
      wrapping,
      migrated!.ciphertext,
    );
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ v: 2, apiKey: 'sk-legacy-key-000001' });
  });

  it('reads a v1 MCP token unchanged: put a bare string, reveal gives the string back', async () => {
    const store = createKeyStore(createMemoryVaultPort());
    await store.put('mcp:test-ref', 'mcp-token-value-1');
    expect(await store.reveal('mcp:test-ref')).toBe('mcp-token-value-1');
  });

  it('never writes the key through console output', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    try {
      const store = createKeyStore(createMemoryVaultPort());
      await store.put('prv_LLLLLLLLLL', KEY);
      await store.reveal('prv_LLLLLLLLLL');
      for (const spy of spies) {
        for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(KEY);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('IndexedDB key vault (browser binding, headless)', () => {
  it('keeps the wrapping key and the entries across a reopen, which is what a reload is', async () => {
    const factory = new MemoryIndexedDb();
    const first = createKeyStore(createIndexedDbVaultPort({ factory }));
    await first.put('prv_MMMMMMMMMM', KEY);

    // A new port over the same database is what a reloaded page gets.
    const reloaded = createKeyStore(createIndexedDbVaultPort({ factory }));
    expect(await reloaded.reveal('prv_MMMMMMMMMM')).toBe(KEY);
    expect(await reloaded.has('prv_MMMMMMMMMM')).toBe(true);
  });

  it('lets two tabs sharing one database converge on one wrapping key', async () => {
    const factory = new MemoryIndexedDb();
    const tabA = createKeyStore(createIndexedDbVaultPort({ factory }));
    const tabB = createKeyStore(createIndexedDbVaultPort({ factory }));
    await Promise.all([tabA.put('prv_RRRRRRRRRR', 'sk-idb-a-key-111111'), tabB.put('prv_SSSSSSSSSS', 'sk-idb-b-key-222222')]);

    const reloaded = createKeyStore(createIndexedDbVaultPort({ factory }));
    expect(await reloaded.reveal('prv_RRRRRRRRRR')).toBe('sk-idb-a-key-111111');
    expect(await reloaded.reveal('prv_SSSSSSSSSS')).toBe('sk-idb-b-key-222222');
  });

  it('stores the wrapping key as a non-extractable CryptoKey, unchanged by the trip through IndexedDB', async () => {
    const factory = new MemoryIndexedDb();
    const port: KeyVaultPort = createIndexedDbVaultPort({ factory });
    await createKeyStore(port).put('prv_NNNNNNNNNN', KEY);
    const stored = await port.getWrappingKey();
    expect(stored).toBeDefined();
    expect(stored!.extractable).toBe(false);
    expect(stored!.type).toBe('secret');
  });

  it('removes an entry from the database when the profile is removed', async () => {
    const factory = new MemoryIndexedDb();
    const port = createIndexedDbVaultPort({ factory });
    const store = createKeyStore(port);
    await store.put('prv_OOOOOOOOOO', KEY);
    await store.remove('prv_OOOOOOOOOO');
    expect(await port.getEntry('prv_OOOOOOOOOO')).toBeUndefined();
  });

  it('refuses to open when the host has no IndexedDB and none was supplied', () => {
    expect(() => createIndexedDbVaultPort()).toThrow(/IndexedDB is not available/);
  });
});
