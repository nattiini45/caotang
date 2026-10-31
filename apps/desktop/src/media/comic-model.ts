/**
 * What the comic page editor plans and draws — pure, so the geometry and every gesture's command are tested without a
 * renderer (comics.md §3.3, §3.4).
 *
 * A page is stored in the live area's own 0..1 space; the view draws the trim in millimetres, so every rectangle is
 * placed once here, from the same `pageGeometry` the comic PDF reads, and a panel is where the PDF will put it. A page
 * the loader had to repair (an unknown size, a panel it could not read) still draws what it kept, because the load is
 * tolerant and the view only reads.
 *
 * Every edit is planned here as a whole new page value, and the one command it becomes is `comic.setPage` with the
 * stored value it replaces as `expect` (the `shot.setMeta` pattern): one gesture is one guarded command, undoable, and
 * a page that changed since it was read is refused rather than overwritten. The photo return (§3.4) plans its batch
 * with `planPhotoReturn` and proposes each panel's crop with `proposedPanelCrop`; the photograph itself stays a
 * page-level source link until the writer confirms the crops.
 */

import {
  DEFAULT_GUTTER_MM,
  balloonGeometry,
  clampUnitRect,
  gutterNormalized,
  isTemplateId,
  loadComicBook,
  loadComicPage,
  mintBalloonId,
  mintPanelId,
  pageGeometry,
  serializeComicBook,
  serializeComicPage,
  snapMove,
  snapResize,
  templateRects,
  type Balloon,
  type ComicPage,
  type PageGeometry,
  type Panel,
  type Point,
  type ReadingDirection,
  type Rect,
  type ResizeEdges,
  type SnapOptions,
  type TemplateId,
} from '@caotang/comic';
import type { ProjectState, TreeNode } from '@caotang/store';

export interface DrawnRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PointMm = readonly [number, number];

export interface DrawnTail {
  readonly base: readonly [PointMm, PointMm];
  readonly tip: PointMm;
}

