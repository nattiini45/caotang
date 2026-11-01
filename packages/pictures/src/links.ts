/**
 * Link operations over a plain list: ids, ordering, the card rule and the delete cascade. Every
 * function returns new arrays and never mutates its input, so the store can capture the prior list
 * for undo with a reference. Unknown roles and target kinds pass through untouched.
 */

import { newId, type RandomBytes } from '@caotang/ids';

import type { AssetLink, AssetLinkRole, AssetTarget, ReadAssetLink } from './model.js';
import { LINK_ID_PATTERN, validateAssetLink, type Validation } from './validate.js';

export const LINK_ORDER_GAP = 10;

type AnyLink = AssetLink | ReadAssetLink;

/** `l_` and ten Crockford base32 characters, the same family as every other id. */
export function mintLinkId(taken: ReadonlySet<string>, randomBytes?: RandomBytes): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `l_${newId('c', randomBytes ? { randomBytes } : {}).slice(2)}`;
    if (!taken.has(candidate) && LINK_ID_PATTERN.test(candidate)) return candidate;
  }
  throw new Error('could not mint a unique l_ id after 8 attempts');
}

interface LooseTarget {
  kind: string;
  nodeId?: unknown;
}

/**
 * The ordering group of a target: the project, one node's own pictures, or one node's paragraph
 * pictures. `order` is gap-encoded within a group, so two groups never interleave.
 */
export function targetKey(target: AssetTarget | { kind: string }): string {
  const t = target as LooseTarget;
  if (t.kind === 'project') return 'project';
  if (typeof t.nodeId === 'string') return `${t.kind}:${t.nodeId}`;
  return `${t.kind}:`;
}

export function nodeIdOfTarget(target: AssetTarget | { kind: string }): string | undefined {
  const t = target as LooseTarget;
  return (t.kind === 'node' || t.kind === 'paragraph') && typeof t.nodeId === 'string' ? t.nodeId : undefined;
}

