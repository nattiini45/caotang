/**
 * In-memory project state — the thing the artifact is a *serialization of*.
 *
 * §8 makes this the pivot of the whole design: "open artifact → mutate →
 * export → diff against in-memory project state = empty". The artifact is not
 * the database and is not allowed to become one; the runtime store is a view
 * over this state, and the files are what you own. So the state is the thing
 * with the fewest opinions in it.
 *
 * The `revision` counter is per-document and in-memory only (§4: "every mutation
 * bumps a per-document `revision` counter, used by agent tools for optimistic
 * concurrency"). It is deliberately *not* in `caotang.json` — it is concurrency
 * state, not content, and putting it in the manifest would make every save
 * produce a diff.
 */

import { FIXED_ROOT_IDS, type Manifest, type NodeType, type TreeNode } from './manifest.js';
import type { CoherenceState } from './coherence-state.js';
import { newId } from '@caotang/ids';
import { nextSiblingOrder } from './create.js';
import { countBody, WORD_RULE_VERSION, wordRuleInUse } from './word-count.js';
import { isBodyType } from './paths.js';
import type { SkillFile } from '@caotang/skills';

export interface DocumentRecord {
  readonly id: string;
  /** Body text, no front matter, no title heading, no trailing newline. */
  body: string;
  /** Monotonic; bumped on every mutation (§4). Not serialized. */
  revision: number;
}

export interface ProjectState {
  manifest: Manifest;
  readonly documents: Map<string, DocumentRecord>;
  /**
   * `codex/<id>.md` files **this load saw and declined to import** — front
   * matter that does not parse. Not a list of orphans: `codex/*.md` with no
   * manifest entry is *imported* (codex.md §3, "recovered like orphan
   * `docs/*.md`"), so by the time anything is written those files are in the
   * manifest. This is the residue the import step could not read.
   *
   * It exists because an un-imported file is un-owned in exactly the way a
   * deleted entry is, and `writeProject` removes redundancy files no manifest
   * entry owns: before this set existed, the one copy of a hand-written
   * description was deleted by the next save, with a notice that never mentioned
   * a deletion. The decision is made here — at load, by the code that actually
   * read the file — and honoured by the prune at write, rather than re-derived
   * there from a second opinion about what counts as importable.
   *
   * Not serialized into `caotang.json`: it records how *this load* read a folder,
   * not a property of the project, and a manifest field would make every save of
   * a project whose `codex/` folder is dirty produce a diff. It does ride the
   * runtime store's project row, because that store rehydrates a state between
   * sessions and a prune running against a state that had forgotten would delete
   * the file all over again.
   */
  readonly declinedCodexFiles: Set<string>;
  /**
   * `docs/<id>.md` files **this load saw and declined to take into the state**. Two
   * cases share the set. A file named for a node that is not a document (a folder):
   * importing it would give the tree two nodes with one id, which §2 step 3 refuses
   * on the next open. And a body whose bytes are not UTF-8 text: the state can hold
   * no text for it, so its node is held with no body record and the writer skips it
   * while its file is in place (write.ts). In both cases the file is left where it
   * is — and, like {@link declinedCodexFiles}, recorded here so the prune at save
   * does not remove it as "a document file no document owns".
   * Persisted on the project row for the same reason that set is.
   */
  readonly declinedDocFiles: Set<string>;
  /**
   * The text of every file in {@link declinedCodexFiles} and {@link declinedDocFiles},
   * keyed by its path (`codex/<id>.md`, `docs/<id>.md`), as the load read it.
   *
   * The sets say *which* files were declined and must not be pruned; this says
   * *what they held*. An export is built from state, not from the folder it came
   * from, so without the text a declined file was simply absent from the bundle
   *. `writeProject` carries these into any target that does not already hold
   * the file, and never rewrites a file a target has. Persisted on the project row
   * with the sets, for the same reason.
   */
  readonly declinedText: Map<string, string>;
  /**
   * The project's skills, `.agents/skills/<folder>/…`: every file of every skill folder this load read, by folder name, each folder's files
   * sorted by path. Plain bytes and not parsed skills, so a save writes back exactly what the load read and a skill that does not parse
   * is still carried (extensibility.md §10). A folder the load declined, for a cap or an unsafe path, is not here and is left on disk.
   * Not in `caotang.json`; the runtime store keeps it on the project row (`ProjectRow.skillFiles`).
   */
  readonly skills: Map<string, SkillFile[]>;
  /**
   * The skill files the writer removed since this state was last written, by project path. A save removes them from a folder and only
   * them: the writer takes nothing out of `.agents/skills/` that it did not put there. Cleared per path as a write removes it, and not
   * persisted (a project's save to a folder is the only thing that reads it).
   */
  readonly removedSkillFiles: Set<string>;
  /**
   * The coherence file, when one is open (coherence.md §3). Optional: a project opened without
   * one has none, and the coherence commands refuse that case rather than creating it. Loaded and
   * saved by the coherence module through `ArtifactFs`; the applies change the in-memory copy here
   * (coherence-state.ts explains why an apply cannot do the I/O itself).
   */
  coherence?: CoherenceState;
}

