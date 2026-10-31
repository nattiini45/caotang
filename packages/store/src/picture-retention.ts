/**
 * Retention-safe picture storage — [pictures.md §6.4.2, §6.5, §6.6.1](docs/architecture/pictures.md).
 *
 * A picture file is safe to delete only when **every** root that can name it has been read and none does
 * (§6.6.1). That is why this module is built around **root-provider contracts**, not around a list of places
 * the sweep happens to know: each root is a named provider whose `list()` either enumerates the asset ids it
 * still names or refuses (`authoritative: false`). A provider that cannot enumerate makes the whole snapshot
 * non-authoritative, and the sweep refuses whole — it never falls back to "delete what we could read".
 *
 * The roots the store can derive from project state (records, uses, links, declined files) are built here by
 * {@link stateRetentionRoots}; the roots that live in the host (undo groups, checkpoints, the pending and
 * editor-history journals, retained snapshots) are supplied by the host through the
 * {@link AssetDeletionPort} it injects into the asset port (§6.4.2), and assembled with
 * {@link collectRetention}.
 *
 * Everything here is pure except {@link executeSweep}, {@link planRelinkPairs} and the port adapters, which
 * take the host's ports as parameters. No file is ever removed by this module itself: removal goes through
 * the deletion port, one file at a time, so an interrupted sweep can report each removed and remaining file
 * honestly.
 */

import { panelPictureRefs } from '@caotang/comic';
import {
  collectUses,
  isAssetId,
  parseAssetFileName,
  sha256Hex,
  type AssetLink,
  type ReadAssetLink,
  type UsesSnapshot,
} from '@caotang/pictures';

import { recordsOf, replaceList, type ListUndo } from './picture-registry.js';
import type { ProjectState } from './state.js';

/* ------------------------------------------------------------------ *
 * The retention snapshot and the root providers (§6.4.2, §6.6.1)
 * ------------------------------------------------------------------ */

/**
 * What a sweep reads before it removes anything (§6.4.2). `authoritative: false` means at least one root
 * could not enumerate, and `reasons` names the root per id — or, when not authoritative, names the roots
 * that refused. The sweep refuses whole on a non-authoritative snapshot and removes nothing.
 */
export interface AssetRetentionSnapshot {
  readonly authoritative: boolean;
  readonly ids: ReadonlySet<string>;
  readonly reasons: readonly string[];
}

/** What one root provider returns: the ids it retains with the reason per id, or a refusal it cannot enumerate. */
export type RetentionRootListing =
  | { readonly authoritative: true; readonly ids: ReadonlyMap<string, readonly string[]> }
  | { readonly authoritative: false; readonly reason: string };

/**
 * One named place that can still name a picture file (undo groups, checkpoints, the pending journal, …).
 * A provider that cannot enumerate its roots returns `authoritative: false`; the sweep then refuses rather
 * than assume the root is empty.
 */
export interface RetentionRoot {
  readonly name: string;
  list(): Promise<RetentionRootListing>;
}

/** A root that already knows its ids: always authoritative. */
export function idsRetentionRoot(name: string, entries: Iterable<readonly [string, readonly string[]]>): RetentionRoot {
  const ids = new Map<string, readonly string[]>(entries);
  return { name, list: async () => ({ authoritative: true, ids }) };
}

/** A root whose retained ids are read out of texts (bodies, journal entries): `assets/a_….png` spellings count. */
export function textsRetentionRoot(name: string, texts: readonly string[] | (() => Promise<readonly string[]>)): RetentionRoot {
  return {
    name,
    list: async () => {
      const given = typeof texts === 'function' ? await texts() : texts;
      const ids = new Map<string, string[]>();
      for (const text of given) {
        for (const id of assetIdsInText(text)) {
          const list = ids.get(id);
          if (list === undefined) ids.set(id, ['named in text']);
          else if (!list.includes('named in text')) ids.set(id, [...list, 'named in text']);
        }
      }
      return { authoritative: true, ids };
    },
  };
}

