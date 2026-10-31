/**
 * The store's side of the media track's node creation (storyboard.md §2.1, dialogue-narrative.md §2.1,
 * screenplay.md §2.1). `binder.create` names a node by its type and kind; this file makes the node that name asks
 * for, with the body record its kind needs, and leaves the prose folder and document to the store's own primitives.
 *
 * What a kind needs from the store:
 *  - a `screenplay` document holds a body, written as `docs/<id>.fountain`;
 *  - a `dialogue` container holds a body, written as `docs/<id>.ink`, and is marked `branching` (its graph-view marker);
 *  - a `shot` holds no body at all, so it gets no record: its content is its metadata and an image (storyboard.md §2.1).
 *    The storyboard module writes the metadata through `shot.setMeta`; creating the card is this function's job.
 *  - a `storyboard` folder is a folder with the `storyboard` marker, and holds no body.
 */

import { loadComicBook, pageFromTemplate, serializeComicPage } from '@caotang/comic';

import type { TreeNode } from './manifest.js';
import { addDocument, addNode, nodeById, type ProjectState } from './state.js';

/** The params `binder.create` validates to. A structural copy: the bus type is not a dependency of this file. */
export interface MediaCreateParams {
  readonly parentId: string;
  readonly type: 'folder' | 'document' | 'shot' | 'dialogue' | 'comic-page';
  readonly title: string;
  readonly kind?: string;
}

/**
 * The node a `binder.create` names. A `dialogue` container with no kind named is `branching`, the same default the bus
 * validator fills in, so a caller that reaches the store without the bus still gets the marker the graph view needs.
 */
export function createBinderNode(state: ProjectState, params: MediaCreateParams, now: Date): TreeNode {
  const kind = params.kind ?? (params.type === 'dialogue' ? 'branching' : undefined);
  const kindField = kind === undefined ? {} : { kind };
  if (params.type === 'document' || params.type === 'dialogue') {
    return addDocument(state, { parentId: params.parentId, title: params.title, type: params.type, ...kindField, now });
  }
  const node = addNode(state, { parentId: params.parentId, title: params.title, type: params.type, ...kindField, now });
  if (params.type === 'comic-page') {
    // A page starts from the book's own size and direction, so a new page is ready to be drawn on.
    const book = loadComicBook(nodeById(state, params.parentId)?.comic).value;
    node.comicPage = serializeComicPage(pageFromTemplate({ size: book.pageSize, direction: book.readingDirection as 'ltr' | 'rtl' }));
  }
  return node;
}
