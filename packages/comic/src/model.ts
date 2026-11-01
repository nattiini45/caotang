/**
 * The comic vocabulary — [comics.md](../../../docs/architecture/comics.md) §2.
 *
 * Everything here is plain JSON: the store carries `tree[].comic` and `tree[].comicPage` unread and this
 * package owns their fields. Every object keeps an index signature so a key a newer build wrote survives a
 * load and a round trip (project-format §6).
 *
 * Enum fields are typed {@link Open}: a loaded value outside a closed list is kept verbatim, and only the
 * write boundary (`validateComicPage`) refuses it, unless the value is the one already stored.
 */

/** A closed string list that still admits a value an unknown build wrote. */
export type Open<T extends string> = T | (string & Record<never, never>);

export const PAGE_SIZES = ['us-comic', 'manga-b5', 'a4', 'letter'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const READING_DIRECTIONS = ['ltr', 'rtl'] as const;
export type ReadingDirection = (typeof READING_DIRECTIONS)[number];

export const BALLOON_KINDS = ['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout', 'radio'] as const;
export type BalloonKind = (typeof BALLOON_KINDS)[number];

export const PANEL_BORDERS = ['none', 'thin', 'bold'] as const;
export type PanelBorder = (typeof PANEL_BORDERS)[number];

export const BALLOON_STYLES = ['lettering', 'sfx'] as const;
export type BalloonStyle = (typeof BALLOON_STYLES)[number];

/** `[x, y, w, h]`. A panel and a balloon rect are 0..1 of the page's live area; a crop is 0..1 of the picture. */
export type Rect = readonly [number, number, number, number];
export type Point = readonly [number, number];

/** The default lettering face; a book setting so it can be swapped without a model change (D11). */
export const DEFAULT_LETTERING_FACE = 'comic-neue';

export interface ComicBookSettings {
  readingDirection: Open<ReadingDirection>;
  letteringFace: string;
  capsTransform: boolean;
  /** German ß becomes SS unless the book opts into ẞ. */
  esszett: boolean;
  pageSize: Open<PageSize>;
  /** Absent, never empty and never guessed, when the book has no script (comics.md §2). */
  scriptDocId?: string;
  [key: string]: unknown;
}

/** edit-anchors.md §2's shape, restated structurally so this package does not depend on the editor. */
export interface TextAnchor {
  from: number;
  to: number;
  exact: string;
  prefix: string;
  suffix: string;
  capturedRevision: number;
  [key: string]: unknown;
}

/**
 * One script line a panel covers. Comics.md names `DialogueCoverage` without defining it, so this mirrors the
 * storyboard's and adds the balloon that letters the line: a line without `balloonId` is covered but not lettered.
 */
export interface DialogueCoverage {
  kind: 'comic-script-line';
  docId: string;
  anchor: TextAnchor;
  balloonId?: string;
  [key: string]: unknown;
}

export interface Balloon {
  id: string;
  kind: Open<BalloonKind>;
  text: string;
  /** A codex id, never a name. */
  speaker?: string;
  /** Page live-area space, the same as a panel's, so a balloon may hang over a gutter. */
  rect: Rect;
  /** Where the tail aims (the speaker's mouth), in the same space as `rect`. */
  tail?: Point;
  offPanel?: true;
  fontSize?: number;
  style?: Open<BalloonStyle>;
  [key: string]: unknown;
}

export interface Panel {
  id: string;
  rect: Rect;
  assetId?: string;
  crop?: Rect;
  border?: Open<PanelBorder>;
  /** Reading order inside the panel is array order. */
  balloons: Balloon[];
  script?: DialogueCoverage[];
  [key: string]: unknown;
}

export interface ComicPage {
  size: Open<PageSize>;
  layout?: string;
  /** Reading order is array order (LTR or RTL per the book's setting). */
  panels: Panel[];
  [key: string]: unknown;
}

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export const isBalloonKind = (value: unknown): value is BalloonKind => isOneOf(BALLOON_KINDS, value);
export const isPageSize = (value: unknown): value is PageSize => isOneOf(PAGE_SIZES, value);
export const isReadingDirection = (value: unknown): value is ReadingDirection => isOneOf(READING_DIRECTIONS, value);

/** What a renderer draws for a balloon kind it does not know. */
export function drawnKind(kind: string): BalloonKind {
  return isBalloonKind(kind) ? kind : 'speech';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
