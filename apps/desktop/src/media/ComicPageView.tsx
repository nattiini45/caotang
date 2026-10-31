/**
 * The comic page editor — comics.md §3.3. An SVG page at the trim size: the eight layout templates, panel drag and
 * resize with gutter snapping (`snapMove`/`snapResize`), panel add and remove, pictures dropped, pasted or chosen onto
 * a panel (`asset.importBatch` + `comic.setPage`), balloons of all seven kinds drawn from the same `balloonGeometry`
 * the comic PDF reads, and explicit reading-order controls. Every gesture is one guarded `comic.setPage` — the whole
 * page value over the one it replaces as `expect` — so each is undoable and a page that changed since it was read is
 * refused, not overwritten. Keyboard alternatives exist for every gesture, and focus stays on the element it was on.
 *
 * The paper round trip (§3.4) lands here too: photographs dropped or pasted on the sheet return by their file-name
 * number as one reviewed batch, each stored as the page's source link, with its proposed panel crops reviewed against
 * the photograph before any panel claims art.
 */

import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  BALLOON_KINDS,
  BANGERS_FAMILY,
  COMIC_NEUE_FAMILY,
  FULL_RECT,
  TEMPLATE_IDS,
  isTemplateId,
  loadComicPage,
  planPhotoReturn,
  proposedPanelCrop,
  type BalloonKind,
  type ComicPage,
  type Panel,
  type PhotoReturnPlan,
  type Point,
  type Rect,
  type ResizeEdges,
  type TemplateId,
} from '@caotang/comic';
import { nodeById, type TreeNode } from '@caotang/store';

import { isImeEnter, layoutLetter } from '../app/keymap.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from '../components/actions.js';
import { ConfirmDialog, EmptyState, useReport, useSession } from '../components/shared.js';
import { ComicPhotoReturn, emptyReview, pictureLabelOf, type PhotoReturnEntry, type PhotoReview } from './ComicPhotoReturn.js';
import {
  KEY_STEP,
  comicBookOf,
  comicPageNodesOf,
  drawnPageOf,
  imagePlacementOf,
  liveOfMm,
  movedPanelRect,
  pagePlaceOf,
  pageSourceLinksOf,
  resizedPanelRect,
  scriptFromPagesCommand,
  scriptLinkOf,
  setBookDirectionCommand,
  setPageCommand,
  withBalloonAdded,
  withBalloonMoved,
  withBalloonPatch,
  withBalloonRemoved,
  withPanelAdded,
  withPanelBorder,
  withPanelMoved,
  withPanelPicture,
  withPanelPictureCleared,
  withPanelRect,
  withPanelRemoved,
  withTemplate,
  type DrawnBalloon,
  type DrawnPanel,
  type DrawnRect,
  type PointMm,
  type ScriptFromPagesCommand,
} from './comic-model.js';
import { IMPORT_SOURCE, usePictureImage, usePictureImporter } from './picture-hooks.js';

/* lingui-set comment="The comic page editor. Interpolated values: title is the page's own title; scriptTitle is the writer's own title of the book's script; revision is the script's revision number; name is a file the writer chose; number and count are page or panel numbers; label is a picture's caption or file name; counts are numbers grouped for the formatter locale." */
export interface ComicPageViewProps {
  readonly session: ProjectSession;
  /** The comic page node. */
  readonly node: TreeNode;
}

type Selection = { readonly kind: 'panel'; readonly panelId: string } | { readonly kind: 'balloon'; readonly panelId: string; readonly balloonId: string };

type Drag =
  | { readonly kind: 'panel-move'; readonly panelId: string; readonly start: Point; readonly orig: Rect; current: Rect }
  | { readonly kind: 'panel-resize'; readonly panelId: string; readonly edges: ResizeEdges; readonly start: Point; readonly orig: Rect; current: Rect }
  | { readonly kind: 'balloon-move'; readonly panelId: string; readonly balloonId: string; readonly start: Point; readonly orig: Rect; current: Rect }
  | { readonly kind: 'balloon-resize'; readonly panelId: string; readonly balloonId: string; readonly edges: ResizeEdges; readonly start: Point; readonly orig: Rect; current: Rect }
  | { readonly kind: 'tail'; readonly panelId: string; readonly balloonId: string; current: Point };

const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;

/** The eight templates the editor offers, with their labels. */
function templateLabelOf(id: TemplateId): string {
  switch (id) {
    case 'splash':
      return t`Splash`;
    case '2-tier':
      return t`Two tiers`;
    case '3-tier':
      return t`Three tiers`;
    case 'grid-4':
      return t`Grid of four`;
    case 'grid-6':
      return t`Grid of six`;
    case 'grid-9':
      return t`Grid of nine`;
    case 'tier-1-2':
      return t`Tier over two`;
    case 'tier-2-1':
      return t`Two over a tier`;
  }
}

/** The seven balloon kinds, with their labels. */
function balloonKindLabelOf(kind: string): string {
  switch (kind) {
    case 'speech':
      return t`Speech`;
    case 'thought':
      return t`Thought`;
    case 'caption':
      return t`Caption`;
    case 'sfx':
      return t`Sound effect`;
    case 'whisper':
      return t`Whisper`;
    case 'shout':
      return t`Shout`;
    case 'radio':
      return t`Radio`;
    default:
      return kind;
  }
}

/** Registers the vendored lettering faces for the editor, best effort: when a face cannot load, the CSS fallback stack renders the balloons anyway. */
function useComicLetteringFaces(): void {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const add = async (family: string, load: () => Promise<{ default: string }>): Promise<void> => {
      try {
        const { default: url } = await load();
        const response = await fetch(url);
        if (!response.ok) return;
        const face = new FontFace(family, await response.arrayBuffer());
        await face.load();
        document.fonts.add(face);
      } catch {
        // A face that did not load falls back to the CSS stack, so the page still renders.
      }
    };
    void Promise.all([
      add(COMIC_NEUE_FAMILY, () => import('@caotang/font-comic-lettering/ComicNeue-Regular.woff?url')),
      add(BANGERS_FAMILY, () => import('@caotang/font-comic-lettering/Bangers-Regular.woff?url')),
    ]);
  }, []);
}