export function sortByOrder<T extends AnyLink>(links: readonly T[]): T[] {
  return [...links].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The order a new link takes at the end of its group. */
export function nextLinkOrder(links: readonly AnyLink[], target: AssetTarget): number {
  const key = targetKey(target);
  let max = 0;
  for (const link of links) if (targetKey(link.target) === key && link.order > max) max = link.order;
  return max + LINK_ORDER_GAP;
}

export interface NewLink {
  assetId: string;
  target: AssetTarget;
  role?: AssetLinkRole;
  note?: string;
  when?: AssetLink['when'];
  /** Defaults to the end of the target's group. */
  order?: number;
  id?: string;
}

export interface LinkChange {
  linkId: string;
  before?: AnyLink;
  after?: AnyLink;
}

export interface LinkEdit<L extends AnyLink = AnyLink> {
  readonly links: L[];
  /** Exactly what changed, for the undo capture. */
  readonly changes: readonly LinkChange[];
}

const refuse = (code: string, message: string): Validation<never> => ({ ok: false, issues: [{ code, path: '', message }] });

export function cardLinkOf(links: readonly AnyLink[], nodeId: string): AnyLink | undefined {
  return sortByOrder(links.filter((l) => l.role === 'card' && nodeIdOfTarget(l.target) === nodeId && l.target.kind === 'node'))[0];
}

/**
 * Adds a link. The same picture may be linked to any number of targets; a second card picture for one
 * node is refused (use {@link makeCard} to move the card), and the check names the link that holds it.
 */
export function addLink(links: readonly AnyLink[], draft: NewLink, randomBytes?: RandomBytes): Validation<LinkEdit & { link: AssetLink }> {
  const taken = new Set(links.map((l) => l.id));
  if (draft.id !== undefined && taken.has(draft.id)) return refuse('duplicate-id', `the link id ${draft.id} is already used`);
  const link: AssetLink = {
    id: draft.id ?? mintLinkId(taken, randomBytes),
    assetId: draft.assetId,
    target: draft.target,
    role: draft.role ?? 'reference',
    order: draft.order ?? nextLinkOrder(links, draft.target),
    ...(draft.note === undefined ? {} : { note: draft.note }),
    ...(draft.when === undefined ? {} : { when: draft.when }),
  };
  const checked = validateAssetLink(link);
  if (!checked.ok) return checked;
  const nodeId = nodeIdOfTarget(link.target);
  if (link.role === 'card' && nodeId !== undefined) {
    const held = cardLinkOf(links, nodeId);
    if (held !== undefined) return refuse('card-conflict', `this binder item already has a card picture (${held.id}); make the new one the card instead`);
  }
  return { ok: true, value: { links: [...links, checked.value], changes: [{ linkId: link.id, after: checked.value }], link: checked.value } };
}

/**
 * Places a picture at a target, the one operation `asset.link` and `asset.import` both run. A picture is placed at a target at most once
 * (the same picture at many targets is fine). A card that would be a node's second is made the card instead: the earlier card turns
 * into a plain reference and keeps its place, its note and its order, so replacing a card never drops a link.
 */
export function placeLink(links: readonly AnyLink[], draft: NewLink, randomBytes?: RandomBytes): Validation<LinkEdit & { link: AssetLink }> {
  const key = targetKey(draft.target);
  const twin = links.find((l) => l.assetId === draft.assetId && targetKey(l.target) === key);
  const wantsCard = draft.role === 'card';
  if (twin !== undefined) {
    // A picture already placed on a binder item as a plain reference becomes that item's card in place, keeping its note and order:
    // choosing a linked picture as the card is one change, not an unlink and a second link.
    if (wantsCard && twin.role === 'reference' && twin.target.kind === 'node') {
      const promoted = makeCard(links, twin.id);
      if (!promoted.ok) return promoted;
      const link = promoted.value.links.find((l) => l.id === twin.id) as AssetLink;
      return { ok: true, value: { links: promoted.value.links, changes: promoted.value.changes, link } };
    }
    return refuse('duplicate-link', `this picture is already placed there (${twin.id})`);
  }
  const added = addLink(links, wantsCard ? { ...draft, role: 'reference' } : draft, randomBytes);
  if (!added.ok || !wantsCard) return added;
  const moved = makeCard(added.value.links, added.value.link.id);
  if (!moved.ok) return moved;
  const link = moved.value.links.find((l) => l.id === added.value.link.id) as AssetLink;
  const others = moved.value.changes.filter((c) => c.linkId !== link.id);
  return { ok: true, value: { links: moved.value.links, changes: [{ linkId: link.id, after: link }, ...others], link } };
}
/** Makes one node link the node's card picture and turns any other card of that node back into a plain reference. */
export function makeCard(links: readonly AnyLink[], linkId: string): Validation<LinkEdit> {
  const target = links.find((l) => l.id === linkId);
  if (target === undefined) return refuse('unknown-link', `there is no link ${linkId}`);
  const nodeId = nodeIdOfTarget(target.target);
  if (target.target.kind !== 'node' || nodeId === undefined) return refuse('card-target', 'only a picture linked to a binder item can be its card');
  if (target.role !== 'card' && target.role !== 'reference') return refuse('card-role', `a ${String(target.role)} link cannot become a card picture`);
  const changes: LinkChange[] = [];
  const next = links.map((l) => {
    const isOtherCard = l.id !== linkId && l.role === 'card' && l.target.kind === 'node' && nodeIdOfTarget(l.target) === nodeId;
    if (isOtherCard) {
      const after = { ...l, role: 'reference' } as AnyLink;
      changes.push({ linkId: l.id, before: l, after });
      return after;
    }
    if (l.id === linkId && l.role !== 'card') {
      const after = { ...l, role: 'card' } as AnyLink;
      changes.push({ linkId: l.id, before: l, after });
      return after;
    }
    return l;
  });
  return { ok: true, value: { links: next, changes } };
}

export function removeLink(links: readonly AnyLink[], linkId: string): Validation<LinkEdit> {
  const found = links.find((l) => l.id === linkId);
  if (found === undefined) return refuse('unknown-link', `there is no link ${linkId}`);
  return { ok: true, value: { links: links.filter((l) => l.id !== linkId), changes: [{ linkId, before: found }] } };
}

/**
 * Puts the links of one target in the given order, renumbering the group in steps of 10. The list must
 * name every link of the target exactly once; a partial list would silently reorder the rest.
 */
export function reorderLinks(links: readonly AnyLink[], target: AssetTarget, orderedIds: readonly string[]): Validation<LinkEdit> {
  const key = targetKey(target);
  const group = links.filter((l) => targetKey(l.target) === key);
  const wanted = new Set(orderedIds);
  if (wanted.size !== orderedIds.length || wanted.size !== group.length || group.some((l) => !wanted.has(l.id))) {
    return refuse('reorder-set', 'the new order must list every picture of this target exactly once');
  }
  const position = new Map(orderedIds.map((id, index) => [id, (index + 1) * LINK_ORDER_GAP] as const));
  const changes: LinkChange[] = [];
  const next = links.map((l) => {
    const order = position.get(l.id);
    if (order === undefined || order === l.order) return l;
    const after = { ...l, order } as AnyLink;
    changes.push({ linkId: l.id, before: l, after });
    return after;
  });
  return { ok: true, value: { links: next, changes } };
}

/** Sets or clears a link's own note. The note is placement text; the picture's caption is not touched. */
export function setLinkNote(links: readonly AnyLink[], linkId: string, note: string | null): Validation<LinkEdit> {
  const found = links.find((l) => l.id === linkId);
  if (found === undefined) return refuse('unknown-link', `there is no link ${linkId}`);
  const after: Record<string, unknown> = { ...found };
  if (note === null) delete after['note'];
  else after['note'] = note;
  return { ok: true, value: { links: links.map((l) => (l.id === linkId ? (after as AnyLink) : l)), changes: [{ linkId, before: found, after: after as AnyLink }] } };
}

export interface Cascade {
  readonly kept: AnyLink[];
  readonly removed: AnyLink[];
}

/**
 * The links a deleted subtree takes with it: node and paragraph links to a deleted node. A link whose
 * target kind this build does not know is kept, because its node cannot be read from it.
 */
export function cascadeNodeDeletion(links: readonly AnyLink[], deletedNodeIds: ReadonlySet<string>): Cascade {
  const kept: AnyLink[] = [];
  const removed: AnyLink[] = [];
  for (const link of links) {
    const nodeId = nodeIdOfTarget(link.target);
    (nodeId !== undefined && deletedNodeIds.has(nodeId) ? removed : kept).push(link);
  }
  return { kept, removed };
}