export type { CoherenceState, CoherenceFindingState } from './coherence-state.js';

/**
 * The one constructor every project state goes through.
 *
 * **`derived` is materialized here, and it is the root of §2's "loader recomputes
 * on open if absent."** `validateManifest` treats a missing `derived` as *"not an
 * error"* (`validate.ts`, step 3) and then returns `source as unknown as
 * Manifest`, so a manifest without the block produces a value typed as having
 * `derived: Derived` and carrying `undefined`. Measured on this tree before this
 * slice: such a manifest validates `ok: true`, `readProject` **resolves** on it,
 * and the failure lands later and elsewhere — `serializeManifest` throws
 * `Cannot read properties of undefined (reading 'wordCounts')`, i.e. the next
 * save of a project that opened perfectly. Making the type true at the one
 * constructor is what turns that into a manifest with an empty cache instead.
 *
 * The default is deliberately *empty and not counted*: `rebuildDerived` is the
 * function §2's sentence names, it needs every loaded body, and a constructor
 * that counted an empty `documents` map would produce a count map that is empty
 * for a different reason than the one it is checking.
 */
export function createProjectState(manifest: Manifest, options: CreateStateOptions = {}): ProjectState {
  if (!isDerived(manifest.derived)) {
    manifest.derived = {
      wordCounts: {},
      computedAt: isoNow(options.now),
      ...(wordRuleInUse() === WORD_RULE_VERSION ? { ruleVersion: WORD_RULE_VERSION } : {}),
    };
  }
  return {
    manifest,
    documents: new Map(),
    declinedCodexFiles: new Set(),
    declinedDocFiles: new Set(),
    declinedText: new Map(),
    skills: new Map(),
    removedSkillFiles: new Set(),
  };
}

export interface CreateStateOptions {
  /** Only used to stamp a `derived` block this call has to invent. */
  readonly now?: Date;
}

/**
 * A copy of a state that shares nothing mutable with it: the manifest, the documents, the declined sets, the declined text and the skills. A write made
 * from the copy cannot change the original. `writeProject` stamps `project.modifiedAt` on whatever it writes from, so an export that writes
 * from the open project's own state would mark the project changed when nothing was edited (lifecycle `exportBundle`, persistence-plan).
 */
export function cloneProjectState(state: ProjectState): ProjectState {
  const copy = createProjectState(structuredClone(state.manifest));
  for (const [id, record] of state.documents) {
    copy.documents.set(id, { id, body: record.body, revision: record.revision });
  }
  for (const name of state.declinedCodexFiles) copy.declinedCodexFiles.add(name);
  for (const name of state.declinedDocFiles) copy.declinedDocFiles.add(name);
  for (const [path, text] of state.declinedText) copy.declinedText.set(path, text);
  for (const [folder, files] of state.skills) copy.skills.set(folder, files.map((file) => ({ path: file.path, bytes: file.bytes.slice() })));
  for (const path of state.removedSkillFiles) copy.removedSkillFiles.add(path);
  return copy;
}

function isDerived(value: unknown): value is Manifest['derived'] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.computedAt === 'string' &&
    typeof candidate.wordCounts === 'object' &&
    candidate.wordCounts !== null
  );
}

function isoNow(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}