/** The scalloped outline of a thought balloon, the same path the comic PDF draws: a bump on each of `lobes` equal angles. */
function cloudPathOf(rect: DrawnRect, lobes: number): string {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const rx = rect.width / 2;
  const ry = rect.height / 2;
  const at = (angle: number): PointMm => [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
  const start = at(0);
  const parts: (string | number)[] = ['M', start[0], start[1]];
  for (let i = 0; i < lobes; i += 1) {
    const t0 = (2 * Math.PI * i) / lobes;
    const t1 = (2 * Math.PI * (i + 1)) / lobes;
    const tm = (t0 + t1) / 2;
    const p0 = at(t0);
    const p1 = at(t1);
    const mid = at(tm);
    const nx = Math.cos(tm) / rx;
    const ny = Math.sin(tm) / ry;
    const norm = Math.hypot(nx, ny) || 1;
    const bump = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 0.32;
    const q: PointMm = [mid[0] + (nx / norm) * bump * 2, mid[1] + (ny / norm) * bump * 2];
    parts.push(
      'C',
      p0[0] + ((q[0] - p0[0]) * 2) / 3,
      p0[1] + ((q[1] - p0[1]) * 2) / 3,
      p1[0] + ((q[0] - p1[0]) * 2) / 3,
      p1[1] + ((q[1] - p1[1]) * 2) / 3,
      p1[0],
      p1[1],
    );
  }
  parts.push('Z');
  return parts.join(' ');
}

/** One balloon's outline, tail and thought circles, from the drawn geometry the comic PDF reads. */
function BalloonShape({ balloon, rect }: { readonly balloon: DrawnBalloon; readonly rect: DrawnRect }): ReactNode {
  const strokeWidth = balloon.stroke === 'bold' ? 1.1 : balloon.stroke === 'normal' ? 0.55 : 0;
  const dash = balloon.dash === undefined ? undefined : `${balloon.dash[0] * strokeWidth} ${balloon.dash[1] * strokeWidth}`;
  const paint = {
    className: 'comic-balloon-shape',
    fill: 'var(--comic-paper, var(--raised))',
    stroke: 'var(--ink)',
    strokeWidth,
    strokeDasharray: dash,
    strokeLinejoin: 'round',
  } as const;
  let outline: ReactNode = null;
  if (balloon.shape === 'ellipse') {
    outline = <ellipse cx={rect.x + rect.width / 2} cy={rect.y + rect.height / 2} rx={rect.width / 2} ry={rect.height / 2} {...paint} />;
  } else if (balloon.shape === 'rect') {
    outline = <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} {...paint} />;
  } else if (balloon.shape === 'cloud') {
    outline = <path d={cloudPathOf(rect, balloon.lobes ?? 12)} {...paint} />;
  } else if (balloon.shape === 'burst' || balloon.shape === 'spiky') {
    outline = <polygon points={(balloon.points ?? []).map((point) => `${point[0]},${point[1]}`).join(' ')} {...paint} />;
  }
  const tail = balloon.tail;
  return (
    <>
      {outline}
      {tail === undefined || strokeWidth === 0 ? null : (
        <polygon
          className="comic-balloon-tail"
          points={`${tail.base[0][0]},${tail.base[0][1]} ${tail.tip[0]},${tail.tip[1]} ${tail.base[1][0]},${tail.base[1][1]}`}
          fill="var(--comic-paper, var(--raised))"
          stroke="var(--ink)"
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
        />
      )}
      {(balloon.circles ?? []).map((circle, index) => (
        <ellipse key={index} cx={circle.cx} cy={circle.cy} rx={circle.rx} ry={circle.ry} className="comic-balloon-circle" fill="var(--comic-paper, var(--raised))" stroke="var(--ink)" strokeWidth={strokeWidth} />
      ))}
    </>
  );
}

/** A panel's picture: its crop scaled to cover the panel, clipped to it, or the placeholder a missing picture leaves. */
function PanelArt({
  session,
  assetId,
  crop,
  panel,
  clipId,
  version,
}: {
  readonly session: ProjectSession;
  readonly assetId: string;
  readonly crop: Rect | undefined;
  readonly panel: DrawnRect;
  readonly clipId: string;
  readonly version: number;
}): ReactNode {
  const record = (session.state.manifest.assets ?? []).find((candidate) => candidate.id === assetId);
  const image = usePictureImage(session, record, true, version);
  if (record === undefined) {
    return (
      <text className="comic-panel-note" x={panel.x + panel.width / 2} y={panel.y + panel.height / 2} textAnchor="middle">
        {t`The picture is no longer in the project`}
      </text>
    );
  }
  if (image.url === null) {
    return (
      <text className="comic-panel-note" x={panel.x + panel.width / 2} y={panel.y + panel.height / 2} textAnchor="middle">
        {image.state === 'missing' ? t`The picture's file could not be read` : t`Loading the picture…`}
      </text>
    );
  }
  const placement = imagePlacementOf(panel, crop, record.width, record.height);
  return (
    <image
      className="comic-panel-art"
      href={image.url}
      x={placement.x}
      y={placement.y}
      width={placement.width}
      height={placement.height}
      preserveAspectRatio="none"
      clipPath={`url(#${clipId})`}
    />
  );
}

const HANDLE_EDGES: Record<string, ResizeEdges> = {
  nw: { left: true, top: true },
  n: { top: true },
  ne: { right: true, top: true },
  e: { right: true },
  se: { right: true, bottom: true },
  s: { bottom: true },
  sw: { left: true, bottom: true },
  w: { left: true },
};

/** The eight resize handles of a selected panel or balloon, at its edges and corners. */
function Handles({ rect, onStart }: { readonly rect: DrawnRect; readonly onStart: (event: React.PointerEvent, edges: ResizeEdges) => void }): ReactNode {
  const size = 5;
  const spots: [string, number, number][] = [
    ['nw', rect.x, rect.y],
    ['n', rect.x + rect.width / 2, rect.y],
    ['ne', rect.x + rect.width, rect.y],
    ['e', rect.x + rect.width, rect.y + rect.height / 2],
    ['se', rect.x + rect.width, rect.y + rect.height],
    ['s', rect.x + rect.width / 2, rect.y + rect.height],
    ['sw', rect.x, rect.y + rect.height],
    ['w', rect.x, rect.y + rect.height / 2],
  ];
  return (
    <>
      {spots.map(([spot, cx, cy]) => (
        <rect
          key={spot}
          className="comic-handle"
          x={cx - size / 2}
          y={cy - size / 2}
          width={size}
          height={size}
          tabIndex={-1}
          aria-hidden="true"
          onPointerDown={(event) => onStart(event, HANDLE_EDGES[spot] ?? {})}
        />
      ))}
    </>
  );
}

