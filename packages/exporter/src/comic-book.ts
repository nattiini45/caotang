/**
 * The comic book a selection names — [comics.md](../../../docs/architecture/comics.md) §2.
 *
 * A comic is a folder with `kind: 'comic'` and its settings in `comic`; its pages are `comic-page` children with their panels in
 * `comicPage`. Both are read here the way the model's loaders read them: whatever is stored is kept as far as it has a shape, and
 * what has none is dropped with a log line, so a hand-edited manifest cannot crash a compile. The nodes are read as plain records,
 * not through the store's `TreeNode`, because the store carries these fields as additive and unknown-tolerant values.
 */

import { loadComicBook, loadComicPage, type ComicBookSettings } from '@caotang/comic';
import type { ProjectState, TreeNode } from '@caotang/store';

import type { ComicPdfBook, ComicPdfPageInput } from './render-comic-pdf.js';

export interface SelectedComic {
  readonly book: ComicPdfBook;
  readonly notes: readonly string[];
}

export type ComicSelection = { readonly ok: true; readonly comic: SelectedComic } | { readonly ok: false; readonly reasons: readonly string[] };

const record = (node: TreeNode): Record<string, unknown> => node as unknown as Record<string, unknown>;

const isComicPageNode = (node: TreeNode): boolean => (node.type as string) === 'comic-page';
const isComicFolder = (node: TreeNode): boolean => node.kind === 'comic';

const childrenOf = (nodes: readonly TreeNode[], parentId: string | null): TreeNode[] =>
  nodes.filter((node) => node.parentId === parentId).sort((a, b) => a.order - b.order);

/**
 * The pages under a selection in binder order, and the one book they belong to. A selection of pages from more than one comic, or
 * with no page, is refused with what the writer can do about it. `label` names the format in the notes it returns.
 */
export function selectComic(state: ProjectState, includeRootIds: readonly string[], projectTitle: string, label = 'comic PDF'): ComicSelection {
  const nodes = state.manifest.tree;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chosen = new Set(includeRootIds);
  const pages: { node: TreeNode; folder: TreeNode | undefined }[] = [];
  const seen = new Set<string>();

  const visit = (node: TreeNode, inherited: boolean, folder: TreeNode | undefined): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const selected = inherited || chosen.has(node.id);
    const own = isComicFolder(node) ? node : folder;
    if (selected && isComicPageNode(node)) pages.push({ node, folder: own });
    for (const child of childrenOf(nodes, node.id)) visit(child, selected, own);
  };
  for (const root of childrenOf(nodes, null)) visit(root, false, undefined);

  if (pages.length === 0) {
    return { ok: false, reasons: ['the selection holds no comic page, so there is no comic to draw. Select a comic or some of its pages'] };
  }
  const folders = [...new Set(pages.map((entry) => entry.folder?.id ?? ''))];
  if (folders.length > 1) {
    const named = folders.map((id) => `"${byId.get(id)?.title ?? 'pages outside a comic'}"`).join(', ');
    return { ok: false, reasons: [`the selection holds pages of more than one comic (${named}), and one ${label === 'comic PDF' ? 'PDF' : 'file'} holds one comic. Select one comic`] };
  }

  const folder = pages[0]?.folder;
  const notes: string[] = [];
  const loadedBook = loadComicBook(folder === undefined ? undefined : record(folder)['comic']);
  if (folder !== undefined && loadedBook.issues.length > 0) {
    notes.push(`${label}: the settings of "${folder.title}" have ${loadedBook.issues.length} ${loadedBook.issues.length === 1 ? 'value' : 'values'} the model could not read, which fall back to the defaults`);
  }
  if (folder === undefined) notes.push(`${label}: the pages sit outside a comic folder, so the book settings are the defaults (left to right, Comic Neue lettering)`);

  const inputs: ComicPdfPageInput[] = [];
  for (const [index, entry] of pages.entries()) {
    const loaded = loadComicPage(record(entry.node)['comicPage']);
    if (loaded.issues.length > 0) {
      notes.push(`${label}: page ${index + 1} ("${entry.node.title}") has ${loaded.issues.length} ${loaded.issues.length === 1 ? 'value' : 'values'} the model could not read, which ${loaded.issues.length === 1 ? 'is' : 'are'} left out`);
    }
    inputs.push({ id: entry.node.id, page: loaded.value });
  }
  const settings: ComicBookSettings = loadedBook.value;
  return { ok: true, comic: { book: { title: folder?.title ?? projectTitle, settings, pages: inputs }, notes } };
}
