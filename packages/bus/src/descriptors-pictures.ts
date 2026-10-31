/**
 * The picture registry's descriptors — [pictures.md §2.4](docs/architecture/pictures.md). The applies are the store's
 * (`packages/store/src/commands-pictures.ts`), reached through the same registry as the rest of the closed set (`registry.ts`).
 *
 * A picture's bytes are never params: the host stages them and the import names the staging id, as `project.importAsset` always has.
 * What a validate can check from the project alone is checked here (the record or link exists, a target node exists, an `expect` still
 * holds, a placement is legal, a delete is not blocked by a typed use); what needs the bytes (the format, the size, the hash) is the
 * apply's, before it writes a file.
 *
 * Every command is undoable and none is an agent tool yet: the imports are `write-confirm` because they consume bytes only the writer's
 * host can stage, the rest are `write-auto` or `write-confirm` as pictures.md §2.4 sets them.
 */

import {
  ASSET_LINK_ROLES,
  ASSET_SOURCE_KINDS,
  PICTURE_LIMITS,
  collectUses,
  deletionBlockers,
  isAssetId,
  parseAssetFileName,
  placeLink,
  reorderLinks,
  validateAssetLink,
  validateLinkNotePatch,
  validateRecordPatch,
  type AssetLink,
  type AssetLinkRole,
  type AssetSource,
  type AssetTarget,
  type LinkNotePatch,
  type PictureUse,
  type ReadAssetLink,
  type ReadAssetRecord,
  type RecordPatch,
  type UsesSnapshot,
} from '@caotang/pictures';

import { panelPictureRefs } from '@caotang/comic';

import type { CommandDescriptor, ValidationSnapshot } from './command.js';
import {
  invalid,
  isRecord,
  limitExceeded,
  notFound,
  requireDeclaredParams,
  requireNonBlankString,
  requireString,
  showValue,
} from './params.js';
import { err, ok, type CommandError, type Result } from './result.js';

/* ------------------------------------------------------------------ *
 * Param shapes
 * ------------------------------------------------------------------ */

/** What the writer chose for pictures above the size prompt (pictures.md §6.4 step 3), asked once for a batch. */
export type LargePhotoChoice = 'keep-originals' | 'working-copies';

export const LARGE_PHOTO_CHOICES: readonly LargePhotoChoice[] = ['keep-originals', 'working-copies'];

/** The most pictures one `asset.importBatch` takes. */
export const ASSET_IMPORT_BATCH_MAX = 200;

/** The most targets one import places a picture at. */
export const ASSET_IMPORT_LINKS_MAX = 50;

/** One staged picture and what to record about it. */
export type AssetImportItem = {
  stagingId: string;
  links?: AssetTarget[];
  caption?: string;
  alt?: string;
  source?: AssetSource;
};

export type AssetImportParams = AssetImportItem & { largePhotos?: LargePhotoChoice };

export type AssetImportBatchParams = { items: AssetImportItem[]; largePhotos?: LargePhotoChoice };

/** `expect` is the record's current value of each field the patch changes, with `null` for a field that holds nothing. */
export type AssetSetMetaParams = { assetId: string; patch: RecordPatch; expect?: RecordPatch };

export type AssetSetLinkMetaParams = { linkId: string; patch: LinkNotePatch; expect?: LinkNotePatch };

export type AssetLinkParams = { assetId: string; target: AssetTarget; role?: AssetLinkRole; note?: string };

export type AssetUnlinkParams = { linkId: string };

/** `asset.makeDocumentLevel`: move one orphaned paragraph placement to its document as one undoable gesture. */
export type AssetMakeDocumentLevelParams = { linkId: string };

/**
 * `asset.repin` (pictures.md §2.3): re-capture an orphaned or moved paragraph anchor from a selection in the document's
 * own UTF-16 offsets. The paragraph is the block the selection starts in, exactly as a first capture reads it.
 */
export type AssetRepinParams = { linkId: string; selection: { from: number; to: number } };

export type AssetReorderLinksParams = { target: AssetTarget; orderedIds: string[] };

export type AssetDeleteParams = { assetId: string };

/** `asset.sweep` takes no params: the candidates come from the retention inventory, never from the caller. */
export type AssetSweepParams = Record<string, never>;

