/**
 * The binder's entries for making a media node (screenplay, dialogue, storyboard and comic; media-track.md): a screenplay scene, a storyboard, a shot card, a
 * dialogue container, a comic book and a comic page. The rules for which kind goes where live here, with the media kinds, and the binder only asks for
 * the entries a node earns. Every create is a `binder.create`, so the bus checks it (storyboard.md §2.1: a shot lives in
 * a storyboard folder; dialogue-narrative.md §2.1: a container is `branching`), and a refusal reaches the binder's error line.
 */

import { t } from '@lingui/core/macro';
import type { TreeNode } from '@caotang/store';

import { isStoryboardFolder } from './engines.js';

/** A comic book: a folder marked `comic` (comics.md §3.1). It holds only its pages and its script. */
function isComicBook(node: TreeNode): boolean {
  return node.type === 'folder' && node.kind === 'comic';
}
import { defaultTitleOf } from '@caotang/i18n';

/** What the binder asks the bus to create: the params `binder.create` takes, less the parent. */
export interface MediaCreateSpec {
  readonly type: 'folder' | 'document' | 'shot' | 'dialogue' | 'comic-page';
  /** `comic` is a comic book: the binder makes it with `comic.createBook`, which gives it its first page. */
  readonly kind?: 'screenplay' | 'storyboard' | 'branching' | 'comic';
  readonly title: string;
}

/**
 * One entry of the binder's context menu: the fields `components/shared.tsx`'s `MenuItem` takes, which the binder adds
 * to its own list. Declared here so this module imports no component file.
 */
export interface MediaMenuItem {
  readonly key: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly separatorBefore?: boolean;
}

/**
 * The menu entries for a node. A chapter (a folder directly under the manuscript) offers a screenplay scene, a storyboard and a
 * dialogue container; a storyboard folder offers a shot card, and nothing else, because a storyboard holds only shots. Any other
 * node offers nothing: the manuscript and research sections are not chapters, and a document goes inside a chapter (docs/decisions.md
 * 2026-10-14, "Chapterless documents"), and a document is not a container, so the binder's own entries cover it.
 */
export function mediaCreateItems(node: TreeNode, create: (parentId: string, spec: MediaCreateSpec) => void, language?: string): MediaMenuItem[] {
  if (isStoryboardFolder(node)) {
    return [{ key: 'new-shot', label: t`New shot here`, separatorBefore: true, onSelect: () => create(node.id, { type: 'shot', title: defaultTitleOf('shot', language) }) }];
  }
  if (isComicBook(node)) {
    return [{ key: 'new-comic-page', label: t`New page here`, separatorBefore: true, onSelect: () => create(node.id, { type: 'comic-page', title: defaultTitleOf('comicPage', language) }) }];
  }
  if (node.type !== 'folder' || node.parentId !== 'manuscript') return [];
  return [
    {
      key: 'new-screenplay',
      label: t`New screenplay scene here`,
      separatorBefore: true,
      onSelect: () => create(node.id, { type: 'document', kind: 'screenplay', title: defaultTitleOf('scene', language) }),
    },
    {
      key: 'new-storyboard',
      label: t`New storyboard here`,
      onSelect: () => create(node.id, { type: 'folder', kind: 'storyboard', title: defaultTitleOf('storyboard', language) }),
    },
    {
      key: 'new-dialogue',
      label: t`New dialogue here`,
      onSelect: () => create(node.id, { type: 'dialogue', kind: 'branching', title: defaultTitleOf('dialogue', language) }),
    },
    {
      key: 'new-comic',
      label: t`New comic here`,
      onSelect: () => create(node.id, { type: 'folder', kind: 'comic', title: defaultTitleOf('comic', language) }),
    },
  ];
}