/**
 * §2's "loader recomputes on open if absent" — the rebuild, as one function.
 *
 * **Rebuilds when the map is empty, or when it was counted with an older words
 * rule than this engine uses, and otherwise leaves it alone.** The `empty` half
 * is not a widening of the spec's word "absent"; it is what "absent" *means in
 * this tree*. Measured before this slice: with no producer, **every** manifest the
 * writer emitted serialized `"wordCounts": {}` — so a hand-written or pre-slice
 * project is the ordinary case, not the rare one. Rebuilding on an empty map
 * cannot be wrong: an empty map is not a truthful count of a project holding
 * documents, and §2 makes the whole block rebuildable.
 *
 * **The rule version only ever moves up.** `ruleVersion` (absent = 1) is what the
 * counts were made with; a cache older than `wordRuleInUse()` is recomputed once
 * and stamped. A newer cache read by an engine without `Intl.Segmenter` is left
 * as it is, so opening a project there neither rewrites it nor ping-pongs. The
 * rebuild is in memory (`modifiedAt` is untouched) and never rejects a manifest.
 *
 * **Otherwise a non-empty map is left exactly as it is.** §2 says the field is
 * *"allowed stale"* — a rebuild that ran on every open would make the cache a
 * second source of truth and would make every open rewrite `computedAt` for a
 * project nobody edited.
 */
export function rebuildDerived(state: ProjectState, options: { now?: Date } = {}): void {
  const derived = state.manifest.derived;
  const rule = wordRuleInUse();
  if (Object.keys(derived.wordCounts).length > 0 && (derived.ruleVersion ?? 1) >= rule) return;
  for (const record of state.documents.values()) {
    derived.wordCounts[record.id] = countBody(record.body).words;
  }
  if (rule === WORD_RULE_VERSION) derived.ruleVersion = rule;
  else delete derived.ruleVersion;
  derived.computedAt = isoNow(options.now);
}

/**
 * Record one document's §9 count. No stamp.
 *
 * Used where a document comes into existence with a body it never had: a count
 * with no previous value is not a *re*-computation of anything, and §2's
 * `computedAt` says when the block was last rebuilt.
 */
export function putBodyCount(state: ProjectState, id: string, body: string): void {
  state.manifest.derived.wordCounts[id] = countBody(body).words;
}

/**
 * Record one document's §9 count and stamp the recompute.
 *
 * `setBody` is the caller — §9's "per revision". The stamp moves with the count
 * because a count recomputed at revision *n* beside a `computedAt` naming
 * revision *n-1* is the corpus's standing "field reporting a different number
 * from the one it counted".
 */
export function recordBodyCount(state: ProjectState, id: string, body: string, now?: Date): void {
  putBodyCount(state, id, body);
  state.manifest.derived.computedAt = isoNow(now);
}

export function nodeById(state: ProjectState, id: string): TreeNode | undefined {
  return state.manifest.tree.find((n) => n.id === id);
}

export function documentIds(state: ProjectState): string[] {
  return state.manifest.tree
    .filter((n) => n.type === 'document')
    .map((n) => n.id)
    .sort();
}

export function getBody(state: ProjectState, id: string): string {
  return state.documents.get(id)?.body ?? '';
}

export function getRevision(state: ProjectState, id: string): number {
  return state.documents.get(id)?.revision ?? 0;
}

/**
 * Write a document body and bump its revision. Content-touching by definition.
 *
 * **This is §9's "per revision" producer.** `setBody` is the one function every
 * body mutation in the package flows through — `doc.write`, `editor.insert`,
 * `editor.replaceRange` and the `compensateBody` restore behind undo all call it
 * — so it is the only place the count can be maintained without a second path
 * that a command could forget. Measured before this slice: a document whose body
 * carried six words round-tripped through `writeProject`/`readProject` with
 * `"wordCounts": {}`.
 *
 * **An unchanged body records nothing and stamps nothing.** The early return is
 * §4's no-op write, and a cache whose `computedAt` advances on a write that did
 * not happen is a stamp lying about the revision it describes.
 *
 * **An undo is a write too.** The undo's restore comes through here, so it bumps
 * the counter like any other write and the counter only rises (project-format §4).
 * Nothing sets `revision` back to a number it had before.
 */
