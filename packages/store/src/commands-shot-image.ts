/**
 * Storyboard: the store's apply of `shot.importImage` (storyboard.md §3.1), the import a card's image slot makes.
 * Its descriptor is the bus's (`shotImageCommands` in `@caotang/bus`, `descriptors-shot-image.ts`), so a refusal here
 * is never the first place a bad value is caught.
 *
 * The apply does three things in order, and only the last one is the shot's. It checks the shot exists and is a shot, so
 * a refused import writes no file. It writes the staged image into `assets/` through the host's port. Then it sets the
 * shot's `image` through the storyboard module's own `shot.setMeta` (the port the store was given), which runs the module's
 * guards and its `expect` check. One undo restores the image the shot had before, so the file stays and the reference goes
 * back, the same rule the cover import keeps.
 *
 * `shot.importImages` is the same import for several pictures, each on its own shot, as one command and so one undo group
 * (storyboard.md §6, the paper-photo round trip). It differs in what it promises. Every shot is checked, and every staged file is
 * taken, sized and sniffed, before a byte is written. A write that fails after earlier files were written refuses the command,
 * sets no `image`, and says how many files were left unused in `assets/`. A shot write that refuses after others succeeded puts
 * those back before it refuses. The one undo entry puts every shot's stored value back; the files stay.
 *
 * The storyboard module is injected, not imported, for the reason every other port is: it depends on this package.
 */

import { newId } from '@caotang/ids';
import {
  ApplyRefusal,
  shotImageCommands,
  type ApplyContext,
  type Command,
  type CommandApply,
  type CommandRegistry,
  type ShotImportImageParams,
  type ShotImportImagesParams,
} from '@caotang/bus';

import { sniffCoverImage, COVER_MAX_BYTES, type ApplyClock, type ProjectAssetPort } from './commands-project.js';
import type { ShotCommandPort } from './commands.js';
import type { TreeNode } from './manifest.js';
import { nodeById, type ProjectState } from './state.js';

type ImportApply<P> = CommandApply<P, ProjectState>;

/** The node type a shot card is (storyboard.md §2.1). The store does not import the storyboard module to name it. */
const SHOT_NODE_TYPE = 'shot';

/** A new asset id, `a_` and ten Crockford base32 characters, the shape the storyboard's image store uses. */
function mintAssetId(): string {
  return `a_${newId('c').slice(2)}`;
}

/** The inverse command, minted as the user's own gesture, as the store's other inverses are (command-bus §4). */
function inverseCommand<P>(name: 'shot.setMeta', params: P, clock: ApplyClock): Command<P> {
  return { id: newId('cmd'), name, params, issuedBy: 'user', createdAt: clock.now() };
}

/** The shot a node id names, or a refusal that writes nothing. A shot's stored details must be an object (or none), so an image can be set on them. */
function shotToImportOnto(state: ProjectState, nodeId: string): TreeNode {
  const node = nodeById(state, nodeId);
  if (node === undefined || node.type !== SHOT_NODE_TYPE) {
    throw new ApplyRefusal({
      code: 'not-found',
      message: `there is no shot "${nodeId}", so the image was not imported`,
      target: 'nodeId',
      correctiveHint: 'choose a shot card and add the image to that card',
    });
  }
  const stored: unknown = node.shot;
  if (stored !== undefined && stored !== null && (typeof stored !== 'object' || Array.isArray(stored))) {
    throw new ApplyRefusal({
      code: 'invalid-params',
      message: 'the shot’s stored details are not an object, so an image cannot be set on it until they are fixed',
      target: 'nodeId',
      correctiveHint: 'open the shot and save its fields first',
    });
  }
  return node;
}

