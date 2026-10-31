/**
 * Uses, dedup and the backfill — pictures.md §2.1, §6.2.
 *
 * A picture's uses are derived, never stored. The caller hands in structural snapshots (the manifest's
 * tree and codex, the link list) plus the references it parsed out of bodies and vendor prompts; this
 * module imports neither the store nor the editor, so the dependency runs pictures <- store <- bus.
 */

import { isAssetId, parseAssetFileName } from './asset-files.js';
import { cardLinkOf, nodeIdOfTarget, sortByOrder, targetKey } from './links.js';
import {
  ASSET_LINK_ROLES,
  type AssetLink,
  type AssetRecord,
  type AssetTarget,
  type ReadAssetLink,
  type UnknownTarget,
} from './model.js';

export interface UsesNode {
  id: string;
  /** The shot object as the manifest stores it; only `image` is read. */
  shot?: Record<string, unknown> | undefined;
}

export interface UsesCodexEntry {
  id: string;
  visualRefs?: readonly string[] | undefined;
}

/** An image the caller parsed out of a stored body (`![](../assets/a_….png)`). */
export interface InlineImageRef {
  assetId: string;
  nodeId: string;
}

export type VendorOwner =
  | { kind: 'shot'; nodeId: string }
  | { kind: 'codex'; entryId: string }
  | { kind: 'other'; label: string };

/** A picture a shot prompt's `references[]` or a prompt pack names (video-prompt-pack.md §3, §6). */
export interface VendorRef {
  assetId: string;
  owner: VendorOwner;
}

export interface ComicPanelRef {
  assetId: string;
  nodeId: string;
  panelId?: string;
}

export interface UsesSnapshot {
  coverAssetId?: string | null | undefined;
  nodes?: readonly UsesNode[];
  codex?: readonly UsesCodexEntry[];
  links?: readonly (AssetLink | ReadAssetLink)[];
  inline?: readonly InlineImageRef[];
  vendor?: readonly VendorRef[];
  panels?: readonly ComicPanelRef[];
}

export type PictureUse =
  | { kind: 'cover' }
  | { kind: 'shot'; nodeId: string }
  | { kind: 'codex'; entryId: string }
  | { kind: 'inline'; nodeId: string }
  | { kind: 'vendor'; owner: VendorOwner }
  | { kind: 'comic-panel'; nodeId: string; panelId?: string }
  | {
      kind: 'link';
      linkId: string;
      target: AssetTarget | UnknownTarget;
      role: string;
      /** False for a role or target kind this build does not know; deleting the picture would be a guess. */
      understood: boolean;
    };

const KNOWN_TARGET_KINDS = new Set(['project', 'node', 'paragraph']);

function linkUnderstood(link: AssetLink | ReadAssetLink): boolean {
  return KNOWN_TARGET_KINDS.has(link.target.kind) && (ASSET_LINK_ROLES as readonly string[]).includes(link.role);
}

/** Every use of every picture, in a stable order: cover, shots, codex, inline, vendor, panels, then links by order. */
export function collectUses(snapshot: UsesSnapshot): Map<string, PictureUse[]> {
  const uses = new Map<string, PictureUse[]>();
  const add = (assetId: unknown, use: PictureUse): void => {
    if (typeof assetId !== 'string' || assetId === '') return;
    const list = uses.get(assetId);
    if (list === undefined) uses.set(assetId, [use]);
    else list.push(use);
  };

  if (typeof snapshot.coverAssetId === 'string') add(snapshot.coverAssetId, { kind: 'cover' });
  for (const node of snapshot.nodes ?? []) {
    const image = node.shot?.['image'];
    if (typeof image === 'string' && isAssetId(image)) add(image, { kind: 'shot', nodeId: node.id });
  }
  for (const entry of snapshot.codex ?? []) {
    for (const ref of entry.visualRefs ?? []) add(ref, { kind: 'codex', entryId: entry.id });
  }
  for (const ref of snapshot.inline ?? []) add(ref.assetId, { kind: 'inline', nodeId: ref.nodeId });
  for (const ref of snapshot.vendor ?? []) add(ref.assetId, { kind: 'vendor', owner: ref.owner });
  for (const ref of snapshot.panels ?? []) {
    add(ref.assetId, { kind: 'comic-panel', nodeId: ref.nodeId, ...(ref.panelId === undefined ? {} : { panelId: ref.panelId }) });
  }
  for (const link of sortByOrder(snapshot.links ?? [])) {
    add(link.assetId, { kind: 'link', linkId: link.id, target: link.target, role: String(link.role), understood: linkUnderstood(link) });
  }
  return uses;
}

export function usesOf(snapshot: UsesSnapshot, assetId: string): PictureUse[] {
  return collectUses(snapshot).get(assetId) ?? [];
}

/**
 * The uses that stop `asset.delete`: everything except a link this build understands, because deleting
 * a record removes its links. An unknown link stays a blocker rather than be silently dropped.
 */
export function deletionBlockers(uses: readonly PictureUse[]): PictureUse[] {
  return uses.filter((use) => use.kind !== 'link' || !use.understood);
}

/** The ids whose files something other than a link names: the set the backfill gives records to. */
export function usedAssetIds(snapshot: UsesSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const [assetId, list] of collectUses(snapshot)) if (list.some((use) => use.kind !== 'link')) ids.add(assetId);
  return ids;
}

export type LinkQuery = { kind: 'project' } | { kind: 'node'; nodeId: string } | { kind: 'paragraph'; nodeId: string };

/**
 * The links of one target, in order. A node query returns the node's own links; pass
 * `includeParagraphs` for the node's paragraph links as well. The timeline reads `linksOf({kind:'node'})`.
 */
