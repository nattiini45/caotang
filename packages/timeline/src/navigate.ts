/**
 * What an item opens in its real media view ([timeline.md §9.3, §9.4](../../../docs/architecture/timeline.md)). The shell
 * opens a node and the centre pane routes on the node's own kind (a shots folder to its board, a dialogue container to the
 * Ink view, a comic page to the page view), so navigation is a node id and nothing here knows a view. It is a pure function
 * of the model so the shell's wiring can be checked without a page.
 */

import { COMIC_GLYPH, DIALOGUE_GLYPH } from './media.js';
import type { Medium, TimelineItem, TimelineModel } from './model.js';

export interface MediaEntry {
  kind: 'dialogue' | 'book' | 'shots' | 'pages';
  medium: Medium;
  title: string;
  glyph: string;
  /**
   * The node the shell opens. Absent when the declaration names a node that is gone: the entry is then a note that says what
   * is missing, not a button that opens nothing.
   */
  open?: string;
  /** The id a broken declaration names. */
  ref?: string;
  /** Strip entries: the strip, whose cells each open their own node. */
  strip?: TimelineItem;
}

/** The media a scene reaches: its declared links and the strips under it, in a fixed order (links, then shots, then pages). */
export function mediaEntriesOf(model: TimelineModel, nodeId: string): MediaEntry[] {
  const entries: MediaEntry[] = [];
  const scene = model.items.find((item) => item.nodeId === nodeId);
  for (const link of scene?.links ?? []) {
    const kind = link.medium === 'dialogue' ? 'dialogue' : 'book';
    entries.push({
      kind,
      medium: link.medium,
      title: link.title ?? '',
      glyph: link.medium === 'dialogue' ? DIALOGUE_GLYPH : COMIC_GLYPH,
      ...(link.nodeId !== undefined ? { open: link.nodeId } : {}),
      ...(link.broken === true && link.ref !== undefined ? { ref: link.ref } : {}),
    });
  }
  for (const strip of model.strips) {
    if (strip.hostId !== nodeId) continue;
    entries.push(stripEntry(strip));
  }
  return entries.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

const ORDER: readonly MediaEntry['kind'][] = ['dialogue', 'book', 'shots', 'pages'];

function stripEntry(strip: TimelineItem): MediaEntry {
  const broken = strip.links?.find((link) => link.broken === true);
  return {
    kind: strip.kind === 'shot-strip' ? 'shots' : 'pages',
    medium: strip.medium,
    title: strip.label,
    glyph: strip.mediumGlyph ?? '',
    ...(strip.open !== undefined ? { open: strip.open } : {}),
    ...(broken?.ref !== undefined ? { ref: broken.ref } : {}),
    strip,
  };
}

/** Strips with no scene to hang under: a comic book written from its pages, or one whose script is gone. */
export function unattachedStrips(model: TimelineModel): TimelineItem[] {
  return model.strips.filter((strip) => strip.readingIndex < 0);
}
