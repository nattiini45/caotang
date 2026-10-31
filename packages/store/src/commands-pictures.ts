/**
 * The picture registry's applies — [pictures.md §2.4](docs/architecture/pictures.md). Their descriptors are the bus's
 * (`pictureCommands` in `@caotang/bus`, `descriptors-pictures.ts`), so a refusal here is never the first place a bad value is caught.
 *
 * Every command is undoable, with one entry each. The undo is a compensation, not an inverse command, because the changes are not always
 * expressible as a command of the same family: a card replaced turns the old card back into a reference, an import adds records and
 * placements together, and a delete takes a record and every placement of it at once. The capture is the list as it was (the lists are
 * replaced, never edited in place), so one Undo puts back records, placements and their order exactly, and when something else changed the
 * list in between, only the entries this command touched move (`picture-registry.ts`).
 *
 * The two imports are asynchronous: the bytes are written through the host's port before the record names them, and a record is published
 * only when every file of the batch is in place. A file that was written for an import that was then undone stays; the next import of the
 * same bytes adopts it rather than writing it twice.
 */

import {
  ApplyRefusal,
  assetTranscribeDescriptor,
  pictureCommands,
  type ApplyContext,
  type AssetDeleteParams,
  type AssetImportBatchParams,
  type AssetImportItem,
  type AssetImportParams,
  type AssetLinkParams,
  type AssetMakeDocumentLevelParams,
  type AssetRelinkParams,
  type AssetRepinParams,
  type AssetReorderLinksParams,
  type AssetSetLinkMetaParams,
  type AssetSetMetaParams,
  type AssetStoreWorkingCopiesParams,
  type AssetSweepParams,
  type AssetUnlinkParams,
  type CommandApply,
  type CommandRegistry,
} from '@caotang/bus';
import {
  captureParagraphAnchor,
  extensionOfMime,
  mintAssetId,
  nextLinkOrder,
  parseAssetFileName,
  placeLink,
  readPictureHeader,
  removeLink,
  reorderLinks,
  setLinkNote,
  sha256Hex,
  sniffPicture,
  stripPrivateMetadata,
  validateAssetRecord,
  WORKING_COPY_LONG_EDGE,
  type AssetTarget,
  type ReadAssetRecord,
} from '@caotang/pictures';

import type { ApplyClock, ProjectAssetPort } from './commands-project.js';
import { applyAssetTranscribe } from './commands-transcription.js';
import {
  PictureWriteError,
  missingTargets,
  planPictureImport,
  publishPlan,
  undoPublished,
  type PictureRequest,
} from './picture-import.js';
import {
  applyRelink,
  assetIdPathsIn,
  executeSweep,
  planRelinkPairs,
  rewriteInlineRefs,
  rewriteTypedRefs,
  unknownInlineShapes,
  withAssetFileGate,
  type RelinkPair,
  type SweepPort,
  type UndoRetentionLedger,
} from './picture-retention.js';
import { linksOf, recordsOf, replaceList, undoList, type ListUndo } from './picture-registry.js';
import { anchorPortOf, mapLinksThroughWrite, paragraphLinksOfDoc, type AnchorPort } from './body-write.js';
import { nodeById, type ProjectState } from './state.js';

type PictureApply<P> = CommandApply<P, ProjectState>;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The picture a refusal names, when the writer gave it a caption. */
function nameOf(record: ReadAssetRecord): string {
  return record.caption !== undefined && record.caption !== '' ? `"${record.caption}"` : record.file;
}