/** One rename-by-hash re-link (§6.3): the record and the file its bytes were found under. */
export type AssetRelinkPair = { assetId: string; file: string };

export type AssetRelinkParams = { pairs: AssetRelinkPair[] };

export type AssetStoreWorkingCopiesParams = { assetIds: string[] };

/** The most renamed pictures one `asset.relink` batch takes. */
export const ASSET_RELINK_PAIRS_MAX = 200;

/** The most pictures one `asset.storeWorkingCopies` batch takes. */
export const ASSET_WORKING_COPIES_MAX = 200;

/* ------------------------------------------------------------------ *
 * What the picture commands read of a snapshot
 * ------------------------------------------------------------------ */

const INLINE_IMAGE = /!\[[^\]]*\]\(\s*<?(?:\.\.\/)?assets\/(a_[0-9A-HJKMNP-TV-Z]{10})\.(?:png|jpg|webp)/g;

/**
 * The picture uses of a project, as `@caotang/pictures` takes them. The store reads the same function on its own state, so the
 * descriptor's refusal and the apply's agree on what a use is.
 */
export function picturesUsesSnapshot(snapshot: ValidationSnapshot): UsesSnapshot {
  const inline: { assetId: string; nodeId: string }[] = [];
  for (const [nodeId, document] of snapshot.documents) {
    for (const match of document.body.matchAll(INLINE_IMAGE)) {
      const assetId = match[1];
      if (assetId !== undefined) inline.push({ assetId, nodeId });
    }
  }
  const panels = snapshot.manifest.tree.flatMap((node) =>
    panelPictureRefs(node.comicPage).map((ref) => ({ assetId: ref.assetId, nodeId: node.id, ...(ref.panelId === undefined ? {} : { panelId: ref.panelId }) })),
  );
  return {
    coverAssetId: snapshot.manifest.project?.coverAssetId,
    nodes: snapshot.manifest.tree.map((node) => ({ id: node.id, shot: node.shot })),
    codex: (snapshot.manifest.codex ?? []).map((entry) => ({ id: entry.id, visualRefs: entry.visualRefs })),
    links: snapshot.manifest.assetLinks ?? [],
    inline,
    panels,
  };
}

function recordOf(snapshot: ValidationSnapshot, assetId: string): ReadAssetRecord | undefined {
  return (snapshot.manifest.assets ?? []).find((record) => record.id === assetId);
}

function linkOf(snapshot: ValidationSnapshot, linkId: string): AssetLink | ReadAssetLink | undefined {
  return (snapshot.manifest.assetLinks ?? []).find((link) => link.id === linkId);
}

/** A use in the words a refusal quotes. */
export function describePictureUse(snapshot: ValidationSnapshot, use: PictureUse): string {
  const title = (nodeId: string): string => snapshot.manifest.tree.find((node) => node.id === nodeId)?.title ?? nodeId;
  switch (use.kind) {
    case 'cover':
      return 'the project cover';
    case 'shot':
      return `the picture of the shot "${title(use.nodeId)}"`;
    case 'codex':
      return `a visual reference of the codex entry "${snapshot.manifest.codex?.find((entry) => entry.id === use.entryId)?.name ?? use.entryId}"`;
    case 'inline':
      return `an inline picture in "${title(use.nodeId)}"`;
    case 'vendor':
      return 'a prompt reference';
    case 'comic-panel':
      return `a comic panel of "${title(use.nodeId)}"`;
    case 'link':
      return `a placement (${use.role}) this build does not know how to remove`;
  }
}

const withIssues = (issues: readonly { message: string }[]): string => issues.map((issue) => issue.message).join('; ');

/* ------------------------------------------------------------------ *
 * Shared readers
 * ------------------------------------------------------------------ */

function readTarget(value: unknown, snapshot: ValidationSnapshot, path: string): Result<AssetTarget, CommandError> {
  if (!isRecord(value)) return invalid(`${path} must be an object naming where the picture goes, got ${showValue(value)}`, 'use {kind: "project"} or {kind: "node", nodeId}', path);
  // A target is checked as the link it will become, so the rules live in one place (`validateAssetLink`).
  const probe = validateAssetLink({ id: 'l_0000000000', assetId: 'a_0000000000', target: value, role: 'reference', order: 10 });
  if (!probe.ok) return invalid(`${path}: ${withIssues(probe.issues)}`, 'use {kind: "project"} or {kind: "node", nodeId}', path);
  const target = probe.value.target;
  if (target.kind !== 'project' && !snapshot.manifest.tree.some((node) => node.id === target.nodeId)) {
    return notFound(`${path} names the binder item "${target.nodeId}", which does not exist`, 'choose an item from the binder', path);
  }
  return ok(target);
}

function readSource(value: unknown, path: string): Result<AssetSource, CommandError> {
  if (!isRecord(value)) return invalid(`${path} must be an object, got ${showValue(value)}`, 'use {kind, label?}', path);
  for (const key of Object.keys(value)) {
    if (!['kind', 'label', 'server', 'tool', 'url'].includes(key)) return invalid(`${path}.${key} is not a field of a picture's source`, 'a source carries kind, label, server, tool and url', `${path}.${key}`);
  }
  const kind = value['kind'];
  if (typeof kind !== 'string' || !(ASSET_SOURCE_KINDS as readonly string[]).includes(kind)) {
    return invalid(`${path}.kind must be one of ${ASSET_SOURCE_KINDS.join(', ')}, got ${showValue(kind)}`, undefined, `${path}.kind`);
  }
  const out: Record<string, unknown> = { kind };
  for (const key of ['label', 'server', 'tool', 'url'] as const) {
    if (value[key] === undefined) continue;
    const text = requireString(value, key, key === 'url' ? 2000 : PICTURE_LIMITS.label);
    if (!text.ok) return invalid(`${path}: ${text.error.message}`, text.error.correctiveHint, `${path}.${key}`);
    out[key] = text.value;
  }
  return ok(out as unknown as AssetSource);
}

function readImportItem(entry: unknown, snapshot: ValidationSnapshot, path: string, keys: readonly string[]): Result<AssetImportItem, CommandError> {
  if (!isRecord(entry)) return invalid(`${path} must be an object with a stagingId, got ${showValue(entry)}`, undefined, path);
  for (const key of Object.keys(entry)) {
    if (!keys.includes(key)) return invalid(`${path}.${key} is not a key of an import`, `an import carries only ${keys.join(', ')}`, `${path}.${key}`);
  }
  const stagingId = requireNonBlankString(entry, 'stagingId', { maxChars: 64 });
  if (!stagingId.ok) return invalid(`${path}: ${stagingId.error.message}`, stagingId.error.correctiveHint, `${path}.stagingId`);
  const item: AssetImportItem = { stagingId: stagingId.value };
  if (entry['caption'] !== undefined) {
    const caption = requireString(entry, 'caption', PICTURE_LIMITS.caption);
    if (!caption.ok) return caption.error.code === 'limit-exceeded' ? limitExceeded(`${path}: ${caption.error.message}`, caption.error.correctiveHint, `${path}.caption`) : invalid(`${path}: ${caption.error.message}`, caption.error.correctiveHint, `${path}.caption`);
    item.caption = caption.value;
  }
  if (entry['alt'] !== undefined) {
    const alt = requireString(entry, 'alt', PICTURE_LIMITS.alt);
    if (!alt.ok) return alt.error.code === 'limit-exceeded' ? limitExceeded(`${path}: ${alt.error.message}`, alt.error.correctiveHint, `${path}.alt`) : invalid(`${path}: ${alt.error.message}`, alt.error.correctiveHint, `${path}.alt`);
    item.alt = alt.value;
  }
  if (entry['source'] !== undefined) {
    const source = readSource(entry['source'], `${path}.source`);
    if (!source.ok) return source;
    item.source = source.value;
  }
  if (entry['links'] !== undefined) {
    const list = entry['links'];
    if (!Array.isArray(list)) return invalid(`${path}.links must be an array of targets, got ${showValue(list)}`, undefined, `${path}.links`);
    if (list.length > ASSET_IMPORT_LINKS_MAX) return limitExceeded(`${path}.links has ${list.length} entries, limit ${ASSET_IMPORT_LINKS_MAX}`, undefined, `${path}.links`);
    const targets: AssetTarget[] = [];
    for (const [index, raw] of list.entries()) {
      const target = readTarget(raw, snapshot, `${path}.links[${index}]`);
      if (!target.ok) return target;
      targets.push(target.value);
    }
    item.links = targets;
  }
  return ok(item);
}

function readLargePhotos(params: Record<string, unknown>): Result<LargePhotoChoice | undefined, CommandError> {
  const value = params['largePhotos'];
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string' || !(LARGE_PHOTO_CHOICES as readonly string[]).includes(value)) {
    return invalid(`params.largePhotos must be one of ${LARGE_PHOTO_CHOICES.join(', ')}, got ${showValue(value)}`, 'answer the large-photo question once for the whole import', 'largePhotos');
  }
  return ok(value as LargePhotoChoice);
}

