import type { ComicPage } from './model.js';
import type { MessageRef } from './message.js';

/** The deterministic checks this package computes; the coherence registry owns their registration. */
export type ComicCheckId =
  | 'comic.balloon-coverage'
  | 'comic.balloon-density'
  | 'comic.em-dash'
  | 'comic.caps-policy';

/** A page as the checks read it: the store's node id and number beside the stored value. */
export interface ComicPageInput {
  id: string;
  /** The page number, derived from order. */
  number: number;
  page: ComicPage;
}

export interface ComicFindingWhere {
  pageId?: string;
  pageNumber?: number;
  panelId?: string;
  balloonId?: string;
  docId?: string;
  /** For a script line: its offsets in the script body at the time of the check. */
  scriptRange?: { from: number; to: number };
}

/** A finding before the coherence module gives it an id, a run and a dismissal state. */
export interface ComicDraftFinding {
  checkId: ComicCheckId;
  code: string;
  severity: 'warning' | 'info';
  /** Stable across runs while the thing it points at is unchanged, so a dismissal keeps matching. */
  key: string;
  message: MessageRef;
  nextAction: MessageRef;
  /** The writer's own words that triggered it, shortened. */
  evidence: string;
  where: ComicFindingWhere;
}

export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
