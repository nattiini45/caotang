/**
 * The message contract between the import preview's reader host (reader-host.ts, main thread) and its `'self'` module Worker
 * (reader.worker.ts), issues #283 / #274 / #390. The heavy read — decoding a text file, parsing RTF, unpacking an `.rtfd` package —
 * runs in the Worker; the splitter stays on the main thread, where it re-runs on every rule chip.
 *
 * The input bytes are sent once, on `open`, and cached in the Worker: every `read` re-reads that copy, so toggling an encoding or the
 * underline option never sends the file again. They are cloned, not transferred, so the source keeps its own copy for a remount
 * (React's StrictMode mounts the dialog twice in dev). A read's picture bytes ARE transferred back, so an image-heavy RTF costs the
 * main thread no copy. Results are plain structured-clone data; an error is carried as its code and message, never as an `Error`
 * instance (structured clone drops an error's own `code`).
 */

import type { ParagraphMode, PlainTextRead } from '@caotang/import-read/text';
import type { RtfImport } from '@caotang/import-rtf';
import type { DecodableEncoding } from '@caotang/store/encoding';

/** Opens a reader with its input. The bytes (or folder files) are transferred to the Worker and cached there. */
export type ReaderOpen =
  | { readonly kind: 'open'; readonly reader: 'text'; readonly bytes: Uint8Array }
  | { readonly kind: 'open'; readonly reader: 'rtf'; readonly bytes: Uint8Array }
  | { readonly kind: 'open'; readonly reader: 'rtfd'; readonly files: readonly { readonly path: string; readonly size: number; readonly bytes: Uint8Array }[] }
  | { readonly kind: 'open'; readonly reader: 'rtfd-zip'; readonly bytes: Uint8Array };

/** Reads the cached input again with these options. A text read decodes and builds blocks; an RTF read parses. */
export type ReaderRead =
  | { readonly kind: 'read'; readonly reader: 'text'; readonly encoding?: DecodableEncoding; readonly paragraphs?: ParagraphMode | 'auto'; readonly fileName?: string }
  | { readonly kind: 'read'; readonly reader: 'rtf' | 'rtfd'; readonly underlineAs?: 'italic' | 'none'; readonly assetPrefix?: string };

/** An RTF or `.rtfd` read's result, with its error flattened to a code and a message so it survives the clone. */
export type SerializableRtfResult =
  | { readonly ok: true; readonly value: RtfImport }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export type ReaderResult =
  | { readonly kind: 'opened' }
  | { readonly kind: 'text'; readonly result: PlainTextRead }
  | { readonly kind: 'rtf'; readonly result: SerializableRtfResult };

/** The envelope the Worker posts back: the request's id, and its result or a failure message. */
export interface ReaderReply {
  readonly id: number;
  readonly ok: boolean;
  readonly result?: ReaderResult;
  readonly error?: string;
}

/** A buffer a `Uint8Array` owns whole, so it can be transferred without detaching a neighbour's view; null when it must be copied. */
export function dedicatedBuffer(bytes: Uint8Array): ArrayBuffer | null {
  const buffer = bytes.buffer;
  return buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength ? buffer : null;
}

/**
 * The transfer list for a read's reply: every picture buffer it owns whole, so the bytes move to the main thread without a copy.
 * A buffer is listed once even when several attachments share it (the same picture placed twice in an `.rtfd` package): a duplicate
 * in the transfer list makes `postMessage` throw, and the cloned views keep sharing the one transferred buffer (#597 F1).
 */
export function resultTransferList(result: ReaderResult): Transferable[] {
  if (result.kind !== 'rtf' || !result.result.ok) return [];
  const seen = new Set<ArrayBuffer>();
  const buffers: Transferable[] = [];
  for (const bytes of result.result.value.assetData.values()) {
    const buffer = dedicatedBuffer(bytes);
    if (buffer !== null && !seen.has(buffer)) {
      seen.add(buffer);
      buffers.push(buffer);
    }
  }
  return buffers;
}
