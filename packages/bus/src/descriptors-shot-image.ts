/**
 * Storyboard: the descriptor of `shot.importImage`, the storyboard's image import. Its apply is
 * the store's (`packages/store/src/commands-shot-image.ts`), reached through the same registry as the rest of the
 * closed set (`registry.ts`).
 *
 * `shot.importImages` is the same import for several pictures at once (the paper-photo round trip, storyboard.md §6): one command, so
 * one undo group. Its apply is the store's too.
 *
 * The apply is asynchronous, because the image is written to `assets/` before the shot names it, so the descriptor
 * is `asyncApply` and runs through `executeAsync`. Validation is pure and total (command-bus §2): it checks the closed
 * key set and the two strings. Whether the node exists and is a shot is the apply's to say, before any byte is written,
 * because only the apply reads the stored project.
 */

import type { CommandDescriptor, ShotImportImageParams, ShotImportImagesParams } from './command.js';
import { ok, type Result, type CommandError } from './result.js';
import { invalid, isRecord, limitExceeded, requireDeclaredParams, requireNonBlankString, showValue } from './params.js';

export const shotImportImage: CommandDescriptor<ShotImportImageParams> = {
  mutates: 'project',
  // The image is a file the writer chose, so the gate asks rather than refusing a writer's own picture. An agent cannot stage
  // bytes, so its call is refused as not-found before anything is written, the same as the cover import.
  agentRisk: 'write-confirm',
  undo: 'inverse',
  asyncApply: true,
  validate: (params): Result<ShotImportImageParams, CommandError> => {
    const p = requireDeclaredParams('shot.importImage', params);
    if (!p.ok) return p;
    const nodeId = requireNonBlankString(p.value, 'nodeId', { maxChars: 64 });
    if (!nodeId.ok) return nodeId;
    const stagingId = requireNonBlankString(p.value, 'stagingId', { maxChars: 64 });
    if (!stagingId.ok) return stagingId;
    return ok({ nodeId: nodeId.value, stagingId: stagingId.value });
  },
};

/** The most pictures one `shot.importImages` takes: more than a board or a sheet comfortably holds. */
export const SHOT_IMPORT_IMAGES_MAX = 200;

export const shotImportImages: CommandDescriptor<ShotImportImagesParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  // One entry for the batch: its restore puts every shot's stored value back, so one Undo takes back every picture the batch set.
  undo: 'compensable',
  asyncApply: true,
  validate: (params): Result<ShotImportImagesParams, CommandError> => {
    const p = requireDeclaredParams('shot.importImages', params);
    if (!p.ok) return p;
    const list = p.value['items'];
    if (!Array.isArray(list) || list.length === 0) {
      return invalid(`params.items must be a non-empty array of {nodeId, stagingId}, got ${showValue(list)}`, 'pass one entry for each picture', 'items');
    }
    if (list.length > SHOT_IMPORT_IMAGES_MAX) {
      return limitExceeded(`params.items has ${list.length} entries, limit ${SHOT_IMPORT_IMAGES_MAX}`, `send at most ${SHOT_IMPORT_IMAGES_MAX} pictures at once`, 'items');
    }
    const items: ShotImportImagesParams['items'] = [];
    const shots = new Set<string>();
    for (const [index, entry] of list.entries()) {
      if (!isRecord(entry)) {
        return invalid(`params.items[${index}] must be an object {nodeId, stagingId}, got ${showValue(entry)}`, undefined, `items[${index}]`);
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'nodeId' && key !== 'stagingId') {
          return invalid(`params.items[${index}].${key} is not a key of an item`, 'an item carries only nodeId and stagingId', `items[${index}].${key}`);
        }
      }
      const nodeId = requireNonBlankString(entry, 'nodeId', { maxChars: 64 });
      if (!nodeId.ok) return invalid(`params.items[${index}]: ${nodeId.error.message}`, nodeId.error.correctiveHint, `items[${index}].nodeId`);
      const stagingId = requireNonBlankString(entry, 'stagingId', { maxChars: 64 });
      if (!stagingId.ok) return invalid(`params.items[${index}]: ${stagingId.error.message}`, stagingId.error.correctiveHint, `items[${index}].stagingId`);
      if (shots.has(nodeId.value)) {
        return invalid(`params.items names the shot "${nodeId.value}" more than once`, 'give each shot one picture', `items[${index}].nodeId`);
      }
      shots.add(nodeId.value);
      items.push({ nodeId: nodeId.value, stagingId: stagingId.value });
    }
    return ok({ items });
  },
};
