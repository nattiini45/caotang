/**
 * What `import-rtf-worker.spec.ts` asks the RTF reader, written once and run in three places: the Node test runner, the page's
 * main thread, and a module Worker. The reader is passed in rather than imported, so the same function runs against whichever copy
 * of the module each place loaded.
 */

import type * as Rtf from '../packages/import-rtf/src/rtf.js';

export interface RtfInput {
  /** An RTF file's bytes: \uc0 and \uc1 text, an emoji as a surrogate pair, a GBK font, a footnote, a table row and a PNG picture. */
  readonly rtf: readonly number[];
}

export interface RtfSummary {
  readonly blocks: readonly string[];
  readonly footnotes: readonly string[];
  readonly assets: readonly string[];
  readonly losses: readonly string[];
  readonly notRtf: string;
}

export function rtfSummary(input: RtfInput, readRtf: typeof Rtf.readRtf): RtfSummary {
  const read = readRtf(new Uint8Array(input.rtf));
  if (!read.ok) throw read.error;
  const { document } = read.value;
  const notRtf = readRtf('plain text');
  return {
    blocks: document.blocks.map((b) => (b.kind === 'para' || b.kind === 'other' ? b.md : b.kind === 'image' ? `<image ${b.assetRef}>` : `<${b.kind}>`)),
    footnotes: (document.footnotes ?? []).map((f) => `${f.label}@${f.blockIndex}: ${f.md}`),
    assets: (document.assets ?? []).map((a) => `${a.ref} ${a.mime ?? ''} ${a.bytes ?? 0}`),
    losses: (document.losses ?? []).map((l) => l.code),
    notRtf: notRtf.ok ? 'read' : `${notRtf.error.name}:${notRtf.error.code}`,
  };
}
