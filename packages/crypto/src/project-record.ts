/**
 * The project record — [hosted.md §5](docs/architecture/hosted.md). What a second device needs before it can open a
 * project it has never seen: the project's name. It is sealed under a key of that project's own, not the master key, so
 * a master-key rotation — which re-wraps the project key and leaves everything under it valid — keeps every project's
 * name readable, and the record is bound to the account and the project id so one moved to another project or to
 * another account does not open.
 *
 * The server stores it beside the wrapped project key and cannot read either: a record is opaque bytes at most
 * {@link MAX_SEALED_PROJECT_RECORD} long.
 */
import { NONCE_BYTES, TAG_BYTES, aeadOpen, aeadSeal, associatedData } from './aead.js';
import { type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import { deriveSubkey, type SecretKey } from './keys.js';

/** The record's own format byte: a file, manifest or vault reader refuses it, and it refuses theirs. */
export const PROJECT_RECORD_FORMAT_TAG = 3;

/** A project's name, in characters. Long enough for a working title; short enough that the server's cap is never hit. */
export const MAX_PROJECT_NAME = 200;

/** What the record is bound to. Both halves travel in the associated data, never as bytes the server could read. */
export interface ProjectRecordContext {
  readonly accountId: string;
  readonly projectId: string;
}

/** The record's own layout, inside the seal. `v` lets a reader refuse a layout it does not know instead of guessing. */
export interface ProjectRecord {
  readonly name: string;
}

const RECORD_LAYOUT = 1;

function recordAd(ctx: ProjectRecordContext): Uint8Array {
  return associatedData('caotang/v1/project-record', ctx.accountId, ctx.projectId);
}

/** What a record of this many characters occupies once sealed, so a caller can check the server's cap first. */
export function sealedProjectRecordLength(name: string): number {
  return 1 + NONCE_BYTES + new TextEncoder().encode(JSON.stringify({ v: RECORD_LAYOUT, name })).length + TAG_BYTES;
}

export const MAX_SEALED_PROJECT_RECORD = 1024;

function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new CryptoError('invalid-argument', 'a project needs a name');
  if ([...trimmed].length > MAX_PROJECT_NAME) throw new CryptoError('invalid-argument', `a project name is at most ${MAX_PROJECT_NAME} characters`);
  return trimmed;
}

/** Seals one project's record under a key derived from that project's key. */
export async function sealProjectRecord(project: SecretKey, ctx: ProjectRecordContext, record: ProjectRecord, random?: RandomBytes): Promise<Uint8Array> {
  const name = assertName(record.name);
  const plain = new TextEncoder().encode(JSON.stringify({ v: RECORD_LAYOUT, name }));
  return aeadSeal(await deriveSubkey(project, 'name'), recordAd(ctx), plain, random, PROJECT_RECORD_FORMAT_TAG);
}

/** Refuses a record from another account or another project, a record of an unknown layout, and any altered byte. */
export async function openProjectRecord(project: SecretKey, ctx: ProjectRecordContext, sealed: Uint8Array): Promise<ProjectRecord> {
  const plain = await aeadOpen(await deriveSubkey(project, 'name'), recordAd(ctx), sealed, PROJECT_RECORD_FORMAT_TAG);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new CryptoError('bad-format', 'the project record is not readable');
  }
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== RECORD_LAYOUT) {
    throw new CryptoError('bad-format', 'the project record has an unknown layout');
  }
  const name = (raw as { name?: unknown }).name;
  if (typeof name !== 'string' || name.trim() === '' || [...name].length > MAX_PROJECT_NAME) {
    throw new CryptoError('bad-format', 'the project record holds no usable name');
  }
  return { name };
}