const ITEM_KEYS = ['stagingId', 'links', 'caption', 'alt', 'source'] as const;

/* ------------------------------------------------------------------ *
 * The descriptors
 * ------------------------------------------------------------------ */

const assetImport: CommandDescriptor<AssetImportParams> = {
  mutates: 'project',
  // The bytes are a file the writer's host staged, which an agent cannot do, so an agent's call is refused as not-found before anything is written.
  agentRisk: 'write-confirm',
  // The undo removes the record and the links this import made; the file stays, so an undone import can be taken again without a second write.
  undo: 'compensable',
  asyncApply: true,
  validate: (params, snapshot): Result<AssetImportParams, CommandError> => {
    const p = requireDeclaredParams('asset.import', params);
    if (!p.ok) return p;
    const item = readImportItem(p.value, snapshot, 'params', [...ITEM_KEYS, 'largePhotos']);
    if (!item.ok) return item;
    const choice = readLargePhotos(p.value);
    if (!choice.ok) return choice;
    return ok({ ...item.value, ...(choice.value === undefined ? {} : { largePhotos: choice.value }) });
  },
};

const assetImportBatch: CommandDescriptor<AssetImportBatchParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  // One entry for the batch: every record and link it made goes in one Undo.
  undo: 'compensable',
  asyncApply: true,
  validate: (params, snapshot): Result<AssetImportBatchParams, CommandError> => {
    const p = requireDeclaredParams('asset.importBatch', params);
    if (!p.ok) return p;
    const list = p.value['items'];
    if (!Array.isArray(list) || list.length === 0) {
      return invalid(`params.items must be a non-empty array of imports, got ${showValue(list)}`, 'pass one entry for each picture', 'items');
    }
    if (list.length > ASSET_IMPORT_BATCH_MAX) {
      return limitExceeded(`params.items has ${list.length} entries, limit ${ASSET_IMPORT_BATCH_MAX}`, `send at most ${ASSET_IMPORT_BATCH_MAX} pictures at once`, 'items');
    }
    const items: AssetImportItem[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      const item = readImportItem(entry, snapshot, `params.items[${index}]`, ITEM_KEYS);
      if (!item.ok) return item;
      if (seen.has(item.value.stagingId)) {
        return invalid(`params.items names the staged picture "${item.value.stagingId}" more than once`, 'give each staged picture one entry', `items[${index}].stagingId`);
      }
      seen.add(item.value.stagingId);
      items.push(item.value);
    }
    const choice = readLargePhotos(p.value);
    if (!choice.ok) return choice;
    return ok({ items, ...(choice.value === undefined ? {} : { largePhotos: choice.value }) });
  },
};

