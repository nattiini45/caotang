/**
 * `@caotang/import-rtf`: the RTF reader every RTF-based import shares (issue #274): Scrivener's `content.rtf` and `notes.rtf`, and a
 * standalone `.rtf` or `.rtfd` file. Bytes in, the import block list (`ImportDocument`, import-core.md §2) and its losses out.
 */

export type { RtfErrorCode, RtfImport, RtfLimits, RtfLink, RtfReadOptions, RtfReadResult } from './rtf.js';
export { RTF_LIMITS, RtfReadError, readRtf } from './rtf.js';
export type { RtfdReadResult } from './rtfd.js';
export { readRtfd, rtfdTextPath } from './rtfd.js';
export { scanPartsOf } from './scan.js';
export { canDecode, decodeCodePage } from './codepage.js';
export { isSafeLinkTarget } from './markdown.js';
export type * from './model.js';
