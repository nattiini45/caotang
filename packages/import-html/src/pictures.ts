/**
 * The pictures a page names but the import cannot resolve (#299). A ref with no bytes behind it would be written into the
 * writer's manuscript as `![alt](import:html-image-0-3)`, a target that resolves to nothing, so the words beside it are kept
 * instead and the target is named as a loss. The block count does not change, so the splitter's indexes and the losses that
 * point at a block still line up.
 */

import type { ImportBlock, LossWarning } from '@caotang/import-core';

/** How many targets the report names before it counts the rest. */
const NAMED_LIMIT = 20;

/** An inline picture whose target is one of the reader's own refs. */
const INLINE_IMAGE = /!\[([^\]]*)\]\((import:[A-Za-z0-9._/-]+)\)/g;

/** The relative target as paths to try inside the archive: its own folder first, then the archive root, `..` climbing. */
export function relativeCandidates(pagePath: string, target: string): readonly string[] {
  const clean = target.replace(/[?#].*$/, '');
  const parts = pagePath.split('/').slice(0, -1);
  const out: string[] = [];
  const walk = clean.split('/');
  const stack = [...parts];
  let above = false;
  for (const piece of walk) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') {
      if (stack.length === 0) above = true;
      else stack.pop();
      continue;
    }
    stack.push(piece);
  }
  if (!above) out.push(stack.join('/'));
  const root = walk.filter((piece) => piece !== '' && piece !== '.' && piece !== '..').join('/');
  if (root !== '' && !out.includes(root)) out.push(root);
  return out;
}

/** The blocks with every unresolved picture turned into its alt text, and one loss naming the targets. */
export function dropUnresolvedPictures(
  blocks: readonly ImportBlock[],
  resolved: ReadonlySet<string>,
  targets: ReadonlyMap<string, string>,
): { readonly blocks: ImportBlock[]; readonly losses: LossWarning[] } {
  const missing = new Map<string, string>();
  const note = (ref: string): void => {
    if (resolved.has(ref) || !targets.has(ref)) return;
    missing.set(targets.get(ref) as string, ref);
  };
  const inline = (text: string): string =>
    text.replace(INLINE_IMAGE, (whole, alt: string, ref: string) => {
      if (resolved.has(ref) || !targets.has(ref)) return whole;
      note(ref);
      return alt;
    });

  const out = blocks.map((block, index): ImportBlock => {
    if (block.kind === 'image') {
      if (resolved.has(block.assetRef) || !targets.has(block.assetRef)) return block;
      note(block.assetRef);
      const alt = block.alt.trim();
      return alt === '' ? { kind: 'para', md: '', text: '' } : { kind: 'para', md: alt, text: alt };
    }
    if (block.kind === 'para') return { ...block, md: inline(block.md), text: inline(block.text) };
    if (block.kind === 'heading') return { ...block, md: inline(block.md), text: inline(block.text) };
    if (block.kind === 'other') return { ...block, md: inline(block.md) };
    void index;
    return block;
  });

  if (missing.size === 0) return { blocks: out, losses: [] };
  const named = [...missing.keys()].slice(0, NAMED_LIMIT);
  const rest = missing.size - named.length;
  const list = `${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`;
  return {
    blocks: out,
    losses: [{ code: 'image-unreadable', message: `${list} could not be read from the file; the words beside each picture are kept.`, count: missing.size }],
  };
}