/** The fields of a record a patch can name, read off a record the way `expect` states them. */
function recordFieldValue(record: ReadAssetRecord, key: keyof RecordPatch): unknown {
  switch (key) {
    case 'sourceLabel':
      return record.source?.label ?? null;
    case 'decorative':
      return record.decorative ?? null;
    default:
      return record[key] ?? null;
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function conflict(what: string, key: string): Result<never, CommandError> {
  return err({
    code: 'revision-conflict',
    message: `${what} changed since it was read (${key} is no longer what the change expected), so nothing was changed`,
    target: 'expect',
    correctiveHint: 'read the picture again and resend the change against what it holds now',
  });
}

const assetSetMeta: CommandDescriptor<AssetSetMetaParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetSetMetaParams, CommandError> => {
    const p = requireDeclaredParams('asset.setMeta', params);
    if (!p.ok) return p;
    const assetId = requireNonBlankString(p.value, 'assetId', { maxChars: 64 });
    if (!assetId.ok) return assetId;
    const patch = validateRecordPatch(p.value['patch']);
    if (!patch.ok) return invalid(`params.patch: ${withIssues(patch.issues)}`, 'a patch carries caption, alt, decorative, tags and sourceLabel; a link\'s note belongs to asset.setLinkMeta', 'patch');
    const record = recordOf(snapshot, assetId.value);
    if (record === undefined) return notFound(`there is no picture "${assetId.value}"`, 'choose a picture from the library', 'assetId');
    const out: AssetSetMetaParams = { assetId: assetId.value, patch: patch.value };
    if (p.value['expect'] !== undefined) {
      const expect = p.value['expect'];
      if (!isRecord(expect)) return invalid(`params.expect must be an object of the values the patch replaces, got ${showValue(expect)}`, undefined, 'expect');
      for (const [key, value] of Object.entries(expect)) {
        if (!(key in patch.value)) return invalid(`params.expect.${key} is not a field this patch changes`, 'expect names only the fields the patch names', `expect.${key}`);
        if (!sameValue(recordFieldValue(record, key as keyof RecordPatch), value)) return conflict(`the picture "${assetId.value}"`, key);
      }
      out.expect = expect as RecordPatch;
    }
    return ok(out);
  },
};

const assetSetLinkMeta: CommandDescriptor<AssetSetLinkMetaParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetSetLinkMetaParams, CommandError> => {
    const p = requireDeclaredParams('asset.setLinkMeta', params);
    if (!p.ok) return p;
    const linkId = requireNonBlankString(p.value, 'linkId', { maxChars: 64 });
    if (!linkId.ok) return linkId;
    const patch = validateLinkNotePatch(p.value['patch']);
    if (!patch.ok) return invalid(`params.patch: ${withIssues(patch.issues)}`, 'a link patch carries a note, or null to clear it', 'patch');
    const link = linkOf(snapshot, linkId.value);
    if (link === undefined) return notFound(`there is no placement "${linkId.value}"`, 'choose a placement from the picture\'s uses', 'linkId');
    const out: AssetSetLinkMetaParams = { linkId: linkId.value, patch: patch.value };
    if (p.value['expect'] !== undefined) {
      const expect = validateLinkNotePatch(p.value['expect']);
      if (!expect.ok) return invalid(`params.expect: ${withIssues(expect.issues)}`, 'expect is {note: the note it holds now, or null}', 'expect');
      if (!sameValue(link.note, expect.value.note)) return conflict(`the placement "${linkId.value}"`, 'note');
      out.expect = expect.value;
    }
    return ok(out);
  },
};

