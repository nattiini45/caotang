/**
 * A new page — comics.md §2.1: a template is a starting point, so a page made from one is an ordinary page whose panels the
 * writer then moves.
 */

import { mintPanelId } from './codec.js';
import { templateRects, type TemplateId } from './layout.js';
import type { ComicPage, Panel, ReadingDirection } from './model.js';

/** What a new page starts from: a six-panel grid is the common floppy page. */
export const DEFAULT_PAGE_TEMPLATE: TemplateId = 'grid-6';

export interface NewPageOptions {
  size: string;
  direction?: ReadingDirection;
  template?: TemplateId;
}

export function pageFromTemplate(options: NewPageOptions): ComicPage {
  const template = options.template ?? DEFAULT_PAGE_TEMPLATE;
  const taken = new Set<string>();
  const panels: Panel[] = templateRects(template, {
    size: options.size,
    ...(options.direction === undefined ? {} : { direction: options.direction }),
  }).map((rect) => {
    const id = mintPanelId(taken);
    taken.add(id);
    return { id, rect: [rect[0], rect[1], rect[2], rect[3]], border: 'thin', balloons: [] };
  });
  return { size: options.size, layout: template, panels };
}