/** A root whose retained ids are read out of a JSON value (an undo command's params, a manifest snapshot). */
export function valueRetentionRoot(name: string, value: unknown | (() => Promise<unknown>)): RetentionRoot {
  return {
    name,
    list: async () => {
      const given = typeof value === 'function' ? await value() : value;
      const ids = new Map<string, string[]>();
      for (const id of assetIdsInValue(given)) ids.set(id, ['named in a stored value']);
      return { authoritative: true, ids };
    },
  };
}

/** A root that cannot enumerate: the sweep must refuse while this root exists. Never treated as empty. */
export function refusingRetentionRoot(name: string, reason: string): RetentionRoot {
  return { name, list: async () => ({ authoritative: false, reason }) };
}

/** Merges every root into one snapshot. Any refusal or throw makes the whole snapshot non-authoritative. */
export async function collectRetention(roots: readonly RetentionRoot[]): Promise<AssetRetentionSnapshot> {
  const ids = new Set<string>();
  const reasons: string[] = [];
  for (const root of roots) {
    let listing: RetentionRootListing;
    try {
      listing = await root.list();
    } catch (failure) {
      return { authoritative: false, ids: new Set(), reasons: [`${root.name}: ${failure instanceof Error ? failure.message : String(failure)}`] };
    }
    if (!listing.authoritative) {
      return { authoritative: false, ids: new Set(), reasons: [`${root.name} could not list what it retains (${listing.reason})`] };
    }
    for (const [id, why] of listing.ids) {
      ids.add(id);
      for (const reason of why) reasons.push(`${id} — ${root.name}: ${reason}`);
    }
  }
  return { authoritative: true, ids, reasons };
}

/* ------------------------------------------------------------------ *
 * Scanners: what names a picture
 * ------------------------------------------------------------------ */

/** An `assets/a_XXXXXXXXXX.png` spelling anywhere in a text (the inline form, with or without `../`). */
const ASSET_PATH_IN_TEXT = /assets\/(a_[0-9A-HJKMNP-TV-Z]{10})\.(?:png|jpg|webp)\b/g;

/** Every asset id a text spells as a path (`../assets/a_….png`, `assets/a_….png`). */
export function assetIdsInText(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(ASSET_PATH_IN_TEXT)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/**
 * Every asset id a JSON value names: a string that **is** an asset id (`assetId: "a_…"`), and the path
 * spellings inside longer strings. Recursive, total, never throws.
 */
export function assetIdsInValue(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      if (isAssetId(node)) ids.add(node);
      for (const id of assetIdsInText(node)) ids.add(id);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(value);
  return [...ids];
}

/** The JSON paths at which `value` still names `assetId` — used to refuse an unknown reference shape. */
export function assetIdPathsIn(value: unknown, assetId: string, at = 'manifest'): string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (node === assetId || node.includes(`assets/${assetId}.`)) found.push(path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, item] of Object.entries(node)) {
        // A paragraph anchor's `exact`, `prefix` and `suffix` are **the writer's own prose**, captured verbatim
        // (pictures.md §2.3), so an image's Markdown in the sentence above a link appears there as text. That is not a
        // reference the batch has to rewrite: the body rewrite moves it, and the anchor is recaptured from the new body.
        // Treating it as one refused every working-copy batch for a picture whose Markdown sat in a neighbouring paragraph.
        if (key === 'anchor') continue;
        visit(item, `${path}.${key}`);
      }
    }
  };
  visit(value, at);
  return found;
}

/* ------------------------------------------------------------------ *
 * The roots the store derives from project state
 * ------------------------------------------------------------------ */

/** The asset ids a shot's vendor prompt references name (`shot.vendorRefs[vendor].references[].assetId`). */
function vendorRefsOfShot(shot: unknown): string[] {
  if (typeof shot !== 'object' || shot === null) return [];
  const vendorRefs = (shot as Record<string, unknown>)['vendorRefs'];
  if (typeof vendorRefs !== 'object' || vendorRefs === null) return [];
  const ids: string[] = [];
  for (const entry of Object.values(vendorRefs)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const references = (entry as Record<string, unknown>)['references'];
    if (!Array.isArray(references)) continue;
    for (const reference of references) {
      if (typeof reference !== 'object' || reference === null) continue;
      const assetId = (reference as Record<string, unknown>)['assetId'];
      if (typeof assetId === 'string' && isAssetId(assetId)) ids.push(assetId);
    }
  }
  return ids;
}