export function setBody(
  state: ProjectState,
  id: string,
  body: string,
  options: { now?: Date } = {},
): void {
  const record = state.documents.get(id);
  if (!record) throw new Error(`no document record for "${id}"`);
  if (record.body === body) return;
  record.body = body;
  record.revision += 1;
  recordBodyCount(state, id, body, options.now);
}

export interface AddDocumentOptions {
  parentId: string;
  title: string;
  body?: string;
  /** Defaults to a `document`. A `dialogue` container is the other type that holds a body (dialogue-narrative.md §2.1). */
  type?: NodeType;
  /** The media-track kind marker (screenplay.md §2.1, dialogue-narrative.md §2.1); absent on a prose document. */
  kind?: string;
  status?: string | null;
  label?: string | null;
  keywords?: string[];
  synopsis?: string;
  notes?: string;
  now?: Date;
  /** Test seam for fixture-stable ids; production omits it. */
  id?: string;
}

/**
 * Add a document node plus its record. Order is gap-encoded at
 * `maxSiblingOrder + 10` (§2), so inserting a scene between two others does not
 * renumber the siblings around it.
 */
export function addDocument(state: ProjectState, options: AddDocumentOptions): TreeNode {
  const taken = new Set(state.manifest.tree.map((n) => n.id));
  const id = options.id ?? newId('n', { taken });
  if (taken.has(id)) throw new Error(`node id "${id}" is already in use`);

  const created = options.now?.toISOString() ?? new Date().toISOString();
  const node: TreeNode = {
    id,
    parentId: options.parentId,
    type: options.type ?? 'document',
    title: options.title,
    order: nextSiblingOrder(state.manifest.tree, options.parentId),
    status: options.status ?? null,
    label: options.label ?? null,
    keywords: options.keywords ?? [],
    synopsis: options.synopsis ?? '',
    notes: options.notes ?? '',
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    createdAt: created,
    updatedAt: created,
  };

  state.manifest.tree.push(node);
  const body = options.body ?? '';
  state.documents.set(id, { id, body, revision: 0 });
  // A document born with a body has a count. Recording it here is what keeps
  // `wordCounts` a map over *the documents the tree holds* rather than a map
  // that fills in as documents happen to be edited — otherwise a newly created
  // document is missing from the map until its first keystroke, and the loader's
  // rebuild would add it on the next open, so the two producers of one field
  // would disagree about a document that never moved.
  //
  // **No stamp, and that is measured rather than tidiness.** `binder.create` is
  // the only production caller and its undo is an *inverse*, not a compensation:
  // `exit-gate.test.ts`'s §5.1 "snapshotOf(state) === before" was measured red
  // with a stamp here, and the sole differing field was `computedAt` —
  // `2025-10-09T08:53:20.000Z` where the fixture had `2026-10-03T09:00:00.000Z`.
  // A stamp on this path is unrestorable by construction, because the command
  // that would undo it dispatches `project.deleteNode`, whose job is to restore
  // what *it* removed. Every count here is definitional rather than recomputed
  // — a document with no body has zero words — so nothing is misreported.
  putBodyCount(state, id, body);
  return node;
}

/** Options for a node that holds no body: a folder, or a shot card (storyboard.md §2.1). */
export interface AddNodeOptions {
  parentId: string;
  title: string;
  /** Defaults to a `folder`. A `shot` is the other type this builds, and it has no body record. */
  type?: NodeType;
  kind?: string;
  now?: Date;
  id?: string;
}

/**
 * Add a node that holds no body: a folder, or a shot. Neither has a file in `docs/` (storyboard.md §2.1: a shot's
 * content is its metadata and its image), so neither gets a record, and a save writes it as structure only.
 */
export function addNode(state: ProjectState, options: AddNodeOptions): TreeNode {
  const taken = new Set(state.manifest.tree.map((n) => n.id));
  const id = options.id ?? newId('n', { taken });
  if (taken.has(id)) throw new Error(`node id "${id}" is already in use`);

  const created = options.now?.toISOString() ?? new Date().toISOString();
  const node: TreeNode = {
    id,
    parentId: options.parentId,
    type: options.type ?? 'folder',
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    title: options.title,
    order: nextSiblingOrder(state.manifest.tree, options.parentId),
    status: null,
    label: null,
    keywords: [],
    synopsis: '',
    notes: '',
    createdAt: created,
    updatedAt: created,
  };
  state.manifest.tree.push(node);
  return node;
}

