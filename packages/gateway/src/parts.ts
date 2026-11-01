/**
 * Content parts — the text/image message content of [provider-gateway.md §3](../../../docs/architecture/provider-gateway.md)
 * and [pictures.md §8.1](../../../docs/architecture/pictures.md).
 *
 * A `ChatMessage`'s content is either a plain string (unchanged on every wire route) or an array of
 * discriminated parts. Image parts carry their bytes for exactly one request and nothing else:
 *
 * - **bytes are transient.** They are mapped onto the wire by the adapter and dropped. They never
 *   enter the request log, the ledger, persisted turn history, a preview exported as text, or an
 *   error. Wherever content is summarised, only `hash` / `size` / `mime` / `caption` / the image
 *   count survive (see {@link contentSummaryOf} and {@link textOf}). The gateway also adds each
 *   image's base64 form to the call's redaction list, so a provider that echoes the request body
 *   back in an error has the image scrubbed like a key.
 * - **the vision gate.** An actual request carrying image parts is refused before anything is sent
 *   unless the active model's capability row says `vision` (see {@link checkRequestImages}).
 * - **token estimates.** Text parts count as text. An image counts by its own per-route formula
 *   ({@link imageTokens}); the base64 form is never counted as ordinary text tokens, an unknown
 *   route takes the larger of the per-route rules, and an undecodable header falls back to a
 *   size-based figure. Every one of them is an estimate, never a claimed exact count.
 */

import { tokensForChars } from '@caotang/codex';

import { EgressDeniedError } from './errors.js';
import type { ChatMessage, ContentPart, ImageMime, ImagePart, MessageContent, ModelCaps, TextPart } from './types.js';

/** The wire routes, as the adapters name them. `undefined` is the route-agnostic (mock, estimation) case. */
export type ContentRoute = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export const IMAGE_MIMES: readonly ImageMime[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The gateway's own per-route image caps, enforced before a request is sent. Conservative, not a provider claim. */
export interface RouteImageLimits {
  readonly maxImages: number;
  readonly maxImageBytes: number;
  readonly maxTotalBytes: number;
}

const MIB = 1024 * 1024;
const LIMITS: Record<ContentRoute, RouteImageLimits> = {
  // Chat Completions and Responses carry images as data URLs; 20 MiB per image, 20 images, 64 MiB a request.
  'openai-chat': { maxImages: 20, maxImageBytes: 20 * MIB, maxTotalBytes: 64 * MIB },
  'openai-responses': { maxImages: 20, maxImageBytes: 20 * MIB, maxTotalBytes: 64 * MIB },
  // Messages carries base64 sources; 5 MiB per image, 20 images, 32 MiB a request.
  'anthropic-messages': { maxImages: 20, maxImageBytes: 5 * MIB, maxTotalBytes: 32 * MIB },
};
/** The route-agnostic caps (mock profiles, pre-route estimates): the most conservative row. */
const GENERIC_LIMITS: RouteImageLimits = LIMITS['anthropic-messages'];

export function imageLimitsFor(route: ContentRoute | undefined): RouteImageLimits {
  return route === undefined ? GENERIC_LIMITS : LIMITS[route];
}

export function isContentParts(content: MessageContent): content is readonly ContentPart[] {
  return typeof content !== 'string';
}

/** The content as a part array; a string becomes its single text part. */
export function partsOf(content: MessageContent): readonly ContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

export function imagePartsOf(content: MessageContent): readonly ImagePart[] {
  return partsOf(content).filter((part): part is ImagePart => part.type === 'image');
}

/** One image's placeholder, the only form an image takes outside the wire: `[image 2: image/png, 812 KB, sha256:ab12…]`. */
export function placeholderOf(part: ImagePart, index: number): string {
  const kb = part.size >= 1024 ? `${Math.round(part.size / 1024)} KB` : `${part.size} B`;
  return `[image ${index}: ${part.mime}, ${kb}, sha256:${part.hash.slice(0, 8)}…${part.caption === undefined ? '' : `, “${part.caption}”`}]`;
}

/**
 * The content as text: text parts joined, each image replaced by its placeholder. This is what
 * previews, logs, history summaries and errors may show — never the bytes.
 */
export function textOf(content: MessageContent): string {
  let imageIndex = 0;
  return partsOf(content)
    .map((part) => (part.type === 'text' ? part.text : placeholderOf(part, ++imageIndex)))
    .join('\n\n');
}

/** The metadata record of one message's images: hash/size/mime/caption only, never bytes. */
export interface ImageSummary {
  readonly hash: string;
  readonly size: number;
  readonly mime: ImageMime;
  readonly caption?: string;
}

export interface ContentSummary {
  /** The text characters, images excluded. */
  readonly chars: number;
  readonly imageCount: number;
  readonly images: readonly ImageSummary[];
}

/** The persistable summary of a message list: text chars plus one hash/size/mime record per image. */
export function contentSummaryOf(messages: readonly Pick<ChatMessage, 'content'>[]): ContentSummary {
  let chars = 0;
  const images: ImageSummary[] = [];
  for (const message of messages) {
    for (const part of partsOf(message.content)) {
      if (part.type === 'text') chars += part.text.length;
      else images.push({ hash: part.hash, size: part.size, mime: part.mime, ...(part.caption === undefined ? {} : { caption: part.caption }) });
    }
  }
  return { chars, imageCount: images.length, images };
}

/** The base64 forms of every image in the messages — the redaction list for one call, so an echoed body is scrubbed. */
export function imageBase64Of(messages: readonly Pick<ChatMessage, 'content'>[]): string[] {
  return messages.flatMap((message) => imagePartsOf(message.content).map((part) => base64Of(part.bytes)));
}

// --- validation ------------------------------------------------------------

const HASH_HEX = /^[0-9a-f]{64}$/;

/** The MIME the bytes' magic numbers declare, when they declare a supported one. */
export function sniffMime(bytes: Uint8Array): ImageMime | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes.length >= 16 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return undefined;
}