const assetLink: CommandDescriptor<AssetLinkParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetLinkParams, CommandError> => {
    const p = requireDeclaredParams('asset.link', params);
    if (!p.ok) return p;
    const assetId = requireNonBlankString(p.value, 'assetId', { maxChars: 64 });
    if (!assetId.ok) return assetId;
    if (recordOf(snapshot, assetId.value) === undefined) return notFound(`there is no picture "${assetId.value}"`, 'choose a picture from the library', 'assetId');
    const target = readTarget(p.value['target'], snapshot, 'params.target');
    if (!target.ok) return target;
    let role: AssetLinkRole | undefined;
    if (p.value['role'] !== undefined) {
      const given = p.value['role'];
      if (typeof given !== 'string' || !(ASSET_LINK_ROLES as readonly string[]).includes(given)) {
        return invalid(`params.role must be one of ${ASSET_LINK_ROLES.join(', ')}, got ${showValue(given)}`, undefined, 'role');
      }
      role = given as AssetLinkRole;
    }
    let note: string | undefined;
    if (p.value['note'] !== undefined) {
      const text = requireString(p.value, 'note', PICTURE_LIMITS.note);
      if (!text.ok) return text;
      note = text.value;
    }
    // The placement is tried on the project's own links, so a refusal here is the one the apply would have made.
    const tried = placeLink(snapshot.manifest.assetLinks ?? [], {
      assetId: assetId.value,
      target: target.value,
      id: 'l_0000000000',
      ...(role === undefined ? {} : { role }),
      ...(note === undefined ? {} : { note }),
    });
    if (!tried.ok) return invalid(`params: ${withIssues(tried.issues)}`, 'check where the picture is already placed', 'target');
    return ok({ assetId: assetId.value, target: target.value, ...(role === undefined ? {} : { role }), ...(note === undefined ? {} : { note }) });
  },
};

