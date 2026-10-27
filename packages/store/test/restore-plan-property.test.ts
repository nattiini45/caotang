/**
 * The gate for `restorePlan` (packages/bus/src/restore-plan.ts, command-bus §5 "Independence rule"): a property and differential
 * test over the real commands. The planner is allowed to say `exact` only when taking one checkpoint back, with the groups after it
 * left standing, is the same as those groups having run without it. This file generates random undo stacks over a small tree and
 * checks that claim three ways, for every plan that comes back `exact`:
 *
 * 1. **Ground truth.** The nodes and child lists each command really changed are measured by diffing the state before and after it,
 *    not read from the log. The target's measured touch and every later group's must not meet.
 * 2. **Byte-identical.** After the restore, every node a later group changed, and every child list it changed, is byte for byte what it
 *    was before the restore.
 * 3. **Differential.** The whole project after the restore equals a project in which the same later groups ran without the target.
 *
 * It also checks that the planner is not vacuous: over the run it returns both `exact` and `with-later`, so a planner that always
 * refused (or always allowed) fails here. A seed that fails is printed, so it can be replayed.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  restorePlan,
  type ActivityLog,
  type BusContext,
  type Command,
  type CommandName,
  type UndoStore,
} from '@caotang/bus';

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  getBody,
  getRevision,
  nodeById,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-02T15:00:00.000Z');
const TICK = 1_760_000_000_000;
const clock = { now: () => TICK };

// ---------------------------------------------------------------- the project

const FOLDERS = ['n_F00000001', 'n_F00000002', 'n_F00000003', 'n_F00000004'] as const;
const DOCS = ['n_D00000001', 'n_D00000002', 'n_D00000003', 'n_D00000004', 'n_D00000005', 'n_D00000006', 'n_D00000007', 'n_D00000008'] as const;

function makeState(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  state.manifest.project.id = 'p_PROPERTY01';
  state.manifest.vocabulary.labels = [
    { id: 'act-1', name: 'Act 1', color: '#8a8a8a' },
    { id: 'act-2', name: 'Act 2', color: '#4a90d9' },
  ];
  // Three chapters under the manuscript and a nested folder in the first: root > manuscript > f1 (d1, d2, f4 (d3)), f2 (d4, d5), f3 (d6, d7, d8).
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: FOLDERS[0] });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 2', now: OPENED, id: FOLDERS[1] });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 3', now: OPENED, id: FOLDERS[2] });
  addDocument(state, { parentId: FOLDERS[0], title: 'One', now: OPENED, id: DOCS[0], body: 'First scene.', status: 'draft' });
  addDocument(state, { parentId: FOLDERS[0], title: 'Two', now: OPENED, id: DOCS[1], body: 'Second scene.' });
  addFolder(state, { parentId: FOLDERS[0], title: 'Interlude', now: OPENED, id: FOLDERS[3] });
  addDocument(state, { parentId: FOLDERS[3], title: 'Three', now: OPENED, id: DOCS[2], body: 'Third scene.' });
  addDocument(state, { parentId: FOLDERS[1], title: 'Four', now: OPENED, id: DOCS[3], body: 'Fourth scene.' });
  addDocument(state, { parentId: FOLDERS[1], title: 'Five', now: OPENED, id: DOCS[4], body: 'Fifth scene.' });
  addDocument(state, { parentId: FOLDERS[2], title: 'Six', now: OPENED, id: DOCS[5], body: 'Sixth scene.' });
  addDocument(state, { parentId: FOLDERS[2], title: 'Seven', now: OPENED, id: DOCS[6], body: 'Seventh scene.' });
  addDocument(state, { parentId: FOLDERS[2], title: 'Eight', now: OPENED, id: DOCS[7], body: 'Eighth scene.' });
  return state;
}

interface Rig {
  readonly state: ProjectState;
  readonly bus: BusContext<ProjectState>;
  readonly undo: UndoStore;
  readonly log: ActivityLog;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
}

function rig(): Rig {
  const state = makeState();
  const registry = createProjectCommandRegistry({ clock });
  const log = createActivityLog();
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    permission: { approvedPlan: true },
    undo,
    log,
    idempotency: createIdempotencyCache(),
    notify: () => undefined,
  };
  return { state, bus, undo, log, registry };
}

// ---------------------------------------------------------------- measuring what a command really changed

interface Snapshot {
  readonly nodes: ReadonlyMap<string, string>;
  readonly bodies: ReadonlyMap<string, string>;
  readonly lists: ReadonlyMap<string, string>;
}

function snapshot(state: ProjectState): Snapshot {
  const nodes = new Map<string, string>();
  const lists = new Map<string, string[]>();
  for (const node of [...state.manifest.tree].sort((a, b) => a.order - b.order)) {
    nodes.set(node.id, JSON.stringify(node, Object.keys(node).sort()));
    if (node.parentId !== null) lists.set(node.parentId, [...(lists.get(node.parentId) ?? []), node.id]);
  }
  const bodies = new Map<string, string>();
  for (const id of state.documents.keys()) bodies.set(id, getBody(state, id));
  return { nodes, bodies, lists: new Map([...lists].map(([parent, ids]) => [parent, ids.join(',')])) };
}

/** The ids whose record or body differ between two snapshots (a node in only one counts), and the parents whose child list differs. */
function diff(before: Snapshot, after: Snapshot): { nodes: Set<string>; lists: Set<string> } {
  const nodes = new Set<string>();
  for (const id of new Set([...before.nodes.keys(), ...after.nodes.keys()])) {
    if (before.nodes.get(id) !== after.nodes.get(id) || before.bodies.get(id) !== after.bodies.get(id)) nodes.add(id);
  }
  const lists = new Set<string>();
  for (const id of new Set([...before.lists.keys(), ...after.lists.keys()])) {
    if (before.lists.get(id) !== after.lists.get(id)) lists.add(id);
  }
  return { nodes, lists };
}

