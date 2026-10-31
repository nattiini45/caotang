/**
 * The unscheduled shelf ([timeline.md §3.7](../../../docs/architecture/timeline.md)) and the `after` graph it is built on.
 * Undated scenes stay undated here: nothing is given a day, and the shelf only orders and groups them.
 */

import type { CalendarLens } from './calendar.js';
import type { TimelineLabels } from './labels.js';
import { MinHeap } from './packing.js';
import type { Chain, ChainStep, StoryPart, TimelineItem } from './model.js';

/** Prologue and epilogue groups sit ahead of the main groups on the shelf (§3.4). */
const SHELF_RANK: Readonly<Record<StoryPart, number>> = { prologue: 0, epilogue: 1, main: 2 };

/**
 * Nodes on an `after` cycle, each with the number of its cycle: a strongly connected set of two or more, or a scene that
 * follows itself. Two nodes share a number exactly when one cycle holds both. Iterative Tarjan.
 */
export function findCycles(edges: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Map<string, number>();
  let counter = 0;
  let cycles = 0;

  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; next: number };
      const targets = edges.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next] as string;
        frame.next += 1;
        if (target === frame.node && !cyclic.has(target)) cyclic.set(target, cycles++);
        if (!edges.has(target)) continue;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(target) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node) as number, low.get(frame.node) as number));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        if (component.length > 1) {
          const number = cycles++;
          for (const member of component) cyclic.set(member, number);
        }
      }
    }
  }
  return cyclic;
}

export interface ShelfInput {
  /** The undated scenes' primary items, in reading order. */
  undated: readonly TimelineItem[];
  /** Every scene's `after` targets that are scenes in the model. */
  after: ReadonlyMap<string, readonly string[]>;
  /** The earliest day each dated scene lets a follower start: its day plus its duration. */
  datedEarliest: ReadonlyMap<string, number>;
  cyclic: ReadonlyMap<string, number>;
  lens: CalendarLens;
  labels: TimelineLabels;
}

export function buildShelf(input: ShelfInput): { sequenced: Chain[]; loose: TimelineItem[] } {
  const { undated, after, datedEarliest, cyclic, lens, labels } = input;
  const byNode = new Map<string, TimelineItem>();
  for (const item of undated) byNode.set(item.nodeId, item);

  // Undated-only edges, as predecessors (what each scene must follow) and followers (who must follow it).
  const predecessors = new Map<string, string[]>();
  const followers = new Map<string, string[]>();
  const anchors = new Map<string, { nodeId: string; day: number }>();
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      const up = parent.get(root) as string;
      parent.set(root, parent.get(up) as string);
      root = up;
    }
    return root;
  };
  for (const item of undated) parent.set(item.nodeId, item.nodeId);

  for (const item of undated) {
    for (const target of after.get(item.nodeId) ?? []) {
      if (byNode.has(target)) {
        (predecessors.get(item.nodeId) ?? predecessors.set(item.nodeId, []).get(item.nodeId))?.push(target);
        (followers.get(target) ?? followers.set(target, []).get(target))?.push(item.nodeId);
        parent.set(find(item.nodeId), find(target));
      } else {
        const day = datedEarliest.get(target);
        const held = anchors.get(item.nodeId);
        if (day !== undefined && (held === undefined || day > held.day)) anchors.set(item.nodeId, { nodeId: target, day });
      }
    }
  }

  const components = new Map<string, TimelineItem[]>();
  for (const item of undated) {
    const root = find(item.nodeId);
    (components.get(root) ?? components.set(root, []).get(root))?.push(item);
  }

  const sequenced: Chain[] = [];
  const loose: TimelineItem[] = [];
  for (const members of components.values()) {
    const first = members[0] as TimelineItem;
    const chained =
      members.length > 1 || cyclic.has(first.nodeId) || anchors.has(first.nodeId) || (predecessors.get(first.nodeId)?.length ?? 0) > 0;
    if (!chained) {
      loose.push(first);
      continue;
    }
    const waiting = new Map<string, number>();
    for (const member of members) waiting.set(member.nodeId, new Set(predecessors.get(member.nodeId)).size);
    const ready = new MinHeap<TimelineItem>((a, b) => a.readingIndex < b.readingIndex);
    for (const member of members) if (waiting.get(member.nodeId) === 0) ready.push(member);

    const ordered: TimelineItem[] = [];
    const placed = new Set<string>();
    for (let next = ready.pop(); next !== undefined; next = ready.pop()) {
      ordered.push(next);
      placed.add(next.nodeId);
      for (const follower of new Set(followers.get(next.nodeId))) {
        const left = (waiting.get(follower) ?? 0) - 1;
        waiting.set(follower, left);
        if (left === 0) ready.push(byNode.get(follower) as TimelineItem);
      }
    }
    // What a cycle holds back cannot be sorted: it follows the sorted part in reading order, drawn broken.
    for (const member of members) if (!placed.has(member.nodeId)) ordered.push(member);

    const steps: ChainStep[] = ordered.map((item) => {
      const anchor = anchors.get(item.nodeId);
      return {
        item,
        inCycle: cyclic.has(item.nodeId),
        ...(anchor !== undefined ? { anchor: { ...anchor, hint: labels.afterHint(lens.label(anchor.day, 'short')) } } : {}),
      };
    });
    const head = ordered[0] as TimelineItem;
    sequenced.push({ id: `chain:${head.nodeId}`, part: head.part, steps, cycle: steps.some((step) => step.inCycle) });
  }

  const rankOf = (part: StoryPart): number => SHELF_RANK[part];
  sequenced.sort((a, b) => rankOf(a.part) - rankOf(b.part) || (a.steps[0] as ChainStep).item.readingIndex - (b.steps[0] as ChainStep).item.readingIndex);
  loose.sort((a, b) => rankOf(a.part) - rankOf(b.part) || a.readingIndex - b.readingIndex);
  return { sequenced, loose };
}