const assetUnlink: CommandDescriptor<AssetUnlinkParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetUnlinkParams, CommandError> => {
    const p = requireDeclaredParams('asset.unlink', params);
    if (!p.ok) return p;
    const linkId = requireNonBlankString(p.value, 'linkId', { maxChars: 64 });
    if (!linkId.ok) return linkId;
    if (linkOf(snapshot, linkId.value) === undefined) return notFound(`there is no placement "${linkId.value}"`, 'choose a placement from the picture\'s uses', 'linkId');
    return ok({ linkId: linkId.value });
  },
};

const assetMakeDocumentLevel: CommandDescriptor<AssetMakeDocumentLevelParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetMakeDocumentLevelParams, CommandError> => {
    const p = requireDeclaredParams('asset.makeDocumentLevel', params);
    if (!p.ok) return p;
    const linkId = requireNonBlankString(p.value, 'linkId', { maxChars: 64 });
    if (!linkId.ok) return linkId;
    const link = linkOf(snapshot, linkId.value);
    if (link === undefined) return notFound(`there is no placement "${linkId.value}"`, 'choose a placement from the picture\'s uses', 'linkId');
    const target = link.target as { readonly kind?: unknown; readonly orphaned?: unknown };
    if (target.kind !== 'paragraph' || target.orphaned !== true) {
      return invalid('asset.makeDocumentLevel needs a placement whose paragraph is lost', 'choose a placement under Lost their paragraph', 'linkId');
    }
    return ok({ linkId: linkId.value });
  },
};

const assetReorderLinks: CommandDescriptor<AssetReorderLinksParams> = {
  mutates: 'project',
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetReorderLinksParams, CommandError> => {
    const p = requireDeclaredParams('asset.reorderLinks', params);
    if (!p.ok) return p;
    const target = readTarget(p.value['target'], snapshot, 'params.target');
    if (!target.ok) return target;
    const list = p.value['orderedIds'];
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) {
      return invalid(`params.orderedIds must be an array of placement ids, got ${showValue(list)}`, 'list every placement of the target, in the new order', 'orderedIds');
    }
    const orderedIds = list as string[];
    const tried = reorderLinks(snapshot.manifest.assetLinks ?? [], target.value, orderedIds);
    if (!tried.ok) return invalid(`params.orderedIds: ${withIssues(tried.issues)}`, 'list every placement of the target exactly once', 'orderedIds');
    return ok({ target: target.value, orderedIds });
  },
};

const assetRepin: CommandDescriptor<AssetRepinParams> = {
  mutates: 'project',
  // §2.3's activation action: an orphaned or moved paragraph anchor is re-captured from a selection, in the document's own
  // UTF-16 offsets. Only the placement's anchor moves; one Undo puts the captured anchor back.
  agentRisk: 'write-auto',
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetRepinParams, CommandError> => {
    const p = requireDeclaredParams('asset.repin', params);
    if (!p.ok) return p;
    const linkId = requireNonBlankString(p.value, 'linkId', { maxChars: 64 });
    if (!linkId.ok) return linkId;
    const link = linkOf(snapshot, linkId.value);
    if (link === undefined) return notFound(`there is no placement "${linkId.value}"`, 'choose a placement from the picture\'s uses', 'linkId');
    const target = link.target as { kind?: unknown; nodeId?: unknown };
    if (target.kind !== 'paragraph') {
      return invalid(`the placement "${linkId.value}" is not anchored to a paragraph, so there is nothing to re-pin`, 're-pin only a placement a paragraph holds', 'linkId');
    }
    const raw = p.value['selection'];
    if (!isRecord(raw) || typeof raw['from'] !== 'number' || typeof raw['to'] !== 'number') {
      return invalid(`params.selection must be {from, to} in the document's own offsets, got ${showValue(raw)}`, 'select a paragraph in the document, then re-pin', 'selection');
    }
    const from = raw['from'];
    const to = raw['to'];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      return invalid(`params.selection is ${showValue(raw)}; its offsets must be whole numbers with from ≥ 0 and to ≥ from`, 'select a paragraph in the document, then re-pin', 'selection');
    }
    const document = typeof target.nodeId === 'string' ? snapshot.documents.get(target.nodeId) : undefined;
    if (document === undefined) return notFound(`the document of the placement "${linkId.value}" is no longer in the project`, 'choose a placement whose document still exists', 'linkId');
    if (from > document.body.length) {
      return invalid(`params.selection.from is ${from}, past the end of the document (${document.body.length} characters)`, 'select a paragraph in the document, then re-pin', 'selection.from');
    }
    return ok({ linkId: linkId.value, selection: { from, to } });
  },
};

