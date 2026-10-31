/**
 * Paragraph identity — pictures.md §2.3, the capture half.
 *
 * An anchor names a paragraph of the body projection (the stored body, UTF-16 offsets, front matter
 * already removed) by a short exact quote, 32 characters of context each side, the revision it was
 * captured at, and two tie-breakers: a hash of the whole normalised paragraph and its ordinal among
 * the body's non-blank blocks. This module captures and checks identity against one body. Carrying an
 * anchor across an edit — the diff, the verify step, `orphaned` and `moved` — is a separate piece of
 * work that takes the old and new bodies; it reads these types and does not live here.
 */

import type { ParagraphAnchor } from './model.js';

export const PARAGRAPH_EXACT_MAX = 200;
export const PARAGRAPH_CONTEXT = 32;

export interface ParagraphBlock {
  /** First and one-past-last UTF-16 offset of the block's text, outer whitespace excluded. */
  start: number;
  end: number;
  text: string;
  /** Zero-based among the non-blank blocks. */
  ordinal: number;
}

/** Blocks are the blank-line-separated top-level runs of the body, the same split the editor's projection makes. */
export function paragraphBlocks(body: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let first = -1;
  let last = -1;
  const close = (): void => {
    if (first >= 0) blocks.push({ start: first, end: last, text: body.slice(first, last), ordinal: blocks.length });
    first = -1;
  };
  let i = 0;
  while (i <= body.length) {
    let lineEnd = i;
    while (lineEnd < body.length && body[lineEnd] !== '\n' && body[lineEnd] !== '\r') lineEnd += 1;
    let s = i;
    let e = lineEnd;
    while (s < e && /\s/.test(body[s] ?? '')) s += 1;
    while (e > s && /\s/.test(body[e - 1] ?? '')) e -= 1;
    if (s === e) close();
    else {
      if (first < 0) first = s;
      last = e;
    }
    if (lineEnd >= body.length) break;
    i = lineEnd + (body[lineEnd] === '\r' && body[lineEnd + 1] === '\n' ? 2 : 1);
  }
  close();
  return blocks;
}

/** The text a block hash is taken over: NFC, whitespace runs collapsed, outer whitespace removed. Case and punctuation stay. */
export function normalizeBlockText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a over the UTF-8 bytes, as 16 lower-case hex digits. */
export function fnv1a64Hex(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

export function blockHashOf(text: string): string {
  return fnv1a64Hex(normalizeBlockText(text));
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function blockAt(blocks: readonly ParagraphBlock[], offset: number): ParagraphBlock | undefined {
  return blocks.find((b) => offset >= b.start && offset <= b.end) ?? blocks.find((b) => b.start > offset) ?? blocks[blocks.length - 1];
}

/**
 * Captures the identity of the paragraph at `position` (an offset, or the start of a selection). A
 * position in the blank space between paragraphs snaps to the next one, and past the end to the last.
 * `undefined` only when the body has no text at all.
 */
export function captureParagraphAnchor(body: string, position: number | { from: number }, capturedRevision: number): ParagraphAnchor | undefined {
  const blocks = paragraphBlocks(body);
  const block = blockAt(blocks, typeof position === 'number' ? position : position.from);
  if (block === undefined) return undefined;

  const from = block.start;
  let to = Math.min(block.end, from + PARAGRAPH_EXACT_MAX);
  if (to < block.end && isHighSurrogate(body.charCodeAt(to - 1))) to -= 1;
  let prefixStart = Math.max(0, from - PARAGRAPH_CONTEXT);
  if (prefixStart > 0 && isLowSurrogate(body.charCodeAt(prefixStart))) prefixStart += 1;
  let suffixEnd = Math.min(body.length, to + PARAGRAPH_CONTEXT);
  if (suffixEnd < body.length && isHighSurrogate(body.charCodeAt(suffixEnd - 1))) suffixEnd -= 1;

  return {
    from,
    to,
    exact: body.slice(from, to),
    prefix: body.slice(prefixStart, from),
    suffix: body.slice(to, suffixEnd),
    capturedRevision,
    blockHash: blockHashOf(block.text),
    ordinal: block.ordinal,
  };
}

export interface ParagraphIdentity {
  /** The short quote still sits at the anchor's offsets. */
  quote: boolean;
  /** The whole block at those offsets hashes the same. A separate question from the quote: an edit past the first 200 characters leaves the quote alone. */
  block: boolean;
  /** The block is still at the same position among the body's blocks. */
  ordinal: boolean;
}

/** Checks an anchor against a body at the anchor's own offsets, without searching. */
export function checkParagraphAnchor(body: string, anchor: ParagraphAnchor): ParagraphIdentity {
  const quote = anchor.from >= 0 && anchor.to <= body.length && body.slice(anchor.from, anchor.to) === anchor.exact;
  const block = paragraphBlocks(body).find((b) => anchor.from >= b.start && anchor.from <= b.end);
  return {
    quote,
    block: block !== undefined && blockHashOf(block.text) === anchor.blockHash,
    ordinal: block !== undefined && block.ordinal === anchor.ordinal,
  };
}