// ---------------------------------------------------------------- generating a stack

/** A seeded generator, so a failing run can be replayed from its number. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Op {
  readonly name: CommandName;
  readonly params: Record<string, unknown>;
  /** A body write is guarded by the revision the document has when it is dispatched. */
  readonly guarded?: true;
}

interface Done {
  readonly op: Op;
  readonly callId?: string;
  readonly touched: { nodes: Set<string>; lists: Set<string> };
}

interface Stack {
  readonly rig: Rig;
  /** One entry per group the stack holds, oldest first: the ground truth of each of its commands. */
  readonly groups: { readonly id: string; readonly agent: boolean; readonly done: Done[] }[];
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)]!;
}

const WORDS = ['tide', 'lamp', 'ferry', 'wreck', 'keeper', 'gull', 'salt', 'fog'];

/** Whether `ancestor` is `id` or above it. */
function within(state: ProjectState, id: string, ancestor: string): boolean {
  for (let at = nodeById(state, id); at !== undefined; at = at.parentId === null ? undefined : nodeById(state, at.parentId)) {
    if (at.id === ancestor) return true;
  }
  return false;
}

function opFor(state: ProjectState, next: () => number, serial: number): Op {
  const nodes = [...FOLDERS, ...DOCS];
  const doc = pick(next, DOCS);
  const word = pick(next, WORDS);
  switch (Math.floor(next() * 14)) {
    case 0:
    case 1:
      return { name: 'doc.write', params: { docId: doc, body: `${word} ${serial}. ${getBody(state, doc)}` }, guarded: true };
    case 2:
      return { name: 'editor.insert', params: { docId: doc, offset: 0, text: `${word}${serial} ` } };
    case 3:
      return { name: 'notes.append', params: { nodeId: pick(next, nodes), text: `${word} ${serial}` } };
    case 4:
      return { name: 'notes.set', params: { nodeId: pick(next, nodes), notes: `${word} ${serial}` } };
    case 5:
      return { name: 'binder.setSynopsis', params: { nodeId: pick(next, nodes), synopsis: `${word} ${serial}` } };
    case 6:
      return { name: 'binder.setMeta', params: { nodeId: pick(next, nodes), patch: { status: pick(next, ['draft', 'revised', 'final']) } } };
    case 7:
      return { name: 'binder.setMeta', params: { nodeId: pick(next, nodes), patch: { label: pick(next, ['act-1', 'act-2']), keywords_add: [word] } } };
    case 8:
      return { name: 'binder.rename', params: { nodeId: pick(next, nodes), title: `${word} ${serial}` } };
    case 9:
    case 10:
    case 11: {
      const node = pick(next, nodes);
      const parent = pick(next, ['manuscript', ...FOLDERS]);
      // A node is never moved into itself or below itself; an index past the end lands last.
      return { name: 'binder.move', params: { nodeId: node, newParentId: within(state, parent, node) ? 'manuscript' : parent, index: Math.floor(next() * 3) } };
    }
    case 12:
      // A global touch: a new node. It must never be part of an exact plan.
      return { name: 'binder.create', params: { parentId: pick(next, FOLDERS), type: 'document', title: `New ${serial}` } };
    default:
      return { name: 'vocabulary.upsert', params: { kind: 'status', id: `s${serial}`, name: `Status ${serial}`, color: '#112233' } };
  }
}