/** Pixel dimensions read from the header of the four supported formats; undefined when the header does not parse. */
export function imageDimensions(bytes: Uint8Array, mime: ImageMime): { width: number; height: number } | undefined {
  // Indexed reads are `number | undefined` under noUncheckedIndexedAccess; a missing byte reads as 0.
  const b = (i: number): number => bytes[i] ?? 0;
  try {
    if (mime === 'image/png' && bytes.length >= 24) {
      return { width: ((b(16) << 24) | (b(17) << 16) | (b(18) << 8) | b(19)) >>> 0, height: ((b(20) << 24) | (b(21) << 16) | (b(22) << 8) | b(23)) >>> 0 };
    }
    if (mime === 'image/gif' && bytes.length >= 10) {
      return { width: b(6) | (b(7) << 8), height: b(8) | (b(9) << 8) };
    }
    if (mime === 'image/webp' && bytes.length >= 30) {
      const chunk = String.fromCharCode(b(12), b(13), b(14), b(15));
      if (chunk === 'VP8X') return { width: 1 + (b(24) | (b(25) << 8) | (b(26) << 16)), height: 1 + (b(27) | (b(28) << 8) | (b(29) << 16)) };
      if (chunk === 'VP8 ') {
        // The keyframe header starts at offset 20; width/height are 14-bit little-endian at 26/28.
        return { width: b(26) | ((b(27) & 0x3f) << 8), height: b(28) | ((b(29) & 0x3f) << 8) };
      }
      if (chunk === 'VP8L' && bytes.length >= 25) {
        const bits = b(21) | (b(22) << 8) | (b(23) << 16) | (b(24) << 24);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return undefined;
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (b(offset) !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = b(offset + 1);
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: (b(offset + 5) << 8) | b(offset + 6), width: (b(offset + 7) << 8) | b(offset + 8) };
        }
        offset += 2 + ((b(offset + 2) << 8) | b(offset + 3));
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** One part's validation problem, or undefined when the part is well-formed. `role` gates where images may sit. */
export function validatePart(part: ContentPart, role: ChatMessage['role']): string | undefined {
  if (typeof part !== 'object' || part === null) return 'a content part must be an object';
  if (part.type === 'text') {
    return typeof (part as TextPart).text === 'string' ? undefined : 'a text part needs a string text';
  }
  if (part.type !== 'image') return `unknown content part type ${JSON.stringify((part as { type?: unknown }).type)}`;
  const image = part as ImagePart;
  if (!(image.bytes instanceof Uint8Array) || image.bytes.length === 0) return 'an image part needs non-empty Uint8Array bytes';
  if (!IMAGE_MIMES.includes(image.mime)) return `image mime ${JSON.stringify(image.mime)} is not one of ${IMAGE_MIMES.join(', ')}`;
  if (typeof image.size !== 'number' || image.size !== image.bytes.length) return `image size ${String(image.size)} does not match its ${image.bytes.length} bytes`;
  if (typeof image.hash !== 'string' || !HASH_HEX.test(image.hash)) return 'image hash must be 64 lowercase hex characters (sha-256 of the bytes)';
  if (image.caption !== undefined && typeof image.caption !== 'string') return 'image caption must be a string';
  const sniffed = sniffMime(image.bytes);
  if (sniffed === undefined) return `image bytes do not start with a supported image signature (declared ${image.mime})`;
  if (sniffed !== image.mime) return `image bytes are ${sniffed}, not the declared ${image.mime}`;
  if (role !== 'user') return `image parts are only sent on user messages, not ${role}`;
  return undefined;
}

/** One message's validation problem (every part, plus the route's per-image and per-message caps), or undefined. */
export function validateMessageContent(message: Pick<ChatMessage, 'role' | 'content'>, route: ContentRoute | undefined): string | undefined {
  if (typeof message.content === 'string') return undefined;
  if (!Array.isArray(message.content)) return 'message content must be a string or an array of parts';
  const limits = imageLimitsFor(route);
  let images = 0;
  let total = 0;
  for (const part of message.content) {
    const problem = validatePart(part, message.role);
    if (problem !== undefined) return problem;
    if (part.type === 'image') {
      images += 1;
      total += part.size;
      if (part.size > limits.maxImageBytes) {
        return `an image of ${part.size} bytes is over this route's per-image cap of ${limits.maxImageBytes} bytes (${part.mime}, sha256:${part.hash.slice(0, 8)}…)`;
      }
    }
  }
  if (images > limits.maxImages) return `a message carries ${images} images, over this route's cap of ${limits.maxImages}`;
  if (total > limits.maxTotalBytes) return `a message's images total ${total} bytes, over this route's cap of ${limits.maxTotalBytes} bytes`;
  return undefined;
}

/**
 * The request-level gate: every message validated, the image totals checked against the route's
 * caps, and — when any image is present — the active model's capability row must say `vision`.
 * Returns the refusal's words (with the remedy), or undefined when the request may be sent.
 */
export function checkRequestImages(
  messages: readonly Pick<ChatMessage, 'role' | 'content'>[],
  caps: ModelCaps,
  route: ContentRoute | undefined,
  modelLabel: string,
): string | undefined {
  const limits = imageLimitsFor(route);
  let images = 0;
  let total = 0;
  for (const message of messages) {
    const problem = validateMessageContent(message, route);
    if (problem !== undefined) return `Refused a request over a malformed content part: ${problem}.`;
    for (const part of imagePartsOf(message.content)) {
      images += 1;
      total += part.size;
    }
  }
  if (images === 0) return undefined;
  if (images > limits.maxImages) return `Refused a request with ${images} images, over this route's cap of ${limits.maxImages}. Send fewer images per request.`;
  if (total > limits.maxTotalBytes) return `Refused a request whose images total ${total} bytes, over this route's cap of ${limits.maxTotalBytes} bytes. Send smaller images (the app downscales to a 1568-pixel long edge).`;
  if (caps.vision !== true) {
    return `Refused a request with ${images} image${images === 1 ? '' : 's'}: “${modelLabel}” does not accept images (its capability row has no vision). Choose a vision-capable model in Settings, or send the pictures as text — a caption or a transcription.`;
  }
  return undefined;
}

/** Validates one message and throws the gateway's refusal when it is malformed. Used by the adapters' body builders. */
export function assertValidMessage(message: Pick<ChatMessage, 'role' | 'content'>, route: ContentRoute | undefined): void {
  const problem = validateMessageContent(message, route);
  if (problem !== undefined) throw new EgressDeniedError(`Refused to build a request body: ${problem}.`);
}

// --- wire encoding ----------------------------------------------------------

/** Base64 of the bytes, in both the browser and Node, without ever building a giant string arg list. */
export function base64Of(bytes: Uint8Array): string {
  const nodeBuffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (nodeBuffer !== undefined) return nodeBuffer.from(bytes).toString('base64');
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** A data URL for the Chat and Responses routes. */
export function dataUrlOf(part: ImagePart): string {
  return `data:${part.mime};base64,${base64Of(part.bytes)}`;
}

// --- token estimates --------------------------------------------------------

/**
 * One image's estimated tokens on a route. With readable dimensions:
 *
 * - `anthropic-messages`: `ceil(width × height / 750)` — the Messages route's per-pixel rule.
 * - `openai-chat` / `openai-responses`: `85 + 170 × ceil(width/512) × ceil(height/512)` — the
 *   tile rule of a high-detail image (the default; no `detail` field is sent).
 *
 * On an unknown route with readable dimensions, the larger of the two rules. Without dimensions the
 * fallback is `ceil(size / 64)`, a size-based figure that is only as good as the header it could
 * not read. It is always labelled an estimate, and the base64 form is never counted as ordinary text tokens.
 */
export function imageTokens(part: ImagePart, route?: ContentRoute): number {
  const dims = imageDimensions(part.bytes, part.mime);
  if (dims !== undefined) {
    if (route === 'anthropic-messages') return Math.ceil((dims.width * dims.height) / 750);
    if (route === 'openai-chat' || route === 'openai-responses') {
      return 85 + 170 * Math.ceil(dims.width / 512) * Math.ceil(dims.height / 512);
    }
    // Unknown route, known pixels: the larger of the two rules, so the estimate never undercounts on either route.
    // A small image is cheaper per pixel than a tile, so the pixel rule alone would undercount it on the OpenAI routes.
    return Math.max(
      Math.ceil((dims.width * dims.height) / 750),
      85 + 170 * Math.ceil(dims.width / 512) * Math.ceil(dims.height / 512),
    );
  }
  return Math.ceil(part.size / 64);
}

/** One content's estimated tokens on a route: text parts as text, images by {@link imageTokens}. */
export function contentTokens(content: MessageContent, route?: ContentRoute): number {
  let tokens = 0;
  for (const part of partsOf(content)) {
    tokens += part.type === 'text' ? tokensForChars(part.text.length) : imageTokens(part, route);
  }
  return tokens;
}