export function ComicPageView({ session, node }: ComicPageViewProps): ReactNode {
  useLingui();
  useSession(session);
  const report = useReport();
  const importer = usePictureImporter(session);
  useComicLetteringFaces();

  const tree = session.state.manifest.tree;
  const page = nodeById(session.state, node.id) ?? node;
  const book = comicBookOf(tree, page.id);
  const bookPages = book === undefined ? [] : comicPageNodesOf(tree, book.id);
  const drawn = useMemo(() => drawnPageOf(page.comicPage, book?.comic), [page.comicPage, book?.comic]);
  const loaded = useMemo(() => loadComicPage(page.comicPage).value, [page.comicPage]);
  const place = pagePlaceOf(tree, page);
  const version = session.assetsVersion();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const panelInputRef = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<PhotoReview | null>(null);
  /** The script write the writer is being asked to confirm, frozen with the script revision it was planned against. */
  const [scriptPlan, setScriptPlan] = useState<ScriptFromPagesCommand | null>(null);
  const scriptLink = book === undefined ? undefined : scriptLinkOf(session.state, book);

  const sourceLinks = useMemo(() => pageSourceLinksOf(session.state.manifest.assetLinks, page.id), [session.state.manifest.assetLinks, page.id]);

  const fail = (message: string): void => {
    setNotice(message);
    report({ text: message, tone: 'error' });
  };

  /** One guarded `comic.setPage`: the whole new page over the stored value, which a page that changed since refuses. */
  const commitPage = (next: ComicPage, expect?: unknown): string | null => {
    const fresh = nodeById(session.state, node.id) ?? node;
    const command = setPageCommand(fresh, next, expect);
    const outcome = session.dispatch(command.name, command.params);
    return outcome.ok ? null : explain(outcome.error);
  };

  const commit = (next: ComicPage): void => {
    const refusal = commitPage(next);
    if (refusal === null) setNotice(null);
    else fail(refusal);
  };

  const placeRect = (rect: Rect): DrawnRect => ({
    x: drawn.live.x + rect[0] * drawn.live.width,
    y: drawn.live.y + rect[1] * drawn.live.height,
    width: rect[2] * drawn.live.width,
    height: rect[3] * drawn.live.height,
  });

  const toMm = (event: { readonly clientX: number; readonly clientY: number }): PointMm => {
    const svg = svgRef.current;
    if (svg === null) return [0, 0];
    const box = svg.getBoundingClientRect();
    return [((event.clientX - box.left) / box.width) * drawn.width, ((event.clientY - box.top) / box.height) * drawn.height];
  };

  const toLive = (event: { readonly clientX: number; readonly clientY: number }): Point => {
    const [x, y] = toMm(event);
    return liveOfMm(drawn, x, y);
  };

  /* ---------------------------------------------------------------- *
   * Pointer gestures: one command at pointer-up, snapped while dragging
   * ---------------------------------------------------------------- */

  /** The press is the writer's choice of this shape. `preventDefault` below stops the browser's own focus-on-press, so select and focus it here. */
  const chooseShape = (event: React.PointerEvent, selection: Selection): void => {
    setSelected(selection);
    (event.currentTarget as SVGElement).focus({ preventScroll: true });
  };

  const beginPanelMove = (event: React.PointerEvent, panel: Panel): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    chooseShape(event, { kind: 'panel', panelId: panel.id });
    const start = toLive(event);
    setDrag({ kind: 'panel-move', panelId: panel.id, start, orig: panel.rect, current: panel.rect });
  };

  const beginPanelResize = (event: React.PointerEvent, panel: Panel, edges: ResizeEdges): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    const start = toLive(event);
    setDrag({ kind: 'panel-resize', panelId: panel.id, edges, start, orig: panel.rect, current: panel.rect });
  };

  const beginBalloonMove = (event: React.PointerEvent, panel: Panel, balloonId: string, rect: Rect): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    chooseShape(event, { kind: 'balloon', panelId: panel.id, balloonId });
    const start = toLive(event);
    setDrag({ kind: 'balloon-move', panelId: panel.id, balloonId, start, orig: rect, current: rect });
  };

  const beginBalloonResize = (event: React.PointerEvent, panel: Panel, balloonId: string, rect: Rect, edges: ResizeEdges): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    const start = toLive(event);
    setDrag({ kind: 'balloon-resize', panelId: panel.id, balloonId, edges, start, orig: rect, current: rect });
  };

  const beginTail = (event: React.PointerEvent, panel: Panel, balloonId: string): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    setDrag({ kind: 'tail', panelId: panel.id, balloonId, current: toLive(event) });
  };

  const onDragMove = (event: React.PointerEvent): void => {
    if (drag === null) return;
    const at = toLive(event);
    if (drag.kind === 'tail') {
      setDrag({ ...drag, current: at });
      return;
    }
    const dx = at[0] - drag.start[0];
    const dy = at[1] - drag.start[1];
    if (drag.kind === 'panel-move') {
      setDrag({ ...drag, current: movedPanelRect(loaded, drag.panelId, [drag.orig[0] + dx, drag.orig[1] + dy, drag.orig[2], drag.orig[3]]) });
    } else if (drag.kind === 'panel-resize') {
      const edges = drag.edges;
      const raw: Rect = [
        drag.orig[0] + (edges.left === true ? dx : 0),
        drag.orig[1] + (edges.top === true ? dy : 0),
        drag.orig[2] + (edges.right === true ? dx : 0) - (edges.left === true ? dx : 0),
        drag.orig[3] + (edges.bottom === true ? dy : 0) - (edges.top === true ? dy : 0),
      ];
      setDrag({ ...drag, current: resizedPanelRect(loaded, drag.panelId, edges, raw) });
    } else if (drag.kind === 'balloon-move') {
      setDrag({ ...drag, current: movedPanelRect(loaded, drag.panelId, [drag.orig[0] + dx, drag.orig[1] + dy, drag.orig[2], drag.orig[3]]) });
    } else if (drag.kind === 'balloon-resize') {
      const edges = drag.edges;
      const raw: Rect = [
        drag.orig[0] + (edges.left === true ? dx : 0),
        drag.orig[1] + (edges.top === true ? dy : 0),
        drag.orig[2] + (edges.right === true ? dx : 0) - (edges.left === true ? dx : 0),
        drag.orig[3] + (edges.bottom === true ? dy : 0) - (edges.top === true ? dy : 0),
      ];
      setDrag({ ...drag, current: resizedPanelRect(loaded, drag.panelId, edges, raw) });
    }
  };

  const onDragEnd = (): void => {
    if (drag === null) return;
    const held = drag;
    setDrag(null);
    // A press that did not move the shape, or that snapped it back to where it was, is a selection and not a change: the bus would refuse it as "already holds this".
    if ('orig' in held && held.current.every((value, index) => value === held.orig[index])) return;
    if (held.kind === 'panel-move' || held.kind === 'panel-resize') {
      commit(withPanelRect(loaded, held.panelId, held.current));
    } else if (held.kind === 'balloon-move' || held.kind === 'balloon-resize') {
      commit(withBalloonPatch(loaded, held.panelId, held.balloonId, { rect: held.current }));
    } else if (held.kind === 'tail') {
      const panel = loaded.panels.find((candidate) => candidate.id === held.panelId);
      const inside = panel !== undefined && held.current[0] >= panel.rect[0] && held.current[0] <= panel.rect[0] + panel.rect[2] && held.current[1] >= panel.rect[1] && held.current[1] <= panel.rect[1] + panel.rect[3];
      commit(withBalloonPatch(loaded, held.panelId, held.balloonId, { tail: held.current, offPanel: inside ? undefined : true }));
    }
  };

  /* ---------------------------------------------------------------- *
   * Keyboard alternatives for every gesture
   * ---------------------------------------------------------------- */

  const step = KEY_STEP;

  const onPanelKey = (event: React.KeyboardEvent, panel: Panel): void => {
    const key = event.key;
    if (ARROWS.includes(key as (typeof ARROWS)[number])) {
      event.preventDefault();
      if (event.altKey) {
        commit(withPanelMoved(loaded, panel.id, key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1));
        return;
      }
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      if (event.shiftKey) {
        const edges: ResizeEdges = key === 'ArrowLeft' ? { left: true } : key === 'ArrowRight' ? { right: true } : key === 'ArrowUp' ? { top: true } : { bottom: true };
        const raw: Rect = [panel.rect[0] + (edges.left === true ? dx : 0), panel.rect[1] + (edges.top === true ? dy : 0), panel.rect[2] + (edges.right === true ? dx : 0) - (edges.left === true ? dx : 0), panel.rect[3] + (edges.bottom === true ? dy : 0) - (edges.top === true ? dy : 0)];
        commit(withPanelRect(loaded, panel.id, resizedPanelRect(loaded, panel.id, edges, raw, true)));
      } else {
        commit(withPanelRect(loaded, panel.id, movedPanelRect(loaded, panel.id, [panel.rect[0] + dx, panel.rect[1] + dy, panel.rect[2], panel.rect[3]], true)));
      }
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      commit(withPanelRemoved(loaded, panel.id));
      setSelected(null);
      svgRef.current?.focus();
      return;
    }
    if (layoutLetter(key, event.code) === 'b' && !event.ctrlKey && !event.metaKey && !event.altKey && !isImeEnter(event.nativeEvent)) {
      event.preventDefault();
      commit(withBalloonAdded(loaded, panel.id, 'speech'));
    }
  };

  const onBalloonKey = (event: React.KeyboardEvent, panel: Panel, balloonId: string, rect: Rect): void => {
    const key = event.key;
    if (ARROWS.includes(key as (typeof ARROWS)[number])) {
      event.preventDefault();
      if (event.altKey) {
        commit(withBalloonMoved(loaded, panel.id, balloonId, key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1));
        return;
      }
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      if (event.shiftKey) {
        const edges: ResizeEdges = key === 'ArrowLeft' ? { left: true } : key === 'ArrowRight' ? { right: true } : key === 'ArrowUp' ? { top: true } : { bottom: true };
        const raw: Rect = [rect[0] + (edges.left === true ? dx : 0), rect[1] + (edges.top === true ? dy : 0), rect[2] + (edges.right === true ? dx : 0) - (edges.left === true ? dx : 0), rect[3] + (edges.bottom === true ? dy : 0) - (edges.top === true ? dy : 0)];
        commit(withBalloonPatch(loaded, panel.id, balloonId, { rect: resizedPanelRect(loaded, panel.id, edges, raw, true) }));
      } else {
        commit(withBalloonPatch(loaded, panel.id, balloonId, { rect: movedPanelRect(loaded, panel.id, [rect[0] + dx, rect[1] + dy, rect[2], rect[3]], true) }));
      }
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      commit(withBalloonRemoved(loaded, panel.id, balloonId));
      setSelected({ kind: 'panel', panelId: panel.id });
      return;
    }
    if (layoutLetter(key, event.code) === 't' && !event.ctrlKey && !event.metaKey && !event.altKey && !isImeEnter(event.nativeEvent)) {
      event.preventDefault();
      document.getElementById(`comic-balloon-text-${balloonId}`)?.focus();
    }
  };

  /* ---------------------------------------------------------------- *
   * Pictures: drop, paste or choose onto a panel; the sheet takes the numbered photo return
   * ---------------------------------------------------------------- */

  const placePictureOnPanel = async (panelId: string, files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    const result = await importer.importFiles(files, { source: IMPORT_SOURCE });
    const assetId = result.assetIds[0];
    if (result.status !== 'imported' || assetId === undefined) {
      if (result.message !== undefined) fail(result.message);
      return;
    }
    const fresh = loadComicPage((nodeById(session.state, node.id) ?? node).comicPage).value;
    commit(withPanelPicture(fresh, panelId, assetId, FULL_RECT));
  };

  const planRefusalText = (plan: Extract<PhotoReturnPlan, { ok: false }>, count: number): string => {
    const parts = plan.refusals.map((refusal) => {
      if (refusal.reason === 'no-number') return t`${{ name: isolate(refusal.name) }} has no page number in its file name, like 0012.jpg`;
      if (refusal.reason === 'duplicate-page') return t`${{ name: isolate(refusal.name) }} names page ${{ number: refusal.pageNumber ?? 0 }}, and another file in this batch already names it`;
      return t`${{ name: isolate(refusal.name) }} names page ${{ number: refusal.pageNumber ?? 0 }}, which this book does not have (${{ count }} pages)`;
    });
    return `${t`Nothing was imported.`} ${parts.join(' ')}`;
  };

  /** The numbered photo return: one reviewed batch, each photograph the page's source by its file-name number. */
  const startPhotoReturn = async (files: readonly File[], assignments: readonly { readonly name: string; readonly pageNumber: number }[]): Promise<void> => {
    const result = await importer.importFiles(files, { source: IMPORT_SOURCE });
    if (result.status !== 'imported') {
      if (result.message !== undefined) fail(result.message);
      return;
    }
    const skipped = new Set(result.skipped.map((skip) => skip.name));
    const byName = new Map<string, string>();
    let index = 0;
    for (const file of files) {
      if (skipped.has(file.name)) continue;
      const assetId = result.assetIds[index];
      index += 1;
      if (assetId !== undefined) byName.set(file.name, assetId);
    }
    const entries: PhotoReturnEntry[] = [];
    for (const assignment of assignments) {
      const assetId = byName.get(assignment.name);
      const target = bookPages[assignment.pageNumber - 1];
      if (assetId === undefined || target === undefined) continue;
      const outcome = session.dispatch('asset.link', { assetId, target: { kind: 'node', nodeId: target.id }, role: 'source' });
      if (!outcome.ok) {
        fail(explain(outcome.error));
        continue;
      }
      const record = (session.state.manifest.assets ?? []).find((candidate) => candidate.id === assetId);
      entries.push({ pageId: target.id, pageNumber: assignment.pageNumber, assetId, name: assignment.name, label: pictureLabelOf(record) });
    }
    if (entries.length > 0) setReview(emptyReview(entries, tree));
  };

  const sheetFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0 || bookPages.length === 0) return;
    const plan = planPhotoReturn(files.map((file) => file.name), bookPages.length);
    if (!plan.ok) {
      fail(planRefusalText(plan, bookPages.length));
      return;
    }
    await startPhotoReturn(files, plan.assignments);
  };

  const onSheetDragOver = (event: React.DragEvent): void => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  };

  const onSheetDrop = (event: React.DragEvent): void => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    void sheetFiles(files);
  };

  const onSheetPaste = (event: React.ClipboardEvent): void => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void sheetFiles(files);
  };

  const onPanelDrop = (event: React.DragEvent, panelId: string): void => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void placePictureOnPanel(panelId, files);
  };

  const onPanelPaste = (event: React.ClipboardEvent, panelId: string): void => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void placePictureOnPanel(panelId, files);
  };

  /* ---------------------------------------------------------------- *
   * Toolbar gestures
   * ---------------------------------------------------------------- */

  const onTemplate = (value: string): void => {
    if (!isTemplateId(value)) return;
    commit(withTemplate(loaded, value, drawn.direction, loaded.size));
  };

  const onDirection = (value: string): void => {
    if (book === undefined || (value !== 'ltr' && value !== 'rtl')) return;
    const command = setBookDirectionCommand(book, value);
    const outcome = session.dispatch(command.name, command.params);
    if (!outcome.ok) fail(explain(outcome.error));
  };

  const onAddPanel = (): void => {
    const snapped = movedPanelRect(loaded, '__new__', [0.25, 0.25, 0.5, 0.5]);
    commit(withPanelAdded(loaded, snapped));
  };

  const onAskScript = (): void => {
    if (book === undefined) return;
    const fresh = nodeById(session.state, book.id) ?? book;
    const command = scriptFromPagesCommand(fresh, scriptLinkOf(session.state, fresh), comicPageNodesOf(session.state.manifest.tree, fresh.id).length);
    if (command !== null) setScriptPlan(command);
  };

  /** Writes against the script revision the confirmation named, not the one the script has by the time Confirm is pressed. */
  const onConfirmScript = (): void => {
    const command = scriptPlan;
    setScriptPlan(null);
    if (command === null) return;
    const outcome = session.dispatch(command.name, command.params);
    if (outcome.ok) report({ text: t`The script was written from the pages. Undo puts it back as it was.`, tone: 'info' });
    else fail(explain(outcome.error));
  };

  /** The review's placement writes against the page value the review read when it opened. */
  const commitReviewPage = (pageId: string, next: ComicPage, expect: unknown): string | null => {
    const target = nodeById(session.state, pageId);
    if (target === undefined) return t`The page is no longer in the project.`;
    const command = setPageCommand(target, next, expect);
    const outcome = session.dispatch(command.name, command.params);
    return outcome.ok ? null : explain(outcome.error);
  };

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  if (book === undefined) {
    return (
      <EmptyState title={t`${{ title: isolate(page.title) }} is not in a comic book`}>
        <Trans>A comic page belongs to a comic book. Move it into one, or choose another item.</Trans>
      </EmptyState>
    );
  }

  const selectedPanel = selected?.kind === 'panel' || selected?.kind === 'balloon' ? loaded.panels.find((panel) => panel.id === selected.panelId) : undefined;
  const selectedBalloon =
    selected?.kind === 'balloon' ? (selectedPanel?.balloons.find((balloon) => balloon.id === selected.balloonId) ?? undefined) : undefined;

  const scriptBroken = scriptLink?.kind === 'broken';
  const panels = drawn.panels.length;
  const balloons = drawn.panels.reduce((total, panel) => total + panel.balloons.length, 0);
  const pictures = drawn.panels.filter((panel) => panel.assetId !== undefined).length;
  const sources = sourceLinks.length;
  const summary = t`${plural(panels, { one: '# panel', other: '# panels' })}, ${plural(balloons, { one: '# balloon', other: '# balloons' })}, ${plural(pictures, { one: '# picture', other: '# pictures' })}`;

  const rectOfPanel = (panel: DrawnPanel): DrawnRect => {
    if (drag !== null && (drag.kind === 'panel-move' || drag.kind === 'panel-resize') && drag.panelId === panel.id) return placeRect(drag.current);
    return panel;
  };

  const rectOfBalloon = (panel: DrawnPanel, balloon: DrawnBalloon): DrawnRect => {
    if (drag !== null && (drag.kind === 'balloon-move' || drag.kind === 'balloon-resize') && drag.panelId === panel.id && drag.balloonId === balloon.id) return placeRect(drag.current);
    return balloon;
  };

  const panelLabel = (panel: DrawnPanel): string => {
    const state = panel.assetId === undefined ? t`empty` : t`with panel art`;
    return t`Panel ${{ number: panel.number }} of ${{ count: drawn.panels.length }}, ${{ state: state }} — drag to move, Shift with the arrow keys resizes, Alt with up and down changes the reading order, Delete removes, B adds a balloon`;
  };

  const balloonLabel = (panel: DrawnPanel, balloon: DrawnBalloon): string =>
    t`Balloon ${{ number: panel.balloons.findIndex((candidate) => candidate.id === balloon.id) + 1 }} of ${{ count: panel.balloons.length }} on panel ${{ panelNumber: panel.number }}, ${{ kind: balloonKindLabelOf(balloon.kind) }} — drag to move, T edits the text, Delete removes`;

  return (
    <section className="media-view comic-view" aria-label={t`Comic page ${{ title: isolate(page.title) }}`}>
      <header className="media-head">
        <div>
          <span className="badge">{t`Page ${{ number: place.number }} of ${{ count: place.count }}`}</span>
          <span className="badge">{drawn.direction === 'rtl' ? t`Reads right to left` : t`Reads left to right`}</span>
          {sources === 0 ? null : <span className="badge">{t`${plural(sources, { one: '# source photo', other: '# source photos' })}`}</span>}
          <h2 className="media-title">{page.title}</h2>
        </div>
        <div className="comic-tools">
          <label className="comic-field">
            <span>{t`Layout`}</span>
            <select aria-label={t`Page layout template`} value={isTemplateId(loaded.layout) ? loaded.layout : ''} onChange={(event) => onTemplate(event.target.value)}>
              {!isTemplateId(loaded.layout) && loaded.layout !== undefined ? <option value="">{loaded.layout}</option> : null}
              {TEMPLATE_IDS.map((id) => (
                <option key={id} value={id}>
                  {templateLabelOf(id)}
                </option>
              ))}
            </select>
          </label>
          <label className="comic-field">
            <span>{t`Reading direction`}</span>
            <select aria-label={t`Reading direction`} value={drawn.direction} onChange={(event) => onDirection(event.target.value)}>
              <option value="ltr">{t`Reads left to right`}</option>
              <option value="rtl">{t`Reads right to left`}</option>
            </select>
          </label>
          <button type="button" className="button" onClick={onAddPanel}>
            <Trans>Add panel</Trans>
          </button>
          <button type="button" className="button" onClick={() => photoInputRef.current?.click()}>
            <Trans>Return photographs…</Trans>
          </button>
          <button type="button" className="button" disabled={scriptBroken || bookPages.length === 0} onClick={onAskScript}>
            <Trans>Write the script from the pages…</Trans>
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            className="comic-file-input"
            aria-label={t`Choose the photographed pages`}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void sheetFiles(files);
            }}
          />
        </div>
      </header>
      <p className="muted comic-note">
        <Trans>
          Drag a panel to move it and an edge to resize it; both snap to the gutters. Every change is one undoable step. Arrow keys move the focused panel or balloon, Shift with the arrows resizes, Alt with up and down changes the reading order, Delete removes, B adds a balloon, T edits a balloon's text, and the tail buttons below a selected balloon aim its tail. Drop, paste or choose a picture on a panel to place its art; drop numbered photographs of printed pages on the sheet to return them.
        </Trans>
      </p>
      {scriptBroken ? (
        <p className="comic-notice" role="status">
          <Trans>The script for this book is no longer in the project. Choose a script, or work from the pages.</Trans>
        </p>
      ) : null}
      {notice === null ? null : (
        <p className="comic-notice" role="alert">
          {notice}
        </p>
      )}
      <ConfirmDialog
        open={scriptPlan !== null}
        title={scriptPlan?.params.expectedRevision !== undefined ? t`Replace the script with one written from the pages?` : t`Write a script from the pages?`}
        confirmLabel={t`Write the script`}
        onCancel={() => setScriptPlan(null)}
        onConfirm={onConfirmScript}
      >
        {scriptPlan?.params.expectedRevision === undefined ? (
          <p>
            <Trans>A new comic script is made from the panels and balloons on this book's pages and linked to the book. Pictures are never copied into it.</Trans>
          </p>
        ) : (
          <>
            <p>
              {t`The script ${{ scriptTitle: isolate(scriptLink?.kind === 'linked' ? scriptLink.title : '') }} is rewritten from the panels and balloons on this book's pages. Pictures are never copied into it.`}
            </p>
            <p>
              {t`It is only replaced if it is still at revision ${{ revision: scriptPlan.params.expectedRevision }}, the one read for this question. If you or the agent changed it since, nothing is written and you can ask again.`}
            </p>
          </>
        )}
        <p>
          <Trans>Undo restores the script as it was, or removes the new one.</Trans>
        </p>
      </ConfirmDialog>
      <div
        className="comic-sheet-wrap"
        onDragOver={onSheetDragOver}
        onDrop={onSheetDrop}
        onPaste={onSheetPaste}
      >
        <svg
          ref={svgRef}
          className="comic-sheet"
          viewBox={`0 0 ${drawn.width} ${drawn.height}`}
          role="img"
          aria-label={summary}
          preserveAspectRatio="xMidYMin meet"
          tabIndex={-1}
        >
          <defs>
            {drawn.panels.map((panel) => (
              <clipPath key={panel.id} id={`comic-clip-${page.id}-${panel.id}`}>
                <rect x={panel.x} y={panel.y} width={panel.width} height={panel.height} />
              </clipPath>
            ))}
          </defs>
          <rect className="comic-trim" x={0} y={0} width={drawn.width} height={drawn.height} />
          <rect className="comic-live" x={drawn.live.x} y={drawn.live.y} width={drawn.live.width} height={drawn.live.height} />
          {drawn.panels.map((drawnPanel) => {
            const panel = loaded.panels.find((candidate) => candidate.id === drawnPanel.id);
            const rect = rectOfPanel(drawnPanel);
            const isSelected = selected?.kind === 'panel' && selected.panelId === drawnPanel.id;
            return (
              <g
                key={drawnPanel.id}
                className={`comic-panel-g${isSelected ? ' is-selected' : ''}`}
                tabIndex={0}
                role="button"
                aria-label={panel === undefined ? t`Panel ${{ number: drawnPanel.number }}` : panelLabel(drawnPanel)}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) setSelected({ kind: 'panel', panelId: drawnPanel.id });
                }}
                onPointerDown={(event) => {
                  if (panel !== undefined) beginPanelMove(event, panel);
                }}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onKeyDown={(event) => {
                  if (panel !== undefined) onPanelKey(event, panel);
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
                }}
                onDrop={(event) => onPanelDrop(event, drawnPanel.id)}
                onPaste={(event) => onPanelPaste(event, drawnPanel.id)}
              >
                <title>{t`Panel ${{ number: drawnPanel.number }}`}</title>
                {panel !== undefined && panel.assetId !== undefined ? (
                  <PanelArt session={session} assetId={panel.assetId} crop={panel.crop} panel={rect} clipId={`comic-clip-${page.id}-${panel.id}`} version={version} />
                ) : (
                  <rect className="comic-panel-placeholder" x={rect.x} y={rect.y} width={rect.width} height={rect.height} />
                )}
                {panel !== undefined && panel.assetId === undefined ? (
                  <text className="comic-panel-note" x={rect.x + rect.width / 2} y={rect.y + rect.height / 2} textAnchor="middle">
                    {t`Empty panel — a placeholder, not art`}
                  </text>
                ) : null}
                <rect
                  className={`comic-panel-frame${panel?.border === 'none' ? ' is-borderless' : panel?.border === 'bold' ? ' is-bold' : ''}`}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                />
                <text className="comic-panel-number" x={rect.x + 2} y={rect.y + 7}>
                  {drawnPanel.number}
                </text>
                {isSelected && panel !== undefined ? (
                  <Handles
                    rect={rect}
                    onStart={(event, edges) => {
                      beginPanelResize(event, panel, edges);
                    }}
                  />
                ) : null}
              </g>
            );
          })}
          {drawn.panels.map((drawnPanel) => {
            const panel = loaded.panels.find((candidate) => candidate.id === drawnPanel.id);
            if (panel === undefined) return null;
            return panel.balloons.map((balloon) => {
              const drawnBalloon = drawnPanel.balloons.find((candidate) => candidate.id === balloon.id);
              if (drawnBalloon === undefined) return null;
              const rect = rectOfBalloon(drawnPanel, drawnBalloon);
              const isSelected = selected?.kind === 'balloon' && selected.panelId === panel.id && selected.balloonId === balloon.id;
              return (
                <g
                  key={balloon.id}
                  className={`comic-balloon-g${isSelected ? ' is-selected' : ''}`}
                  tabIndex={0}
                  role="button"
                  aria-label={balloonLabel(drawnPanel, drawnBalloon)}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget) setSelected({ kind: 'balloon', panelId: panel.id, balloonId: balloon.id });
                  }}
                  onPointerDown={(event) => beginBalloonMove(event, panel, balloon.id, balloon.rect)}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragEnd}
                  onKeyDown={(event) => onBalloonKey(event, panel, balloon.id, balloon.rect)}
                >
                  <BalloonShape balloon={drawnBalloon} rect={rect} />
                  {drawnBalloon.tail !== undefined && isSelected ? (
                    <circle
                      className="comic-tail-handle"
                      cx={drawnBalloon.tail.tip[0]}
                      cy={drawnBalloon.tail.tip[1]}
                      r={2.4}
                      tabIndex={-1}
                      aria-label={t`Tail target — drag to aim it, or use the tail buttons below the page`}
                      onPointerDown={(event) => beginTail(event, panel, balloon.id)}
                    />
                  ) : null}
                  {isSelected ? <Handles rect={rect} onStart={(event, edges) => beginBalloonResize(event, panel, balloon.id, balloon.rect, edges)} /> : null}
                  <foreignObject x={drawnBalloon.textBox.x} y={drawnBalloon.textBox.y} width={drawnBalloon.textBox.width} height={drawnBalloon.textBox.height}>
                    <div
                      className={`comic-balloon-text${drawnBalloon.fontRole === 'sfx' ? ' is-sfx' : ''}${drawnBalloon.italic ? ' is-italic' : ''}`}
                      dir="auto"
                    >
                      {balloon.text}
                    </div>
                  </foreignObject>
                </g>
              );
            });
          })}
        </svg>
        {review === null ? null : (
          <ComicPhotoReturn session={session} review={review} onReview={setReview} onClose={() => setReview(null)} commitPage={commitReviewPage} />
        )}
      </div>

      {selectedPanel === undefined ? null : selected?.kind === 'balloon' && selectedBalloon !== undefined ? (
        <BalloonInspector
          key={selectedBalloon.id}
          panel={selectedPanel}
          balloon={selectedBalloon}
          loaded={loaded}
          commit={commit}
          setSelected={setSelected}
        />
      ) : (
        <PanelInspector
          panel={selectedPanel}
          loaded={loaded}
          sources={sourceLinks}
          commit={commit}
          setSelected={setSelected}
          panelInputRef={panelInputRef}
          placePicture={(files) => void placePictureOnPanel(selectedPanel.id, files)}
        />
      )}

      <p className="muted">{summary}</p>
      {importer.dialog}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The inspector of the selected panel or balloon
 * ------------------------------------------------------------------ */

