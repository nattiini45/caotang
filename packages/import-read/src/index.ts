/**
 * `@caotang/import-read`: the readers every import shares (issue #268). The XML reader, the archive reader and the plain-text reader are separate
 * subpaths (`@caotang/import-read/xml`, `@caotang/import-read/zip`) so a caller loads only the one it needs; this index
 * re-exports them for Node hosts and tests. The plain-text reader is `@caotang/import-read/text`.
 */

export * from './xml.js';
export * from './zip.js';
export * from './text.js';
