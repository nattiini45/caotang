import { describe, expect, it } from 'vitest';
import {
  PAD_MIN,
  PAD_STEP,
  generateProjectKey,
  openFile,
  openManifest,
  paddedLength,
  sealFile,
  sealManifest,
  sealedLength,
  type FileContext,
} from '../src/index.js';

const ctx: FileContext = { projectId: 'p_ONE', pathHash: 'a'.repeat(52), version: 3 };
const text = new TextEncoder().encode('The ferry was late, as always.');

/**
 * The budget for the two exhaustive seal fixtures below — explicit, per-test, and never
 * `vitest.config.ts`'s default.
 *
 * **Why 5 000 ms was never their budget.** Neither fixture measures wall clock. One proves every
 * one of the 285 bytes of a sealed value is authenticated (285 opens); the other proves 500 seals
 * draw 500 nonces. Each iteration is four asynchronous WebCrypto calls — an HKDF import and
 * derive, an AES-GCM import, then the encrypt or decrypt — so 3 144 calls run between the two
 * fixtures, and that cost is the subject matter, not an accident.
 *
 * **Measured, both directions.** Alone on one development machine they ran **98 ms** and
 * **128 ms**. Under the full suite's worker pool they ran **3 313 ms** and **5 052 ms**; the
 * second is a timeout, and the same file passed in 167 ms on an idle run of the same suite. The
 * spread is the machine, not the claim.
 *
 * **30 000 ms clears every figure recorded (max 5 052 ms) with headroom, and still fails a
 * hang.** Raising the config default instead would move every other test's budget in the repo to
 * accommodate two fixtures, which is the option the timeout decision in
 * `packages/editor/test/dialect.test.ts` explicitly rules out and its guard rejects.
 */
const EXHAUSTIVE_SEAL_TIMEOUT = 30_000;