const assetDelete: CommandDescriptor<AssetDeleteParams> = {
  mutates: 'project',
  // The record and its placements go; the file stays until a sweep. The writer confirms, and the one Undo puts the record and every placement back in order.
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params, snapshot): Result<AssetDeleteParams, CommandError> => {
    const p = requireDeclaredParams('asset.delete', params);
    if (!p.ok) return p;
    const assetId = requireNonBlankString(p.value, 'assetId', { maxChars: 64 });
    if (!assetId.ok) return assetId;
    if (recordOf(snapshot, assetId.value) === undefined) return notFound(`there is no picture "${assetId.value}"`, 'choose a picture from the library', 'assetId');
    const blockers = deletionBlockers(collectUses(picturesUsesSnapshot(snapshot)).get(assetId.value) ?? []);
    if (blockers.length > 0) {
      const named = blockers.map((use) => describePictureUse(snapshot, use));
      return err({
        code: 'invalid-params',
        message: `the picture "${assetId.value}" is still used as ${named.join(', ')}, so it was not deleted`,
        target: 'assetId',
        correctiveHint: 'take the picture off those uses first, then delete it',
        details: { uses: blockers },
      });
    }
    return ok({ assetId: assetId.value });
  },
};

const assetSweep: CommandDescriptor<AssetSweepParams> = {
  mutates: 'project',
  // The destructive class (pictures.md §2.4, §6.6.1): writer-confirmed, **not undoable**, and no harness row — an agent never
  // dispatches it. `never` is that sentence in the bus's own vocabulary: no plan and no card approves it for an agent. The apply
  // refuses whole unless every retention root enumerated, and removes only files no record, no use and no root names.
  agentRisk: 'never',
  undo: 'none',
  asyncApply: true,
  validate: (params): Result<AssetSweepParams, CommandError> => {
    const p = requireDeclaredParams('asset.sweep', params);
    if (!p.ok) return p;
    return ok({});
  },
};