/**
 * The picture uses of a project state, as `@caotang/pictures` takes them: the cover, every shot's image, the
 * codex visual references, every inline image parsed out of every stored body, the vendor prompt references,
 * the comic panels and every link whatever its role or target — an orphaned or unknown-shaped link is still
 * the writer's link. The store reads the same function the descriptor's refusal reads, so the two agree.
 */
export function usesSnapshotOfState(state: ProjectState): UsesSnapshot {
  const inline: { assetId: string; nodeId: string }[] = [];
  for (const [nodeId, document] of state.documents) {
    for (const assetId of assetIdsInText(document.body)) inline.push({ assetId, nodeId });
  }
  const vendor: { assetId: string; owner: { kind: 'shot'; nodeId: string } }[] = [];
  for (const node of state.manifest.tree) {
    for (const assetId of vendorRefsOfShot(node.shot)) vendor.push({ assetId, owner: { kind: 'shot', nodeId: node.id } });
  }
  return {
    coverAssetId: state.manifest.project?.coverAssetId,
    nodes: state.manifest.tree.map((node) => ({ id: node.id, shot: node.shot })),
    codex: (state.manifest.codex ?? []).map((entry) => ({ id: entry.id, visualRefs: entry.visualRefs })),
    links: state.manifest.assetLinks ?? [],
    inline,
    vendor,
    panels: state.manifest.tree.flatMap((node) =>
      panelPictureRefs(node.comicPage).map((ref) => ({ assetId: ref.assetId, nodeId: node.id, ...(ref.panelId === undefined ? {} : { panelId: ref.panelId }) })),
    ),
  };
}

/** The roots the store can enumerate from the state alone: the registry records, every use and link, the declined files' text. */
export function stateRetentionRoots(state: ProjectState): RetentionRoot[] {
  const records = recordsOf(state);
  const uses = collectUses(usesSnapshotOfState(state));
  return [
    idsRetentionRoot(
      'registry records',
      records.map((record) => [record.id, [`record ${record.file}`]] as const),
    ),
    idsRetentionRoot(
      'uses and links',
      [...uses.entries()].map(([id, list]) => [id, list.map((use) => use.kind)] as const),
    ),
    textsRetentionRoot('declined files', [...state.declinedText.values()]),
  ];
}

/* ------------------------------------------------------------------ *
 * The sweep (§6.6.1): preview, recheck, remove only what no root names
 * ------------------------------------------------------------------ */

/** One file the sweep offers to remove: no record, no use, no retention root names it. */
export interface SweepCandidate {
  /** The file name under `assets/` (`a_….png`). */
  readonly file: string;
  /** `assets/a_….png`. */
  readonly path: string;
  readonly assetId: string;
}

