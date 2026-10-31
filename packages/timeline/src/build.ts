/**
 * `buildTimeline` — the pure layout of [timeline.md §3](../../../docs/architecture/timeline.md).
 *
 * A project and its `coherence.json` go in; a `TimelineModel` in canonical logical order comes out. Nothing is inferred:
 * a day, a part, a lane or an `after` link is read from a declaration, never from a title, the binder position or the
 * text. A scene with no `dayOffset` stays undated and goes to the shelf.
 */

import { isDayOffset } from '@caotang/bus';
import {
  effectiveStoryParts,
  entriesOf,
  isArchived,
  resolveMentions,
  windowOf,
  type CoherenceFile,
  type SceneMeta,
} from '@caotang/coherence';
import { directionOf } from '@caotang/i18n';
import type { CodexEntry, ProjectState, TreeNode } from '@caotang/store';

import { buildStoryAxis, pxPerDayOf, segmentIndexOf, semanticLevelOf, type AxisScene } from './axis.js';
import { dayLens } from './day-lens.js';
import { ENGLISH_LABELS } from './labels.js';
import { adapterFor, attachmentsOf, createMediaContext, folderStripsOf, unitOf, type StripDraft } from './media.js';
import {
  MODE_LANE_ORDER,
  MODE_RENDER,
  glyphOf,
  knownMode,
} from './mode-render.js';
import {
  MEDIUM_ORDER,
  PART_ORDER,
  PART_RANK,
  PRESENCE_DEFAULT_LIMIT,
  WORDS_PER_UNIT,
  type AggregateBlock,
  type AppearanceSpan,
  type AxisModel,
  type Connector,
  type FindingRef,
  type FolderBand,
  type Lane,
  type LaneKey,
  type MeasureUnit,
  type MediaLink,
  type Medium,
  type PartRun,
  type PartZone,
  type StoryPart,
  type TimelineItem,
  type TimelineMode,
  type TimelineModel,
  type TimelineOptions,
} from './model.js';
import { packRows } from './packing.js';
import { buildShelf, findCycles } from './shelf.js';

const MANUSCRIPT_ROOT = 'manuscript';
const PAIR_CHECKS: ReadonlySet<string> = new Set(['timeline.order-drift', 'timeline.overlap', 'timeline.gap', 'timeline.relation']);
const NONE_ORDER = Number.MAX_SAFE_INTEGER;

interface Scene {
  node: TreeNode;
  id: string;
  parentId: string | null;
  /** Folder ids above the scene, nearest last. */
  ancestors: readonly string[];
  part: StoryPart;
  meta: SceneMeta;
  readingIndex: number;
  day?: number;
  end?: number;
  duration?: number;
  mode: TimelineMode;
  medium: Medium;
  label: string;
  measure: number;
  unit: MeasureUnit;
  /** What the other media hang on the scene (§9.3): a glyph, declared links, and strips under it. */
  glyph: string;
  links: MediaLink[];
  strips: StripDraft[];
  findings: FindingRef[];
}

/** What a strip inherits from its host: the day, part, mode, lane and slot (§9.3). */
type StripBase = Pick<TimelineItem, 'key' | 'hostId' | 'nodeId' | 'part' | 'lane' | 'row' | 'readingIndex' | 'mode' | 'glyph' | 'folderId'> &
  Pick<Partial<TimelineItem>, 'start' | 'end' | 'dayOffset' | 'durationDays' | 'segment' | 'partNote' | 'partOverride'>;

interface Member {
  id: string;
  key: LaneKey;
  label: string;
  value?: string;
  order: number;
  inferred: boolean;
}

function sortedChildren(tree: readonly TreeNode[]): Map<string, TreeNode[]> {
  const children = new Map<string, TreeNode[]>();
  for (const node of tree) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list === undefined) children.set(node.parentId, [node]);
    else list.push(node);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return children;
}

function uniq(values: readonly string[] | undefined): string[] {
  return values === undefined ? [] : [...new Set(values)];
}

