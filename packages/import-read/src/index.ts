/**
 * `@caotang/import-read`: the readers every import shares (issue #268). The XML reader and the archive reader are separate
 * subpaths (`@caotang/import-read/xml`, `@caotang/import-read/zip`) so a caller loads only the one it needs; this index
 * re-exports both for Node hosts and tests.
 */

export * from './xml.js';
export * from './zip.js';
