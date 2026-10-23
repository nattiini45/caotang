/**
 * Applying a storyboard command from a view. Every change goes through here, so the one rule lives in one place:
 * the App's `commitShot` port when it supplies one, else the bus. The bus registers every storyboard command now
 * (`storyboard.create`, `shot.create`, `shot.setMeta`, the `binder.move` that reorders a card and the `binder.create` that
 * makes one), and a view never mutates the state itself (ui-modules §0.1), so each change is the bus's own dispatch, with
 * its undo and its row.
 */

import { createdNodeId, explain } from '../components/actions.js';
import type { ProjectSession } from '../app/session.js';

import type { MediaCommand, MediaPorts, ShotCommitResult } from './ports.js';

export function commitShotCommand(session: ProjectSession, command: MediaCommand, ports: MediaPorts | undefined): ShotCommitResult {
  if (ports?.commitShot !== undefined) return ports.commitShot(command);
  const outcome = dispatchShot(session, command);
  if (!outcome.ok) return { ok: false, message: explain(outcome.error) };
  const createdId = createdNodeId(outcome);
  return createdId === undefined ? { ok: true } : { ok: true, createdId };
}

/**
 * Imports one picture as a shot's image: the file and the shot's `image` are one undo group (`shot.importImage`, storyboard.md
 * §3.1). The bytes come from the writer's own file, so this is the one storyboard path that is asynchronous.
 */
export async function importShotImage(session: ProjectSession, shotId: string, bytes: Uint8Array): Promise<ShotCommitResult> {
  const result = await session.importShotImage(shotId, bytes);
  if (!result.ok) return { ok: false, message: explain(result.error) };
  return { ok: true };
}

/**
 * Imports several pictures, each as its own shot's image, as one command and so one undo step (`shot.importImages`, storyboard.md §6).
 * The command is all or nothing on what it can check first, so a refusal means no shot was given a picture.
 */
export async function importShotImages(
  session: ProjectSession,
  items: readonly { readonly shotId: string; readonly bytes: Uint8Array }[],
): Promise<ShotCommitResult> {
  const result = await session.importShotImages(items.map(({ shotId, bytes }) => ({ nodeId: shotId, bytes })));
  if (!result.ok) return { ok: false, message: explain(result.error) };
  return { ok: true };
}

/** One dispatch per name, so each call's params are checked against that name's own type. */
function dispatchShot(session: ProjectSession, command: MediaCommand) {
  switch (command.name) {
    case 'binder.move':
      return session.dispatch('binder.move', command.params);
    case 'binder.create':
      return session.dispatch('binder.create', command.params);
    case 'storyboard.create':
      return session.dispatch('storyboard.create', command.params);
    case 'shot.create':
      return session.dispatch('shot.create', command.params);
    case 'shot.setMeta':
      return session.dispatch('shot.setMeta', command.params);
  }
}
