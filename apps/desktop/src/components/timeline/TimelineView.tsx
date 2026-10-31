/**
 * The story timeline, read-only ([timeline.md §3, §4.6, §5.2, §6, §7](docs/architecture/timeline.md)).
 *
 * An `aria-hidden` SVG draws the geometry (grid, ticks, breaks, folds, zones, connectors). The scenes are HTML cells of an ARIA
 * grid, drawn only for the window the writer is looking at, so a 2,000-scene book stays inside the DOM budget. The scroller is
 * `dir="ltr"` on purpose: `@caotang/timeline` has already mirrored every box for a right-to-left book, and a second flip by the
 * browser's own scroll origin would undo it. The controls around it follow the interface instead.
 *
 * Nothing here writes to the project. Selecting a cell marks it on the timeline only; Enter opens the scene.
 */
/* lingui-set comment="The story timeline view. Interpolated values: title, label, name, part, count, number, scheduled, total, shown are writer text, part words or counts." */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { isolate } from '@caotang/i18n';
import { emptyCoherenceFile } from '@caotang/coherence';
import { buildTimeline, projectLensOf, projectTimeline, type Box, type LaneKey, type TimelineAxis, type TimelineItem, type Zoom } from '@caotang/timeline';

import {
  DOM_BUDGET,
  GUTTER_PX,
  HEADER_PX,
  MAX_BANDS,
  MAX_CHIPS,
  MAX_CONNECTORS,
  MAX_TICKS,
  PAIR_GLYPH,
  ROW_PX,
  SEVERITY_GLYPH,
  badgeOf,
  blockBoxes,
  boxStyle,
  classes,
  mediaQuery,
  pathOf,
  curveBetween,
  drawWindow,
  foldsBetween,
  gridOf,
  initialViewState,
  intersects,
  levelOfZoom,
  moveFocus,
  moveOfKey,
  originX,
  pairOverlays,
  projectionOptionsOf,
  rememberViewState,
  rememberedViewState,
  scopeOptions,
  scrollToReveal,
  stepZoom,
  targetForDocs,
  visibleKeys,
  visibleLanes,
  withAxis,
  zoomForAxis,
  defaultZoom,
  type Placed,
  type Rect,
  type TimelineFocusRequest,
  type TimelineOverlays,
  type TimelineViewState,
  type Viewport,
} from '../../app/timeline-model.js';
import {
  DRAG_THRESHOLD_PX,
  adjacentLane,
  altChordOf,
  dayFrames,
  ghostOfMove,
  ghostOfScene,
  ghostOfShift,
  laneIntent,
  narrativeDrop,
  planNarrativeMove,
  storyDrop,
  unmirroredLeft,
  type DropArea,
  type GhostContext,
} from '../../app/timeline-edit-model.js';
import { SHIFT_ABOVE, datedAmong, declaredOf, isProposableDay, pinNow, pinWithDay, type MetaIntent, type MetaRow, type MoveRow, type PinRow } from '../../app/timeline-proposals.js';
import { barPictures, packPins, picturePins, pictureIndex, pinBandPx, pinCenter, pinDragDay, pinKeyDelta, pinRect, portraitOf, type PicturePin } from '../../app/timeline-pictures.js';
import { accessibleText } from '../../i18n/accessible-text.js';
import { uiIsRtl } from '../../i18n/direction.js';
import { isImeEnter, layoutLetter } from '../../app/keymap.js';
import { UserText } from '../../i18n/UserText.js';
import { TimelineMedia, mediaNoteOf } from './TimelineMedia.js';
import { BarThumbs, LanePortrait, PictureButton, PictureLightbox, ScenePictures, picturesNote, type OpenedPicture } from './TimelinePictures.js';
import { povCandidates } from '../../app/findings-model.js';
import type { ProjectSession } from '../../app/session.js';
import { saveTimelineImage } from '../../app/timeline-image.js';
import { EmptyState, useSession } from '../shared.js';
import { Agenda, type AgendaEdit } from './Agenda.js';
import { CalendarDialog } from './CalendarDialog.js';
import { SceneChanges } from './SceneChanges.js';
import { TimelineControls } from './TimelineControls.js';
import { TimelineShelf } from './TimelineShelf.js';
import { TimelineTray } from './TimelineTray.js';
import { createDayLensMessages, createTimelineLabels, useLabelCatalogue } from './timeline-labels.js';
import { useProposals } from './use-proposals.js';

import './timeline.css';

export interface TimelineViewProps {
  readonly session: ProjectSession;
  /** Enter on a scene: the editor shows it. Selecting a cell never calls this. */
  readonly onOpenDocument: (docId: string) => void;
  /** A badge or a finding link: the Findings tab, on the group with this fact. */
  readonly onOpenFindings: (factGroup: string) => void;
  /** "Show on timeline" from the Findings tab. */
  readonly focusRequest: TimelineFocusRequest | null;
  readonly onFocusHandled: () => void;
}

const BAND_PX = 18;
const SCROLL_STEP = 320;
/** What is drawn before the scroller has been measured. */
const FIRST_VIEWPORT: Viewport = { x: 0, y: 0, w: 1200, h: 600 };

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function shifted(box: Box, ox: number, oy: number): Rect {
  return { x: box.x + ox, y: box.y + oy, w: box.w, h: box.h };
}

const PREFERS_AGENDA = mediaQuery(['forced-colors', 'active'], ['prefers-reduced-motion', 'reduce']);