function affectedNodes(state: ProjectState, targets: readonly (AssetTarget | { kind: string; nodeId?: unknown })[]): { nodeId: string; title: string }[] {
  const seen = new Set<string>();
  const out: { nodeId: string; title: string }[] = [];
  for (const target of targets) {
    const nodeId = (target as { nodeId?: unknown }).nodeId;
    if (typeof nodeId !== 'string' || seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = nodeById(state, nodeId);
    if (node !== undefined) out.push({ nodeId, title: node.title });
  }
  return out;
}

/** The one Undo of a command that changed these lists. */
function compensate(context: ApplyContext, label: string, undo: readonly ListUndo[], state: ProjectState): void {
  context.undo.compensate(label, () => {
    for (const list of [...undo].reverse()) undoList(state, list);
  });
}

function refusedValidation(issues: readonly { message: string }[], target: string): ApplyRefusal {
  return new ApplyRefusal({
    code: 'invalid-params',
    message: issues.map((issue) => issue.message).join('; '),
    target,
    correctiveHint: 'the project changed since the command was checked; read it again and resend',
  });
}

/* ------------------------------------------------------------------ *
 * A record's and a link's own text
 * ------------------------------------------------------------------ */

function applyRecordPatch(record: ReadAssetRecord, patch: AssetSetMetaParams['patch'], stamp: string): ReadAssetRecord {
  const next: Record<string, unknown> = { ...record };
  for (const key of ['caption', 'alt'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === '') delete next[key];
    else next[key] = value;
  }
  if (patch.decorative !== undefined) {
    if (patch.decorative === true) next['decorative'] = true;
    else delete next['decorative'];
  }
  if (patch.tags !== undefined) {
    if (patch.tags === null || patch.tags.length === 0) delete next['tags'];
    else next['tags'] = [...patch.tags];
  }
  if (patch.sourceLabel !== undefined) {
    const source: Record<string, unknown> = { ...(record.source ?? { kind: 'import' }) };
    if (patch.sourceLabel === null || patch.sourceLabel === '') delete source['label'];
    else source['label'] = patch.sourceLabel;
    next['source'] = source;
  }
  next['updatedAt'] = stamp;
  return next as ReadAssetRecord;
}

function assetSetMetaApply(clock: ApplyClock, ledger?: UndoRetentionLedger): PictureApply<AssetSetMetaParams> {
  return (state, params, context) => {
    const records = recordsOf(state);
    const record = records.find((candidate) => candidate.id === params.assetId);
    if (record === undefined) throw new Error(`asset.setMeta reached its apply with no picture "${params.assetId}"`);
    const next = applyRecordPatch(record, params.patch, new Date(clock.now()).toISOString());
    const undo = replaceList(state, 'assets', records.map((candidate) => (candidate === record ? next : candidate)), [params.assetId]);
    const fields = Object.keys(params.patch).map((key) => (key === 'sourceLabel' ? 'source label' : key));
    ledger?.note(context.commandId, [params.assetId], 'a record capture');
    compensate(context, `put back the ${fields.join(', ')} of ${nameOf(record)}`, [undo], state);
    context.report({ affected: [], summary: `changed the ${fields.join(', ')} of ${nameOf(record)}` });
    return { assetId: params.assetId };
  };
}

function assetSetLinkMetaApply(ledger?: UndoRetentionLedger): PictureApply<AssetSetLinkMetaParams> {
  return (state, params, context) => {
    const edit = setLinkNote(linksOf(state), params.linkId, params.patch.note);
    if (!edit.ok) throw refusedValidation(edit.issues, 'linkId');
    const link = linksOf(state).find((candidate) => candidate.id === params.linkId);
    const undo = replaceList(state, 'assetLinks', edit.value.links, [params.linkId]);
    ledger?.note(context.commandId, link === undefined ? [] : [link.assetId], 'a placement capture');
    compensate(context, 'put back the note of a placement', [undo], state);
    context.report({ affected: link === undefined ? [] : affectedNodes(state, [link.target]), summary: params.patch.note === null ? 'cleared a placement note' : 'changed a placement note' });
    return { linkId: params.linkId };
  };
}

/* ------------------------------------------------------------------ *
 * Placing a picture
 * ------------------------------------------------------------------ */

function assetLinkApply(ledger?: UndoRetentionLedger): PictureApply<AssetLinkParams> {
  return (state, params, context) => {
    const placed = placeLink(linksOf(state), {
      assetId: params.assetId,
      target: params.target,
      ...(params.role === undefined ? {} : { role: params.role }),
      ...(params.note === undefined ? {} : { note: params.note }),
    });
    if (!placed.ok) throw refusedValidation(placed.issues, 'target');
    const undo = replaceList(state, 'assetLinks', placed.value.links, placed.value.changes.map((change) => change.linkId));
    const record = recordsOf(state).find((candidate) => candidate.id === params.assetId);
    ledger?.note(context.commandId, [params.assetId], 'a placement capture');
    compensate(context, 'take the picture off where it was placed', [undo], state);
    const demoted = placed.value.changes.length - 1;
    context.report({
      affected: affectedNodes(state, [params.target]),
      summary: `placed ${record === undefined ? 'a picture' : nameOf(record)}${params.role === 'card' ? ' as a card picture' : ''}${demoted > 0 ? `, and the earlier card picture became a reference` : ''}`,
    });
    return { linkId: placed.value.link.id };
  };
}

function assetUnlinkApply(ledger?: UndoRetentionLedger): PictureApply<AssetUnlinkParams> {
  return (state, params, context) => {
    const link = linksOf(state).find((candidate) => candidate.id === params.linkId);
    const removed = removeLink(linksOf(state), params.linkId);
    if (!removed.ok || link === undefined) throw refusedValidation(removed.ok ? [{ message: `there is no placement ${params.linkId}` }] : removed.issues, 'linkId');
    const undo = replaceList(state, 'assetLinks', removed.value.links, [params.linkId]);
    ledger?.note(context.commandId, [link.assetId], 'a placement capture');
    compensate(context, 'put the picture back where it was placed', [undo], state);
    context.report({ affected: affectedNodes(state, [link.target]), summary: 'took a picture off where it was placed' });
    return { linkId: params.linkId };
  };
}

/**
 * Moves one orphaned paragraph placement to its binder item. Re-targeting the existing link keeps its timeline pin and fields a
 * newer reader may have added. A merge keeps the existing document-level link and carries over a pin it does not already hold.
 * Either way the gesture is one state replacement and one compensation, so it never needs two Undo steps or exposes a half-move.
 */
function assetMakeDocumentLevelApply(ledger?: UndoRetentionLedger): PictureApply<AssetMakeDocumentLevelParams> {
  return (state, params, context) => {
    const links = linksOf(state);
    const link = links.find((candidate) => candidate.id === params.linkId);
    const sourceTarget = link?.target as { readonly kind?: unknown; readonly nodeId?: unknown } | undefined;
    if (link === undefined || sourceTarget?.kind !== 'paragraph' || typeof sourceTarget.nodeId !== 'string') throw new Error('asset.makeDocumentLevel passed validation for a placement that is no longer there');
    const target: AssetTarget = { kind: 'node', nodeId: sourceTarget.nodeId };
    const twin = links.find((candidate) => candidate.id !== link.id && candidate.assetId === link.assetId && candidate.target.kind === 'node' && (candidate.target as { readonly nodeId?: unknown }).nodeId === target.nodeId);
    let next: typeof links;
    let touched: string[];
    if (twin === undefined) {
      const moved = {
        ...link,
        target,
        role: link.role === 'source' ? 'source' as const : 'reference' as const,
        order: nextLinkOrder(links, target),
      };
      next = links.map((candidate) => candidate.id === link.id ? moved : candidate);
      touched = [link.id];
    } else {
      const merged = twin.when === undefined && link.when !== undefined ? { ...twin, when: link.when } : twin;
      const removed = removeLink(links.map((candidate) => candidate.id === twin.id ? merged : candidate), params.linkId);
      if (!removed.ok) throw refusedValidation(removed.issues, 'linkId');
      next = removed.value.links;
      touched = merged === twin ? [params.linkId] : [params.linkId, twin.id];
    }
    const undo = replaceList(state, 'assetLinks', next, touched);
    ledger?.note(context.commandId, [link.assetId], 'a document-level placement capture');
    compensate(context, 'put the picture back under its paragraph', [undo], state);
    context.report({ affected: affectedNodes(state, [target]), summary: 'placed a picture on the whole item and took off its lost paragraph placement' });
    return { linkId: twin?.id ?? params.linkId };
  };
}

/**
 * `asset.repin` — re-capture an orphaned or moved paragraph anchor from a selection (§2.3's activation row). The paragraph is the
 * block the selection starts in, captured against the document's body as it is now, with the document's current revision; only the
 * placement's `target.anchor` and its `orphaned`/`moved` marks change, and one undo puts the captured anchor back.
 *
 * A body that no longer holds the selection (the document was rewritten between the writer's look and the click) refuses rather than
 * pin the picture to a paragraph nobody chose.
 */
function assetRepinApply(ledger?: UndoRetentionLedger): PictureApply<AssetRepinParams> {
  return (state, params, context) => {
    const links = linksOf(state);
    const link = links.find((candidate) => candidate.id === params.linkId);
    if (link === undefined) throw new ApplyRefusal({ code: 'not-found', message: `there is no placement "${params.linkId}", so nothing was re-pinned`, target: 'linkId', correctiveHint: 'choose a placement from the picture\'s uses' });
    const target = link.target as { kind?: unknown; nodeId?: unknown; anchor?: unknown } & Record<string, unknown>;
    if (target.kind !== 'paragraph' || typeof target.nodeId !== 'string') {
      throw new ApplyRefusal({ code: 'invalid-params', message: `the placement "${params.linkId}" is not anchored to a paragraph, so nothing was re-pinned`, target: 'linkId', correctiveHint: 're-pin only a placement a paragraph holds' });
    }
    // The marks a re-pin clears are the ones the capture no longer earns: the picture now names the paragraph under the selection.
    const { orphaned: _orphaned, moved: _moved, ...targetRest } = target;
    const document = state.documents.get(target.nodeId);
    if (document === undefined) {
      throw new ApplyRefusal({ code: 'not-found', message: `the document of the placement "${params.linkId}" is no longer in the project, so nothing was re-pinned`, target: 'linkId', correctiveHint: 'choose a placement whose document still exists' });
    }
    const anchor = captureParagraphAnchor(document.body, { from: params.selection.from }, document.revision);
    if (anchor === undefined) {
      throw new ApplyRefusal({ code: 'invalid-params', message: 'the document holds no paragraph at the selection, so nothing was re-pinned', target: 'selection', correctiveHint: 'select a paragraph in the document, then re-pin' });
    }
    const next = links.map((candidate) =>
      candidate.id === params.linkId ? { ...candidate, target: { ...targetRest, anchor } } : candidate,
    );
    const undo = replaceList(state, 'assetLinks', next, [params.linkId]);
    ledger?.note(context.commandId, [link.assetId], 'a re-pin capture');
    compensate(context, 'put the placement back where it was pinned', [undo], state);
    context.report({ affected: affectedNodes(state, [link.target]), summary: 're-pinned a picture to the paragraph under the selection' });
    return { linkId: params.linkId };
  };
}

function assetReorderLinksApply(ledger?: UndoRetentionLedger): PictureApply<AssetReorderLinksParams> {
  return (state, params, context) => {
    const edit = reorderLinks(linksOf(state), params.target, params.orderedIds);
    if (!edit.ok) throw refusedValidation(edit.issues, 'orderedIds');
    const undo = replaceList(state, 'assetLinks', edit.value.links, params.orderedIds);
    ledger?.note(context.commandId, linksOf(state).filter((link) => params.orderedIds.includes(link.id)).map((link) => link.assetId), 'a placement capture');
    compensate(context, 'put the pictures back in their order', [undo], state);
    context.report({ affected: affectedNodes(state, [params.target]), summary: `reordered ${plural(params.orderedIds.length, 'picture', 'pictures')}` });
    return { count: params.orderedIds.length };
  };
}

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

function assetDeleteApply(ledger?: UndoRetentionLedger): PictureApply<AssetDeleteParams> {
  return (state, params, context) => {
    const records = recordsOf(state);
    const record = records.find((candidate) => candidate.id === params.assetId);
    if (record === undefined) throw new Error(`asset.delete reached its apply with no picture "${params.assetId}"`);
    const links = linksOf(state);
    const gone = links.filter((link) => link.assetId === params.assetId);
    const undo: ListUndo[] = [replaceList(state, 'assets', records.filter((candidate) => candidate !== record), [params.assetId])];
    if (gone.length > 0) {
      undo.push(replaceList(state, 'assetLinks', links.filter((link) => link.assetId !== params.assetId), gone.map((link) => link.id)));
    }
    ledger?.note(context.commandId, [params.assetId], 'a delete capture');
    compensate(context, `put ${nameOf(record)} back with its placements`, undo, state);
    context.report({
      affected: affectedNodes(state, gone.map((link) => link.target)),
      summary: `deleted ${nameOf(record)}${gone.length === 0 ? '' : ` and ${plural(gone.length, 'placement', 'placements')}`}; the file stays until it is swept`,
    });
    return { assetId: params.assetId, removedLinks: gone.length };
  };
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

function requestOf(item: AssetImportItem): PictureRequest {
  return {
    stagingId: item.stagingId,
    ...(item.links === undefined ? {} : { links: item.links }),
    ...(item.caption === undefined ? {} : { caption: item.caption }),
    ...(item.alt === undefined ? {} : { alt: item.alt }),
    ...(item.source === undefined ? {} : { source: item.source }),
  };
}

interface ImportedItem {
  assetId: string;
  path: string;
  created: boolean;
  linkIds: string[];
}

/**
 * The import both commands run. The registered undo is one compensation that removes the records and the placements this import made;
 * a picture it reused loses nothing, and its file stays in every case.
 */
async function runImport(
  state: ProjectState,
  assets: ProjectAssetPort,
  clock: ApplyClock,
  context: ApplyContext,
  items: readonly AssetImportItem[],
  largePhotos: AssetImportParams['largePhotos'],
  ledger?: UndoRetentionLedger,
): Promise<ImportedItem[]> {
  // A target that has gone is found before a staged byte is touched.
  for (const item of items) {
    const missing = missingTargets(state, item.links)[0];
    if (missing !== undefined && missing.kind !== 'project') {
      throw new ApplyRefusal({
        code: 'not-found',
        message: `the binder item "${missing.nodeId}" does not exist, so nothing was imported`,
        target: 'links',
        correctiveHint: 'choose an item from the binder',
      });
    }
  }

  const now = new Date(clock.now());
  const plan = await planPictureImport(state, assets, items.map(requestOf), {
    mode: 'strict',
    now,
    ...(largePhotos === undefined ? {} : { largePhotos }),
    randomBytes: assets.randomBytes,
  });

  try {
    await plan.writeFiles();
  } catch (failure) {
    if (!(failure instanceof PictureWriteError)) throw failure;
    const saved = failure.written === 1 ? 'it' : 'them';
    const left = failure.written === 0 ? '' : ` ${plural(failure.written, 'file was', 'files were')} already saved, and no picture names ${saved}; the next import will find ${saved}.`;
    throw new ApplyRefusal({
      code: failure.quota ? 'limit-exceeded' : 'internal',
      message: `${failure.quota ? `there is no room left to keep the pictures (${failure.message})` : `the pictures could not be saved (${failure.message})`}, so nothing was imported.${left} The pictures are still here.`,
      target: 'stagingId',
      correctiveHint: failure.quota ? 'attach a folder or export a bundle to make room, then import again' : 'try again once the project can be written to',
      details: { quota: failure.quota, kept: true, filesWritten: failure.written },
    });
  }

  const published = publishPlan(state, plan, now);
  ledger?.note(context.commandId, [...published.createdRecordIds, ...published.links.map((link) => link.assetId)], 'an import capture');
  context.undo.compensate(`take back ${plural(published.createdRecordIds.length, 'picture', 'pictures')} and ${plural(published.links.length, 'placement', 'placements')}`, () => undoPublished(state, published));
  return published.items.map((item, index) => {
    const wanted = (items[index]?.links ?? []).map((target) => JSON.stringify(target));
    return { ...item, linkIds: published.links.filter((link) => link.assetId === item.assetId && wanted.includes(JSON.stringify(link.target))).map((link) => link.id) };
  });
}

function reportImport(state: ProjectState, context: ApplyContext, items: readonly AssetImportItem[], imported: readonly ImportedItem[]): void {
  const created = imported.filter((item) => item.created).length;
  const reused = imported.length - created;
  const parts = [created > 0 ? `imported ${plural(created, 'picture', 'pictures')}` : undefined, reused > 0 ? `${plural(reused, 'picture', 'pictures')} the project already holds` : undefined];
  context.report({
    affected: affectedNodes(state, items.flatMap((item) => item.links ?? [])),
    summary: parts.filter((part) => part !== undefined).join(' and '),
  });
}

function assetImportApply(clock: ApplyClock, assets: ProjectAssetPort, ledger?: UndoRetentionLedger): PictureApply<AssetImportParams> {
  return async (state, params, context) => {
    const { largePhotos, ...item } = params;
    const [imported] = await withAssetFileGate(assets, () => runImport(state, assets, clock, context, [item], largePhotos, ledger));
    if (imported === undefined) throw new Error('a one-picture import imports one picture');
    reportImport(state, context, [item], [imported]);
    return imported;
  };
}

function assetImportBatchApply(clock: ApplyClock, assets: ProjectAssetPort, ledger?: UndoRetentionLedger): PictureApply<AssetImportBatchParams> {
  return async (state, params, context) => {
    const imported = await withAssetFileGate(assets, () => runImport(state, assets, clock, context, params.items, params.largePhotos, ledger));
    reportImport(state, context, params.items, imported);
    return { items: imported };
  };
}

/* ------------------------------------------------------------------ *
 * Sweep, re-link and the bulk working-copy batch (§6.3, §6.5, §6.6.1)
 * ------------------------------------------------------------------ */

/**
 * `asset.sweep` — the destructive class (pictures.md §6.6.1): confirmed, **not undoable**, no agent tool. The apply previews the
 * exact candidates, re-reads the listing and the retention roots immediately before removal, and removes only files that are
 * still no-record/no-use/no-retention. A root that cannot enumerate refuses the whole sweep and nothing is removed; an
 * interrupted sweep reports each removed and remaining file in its result.
 */
function assetSweepApply(assets: ProjectAssetPort): PictureApply<AssetSweepParams> {
  return async (state, _params, context) => {
    const deletion = assets.deletion;
    const list = assets.list;
    if (deletion === undefined || list === undefined) throw new Error('asset.sweep reached its apply without the host\'s deletion port');
    const port: SweepPort = { list: () => list.call(assets), listRetention: () => deletion.listRetention(), remove: (paths) => deletion.remove(paths) };
    const report = await withAssetFileGate(assets, () => executeSweep(state, port));
    if (report.refused !== undefined) {
      throw new ApplyRefusal({
        code: 'io-error',
        message: `the sweep was refused, so no file was removed: ${report.refused}`,
        target: 'sweep',
        correctiveHint: 'make the named root readable, then sweep again',
      });
    }
    const summary =
      report.removed.length === 0
        ? 'the sweep found no unreferenced picture file'
        : `swept ${plural(report.removed.length, 'picture file', 'picture files')}${report.interrupted === undefined ? '' : `; the sweep stopped early (${report.interrupted}), and ${plural(report.remaining.length, 'file remains', 'files remain')}`}`;
    context.report({ affected: [], summary });
    return {
      candidates: report.candidates,
      removed: [...report.removed],
      remaining: [...report.remaining],
      ...(report.interrupted === undefined ? {} : { interrupted: report.interrupted }),
    };
  };
}

/**
 * `asset.relink` — the rename-by-hash re-link (§6.3). The plan only matches a record whose file is absent from an authoritative
 * listing against an unrecorded file whose bytes hash to the record's `sha256`, and the apply re-verifies each pair's bytes
 * immediately before the record moves: metadata changes only after verification, and a mismatch refuses the whole command with
 * nothing written.
 */
function assetRelinkApply(clock: ApplyClock, assets: ProjectAssetPort, ledger?: UndoRetentionLedger): PictureApply<AssetRelinkParams> {
  return async (state, params, context) => {
    const list = assets.list;
    const readBytes = assets.readBytes;
    if (list === undefined || readBytes === undefined) throw new Error('asset.relink reached its apply without a listing port');
    const plan = await planRelinkPairs(state, { list: () => list.call(assets), readBytes: (path) => readBytes.call(assets, path) });
    if ('refusal' in plan) {
      throw new ApplyRefusal({
        code: 'io-error',
        message: `the pictures could not be re-linked: ${plan.refusal}`,
        target: 'pairs',
        correctiveHint: 'list the project folder again, then re-link against what it holds',
      });
    }
    const wanted = new Map(params.pairs.map((pair) => [pair.assetId, pair.file]));
    const verified: RelinkPair[] = [];
    for (const pair of plan.pairs) {
      if (wanted.get(pair.assetId) !== pair.file) continue;
      // The recheck immediately before the record moves: the file's bytes must still hash to the record's sha256.
      const record = recordsOf(state).find((candidate) => candidate.id === pair.assetId);
      const bytes = await readBytes.call(assets, `assets/${pair.file}`);
      if (record === undefined || bytes === undefined || bytes === null || (await sha256Hex(bytes)) !== record.sha256) {
        throw new ApplyRefusal({
          code: 'revision-conflict',
          message: `the file "${pair.file}" no longer holds the bytes of the picture "${pair.assetId}", so nothing was re-linked`,
          target: 'pairs',
          correctiveHint: 'read the project again and re-link against what the folder holds now',
        });
      }
      verified.push(pair);
    }
    if (verified.length === 0) {
      throw new ApplyRefusal({
        code: 'not-found',
        message: 'none of the named files holds the bytes of its picture, so nothing was re-linked',
        target: 'pairs',
        correctiveHint: 'read the project again and re-link against what the folder holds now',
      });
    }
    const undo = applyRelink(state, verified, new Date(clock.now()).toISOString());
    ledger?.note(context.commandId, verified.map((pair) => pair.assetId), 'a re-link capture');
    compensate(context, `point ${plural(verified.length, 'a picture', 'pictures')} back at the old file ${verified.length === 1 ? 'name' : 'names'}`, [undo], state);
    context.report({ affected: [], summary: `re-linked ${plural(verified.length, 'a renamed picture', 'renamed pictures')} by hash` });
    return { pairs: verified.map((pair) => ({ ...pair })) };
  };
}

interface WorkingCopyPlan {
  readonly record: ReadAssetRecord;
  readonly newId: string;
  readonly newFile: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly workingCopy: { fromBytes: number; fromWidth: number; fromHeight: number };
}

/**
 * `asset.storeWorkingCopies` — the bulk working-copy action (§6.4 step 3). New immutable files and records are written, every
 * supported typed and inline reference is updated in **one captured batch**, and the prior files stay, so one undo puts every
 * reference and record back. A reference shape this build cannot rewrite (an inline spelling with another extension, or a manifest
 * field outside the known ones) refuses the whole batch before anything is written.
 */
function assetStoreWorkingCopiesApply(clock: ApplyClock, assets: ProjectAssetPort, ledger?: UndoRetentionLedger, injected?: AnchorPort): PictureApply<AssetStoreWorkingCopiesParams> {
  // The default is the pure pictures port, exactly as the registry's other applies get it: a host that injects nothing still maps.
  const anchors = injected ?? anchorPortOf({});
  async function storeWorkingCopies(state: ProjectState, params: AssetStoreWorkingCopiesParams, context: ApplyContext): Promise<{ assetIds: string[] }> {
    const process = assets.process;
    const readBytes = assets.readBytes;
    const list = assets.list;
    if (process === undefined || readBytes === undefined || list === undefined) {
      throw new ApplyRefusal({
        code: 'invalid-params',
        message: 'this host cannot make 4096 px working copies, so nothing was changed',
        target: 'assetIds',
        correctiveHint: 'open the project in the app to store working copies',
      });
    }
    const records = recordsOf(state);
    const listing = await list.call(assets);
    const taken = new Set(records.map((record) => record.id));
    for (const name of listing.files) {
      const parsed = parseAssetFileName(name);
      if (parsed !== undefined) taken.add(parsed.assetId);
    }

    // Phase 1: make every working copy. Nothing in the manifest has changed yet.
    const plans: WorkingCopyPlan[] = [];
    for (const assetId of params.assetIds) {
      const record = records.find((candidate) => candidate.id === assetId);
      if (record === undefined) throw new Error(`asset.storeWorkingCopies reached its apply with no picture "${assetId}"`);
      const bytes = await readBytes.call(assets, `assets/${record.file}`);
      if (bytes === undefined || bytes === null) {
        throw new ApplyRefusal({
          code: 'not-found',
          message: `the file of ${nameOf(record)} is not held, so no working copy was made and nothing was changed`,
          target: 'assetIds',
          correctiveHint: 'attach a folder, or import the picture again, then store the working copy',
        });
      }
      const header = readPictureHeader(bytes, record.mime);
      const fromWidth = header.ok ? header.width : record.width;
      const fromHeight = header.ok ? header.height : record.height;
      if (fromWidth === undefined || fromHeight === undefined) {
        throw new ApplyRefusal({
          code: 'invalid-params',
          message: `the size of ${nameOf(record)} is not known, so no working copy was made and nothing was changed`,
          target: 'assetIds',
          correctiveHint: 'open the picture in the app once, then store the working copy',
        });
      }
      const output = await process({ bytes, mime: record.mime, width: fromWidth, height: fromHeight }, { maxEdge: WORKING_COPY_LONG_EDGE, output: 'preserve', jpegQuality: 0.9, flattenAlpha: false, stripMetadata: true });
      const sniffed = sniffPicture(output.bytes);
      const outHeader = sniffed.ok ? readPictureHeader(output.bytes, sniffed.mime) : undefined;
      if (!sniffed.ok || sniffed.mime !== record.mime || outHeader === undefined || !outHeader.ok) {
        throw new ApplyRefusal({
          code: 'invalid-params',
          message: `${nameOf(record)} could not be made into a working copy, so nothing was changed`,
          target: 'assetIds',
          correctiveHint: 'keep the original instead',
        });
      }
      const cleaned = stripPrivateMetadata(output.bytes, sniffed.mime);
      const stored = cleaned.ok ? cleaned.bytes : output.bytes;
      const newId = mintAssetId(taken, assets.randomBytes);
      taken.add(newId);
      plans.push({
        record,
        newId,
        newFile: `${newId}.${extensionOfMime(sniffed.mime)}`,
        bytes: stored,
        sha256: await sha256Hex(stored),
        width: outHeader.displayWidth,
        height: outHeader.displayHeight,
        workingCopy: { fromBytes: bytes.length, fromWidth, fromHeight },
      });
    }

    // Phase 2: refuse unknown reference shapes before anything is written. The probe is a clone, so a refusal changes nothing.
    const refuseUnknownShapes = (): void => {
      const probe = structuredClone(state.manifest);
      for (const plan of plans) rewriteTypedRefs(probe, plan.record.id, plan.newId);
      for (const plan of plans) {
        // The record itself is kept (its bytes stay for undo), so its own `id` is not an unknown shape.
        const left = assetIdPathsIn(probe, plan.record.id).filter((path) => !/^manifest\.assets\[\d+\]\.id$/.test(path));
        if (left.length > 0) {
          throw new ApplyRefusal({
            code: 'invalid-params',
            message: `a stored field this build does not know names ${nameOf(plan.record)} (${left[0]}), so no working copy was made and nothing was changed`,
            target: 'assetIds',
            correctiveHint: 'remove that reference by hand, then store the working copy',
          });
        }
        const extension = parseAssetFileName(plan.record.file)?.extension ?? '';
        for (const document of state.documents.values()) {
          const shapes = unknownInlineShapes(document.body, plan.record.id, extension);
          if (shapes.length > 0) {
            throw new ApplyRefusal({
              code: 'invalid-params',
              message: `a body references ${shapes[0]} in a shape this build cannot rewrite, so no working copy was made and nothing was changed`,
              target: 'assetIds',
              correctiveHint: 'fix the reference in the document, then store the working copy',
            });
          }
        }
      }
    };
    refuseUnknownShapes();

    // Phase 3: write the new files. A failed write leaves the manifest untouched, so the new files are harmless orphans.
    for (const plan of plans) await assets.writeBytes(`assets/${plan.newFile}`, plan.bytes);

    // Every await above let other commands change the project, so Phase 4 starts from what it holds now: a record deleted or replaced
    // in the meantime, a new record that took a minted id, or a reference added in a shape this build cannot rewrite refuses the batch
    // (the written files stay as harmless orphans), and the records the batch adds go onto the current list, not the one read first.
    const current = recordsOf(state);
    const currentOf = new Map<string, ReadAssetRecord>();
    for (const plan of plans) {
      const now = current.find((candidate) => candidate.id === plan.record.id);
      if (now === undefined || now.file !== plan.record.file || now.sha256 !== plan.record.sha256 || current.some((candidate) => candidate.id === plan.newId)) {
        throw new ApplyRefusal({
          code: 'revision-conflict',
          message: `the pictures changed while the working copies were being made, so nothing was changed`,
          target: 'assetIds',
          correctiveHint: 'read the pictures again, then store the working copies',
        });
      }
      currentOf.set(plan.record.id, now);
    }
    refuseUnknownShapes();

    // Phase 4: one captured batch — every supported reference moves to the new records, the old files and records stay.
    const stamp = new Date(clock.now()).toISOString();
    const treeBefore = structuredClone(state.manifest.tree);
    const codexBefore = state.manifest.codex === undefined ? undefined : structuredClone(state.manifest.codex);
    const coverBefore = state.manifest.project.coverAssetId;
    const bodiesBefore = new Map([...state.documents].map(([id, document]) => [id, { body: document.body, revision: document.revision }]));
    const newRecords: ReadAssetRecord[] = [];
    for (const plan of plans) {
      const record: ReadAssetRecord = {
        ...(currentOf.get(plan.record.id) ?? plan.record),
        id: plan.newId,
        file: plan.newFile,
        mime: parseAssetFileName(plan.newFile)?.mime ?? plan.record.mime,
        sha256: plan.sha256,
        bytes: plan.bytes.length,
        width: plan.width,
        height: plan.height,
        workingCopy: plan.workingCopy,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const checked = validateAssetRecord(record);
      if (!checked.ok) throw new Error(`the working-copy record for ${plan.newId} is not valid: ${checked.issues.map((issue) => issue.message).join('; ')}`);
      newRecords.push(record);
    }
    const byOldId = new Map(plans.map((plan) => [plan.record.id, plan]));
    const linksNext = linksOf(state).map((link) => (byOldId.has(link.assetId) ? { ...link, assetId: byOldId.get(link.assetId)!.newId } : link));
    const linksUndo = replaceList(state, 'assetLinks', linksNext, linksOf(state).filter((link) => byOldId.has(link.assetId)).map((link) => link.id));
    // One link undo per document whose paragraph anchors the body rewrite moved; they are applied after `linksUndo` and undone
    // before it, so one Undo puts both the picture ids and the anchors back.
    const bodyLinkUndos: ListUndo[] = [];
    for (const plan of plans) rewriteTypedRefs(state.manifest, plan.record.id, plan.newId, { links: false });
    const assetsUndo = replaceList(state, 'assets', [...current, ...newRecords], newRecords.map((record) => record.id));
    for (const plan of plans) {
      for (const document of state.documents.values()) {
        const next = rewriteInlineRefs(document.body, plan.record.file, plan.newFile);
        if (next !== document.body) {
          // A rewritten inline reference changes the body's length, so the document's paragraph links are mapped across this
          // write as they are across `doc.write` (pictures.md §2.3). Without it a picture attached to a later paragraph would
          // point at the wrong text after every working copy of an earlier picture.
          const priorLinks = paragraphLinksOfDoc(state, document.id);
          const oldBody = document.body;
          document.body = next;
          document.revision += 1;
          if (priorLinks.length > 0) {
            const mapped = mapLinksThroughWrite(state, anchors, document.id, oldBody, next, document.revision);
            if (mapped.changed.length > 0) bodyLinkUndos.push(replaceList(state, 'assetLinks', mapped.next, mapped.changed));
          }
        }
      }
    }
    ledger?.note(context.commandId, [...byOldId.keys(), ...newRecords.map((record) => record.id)], 'a working-copy batch capture');
    // One captured batch: the lists restore through their ListUndos, and the tree, codex, cover and body captures restore with
    // them, so a single Undo puts every reference and record back.
    context.undo.compensate(`put the original ${plural(params.assetIds.length, 'picture', 'pictures')} and every reference back`, () => {
      for (const undo of [assetsUndo, linksUndo, ...bodyLinkUndos].reverse()) undoList(state, undo);
      state.manifest.tree = treeBefore;
      if (codexBefore === undefined) delete (state.manifest as unknown as Record<string, unknown>)['codex'];
      else state.manifest.codex = codexBefore;
      state.manifest.project.coverAssetId = coverBefore;
      for (const [docId, before] of bodiesBefore) {
        const document = state.documents.get(docId);
        if (document !== undefined) {
          document.body = before.body;
          document.revision = before.revision;
        }
      }
    });
    context.report({
      affected: [],
      summary: `stored ${plural(plans.length, 'a working copy', 'working copies')} of ${plural(plans.length, 'a picture', 'pictures')}; the originals stay until they are deleted and swept`,
    });
    return { assetIds: plans.map((plan) => plan.newId) };
  }
  return (state, params, context) => withAssetFileGate(assets, () => storeWorkingCopies(state, params, context));
}

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: PictureApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/**
 * The picture registrations, for the store's registry. The six that change only the manifest are always registered. `asset.import`,
 * `asset.importBatch`, `asset.relink` and `asset.storeWorkingCopies` are registered only when the host injects the asset port, the
 * same way the cover import is: without it the names stay descriptor-only and the bus refuses them as not wired. `asset.sweep` needs
 * the port's deletion half as well, so it is registered only when the host injects that too.
 *
 * `undoRetention` is the ledger the host's undo root reads (§6.6.1 root 4): every apply that captures a compensation which can
 * name a picture notes the ids here, keyed by the dispatch's command id, so an open undo group retains them and an undone one
 * stops.
 */
export function pictureCommandRegistrations(options: {
  readonly clock: ApplyClock;
  readonly assets?: ProjectAssetPort;
  readonly undoRetention?: UndoRetentionLedger;
  /** The paragraph-anchor port of pictures.md §2.3; the working-copy batch maps links through it. */
  readonly anchors?: AnchorPort;
}): Partial<CommandRegistry> {
  const ledger = options.undoRetention;
  const registrations: Partial<CommandRegistry> = {
    'asset.setMeta': { descriptor: pictureCommands.assetSetMeta, apply: narrow(assetSetMetaApply(options.clock, ledger)) },
    'asset.transcribe': { descriptor: assetTranscribeDescriptor, apply: applyAssetTranscribe(options.clock, ledger) },
    'asset.setLinkMeta': { descriptor: pictureCommands.assetSetLinkMeta, apply: narrow(assetSetLinkMetaApply(ledger)) },
    'asset.link': { descriptor: pictureCommands.assetLink, apply: narrow(assetLinkApply(ledger)) },
    'asset.unlink': { descriptor: pictureCommands.assetUnlink, apply: narrow(assetUnlinkApply(ledger)) },
    'asset.makeDocumentLevel': { descriptor: pictureCommands.assetMakeDocumentLevel, apply: narrow(assetMakeDocumentLevelApply(ledger)) },
    'asset.repin': { descriptor: pictureCommands.assetRepin, apply: narrow(assetRepinApply(ledger)) },
    'asset.reorderLinks': { descriptor: pictureCommands.assetReorderLinks, apply: narrow(assetReorderLinksApply(ledger)) },
    'asset.delete': { descriptor: pictureCommands.assetDelete, apply: narrow(assetDeleteApply(ledger)) },
  };
  if (options.assets !== undefined) {
    registrations['asset.import'] = { descriptor: pictureCommands.assetImport, apply: narrow(assetImportApply(options.clock, options.assets, ledger)) };
    registrations['asset.importBatch'] = { descriptor: pictureCommands.assetImportBatch, apply: narrow(assetImportBatchApply(options.clock, options.assets, ledger)) };
    registrations['asset.relink'] = { descriptor: pictureCommands.assetRelink, apply: narrow(assetRelinkApply(options.clock, options.assets, ledger)) };
    registrations['asset.storeWorkingCopies'] = { descriptor: pictureCommands.assetStoreWorkingCopies, apply: narrow(assetStoreWorkingCopiesApply(options.clock, options.assets, ledger, options.anchors)) };
    if (options.assets.deletion !== undefined) {
      registrations['asset.sweep'] = { descriptor: pictureCommands.assetSweep, apply: narrow(assetSweepApply(options.assets)) };
    }
  }
  return registrations;
}