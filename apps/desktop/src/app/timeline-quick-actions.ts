/**
 * What a finding on the timeline offers as a quick action ([timeline.md §5.3](docs/architecture/timeline.md)). Each is a row for the
 * tray, never a write; the words are the component's, and this says which scene changes and how.
 */

import { isDayOffset } from '@caotang/bus';
import type { ProjectState } from '@caotang/store';
import type { TimelineItem, TimelineModel } from '@caotang/timeline';

import { declaredOf, placeOf, type MetaIntent, type MoveTarget } from './timeline-proposals.js';

export type QuickKind = 'time-skip' | 'epilogue' | 'prologue' | 'simultaneous' | 'flashback' | 'match-days' | 'relation-day';

export interface QuickAction {
  /** Stable for a finding and a kind, so a list keeps its keys. */
  readonly key: string;
  readonly kind: QuickKind;
  readonly findingId: string;
  /** The scene the action changes. */
  readonly nodeId: string;
  /** The scene the finding names beside it. */
  readonly otherId: string;
  /** A `meta` row's fields. */
  readonly intent?: MetaIntent;
  /** A `move` row's place. */
  readonly move?: MoveTarget;
}

const dayOf = (item: TimelineItem): number => item.dayOffset ?? item.start ?? 0;

/** The quick actions of the open findings on one scene. */
export function quickActions(state: ProjectState, model: TimelineModel, item: TimelineItem): QuickAction[] {
  const byNode = new Map<string, TimelineItem>();
  for (const candidate of model.items) if (!byNode.has(candidate.nodeId)) byNode.set(candidate.nodeId, candidate);
  const lastReading = model.items.reduce((most, candidate) => Math.max(most, candidate.readingIndex), 0);
  const out: QuickAction[] = [];
  const seen = new Set<string>();
  const add = (action: QuickAction): void => {
    if (seen.has(action.key)) return;
    seen.add(action.key);
    out.push(action);
  };
  for (const finding of item.findings) {
    const connector = model.connectors.find((candidate) => candidate.kind === 'finding' && candidate.findingId === finding.id);
    if (connector === undefined) continue;
    const a = byNode.get(connector.fromNode);
    const b = byNode.get(connector.toNode);
    if (a === undefined || b === undefined || a.nodeId === b.nodeId) continue;
    const [early, late] = dayOf(a) < dayOf(b) || (dayOf(a) === dayOf(b) && a.readingIndex <= b.readingIndex) ? [a, b] : [b, a];
    const key = (kind: QuickKind, nodeId: string): string => `${finding.id}:${kind}:${nodeId}`;
    switch (finding.checkId) {
      case 'timeline.gap': {
        add({ key: key('time-skip', late.nodeId), kind: 'time-skip', findingId: finding.id, nodeId: late.nodeId, otherId: early.nodeId, intent: { mode: 'time-skip' } });
        if (late.readingIndex === lastReading && late.part === 'main') add({ key: key('epilogue', late.nodeId), kind: 'epilogue', findingId: finding.id, nodeId: late.nodeId, otherId: early.nodeId, intent: { part: 'epilogue' } });
        else if (early.readingIndex === 0 && early.part === 'main') add({ key: key('prologue', early.nodeId), kind: 'prologue', findingId: finding.id, nodeId: early.nodeId, otherId: late.nodeId, intent: { part: 'prologue' } });
        break;
      }
      case 'timeline.overlap':
        add({ key: key('simultaneous', late.nodeId), kind: 'simultaneous', findingId: finding.id, nodeId: late.nodeId, otherId: early.nodeId, intent: { mode: 'simultaneous' } });
        break;
      case 'timeline.order-drift': {
        const [read, readLater] = a.readingIndex <= b.readingIndex ? [a, b] : [b, a];
        add({ key: key('flashback', readLater.nodeId), kind: 'flashback', findingId: finding.id, nodeId: readLater.nodeId, otherId: read.nodeId, intent: { mode: 'flashback' } });
        const place = placeOf(state.manifest.tree, read.nodeId);
        if (place !== undefined && place.predecessorId !== readLater.nodeId) add({ key: key('match-days', readLater.nodeId), kind: 'match-days', findingId: finding.id, nodeId: readLater.nodeId, otherId: read.nodeId, move: { parentId: place.parentId, anchorId: place.predecessorId } });
        break;
      }
      case 'timeline.relation': {
        const follows = declaredOf(state, a.nodeId).after?.includes(b.nodeId) === true;
        const follower = follows ? a : b;
        const followed = follows ? b : a;
        const day = dayOf(followed) + (followed.durationDays ?? 0);
        if (isDayOffset(day)) add({ key: key('relation-day', follower.nodeId), kind: 'relation-day', findingId: finding.id, nodeId: follower.nodeId, otherId: followed.nodeId, intent: { day } });
        break;
      }
      default:
        break;
    }
  }
  return out;
}