describe('seal and open a file', () => {
  it('round-trips text, empty content and every byte value', async () => {
    const key = generateProjectKey();
    for (const plain of [text, new Uint8Array(0), Uint8Array.from({ length: 256 }, (_, i) => i)]) {
      expect(await openFile(key, ctx, await sealFile(key, ctx, plain))).toEqual(plain);
    }
  });

  it('does not put the plaintext in the sealed bytes', async () => {
    const key = generateProjectKey();
    const sealed = Buffer.from(await sealFile(key, ctx, text));
    expect(sealed.includes(Buffer.from(text.subarray(0, 12)))).toBe(false);
  });

  it('refuses a wrong key', async () => {
    const sealed = await sealFile(generateProjectKey(), ctx, text);
    await expect(openFile(generateProjectKey(), ctx, sealed)).rejects.toMatchObject({ code: 'unauthentic' });
  });

  it('refuses a wrong project id, path hash or version in the associated data', async () => {
    const key = generateProjectKey();
    const sealed = await sealFile(key, ctx, text);
    for (const wrong of [
      { ...ctx, projectId: 'p_TWO' },
      { ...ctx, pathHash: 'b'.repeat(52) },
      { ...ctx, version: 2 },
      { ...ctx, version: 4 },
    ]) {
      await expect(openFile(key, wrong, sealed)).rejects.toMatchObject({ code: 'unauthentic' });
    }
  });

  it('detects a changed byte anywhere in the sealed value', async () => {
    const key = generateProjectKey();
    const sealed = await sealFile(key, ctx, text);
    for (let i = 0; i < sealed.length; i++) {
      const altered = sealed.slice();
      altered[i] = (altered[i] ?? 0) ^ 1;
      await expect(openFile(key, ctx, altered), `byte ${i}`).rejects.toBeInstanceOf(Error);
    }
  }, EXHAUSTIVE_SEAL_TIMEOUT);

  it('refuses a truncated value and an unknown format tag', async () => {
    const key = generateProjectKey();
    const sealed = await sealFile(key, ctx, text);
    await expect(openFile(key, ctx, sealed.slice(0, 20))).rejects.toMatchObject({ code: 'bad-format' });
    const retagged = sealed.slice();
    retagged[0] = 2;
    await expect(openFile(key, ctx, retagged)).rejects.toMatchObject({ code: 'bad-format' });
  });

  it('draws a fresh nonce for every seal, so one plaintext never seals to the same bytes', async () => {
    const key = generateProjectKey();
    const nonces = new Set<string>();
    for (let i = 0; i < 500; i++) nonces.add(Buffer.from((await sealFile(key, ctx, text)).subarray(1, 13)).toString('hex'));
    expect(nonces.size).toBe(500);
  }, EXHAUSTIVE_SEAL_TIMEOUT);

  it('refuses a NUL in the project id or path hash, which could shift a field boundary', async () => {
    const key = generateProjectKey();
    await expect(sealFile(key, { ...ctx, projectId: 'p_ONE\0x' }, text)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(sealFile(key, { ...ctx, version: -1 }, text)).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(sealFile(key, { ...ctx, version: 1.5 }, text)).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('keeps a file and a manifest apart: one cannot be opened as the other', async () => {
    const key = generateProjectKey();
    const file = await sealFile(key, ctx, text);
    const manifest = await sealManifest(key, { projectId: 'p_ONE', version: 3 }, text);
    await expect(openManifest(key, { projectId: 'p_ONE', version: 3 }, file)).rejects.toMatchObject({ code: 'unauthentic' });
    await expect(openFile(key, ctx, manifest)).rejects.toMatchObject({ code: 'unauthentic' });
    expect(await openManifest(key, { projectId: 'p_ONE', version: 3 }, manifest)).toEqual(text);
    await expect(openManifest(key, { projectId: 'p_ONE', version: 4 }, manifest)).rejects.toMatchObject({ code: 'unauthentic' });
  });
});

describe('padding buckets', () => {
  it('pads a framed length to a power of two from 256 bytes up to 1 MiB, then to whole MiB', () => {
    expect(paddedLength(0)).toBe(PAD_MIN);
    expect(paddedLength(1)).toBe(256);
    expect(paddedLength(256)).toBe(256);
    expect(paddedLength(257)).toBe(512);
    expect(paddedLength(512)).toBe(512);
    expect(paddedLength(513)).toBe(1024);
    expect(paddedLength(PAD_STEP - 1)).toBe(PAD_STEP);
    expect(paddedLength(PAD_STEP)).toBe(PAD_STEP);
    expect(paddedLength(PAD_STEP + 1)).toBe(2 * PAD_STEP);
    expect(paddedLength(2 * PAD_STEP)).toBe(2 * PAD_STEP);
    expect(paddedLength(2 * PAD_STEP + 1)).toBe(3 * PAD_STEP);
  });

  it('seals content of different lengths in one bucket to values of one length', async () => {
    const key = generateProjectKey();
    const sizes = new Set<number>();
    for (const n of [0, 1, 100, 200, 252]) sizes.add((await sealFile(key, ctx, new Uint8Array(n))).length);
    expect(sizes.size).toBe(1);
    expect([...sizes][0]).toBe(sealedLength(0));
    expect((await sealFile(key, ctx, new Uint8Array(253))).length).toBe(sealedLength(253));
    expect(sealedLength(253)).toBeGreaterThan(sealedLength(252));
  });

  it('round-trips content at each side of a bucket boundary', async () => {
    const key = generateProjectKey();
    for (const n of [251, 252, 253, 508, 509, PAD_STEP - 5, PAD_STEP - 4, PAD_STEP - 3]) {
      const plain = new Uint8Array(n).fill(7);
      const sealed = await sealFile(key, ctx, plain);
      expect(sealed.length, `${n} bytes`).toBe(sealedLength(n));
      expect(Buffer.from(await openFile(key, ctx, sealed)).equals(Buffer.from(plain))).toBe(true);
    }
  });
});