interface InspectorProps {
  readonly loaded: ComicPage;
  readonly commit: (next: ComicPage) => void;
  readonly setSelected: (selection: Selection | null) => void;
}

function PanelInspector({
  panel,
  loaded,
  sources,
  commit,
  setSelected,
  panelInputRef,
  placePicture,
}: InspectorProps & {
  readonly panel: Panel;
  readonly sources: readonly { readonly linkId: string; readonly assetId: string; readonly note: string | undefined }[];
  readonly panelInputRef: React.RefObject<HTMLInputElement | null>;
  readonly placePicture: (files: readonly File[]) => void;
}): ReactNode {
  useLingui();
  const index = loaded.panels.findIndex((candidate) => candidate.id === panel.id);
  const sourceAssetId = sources[0]?.assetId;
  return (
    <section className="comic-inspector" aria-label={t`Panel ${{ number: index + 1 }}`}>
      <h3>{t`Panel ${{ number: index + 1 }} of ${{ count: loaded.panels.length }}`}</h3>
      <div className="comic-inspector-row">
        <button type="button" className="button is-quiet" disabled={index <= 0} onClick={() => commit(withPanelMoved(loaded, panel.id, -1))}>
          <Trans>Earlier in reading order</Trans>
        </button>
        <button type="button" className="button is-quiet" disabled={index < 0 || index >= loaded.panels.length - 1} onClick={() => commit(withPanelMoved(loaded, panel.id, 1))}>
          <Trans>Later in reading order</Trans>
        </button>
      </div>
      <label className="comic-field">
        <span>{t`Border`}</span>
        <select
          aria-label={t`Panel border`}
          value={panel.border ?? 'thin'}
          onChange={(event) => commit(withPanelBorder(loaded, panel.id, event.target.value as Panel['border']))}
        >
          <option value="none">{t`None`}</option>
          <option value="thin">{t`Thin`}</option>
          <option value="bold">{t`Bold`}</option>
        </select>
      </label>
      <div className="comic-inspector-row">
        {panel.assetId === undefined ? (
          <p className="muted">{t`An empty placeholder — no art is placed in this panel yet.`}</p>
        ) : (
          <p className="muted">{t`Panel art is placed in this panel.`}</p>
        )}
        <button type="button" className="button is-quiet" onClick={() => panelInputRef.current?.click()}>
          <Trans>Choose a picture…</Trans>
        </button>
        <input
          ref={panelInputRef}
          type="file"
          accept="image/*"
          className="comic-file-input"
          aria-label={t`Choose a picture for this panel`}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            placePicture(files);
          }}
        />
        {sourceAssetId === undefined ? null : (
          <button
            type="button"
            className="button is-quiet"
            onClick={() => commit(withPanelPicture(loaded, panel.id, sourceAssetId, proposedPanelCrop(panel.rect, loaded.size)))}
          >
            <Trans>Use the page's source photo</Trans>
          </button>
        )}
        {panel.assetId === undefined ? null : (
          <button type="button" className="button is-quiet" onClick={() => commit(withPanelPictureCleared(loaded, panel.id))}>
            <Trans>Remove picture</Trans>
          </button>
        )}
      </div>
      <div className="comic-inspector-row">
        <button type="button" className="button" onClick={() => commit(withBalloonAdded(loaded, panel.id, 'speech'))}>
          <Trans>Add balloon</Trans>
        </button>
        <button
          type="button"
          className="button is-quiet"
          onClick={() => {
            commit(withPanelRemoved(loaded, panel.id));
            setSelected(null);
          }}
        >
          <Trans>Remove panel</Trans>
        </button>
      </div>
    </section>
  );
}

