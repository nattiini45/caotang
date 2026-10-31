import { describe, expect, it } from 'vitest';

import type { ImportBlock, ImportDocument, LossCode } from '../src/model.js';

/**
 * `src/model.ts` repeats `@caotang/import-core`'s model until #317 is merged. This pins the shapes the reader emits, so a drift
 * shows here first; when the copy becomes a re-export of `@caotang/import-core`, these still compile and pass.
 */
describe('the import block model the reader emits', () => {
  it('has the block kinds and loss codes of import-core.md §2', () => {
    const blocks: ImportBlock[] = [
      { kind: 'heading', level: 1, text: 'T', md: '# T' },
      { kind: 'para', md: 'p', text: 'p', src: { styleName: 'heading 1', outlineLevel: 1, align: 'center', allBold: true, allCaps: true, fontSizeRel: 1.5, pageBreakBefore: true, toc: true } },
      { kind: 'break', marker: '***' },
      { kind: 'pagebreak' },
      { kind: 'image', assetRef: 'a.png', alt: '' },
      { kind: 'other', md: 'a | b', loss: 'table' },
    ];
    const codes: LossCode[] = ['table', 'image-unreadable', 'equation', 'text-box', 'field', 'tracked-change', 'comment', 'footnote', 'formatting', 'embedded-object', 'unsupported'];
    const document: ImportDocument = {
      blocks,
      footnotes: [{ blockIndex: 1, label: '1', md: 'n' }],
      comments: [{ blockIndex: 1, md: 'c', author: 'A' }],
      metadata: { title: 't' },
      assets: [{ ref: 'a.png', mime: 'image/png', bytes: 1 }],
      losses: codes.map((code) => ({ code, count: 1 })),
    };
    expect(document.blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'break', 'pagebreak', 'image', 'other']);
  });
});