/** Add a folder node (structure only — folders have no file in `docs/`). */
export function addFolder(
  state: ProjectState,
  options: { parentId: string; title: string; now?: Date; id?: string },
): TreeNode {
  return addNode(state, { ...options, type: 'folder' });
}

/**
 * One node as it left the tree, plus everything a restore needs to put it back.
 *
 * `index` is why this type exists: the position the node held in `manifest.tree` is
 * not read by anything (project-format §2's `tree` is an array, but the binder's order
 * comes from `parentId` + `order` — see `siblingIndex`), so it is captured purely to
 * give the restore the removed set's *relative* order, which nothing else preserves.
 * `record` is the body the node owned: a `document` node with no record fails
 * `writeProject` on the way out, and a record with no node is a lie
 * `writeProjectState` would hand to the runtime store.
 */
export interface RemovedNode {
  readonly node: TreeNode;
  readonly index: number;
  readonly record: DocumentRecord | undefined;
}

/**
 * Remove a node, its entire subtree, and the body records the removed documents
 * owned — the store's only node-removing primitive, so that no caller can drop the
 * tree entry and forget the record behind it.
 *
 * **Descendants are collected to a fixed point, not by one pass over the children.**
 * The tree is flat and parent-referenced, so a single pass sees only the direct
 * children; a grandchild would survive as an orphan whose `parentId` resolves to
 * nothing, and project-format §2's step-4 validator checks that every parent
 * resolves — the artifact would be rejected by its own reader. The loop is written
 * for the obvious property rather than for speed, because this is the function where
 * a wrong-but-fast parent chase silently orphans a whole scene.
 *
 * `derived.wordCounts` **drops the removed ids.** Leaving them untouched would
 * only be defensible if every count were equally stale and nothing read them as
 * truth; neither holds — the counts are maintained per revision, and something
 * reads them. Measured consequence of leaving them: a `project.deleteNode` whose compensation recreates the
 * subtree cannot return the manifest to its pre-command bytes, because the undo
 * of the *create* removes the node and leaves an entry keyed to an id the tree
 * no longer holds — `exit-gate.test.ts`'s §5.1 "snapshotOf(state) === before"
 * assertion, which the undo is supposed to satisfy exactly. §2's "allowed stale"
 * survives this change untouched: it means a *count* may lag its document, not
 * that the map may keep an id nothing owns.
 *
 * Fixed roots are refused here and not only in a descriptor's `validate`, because this
 * is the layer that actually mutates the tree: a rule held only by the caller who
 * validated is a rule that a second caller does not have.
 */
export function removeNode(state: ProjectState, id: string): RemovedNode[] {
  if ((FIXED_ROOT_IDS as readonly string[]).includes(id)) {
    throw new Error(`"${id}" is a fixed root and cannot be deleted`);
  }
  if (!nodeById(state, id)) throw new Error(`no node "${id}"`);

  const doomed = new Set<string>([id]);
  const tree = state.manifest.tree;
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of tree) {
      if (doomed.has(node.id)) continue;
      if (node.parentId !== null && doomed.has(node.parentId)) {
        doomed.add(node.id);
        grew = true;
      }
    }
  }

  const removed: RemovedNode[] = [];
  const kept: TreeNode[] = [];
  for (let index = 0; index < tree.length; index += 1) {
    const node = tree[index];
    if (node === undefined) continue;
    if (!doomed.has(node.id)) {
      kept.push(node);
      continue;
    }
    removed.push({
      node,
      index,
      record: isBodyType(node.type) ? state.documents.get(node.id) : undefined,
    });
  }

  for (const entry of removed) {
    if (entry.record !== undefined) state.documents.delete(entry.node.id);
    // The count goes with the record it describes — see the header on why this
    // clause reversed the decision the header used to record.
    delete state.manifest.derived.wordCounts[entry.node.id];
  }
  state.manifest.tree = kept;
  return removed;
}

/**
 * Reparent or reorder a node. This is a *structure* operation: §2's contract is
 * that structure ops deliberately do not bump `updatedAt`.
 * The body's revision is untouched too — a drag is not a content edit.
 */