export function buildTimeline(state: ProjectState, file: CoherenceFile, opts: TimelineOptions): TimelineModel {
  const axisKind = opts.axis;
  const groupBy = opts.groupBy ?? 'none';
  const zoom = opts.zoom ?? (axisKind === 'narrative' ? 'scene' : 'day');
  const lens = opts.lens ?? dayLens;
  const labels = opts.labels ?? ENGLISH_LABELS;
  const compress = opts.compressGaps ?? true;
  const level = semanticLevelOf(zoom);
  const tree = state.manifest.tree;
  const nodes = new Map<string, TreeNode>();
  for (const node of tree) nodes.set(node.id, node);
  const entries = entriesOf(state);
  const entryById = new Map<string, CodexEntry>();
  entries.forEach((entry) => entryById.set(entry.id, entry));
  const codexIndex = new Map<string, number>();
  entries.forEach((entry, at) => codexIndex.set(entry.id, at));

  const parts = effectiveStoryParts(tree, file.sceneMeta);
  const children = sortedChildren(tree);
  const media = createMediaContext({ tree, sceneMeta: file.sceneMeta, nodes, children });

  // Open findings by the scene they cite, with the pair, gap and overlap facts the model draws.
  const findingsByDoc = new Map<string, FindingRef[]>();
  const gapFindings = new Map<string, string>();
  const pairFindings: { id: string; checkId: string; severity: FindingRef['severity']; a: string; b: string }[] = [];
  const overlapPartners = new Map<string, string[]>();
  if ((opts.findings ?? 'open') === 'open') {
    for (const finding of file.findings) {
      if (finding.status !== 'open') continue;
      const docs = uniq(finding.evidence.map((passage) => passage.docId));
      const ref: FindingRef = { id: finding.id, checkId: finding.checkId, severity: finding.severity, type: finding.type, groupKey: finding.factGroup };
      for (const doc of docs) {
        const list = findingsByDoc.get(doc);
        if (list === undefined) findingsByDoc.set(doc, [ref]);
        else list.push(ref);
      }
      if (PAIR_CHECKS.has(finding.checkId) && docs.length >= 2) {
        pairFindings.push({ id: finding.id, checkId: finding.checkId, severity: finding.severity, a: docs[0] as string, b: docs[1] as string });
        if (finding.checkId === 'timeline.gap') {
          const later = finding.evidence[1]?.docId;
          if (later !== undefined && !gapFindings.has(later)) gapFindings.set(later, finding.id);
        }
        if (finding.checkId === 'timeline.overlap') {
          (overlapPartners.get(docs[0] as string) ?? overlapPartners.set(docs[0] as string, []).get(docs[0] as string))?.push(docs[1] as string);
          (overlapPartners.get(docs[1] as string) ?? overlapPartners.set(docs[1] as string, []).get(docs[1] as string))?.push(docs[0] as string);
        }
      }
    }
  }

  // The scenes: manuscript documents in binder order, narrowed to the scope, as the snapshot reads them.
  const scenes: Scene[] = [];
  const folderNodes: TreeNode[] = [];
  /** Folders in scope that may carry strips of their own, as a comic book written from its pages does. */
  const hostFolders: TreeNode[] = [];
  const scope = opts.scope;
  const inScope = (node: TreeNode, ancestors: readonly string[]): boolean =>
    scope === undefined || scope === MANUSCRIPT_ROOT || node.id === scope || ancestors.includes(scope);

  const visit = (node: TreeNode, ancestors: readonly string[], inManuscript: boolean): void => {
    if (node.type === 'document') {
      if (!inManuscript || isArchived(node) || !inScope(node, ancestors)) return;
      const meta = file.sceneMeta[node.id] ?? {};
      const day = isDayOffset(meta.dayOffset) ? meta.dayOffset : undefined;
      const duration = typeof meta.durationDays === 'number' && Number.isInteger(meta.durationDays) && meta.durationDays >= 0 ? meta.durationDays : undefined;
      const adapter = adapterFor(node);
      const attached = attachmentsOf(node, state, media);
      const scene: Scene = {
        node,
        id: node.id,
        parentId: node.parentId,
        ancestors,
        part: parts.get(node.id) ?? 'main',
        meta,
        readingIndex: scenes.length,
        mode: knownMode(meta.timelineMode),
        medium: adapter.medium,
        label: adapter.label(node, state),
        measure: adapter.measure(node, state),
        unit: unitOf(adapter, node, state),
        glyph: attached.glyph,
        links: attached.links,
        strips: attached.strips,
        findings: findingsByDoc.get(node.id) ?? [],
      };
      if (day !== undefined) {
        scene.day = day;
        scene.end = windowOf(day, duration).end;
      }
      if (duration !== undefined) scene.duration = duration;
      scenes.push(scene);
      return;
    }
    const member = inManuscript || node.id === MANUSCRIPT_ROOT;
    // The manuscript root is where the book starts, not a folder in it: no band, and not an act or a chapter.
    const isRoot = node.id === MANUSCRIPT_ROOT;
    if (node.type === 'folder' && member && !isRoot) {
      folderNodes.push(node);
      if (inScope(node, ancestors)) hostFolders.push(node);
    }
    const inner = node.type === 'folder' && !isRoot ? [...ancestors, node.id] : ancestors;
    for (const child of children.get(node.id) ?? []) visit(child, inner, member);
  };
  for (const top of tree) if (top.parentId === null) visit(top, [], false);

  const byId = new Map<string, Scene>();
  for (const scene of scenes) byId.set(scene.id, scene);

  // Zones need the main story's extent first: a prologue or epilogue dated inside it carries a note.
  let mainStart: number | undefined;
  let mainEnd: number | undefined;
  for (const scene of scenes) {
    if (scene.part !== 'main' || scene.day === undefined || scene.end === undefined) continue;
    if (mainStart === undefined || scene.day < mainStart) mainStart = scene.day;
    if (mainEnd === undefined || scene.end > mainEnd) mainEnd = scene.end;
  }

  const afterEdges = new Map<string, string[]>();
  for (const scene of scenes) {
    const targets = uniq(scene.meta.after).filter((target) => byId.has(target));
    if (targets.length > 0) afterEdges.set(scene.id, targets);
  }
  const cyclic = findCycles(afterEdges);

  // Detected mentions are opt-in, and only counted by a detector or cache the caller supplied.
  let hits: ReadonlyMap<string, ReadonlyMap<string, number>> | undefined;
  if (opts.includeDetectedMentions === true && (opts.detector !== undefined || opts.mentions !== undefined) && (groupBy === 'character' || groupBy === 'location')) {
    hits = resolveMentions(
      scenes.map((scene) => ({ docId: scene.id, body: state.documents.get(scene.id)?.body ?? '', revision: state.documents.get(scene.id)?.revision ?? 0, ...(scene.node.kind !== undefined ? { kind: scene.node.kind } : {}) })),
      entries,
      opts.mentions,
      opts.detector,
    ).hits;
  }
  const entriesOfType = (type: string): CodexEntry[] => entries.filter((entry) => entry.type === type);
  const characterEntries = entriesOfType('character');
  const locationEntries = entriesOfType('location');
  const placesOf = new Map<string, CodexEntry[]>();
  for (const entry of locationEntries) {
    for (const attached of entry.attachments) {
      const list = placesOf.get(attached);
      if (list === undefined) placesOf.set(attached, [entry]);
      else list.push(entry);
    }
  }

  const nameOf = (id: string): string => entryById.get(id)?.name ?? id;
  const orderOf = (id: string, fallback: number): number => codexIndex.get(id) ?? entries.length + fallback;
  let appearance = 0;

  const membersOf = (scene: Scene): Member[] => {
    switch (groupBy) {
      case 'none':
        return [{ id: 'all', key: 'none', label: labels.lane.all, order: 0, inferred: false }];
      case 'pov': {
        const pov = scene.meta.pov;
        if (pov === undefined || pov === '') return [{ id: 'pov:none', key: 'pov', label: labels.lane.noPov, order: NONE_ORDER, inferred: false }];
        return [{ id: `pov:${pov}`, key: 'pov', label: nameOf(pov), value: pov, order: appearance++, inferred: false }];
      }
      case 'character': {
        const declared = uniq(scene.meta.expectedPresent);
        const out: Member[] = declared.map((id) => ({ id: `character:${id}`, key: 'character', label: nameOf(id), value: id, order: orderOf(id, appearance++), inferred: false }));
        const seen = hits?.get(scene.id);
        if (seen !== undefined) {
          for (const entry of characterEntries) {
            if ((seen.get(entry.id) ?? 0) > 0 && !declared.includes(entry.id)) {
              out.push({ id: `character:${entry.id}`, key: 'character', label: entry.name, value: entry.id, order: orderOf(entry.id, 0), inferred: true });
            }
          }
        }
        return out.length > 0 ? out : [{ id: 'character:none', key: 'character', label: labels.lane.noCharacter, order: NONE_ORDER, inferred: false }];
      }
      case 'mode': {
        const group = MODE_RENDER[scene.mode].laneGroup;
        return [{ id: `mode:${group}`, key: 'mode', label: labels.lane.modeGroup(group), value: group, order: MODE_LANE_ORDER.indexOf(group), inferred: false }];
      }
      case 'folder': {
        const parent = scene.parentId === null ? undefined : nodes.get(scene.parentId);
        const id = scene.parentId ?? MANUSCRIPT_ROOT;
        return [{ id: `folder:${id}`, key: 'folder', label: parent?.title ?? id, value: id, order: appearance++, inferred: false }];
      }
      case 'location': {
        const declared = placesOf.get(scene.id) ?? [];
        const out: Member[] = declared.map((entry) => ({ id: `location:${entry.id}`, key: 'location', label: entry.name, value: entry.id, order: orderOf(entry.id, 0), inferred: false }));
        const seen = hits?.get(scene.id);
        if (seen !== undefined) {
          for (const entry of locationEntries) {
            if ((seen.get(entry.id) ?? 0) > 0 && !declared.includes(entry)) {
              out.push({ id: `location:${entry.id}`, key: 'location', label: entry.name, value: entry.id, order: orderOf(entry.id, 0), inferred: true });
            }
          }
        }
        return out.length > 0 ? out : [{ id: 'location:none', key: 'location', label: labels.lane.noLocation, order: NONE_ORDER, inferred: false }];
      }
      case 'thread': {
        const handles = uniq((scene.meta.threads ?? []).map((thread) => thread.id));
        if (handles.length === 0) return [{ id: 'thread:none', key: 'thread', label: labels.lane.noThread, order: NONE_ORDER, inferred: false }];
        return handles.map((handle) => ({ id: `thread:${handle}`, key: 'thread' as const, label: handle, value: handle, order: appearance++, inferred: false }));
      }
    }
  };

  const laneInfo = new Map<string, { member: Member; count: number; seq: number }>();
  const itemsOf: TimelineItem[] = [];
  /** The first item of each scene: the one its strips hang under when a scene sits in several lanes. */
  const hostOf = new Map<string, TimelineItem>();
  const frames = scenes.filter((scene) => scene.mode === 'frame');
  const firstFrame = frames[0];
  const lastFrame = frames[frames.length - 1];

  for (const scene of scenes) {
    const scheduled = scene.day !== undefined;
    const parentPart = scene.parentId === null ? undefined : parts.get(scene.parentId);
    const partOverride = scene.meta.storyPart === 'main' && parentPart !== undefined && parentPart !== 'main';
    let partNote: 'dated-inside-main' | undefined;
    if (scene.day !== undefined) {
      if (scene.part === 'prologue' && mainStart !== undefined && scene.day >= mainStart) partNote = 'dated-inside-main';
      else if (scene.part === 'epilogue' && mainEnd !== undefined && scene.day < mainEnd) partNote = 'dated-inside-main';
    }
    const parent = scene.parentId === null ? undefined : nodes.get(scene.parentId);
    const pov = scene.meta.pov;
    const partners = overlapPartners.get(scene.id);
    const dayLabel = scene.day === undefined ? undefined : lens.label(scene.day, 'long');
    const a11yLabel = labels.itemName({
      title: scene.label,
      part: scene.part,
      partOverride,
      ...(dayLabel !== undefined ? { dayLabel } : {}),
      ...(scene.day !== undefined && scene.duration !== undefined && scene.duration > 0 ? { endLabel: lens.label(scene.day + scene.duration, 'long') } : {}),
      ...(scene.duration !== undefined ? { durationDays: scene.duration } : {}),
      mode: scene.mode,
      ...(pov !== undefined && pov !== '' ? { povName: nameOf(pov) } : {}),
      ...(parent?.type === 'folder' && !partOverride ? { folderTitle: parent.title } : {}),
      overlaps: (partners ?? []).map((id) => byId.get(id)?.label ?? id),
      openFindings: scene.findings.length,
      partNote: partNote !== undefined,
    });
    const render = MODE_RENDER[scene.mode];
    let bracket: TimelineItem['bracket'];
    if (render.bracket && firstFrame !== undefined && lastFrame !== undefined) {
      if (scene === firstFrame && scene === lastFrame) bracket = 'both';
      else if (scene === firstFrame) bracket = 'open';
      else if (scene === lastFrame) bracket = 'close';
    }

    for (const member of membersOf(scene)) {
      const known = laneInfo.get(member.id);
      if (known === undefined) laneInfo.set(member.id, { member, count: 1, seq: laneInfo.size });
      else known.count += 1;
      const item: TimelineItem = {
        key: `${scene.id}@${member.id}`,
        nodeId: scene.id,
        kind: 'scene',
        medium: scene.medium,
        part: scene.part,
        lane: member.id,
        row: 0,
        readingIndex: scene.readingIndex,
        measure: scene.measure,
        measureUnit: scene.unit,
        mode: scene.mode,
        glyph: glyphOf(scene.mode, scheduled),
        findings: scene.findings,
        label: scene.label,
        a11yLabel,
        title: scene.node.title,
        folderId: scene.parentId,
      };
      if (scene.day !== undefined && scene.end !== undefined) {
        item.start = scene.day;
        item.end = scene.end;
        item.dayOffset = scene.day;
        if (render.tether) item.tetherDay = scene.day;
      }
      if (scene.duration !== undefined) item.durationDays = scene.duration;
      if (partNote !== undefined) item.partNote = partNote;
      if (partOverride) item.partOverride = true;
      if (member.inferred) item.inferred = true;
      if (cyclic.has(scene.id)) item.inCycle = true;
      if (bracket !== undefined) item.bracket = bracket;
      if (pov !== undefined && pov !== '') item.pov = pov;
      if (scene.glyph !== '') item.mediumGlyph = scene.glyph;
      if (scene.links.length > 0) item.links = scene.links;
      if (!hostOf.has(scene.id)) hostOf.set(scene.id, item);
      itemsOf.push(item);
    }
  }

  const laneList = [...laneInfo.values()].sort((a, b) => a.member.order - b.member.order || a.seq - b.seq);
  const lanes: Lane[] = laneList.map(({ member, count }) => ({
    id: member.id,
    key: member.key,
    label: member.label,
    ...(member.value !== undefined ? { value: member.value } : {}),
    rows: 1,
    count,
  }));
  const laneIndex = new Map<string, number>();
  lanes.forEach((lane, at) => laneIndex.set(lane.id, at));
  const laneById = new Map<string, Lane>();
  for (const lane of lanes) laneById.set(lane.id, lane);

  // Same-day packing, per lane and per part zone: a start-sorted sweep with an interval-end min-heap.
  const simultaneous: TimelineModel['simultaneous'] = [];
  if (axisKind !== 'narrative') {
    const groups = new Map<string, TimelineItem[]>();
    for (const item of itemsOf) {
      if (item.start === undefined) continue;
      const key = `${item.lane}|${item.part}`;
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [item]);
      else list.push(item);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a.start as number) - (b.start as number) || a.readingIndex - b.readingIndex);
      const packed = packRows(list as { start: number; end: number }[]);
      const lane = laneById.get((list[0] as TimelineItem).lane) as Lane;
      if (packed.rowCount > lane.rows) lane.rows = packed.rowCount;
      list.forEach((item, at) => {
        item.row = packed.rows[at] as number;
      });
    }
    const stacks = new Map<string, TimelineItem[]>();
    for (const item of itemsOf) {
      if (item.start === undefined || !MODE_RENDER[item.mode].stacked) continue;
      const id = `simultaneous:${item.lane}:${item.part}:${item.start}`;
      const list = stacks.get(id);
      if (list === undefined) stacks.set(id, [item]);
      else list.push(item);
    }
    for (const [id, list] of stacks) {
      if (list.length < 2) continue;
      for (const item of list) item.group = id;
      const head = list[0] as TimelineItem;
      simultaneous.push({ id, part: head.part, day: head.start as number, keys: list.map((item) => item.key) });
    }
  }

  // The canonical order: part, dated before undated, day, reading index, lane.
  itemsOf.sort(
    (a, b) =>
      PART_RANK[a.part] - PART_RANK[b.part] ||
      (a.start === undefined ? 1 : 0) - (b.start === undefined ? 1 : 0) ||
      (a.start ?? 0) - (b.start ?? 0) ||
      a.readingIndex - b.readingIndex ||
      (laneIndex.get(a.lane) as number) - (laneIndex.get(b.lane) as number),
  );

  // Axis.
  const pxPerDay = pxPerDayOf(zoom);
  const scheduled = scenes.filter((scene) => scene.day !== undefined);
  // One scale for the slots: a scope that counts words and pages together is read in words-equivalent, and a scope that
  // counts one unit is left as it is.
  const units = new Set(scenes.map((scene) => scene.unit));
  const mixedUnits = units.size > 1;
  const measures = scenes.map((scene) => (mixedUnits ? scene.measure * WORDS_PER_UNIT[scene.unit] : scene.measure));
  const measureUnit: AxisModel['measureUnit'] = mixedUnits ? 'words-equivalent' : scenes.length === 0 ? undefined : (scenes[0] as Scene).unit;
  const measured = measureUnit === undefined ? {} : { measureUnit };
  let axis: AxisModel;
  if (axisKind === 'narrative') {
    axis = { kind: 'narrative', segments: [], breaks: [], folds: [], ticks: [], measures, ...measured, pxPerDay };
  } else {
    const axisScenes: AxisScene[] = scheduled.map((scene) => ({
      nodeId: scene.id,
      part: scene.part,
      start: scene.day as number,
      end: scene.end as number,
      mode: scene.mode,
      readingIndex: scene.readingIndex,
    }));
    const built = buildStoryAxis({ scenes: axisScenes, compress, lens, labels, pxPerDay, gapFindings });
    axis = { kind: axisKind, ...built, measures, ...measured, pxPerDay };
    for (const item of itemsOf) {
      if (item.start !== undefined) {
        const at = segmentIndexOf(axis.segments, item.part, item.start);
        if (at >= 0) item.segment = at;
      }
    }
  }

  // Strips (§9.3, §9.4). A strip under a scene takes that scene's day, part, mode, lane and slot, so it can never disagree
  // with its host; a strip with no scene (a comic book written from its pages) takes the book folder's own span and part,
  // and has no lane and no reading slot, because nothing declares either. They stay out of `items`.
  const strips: TimelineItem[] = [];
  const stripOf = (draft: StripDraft, base: StripBase): TimelineItem => {
    const strip: TimelineItem = {
      ...base,
      findings: [],
      key: `${base.key}:${draft.kind}`,
      kind: draft.kind,
      medium: draft.medium,
      measure: draft.cells.length,
      measureUnit: draft.kind === 'shot-strip' ? 'shots' : 'pages',
      label: draft.label,
      a11yLabel: draft.label,
      title: draft.label,
      mediumGlyph: draft.glyph,
      sourceId: draft.sourceId,
      cells: draft.cells,
      open: draft.open,
    };
    if (draft.runtimeSec !== undefined) strip.runtimeSec = draft.runtimeSec;
    if (draft.unmeasured !== undefined) strip.unmeasured = draft.unmeasured;
    if (draft.direction !== undefined) strip.direction = draft.direction;
    if (draft.links !== undefined && draft.links.length > 0) strip.links = draft.links;
    return strip;
  };
  for (const scene of scenes) {
    const host = hostOf.get(scene.id);
    if (host === undefined) continue;
    for (const draft of scene.strips) {
      const base: StripBase = {
        key: host.key,
        hostId: host.nodeId,
        nodeId: host.nodeId,
        part: host.part,
        lane: host.lane,
        row: host.row,
        readingIndex: host.readingIndex,
        mode: host.mode,
        glyph: host.glyph,
        folderId: host.folderId,
      };
      if (host.start !== undefined) base.start = host.start;
      if (host.end !== undefined) base.end = host.end;
      if (host.dayOffset !== undefined) base.dayOffset = host.dayOffset;
      if (host.durationDays !== undefined) base.durationDays = host.durationDays;
      if (host.segment !== undefined) base.segment = host.segment;
      if (host.partNote !== undefined) base.partNote = host.partNote;
      if (host.partOverride !== undefined) base.partOverride = host.partOverride;
      strips.push(stripOf(draft, base));
    }
  }
  for (const folder of hostFolders) {
    for (const draft of folderStripsOf(folder, state, media)) {
      const meta = file.sceneMeta[folder.id] ?? {};
      const day = isDayOffset(meta.dayOffset) ? meta.dayOffset : undefined;
      const duration = typeof meta.durationDays === 'number' && Number.isInteger(meta.durationDays) && meta.durationDays >= 0 ? meta.durationDays : undefined;
      const base: StripBase = {
        key: `${folder.id}@`,
        nodeId: folder.id,
        hostId: folder.id,
        part: parts.get(folder.id) ?? 'main',
        lane: '',
        row: 0,
        readingIndex: -1,
        mode: 'linear',
        glyph: glyphOf('linear', day !== undefined),
        folderId: folder.parentId,
      };
      if (day !== undefined) {
        base.start = day;
        base.end = windowOf(day, duration).end;
        base.dayOffset = day;
      }
      if (duration !== undefined) base.durationDays = duration;
      strips.push(stripOf(draft, base));
    }
  }
  strips.sort(
    (a, b) =>
      PART_RANK[a.part] - PART_RANK[b.part] ||
      (a.start === undefined ? 1 : 0) - (b.start === undefined ? 1 : 0) ||
      (a.start ?? 0) - (b.start ?? 0) ||
      // A strip with no scene has no reading slot (-1) and follows the strips that do.
      (a.readingIndex < 0 ? Number.MAX_SAFE_INTEGER : a.readingIndex) - (b.readingIndex < 0 ? Number.MAX_SAFE_INTEGER : b.readingIndex) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  // Zones.
  const zones: PartZone[] = [];
  for (const part of PART_ORDER) {
    const mine = scenes.filter((scene) => scene.part === part);
    if (mine.length === 0) continue;
    const zone: PartZone = {
      part,
      firstReading: mine[0]?.readingIndex as number,
      lastReading: mine[mine.length - 1]?.readingIndex as number,
      count: mine.length,
    };
    for (const scene of mine) {
      if (scene.day === undefined || scene.end === undefined) continue;
      if (zone.startDay === undefined || scene.day < zone.startDay) zone.startDay = scene.day;
      if (zone.endDay === undefined || scene.end > zone.endDay) zone.endDay = scene.end;
    }
    zones.push(zone);
  }

  // Folder bands and part runs.
  const bandAt = new Map<string, FolderBand>();
  for (const scene of scenes) {
    scene.ancestors.forEach((folderId, depth) => {
      const band = bandAt.get(folderId);
      if (band === undefined) {
        const folder = nodes.get(folderId) as TreeNode;
        const meta = file.sceneMeta[folderId] ?? {};
        const start = isDayOffset(meta.dayOffset) ? meta.dayOffset : undefined;
        bandAt.set(folderId, {
          nodeId: folderId,
          title: folder.title,
          parentId: folder.parentId,
          depth,
          part: parts.get(folderId) ?? 'main',
          firstReading: scene.readingIndex,
          lastReading: scene.readingIndex,
          count: 1,
          ...(start !== undefined ? { start, end: windowOf(start, meta.durationDays).end } : {}),
        });
      } else {
        band.lastReading = scene.readingIndex;
        band.count += 1;
      }
    });
  }
  const bands = folderNodes.map((folder) => bandAt.get(folder.id)).filter((band): band is FolderBand => band !== undefined);

  const partRuns: PartRun[] = [];
  for (const scene of scenes) {
    const run = partRuns[partRuns.length - 1];
    if (scene.part === 'main') continue;
    if (run !== undefined && run.part === scene.part && run.lastReading === scene.readingIndex - 1) {
      run.lastReading = scene.readingIndex;
      run.count += 1;
    } else {
      partRuns.push({ part: scene.part, firstReading: scene.readingIndex, lastReading: scene.readingIndex, count: 1 });
    }
  }

  // Semantic zoom: chapters are the nearest folder, acts the top-level folder under the manuscript root.
  const blocks: AggregateBlock[] = [];
  if (level !== 'scene') {
    const blockAt = new Map<string, AggregateBlock & { seen: Set<string> }>();
    for (const scene of scenes) {
      const folderId =
        level === 'act' ? (scene.ancestors[0] ?? scene.parentId ?? MANUSCRIPT_ROOT) : (scene.parentId ?? MANUSCRIPT_ROOT);
      const id = `block:${level}:${scene.part}:${folderId}`;
      let block = blockAt.get(id);
      if (block === undefined) {
        block = {
          id,
          nodeId: folderId,
          label: nodes.get(folderId)?.title ?? folderId,
          part: scene.part,
          level,
          count: 0,
          firstReading: scene.readingIndex,
          lastReading: scene.readingIndex,
          openFindings: 0,
          seen: new Set<string>(),
        };
        blockAt.set(id, block);
      }
      block.count += 1;
      block.lastReading = scene.readingIndex;
      for (const finding of scene.findings) block.seen.add(finding.id);
      if (scene.day !== undefined && scene.end !== undefined) {
        if (block.start === undefined || scene.day < block.start) block.start = scene.day;
        if (block.end === undefined || scene.end > block.end) block.end = scene.end;
      }
    }
    for (const block of blockAt.values()) {
      const { seen, ...rest } = block;
      blocks.push({ ...rest, openFindings: seen.size });
    }
    blocks.sort((a, b) => PART_RANK[a.part] - PART_RANK[b.part] || a.firstReading - b.firstReading);
  }

  // Connectors.
  const keysOf = new Map<string, TimelineItem[]>();
  for (const item of itemsOf) {
    const list = keysOf.get(item.nodeId);
    if (list === undefined) keysOf.set(item.nodeId, [item]);
    else list.push(item);
  }
  const itemFor = (nodeId: string, near: TimelineItem): TimelineItem | undefined => {
    const list = keysOf.get(nodeId);
    return list?.find((item) => item.lane === near.lane) ?? list?.[0];
  };
  const primary = (nodeId: string): TimelineItem | undefined => keysOf.get(nodeId)?.[0];

  const connectors: Connector[] = [];
  for (const [laterId, targets] of afterEdges) {
    const later = byId.get(laterId) as Scene;
    for (const earlierId of targets) {
      const earlier = byId.get(earlierId) as Scene;
      const to = primary(laterId);
      const from = to === undefined ? undefined : itemFor(earlierId, to);
      if (to === undefined || from === undefined) continue;
      const violation = later.day !== undefined && earlier.day !== undefined && later.day < earlier.day + (earlier.duration ?? 0);
      const cycle = cyclic.has(laterId) && cyclic.get(laterId) === cyclic.get(earlierId);
      connectors.push({
        id: `after:${earlierId}>${laterId}`,
        kind: 'after',
        from: from.key,
        to: to.key,
        fromNode: earlierId,
        toNode: laterId,
        ...(violation ? { violation: true } : {}),
        ...(cycle ? { cycle: true } : {}),
      });
    }
  }
  for (const scene of scenes) {
    for (const thread of scene.meta.threads ?? []) {
      const payoff = byId.get(thread.payoff);
      const from = primary(scene.id);
      const to = payoff === undefined || from === undefined ? undefined : itemFor(payoff.id, from);
      if (from === undefined || to === undefined || payoff === undefined) continue;
      connectors.push({ id: `thread:${thread.id}:${scene.id}>${payoff.id}`, kind: 'thread', from: from.key, to: to.key, fromNode: scene.id, toNode: payoff.id, threadId: thread.id });
    }
  }
  if (axisKind === 'braid') {
    const first = scenes[0];
    for (const item of itemsOf) {
      if (item.start === undefined) continue;
      const render = MODE_RENDER[item.mode];
      connectors.push({
        id: `braid:${item.key}`,
        kind: 'braid',
        variant: 'slot',
        from: `slot:${item.nodeId}`,
        to: item.key,
        fromNode: item.nodeId,
        toNode: item.nodeId,
        ...(render.emphasiseConnector ? { emphasised: true } : {}),
      });
      if (render.linksToFirst && first !== undefined && first.id !== item.nodeId) {
        const target = itemFor(first.id, item);
        if (target !== undefined) {
          connectors.push({ id: `braid-return:${item.key}`, kind: 'braid', variant: 'return', from: item.key, to: target.key, fromNode: item.nodeId, toNode: first.id, emphasised: true });
        }
      }
    }
  }
  for (const pair of pairFindings) {
    const from = primary(pair.a);
    const to = from === undefined ? undefined : itemFor(pair.b, from);
    if (from === undefined || to === undefined) continue;
    connectors.push({ id: `finding:${pair.id}`, kind: 'finding', from: from.key, to: to.key, fromNode: pair.a, toNode: pair.b, checkId: pair.checkId, severity: pair.severity, findingId: pair.id });
  }

  // Derived appearance spans, from declared presence only, in story order.
  const storyOrder = [...scheduled].sort(
    (a, b) => PART_RANK[a.part] - PART_RANK[b.part] || (a.day as number) - (b.day as number) || a.readingIndex - b.readingIndex,
  );
  const spans = new Map<string, AppearanceSpan>();
  for (const scene of storyOrder) {
    for (const id of uniq(scene.meta.expectedPresent)) {
      const here = { part: scene.part, day: scene.day as number, nodeId: scene.id };
      const span = spans.get(id);
      if (span === undefined) spans.set(id, { characterId: id, name: nameOf(id), scenes: 1, first: here, last: here });
      else {
        span.scenes += 1;
        span.last = here;
      }
    }
  }
  const characters = new Set<string>();
  for (const scene of scenes) for (const id of uniq(scene.meta.expectedPresent)) characters.add(id);

  if (groupBy === 'character') {
    const byLane = new Map<string, TimelineItem[]>();
    for (const item of itemsOf) {
      if (item.start === undefined || item.inferred === true) continue;
      const list = byLane.get(item.lane);
      if (list === undefined) byLane.set(item.lane, [item]);
      else list.push(item);
    }
    for (const lane of lanes) {
      const list = byLane.get(lane.id);
      if (list === undefined || list.length < 2 || lane.value === undefined) continue;
      const path = axisKind === 'narrative' ? [...list].sort((a, b) => a.readingIndex - b.readingIndex) : list;
      connectors.push({
        id: `presence:${lane.id}`,
        kind: 'presence',
        from: (path[0] as TimelineItem).key,
        to: (path[path.length - 1] as TimelineItem).key,
        fromNode: (path[0] as TimelineItem).nodeId,
        toNode: (path[path.length - 1] as TimelineItem).nodeId,
        path: path.map((item) => item.key),
        characterId: lane.value,
      });
    }
  }

  // The shelf: undated scenes, sequenced by `after` where they have it.
  const datedEarliest = new Map<string, number>();
  for (const scene of scheduled) datedEarliest.set(scene.id, (scene.day as number) + (scene.duration ?? 0));
  const undated: TimelineItem[] = [];
  const seenUndated = new Set<string>();
  for (const item of itemsOf) {
    if (item.start !== undefined || seenUndated.has(item.nodeId)) continue;
    seenUndated.add(item.nodeId);
    undated.push(item);
  }
  undated.sort((a, b) => a.readingIndex - b.readingIndex);
  const afterAll = new Map<string, string[]>();
  for (const scene of scenes) afterAll.set(scene.id, uniq(scene.meta.after).filter((target) => byId.has(target)));
  const unscheduled = buildShelf({ undated, after: afterAll, datedEarliest, cyclic, lens, labels });

  const language = state.manifest.project.language;
  const direction = language === undefined || language === '' ? 'ltr' : directionOf(language);

  const present = new Set<Medium>();
  for (const scene of scenes) {
    present.add(scene.medium);
    for (const link of scene.links) if (link.medium === 'dialogue' && link.broken !== true) present.add('dialogue');
  }
  for (const strip of strips) present.add(strip.medium);

  return {
    axis,
    items: itemsOf,
    strips,
    lanes,
    zones,
    connectors,
    unscheduled,
    bands,
    partRuns,
    blocks,
    appearances: [...spans.values()],
    simultaneous,
    direction,
    options: { axis: axisKind, groupBy, zoom, level, ...(scope !== undefined ? { scope } : {}), compressGaps: compress },
    stats: {
      scenes: scenes.length,
      scheduled: scheduled.length,
      share: scenes.length === 0 ? 0 : scheduled.length / scenes.length,
      characters: characters.size,
      presenceDefaultOn: characters.size <= PRESENCE_DEFAULT_LIMIT,
      mediums: MEDIUM_ORDER.filter((medium) => present.has(medium)),
    },
  };
}

/** §3.3: the story axis when at least half the scenes have a day, the narrative axis otherwise. */
export function defaultAxisFor(stats: Pick<TimelineModel['stats'], 'share'>): 'story' | 'narrative' {
  return stats.share >= 0.5 ? 'story' : 'narrative';
}