/** What a staged file is, or a refusal that writes nothing: held, within the size cap, and a picture by its leading bytes. */
function pictureOf(assets: ProjectAssetPort, stagingId: string, which?: string): { readonly bytes: Uint8Array; readonly extension: string } {
  const bytes = assets.staging.take(stagingId);
  if (bytes === undefined) {
    throw new ApplyRefusal({
      code: 'not-found',
      message: `${which ?? 'the image'} is no longer held, so nothing was imported`,
      target: 'stagingId',
      correctiveHint: 'choose the image again',
    });
  }
  if (bytes.length > COVER_MAX_BYTES) {
    throw new ApplyRefusal({
      code: 'limit-exceeded',
      message: `${which ?? 'the image'} is ${Math.round(bytes.length / (1024 * 1024))} MB, and an image may be at most ${COVER_MAX_BYTES / (1024 * 1024)} MB`,
      target: 'stagingId',
      correctiveHint: 'use a smaller image of the same picture',
    });
  }
  const kind = sniffCoverImage(bytes);
  if (kind === undefined) {
    throw new ApplyRefusal({
      code: 'invalid-params',
      message: `${which ?? 'the file'} is not a PNG, JPEG or WebP image, which are the formats a shot can hold`,
      target: 'stagingId',
      correctiveHint: 'choose a PNG, JPEG or WebP file',
    });
  }
  return { bytes, extension: kind.extension };
}

function shotImportImageApply(clock: ApplyClock, assets: ProjectAssetPort, shots: ShotCommandPort): ImportApply<ShotImportImageParams> {
  return async (state, params, context: ApplyContext) => {
    const node = shotToImportOnto(state, params.nodeId);
    const { bytes, extension } = pictureOf(assets, params.stagingId);

    const assetId = mintAssetId();
    const path = `assets/${assetId}.${extension}`;
    await assets.writeBytes(path, bytes);

    // Everything after the await is synchronous, and reads the shot again, because the project may have moved while the
    // file was written. The write goes through the storyboard module's own guard, with the value it expects to replace.
    const current = nodeById(state, params.nodeId);
    const before: unknown = current?.shot ?? null;
    const nextStored: Record<string, unknown> = { ...((before ?? {}) as Record<string, unknown>), image: assetId };
    const applied = shots.apply(
      state,
      'shot.setMeta',
      { nodeId: params.nodeId, stored: nextStored, expect: before },
      new Date(clock.now()),
    );
    if (!applied.ok) throw new ApplyRefusal(applied.error);

    // The inverse swaps the two values, as shot.setMeta's own does. The file it leaves behind is harmless (assets/ is not
    // read for shots that do not name it), and removing it here would make undo depend on a write this apply does not own.
    context.undo.inverse(
      inverseCommand<ShotImportImageInverse>(
        'shot.setMeta',
        { nodeId: params.nodeId, stored: (before ?? null) as Record<string, unknown> | null, expect: nextStored },
        clock,
      ),
    );
    context.report({ affected: [...applied.value.affected], summary: `put an image on "${node.title}"` });
    return { nodeId: params.nodeId, assetId, path };
  };
}

/** One shot a batch changed: what it held before and after, and its stamp before, which is what the batch's one undo puts back. */
interface BatchedShot {
  readonly node: TreeNode;
  readonly before: unknown;
  readonly after: Record<string, unknown>;
  readonly stampBefore: string | undefined;
}

