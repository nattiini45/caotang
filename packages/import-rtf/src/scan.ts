/**
 * What the import injection scan reads for an RTF import. `scanImport` (packages/harness/src/agent/untrusted.ts) takes a list of
 * `{ where, text }`; this gives it every text the reader produced or dropped: each block, each footnote and comment, and the hidden
 * text, deleted revisions, field instructions and link targets that are not in a block. The app runs the scan, since the scan lives
 * in the harness and this package depends on nothing.
 */

import type { RtfImport } from './rtf.js';

export function scanPartsOf(imported: RtfImport): { readonly where: string; readonly text: string }[] {
  const parts: { where: string; text: string }[] = [];
  const doc = imported.document;
  doc.blocks.forEach((block, index) => {
    if (block.kind === 'para' || block.kind === 'heading') parts.push({ where: `block ${index}`, text: block.text });
    else if (block.kind === 'other') parts.push({ where: `block ${index}`, text: block.md });
    else if (block.kind === 'image' && block.alt.length > 0) parts.push({ where: `block ${index}`, text: block.alt });
  });
  for (const note of doc.footnotes ?? []) parts.push({ where: `footnote ${note.label}`, text: note.md });
  for (const comment of doc.comments ?? []) parts.push({ where: `comment on block ${comment.blockIndex}`, text: comment.md });
  for (const [key, value] of Object.entries(doc.metadata ?? {})) if (value !== undefined) parts.push({ where: `metadata ${key}`, text: value });
  for (const link of imported.links) parts.push({ where: `link in block ${link.blockIndex}`, text: link.target });
  parts.push(...imported.scanExtra);
  return parts;
}