export type SweepPreview =
  | { readonly ok: true; readonly candidates: readonly SweepCandidate[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The exact candidates of one sweep, computed purely from the listing, the state and the retention snapshot.
 * Refuses when the listing or the snapshot is not authoritative — the sweep never deletes against a partial
 * folder listing, and never assumes an unreadable root is empty. Files that are not well-named pictures are
 * left alone: the loaders ignore them, so the sweep does too.
 */
export function previewSweep(input: {
  readonly listing: { readonly authoritative: boolean; readonly files: readonly string[] };
  readonly state: ProjectState;
  readonly retention: AssetRetentionSnapshot;
}): SweepPreview {
  if (!input.listing.authoritative) {
    return { ok: false, reason: 'the listing of assets/ is not authoritative, so a file could only look absent' };
  }
  if (!input.retention.authoritative) {
    return { ok: false, reason: `a retention root could not be read, so nothing is known to be unreferenced: ${input.retention.reasons.join('; ')}` };
  }
  const records = recordsOf(input.state);
  const recordIds = new Set(records.map((record) => record.id));
  const recordFiles = new Set(records.map((record) => record.file));
  const uses = collectUses(usesSnapshotOfState(input.state));
  const candidates: SweepCandidate[] = [];
  for (const name of input.listing.files) {
    const parsed = parseAssetFileName(name);
    if (parsed === undefined) continue;
    if (recordIds.has(parsed.assetId) || recordFiles.has(name)) continue;
    if (uses.has(parsed.assetId)) continue;
    if (input.retention.ids.has(parsed.assetId)) continue;
    candidates.push({ file: name, path: `assets/${name}`, assetId: parsed.assetId });
  }
  return { ok: true, candidates };
}

/** The host side of a sweep: the listing, the retention inventory and the removal, all through ports. */
export interface SweepPort {
  list(): Promise<{ readonly authoritative: boolean; readonly files: readonly string[] }>;
  listRetention(): Promise<AssetRetentionSnapshot>;
  /** Removes the named files and returns the ones actually removed. */
  remove(paths: readonly string[]): Promise<readonly string[]>;
}

/**
 * The removal half of the asset port (§6.4.2): separate from writing, because a writer-only port cannot
 * answer "is this file safe to delete". `listRetention` is the retention inventory the sweep reads;
 * `remove` deletes the named project-relative files (`assets/a_….png`) and returns the ones actually removed.
 * Thumbnails and the app database are never touched by it.
 */
export interface AssetDeletionPort {
  listRetention(): Promise<AssetRetentionSnapshot>;
  remove(paths: readonly string[]): Promise<readonly string[]>;
}

const fileGates = new WeakMap<object, Promise<unknown>>();

/**
 * Runs `task` after every earlier task on the same `key` (the host's asset port) has settled. A command that writes a picture file
 * before a record names it leaves the file unrecorded for as long as it awaits, and a sweep running then would take it for an orphan,
 * so the commands that write files and the sweep take turns instead of overlapping.
 */
export function withAssetFileGate<T>(key: object, task: () => Promise<T>): Promise<T> {
  const prior = fileGates.get(key) ?? Promise.resolve();
  const run = prior.then(task);
  fileGates.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** What a sweep did: the exact candidates it previewed, and each file's outcome. */
export interface SweepReport {
  /** Set when the sweep refused whole and removed nothing. */
  readonly refused?: string;
  readonly candidates: number;
  readonly removed: readonly string[];
  readonly remaining: readonly string[];
  /** Set when a removal failed part-way; `remaining` then names every file not removed, including the failed one. */
  readonly interrupted?: string;
}

/**
 * Runs one sweep: preview the exact candidates, then **re-read the listing and the retention roots
 * immediately before removal** and remove only the files that are still candidates. Each file is removed on
 * its own, so an interruption reports every removed and remaining file honestly. A refused sweep removes
 * nothing.
 */
export async function executeSweep(state: ProjectState, port: SweepPort): Promise<SweepReport> {
  const empty: SweepReport = { candidates: 0, removed: [], remaining: [] };
  const first = previewSweep({ listing: await port.list(), state, retention: await port.listRetention() });
  if (!first.ok) return { ...empty, refused: first.reason };
  // The recheck: a root that appeared, a listing that changed, or a root that became unreadable between the
  // preview and the removal stops the file from being deleted.
  const listing = await port.list();
  const retention = await port.listRetention();
  const again = previewSweep({ listing, state, retention });
  if (!again.ok) return { ...empty, refused: again.reason };
  const wanted = new Set(first.candidates.map((candidate) => candidate.path));
  const still = again.candidates.filter((candidate) => wanted.has(candidate.path));
  const removed: string[] = [];
  const remaining: string[] = [];
  let interrupted: string | undefined;
  for (const candidate of still) {
    // A record or a use that appeared since the recheck, from a command this sweep is not gated against, keeps its file.
    const live = previewSweep({ listing: { authoritative: true, files: [candidate.file] }, state, retention });
    if (!live.ok || live.candidates.length === 0) {
      remaining.push(candidate.path);
      continue;
    }
    try {
      const gone = await port.remove([candidate.path]);
      if (gone.includes(candidate.path)) removed.push(candidate.path);
      else remaining.push(candidate.path);
    } catch (failure) {
      remaining.push(candidate.path);
      interrupted = failure instanceof Error ? failure.message : String(failure);
      break;
    }
  }
  for (const candidate of first.candidates) {
    if (!removed.includes(candidate.path) && !remaining.includes(candidate.path)) remaining.push(candidate.path);
  }
  return { candidates: first.candidates.length, removed, remaining, ...(interrupted === undefined ? {} : { interrupted }) };
}

/* ------------------------------------------------------------------ *
 * Rename-by-hash re-link (§6.3)
 * ------------------------------------------------------------------ */

export interface RelinkPair {
  readonly assetId: string;
  /** The file name under `assets/` the record now points at. */
  readonly file: string;
}

export type RelinkPlan = { readonly pairs: readonly RelinkPair[] } | { readonly refusal: string };

/**
 * The rename-by-hash pairs: every record whose file is absent from an **authoritative** listing, matched
 * against an unrecorded listed file whose bytes hash to the record's `sha256`. Never by name similarity. A
 * non-authoritative listing refuses the plan rather than match against a partial folder.
 */
export async function planRelinkPairs(
  state: ProjectState,
  port: { list(): Promise<{ readonly authoritative: boolean; readonly files: readonly string[] }>; readBytes(path: string): Promise<Uint8Array | null | undefined> },
  hash: (bytes: Uint8Array) => Promise<string> = sha256Hex,
): Promise<RelinkPlan> {
  const listing = await port.list();
  if (!listing.authoritative) return { refusal: 'the listing of assets/ is not authoritative, so a renamed file cannot be told from a missing one' };
  const records = recordsOf(state);
  const recordIds = new Set(records.map((record) => record.id));
  const recordFiles = new Set(records.map((record) => record.file));
  const pairs: RelinkPair[] = [];
  for (const record of records) {
    if (listing.files.includes(record.file)) continue;
    for (const name of [...listing.files].sort()) {
      if (recordFiles.has(name)) continue;
      const parsed = parseAssetFileName(name);
      if (parsed === undefined || recordIds.has(parsed.assetId)) continue;
      const bytes = await port.readBytes(`assets/${name}`);
      if (bytes === undefined || bytes === null) continue;
      if ((await hash(bytes)) === record.sha256) {
        pairs.push({ assetId: record.id, file: name });
        break;
      }
    }
  }
  return { pairs };
}

/**
 * Points the records at their new files. The caller has verified each pair's bytes hash to the record's
 * `sha256` **before** calling this, so the metadata changes only after verification. Returns the list undo a
 * compensation needs to put the old file names back.
 */
export function applyRelink(state: ProjectState, pairs: readonly RelinkPair[], stamp: string): ListUndo {
  const byId = new Map(pairs.map((pair) => [pair.assetId, pair.file]));
  const records = recordsOf(state);
  const next = records.map((record) => {
    const file = byId.get(record.id);
    return file === undefined || file === record.file ? record : { ...record, file, updatedAt: stamp };
  });
  return replaceList(state, 'assets', next, pairs.map((pair) => pair.assetId));
}

/* ------------------------------------------------------------------ *
 * Bulk working copies (§6.4 step 3): new immutable files, every
 * supported reference updated in one captured batch
 * ------------------------------------------------------------------ */

/** Rewrites every `assets/<fromFile>` spelling in a body to `assets/<toFile>`. */
export function rewriteInlineRefs(body: string, fromFile: string, toFile: string): string {
  if (fromFile === toFile) return body;
  return body.split(`assets/${fromFile}`).join(`assets/${toFile}`);
}

/**
 * The inline references to one asset id in a body whose extension does not match the record's file — a
 * reference shape this build cannot rewrite safely, so the batch refuses rather than guess.
 */
export function unknownInlineShapes(body: string, assetId: string, fileExtension: string): string[] {
  const shapes: string[] = [];
  const pattern = new RegExp(`assets/(${assetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\.(\\w+)`, 'g');
  for (const match of body.matchAll(pattern)) {
    const extension = match[2];
    if (extension !== fileExtension) shapes.push(match[0]);
  }
  return shapes;
}

/** The fields of a manifest that reference an asset id and that a working-copy batch rewrites. */
export interface RewrittenRefs {
  /** `manifest.project.coverAssetId`, before the batch. */
  readonly cover: string | null | undefined;
  /** The tree nodes whose `shot.image` named the asset, by node id. */
  readonly shots: ReadonlyMap<string, unknown>;
  /** The codex entries whose `visualRefs` named it, by entry id. */
  readonly codex: ReadonlyMap<string, unknown>;
  /** The comic-page nodes whose panels named it, by node id. */
  readonly panels: ReadonlyMap<string, unknown>;
  /** The shot nodes whose vendor references named it, by node id. */
  readonly vendor: ReadonlyMap<string, unknown>;
}

/**
 * Reads the typed references to `assetId` out of a manifest, tolerantly: anything stored is read as it lies,
 * so a reference the writer's newer build wrote is still found. Returns the references found, so the caller
 * can rewrite them and then refuse what is left (an unknown shape) via {@link assetIdPathsIn}.
 */
export function typedRefsOf(manifest: ProjectState['manifest'], assetId: string): RewrittenRefs {
  const shots = new Map<string, unknown>();
  const panels = new Map<string, unknown>();
  const vendor = new Map<string, unknown>();
  for (const node of manifest.tree) {
    const shot = node.shot as Record<string, unknown> | undefined;
    if (shot !== undefined && shot['image'] === assetId) shots.set(node.id, shot['image']);
    if (panelPictureRefs(node.comicPage).some((ref) => ref.assetId === assetId)) panels.set(node.id, node.comicPage);
    if (vendorRefsOfShot(shot).includes(assetId)) vendor.set(node.id, shot);
  }
  const codex = new Map<string, unknown>();
  for (const entry of manifest.codex ?? []) {
    if (entry.visualRefs?.includes(assetId) === true) codex.set(entry.id, entry.visualRefs);
  }
  return { cover: manifest.project?.coverAssetId, shots, codex, panels, vendor };
}

/** Rewrites every typed reference to `fromId` in the manifest to `toId`. Mutates the manifest's own arrays and fields. */
export function rewriteTypedRefs(manifest: ProjectState['manifest'], fromId: string, toId: string, options: { readonly links?: boolean } = {}): void {
  const record = manifest as unknown as Record<string, unknown>;
  const project = record['project'];
  if (typeof project === 'object' && project !== null && (project as Record<string, unknown>)['coverAssetId'] === fromId) {
    (project as Record<string, unknown>)['coverAssetId'] = toId;
  }
  for (const node of manifest.tree) {
    const shot = node.shot as Record<string, unknown> | undefined;
    if (shot !== undefined && shot['image'] === fromId) shot['image'] = toId;
    if (shot !== undefined) {
      const vendorRefs = shot['vendorRefs'];
      if (typeof vendorRefs === 'object' && vendorRefs !== null) {
        for (const entry of Object.values(vendorRefs)) {
          if (typeof entry !== 'object' || entry === null) continue;
          const references = (entry as Record<string, unknown>)['references'];
          if (!Array.isArray(references)) continue;
          for (const reference of references) {
            if (typeof reference === 'object' && reference !== null && (reference as Record<string, unknown>)['assetId'] === fromId) {
              (reference as Record<string, unknown>)['assetId'] = toId;
            }
          }
        }
      }
    }
    const page = node.comicPage as Record<string, unknown> | undefined;
    if (page !== undefined && Array.isArray(page['panels'])) {
      for (const panel of page['panels']) {
        if (typeof panel === 'object' && panel !== null && (panel as Record<string, unknown>)['assetId'] === fromId) {
          (panel as Record<string, unknown>)['assetId'] = toId;
        }
      }
    }
  }
  for (const entry of manifest.codex ?? []) {
    if (Array.isArray(entry.visualRefs)) {
      entry.visualRefs = entry.visualRefs.map((ref) => (ref === fromId ? toId : ref));
    }
  }
  if (options.links === false) return;
  const links = manifest.assetLinks;
  if (Array.isArray(links)) {
    for (const link of links as (AssetLink | ReadAssetLink)[]) {
      if (link.assetId === fromId) (link as { assetId: string }).assetId = toId;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Storage budget (§6.1) and the bundle's file set (§6.5)
 * ------------------------------------------------------------------ */

/** The project's soft budget for picture bytes: 500 MiB, warned about in Settings › Data (§6.1). */
export const PICTURE_STORAGE_BUDGET_BYTES = 500 * 1024 * 1024;

export interface PictureStorageReport {
  readonly recordCount: number;
  readonly totalBytes: number;
  readonly budgetBytes: number;
  /** True when the pictures are over the soft budget; a warning, never a refusal. */
  readonly overBudget: boolean;
}

/** The project's picture weight: the sum of the records' bytes against the 500 MiB soft budget. */
export function pictureStorageReport(state: ProjectState): PictureStorageReport {
  const records = recordsOf(state);
  const totalBytes = records.reduce((sum, record) => sum + (typeof record.bytes === 'number' ? record.bytes : 0), 0);
  return { recordCount: records.length, totalBytes, budgetBytes: PICTURE_STORAGE_BUDGET_BYTES, overBudget: totalBytes > PICTURE_STORAGE_BUDGET_BYTES };
}

/**
 * The files a bundle carries (§6.5): every file with a record or a use, and nothing else. A used id with no
 * record (a link the record's deletion left, kept as written) still carries the listed file that names it. A
 * file nothing names is left out — the sweep is the writer's, offered before the export, never forced.
 */
export function bundleAssetFileNamesOf(state: ProjectState, listedFiles: readonly string[]): Set<string> {
  const keep = new Set<string>(recordsOf(state).map((record) => record.file));
  const uses = collectUses(usesSnapshotOfState(state));
  for (const name of listedFiles) {
    const parsed = parseAssetFileName(name);
    if (parsed !== undefined && uses.has(parsed.assetId)) keep.add(name);
  }
  return keep;
}

/* ------------------------------------------------------------------ *
 * The undo-capture ledger (§6.6.1 root 4)
 * ------------------------------------------------------------------ */

/**
 * The asset ids an open undo group's captured compensation still names. A compensation is a closure, so the
 * applies that capture one note the ids they captured here, keyed by the dispatch's command id; the host's
 * undo root reads the open groups, reconciles this ledger against the live command ids (so an undone group
 * stops retaining) and scans each inverse command's params with {@link assetIdsInValue}.
 */
export class UndoRetentionLedger {
  private readonly byCommand = new Map<string, { readonly ids: ReadonlySet<string>; readonly reason: string }>();

  note(commandId: string, ids: readonly string[], reason: string): void {
    const kept = ids.filter((id) => isAssetId(id));
    if (kept.length === 0) return;
    const held = this.byCommand.get(commandId);
    const merged = new Set([...(held?.ids ?? []), ...kept]);
    this.byCommand.set(commandId, { ids: merged, reason: held === undefined ? reason : `${held.reason}; ${reason}` });
  }

  idsOf(commandId: string): readonly string[] {
    return [...(this.byCommand.get(commandId)?.ids ?? [])];
  }

  /** Drops every entry whose command is no longer in an open group. */
  reconcile(liveCommandIds: Iterable<string>): void {
    const live = new Set(liveCommandIds);
    for (const commandId of [...this.byCommand.keys()]) {
      if (!live.has(commandId)) this.byCommand.delete(commandId);
    }
  }
}

/** The ids an open undo group retains: the inverse commands' params plus the captures the ledger holds. */
export function undoGroupRetention(groups: readonly { readonly entries: readonly { readonly kind: string; readonly commandId: string; readonly inverse?: unknown }[] }[], ledger: UndoRetentionLedger): { ids: ReadonlyMap<string, readonly string[]> } {
  ledger.reconcile(groups.flatMap((group) => group.entries.map((entry) => entry.commandId)));
  const ids = new Map<string, string[]>();
  const add = (id: string, reason: string): void => {
    const list = ids.get(id);
    if (list === undefined) ids.set(id, [reason]);
    else if (!list.includes(reason)) ids.set(id, [...list, reason]);
  };
  for (const group of groups) {
    for (const entry of group.entries) {
      if (entry.kind === 'inverse' && entry.inverse !== undefined) {
        for (const id of assetIdsInValue(entry.inverse)) add(id, `an open undo group's inverse of ${entry.commandId}`);
      }
      for (const id of ledger.idsOf(entry.commandId)) add(id, `an open undo group's capture of ${entry.commandId}`);
    }
  }
  return { ids };
}
