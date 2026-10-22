import { aeadOpen, aeadSeal, assertVersion, associatedData, NONCE_BYTES, TAG_BYTES } from './aead.js';
import { type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import { deriveSubkey, type SecretKey } from './keys.js';

const FRAME_BYTES = 4;
export const PAD_MIN = 256;
export const PAD_STEP = 1024 * 1024;

/**
 * The length a framed plaintext (4 length bytes plus the content) is padded to: the next power of two from 256
 * bytes up to 1 MiB, then whole MiB steps. Two files in one bucket look alike to the server.
 */
export function paddedLength(framed: number): number {
  if (framed <= PAD_MIN) return PAD_MIN;
  if (framed <= PAD_STEP) {
    let size = PAD_MIN;
    while (size < framed) size *= 2;
    return size;
  }
  return Math.ceil(framed / PAD_STEP) * PAD_STEP;
}

/** What the server stores for a plaintext of this many bytes. */
export function sealedLength(plaintextLength: number): number {
  return 1 + NONCE_BYTES + paddedLength(FRAME_BYTES + plaintextLength) + TAG_BYTES;
}

function pad(plaintext: Uint8Array): Uint8Array {
  if (plaintext.length > 0x7fffffff) throw new CryptoError('invalid-argument', 'the file is too large to seal');
  const out = new Uint8Array(paddedLength(FRAME_BYTES + plaintext.length));
  new DataView(out.buffer).setUint32(0, plaintext.length);
  out.set(plaintext, FRAME_BYTES);
  return out;
}

function unpad(framed: Uint8Array): Uint8Array {
  if (framed.length < FRAME_BYTES) throw new CryptoError('bad-format', 'the sealed frame is too short');
  const length = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(0);
  if (FRAME_BYTES + length > framed.length || paddedLength(FRAME_BYTES + length) !== framed.length) {
    throw new CryptoError('bad-format', 'the sealed frame is not padded to its bucket');
  }
  return framed.slice(FRAME_BYTES, FRAME_BYTES + length);
}

/** What a sealed file is bound to: the project, the hashed path, and the version it was written as. */
export interface FileContext {
  readonly projectId: string;
  readonly pathHash: string;
  readonly version: number;
}

export interface ManifestContext {
  readonly projectId: string;
  readonly version: number;
}

function fileAd(ctx: FileContext): Uint8Array {
  assertVersion(ctx.version);
  return associatedData('caotang/v1/file', ctx.projectId, ctx.pathHash, ctx.version);
}

function manifestAd(ctx: ManifestContext): Uint8Array {
  assertVersion(ctx.version);
  return associatedData('caotang/v1/manifest', ctx.projectId, ctx.version);
}

/** AES-256-GCM under the file's own key, with `{projectId, pathHash, version}` as associated data. */
export async function sealFile(project: SecretKey, ctx: FileContext, plaintext: Uint8Array, random?: RandomBytes): Promise<Uint8Array> {
  return aeadSeal(await deriveSubkey(project, 'file', ctx.pathHash), fileAd(ctx), pad(plaintext), random);
}

/** Refuses a file sealed under another key, project, path or version, and any altered byte. */
export async function openFile(project: SecretKey, ctx: FileContext, sealed: Uint8Array): Promise<Uint8Array> {
  return unpad(await aeadOpen(await deriveSubkey(project, 'file', ctx.pathHash), fileAd(ctx), sealed));
}

export async function sealManifest(project: SecretKey, ctx: ManifestContext, plaintext: Uint8Array, random?: RandomBytes): Promise<Uint8Array> {
  return aeadSeal(await deriveSubkey(project, 'manifest'), manifestAd(ctx), pad(plaintext), random);
}

export async function openManifest(project: SecretKey, ctx: ManifestContext, sealed: Uint8Array): Promise<Uint8Array> {
  return unpad(await aeadOpen(await deriveSubkey(project, 'manifest'), manifestAd(ctx), sealed));
}