function dispatch(r: Rig, op: Op, meta: { agent: boolean; turnId?: string; callId?: string }, serial: number): boolean {
  const params = op.guarded === true ? { ...op.params, expectedRevision: getRevision(r.state, op.params['docId'] as string) } : op.params;
  const command: Command = {
    id: `cmd_${String(serial).padStart(10, '0')}`,
    name: op.name,
    params,
    issuedBy: meta.agent ? 'agent' : 'user',
    ...(meta.turnId === undefined ? {} : { turnId: meta.turnId }),
    ...(meta.callId === undefined ? {} : { callId: meta.callId }),
    createdAt: TICK - 1_000,
  };
  return execute(command, r.bus, r.registry).ok;
}

function build(seed: number): Stack {
  const next = seeded(seed);
  const r = rig();
  const groups: Stack['groups'] = [];
  let serial = 0;
  const count = 3 + Math.floor(next() * 5);
  for (let g = 0; g < count; g += 1) {
    const agent = next() < 0.7;
    const commands = agent ? 1 + Math.floor(next() * 3) : 1;
    const done: Done[] = [];
    const turnId = `turn_${g}`;
    for (let c = 0; c < commands; c += 1) {
      serial += 1;
      const op = opFor(r.state, next, serial);
      const callId = agent ? `${turnId}.${c}` : undefined;
      const before = snapshot(r.state);
      const ok = dispatch(r, op, { agent, ...(agent ? { turnId } : {}), ...(callId === undefined ? {} : { callId }) }, serial);
      if (!ok) continue;
      done.push({ op, ...(callId === undefined ? {} : { callId }), touched: diff(before, snapshot(r.state)) });
    }
    // The group this turn or gesture opened is the newest on the stack, when it registered anything.
    const stack = r.undo.groups();
    const newest = stack[stack.length - 1];
    if (done.length > 0 && newest !== undefined && !groups.some((entry) => entry.id === newest.id)) groups.push({ id: newest.id, agent, done });
  }
  return { rig: r, groups };
}

/** Rebuilds the stack's project without the entries of the target from `fromIndex` on, by running the same commands on a fresh project. */
function replayWithout(stack: Stack, targetAt: number, fromIndex: number): { state: ProjectState; refused: string[] } {
  const r = rig();
  const refused: string[] = [];
  let serial = 100_000;
  stack.groups.forEach((group, at) => {
    group.done.forEach((done, index) => {
      if (at === targetAt && index >= fromIndex) return;
      serial += 1;
      const ok = dispatch(r, done.op, { agent: group.agent, ...(group.agent ? { turnId: `turn_${at}` } : {}), ...(done.callId === undefined ? {} : { callId: done.callId }) }, serial);
      if (!ok) refused.push(`${done.op.name} ${JSON.stringify(done.op.params)}`);
    });
  });
  return { state: r.state, refused };
}

// ---------------------------------------------------------------- comparing projects

/** The project as a reader of it sees it: each node without its raw order, the child lists, the bodies, the derived counts. */
function normalised(state: ProjectState): unknown {
  // A node a command created has a random id; it is named by its title (each is unique), so two projects built alike compare equal.
  const fixed = new Set<string>([...FOLDERS, ...DOCS, 'root', 'manuscript', 'research']);
  const named = new Map(state.manifest.tree.filter((node) => !fixed.has(node.id)).map((node) => [node.id, `created:${node.title}`] as const));
  const renamed = JSON.parse([...named].reduce((text, [id, name]) => text.split(id).join(name), JSON.stringify(plain(state)))) as Record<string, [string, unknown][]>;
  for (const key of ['nodes', 'lists', 'bodies']) renamed[key]!.sort(([a], [b]) => a.localeCompare(b));
  return renamed;
}

function plain(state: ProjectState): unknown {
  const snap = snapshot(state);
  const nodes = [...snap.nodes].map(([id, json]) => {
    const { order: _order, ...rest } = JSON.parse(json) as Record<string, unknown>;
    return [id, rest];
  });
  return {
    nodes,
    lists: [...snap.lists],
    bodies: [...snap.bodies],
    // The counts are content; when the cache was last computed is a stamp, not something a writer wrote.
    wordCounts: state.manifest.derived?.wordCounts,
    vocabulary: state.manifest.vocabulary,
    codex: state.manifest.codex,
  };
}

