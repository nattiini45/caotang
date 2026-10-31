/**
 * Image content blocks in an external answer — [pictures.md §8.3](../../../docs/architecture/pictures.md), [extensibility.md §6](../../../docs/architecture/extensibility.md).
 *
 * An `image` block is bytes, not text. It is never counted as text tokens and never reaches the model: the bytes are checked, held in the
 * project's staging area, and the model reads a one-line stub that names the staging id. The writer's own import, or a `pictures.import`
 * step, is the only way the bytes become a picture of the project, and it carries the provenance {@link ImageStager.provenanceOf} keeps.
 *
 * - **Check before stage.** Every block of the answer is counted, decoded, sniffed and capped first, and only then is anything staged, so a
 *   refusal leaves nothing behind. The sniff decides the type, never the block's own `mimeType`: a block whose claim differs from its bytes is
 *   refused, because the bytes are what the importer would trust.
 * - **No base64 leaves this module.** Every refusal names a cap, an index or a type, never the data, so neither an error nor an activity row can
 *   carry a picture.
 * - **A bounded lifetime.** Held bytes are not a library. They are dropped {@link STAGED_IMAGE_LIFETIME_MS} after they were staged, when the
 *   writer or a refusal discards them, and when the project closes, so a picture nobody chose to keep does not sit in memory for the session.
 * - **Outbound is the same room, read the other way.** A tool argument that is exactly `staged:<id>` is replaced, at the call and after the
 *   writer has approved it, by the base64 of those bytes. A path is never read and a URL is never fetched on a tool's behalf.
 */

import { PICTURE_MAX_BYTES, sniffPicture, type PictureMime } from '@caotang/pictures';

import { isRecord } from './util.js';

/** The most images one external answer may carry. The same four a `pictures.view` shows at once (pictures.md §8.1). */
export const EXTERNAL_IMAGE_COUNT_CAP = 4;

/** The most decoded image bytes one answer, or one outbound call, may carry: the size a picture import takes (16 MiB). */
export const EXTERNAL_IMAGE_BYTES_CAP = PICTURE_MAX_BYTES;

/** How long staged bytes are held: ten minutes, long enough to read the stub and approve an import, short enough not to outlive the turn's interest. */
export const STAGED_IMAGE_LIFETIME_MS = 10 * 60 * 1000;

/** The prefix of an outbound argument that names staged bytes: `staged:stg_…`. */
export const STAGED_ARGUMENT_PREFIX = 'staged:';
const STAGED_ARGUMENT = /^staged:(stg_[0-9A-Za-z]+)$/;

/** What the staging area must do for the client. The project's `RetryableAssetStaging` is one; a test's is another. */
export interface ImageStagingPort {
  stage(bytes: Uint8Array): string;
  discard(ids: readonly string[]): void;
  /** Holds bytes for a read without consuming them. Without it, outbound arguments cannot name staged bytes. */
  reserve?(ids: readonly string[], scope?: string): { readonly id: string; readonly items: readonly { readonly stagingId: string; readonly bytes: Uint8Array }[] };
  release?(reservationId: string): void;
}

/** Where staged bytes came from, as an import records it. */
export interface StagedImageSource {
  readonly kind: 'mcp';
  readonly server: string;
  readonly tool: string;
}

/** One staged image, as the result carries it beside the stub. Metadata only: the bytes stay in the staging area. */
export interface StagedImage {
  readonly stagingId: string;
  readonly mime: PictureMime;
  readonly bytes: number;
  /** One-based among the answer's images, as the stub numbers it. */
  readonly index: number;
  /** Epoch milliseconds after which the bytes are dropped. */
  readonly expiresAt: number;
}

/** The staging area as the invoke apply uses it, with the lifetime and provenance the client adds. */
export interface ImageStager {
  /** Holds every image or none. */
  stage(images: readonly { readonly bytes: Uint8Array; readonly mime: PictureMime }[], source: { readonly server: string; readonly tool: string }): readonly StagedImage[];
  /** Where a held id came from, or nothing once it has expired, been discarded, or was never staged here. */
  provenanceOf(stagingId: string): StagedImageSource | undefined;
  /** The bytes behind an id, for an outbound argument, without consuming them. Any id the staging holds, not only this module's. */
  read(stagingId: string): Uint8Array | undefined;
  /** The writer declined or cancelled: these ids go now. */
  discard(ids: readonly string[]): void;
  /** The project closed: everything this stager staged goes now. */
  releaseAll(): void;
  /** The ids still held, soonest to expire first. */
  heldIds(): readonly string[];
}

export interface ImageStagerOptions {
  readonly staging: ImageStagingPort;
  readonly now?: () => number;
  readonly lifetimeMs?: number;
  /** Timers, so a test can run the clock. Defaults to the platform's, unref'd where it can be so a timer never keeps a process alive. */
  readonly timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };
}

interface Held {
  readonly source: StagedImageSource;
  readonly expiresAt: number;
  readonly timer: unknown;
}