function BalloonInspector({
  panel,
  balloon,
  loaded,
  commit,
  setSelected,
}: InspectorProps & { readonly panel: Panel; readonly balloon: NonNullable<Panel['balloons'][number]> }): ReactNode {
  useLingui();
  const [draft, setDraft] = useState(balloon.text);
  const index = panel.balloons.findIndex((candidate) => candidate.id === balloon.id);
  /** The keyboard's way to aim a tail already placed: one step, with the same inside-or-off-panel rule as the drag's end. */
  const moveTail = (dx: number, dy: number): void => {
    const from = balloon.tail;
    if (from === undefined) return;
    const tip: Point = [from[0] + dx, from[1] + dy];
    const inside = tip[0] >= panel.rect[0] && tip[0] <= panel.rect[0] + panel.rect[2] && tip[1] >= panel.rect[1] && tip[1] <= panel.rect[1] + panel.rect[3];
    commit(withBalloonPatch(loaded, panel.id, balloon.id, { tail: tip, offPanel: inside ? undefined : true }));
  };
  const hasTail = balloon.kind === 'speech' || balloon.kind === 'whisper' || balloon.kind === 'shout' || balloon.kind === 'radio' || balloon.kind === 'thought';
  return (
    <section className="comic-inspector" aria-label={t`Balloon ${{ number: index + 1 }}`}>
      <h3>{t`Balloon ${{ number: index + 1 }} of ${{ count: panel.balloons.length }} on the panel`}</h3>
      <label className="comic-field">
        <span>{t`Kind`}</span>
        <select
          aria-label={t`Balloon kind`}
          value={balloon.kind}
          onChange={(event) => commit(withBalloonPatch(loaded, panel.id, balloon.id, { kind: event.target.value as BalloonKind }))}
        >
          {BALLOON_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {balloonKindLabelOf(kind)}
            </option>
          ))}
        </select>
      </label>
      <label className="comic-field">
        <span>{t`Text`}</span>
        <input
          id={`comic-balloon-text-${balloon.id}`}
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft !== balloon.text) commit(withBalloonPatch(loaded, panel.id, balloon.id, { text: draft }));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) {
              event.preventDefault();
              if (draft !== balloon.text) commit(withBalloonPatch(loaded, panel.id, balloon.id, { text: draft }));
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      {hasTail ? (
        <div className="comic-inspector-row">
          {balloon.tail === undefined ? (
            <button
              type="button"
              className="button is-quiet"
              onClick={() => commit(withBalloonPatch(loaded, panel.id, balloon.id, { tail: [panel.rect[0] + panel.rect[2] / 2, panel.rect[1] + panel.rect[3] * 0.8] }))}
            >
              <Trans>Aim the tail</Trans>
            </button>
          ) : (
            <div role="group" className="comic-inspector-row" aria-label={t`Move the tail`}>
              {(
                [
                  [t`Tail left`, -KEY_STEP, 0],
                  [t`Tail right`, KEY_STEP, 0],
                  [t`Tail up`, 0, -KEY_STEP],
                  [t`Tail down`, 0, KEY_STEP],
                ] as const
              ).map(([label, dx, dy]) => (
                <button key={label} type="button" className="button is-quiet" onClick={() => moveTail(dx, dy)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <label className="comic-check">
            <input
              type="checkbox"
              checked={balloon.offPanel === true}
              onChange={(event) => commit(withBalloonPatch(loaded, panel.id, balloon.id, { offPanel: event.target.checked ? true : undefined }))}
            />
            <span>{t`Tail points off-panel`}</span>
          </label>
        </div>
      ) : null}
      <div className="comic-inspector-row">
        <button type="button" className="button is-quiet" disabled={index <= 0} onClick={() => commit(withBalloonMoved(loaded, panel.id, balloon.id, -1))}>
          <Trans>Earlier in the panel</Trans>
        </button>
        <button
          type="button"
          className="button is-quiet"
          disabled={index < 0 || index >= panel.balloons.length - 1}
          onClick={() => commit(withBalloonMoved(loaded, panel.id, balloon.id, 1))}
        >
          <Trans>Later in the panel</Trans>
        </button>
        <button
          type="button"
          className="button is-quiet"
          onClick={() => {
            commit(withBalloonRemoved(loaded, panel.id, balloon.id));
            setSelected({ kind: 'panel', panelId: panel.id });
          }}
        >
          <Trans>Remove balloon</Trans>
        </button>
      </div>
    </section>
  );
}