export function linksOf<L extends AssetLink | ReadAssetLink>(
  links: readonly L[],
  query: LinkQuery,
  options: { includeParagraphs?: boolean } = {},
): L[] {
  const keys = new Set([targetKey(query)]);
  if (query.kind === 'node' && options.includeParagraphs === true) keys.add(`paragraph:${query.nodeId}`);
  return sortByOrder(links.filter((link) => keys.has(targetKey(link.target))));
}

export function linksToAsset<L extends AssetLink | ReadAssetLink>(links: readonly L[], assetId: string): L[] {
  return sortByOrder(links.filter((link) => link.assetId === assetId));
}

/** The asset id of a node's card picture, if it has one. */
export function cardAssetOf(links: readonly (AssetLink | ReadAssetLink)[], nodeId: string): string | undefined {
  return cardLinkOf(links, nodeId)?.assetId;
}

/** The binder items a picture is linked to, for "used in" chips. */
export function linkedNodeIds(links: readonly (AssetLink | ReadAssetLink)[], assetId: string): string[] {
  const ids = new Set<string>();
  for (const link of links) {
    const nodeId = nodeIdOfTarget(link.target);
    if (link.assetId === assetId && nodeId !== undefined) ids.add(nodeId);
  }
  return [...ids];
}

export interface DedupRecord {
  id: string;
  sha256: string;
  /** The record's file is absent from an authoritative listing. */
  missing?: boolean;
}

export interface UnrecordedFile {
  assetId: string;
  file: string;
  sha256: string;
}

export type DedupDecision =
  /** Same bytes as a record: no new file; add only the links. `restoreBytes` when that record's file is missing. */
  | { action: 'reuse'; assetId: string; restoreBytes: boolean }
  /** Same bytes as a file with no record (an undone import left it): the record is re-created over it. */
  | { action: 'adopt'; assetId: string; file: string }
  | { action: 'new' };

/**
 * Hash-first dedup. `sha256` is of the bytes as they will be stored, after the metadata strip, so two
 * copies that differ only in GPS match. A listing that is not authoritative is not trusted to say that
 * no file exists, so unrecorded files are only used when it is.
 */
export function decideDedup(
  sha256: string,
  records: readonly DedupRecord[],
  unrecorded: { authoritative: boolean; files: readonly UnrecordedFile[] } = { authoritative: false, files: [] },
): DedupDecision {
  const matches = records.filter((r) => r.sha256 === sha256);
  const present = matches.find((r) => r.missing !== true) ?? matches[0];
  if (present !== undefined) return { action: 'reuse', assetId: present.id, restoreBytes: present.missing === true };
  if (unrecorded.authoritative) {
    const files = unrecorded.files.filter((f) => f.sha256 === sha256).sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
    const file = files[0];
    if (file !== undefined) return { action: 'adopt', assetId: file.assetId, file: file.file };
  }
  return { action: 'new' };
}

export interface ListedFile {
  /** The file name inside `assets/`. Names that are not `a_XXXXXXXXXX.<png|jpg|webp>` are not assets and are skipped. */
  file: string;
  /** Known facts, filled in as the idle hashing gets to each file. */
  bytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
}

export interface AssetListing {
  /** True only when the whole folder (or store) was listed successfully. */
  authoritative: boolean;
  files: readonly ListedFile[];
}

export interface BackfillPlan {
  /** Complete records to publish with the next save. */
  create: AssetRecord[];
  /** Used and listed, but its hash and size are not known yet: compute them, then plan again. */
  needFacts: { assetId: string; file: string }[];
  /** Named by a use but absent from an authoritative listing. No record is made; the reference is untouched. */
  missingFiles: string[];
  /** Existing records whose file is absent from an authoritative listing. Kept, with their metadata. */
  missingRecords: string[];
}

/**
 * Gives every used file without a record a record. Idempotent: apply `create` and plan again, and the
 * result is empty. Nothing is ever dropped — a record whose bytes are gone is reported, not removed.
 */
export function planBackfill(input: { records: readonly { id: string; file?: string }[]; used: ReadonlySet<string>; listing: AssetListing; now: string }): BackfillPlan {
  const recorded = new Set(input.records.map((r) => r.id));
  const byId = new Map<string, ListedFile & { mime: AssetRecord['mime'] }>();
  for (const file of [...input.listing.files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const parsed = parseAssetFileName(file.file);
    if (parsed !== undefined && !byId.has(parsed.assetId)) byId.set(parsed.assetId, { ...file, mime: parsed.mime });
  }

  const plan: BackfillPlan = { create: [], needFacts: [], missingFiles: [], missingRecords: [] };
  for (const assetId of [...input.used].sort()) {
    if (recorded.has(assetId)) continue;
    const listed = byId.get(assetId);
    if (listed === undefined) {
      if (input.listing.authoritative) plan.missingFiles.push(assetId);
    } else if (listed.sha256 === undefined || listed.bytes === undefined) {
      plan.needFacts.push({ assetId, file: listed.file });
    } else {
      const hasSize = listed.width !== undefined && listed.height !== undefined;
      plan.create.push({
        id: assetId,
        file: listed.file,
        mime: listed.mime,
        sha256: listed.sha256,
        bytes: listed.bytes,
        ...(hasSize ? { width: listed.width, height: listed.height } : {}),
        createdAt: input.now,
      });
    }
  }
  if (input.listing.authoritative) {
    const present = new Set(input.listing.files.map((f) => f.file));
    for (const record of input.records) {
      if (record.file !== undefined && !present.has(record.file)) plan.missingRecords.push(record.id);
    }
    plan.missingRecords.sort();
  }
  return plan;
}