export function createImageStager(options: ImageStagerOptions): ImageStager {
  const { staging } = options;
  const now = options.now ?? Date.now;
  const lifetime = options.lifetimeMs ?? STAGED_IMAGE_LIFETIME_MS;
  const timers = options.timers ?? platformTimers();
  const held = new Map<string, Held>();

  const drop = (ids: readonly string[]): void => {
    for (const id of ids) {
      const entry = held.get(id);
      if (entry !== undefined) timers.clear(entry.timer);
      held.delete(id);
    }
    staging.discard(ids);
  };
  const sweep = (): void => {
    const at = now();
    const expired = [...held].filter(([, entry]) => entry.expiresAt <= at).map(([id]) => id);
    if (expired.length > 0) drop(expired);
  };

  return {
    stage(images, origin) {
      sweep();
      const source: StagedImageSource = { kind: 'mcp', server: origin.server, tool: origin.tool };
      const expiresAt = now() + lifetime;
      const staged: StagedImage[] = [];
      try {
        for (const [position, image] of images.entries()) {
          const stagingId = staging.stage(image.bytes);
          // Entered before the next stage so a throw below still finds this id to drop.
          held.set(stagingId, { source, expiresAt, timer: timers.set(() => drop([stagingId]), lifetime) });
          staged.push({ stagingId, mime: image.mime, bytes: image.bytes.length, index: position + 1, expiresAt });
        }
      } catch (failure) {
        drop(staged.map((image) => image.stagingId));
        throw failure;
      }
      return staged;
    },
    provenanceOf(stagingId) {
      sweep();
      return held.get(stagingId)?.source;
    },
    read(stagingId) {
      if (staging.reserve === undefined || staging.release === undefined) return undefined;
      try {
        const reservation = staging.reserve([stagingId]);
        const bytes = reservation.items[0]?.bytes;
        staging.release(reservation.id);
        return bytes;
      } catch {
        // An id that is unknown, mid-import or another project's reads as not held; the staging says which, and the caller need not.
        return undefined;
      }
    },
    discard(ids) {
      drop(ids);
    },
    releaseAll() {
      drop([...held.keys()]);
    },
    heldIds() {
      sweep();
      return [...held].sort((a, b) => a[1].expiresAt - b[1].expiresAt).map(([id]) => id);
    },
  };
}