/** Puts a batch's shots back as they were, last first. */
function restoreShots(changed: readonly BatchedShot[]): void {
  for (const { node, before, stampBefore } of [...changed].reverse()) {
    if (before === null || before === undefined) Reflect.deleteProperty(node, 'shot');
    else Object.assign(node, { shot: before });
    if (stampBefore === undefined) Reflect.deleteProperty(node, 'updatedAt');
    else node.updatedAt = stampBefore;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function shotImportImagesApply(clock: ApplyClock, assets: ProjectAssetPort, shots: ShotCommandPort): ImportApply<ShotImportImagesParams> {
  return async (state, params, context: ApplyContext) => {
    // Everything is checked before the first byte is written: each shot, then each staged file (taken, so it is held no longer).
    const staged = params.items.map((item) => {
      const node = shotToImportOnto(state, item.nodeId);
      return { item, node, picture: pictureOf(assets, item.stagingId, `the image for "${node.title}"`) };
    });

    const written: { nodeId: string; assetId: string; path: string }[] = [];
    for (const { item, node, picture } of staged) {
      const assetId = mintAssetId();
      const path = `assets/${assetId}.${picture.extension}`;
      try {
        await assets.writeBytes(path, picture.bytes);
      } catch (failure) {
        const left =
          written.length === 0
            ? ''
            : ` ${plural(written.length, 'file was', 'files were')} already written to the project's images, and no shot names ${written.length === 1 ? 'it' : 'them'}.`;
        throw new ApplyRefusal({
          code: 'internal',
          message: `the image for "${node.title}" could not be saved (${failure instanceof Error ? failure.message : String(failure)}), so no shot was given a picture.${left}`,
          target: 'items',
          correctiveHint: 'drop the pictures again once the project can be written to',
        });
      }
      written.push({ nodeId: item.nodeId, assetId, path });
    }

    // Everything after the last await is synchronous. The shots are read again, because the project may have moved while the files were written.
    const changed: BatchedShot[] = [];
    const affected: { nodeId: string; title: string }[] = [];
    try {
      for (const { nodeId, assetId } of written) {
        const node = shotToImportOnto(state, nodeId);
        const before: unknown = node.shot ?? null;
        const after: Record<string, unknown> = { ...((before ?? {}) as Record<string, unknown>), image: assetId };
        const stampBefore = node.updatedAt;
        const applied = shots.apply(state, 'shot.setMeta', { nodeId, stored: after, expect: before }, new Date(clock.now()));
        if (!applied.ok) {
          throw new ApplyRefusal({
            ...applied.error,
            message: `${applied.error.message} No shot was given a picture; ${plural(written.length, 'file was', 'files were')} written to the project's images, and no shot names ${written.length === 1 ? 'it' : 'them'}.`,
          });
        }
        changed.push({ node, before, after, stampBefore });
        affected.push(...applied.value.affected);
      }
    } catch (failure) {
      // Whatever refused, a write or a shot that is no longer there, the shots already set are put back: all or none.
      restoreShots(changed);
      throw failure;
    }

    // One undo entry for the batch. A shot changed since is not overwritten: the undo throws, and the bus keeps the entry.
    context.undo.compensate(`take the pictures back off ${plural(changed.length, 'shot', 'shots')}`, () => {
      const moved = changed.filter(({ node, after }) => JSON.stringify(node.shot ?? null) !== JSON.stringify(after));
      if (moved.length > 0) {
        throw new Error(`${moved.map(({ node }) => `"${node.title}"`).join(', ')} changed after the pictures were added, so none was put back`);
      }
      restoreShots(changed);
    });
    context.report({ affected, summary: `put images on ${plural(changed.length, 'shot', 'shots')}` });
    return { items: written };
  };
}

/** The params of the inverse `shot.setMeta`, which the bus checks against its own declared keys. */
type ShotImportImageInverse = { nodeId: string; stored: Record<string, unknown> | null; expect: unknown };

/** The apply, narrowed to the registry's state type (the bus does not type project state; see `commands.ts`'s `narrow`). */
function narrow<P>(apply: ImportApply<P>): CommandApply<P, unknown> {
  return apply as CommandApply<P, unknown>;
}

/**
 * The image-import registrations, for the store's registry. `shot.importImage` and `shot.importImages` are registered only when the host
 * injects both ports: the asset port (the bytes) and the storyboard port (the shot's write). Without either the names stay
 * descriptor-only, and the bus refuses them as not wired, so an import is never reachable by accident.
 */
export function shotImageCommandRegistrations(options: {
  readonly clock: ApplyClock;
  readonly assets?: ProjectAssetPort;
  readonly shots?: ShotCommandPort;
}): Partial<CommandRegistry> {
  if (options.assets === undefined || options.shots === undefined) return {};
  return {
    'shot.importImage': {
      descriptor: shotImageCommands.shotImportImage,
      apply: narrow(shotImportImageApply(options.clock, options.assets, options.shots)),
    },
    'shot.importImages': {
      descriptor: shotImageCommands.shotImportImages,
      apply: narrow(shotImportImagesApply(options.clock, options.assets, options.shots)),
    },
  };
}