const assetRelink: CommandDescriptor<AssetRelinkParams> = {
  mutates: 'project',
  // Load-time "renamed outside Caotang" re-link by hash (§6.3): metadata only, after the bytes are verified to hash to the record's
  // sha256. One undo puts the old file names back.
  agentRisk: 'write-auto',
  undo: 'compensable',
  asyncApply: true,
  validate: (params, snapshot): Result<AssetRelinkParams, CommandError> => {
    const p = requireDeclaredParams('asset.relink', params);
    if (!p.ok) return p;
    const list = p.value['pairs'];
    if (!Array.isArray(list) || list.length === 0) {
      return invalid(`params.pairs must be a non-empty array of {assetId, file}, got ${showValue(list)}`, 'one pair per renamed picture', 'pairs');
    }
    if (list.length > ASSET_RELINK_PAIRS_MAX) {
      return limitExceeded(`params.pairs has ${list.length} entries, limit ${ASSET_RELINK_PAIRS_MAX}`, `send at most ${ASSET_RELINK_PAIRS_MAX} pairs at once`, 'pairs');
    }
    const pairs: AssetRelinkPair[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of list.entries()) {
      if (!isRecord(entry)) return invalid(`params.pairs[${index}] must be an object with assetId and file, got ${showValue(entry)}`, undefined, `pairs[${index}]`);
      for (const key of Object.keys(entry)) {
        if (!['assetId', 'file'].includes(key)) return invalid(`params.pairs[${index}].${key} is not a key of a re-link pair`, 'a pair carries only assetId and file', `pairs[${index}].${key}`);
      }
      const assetId = requireNonBlankString(entry, 'assetId', { maxChars: 64 });
      if (!assetId.ok) return invalid(`params.pairs[${index}]: ${assetId.error.message}`, assetId.error.correctiveHint, `pairs[${index}].assetId`);
      if (seen.has(assetId.value)) return invalid(`params.pairs names the picture "${assetId.value}" more than once`, 'give each renamed picture one pair', `pairs[${index}].assetId`);
      const file = requireNonBlankString(entry, 'file', { maxChars: 128 });
      if (!file.ok) return invalid(`params.pairs[${index}]: ${file.error.message}`, file.error.correctiveHint, `pairs[${index}].file`);
      const record = recordOf(snapshot, assetId.value);
      if (record === undefined) return notFound(`there is no picture "${assetId.value}"`, 'choose a picture from the library', `pairs[${index}].assetId`);
      const parsed = parseAssetFileName(file.value);
      if (parsed === undefined) {
        return invalid(`params.pairs[${index}].file must be an asset file name (a_XXXXXXXXXX.png, .jpg or .webp), got ${showValue(file.value)}`, undefined, `pairs[${index}].file`);
      }
      // The file may carry a different stem: a file renamed outside Caotang keeps whatever picture name it was given, and the
      // bytes are what the apply verifies (§6.3). A file another record already names cannot be this one's new name.
      if (file.value === record.file) return invalid(`the picture "${assetId.value}" already names the file "${file.value}", so there is nothing to re-link`, undefined, `pairs[${index}].file`);
      if ((snapshot.manifest.assets ?? []).some((other) => other.file === file.value)) {
        return invalid(`the file "${file.value}" is another picture's file, so it cannot be this one's new name`, 're-link only to a file no record names', `pairs[${index}].file`);
      }
      seen.add(assetId.value);
      pairs.push({ assetId: assetId.value, file: file.value });
    }
    return ok({ pairs });
  },
};

const assetStoreWorkingCopies: CommandDescriptor<AssetStoreWorkingCopiesParams> = {
  mutates: 'project',
  // The bulk working-copy action (§6.4 step 3, §6.5's *Store working copies*): new immutable files are written and every supported
  // reference is rewritten in one batch, so the writer confirms and one undo puts every reference and record back.
  agentRisk: 'write-confirm',
  undo: 'compensable',
  asyncApply: true,
  validate: (params, snapshot): Result<AssetStoreWorkingCopiesParams, CommandError> => {
    const p = requireDeclaredParams('asset.storeWorkingCopies', params);
    if (!p.ok) return p;
    const list = p.value['assetIds'];
    if (!Array.isArray(list) || list.length === 0) {
      return invalid(`params.assetIds must be a non-empty array of picture ids, got ${showValue(list)}`, 'name the pictures to store as working copies', 'assetIds');
    }
    if (list.length > ASSET_WORKING_COPIES_MAX) {
      return limitExceeded(`params.assetIds has ${list.length} entries, limit ${ASSET_WORKING_COPIES_MAX}`, `send at most ${ASSET_WORKING_COPIES_MAX} pictures at once`, 'assetIds');
    }
    const assetIds: string[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of list.entries()) {
      if (typeof raw !== 'string' || !isAssetId(raw)) {
        return invalid(`params.assetIds[${index}] must be a picture id (a_…), got ${showValue(raw)}`, 'choose pictures from the library', `assetIds[${index}]`);
      }
      if (seen.has(raw)) return invalid(`params.assetIds names the picture "${raw}" more than once`, 'name each picture once', `assetIds[${index}]`);
      const record = recordOf(snapshot, raw);
      if (record === undefined) return notFound(`there is no picture "${raw}"`, 'choose a picture from the library', `assetIds[${index}]`);
      if (record.workingCopy !== undefined) {
        return invalid(`the picture "${raw}" is already stored as a working copy`, 'choose a picture that is still stored as imported', `assetIds[${index}]`);
      }
      seen.add(raw);
      assetIds.push(raw);
    }
    return ok({ assetIds });
  },
};

export const pictureCommands = {
  assetImport,
  assetImportBatch,
  assetSetMeta,
  assetSetLinkMeta,
  assetLink,
  assetUnlink,
  assetMakeDocumentLevel,
  assetRepin,
  assetReorderLinks,
  assetDelete,
  assetSweep,
  assetRelink,
  assetStoreWorkingCopies,
} as const;