export function moveNode(
  state: ProjectState,
  id: string,
  target: { parentId: string; order?: number },
): void {
  const node = nodeById(state, id);
  if (!node) throw new Error(`no node "${id}"`);
  if (node.id === 'root') throw new Error('the root cannot be moved');
  node.parentId = target.parentId;
  if (target.order !== undefined) node.order = target.order;
  else node.order = nextSiblingOrder(state.manifest.tree, target.parentId);
}

/**
 * Compact a sibling set back to 10, 20, 30 … — the §2 renormalization, applied
 * explicitly rather than as a side effect of a move.
 */
export function renormalizeSiblings(state: ProjectState, parentId: string | null): void {
  const siblings = state.manifest.tree
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.order - b.order);
  siblings.forEach((node, i) => {
    node.order = (i + 1) * 10;
  });
}

/** project-format §2: *"Renormalize … only when a sibling exceeds order `1_000_000`"*. */
export const RENORMALIZE_THRESHOLD = 1_000_000;

/**
 * A node's position among its siblings — the value `binder.move`'s `index` is in.
 *
 * §9's `index` is a **position**, and this is what makes that safe: orders are
 * gap-encoded and deliberately *not* renumbered by a move, so no arithmetic on
 * `order` is stable across moves, while a position is. The inverse of a move is a
 * move, and it can only carry a position — this is the function that produces
 * the one the inverse needs.
 */
export function siblingIndex(state: ProjectState, parentId: string | null, id: string): number {
  return state.manifest.tree
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .findIndex((n) => n.id === id);
}

/**
 * The `order` that puts a node at `index` among `parentId`'s children —
 * project-format §2's gap-encoding, all three of its clauses.
 *
 * §2, verbatim: *"**Gap-encoded**: created at `maxSiblingOrder + 10`; move = set
 * one node's order. Renormalize (compact to 10,20,30…) only when a sibling
 * exceeds order `1_000_000` or on manifest rewrite. **Insert between two nodes
 * with gap < 1 → renormalize that sibling set first.**"*
 *
 * - **empty set** → 10, which is `maxSiblingOrder + 10` with no siblings to take
 *   a maximum from.
 * - **at or past the end** → `max + 10`, after renormalizing if a sibling has run
 *   past `1_000_000` (clause 2 — appending to that set would keep growing it).
 * - **between two nodes** → the midpoint of the surrounding gap; when the gap
 *   holds no integer, §2's own third clause renormalizes that sibling set first.
 *
 * `movingId` is the node being moved, **excluded from the sibling set**: it is
 * leaving its old position, and counting it would shift every index the caller
 * meant. The same call therefore serves a move forward and the inverse that puts
 * the node back, which is why §5's exact inverse is reachable for `binder.move`
 * at all.
 *
 * `order` is a *non-negative integer* per §2 — the multiples of 10 are the
 * creation discipline, not a constraint on the field — so a midpoint is a legal
 * value, and a midpoint is what keeps a drag between two nodes from renumbering
 * everything around it.
 */
export function siblingOrderAt(
  state: ProjectState,
  parentId: string,
  index: number,
  movingId?: string,
): number {
  const ordered = (): TreeNode[] =>
    state.manifest.tree
      .filter((n) => n.parentId === parentId && n.id !== movingId)
      .sort((a, b) => a.order - b.order);

  let siblings = ordered();
  if (siblings.length === 0) return 10;

  if (index >= siblings.length) {
    const last = siblings[siblings.length - 1]!;
    if (last.order < RENORMALIZE_THRESHOLD) return last.order + 10;
    renormalizeSiblings(state, parentId);
    siblings = ordered();
    return siblings[siblings.length - 1]!.order + 10;
  }

  const gap = (list: TreeNode[]): { low: number; high: number } => ({
    low: index === 0 ? 0 : list[index - 1]!.order,
    high: list[index]!.order,
  });

  const first = gap(siblings);
  if (first.high - first.low >= 2) {
    return first.low + Math.floor((first.high - first.low) / 2);
  }
  renormalizeSiblings(state, parentId);
  siblings = ordered();
  const compacted = gap(siblings);
  return compacted.low + Math.floor((compacted.high - compacted.low) / 2);
}
