/**
 * The import block model (import-core.md §2), as the RTF reader emits it.
 *
 * The model's home is `@caotang/import-core` (#266, `packages/import-core/src/model.ts`); this file only re-exports the types the
 * reader uses, so the reader's own modules keep one local import path. `test/model.test.ts` pins the shapes the reader depends on.
 */
export type {
  Align,
  BreakBlock,
  HeadingBlock,
  ImageBlock,
  ImportAsset,
  ImportBlock,
  ImportComment,
  ImportDocument,
  ImportFootnote,
  ImportMetadata,
  InjectionHit,
  LossCode,
  LossWarning,
  OtherBlock,
  PageBreakBlock,
  ParaBlock,
  Signals,
} from '@caotang/import-core';