function usePrefersAgenda(): boolean {
  const [prefers, setPrefers] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(PREFERS_AGENDA).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(PREFERS_AGENDA);
    const onChange = (): void => setPrefers(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return prefers;
}

function axisName(axis: TimelineAxis): string {
  return axis === 'story' ? t`story time` : axis === 'narrative' ? t`reading order` : t`story time and reading order`;
}

function groupPhrase(key: LaneKey): string {
  switch (key) {
    case 'pov':
      return t`grouped by point of view`;
    case 'character':
      return t`grouped by character`;
    case 'mode':
      return t`grouped by mode`;
    case 'folder':
      return t`grouped by folder`;
    case 'location':
      return t`grouped by location`;
    case 'thread':
      return t`grouped by thread`;
    default:
      return t`not grouped`;
  }
}

export function TimelineView({ session, onOpenDocument, onOpenFindings, focusRequest, onFocusHandled }: TimelineViewProps): ReactNode {
  const version = useSession(session);
  const { i18n: ui } = useLingui();
  const projectId = session.projectId;
  const file = session.coherenceFile();
  const language = session.state.manifest.project.language;
  const catalogue = useLabelCatalogue(language);
  const labels = useMemo(() => createTimelineLabels(catalogue.instance), [catalogue.instance, catalogue.locale, ui.locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const lensOptions = useMemo(
    () => ({ locale: catalogue.locale, messages: createDayLensMessages(catalogue.instance) }),
    [catalogue.instance, catalogue.locale, ui.locale], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // The project's calendar when it chose one and it is usable, else the day lens; a setting this build cannot use is explained, never fatal.
  const timelineSetting = session.state.manifest.timeline;
  const chosen = useMemo(() => projectLensOf(timelineSetting, lensOptions), [timelineSetting, lensOptions]);
  const lens = chosen.lens;
  const [calendarOpen, setCalendarOpen] = useState(false);

  const [view, setView] = useState<TimelineViewState>(
    () =>
      rememberedViewState(projectId) ??
      initialViewState(buildTimeline(session.state, session.coherenceFile() ?? emptyCoherenceFile(), { axis: 'narrative' }).stats.share),
  );
  useEffect(() => rememberViewState(projectId, view), [projectId, view]);
  const prefersAgenda = usePrefersAgenda();
  const agenda = view.agenda ?? prefersAgenda;

  const tree = session.state.manifest.tree;
  const scopes = useMemo(() => scopeOptions(tree), [tree, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeId = view.scope !== null && scopes.some((option) => option.id === view.scope) ? view.scope : null;
  const level = levelOfZoom(view.zoom);

  const model = useMemo(
    () =>
      buildTimeline(session.state, file ?? emptyCoherenceFile(), {
        axis: view.axis,
        groupBy: level === 'scene' ? view.groupBy : 'none',
        zoom: view.zoom,
        lens,
        labels,
        compressGaps: view.compressGaps,
        findings: 'open',
        ...(scopeId !== null ? { scope: scopeId } : {}),
      }),
    [session, version, file, view.axis, view.groupBy, view.zoom, view.compressGaps, scopeId, level, lens, labels], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const geometry = useMemo(() => projectTimeline(model, projectionOptionsOf(model)), [model]);
  const blocks = useMemo(() => (level === 'scene' ? undefined : blockBoxes(model, geometry)), [model, geometry, level]);
  const direction = model.direction;
  const ox = originX(direction);
  const narrative = model.axis.kind === 'narrative';
  const frames = useMemo(() => dayFrames(model), [model]);

  /* ----- pictures: the placements on bars, and the day pins above the axis (§9.1) ----- */
  const assetsVersion = session.assetsVersion();
  const pictures = useMemo(() => pictureIndex(session.state), [session, version, assetsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const pins = useMemo(() => (level === 'scene' && !narrative ? picturePins(session.state, model) : []), [session, version, model, level, narrative]); // eslint-disable-line react-hooks/exhaustive-deps
  const pinSlots = useMemo(() => {
    const centered = pins.flatMap((pin) => {
      const center = pinCenter(frames, pin, model.axis.pxPerDay);
      return center === undefined ? [] : [{ pin, center }];
    });
    const slots = packPins(centered.map((entry) => ({ key: entry.pin.linkId, center: entry.center })));
    return { entries: centered.map((entry) => ({ ...entry, row: slots.rowOf.get(entry.pin.linkId) ?? 0 })), rows: centered.length === 0 ? 0 : slots.rows };
  }, [pins, frames, model]);
  const pinBand = pinBandPx(pinSlots.rows);
  const bandRows = level === 'scene' && model.bands.length > 0 ? Math.min(2, 1 + Math.max(...model.bands.map((band) => band.depth))) : 0;
  const headerPx = HEADER_PX + (narrative ? bandRows * BAND_PX : 0) + pinBand;
  const oy = headerPx;
  const contentH = blocks === undefined ? geometry.height : blocks.top + blocks.rows * ROW_PX;
  const canvasW = Math.max(geometry.width, 0) + GUTTER_PX;
  const canvasH = oy + Math.max(contentH, ROW_PX) + 24;

  const itemByKey = useMemo(() => new Map(model.items.map((item) => [item.key, item])), [model]);
  const placed = useMemo<Placed[]>(() => {
    if (blocks !== undefined) return blocks.blocks.map((entry) => ({ key: entry.block.id, box: shifted(entry.box, ox, oy) }));
    return geometry.items.map((entry) => ({ key: entry.key, box: shifted(entry.box, ox, oy) }));
  }, [blocks, geometry, ox, oy]);
  const boxByKey = useMemo(() => new Map(placed.map((entry) => [entry.key, entry.box])), [placed]);
  const lanes = useMemo(() => {
    if (blocks !== undefined) return [{ id: 'blocks', box: { x: 0, y: blocks.top + oy, w: canvasW, h: blocks.rows * ROW_PX } }];
    return geometry.lanes.map((lane) => ({ id: lane.id, box: shifted(lane.box, 0, oy) }));
  }, [blocks, geometry, oy, canvasW]);
  const grid = useMemo(() => gridOf(model, blocks?.blocks, labels.lane.all), [model, blocks, labels]);
  const laneLabel = useMemo(() => new Map(model.lanes.map((lane) => [lane.id, lane.label])), [model]);
  /** The codex entry a character lane is for, so its head can show the entry's portrait. */
  const laneCharacter = useMemo(() => new Map(model.lanes.filter((lane) => lane.key === 'character' && lane.value !== undefined).map((lane) => [lane.id, lane.value as string])), [model]);

  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const firstKey = grid.rows.find((row) => row.keys.length > 0)?.keys[0];
  const focused = focusKey !== undefined && grid.where.has(focusKey) ? focusKey : firstKey;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState('');
  const [highlight, setHighlight] = useState<string | null>(null);

  const rootRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<Viewport>(FIRST_VIEWPORT);
  const [win, setWin] = useState<Rect>(() => drawWindow(FIRST_VIEWPORT, SCROLL_STEP));
  const pendingFocus = useRef<string | null>(null);
  const anchorRef = useRef<{ readingIndex: number; offsetX: number; offsetY: number } | null>(null);

  const announce = useCallback((text: string): void => {
    setAnnouncement((previous) => (previous === text ? `${text}\u200b` : text));
  }, []);

  const syncViewport = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const next: Viewport = { x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight };
    viewportRef.current = next;
    const wanted = drawWindow(next, SCROLL_STEP);
    setWin((previous) => (sameRect(previous, wanted) ? previous : wanted));
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncViewport);
    observer.observe(el);
    syncViewport();
    return () => observer.disconnect();
  }, [syncViewport, agenda]);

  const structure = `${view.axis}|${view.zoom}|${view.groupBy}|${scopeId ?? ''}|${direction}|${agenda}`;
  // A change of axis, zoom, group or scope puts the scene the writer was on back where it was; with none, the view starts at the
  // reading start of the book, which is the right-hand end of a right-to-left one.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (anchor !== null) {
      const target =
        blocks === undefined
          ? model.items.find((item) => item.readingIndex === anchor.readingIndex)
          : blocks.blocks.find((entry) => anchor.readingIndex >= entry.block.firstReading && anchor.readingIndex <= entry.block.lastReading)?.block;
      const key = target === undefined ? undefined : 'key' in target ? target.key : target.id;
      const box = key === undefined ? undefined : boxByKey.get(key);
      if (box !== undefined) {
        el.scrollTo({ left: Math.max(0, box.x - anchor.offsetX), top: Math.max(0, box.y - anchor.offsetY) });
        syncViewport();
        return;
      }
    }
    el.scrollTo({ left: direction === 'rtl' ? el.scrollWidth : 0, top: 0 });
    syncViewport();
  }, [structure]); // eslint-disable-line react-hooks/exhaustive-deps

  const rememberAnchor = (): void => {
    const key = focused;
    const box = key === undefined ? undefined : boxByKey.get(key);
    const item = key === undefined ? undefined : itemByKey.get(key);
    const reading = item?.readingIndex ?? blocks?.blocks.find((entry) => entry.block.id === key)?.block.firstReading;
    if (box === undefined || reading === undefined) {
      anchorRef.current = null;
      return;
    }
    anchorRef.current = { readingIndex: reading, offsetX: box.x - viewportRef.current.x, offsetY: box.y - viewportRef.current.y };
  };

  const change = (next: (state: TimelineViewState) => TimelineViewState): void => {
    rememberAnchor();
    setView(next);
  };

  /* ----- what is drawn ----- */
  const pinned = useMemo(() => (focused === undefined ? new Set<string>() : new Set([focused])), [focused]);
  const visible = useMemo(() => new Set(visibleKeys(placed, win, MAX_CHIPS, pinned)), [placed, win, pinned]);
  const visibleLaneBoxes = useMemo(() => {
    const focusLane = focused === undefined ? undefined : blocks !== undefined ? 'blocks' : itemByKey.get(focused)?.lane;
    const withRows = new Set(grid.rows.map((row) => row.id));
    return visibleLanes(
      lanes.filter((lane) => withRows.has(lane.id)),
      win,
      focusLane,
    );
  }, [lanes, grid, win, focused, blocks, itemByKey]);
  const rowIndexOf = useMemo(() => new Map(grid.rows.map((row, at) => [row.id, at + 1])), [grid]);

  const chipsByLane = useMemo(() => {
    const out = new Map<string, { key: string; box: Rect }[]>();
    for (const entry of placed) {
      if (!visible.has(entry.key)) continue;
      const lane = blocks !== undefined ? 'blocks' : (itemByKey.get(entry.key)?.lane as string);
      const list = out.get(lane);
      if (list === undefined) out.set(lane, [entry]);
      else list.push(entry);
    }
    return out;
  }, [placed, visible, blocks, itemByKey]);

  const activeDocId = session.view.activeDocId;
  const blockById = useMemo(() => new Map((blocks?.blocks ?? []).map((entry) => [entry.block.id, entry.block])), [blocks]);

  /* ----- moving focus ----- */
  const [, setFocusTick] = useState(0);
  const reveal = useCallback(
    (key: string): void => {
      const box = boxByKey.get(key);
      const el = scrollRef.current;
      if (box === undefined || el === null) return;
      const target = scrollToReveal(box, viewportRef.current, { x: GUTTER_PX + 24, y: 24 });
      if (target !== undefined) el.scrollTo({ left: target.x ?? el.scrollLeft, top: target.y ?? el.scrollTop });
    },
    [boxByKey],
  );

  const goTo = useCallback(
    (key: string, from?: string): void => {
      setFocusKey(key);
      reveal(key);
      pendingFocus.current = key;
      const crossed = foldsBetween(model, from === undefined ? undefined : itemByKey.get(from), itemByKey.get(key));
      if (crossed.length > 0) announce(crossed.map((fold) => fold.a11yLabel).join('. '));
      setFocusTick((tick) => tick + 1);
    },
    [announce, itemByKey, model, reveal],
  );

  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    const root = rootRef.current;
    if (root === null) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-key]')) {
      if (el.dataset['key'] === key) {
        pendingFocus.current = null;
        el.focus({ preventScroll: true });
        return;
      }
    }
  });

  /* ----- follow the editor (§4.6) ----- */
  useEffect(() => {
    if (!view.followEditor || activeDocId === null || agenda) return;
    const root = rootRef.current;
    if (root !== null && root.contains(document.activeElement)) return;
    const item = model.items.find((candidate) => candidate.nodeId === activeDocId && boxByKey.has(candidate.key));
    const box = item === undefined ? undefined : boxByKey.get(item.key);
    const el = scrollRef.current;
    if (box === undefined || el === null) return;
    if (blocks !== undefined) return;
    if (intersects(box, viewportRef.current)) return;
    const target = scrollToReveal(box, viewportRef.current, { x: GUTTER_PX + 24, y: 24 });
    if (target !== undefined) el.scrollTo({ left: target.x ?? el.scrollLeft, top: target.y ?? el.scrollTop });
  }, [activeDocId, view.followEditor]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----- "Show on timeline" from the Findings tab ----- */
  // A request leaves the Agenda, comes down to scene zoom and drops a narrowing scope, so the scene it names can be on screen. This is
  // state adjusted while rendering, which React runs again at once: no frame shows the old view after the writer asked to see a scene.
  const [seenRequest, setSeenRequest] = useState(0);
  if (focusRequest !== null && focusRequest.serial !== seenRequest) {
    setSeenRequest(focusRequest.serial);
    setHighlight(focusRequest.findingId);
    setView((state) => ({
      ...state,
      agenda: false,
      scope: null,
      zoom: levelOfZoom(state.zoom) === 'scene' ? state.zoom : defaultZoom(state.axis),
    }));
  }
  useEffect(() => {
    if (focusRequest === null || agenda || level !== 'scene') return;
    const handle = window.setTimeout(() => {
      const target = targetForDocs(model, focusRequest.docIds);
      if (target === undefined) {
        announce(t`That finding is about a scene that is not on the timeline, so there is nothing to show.`);
        onFocusHandled();
        return;
      }
      const title = target.title;
      if (grid.where.has(target.key)) goTo(target.key);
      else {
        pendingFocus.current = target.key;
        setFocusTick((tick) => tick + 1);
      }
      announce(t`Showing “${{ title }}” on the timeline.`);
      onFocusHandled();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [focusRequest, model, agenda, level]); // eslint-disable-line react-hooks/exhaustive-deps
  /* ----- proposals: what the gestures, the Agenda and the quick actions add to the tray (§4) ----- */
  const proposals = useProposals(session);
  const rows = proposals.tray.set.rows;
  // The tray unmounts with its last row, and focus on one of its buttons goes to <body> with it. Keyboard and screen-reader
  // users are put back where they were working: the focused scene, or the Agenda when it is showing.
  const trayHadFocus = useRef(false);
  const trayRowCount = rows.length;
  useEffect(() => {
    if (trayRowCount > 0 || !trayHadFocus.current) return;
    trayHadFocus.current = false;
    const root = rootRef.current;
    const active = document.activeElement;
    if (root === null || (active !== null && active !== document.body && root.contains(active))) return;
    const cell = agenda || focused === undefined ? undefined : Array.from(root.querySelectorAll<HTMLElement>('[data-key]')).find((el) => el.dataset['key'] === focused);
    (cell ?? document.getElementById('tl-agenda'))?.focus({ preventScroll: true });
  }, [trayRowCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowNumber = useMemo(() => new Map(rows.map((row, at) => [row.id, at + 1])), [rows]);
  const sceneLevel = level === 'scene';
  const itemsByNode = useMemo(() => {
    const map = new Map<string, TimelineItem>();
    for (const item of model.items) if (!map.has(item.nodeId)) map.set(item.nodeId, item);
    return map;
  }, [model]);
  /** The pin rows of the tray by placement, and where each pin's marker stands. */
  const pinRowOf = useMemo(() => new Map(rows.filter((row): row is PinRow => row.kind === 'pin').map((row) => [row.linkId, row])), [rows]);
  const pinEntries = useMemo(() => new Map(pinSlots.entries.map((entry) => [entry.pin.linkId, { ...entry, rect: pinRect(entry.center, entry.row, geometry.width, direction, ox) }])), [pinSlots, geometry, direction, ox]);
  const ghostContext = useMemo<GhostContext>(
    () => ({
      model,
      frames,
      width: geometry.width,
      direction,
      ox,
      boxOf: (key) => boxByKey.get(key),
      laneTop: (laneId) => lanes.find((lane) => lane.id === laneId)?.box.y,
      rowPx: ROW_PX,
    }),
    [model, frames, geometry, direction, ox, boxByKey, lanes],
  );
  /** The proposal rows that name each scene, for the faded original and its number. */
  const proposedBy = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const row of rows) {
      if (row.kind === 'pin') continue;
      const number = rowNumber.get(row.id) as number;
      const ids = row.kind === 'shift' ? row.nodeIds : [row.nodeId];
      for (const id of ids) {
        const list = map.get(id);
        if (list === undefined) map.set(id, [number]);
        else list.push(number);
      }
    }
    return map;
  }, [rows, rowNumber]);
  const ghosts = useMemo(() => {
    const out: { id: string; rowId: string; number: number; box: Rect; from: Rect | undefined; suggestion: boolean }[] = [];
    if (!sceneLevel) return out;
    for (const row of rows) {
      const number = rowNumber.get(row.id) as number;
      const suggestion = row.origin === 'suggestion';
      if (row.kind === 'meta' && !narrative) {
        const item = itemsByNode.get(row.nodeId);
        if (item === undefined) continue;
        const change = { ...(row.day !== undefined ? { day: row.day.to } : {}), ...(row.duration !== undefined ? { duration: row.duration.to } : {}), ...(row.part !== undefined ? { part: row.part.to } : {}) };
        const laneMoves = (row.pov !== undefined && model.options.groupBy === 'pov') || (row.mode !== undefined && model.options.groupBy === 'mode');
        if (Object.keys(change).length === 0 && !laneMoves) continue;
        const box = ghostOfScene(ghostContext, item, change, row);
        if (box !== undefined) out.push({ id: `${row.id}:${item.key}`, rowId: row.id, number, box, from: boxByKey.get(item.key), suggestion });
      } else if (row.kind === 'shift' && !narrative) {
        for (const nodeId of row.nodeIds.slice(0, 60)) {
          const item = itemsByNode.get(nodeId);
          const box = item === undefined ? undefined : ghostOfShift(ghostContext, row, item);
          if (item !== undefined && box !== undefined) out.push({ id: `${row.id}:${item.key}`, rowId: row.id, number, box, from: boxByKey.get(item.key), suggestion });
        }
      } else if (row.kind === 'move' && narrative) {
        const box = ghostOfMove(ghostContext, row, model.items);
        if (box !== undefined) out.push({ id: row.id, rowId: row.id, number, box, from: boxByKey.get(itemsByNode.get(row.nodeId)?.key ?? ''), suggestion });
      } else if (row.kind === 'pin' && !narrative) {
        const entry = pinEntries.get(row.linkId);
        const day = row.to?.dayOffset;
        const center = entry === undefined || day === undefined ? undefined : pinCenter(frames, { day, part: entry.pin.part }, model.axis.pxPerDay);
        if (entry !== undefined && center !== undefined) out.push({ id: row.id, rowId: row.id, number, box: pinRect(center, entry.row, geometry.width, direction, ox), from: entry.rect, suggestion });
      }
    }
    return out;
  }, [rows, rowNumber, sceneLevel, narrative, itemsByNode, ghostContext, boxByKey, model, pinEntries, frames, geometry, direction, ox]);
  const pinsDrawn = useMemo(() => [...pinEntries.values()].filter((entry) => intersects(entry.rect, win)).slice(0, 80), [pinEntries, win]);
  const ghostsDrawn = useMemo(() => ghosts.filter((ghost) => intersects(ghost.box, win)).slice(0, 120), [ghosts, win]);
  const offscreenRows = useMemo(() => {
    const seen = new Set<string>();
    const shown = new Set(ghosts.filter((ghost) => intersects(ghost.box, win)).map((ghost) => ghost.rowId));
    for (const ghost of ghosts) if (!shown.has(ghost.rowId)) seen.add(ghost.rowId);
    return [...seen];
  }, [ghosts, win]);
  const showOffscreen = (): void => {
    const target = ghosts.find((ghost) => ghost.rowId === offscreenRows[0]);
    const el = scrollRef.current;
    if (target === undefined || el === null) return;
    const to = scrollToReveal(target.box, viewportRef.current, { x: GUTTER_PX + 24, y: 24 });
    if (to !== undefined) el.scrollTo({ left: to.x ?? el.scrollLeft, top: to.y ?? el.scrollTop });
  };

  const hasOpenRows = rows.length > 0;
  useEffect(() => {
    if (!hasOpenRows) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasOpenRows]);

  const said = (): void => announce(t`Added to the proposed changes. Nothing is written until you apply.`);
  /** The day a scene would have once the tray's row for it is applied. */
  const dayNow = (nodeId: string): number | null => {
    const row = rows.find((candidate) => candidate.kind === 'meta' && candidate.nodeId === nodeId);
    return row !== undefined && row.kind === 'meta' && row.day !== undefined ? row.day.to : declaredOf(session.state, nodeId).day;
  };
  const durationNow = (nodeId: string): number | null => {
    const row = rows.find((candidate) => candidate.kind === 'meta' && candidate.nodeId === nodeId);
    return row !== undefined && row.kind === 'meta' && row.duration !== undefined ? row.duration.to : declaredOf(session.state, nodeId).duration;
  };
  /** One scene, or every marked scene when the scene is one of them; many scenes at once become one shift. */
  const nudgeDays = (item: TimelineItem, delta: number): void => {
    if (delta === 0) return;
    const ids = selected.has(item.nodeId) && selected.size > 1 ? [...selected] : [item.nodeId];
    const { dated } = datedAmong(session.state, ids);
    if (dated.length > SHIFT_ABOVE) {
      proposals.shift(delta, dated, 'gesture');
      return;
    }
    for (const id of dated) {
      const now = dayNow(id);
      if (now !== null && isProposableDay(now + delta)) proposals.meta(id, { day: now + delta }, 'gesture');
    }
  };
  const proposeIntent = (nodeId: string, intent: MetaIntent): void => {
    if (Object.keys(intent).length === 0) return;
    proposals.meta(nodeId, intent, 'gesture');
    said();
  };
  const proposeNarrative = (item: TimelineItem, how: Parameters<typeof planNarrativeMove>[3]): void => {
    const target = planNarrativeMove(session.state, rows, item.nodeId, how);
    if (target === 'same-place') {
      announce(t`The scene is already there.`);
      return;
    }
    if (target === 'refused') {
      announce(t`The binder does not allow the scene there.`);
      return;
    }
    proposals.move(item.nodeId, target, 'gesture');
    said();
  };
  const [placeRequest, setPlaceRequest] = useState<{ readonly serial: number } | null>(null);

  /* ----- pictures: the lightbox, and moving a pin (§9.1) ----- */
  const [lightbox, setLightbox] = useState<OpenedPicture | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const [markedPins, setMarkedPins] = useState<ReadonlySet<string>>(() => new Set());
  /** The day a pin would have once the tray's row for it is applied. */
  const pinDayNow = (pin: PicturePin): number => pinRowOf.get(pin.linkId)?.to?.dayOffset ?? pin.day;
  const proposePinDay = (pin: PicturePin, day: number): void => {
    if (!isProposableDay(day)) return;
    const current = pinRowOf.get(pin.linkId)?.to ?? pinNow(session.state, pin.linkId) ?? null;
    proposals.pin(pin.linkId, pinWithDay(current, day), 'gesture');
    const title = pin.name;
    const when = lens.label(day, 'long');
    announce(t`Proposed moving the pin of “${{ title }}” to ${{ when }}. Nothing is written until you apply.`);
  };
  const onPinKeyDown = (event: ReactKeyboardEvent<HTMLElement>, pin: PicturePin): void => {
    if (event.key === ' ') {
      // A button opens on the key's release, so the release is what is held back and what marks the pin.
      event.preventDefault();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const row = pinRowOf.get(pin.linkId);
      if (row === undefined) return;
      event.preventDefault();
      proposals.remove(row.id);
      announce(t`The proposed change to this pin is removed.`);
      return;
    }
    const delta = pinKeyDelta({ key: event.key, shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, selected: markedPins.has(pin.linkId) }, uiIsRtl());
    if (delta === null) return;
    event.preventDefault();
    proposePinDay(pin, pinDayNow(pin) + delta);
  };
  const onPinKeyUp = (event: ReactKeyboardEvent<HTMLElement>, pin: PicturePin): void => {
    if (event.key !== ' ') return;
    event.preventDefault();
    setMarkedPins((now) => {
      const next = new Set(now);
      if (next.has(pin.linkId)) next.delete(pin.linkId);
      else next.add(pin.linkId);
      return next;
    });
  };

  const onChord = (event: ReactKeyboardEvent<HTMLElement>, key: string): void => {
    const item = itemByKey.get(key);
    if (item === undefined) return;
    const chord = altChordOf(
      { key: event.key, code: event.code, shift: event.shiftKey, ctrl: event.ctrlKey, meta: event.metaKey, altGraph: event.getModifierState('AltGraph') },
      model.axis.kind,
      uiIsRtl(),
    );
    if (chord === null) return;
    event.preventDefault();
    switch (chord.kind) {
      case 'day': {
        if (item.dayOffset === undefined) {
          announce(t`This scene has no day yet. Use Set day to give it one.`);
          return;
        }
        nudgeDays(item, chord.delta);
        said();
        return;
      }
      case 'duration': {
        const next = Math.max(0, (durationNow(item.nodeId) ?? 0) + chord.delta);
        if (item.dayOffset === undefined) return;
        proposeIntent(item.nodeId, { duration: next === 0 && declaredOf(session.state, item.nodeId).duration === null ? null : next });
        return;
      }
      case 'lane': {
        const laneId = adjacentLane(model, item.lane, chord.step);
        const intent = laneId === undefined ? undefined : laneIntent(model, laneId, item);
        if (intent === undefined) {
          announce(t`There is no lane to change to. Group the timeline by point of view or by mode first.`);
          return;
        }
        proposeIntent(item.nodeId, intent);
        return;
      }
      case 'narrative':
        proposeNarrative(item, { step: chord.step });
        return;
      case 'place':
        setPlaceRequest((now) => ({ serial: (now?.serial ?? 0) + 1 }));
        return;
    }
  };

  /* ----- pointer gestures: a drag is a proposal, and the ghost is one element moved once a frame (§4.2, §7) ----- */
  interface Drag {
    readonly kind: 'chip' | 'edge' | 'shelf' | 'pan' | 'pin';
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly startScroll: { readonly x: number; readonly y: number };
    readonly item: TimelineItem | undefined;
    /** The picture pin a `pin` drag holds. */
    readonly pin?: PicturePin | undefined;
    started: boolean;
    frame: number | null;
    last: { x: number; y: number };
  }
  interface Latest {
    frameOf: () => void;
    onWindowMove: (event: PointerEvent) => void;
    onWindowUp: (event: PointerEvent) => void;
    onWindowCancel: () => void;
    onWindowKey: (event: KeyboardEvent) => void;
    endDrag: (apply: boolean, client?: { x: number; y: number }) => void;
  }
  const latest = useRef<Latest | null>(null);
  // The listeners on `window` are the same functions for the life of the view, so the ones added are the ones removed.
  const windowHandlers = useMemo(
    () => ({
      move: (event: PointerEvent): void => latest.current?.onWindowMove(event),
      up: (event: PointerEvent): void => latest.current?.onWindowUp(event),
      cancel: (): void => latest.current?.onWindowCancel(),
      key: (event: KeyboardEvent): void => latest.current?.onWindowKey(event),
    }),
    [],
  );
  const dragRef = useRef<Drag | null>(null);
  const dragGhost = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);
  const snapshot = (): { model: typeof model; geometry: typeof geometry; boxByKey: typeof boxByKey; lanes: typeof lanes; ghostContext: typeof ghostContext; frames: typeof frames; rows: typeof rows; direction: typeof direction; ox: number; narrative: boolean; placed: typeof placed; visible: typeof visible; itemByKey: typeof itemByKey; selected: typeof selected } => ({ model, geometry, boxByKey, lanes, ghostContext, frames, rows, direction, ox, narrative, placed, visible, itemByKey, selected });

  const canvasPoint = (client: { x: number; y: number }): { x: number; y: number } => {
    const el = scrollRef.current as HTMLDivElement;
    const box = el.getBoundingClientRect();
    return { x: client.x - box.left + el.scrollLeft, y: client.y - box.top + el.scrollTop };
  };

  /** What a drag would propose at a client point, and where its ghost would stand. */
  const resolveDrag = (drag: Drag, client: { x: number; y: number }): { intent: MetaIntent; move?: { item: TimelineItem; target: ReturnType<typeof planNarrativeMove> }; pinDay?: number; rect: Rect | undefined } | undefined => {
    const now = snapshot();
    if (drag.kind === 'pin') {
      const held = drag.pin === undefined ? undefined : pinEntries.get(drag.pin.linkId);
      if (drag.pin === undefined || held === undefined || now.narrative) return undefined;
      const point = canvasPoint(client);
      const x = unmirroredLeft({ x: point.x - now.ox, w: 0 }, now.geometry.width, now.direction);
      const day = pinDragDay(now.frames, now.model.axis.pxPerDay, drag.pin, x);
      const center = day === undefined ? undefined : pinCenter(now.frames, { day, part: drag.pin.part }, now.model.axis.pxPerDay);
      if (day === undefined || center === undefined) return undefined;
      return { intent: {}, pinDay: day, rect: pinRect(center, held.row, now.geometry.width, now.direction, now.ox) };
    }
    const item = drag.item;
    if (item === undefined) return undefined;
    const el = scrollRef.current as HTMLDivElement;
    const point = canvasPoint(client);
    const dx = client.x - drag.startX + (el.scrollLeft - drag.startScroll.x);
    if (now.narrative) {
      if (drag.kind === 'edge') return undefined;
      const chips = now.placed.filter((entry) => now.visible.has(entry.key) && entry.key !== item.key).flatMap((entry) => {
        const other = now.itemByKey.get(entry.key);
        return other === undefined ? [] : [{ nodeId: other.nodeId, box: entry.box }];
      });
      const near = narrativeDrop(chips, point, now.direction);
      if (near === undefined) return undefined;
      const target = planNarrativeMove(session.state, now.rows, item.nodeId, { drop: near });
      const rect = typeof target === 'string' ? undefined : ghostOfMove(now.ghostContext, { kind: 'move', id: 'drag', nodeId: item.nodeId, origin: 'gesture', base: { parentId: '', predecessorId: null }, to: target } satisfies MoveRow, now.model.items);
      return { intent: {}, move: { item, target }, rect };
    }
    const geoPoint = { x: point.x - now.ox, y: point.y };
    const origin = now.boxByKey.get(item.key);
    const ppd = now.model.axis.pxPerDay;
    const current = dayNow(item.nodeId);
    if (drag.kind === 'edge') {
      if (origin === undefined) return undefined;
      const left = unmirroredLeft({ x: origin.x - now.ox, w: origin.w }, now.geometry.width, now.direction);
      const pointer = unmirroredLeft({ x: geoPoint.x, w: 0 }, now.geometry.width, now.direction);
      const length = Math.max(0, Math.round((pointer - left) / ppd));
      const same = length === (durationNow(item.nodeId) ?? 0);
      const intent: MetaIntent = same ? {} : { duration: length === 0 && declaredOf(session.state, item.nodeId).duration === null ? null : length };
      return { intent, rect: ghostOfScene(now.ghostContext, item, { duration: length }) };
    }
    const zones: DropArea[] = now.geometry.zones.map((zone) => ({ part: zone.part, box: zone.box }));
    const folds: DropArea[] = now.geometry.folds.map((fold) => ({ part: now.model.axis.folds[fold.index]?.part ?? 'main', box: fold.box }));
    const drop = storyDrop({
      frames: now.frames,
      ppd,
      width: now.geometry.width,
      direction: now.direction,
      zones,
      folds,
      lanes: now.lanes,
      origin: origin === undefined ? undefined : { x: origin.x - now.ox, w: origin.w },
      dx,
      pointer: geoPoint,
      part: item.part,
    });
    const intent: { -readonly [K in keyof MetaIntent]: MetaIntent[K] } = {};
    if (drop.day !== undefined && drop.region !== 'fold' && drop.day !== current) intent.day = drop.day;
    if (drop.part !== item.part) intent.part = drop.part;
    let laneTopY: number | undefined;
    if (drop.laneId !== undefined && drop.laneId !== item.lane) {
      const lane = laneIntent(now.model, drop.laneId, item);
      if (lane !== undefined) Object.assign(intent, lane);
      laneTopY = now.lanes.find((candidate) => candidate.id === drop.laneId)?.box.y;
    }
    const rect = ghostOfScene(now.ghostContext, item, { ...(drop.day !== undefined && drop.region !== 'fold' ? { day: drop.day } : {}), part: drop.part });
    if (rect === undefined) return { intent, rect: undefined };
    return { intent, rect: laneTopY === undefined ? rect : { ...rect, y: laneTopY + item.row * ROW_PX } };
  };

  const hideDragGhost = (): void => {
    const el = dragGhost.current;
    if (el !== null) el.hidden = true;
  };
  const endDrag = (apply: boolean, client?: { x: number; y: number }): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
    window.removeEventListener('pointermove', windowHandlers.move);
    window.removeEventListener('pointerup', windowHandlers.up);
    window.removeEventListener('pointercancel', windowHandlers.cancel);
    window.removeEventListener('keydown', windowHandlers.key, true);
    hideDragGhost();
    scrollRef.current?.classList.remove('is-panning');
    if (!drag.started) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (!apply || drag.kind === 'pan' || client === undefined) return;
    const result = resolveDrag(drag, client);
    if (result === undefined) return;
    if (drag.kind === 'pin') {
      if (drag.pin !== undefined && result.pinDay !== undefined && result.pinDay !== pinDayNow(drag.pin)) proposePinDay(drag.pin, result.pinDay);
      return;
    }
    if (drag.item === undefined) return;
    if (result.move !== undefined) {
      const target = result.move.target;
      if (typeof target === 'string') {
        announce(target === 'same-place' ? t`The scene is already there.` : t`The binder does not allow the scene there.`);
        return;
      }
      proposals.move(drag.item.nodeId, target, 'gesture');
      said();
      return;
    }
    const intent = result.intent;
    if (Object.keys(intent).length === 0) return;
    const now = snapshot();
    const grabbed = drag.item;
    if (now.selected.has(grabbed.nodeId) && now.selected.size > 1 && intent.day !== undefined && intent.day !== null && drag.kind === 'chip') {
      const base = dayNow(grabbed.nodeId);
      if (base !== null) nudgeDays(grabbed, intent.day - base);
      said();
      return;
    }
    proposeIntent(grabbed.nodeId, intent);
  };
  const frameOf = (): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    drag.frame = null;
    const el = scrollRef.current;
    if (drag.kind === 'pan') {
      if (el !== null) {
        el.scrollLeft = drag.startScroll.x - (drag.last.x - drag.startX);
        el.scrollTop = drag.startScroll.y - (drag.last.y - drag.startY);
      }
      return;
    }
    const ghost = dragGhost.current;
    const result = resolveDrag(drag, drag.last);
    if (ghost === null) return;
    if (result?.rect === undefined) {
      ghost.hidden = true;
      return;
    }
    ghost.hidden = false;
    ghost.style.width = `${result.rect.w}px`;
    ghost.style.height = `${result.rect.h}px`;
    ghost.style.transform = `translate(${result.rect.x}px,${result.rect.y}px)`;
  };
  const onWindowMove = (event: PointerEvent): void => {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    drag.last = { x: event.clientX, y: event.clientY };
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.started = true;
      if (drag.kind === 'pan') scrollRef.current?.classList.add('is-panning');
    }
    if (drag.frame === null) drag.frame = window.requestAnimationFrame(() => latest.current?.frameOf());
  };
  const onWindowUp = (event: PointerEvent): void => {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    endDrag(true, { x: event.clientX, y: event.clientY });
  };
  const onWindowCancel = (): void => endDrag(false);
  const onWindowKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || dragRef.current === null) return;
    event.preventDefault();
    event.stopPropagation();
    const started = dragRef.current.started;
    endDrag(false);
    if (started) announce(t`Drag cancelled. Nothing was proposed.`);
  };
  const beginDrag = (kind: Drag['kind'], event: { pointerId: number; clientX: number; clientY: number }, item: TimelineItem | undefined, pin?: PicturePin): void => {
    if (dragRef.current !== null) return;
    const el = scrollRef.current;
    if (el === null) return;
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScroll: { x: el.scrollLeft, y: el.scrollTop },
      item,
      pin,
      started: false,
      frame: null,
      last: { x: event.clientX, y: event.clientY },
    };
    window.addEventListener('pointermove', windowHandlers.move);
    window.addEventListener('pointerup', windowHandlers.up);
    window.addEventListener('pointercancel', windowHandlers.cancel);
    window.addEventListener('keydown', windowHandlers.key, true);
  };
  useEffect(() => {
    latest.current = { frameOf, onWindowMove, onWindowUp, onWindowCancel, onWindowKey, endDrag };
  });
  useEffect(() => () => latest.current?.endDrag(false), []);

  /** A bar is picked up by a primary press on it, or by its end edge for a length. The shelf's scenes are picked up the same way. */
  const onChipPointerDown = (event: ReactPointerEvent<HTMLElement>, item: TimelineItem): void => {
    if (event.button !== 0 || !event.isPrimary || agenda || !sceneLevel) return;
    if ((event.target as HTMLElement).closest('.tl-badge') !== null) return;
    const box = boxByKey.get(item.key);
    let kind: Drag['kind'] = 'chip';
    if (!narrative && box !== undefined && item.dayOffset !== undefined && box.w > 14) {
      const pointer = unmirroredLeft({ x: canvasPoint({ x: event.clientX, y: event.clientY }).x - ox, w: 0 }, geometry.width, direction);
      const edge = unmirroredLeft({ x: box.x - ox, w: box.w }, geometry.width, direction) + box.w;
      if (Math.abs(pointer - edge) <= 6) kind = 'edge';
    }
    beginDrag(kind, event, item);
  };
  const onPinPointerDown = (event: ReactPointerEvent<HTMLElement>, pin: PicturePin): void => {
    if (event.button !== 0 || !event.isPrimary || narrative || agenda || !sceneLevel) return;
    beginDrag('pin', event, undefined, pin);
  };
  const onShelfPointerDown = (event: ReactPointerEvent<HTMLElement>, item: TimelineItem): void => {
    if (event.button !== 0 || !event.isPrimary || narrative || agenda) return;
    beginDrag('shelf', event, item);
  };
  const onScrollPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (dragRef.current !== null || !event.isPrimary) return;
    const middle = event.button === 1;
    if (!middle && (event.button !== 0 || (event.target as HTMLElement).closest('[role="gridcell"], button, .tl-fold, input, select') !== null)) return;
    if (middle) event.preventDefault();
    beginDrag('pan', event, undefined);
  };
  /** A click that ends a drag is not a click. */
  const clickAllowed = (): boolean => !suppressClick.current;

  /* ----- keys ----- */
  const toggle = (nodeId: string): void => {
    setSelected((now) => {
      const next = new Set(now);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };
  const zoomInto = (nodeId: string): void => {
    change((state) => ({ ...state, scope: nodeId === 'manuscript' ? state.scope : nodeId, zoom: defaultZoom(state.axis) }));
  };
  const openKey = (key: string): void => {
    const item = itemByKey.get(key);
    if (item !== undefined) onOpenDocument(item.nodeId);
    else {
      const block = blockById.get(key);
      if (block !== undefined) zoomInto(block.nodeId);
    }
  };
  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
    const key = cell?.dataset['key'];
    if (key !== undefined && event.altKey) {
      onChord(event, key);
      return;
    }
    if (key === undefined) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const nodeId = itemByKey.get(key)?.nodeId;
      const mine = nodeId === undefined ? [] : rows.filter((row) => row.kind !== 'shift' && row.kind !== 'pin' && row.nodeId === nodeId);
      if (mine.length > 0) {
        event.preventDefault();
        for (const row of mine) proposals.remove(row.id);
        announce(t`The proposed change to this scene is removed.`);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      openKey(key);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      const item = itemByKey.get(key);
      if (item !== undefined) toggle(item.nodeId);
      return;
    }
    if (
      layoutLetter(event.key, event.code) === 'f' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !isImeEnter(event.nativeEvent) &&
      !event.getModifierState('AltGraph')
    ) {
      const group = badgeOf(itemByKey.get(key)?.findings ?? [])?.groups[0];
      if (group !== undefined) {
        event.preventDefault();
        onOpenFindings(group);
      }
      return;
    }
    const move = moveOfKey(event.key, event.ctrlKey || event.metaKey, uiIsRtl());
    if (move === null) return;
    event.preventDefault();
    const next = moveFocus(grid, key, move);
    if (next !== undefined) goTo(next, key);
  };
  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'F6') {
      const tray = rootRef.current?.querySelector<HTMLElement>('#tl-tray');
      if (tray === null || tray === undefined) return;
      event.preventDefault();
      if (tray.contains(document.activeElement)) {
        if (focused !== undefined) goTo(focused);
        else document.getElementById('tl-agenda')?.focus();
      } else tray.focus();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const direction2 = event.key === '=' || event.key === '+' ? 'in' : event.key === '-' ? 'out' : null;
    if (direction2 === null || agenda) return;
    event.preventDefault();
    change((state) => ({ ...state, zoom: stepZoom(state.axis, state.zoom, direction2) }));
  };

  /* ----- the parts of the drawing ----- */
  const patterns = (
    <defs>
      <pattern id="tl-pat-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" className="tl-pat-bg" />
        <line x1="0" y1="0" x2="0" y2="6" className="tl-pat-line" />
      </pattern>
    </defs>
  );

  const ticks = useMemo(() => {
    if (narrative || level !== 'scene') return [];
    const out: { x: number; level: number; label: string }[] = [];
    geometry.ticks.forEach((tick) => {
      const x = tick.x + ox;
      if (x < win.x || x > win.x + win.w) return;
      const source = model.axis.ticks[tick.index];
      if (source !== undefined) out.push({ x, level: source.level, label: source.label });
    });
    out.sort((a, b) => b.level - a.level || a.x - b.x);
    return out.slice(0, MAX_TICKS);
  }, [narrative, level, geometry, model, ox, win]);

  const connectors = useMemo(() => {
    if (level !== 'scene') return [];
    const drawn: { id: string; d: string; cls: string; glyph?: { x: number; y: number; text: string }; findingId?: string }[] = [];
    const onScreen = (a: Rect, b: Rect): boolean => intersects({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + a.w + b.w, h: Math.abs(a.y - b.y) + a.h + b.h }, win);
    if (view.overlays.findings) {
      for (const pair of pairOverlays(model, boxByKey)) {
        if (pair.kind === 'gap-band') continue;
        if (!onScreen(pair.from, pair.to)) continue;
        const curve = curveBetween(pair.from, pair.to);
        drawn.push({ id: pair.id, d: curve.d, cls: classes('tl-conn', 'is-finding', 'is-'.concat(pair.severity)), glyph: { x: curve.mid.x, y: curve.mid.y, text: PAIR_GLYPH[pair.checkId] ?? SEVERITY_GLYPH[pair.severity] }, findingId: pair.findingId });
      }
    }
    for (const connector of model.connectors) {
      const from = boxByKey.get(connector.from);
      const to = boxByKey.get(connector.to);
      if (connector.kind === 'after' && view.overlays.after && from !== undefined && to !== undefined && onScreen(from, to)) {
        const curve = curveBetween(from, to);
        const bad = connector.violation === true || connector.cycle === true;
        drawn.push({ id: connector.id, d: curve.d, cls: classes('tl-conn', 'is-after', bad && 'is-error'), ...(bad ? { glyph: { x: curve.mid.x, y: curve.mid.y, text: SEVERITY_GLYPH.error } } : {}) });
      } else if (connector.kind === 'thread' && view.overlays.thread && from !== undefined && to !== undefined && onScreen(from, to)) {
        drawn.push({ id: connector.id, d: curveBetween(from, to).d, cls: classes('tl-conn', 'is-thread') });
      } else if (connector.kind === 'presence' && view.overlays.presence && connector.path !== undefined) {
        const points = connector.path.map((key) => boxByKey.get(key)).filter((box): box is Rect => box !== undefined && intersects(box, win));
        if (points.length > 1) {
          const [head, ...rest] = points.map((box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 }));
          if (head !== undefined) {
            drawn.push({ id: connector.id, d: pathOf(['M', head.x, head.y], ...rest.map((point): readonly [string, number, number] => ['L', point.x, point.y])), cls: classes('tl-conn', 'is-presence') });
          }
        }
      } else if (connector.kind === 'braid' && model.axis.kind === 'braid' && connector.variant === 'slot' && to !== undefined) {
        const slot = geometry.slots.find((entry) => entry.nodeId === connector.fromNode);
        if (slot === undefined) continue;
        const sb = shifted(slot.box, ox, oy);
        if (!onScreen(sb, to)) continue;
        drawn.push({ id: connector.id, d: pathOf(['M', sb.x + sb.w / 2, sb.y + sb.h], ['L', to.x + Math.min(to.w / 2, 10), to.y]), cls: classes('tl-conn', 'is-braid', connector.emphasised === true && 'is-emphasised') });
      }
    }
    return drawn.slice(0, MAX_CONNECTORS);
  }, [level, view.overlays, model, boxByKey, win, geometry, ox, oy]);

  const gapBands = useMemo(() => (level === 'scene' && view.overlays.findings ? pairOverlays(model, boxByKey).filter((pair) => pair.kind === 'gap-band' && pair.band !== undefined && intersects(pair.band, win)).slice(0, MAX_CONNECTORS) : []), [level, view.overlays.findings, model, boxByKey, win]);

  const slotBoxes = useMemo(() => {
    if (model.axis.kind !== 'braid' || level !== 'scene') return [];
    const list = geometry.slots.map((slot) => ({ key: slot.nodeId, box: shifted(slot.box, ox, oy) }));
    return visibleKeys(list, win, 120).map((key) => list.find((entry) => entry.key === key) as Placed);
  }, [model.axis.kind, level, geometry, ox, oy, win]);

  const bandBoxes = useMemo(() => {
    if (level !== 'scene' || model.axis.kind === 'story') return [];
    const list = geometry.bands.map((band) => {
      const source = model.bands.find((candidate) => candidate.nodeId === band.nodeId);
      const depth = source?.depth ?? 0;
      const box = shifted(band.box, ox, narrative ? HEADER_PX + depth * BAND_PX - band.box.y : oy);
      return { key: band.nodeId, box: { ...box, h: narrative ? BAND_PX - 2 : box.h }, title: source?.title ?? '', depth };
    });
    return list.filter((entry) => (narrative || entry.depth === 0) && intersects(entry.box, win)).slice(0, MAX_BANDS);
  }, [level, model, geometry, ox, oy, narrative, win]);

  const detailItem = focused === undefined ? undefined : itemByKey.get(focused);
  const detailBlock = focused === undefined ? undefined : blockById.get(focused);

  const openFindingsFor = (item: TimelineItem): void => {
    const group = badgeOf(item.findings)?.groups[0];
    if (group !== undefined) onOpenFindings(group);
  };

  const povName = useCallback(
    (id: string): string => (id === '' ? '' : (session.state.manifest.codex?.find((entry) => entry.id === id)?.name ?? id)),
    [session, version], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const povChoices = useMemo(
    () => povCandidates(session.mentions.entriesOf(session.state), language).map((entry) => ({ id: entry.id, name: entry.name })),
    [session, version, language], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const agendaEdit: AgendaEdit = {
    rowOf: (nodeId) => {
      const row = rows.find((candidate): candidate is MetaRow => candidate.kind === 'meta' && candidate.nodeId === nodeId);
      return row === undefined ? undefined : { row, number: rowNumber.get(row.id) as number };
    },
    declared: (nodeId) => declaredOf(session.state, nodeId),
    povChoices,
    onMeta: (nodeId, intent) => {
      proposals.meta(nodeId, intent, 'agenda');
      said();
    },
  };

  /* ----- Save image (§8): a browser-only PNG; the file is never written to the project ----- */
  const [savingImage, setSavingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const saveImage = (): void => {
    if (savingImage) return;
    setSavingImage(true);
    setImageError(null);
    void saveTimelineImage({ state: session.state, scopeId }).then((outcome) => {
      setSavingImage(false);
      if (outcome.ok) {
        const name = outcome.filename;
        announce(t`Saved the timeline image as “${{ name }}”.`);
      } else setImageError(outcome.message);
    });
  };

  /* ----- render ----- */
  const skipToAgenda = (): void => {
    setView((state) => ({ ...state, agenda: true }));
    window.setTimeout(() => document.getElementById('tl-agenda')?.focus(), 0);
  };

  if (model.stats.scenes === 0 && scopeId === null) {
    return (
      <section className="tl" aria-label={t`Timeline`} data-testid="timeline-view">
        <EmptyState title={t`No scenes to place yet`}>
          <Trans>Write a scene in the manuscript, and the timeline shows it. Scenes with a day sit on the story axis, and the rest wait on a shelf.</Trans>
        </EmptyState>
      </section>
    );
  }

  const gridLabel = t`Timeline, ${{ axis: axisName(model.axis.kind) }}, ${{ group: groupPhrase(model.options.groupBy) }}`;
  const emptyStory = model.axis.kind !== 'narrative' && model.stats.scheduled === 0;

  return (
    <section
      className="tl"
      aria-label={t`Timeline`}
      data-testid="timeline-view"
      data-direction={direction}
      data-axis={model.axis.kind}
      data-level={level}
      ref={rootRef}
      onKeyDown={onRootKeyDown}
      onFocus={(event) => {
        trayHadFocus.current = (event.target as HTMLElement).closest('#tl-tray') !== null;
      }}
    >
      {agenda ? null : (
        <button type="button" className="tl-skip" onClick={skipToAgenda}>
          <Trans>Skip to the Agenda</Trans>
        </button>
      )}
      <TimelineControls
        view={view}
        agenda={agenda}
        scheduled={model.stats.scheduled}
        total={model.stats.scenes}
        scopes={scopes}
        scope={scopeId}
        onAxis={(axis: TimelineAxis) => change((state) => withAxis(state, axis))}
        onZoom={(zoom: Zoom) => change((state) => ({ ...state, zoom: zoomForAxis(state.axis, zoom) }))}
        onGroupBy={(groupBy) => change((state) => ({ ...state, groupBy, overlays: { ...state.overlays, presence: groupBy === 'character' ? (state.groupBy === 'character' ? state.overlays.presence : model.stats.presenceDefaultOn) : false } }))}
        onScope={(scope) => change((state) => ({ ...state, scope }))}
        onCompress={(compressGaps) => change((state) => ({ ...state, compressGaps }))}
        onOverlay={(key: keyof TimelineOverlays, on) => setView((state) => ({ ...state, overlays: { ...state.overlays, [key]: on } }))}
        onFollow={(followEditor) => setView((state) => ({ ...state, followEditor }))}
        onAgenda={(on) => setView((state) => ({ ...state, agenda: on }))}
        onSaveImage={saveImage}
        savingImage={savingImage}
        onCalendar={() => setCalendarOpen(true)}
      />
      {calendarOpen ? <CalendarDialog session={session} lensOptions={lensOptions} onClose={() => setCalendarOpen(false)} /> : null}
      {chosen.source === 'day' && chosen.problems.length > 0 ? (
        <p className="form-message is-error" role="status" data-testid="timeline-calendar-problem">
          <Trans>This project's calendar cannot be used, so days show as day numbers. Open Calendar to see what to fix.</Trans>
        </p>
      ) : null}
      {imageError === null ? null : (
        <p className="form-message is-error" role="alert" data-testid="timeline-image-error">
          {imageError}
        </p>
      )}
      <div className="visually-hidden" role="status" aria-live="polite" data-testid="timeline-live">
        {announcement}
      </div>
      {agenda ? (
        <Agenda
          model={model}
          lens={lens}
          labels={labels}
          language={language}
          povName={povName}
          activeDocId={activeDocId}
          onOpen={onOpenDocument}
          onOpenFindings={onOpenFindings}
          edit={agendaEdit}
        />
      ) : (
        <>
          {emptyStory ? (
            <p className="tl-empty" role="note">
              <Trans>No scene has a day yet. Give a scene a day in the Inspector, or ask the agent to propose days from the text. Until then the scenes wait on the shelf below, or switch to reading order.</Trans>
            </p>
          ) : null}
          <div className="tl-stage">
            <div className="tl-scroll" dir="ltr" ref={scrollRef} onScroll={syncViewport} onPointerDown={onScrollPointerDown} data-testid="timeline-scroll">
              <div className="tl-canvas" style={{ inlineSize: canvasW, blockSize: canvasH }}>
                <svg className="tl-svg" width={canvasW} height={canvasH} aria-hidden="true" focusable="false">
                  {patterns}
                  {model.zones.length > 0 && !narrative
                    ? geometry.zones.map((zone) => {
                        const box = shifted(zone.box, ox, oy);
                        return (
                          <g key={zone.part} data-part={zone.part}>
                            <rect className={`tl-zone is-${zone.part}`} x={box.x} y={oy - HEADER_PX + 2} width={box.w} height={contentH + HEADER_PX - 2 + (blocks === undefined ? 0 : 0)} />
                            <text className="tl-zone-label" x={direction === 'ltr' ? box.x + 6 : box.x + box.w - 6} y={oy - HEADER_PX + 14} textAnchor={direction === 'ltr' ? 'start' : 'end'}>
                              {labels.partName(zone.part)}
                            </text>
                          </g>
                        );
                      })
                    : null}
                  {narrative
                    ? geometry.partRuns
                        .map((run) => ({ part: run.part, box: shifted(run.box, ox, oy) }))
                        .filter((run) => intersects(run.box, win))
                        .slice(0, MAX_BANDS)
                        .map((run, at) => (
                          <g key={`${run.part}:${at}`} data-part={run.part}>
                            <rect className={`tl-zone is-${run.part}`} x={run.box.x} y={4} width={run.box.w} height={contentH + oy - 4} />
                            <text className="tl-zone-label" x={direction === 'ltr' ? run.box.x + 6 : run.box.x + run.box.w - 6} y={14} textAnchor={direction === 'ltr' ? 'start' : 'end'}>
                              {labels.partName(run.part)}
                            </text>
                          </g>
                        ))
                    : null}
                  {ticks.map((tick) => (
                    <g key={`${tick.x}:${tick.level}`} className={`tl-tick is-level-${tick.level}`}>
                      <line x1={tick.x} x2={tick.x} y1={oy - 6 - tick.level * 3} y2={oy + contentH} />
                      {tick.label === '' ? null : (
                        <text x={tick.x + 3} y={oy - 10}>
                          {tick.label}
                        </text>
                      )}
                    </g>
                  ))}
                  {narrative || level !== 'scene'
                    ? null
                    : geometry.breaks.map((entry) => {
                        const box = shifted(entry.box, ox, oy);
                        if (!intersects(box, win)) return null;
                        const source = model.axis.breaks[entry.index];
                        return (
                          <g key={`break:${entry.index}`} className={`tl-break is-${source?.kind ?? 'gap'}`}>
                            <rect x={box.x} y={box.y} width={box.w} height={contentH - entry.box.y} />
                            <text transform={`rotate(-90 ${box.x + box.w / 2} ${box.y + 8})`} x={box.x + box.w / 2 - 6} y={box.y + 12}>
                              {source?.label}
                            </text>
                          </g>
                        );
                      })}
                  {narrative || level !== 'scene' ? null : geometry.folds.map((entry) => {
                    const box = shifted(entry.box, ox, oy);
                    return intersects(box, win) ? <rect key={`fold:${entry.index}`} className="tl-fold-rect" x={box.x} y={oy - HEADER_PX + 2} width={box.w} height={contentH + HEADER_PX - 2} /> : null;
                  })}
                  {gapBands.map((pair) => {
                    const band = pair.band as Box;
                    return (
                      <g key={pair.id} className={`tl-gap-band is-${pair.severity}`}>
                        <rect x={band.x} y={band.y} width={band.w} height={band.h} fill="url(#tl-pat-hatch)" />
                        <text x={band.x + band.w / 2} y={band.y + band.h / 2 + 4} textAnchor="middle">
                          {PAIR_GLYPH['timeline.gap']}
                        </text>
                      </g>
                    );
                  })}
                  {slotBoxes.map((slot) => (
                    <rect key={slot.key} className="tl-slot" x={slot.box.x} y={slot.box.y} width={Math.max(slot.box.w - 1, 1)} height={slot.box.h} />
                  ))}
                  {ghostsDrawn.map((ghost) => (ghost.from === undefined ? null : <path key={`link:${ghost.id}`} className="tl-ghost-link" d={curveBetween(ghost.from, ghost.box).d} fill="none" />))}
                  {connectors.map((connector) => (
                    <g key={connector.id} className={connector.cls} data-active={connector.findingId !== undefined && connector.findingId === highlight ? 'true' : undefined}>
                      <path d={connector.d} fill="none" />
                      {connector.glyph === undefined ? null : (
                        <text x={connector.glyph.x} y={connector.glyph.y + 4} textAnchor="middle">
                          {connector.glyph.text}
                        </text>
                      )}
                    </g>
                  ))}
                </svg>
                {bandBoxes.map((band) => (
                  <div
                    key={band.key}
                    className="tl-band"
                    aria-hidden="true"
                    style={{ transform: `translate(${band.box.x}px, ${band.box.y}px)`, inlineSize: band.box.w, blockSize: band.box.h }}
                  >
                    <UserText value={band.title} lang={language} />
                  </div>
                ))}
                {narrative || level !== 'scene'
                  ? null
                  : geometry.folds.map((entry) => {
                      const box = shifted(entry.box, ox, oy);
                      const fold = model.axis.folds[entry.index];
                      if (fold === undefined || !intersects(box, win)) return null;
                      return (
                        <div
                          key={`fold:${entry.index}`}
                          role="separator"
                          aria-orientation="vertical"
                          tabIndex={-1}
                          className="tl-fold"
                          aria-label={accessibleText(fold.a11yLabel)}
                          data-part={fold.part}
                          style={{ transform: `translate(${box.x}px, ${oy}px)`, inlineSize: box.w, blockSize: contentH }}
                        >
                          <span aria-hidden="true">{fold.label}</span>
                        </div>
                      );
                    })}
                {narrative || level !== 'scene'
                  ? null
                  : geometry.breaks.map((entry) => {
                      const source = model.axis.breaks[entry.index];
                      const box = shifted(entry.box, ox, oy);
                      if (source?.findingId === undefined || !intersects(box, win)) return null;
                      const findingId = source.findingId;
                      const group = model.items.flatMap((item) => item.findings).find((finding) => finding.id === findingId)?.groupKey;
                      if (group === undefined) return null;
                      return (
                        <button
                          key={`break:${entry.index}`}
                          type="button"
                          className="tl-break-link"
                          aria-label={t`${{ label: source.label }}: open the gap finding`}
                          style={{ transform: `translate(${box.x}px, ${oy}px)`, inlineSize: box.w, blockSize: Math.min(contentH, 120) }}
                          onClick={() => onOpenFindings(group)}
                        />
                      );
                    })}
                {pinsDrawn.length === 0 ? null : (
                  <div role="group" className="tl-pins" aria-label={t`Pictures pinned to a day`} data-testid="timeline-pins">
                    {pinsDrawn.map((entry) => {
                      const pin = entry.pin;
                      const proposed = pinRowOf.get(pin.linkId);
                      const marked = markedPins.has(pin.linkId);
                      const title = pin.name;
                      const day = lens.label(pin.day, 'long');
                      const base = accessibleText(t`${{ title: isolate(title) }}, pinned to ${{ day }}`);
                      const parts = [base];
                      if (proposed?.to?.dayOffset !== undefined) {
                        const to = lens.label(proposed.to.dayOffset, 'long');
                        parts.push(t`proposed for ${{ to }}`);
                      }
                      if (marked) parts.push(t`marked, the arrow keys propose a new day`);
                      return (
                        <PictureButton
                          key={pin.linkId}
                          session={session}
                          version={assetsVersion}
                          record={pin.record}
                          title={pin.name}
                          alt={pin.alt}
                          className="tl-pin"
                          label={parts.join(', ')}
                          canOpen={clickAllowed}
                          onOpen={setLightbox}
                          extras={{
                            'data-pin': pin.linkId,
                            'data-marked': marked ? 'true' : undefined,
                            'data-proposed': proposed === undefined ? undefined : 'true',
                            style: boxStyle(entry.rect.x, entry.rect.y, entry.rect.w, entry.rect.h),
                            onKeyDown: (event) => onPinKeyDown(event, pin),
                            onKeyUp: (event) => onPinKeyUp(event, pin),
                            onPointerDown: (event) => onPinPointerDown(event, pin),
                          }}
                        />
                      );
                    })}
                  </div>
                )}
                <div role="grid" aria-label={gridLabel} aria-rowcount={grid.rows.length} className="tl-grid" onKeyDown={onGridKeyDown} data-testid="timeline-grid">
                  {visibleLaneBoxes.map((lane) => {
                    const row = grid.rows[(rowIndexOf.get(lane.id) as number) - 1];
                    const label = blocks !== undefined ? labels.lane.all : (laneLabel.get(lane.id) ?? '');
                    const chips = chipsByLane.get(lane.id) ?? [];
                    return (
                      <div
                        key={lane.id}
                        role="row"
                        aria-rowindex={rowIndexOf.get(lane.id)}
                        className="tl-row"
                        data-lane={lane.id}
                        style={{ transform: `translateY(${lane.box.y}px)`, inlineSize: canvasW, blockSize: lane.box.h }}
                      >
                        <div role="rowheader" className="tl-rowhead">
                          {laneCharacter.has(lane.id) && blocks === undefined ? (
                            <LanePortrait session={session} version={assetsVersion} record={portraitOf(session.state, laneCharacter.get(lane.id) as string)} name={label} />
                          ) : null}
                          <UserText value={label} lang={language} />
                        </div>
                        {chips.map((entry) => {
                          const item = itemByKey.get(entry.key);
                          const style: CSSProperties = boxStyle(entry.box.x, entry.box.y - lane.box.y, entry.box.w, entry.box.h);
                          if (item === undefined) {
                            const block = blockById.get(entry.key);
                            if (block === undefined || row === undefined) return null;
                            const count = block.count;
                            const openCount = block.openFindings;
                            const name = block.label;
                            const part = labels.partName(block.part);
                            const first = block.start === undefined ? '' : lens.label(block.start, 'long');
                            const description = [t`${{ name }}, ${plural(count, { one: '# scene', other: '# scenes' })}`, part, first, block.openFindings > 0 ? plural(openCount, { one: '# open finding', other: '# open findings' }) : '']
                              .filter((piece) => piece !== '')
                              .join(', ');
                            return (
                              <div
                                key={entry.key}
                                role="gridcell"
                                data-key={entry.key}
                                className="tl-chip is-block"
                                data-part={block.part}
                                tabIndex={focused === entry.key ? 0 : -1}
                                aria-label={accessibleText(description)}
                                style={style}
                                onFocus={() => setFocusKey(entry.key)}
                                onDoubleClick={() => zoomInto(block.nodeId)}
                              >
                                <UserText value={block.label} lang={language} />
                                <span className="tl-count" aria-hidden="true">
                                  {count}
                                </span>
                                {block.openFindings === 0 ? null : (
                                  <span aria-hidden="true" className="tl-badge is-warning">
                                    {SEVERITY_GLYPH.warning}
                                    {block.openFindings}
                                  </span>
                                )}
                              </div>
                            );
                          }
                          const badge = badgeOf(item.findings);
                          const isSelected = selected.has(item.nodeId);
                          const proposedNumbers = proposedBy.get(item.nodeId);
                          const proposedCount = proposedNumbers?.length ?? 0;
                          const mediaNote = mediaNoteOf(item.mediumGlyph);
                          const placed = pictures.of(item.nodeId);
                          const pictureNote = picturesNote(placed.length);
                          const noted = [accessibleText(item.a11yLabel), mediaNote, pictureNote].filter((piece) => piece !== '');
                          const name = noted.join(', ');
                          const bar = view.zoom === 'day' && !narrative ? barPictures(placed, entry.box.w) : undefined;
                          return (
                            <div
                              key={entry.key}
                              role="gridcell"
                              data-key={entry.key}
                              data-node={item.nodeId}
                              data-mode={item.mode}
                              data-pattern={item.glyph.pattern}
                              data-part={item.part}
                              data-inferred={item.inferred === true ? 'true' : undefined}
                              data-narrow={entry.box.w < 40 ? 'true' : undefined}
                              data-proposed={proposedCount > 0 ? 'true' : undefined}
                              className="tl-chip"
                              tabIndex={focused === entry.key ? 0 : -1}
                              aria-selected={isSelected}
                              aria-current={item.nodeId === activeDocId ? 'true' : undefined}
                              aria-label={proposedCount === 0 ? name : `${name}, ${plural(proposedCount, { one: '# proposed change', other: '# proposed changes' })}`}
                              style={style}
                              onFocus={() => setFocusKey(entry.key)}
                              onPointerDown={(event) => onChipPointerDown(event, item)}
                              onClick={(event) => {
                                if (!clickAllowed()) return;
                                if (event.shiftKey || event.ctrlKey || event.metaKey) toggle(item.nodeId);
                                else setSelected(new Set([item.nodeId]));
                              }}
                              onDoubleClick={() => onOpenDocument(item.nodeId)}
                            >
                              {proposedNumbers === undefined ? null : (
                                <span aria-hidden="true" className="tl-pnum">
                                  {proposedNumbers.join(',')}
                                </span>
                              )}
                              <span aria-hidden="true" className="tl-glyph">
                                {item.partNote === undefined ? item.glyph.glyph : `${item.glyph.glyph}\u26a0`}
                              </span>
                              {item.mediumGlyph === undefined ? null : (
                                <span aria-hidden="true" className="tl-glyph tl-media-glyph">
                                  {item.mediumGlyph}
                                </span>
                              )}
                              {bar === undefined ? null : <BarThumbs session={session} version={assetsVersion} bar={bar} canOpen={clickAllowed} onOpen={setLightbox} />}
                              <UserText value={item.label} lang={language} />
                              {badge === undefined ? null : (
                                <span
                                  aria-hidden="true"
                                  className={`tl-badge is-${badge.severity}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openFindingsFor(item);
                                  }}
                                >
                                  {SEVERITY_GLYPH[badge.severity]}
                                  {badge.count}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
                {ghostsDrawn.map((ghost) => (
                  <div
                    key={ghost.id}
                    className={`tl-ghost${ghost.suggestion ? ' is-suggestion' : ''}`}
                    aria-hidden="true"
                    data-row={ghost.rowId}
                    style={boxStyle(ghost.box.x, ghost.box.y, ghost.box.w, ghost.box.h)}
                  >
                    <span className="tl-pnum">{ghost.number}</span>
                  </div>
                ))}
                <div className="tl-drag-ghost" aria-hidden="true" hidden ref={dragGhost} data-testid="timeline-drag-ghost" />
              </div>
            </div>
          </div>
          <div className="tl-detail" role="group" aria-label={t`The focused scene`} data-testid="timeline-detail">
            {detailItem !== undefined ? (
              <>
                <p className="tl-detail-text">{accessibleText(detailItem.a11yLabel)}</p>
                <button type="button" className="button" onClick={() => onOpenDocument(detailItem.nodeId)}>
                  <Trans>Open scene</Trans>
                </button>
                {detailItem.findings.length > 0 ? (
                  <button type="button" className="button" onClick={() => openFindingsFor(detailItem)}>
                    <Trans>Open in Findings</Trans>
                  </button>
                ) : null}
                <TimelineMedia model={model} nodeId={detailItem.nodeId} language={language} onOpen={onOpenDocument} />
                <ScenePictures session={session} version={assetsVersion} pictures={pictures.of(detailItem.nodeId)} onOpen={setLightbox} />
              </>
            ) : detailBlock !== undefined ? (
              <>
                <p className="tl-detail-text">{accessibleText(detailBlock.label)}</p>
                <button type="button" className="button" onClick={() => zoomInto(detailBlock.nodeId)}>
                  <Trans>Zoom into this</Trans>
                </button>
              </>
            ) : (
              <p className="tl-detail-text muted">
                <Trans>Arrow keys move between scenes. Enter opens a scene, Space marks it, and F opens its findings. Alt and the arrow keys propose a new day.</Trans>
              </p>
            )}
            {detailItem === undefined && detailBlock === undefined ? (
              <TimelineMedia model={model} nodeId={undefined} language={language} onOpen={onOpenDocument} />
            ) : null}
            <SceneChanges
              session={session}
              proposals={proposals}
              model={model}
              lens={lens}
              labels={labels}
              language={language}
              item={detailItem}
              marked={selected}
              announce={announce}
              request={placeRequest}
            />
          </div>
            <TimelineShelf
              model={model}
              labels={labels}
              language={language}
              selected={selected}
              activeDocId={activeDocId}
              focusKey={focused}
              onFocusKey={(key) => {
                setFocusKey(key);
              }}
              onToggle={(nodeId) => {
                if (clickAllowed()) toggle(nodeId);
              }}
              onOpen={onOpenDocument}
              onOpenAgenda={() => setView((state) => ({ ...state, agenda: true }))}
              onGrab={onShelfPointerDown}
            />
        </>
      )}
      <TimelineTray
        session={session}
        proposals={proposals}
        model={model}
        lens={lens}
        labels={labels}
        language={language}
        povName={povName}
        offscreen={agenda ? 0 : offscreenRows.length}
        onShowOffscreen={showOffscreen}
        announce={announce}
        onApplied={() => setSelected(new Set())}
      />
      {lightbox === null ? null : <PictureLightbox session={session} version={assetsVersion} opened={lightbox} onClose={closeLightbox} />}
      <span hidden data-budget={DOM_BUDGET} />
    </section>
  );
}