export interface DrawnCircle {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

export interface DrawnBalloon extends DrawnRect {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  /** The outline shape the kind draws as, from `balloonStyleData`: the same the comic PDF draws. */
  readonly shape: string;
  /** The star polygon of a burst or spiky outline, in millimetres. */
  readonly points?: readonly PointMm[];
  /** The scallop count of a cloud outline. */
  readonly lobes?: number;
  /** Dash and gap in stroke widths, for a whisper. */
  readonly dash?: readonly [number, number];
  readonly stroke: 'none' | 'normal' | 'bold';
  readonly italic: boolean;
  readonly fontRole: 'lettering' | 'sfx';
  readonly tail?: DrawnTail;
  /** The three thought circles, largest nearest the balloon, in millimetres. */
  readonly circles?: readonly DrawnCircle[];
  /** Where the text may be set, in millimetres. */
  readonly textBox: DrawnRect;
}

export interface DrawnPanel extends DrawnRect {
  readonly id: string;
  /** The panel's place in reading order, from 1: its place in the stored array, which is the reading order. */
  readonly number: number;
  readonly assetId: string | undefined;
  readonly crop: Rect | undefined;
  readonly border: string | undefined;
  readonly balloons: readonly DrawnBalloon[];
}

export interface DrawnPage {
  /** The trim size, in millimetres: the view's own coordinate space. */
  readonly width: number;
  readonly height: number;
  /** The live area inside the trim, where the stored rectangles are measured from. */
  readonly live: DrawnRect;
  readonly geometry: PageGeometry;
  /** The book's own reading direction; the page's stored order is the reading order either way. */
  readonly direction: ReadingDirection;
  readonly panels: readonly DrawnPanel[];
}

/** The comic folder a node belongs to: the node itself when it is one, or the folder a page sits in. */
export function comicBookOf(tree: readonly TreeNode[], nodeId: string): TreeNode | undefined {
  const node = tree.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return undefined;
  if (node.type === 'folder' && node.kind === 'comic') return node;
  if (node.type !== 'comic-page' || node.parentId === null) return undefined;
  const parent = tree.find((candidate) => candidate.id === node.parentId);
  return parent !== undefined && parent.type === 'folder' && parent.kind === 'comic' ? parent : undefined;
}

/** The page's place among its book's pages, from 1, and how many the book has. */
export function pagePlaceOf(tree: readonly TreeNode[], page: TreeNode): { readonly number: number; readonly count: number } {
  const siblings = tree.filter((candidate) => candidate.parentId === page.parentId && candidate.type === 'comic-page').sort((a, b) => a.order - b.order);
  return { number: siblings.findIndex((candidate) => candidate.id === page.id) + 1, count: siblings.length };
}

/** A book's pages in binder order. */
export function comicPageNodesOf(tree: readonly TreeNode[], bookId: string): TreeNode[] {
  return tree.filter((candidate) => candidate.parentId === bookId && candidate.type === 'comic-page').sort((a, b) => a.order - b.order);
}

/** The page as the view draws it, in the book's reading direction. Reading order is the stored array order, the same order the comic PDF numbers by. */
export function drawnPageOf(rawPage: unknown, rawBook: unknown): DrawnPage {
  const page = loadComicPage(rawPage).value;
  const direction = loadComicBook(rawBook).value.readingDirection === 'rtl' ? 'rtl' : 'ltr';
  const geometry = pageGeometry(page.size);
  const live: DrawnRect = {
    x: geometry.liveMarginMm,
    y: geometry.liveMarginMm,
    width: geometry.liveWidthMm,
    height: geometry.liveHeightMm,
  };
  const place = (rect: Rect): DrawnRect => ({
    x: live.x + rect[0] * live.width,
    y: live.y + rect[1] * live.height,
    width: rect[2] * live.width,
    height: rect[3] * live.height,
  });
  const mm = (point: Point): PointMm => [live.x + point[0] * live.width, live.y + point[1] * live.height];
  return {
    width: geometry.trimWidthMm,
    height: geometry.trimHeightMm,
    live,
    geometry,
    direction,
    panels: page.panels.map((panel, index) => {
      const drawnPanel: DrawnRect = place(panel.rect);
      return {
        id: panel.id,
        number: index + 1,
        assetId: panel.assetId,
        crop: panel.crop,
        border: panel.border,
        ...drawnPanel,
        balloons: panel.balloons.map((balloon) => {
          const balloonGeometryOfPage = balloonGeometry(balloon, { aspect: geometry.aspect, panelRect: panel.rect });
          const style = balloonGeometryOfPage.style;
          const outline = balloonGeometryOfPage.outline;
          const drawn: DrawnBalloon = {
            id: balloon.id,
            kind: balloon.kind,
            text: balloon.text,
            shape: outline.shape,
            ...(outline.points === undefined ? {} : { points: outline.points.map(mm) }),
            ...(outline.lobes === undefined ? {} : { lobes: outline.lobes }),
            ...(style.dash === undefined ? {} : { dash: style.dash }),
            stroke: style.stroke,
            italic: style.italic,
            fontRole: style.fontRole,
            ...place(balloon.rect),
            textBox: place(balloonGeometryOfPage.textBox),
            ...(balloonGeometryOfPage.tail === undefined
              ? {}
              : { tail: { base: [mm(balloonGeometryOfPage.tail.base[0]), mm(balloonGeometryOfPage.tail.base[1])], tip: mm(balloonGeometryOfPage.tail.tip) } }),
            ...(balloonGeometryOfPage.circles === undefined
              ? {}
              : {
                  circles: balloonGeometryOfPage.circles.map((circle) => {
                    const [cx, cy] = mm([circle.cx, circle.cy]);
                    return { cx, cy, rx: circle.rx * live.width, ry: circle.ry * live.height };
                  }),
                }),
          };
          return drawn;
        }),
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Coordinate space: the pointer speaks screen, the page speaks 0..1 of the live area
 * ------------------------------------------------------------------ */

/** A point in the live area's 0..1 space, drawn at millimetres of the trim. */
export function mmOfLive(page: DrawnPage, point: Point): PointMm {
  return [page.live.x + point[0] * page.live.width, page.live.y + point[1] * page.live.height];
}

/** The live-area 0..1 point under a millimetre position of the trim, clamped into the live area. */
export function liveOfMm(page: DrawnPage, xMm: number, yMm: number): Point {
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  return [clamp01((xMm - page.live.x) / page.live.width), clamp01((yMm - page.live.y) / page.live.height)];
}

/* ------------------------------------------------------------------ *
 * Panel art: where a picture's crop lands on its panel
 * ------------------------------------------------------------------ */

export interface ImagePlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a panel's picture is drawn, in millimetres: the crop region scaled to cover the panel and centred on it,
 * clipped to the panel — the same placement the comic PDF draws. Without the picture's pixel size the crop region is
 * stretched onto the panel instead.
 */
export function imagePlacementOf(panel: DrawnRect, crop: Rect | undefined, imageWidth: number | undefined, imageHeight: number | undefined): ImagePlacement {
  const c: Rect = crop ?? [0, 0, 1, 1];
  if (imageWidth === undefined || imageHeight === undefined || !(imageWidth > 0) || !(imageHeight > 0) || !(c[2] > 0) || !(c[3] > 0)) {
    return {
      x: panel.x - (c[0] / c[2]) * panel.width,
      y: panel.y - (c[1] / c[3]) * panel.height,
      width: panel.width / c[2],
      height: panel.height / c[3],
    };
  }
  const scale = Math.max(panel.width / (c[2] * imageWidth), panel.height / (c[3] * imageHeight));
  const drawnW = imageWidth * scale;
  const drawnH = imageHeight * scale;
  const centreX = panel.x + panel.width / 2;
  const centreY = panel.y + panel.height / 2;
  return { x: centreX - (c[0] + c[2] / 2) * drawnW, y: centreY + (c[1] + c[3] / 2 - 1) * drawnH, width: drawnW, height: drawnH };
}

/* ------------------------------------------------------------------ *
 * The one command every gesture becomes
 * ------------------------------------------------------------------ */

export interface SetPageParams {
  readonly nodeId: string;
  readonly stored: Record<string, unknown>;
  /** The stored page the gesture read; a page that changed since is refused, not overwritten. */
  readonly expect: unknown;
}

export interface SetPageCommand {
  readonly name: 'comic.setPage';
  readonly params: SetPageParams;
}

/** The `comic.setPage` that writes a whole new page value over the one it replaces. `expect` defaults to what the node holds now; the photo return sends the value it read when its review opened. */
export function setPageCommand(node: TreeNode, next: ComicPage, expect?: unknown): SetPageCommand {
  return {
    name: 'comic.setPage',
    params: { nodeId: node.id, stored: serializeComicPage(next), expect: expect === undefined ? (node.comicPage ?? null) : expect },
  };
}

export interface SetBookParams {
  readonly nodeId: string;
  readonly stored: Record<string, unknown>;
  readonly expect: unknown;
}

export interface SetBookCommand {
  readonly name: 'comic.setBook';
  readonly params: SetBookParams;
}

/** The `comic.setBook` that changes the book's reading direction, whole settings over the stored ones. */
export function setBookDirectionCommand(node: TreeNode, direction: ReadingDirection): SetBookCommand {
  const current = loadComicBook(node.comic).value;
  return {
    name: 'comic.setBook',
    params: { nodeId: node.id, stored: serializeComicBook({ ...current, readingDirection: direction }), expect: node.comic ?? null },
  };
}

/* ------------------------------------------------------------------ *
 * Writing the script from the pages
 * ------------------------------------------------------------------ */

/** The book's script link as the writer can act on it: none, a script that is there, or a link whose document is gone. */
export type ScriptLink =
  | { readonly kind: 'none' }
  | { readonly kind: 'linked'; readonly docId: string; readonly title: string; readonly revision: number }
  | { readonly kind: 'broken'; readonly docId: string };

/** Never re-matched by title or content: a link is its stored id, and a document that is not a comic script is as gone as a missing one. */
export function scriptLinkOf(state: Pick<ProjectState, 'manifest' | 'documents'>, book: TreeNode): ScriptLink {
  const docId = loadComicBook(book.comic).value.scriptDocId;
  if (docId === undefined) return { kind: 'none' };
  const doc = state.manifest.tree.find((candidate) => candidate.id === docId);
  if (doc === undefined || doc.type !== 'document' || doc.kind !== 'comic-script') return { kind: 'broken', docId };
  return { kind: 'linked', docId, title: doc.title, revision: state.documents.get(docId)?.revision ?? 0 };
}

export interface ScriptFromPagesParams {
  readonly nodeId: string;
  /** The revision of the linked script the confirmation was shown against; absent when the book has no script yet. */
  readonly expectedRevision?: number;
}

export interface ScriptFromPagesCommand {
  readonly name: 'comic.scriptFromPages';
  readonly params: ScriptFromPagesParams;
}

/** The `comic.scriptFromPages` for a book, or `null` when it cannot run: a broken link has to be chosen again first, and a book with no pages has nothing to write from. */
export function scriptFromPagesCommand(book: TreeNode, link: ScriptLink, pageCount: number): ScriptFromPagesCommand | null {
  if (link.kind === 'broken' || pageCount === 0) return null;
  return {
    name: 'comic.scriptFromPages',
    params: link.kind === 'linked' ? { nodeId: book.id, expectedRevision: link.revision } : { nodeId: book.id },
  };
}

/* ------------------------------------------------------------------ *
 * Gutter snapping
 * ------------------------------------------------------------------ */

/** The snap options of a page: the default gutter in the page's own units, and a threshold of two per cent of the live area. */
export function snapOptionsFor(size: string): SnapOptions {
  return { gutter: gutterNormalized(DEFAULT_GUTTER_MM, size), threshold: 0.02 };
}

const othersOf = (page: ComicPage, panelId: string): readonly Rect[] => page.panels.filter((panel) => panel.id !== panelId).map((panel) => panel.rect);

/** One arrow-key step, in the live area's 0..1 space. */
export const KEY_STEP = 0.01;

/**
 * A keyboard nudge snaps only within half a step. The pointer's two per cent reach is wider than one step, so a one per cent nudge off a
 * gutter-aligned edge would be pulled straight back onto it and the key would do nothing.
 */
const KEY_SNAP_THRESHOLD = KEY_STEP / 2;

const snapOptionsOf = (page: ComicPage, fine: boolean): SnapOptions => {
  const options = snapOptionsFor(page.size);
  return fine ? { ...options, threshold: KEY_SNAP_THRESHOLD } : options;
};

/** A panel moved as one piece, its edges snapped to the gutters, the neighbours' edges and the live area. `fine` is a keyboard nudge. */
export function movedPanelRect(page: ComicPage, panelId: string, rect: Rect, fine = false): Rect {
  return snapMove(clampUnitRect([...rect]), othersOf(page, panelId), snapOptionsOf(page, fine));
}

/** A panel resized by the dragged edges, each edge snapped like a move, never below the minimum size. `fine` is a keyboard nudge. */
export function resizedPanelRect(page: ComicPage, panelId: string, edges: ResizeEdges, rect: Rect, fine = false): Rect {
  return snapResize(clampUnitRect([...rect]), edges, othersOf(page, panelId), snapOptionsOf(page, fine));
}

/* ------------------------------------------------------------------ *
 * Page edits, each a whole new page value
 * ------------------------------------------------------------------ */

const mapPanels = (page: ComicPage, edit: (panel: Panel, index: number) => Panel): ComicPage => ({ ...page, panels: page.panels.map(edit) });

const mapPanel = (page: ComicPage, panelId: string, edit: (panel: Panel) => Panel): ComicPage =>
  mapPanels(page, (panel) => (panel.id === panelId ? edit(panel) : panel));

const takenIdsOf = (page: ComicPage): Set<string> => {
  const taken = new Set<string>();
  for (const panel of page.panels) {
    taken.add(panel.id);
    for (const balloon of panel.balloons) taken.add(balloon.id);
  }
  return taken;
};

export function withPanelRect(page: ComicPage, panelId: string, rect: Rect): ComicPage {
  return mapPanel(page, panelId, (panel) => ({ ...panel, rect: clampUnitRect([...rect]) }));
}

export function withPanelBorder(page: ComicPage, panelId: string, border: Panel['border']): ComicPage {
  return mapPanel(page, panelId, (panel) => ({ ...panel, border }));
}

/** A new panel at a rect, numbered after the ones the page has, so it reads last until the writer moves it. */
export function withPanelAdded(page: ComicPage, rect: Rect): ComicPage {
  const panel: Panel = { id: mintPanelId(takenIdsOf(page)), rect: clampUnitRect([...rect]), border: 'thin', balloons: [] };
  return { ...page, panels: [...page.panels, panel] };
}

export function withPanelRemoved(page: ComicPage, panelId: string): ComicPage {
  return { ...page, panels: page.panels.filter((panel) => panel.id !== panelId) };
}

/** A template applied as a starting point: the page's panels become the template's, and `layout` names it. */
export function withTemplate(page: ComicPage, template: TemplateId, direction: ReadingDirection, size: string): ComicPage {
  const taken = new Set<string>();
  const panels: Panel[] = templateRects(template, { size, direction }).map((rect) => {
    const id = mintPanelId(taken);
    taken.add(id);
    return { id, rect: [rect[0], rect[1], rect[2], rect[3]], border: 'thin', balloons: [] };
  });
  return { ...page, layout: template, panels };
}

/** The panel moved `offset` places in the stored order, which is the reading order (negative is earlier). */
export function withPanelMoved(page: ComicPage, panelId: string, offset: number): ComicPage {
  const index = page.panels.findIndex((panel) => panel.id === panelId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= page.panels.length) return page;
  const panels = [...page.panels];
  const [panel] = panels.splice(index, 1);
  panels.splice(target, 0, panel as Panel);
  return { ...page, panels };
}

export function withPanelPicture(page: ComicPage, panelId: string, assetId: string, crop: Rect): ComicPage {
  return mapPanel(page, panelId, (panel) => ({ ...panel, assetId, crop: clampUnitRect([...crop]) }));
}

export function withPanelPictureCleared(page: ComicPage, panelId: string): ComicPage {
  return mapPanel(page, panelId, (panel) => {
    const next = { ...panel };
    delete next.assetId;
    delete next.crop;
    return next;
  });
}

/** A new balloon of a kind on a panel, its rect in the panel's upper half and its tail not yet aimed. */
export function withBalloonAdded(page: ComicPage, panelId: string, kind: Balloon['kind']): ComicPage {
  return mapPanel(page, panelId, (panel) => {
    const [px, py, pw, ph] = panel.rect;
    const rect = clampUnitRect([px + pw * 0.08, py + ph * 0.06, Math.min(pw * 0.62, 0.42), Math.min(ph * 0.26, 0.2)]);
    const balloon: Balloon = { id: mintBalloonId(takenIdsOf(page)), kind, text: '', rect };
    return { ...panel, balloons: [...panel.balloons, balloon] };
  });
}

export type BalloonPatch = Partial<Pick<Balloon, 'kind' | 'text' | 'rect' | 'tail' | 'offPanel' | 'style'>>;

export function withBalloonPatch(page: ComicPage, panelId: string, balloonId: string, patch: BalloonPatch): ComicPage {
  return mapPanel(page, panelId, (panel) => ({
    ...panel,
    balloons: panel.balloons.map((balloon) => {
      if (balloon.id !== balloonId) return balloon;
      const next: Balloon = { ...balloon, ...patch };
      if (patch.rect !== undefined) next.rect = clampUnitRect([...patch.rect]);
      if (patch.tail !== undefined) next.tail = [patch.tail[0], patch.tail[1]];
      if (patch.offPanel === undefined && patch.tail !== undefined) delete next.offPanel;
      return next;
    }),
  }));
}

export function withBalloonRemoved(page: ComicPage, panelId: string, balloonId: string): ComicPage {
  return mapPanel(page, panelId, (panel) => ({ ...panel, balloons: panel.balloons.filter((balloon) => balloon.id !== balloonId) }));
}

/** The balloon moved `offset` places among its panel's balloons, the panel's own reading order. */
export function withBalloonMoved(page: ComicPage, panelId: string, balloonId: string, offset: number): ComicPage {
  return mapPanel(page, panelId, (panel) => {
    const index = panel.balloons.findIndex((balloon) => balloon.id === balloonId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= panel.balloons.length) return panel;
    const balloons = [...panel.balloons];
    const [balloon] = balloons.splice(index, 1);
    balloons.splice(target, 0, balloon as Balloon);
    return { ...panel, balloons };
  });
}

/* ------------------------------------------------------------------ *
 * The page-level source link of the paper round trip (comics.md §3.4)
 * ------------------------------------------------------------------ */

export interface PageSourceLink {
  readonly linkId: string;
  readonly assetId: string;
  readonly note: string | undefined;
}

/** The `source`-role links of one page: the photographs returned for it, in link order. */
export function pageSourceLinksOf(assetLinks: readonly unknown[] | undefined, pageId: string): PageSourceLink[] {
  if (assetLinks === undefined) return [];
  const out: PageSourceLink[] = [];
  for (const entry of assetLinks) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const link = entry as Record<string, unknown>;
    const target = link['target'];
    if (link['role'] !== 'source' || typeof target !== 'object' || target === null) continue;
    const targetRecord = target as Record<string, unknown>;
    if (targetRecord['kind'] !== 'node' || targetRecord['nodeId'] !== pageId) continue;
    if (typeof link['id'] !== 'string' || typeof link['assetId'] !== 'string') continue;
    out.push({ linkId: link['id'], assetId: link['assetId'], note: typeof link['note'] === 'string' ? link['note'] : undefined });
  }
  return out;
}

/** Whether a template id is one the editor offers. */
export const isOfferedTemplate = isTemplateId;