// ---------------------------------------------------------------- the property

interface Tally {
  exact: number;
  withLater: number;
  step: number;
}

const SEEDS = 600;

describe('restorePlan over random undo stacks (the gate for the keep-later-edits restore)', () => {
  const tally: Tally = { exact: 0, withLater: 0, step: 0 };

  it(`never says exact when the measured touches meet, and an exact restore leaves every later change byte for byte (${SEEDS} stacks)`, () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const stack = build(seed);
      if (stack.groups.length < 2) continue;
      const next = seeded(seed * 7919);
      const targetAt = Math.floor(next() * (stack.groups.length - 1));
      const group = stack.groups[targetAt]!;
      // Half of the agent groups are restored from a step; the step is one of the group's own call ids.
      const fromIndex = group.agent && group.done.length > 1 && next() < 0.5 ? 1 + Math.floor(next() * (group.done.length - 1)) : 0;
      const fromCallId = fromIndex > 0 ? group.done[fromIndex]!.callId : undefined;
      const r = stack.rig;
      const label = `seed ${seed}, target ${group.id}${fromCallId === undefined ? '' : ` from ${fromCallId}`}`;

      const plan = restorePlan(
        r.undo.groups(),
        r.log.entries(),
        { groupId: group.id, ...(fromCallId === undefined ? {} : { fromCallId }) },
        (id) => {
          const chain: string[] = [];
          for (let at = nodeById(r.state, id); at !== undefined && at.parentId !== null; at = nodeById(r.state, at.parentId)) chain.push(at.parentId);
          return chain;
        },
      );

      if (plan.kind !== 'exact') {
        tally.withLater += 1;
        expect(plan.later, label).toEqual(r.undo.groups().slice(r.undo.groups().findIndex((entry) => entry.id === group.id) + 1).map((entry) => entry.id).reverse());
        continue;
      }
      tally.exact += 1;
      if (fromCallId !== undefined) tally.step += 1;

      // 1. Ground truth: what the target really changed does not meet what any later group really changed.
      const mine = { nodes: new Set<string>(), lists: new Set<string>() };
      group.done.slice(fromIndex).forEach((done) => {
        done.touched.nodes.forEach((id) => mine.nodes.add(id));
        done.touched.lists.forEach((id) => mine.lists.add(id));
      });
      const later = stack.groups.slice(targetAt + 1);
      const theirs = { nodes: new Set<string>(), lists: new Set<string>() };
      later.forEach((entry) =>
        entry.done.forEach((done) => {
          done.touched.nodes.forEach((id) => theirs.nodes.add(id));
          done.touched.lists.forEach((id) => theirs.lists.add(id));
        }),
      );
      const mineAll = new Set([...mine.nodes, ...mine.lists]);
      const theirsAll = new Set([...theirs.nodes, ...theirs.lists]);
      expect([...mineAll].filter((id) => theirsAll.has(id)), `${label}: the measured touches meet`).toEqual([]);

      // 2. The restore itself, with nothing failing.
      const before = snapshot(r.state);
      const result = fromCallId === undefined ? r.undo.undo(group.id) : r.undo.undoFrom(group.id, fromCallId);
      expect(result.ok, label).toBe(true);
      if (!result.ok) continue;
      expect(result.value.failures, `${label}: a compensation failed`).toEqual([]);
      const after = snapshot(r.state);
      for (const id of theirs.nodes) {
        expect(after.nodes.get(id), `${label}: node ${id} changed under the restore`).toBe(before.nodes.get(id));
        expect(after.bodies.get(id), `${label}: body of ${id} changed under the restore`).toBe(before.bodies.get(id));
      }
      for (const id of theirs.lists) expect(after.lists.get(id), `${label}: the children of ${id} changed under the restore`).toBe(before.lists.get(id));

      // 3. Differential: the same project, had the target (from the step) never run.
      const expected = replayWithout(stack, targetAt, fromIndex);
      expect(expected.refused, `${label}: the project without the target refused a later command`).toEqual([]);
      expect(normalised(r.state), `${label}: the restored project differs from one that never had the target`).toEqual(normalised(expected.state));
    }

    // The planner is neither always yes nor always no, and the step path is exercised.
    expect(tally.exact).toBeGreaterThan(40);
    expect(tally.withLater).toBeGreaterThan(40);
    expect(tally.step).toBeGreaterThan(5);
  });
});
