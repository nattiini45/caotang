/**
 * Keeps the document's source-provenance map (source-provenance.ts) true while the writer edits.
 *
 * The only part of the map that is not tied to a node is where each link definition stands: a boundary between two top-level blocks.
 * After every transaction that changed the text, the boundaries are moved through that transaction's mapping, in a transaction the
 * plugin appends. Appended transactions are not recorded in the history journal and are made again when a journal is replayed, and
 * the history library groups an appended transaction with the one that caused it, so undo restores the map with the text.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { mapProvenance, readProvenance } from '../source-provenance.js';

/** The plugin on its own, for a ProseMirror state that is not a Tiptap editor. */
export const provenancePlugin = (): Plugin =>
  new Plugin({
    key: new PluginKey('caotangProvenance'),
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const before = readProvenance(oldState.doc.attrs['provenance']);
      if (before === null || before.defs.length === 0) return null;
      // A transaction that set the map itself (an undo or a replacement) has already put it where it belongs.
      if (newState.doc.attrs['provenance'] !== oldState.doc.attrs['provenance']) return null;
      const mapping = new Mapping();
      for (const tr of transactions) for (const map of tr.mapping.maps) mapping.appendMap(map);
      const next = mapProvenance(before, mapping, oldState.doc.content.size);
      if (next === before) return null;
      const tr = newState.tr.setDocAttribute('provenance', next);
      // An edit that is not the writer's stays out of the writer's undo, and so does the map it moves.
      if (transactions.some((root) => root.getMeta('addToHistory') === false)) tr.setMeta('addToHistory', false);
      return tr;
    },
  });

export const CaotangProvenance = Extension.create({
  name: 'caotangProvenance',
  addProseMirrorPlugins() {
    return [provenancePlugin()];
  },
});