function platformTimers(): { set(run: () => void, ms: number): unknown; clear(handle: unknown): void } {
  return {
    set(run, ms) {
      const handle: unknown = setTimeout(run, ms);
      if (isRecord(handle) && typeof handle['unref'] === 'function') (handle['unref'] as () => void)();
      return handle;
    },
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** The `[image 1: image/png, 812 KB, staged as stg_…]` line the model reads in place of a block. Kilobytes at any size, never fewer than one. */
export function imageStub(index: number, mime: PictureMime, bytes: number, stagingId: string | undefined): string {
  const size = `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return stagingId === undefined
    ? `[image ${index}: ${mime}, ${size}, not staged: this host has nowhere to hold pictures]`
    : `[image ${index}: ${mime}, ${size}, staged as ${stagingId}]`;
}

/** What an image block counts as in an answer's token estimate: its stub's longest realistic form, never its base64. */
export const IMAGE_STUB_ESTIMATE = '[image 4: image/webp, 16384 KB, staged as stg_XXXXXXXXXXXX]';

/** A block of type `image`, whatever else is wrong with it. Anything that claims to be an image is handled here and never reaches the model as it came. */
export function isImageBlock(block: unknown): boolean {
  return isRecord(block) && block['type'] === 'image';
}

export type ExternalImages =
  | { readonly ok: true; readonly content: readonly unknown[]; readonly staged: readonly StagedImage[] }
  | { readonly ok: false; readonly code: 'limit-exceeded' | 'postcondition'; readonly message: string; readonly correctiveHint: string };

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The decoded size a base64 string will have, without decoding it. */
function decodedLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function decodeBase64(data: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Replaces each `image` block of an answer with its stub and stages the bytes. Nothing is staged unless every block passes, and with
 * no stager the bytes are checked and dropped, so a host that cannot hold pictures still never shows a model a picture as text.
 */
export function routeImages(
  content: readonly unknown[],
  origin: { readonly server: string; readonly tool: string },
  stager: ImageStager | undefined,
): ExternalImages {
  const blocks = content.filter(isImageBlock) as Record<string, unknown>[];
  if (blocks.length === 0) return { ok: true, content, staged: [] };

  const refuse = (code: 'limit-exceeded' | 'postcondition', message: string, correctiveHint: string): ExternalImages => ({
    ok: false,
    code,
    message: `${message} The tool ran on the server, so any effect it had is already in place; no picture was staged and the answer was not returned.`,
    correctiveHint,
  });
  const where = `server '${origin.server}' answered '${origin.tool}'`;

  if (blocks.length > EXTERNAL_IMAGE_COUNT_CAP) {
    return refuse(
      'limit-exceeded',
      `${where} with ${blocks.length} images, over the ${EXTERNAL_IMAGE_COUNT_CAP}-image cap.`,
      'call the tool again for fewer pictures, or drop this step',
    );
  }

  let total = 0;
  const decoded: { bytes: Uint8Array; mime: PictureMime }[] = [];
  for (const [position, block] of blocks.entries()) {
    const label = `image ${position + 1}`;
    const data = block['data'];
    const declared = block['mimeType'];
    if (typeof data !== 'string' || typeof declared !== 'string') {
      return refuse('postcondition', `${where} with ${label} missing its data or its type, so Caotang cannot read it.`, 'drop this step; the server returned a picture Caotang cannot read');
    }
    total += decodedLength(data);
    if (total > EXTERNAL_IMAGE_BYTES_CAP) {
      return refuse(
        'limit-exceeded',
        `${where} with images of about ${megabytes(total)} by ${label}, over the ${megabytes(EXTERNAL_IMAGE_BYTES_CAP)} cap.`,
        'call the tool again for a smaller or fewer pictures, or drop this step',
      );
    }
    const bytes = decodeBase64(data);
    if (bytes === undefined) {
      return refuse('postcondition', `${where} with ${label} that is not valid base64.`, 'drop this step; the server returned a picture Caotang cannot read');
    }
    const sniffed = sniffPicture(bytes);
    if (!sniffed.ok) {
      return refuse('postcondition', `${where} with ${label} that is not a picture Caotang keeps: ${sniffed.reason}`, 'drop this step, or ask the tool for a PNG, JPEG or WebP picture');
    }
    const claimed = declared.split(';')[0]?.trim().toLowerCase() ?? '';
    if (claimed !== sniffed.mime) {
      return refuse(
        'postcondition',
        `${where} with ${label} declared as ${JSON.stringify(claimed.slice(0, 40))} whose bytes are ${sniffed.mime}.`,
        'drop this step; a picture whose type does not match its bytes is not staged',
      );
    }
    decoded.push({ bytes, mime: sniffed.mime });
  }

  let staged: readonly StagedImage[] = [];
  if (stager !== undefined) {
    try {
      staged = stager.stage(decoded, origin);
    } catch {
      return refuse('postcondition', `${where} with pictures that could not be held for import.`, 'drop this step, or try again');
    }
  }

  let next = 0;
  const replaced = content.map((block) => {
    if (!isImageBlock(block)) return block;
    const item = decoded[next];
    next += 1;
    if (item === undefined) return block;
    return { type: 'text', text: imageStub(next, item.mime, item.bytes.length, staged[next - 1]?.stagingId) };
  });
  return { ok: true, content: replaced, staged };
}

/** Why an outbound argument could not be filled. */
export type OutboundRefusal = { readonly code: 'not-found' | 'limit-exceeded'; readonly message: string; readonly correctiveHint: string };

const OUTBOUND_DEPTH = 8;

/**
 * Fills `staged:<id>` arguments with the bytes' base64, or refuses the call before anything is sent. The arguments were validated and
 * approved as written, so the writer saw an id and not megabytes of text; the bytes are read only now, at the call.
 */
export function resolveStagedArguments(args: Record<string, unknown>, stager: ImageStager | undefined): { readonly ok: true; readonly args: Record<string, unknown> } | { readonly ok: false; readonly refusal: OutboundRefusal } {
  let total = 0;
  let refusal: OutboundRefusal | undefined;

  const fill = (value: unknown, depth: number): unknown => {
    if (refusal !== undefined) return value;
    if (typeof value === 'string') {
      // Only the exact form is a reference, so a sentence that happens to start with "staged:" reaches the tool as written.
      const id = STAGED_ARGUMENT.exec(value)?.[1];
      if (id === undefined) return value;
      const bytes = stager?.read(id);
      if (bytes === undefined) {
        refusal = {
          code: 'not-found',
          message: `the argument ${JSON.stringify(value.slice(0, 60))} names a staged picture that is not held, so nothing was sent`,
          correctiveHint: 'stage the picture again (for example with pictures.view), or drop this step',
        };
        return value;
      }
      total += bytes.length;
      if (total > EXTERNAL_IMAGE_BYTES_CAP) {
        refusal = {
          code: 'limit-exceeded',
          message: `the staged pictures in this call are over the ${megabytes(EXTERNAL_IMAGE_BYTES_CAP)} cap, so nothing was sent`,
          correctiveHint: 'send fewer or smaller pictures',
        };
        return value;
      }
      return toBase64(bytes);
    }
    if (depth >= OUTBOUND_DEPTH) return value;
    if (Array.isArray(value)) return value.map((item) => fill(item, depth + 1));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, depth + 1)]));
    return value;
  };

  const filled = fill(args, 0) as Record<string, unknown>;
  return refusal === undefined ? { ok: true, args: filled } : { ok: false, refusal };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}
