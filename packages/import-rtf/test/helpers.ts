import { readFileSync } from 'node:fs';

import { expect } from 'vitest';

import { readRtf, type RtfImport, type RtfReadOptions } from '../src/index.js';
import type { ImportBlock } from '../src/model.js';

/** A 1×1 PNG, the picture the Word fixture embeds and the .rtfd tests attach. Kept as hex: no binary file sits under a guarded root. */
export const PIXEL_PNG = Uint8Array.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082'.match(/../g) ?? [],
  (byte) => parseInt(byte, 16),
);

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

/** Reads RTF and fails the test when the reader refuses it. */
export function read(input: string | Uint8Array, options?: RtfReadOptions): RtfImport {
  const result = readRtf(input, options);
  if (!result.ok) expect.fail(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The blocks' Markdown (a page break as `<page>`, a picture as `<image ref>`). */
export function mdOf(imported: RtfImport): string[] {
  return imported.document.blocks.map(md);
}

export function md(block: ImportBlock): string {
  switch (block.kind) {
    case 'para':
    case 'heading':
    case 'other':
      return block.md;
    case 'pagebreak':
      return '<page>';
    case 'image':
      return `<image ${block.assetRef}>`;
    case 'break':
      return block.marker;
  }
}

export function lossMessages(imported: RtfImport): string[] {
  return (imported.document.losses ?? []).map((l) => `${l.code}: ${l.message}${l.count !== undefined && l.count > 1 ? ` ×${l.count}` : ''}`);
}

/** A one-paragraph document around a body. */
export const doc = (body: string, header = '\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}}'): string => `{\\rtf1${header}\n${body}}`;
