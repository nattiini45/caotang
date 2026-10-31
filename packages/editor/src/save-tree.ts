/**
 * The mdast a save stringifies: the document's own tree, plus the Markdown it kept from the source (source-provenance.ts).
 *
 * `serialize` and the dialect sniffer both render through this, so they cannot disagree about what a save writes. A document with no
 * provenance takes the shared handler table and is rendered exactly as before.
 */
import { fromProseMirror } from '@handlewithcare/remark-prosemirror';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Root } from 'mdast';
import { createSerializeHandlers, rawSourceNode } from './handlers.js';
import { definitionChunks, readProvenance, resolveReferenceRuns } from './source-provenance.js';
import type { SourceProvenance } from './source-provenance.js';
import { caotangSchema } from './schema.js';

/** §3.3's serialize handlers, built once. */
const SAVE_HANDLERS = createSerializeHandlers();

/** The handler table for one map, built once per map: a document's map keeps its identity until it changes. */
const tables = new WeakMap<object, ReturnType<typeof createSerializeHandlers>>();
const handlersFor = (provenance: SourceProvenance): ReturnType<typeof createSerializeHandlers> => {
  let table = tables.get(provenance);
  if (table === undefined) {
    table = createSerializeHandlers(provenance);
    tables.set(provenance, table);
  }
  return table;
};

export interface SaveTreeOptions {
  /**
   * Write the kept definitions between the blocks. The dialect sniffer renders block by block and leaves them out, because a
   * definition belongs to no block.
   */
  readonly definitions?: boolean;
}

const isEmptyParagraph = (doc: PmNode): boolean =>
  doc.childCount === 1 && doc.child(0).type.name === 'paragraph' && doc.child(0).content.size === 0;

export const toSaveTree = (pm: PmNode, options: SaveTreeOptions = {}): Root => {
  const provenance = readProvenance(pm.attrs['provenance']);
  if (provenance === null) {
    return fromProseMirror(pm, { schema: caotangSchema, nodeHandlers: SAVE_HANDLERS as never, markHandlers: SAVE_HANDLERS as never });
  }
  const handlers = handlersFor(provenance);
  const tree = fromProseMirror(resolveReferenceRuns(pm, provenance), {
    schema: caotangSchema,
    nodeHandlers: handlers as never,
    markHandlers: handlers as never,
  });
  if (options.definitions === false || provenance.defs.length === 0) return tree;
  // A body that was only definitions has one empty paragraph standing in for nothing, so it is not written.
  const blocks = isEmptyParagraph(pm) ? [] : tree.children;
  const chunks = definitionChunks(pm, provenance);
  const children: Root['children'] = [];
  let next = 0;
  for (let index = 0; index <= blocks.length; index += 1) {
    while (next < chunks.length && chunks[next]!.index <= index) children.push(rawSourceNode(chunks[next++]!.text) as never);
    if (index < blocks.length) children.push(blocks[index]!);
  }
  while (next < chunks.length) children.push(rawSourceNode(chunks[next++]!.text) as never);
  return { ...tree, children };
};
