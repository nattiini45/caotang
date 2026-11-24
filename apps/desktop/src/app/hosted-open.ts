/**
 * Opening a project a host has handed over. This module is reached only through `await import('./hosted-open.js')` from the app, so that
 * `caotang.app` and the folder app pay nothing for the hosted path in their first load: the adapter, the target and the queue are one lazy
 * chunk fetched the first time a hosted project opens.
 *
 * Nothing here is a bus command, as nothing in lifecycle is: opening a project reads it.
 */

import type { RemoteChange } from '@caotang/remote-store';
import {
  DOCS_DIR,
  MANIFEST_FILE,
  MemoryArtifactFs,
  isBodyFileName,
  listProjectIds,
  readProject,
  readProjectState,
  readSessions,
  writeProject,
  writeProjectState,
  type ArtifactFs,
  type ProjectState,
  type RuntimeStore,
} from '@caotang/store';
import {
  adopt,
  droppedFieldsOf,
  folderSessionsOf,
  leaseFor,
  linesNotHeld,
  manifestTextOf,
  noticesOf,
  openStored,
  removeProject,
  sameBook,
  type Opened,
} from './lifecycle.js';
import { copyState } from './persistence-plan.js';
import { installHostedTarget } from './hosted-target-registry.js';
import type { HostedTarget } from './hosted-target.js';
import type { HostedProjectSource } from './studio-host.js';

/**
 * The hosted modules are reached only when a host has handed a project over, which is the whole point of the seam: `caotang.app` and the
 * folder app must not pay for the adapter, the target or the queue in their first load. Both of these are dynamic imports for that reason,
 * and the effect is one lazy chunk that is fetched the first time a hosted project opens.
 */
export async function openHostedTargetLater(source: HostedProjectSource): Promise<HostedTarget> {
  const { openHostedTarget } = await import('./hosted-project.js');
  return await openHostedTarget(source);
}

async function picturesOnHostedFs(fs: ArtifactFs): Promise<Record<string, Uint8Array>> {
  const { picturesOnProjectFs } = await import('./hosted-project.js');
  return await picturesOnProjectFs(fs);
}

/**
 * The documents one state holds whose text the other does not: a page this device wrote that the account has never seen, a page the
 * account has that this device deleted, or a page both hold at different words. Their ids, so the text can be read from the copy
 * that has it.
 */
function differingDocumentIds(mine: ProjectState, theirs: ProjectState): string[] {
  const ids = new Set([...mine.documents.keys(), ...theirs.documents.keys()]);
  return [...ids].filter((id) => mine.documents.get(id)?.body !== theirs.documents.get(id)?.body);
}

/**
 * Those documents as the queue holds them: the text as this browser shows it, at the path the project format gives it — which is the
 * codex's own file for a screenplay (`.fountain`) and an Ink knot (`.ink`), not the `.md` every document used to have, so the body is
 * found by the name the copy actually wrote. A document the account holds and this copy does not is held as a deletion (`bytes: null`),
 * because the writer's copy is the one the question is about. A document this copy holds no file for at all — a load declined it
 * because its bytes are not UTF-8 — has no text to hold either, and the account's version stands for it.
 */
async function heldDocumentChanges(state: ProjectState, ids: readonly string[], onAccount: ReadonlySet<string>): Promise<RemoteChange[]> {
  const copy = new MemoryArtifactFs();
  await writeProject(copy, copyState(state), { now: new Date(), copyFor: 'internal' });
  const names = await copy.listFiles(DOCS_DIR);
  const changes: RemoteChange[] = [];
  for (const id of ids) {
    const name = names.find((candidate) => candidate.startsWith(`${id}.`) && isBodyFileName(candidate));
    if (name !== undefined) {
      changes.push({ path: `${DOCS_DIR}/${name}`, bytes: await copy.readBytes(`${DOCS_DIR}/${name}`) });
      continue;
    }
    const onAccountName = [...onAccount].find((candidate) => candidate.startsWith(`${id}.`) && isBodyFileName(candidate));
    if (onAccountName !== undefined) changes.push({ path: `${DOCS_DIR}/${onAccountName}`, bytes: null });
  }
  return changes;
}

export async function openHostedProject(
  store: RuntimeStore,
  source: HostedProjectSource,
  openTarget: (source: HostedProjectSource) => Promise<HostedTarget> = openHostedTargetLater,
  /**
   * This open is the session catching up after a send the writer chose (hosted.md §7.2, the `stale` state), not a project being opened. The
   * account now holds their words and everything else, so its version takes this browser's place without the divergent-copy question: asking
   * here would offer to send the copy that was read before the send, which is exactly what the send replaced.
   */
  catchingUp = false,
): Promise<Opened> {
  const target = await openTarget(source);
  // Nothing the queue holds is sent here: opening a project reads it, and the writer is told what is still on this device with the one
  // action that would send it (hosted.md §7.2). An open that replayed on its own would write to the account without being asked.
  const loaded = await readProject(target.fs);
  // The project's pictures travel with it: the copy this browser keeps is what a later save is measured on, so a picture left
  // behind here would be a picture the next save prunes from the account.
  const pictures = await picturesOnHostedFs(target.fs);
  // The account is this project's home, so the browser's copy of it is a cache rather than a second project: the account's version
  // takes its place under the same id, with the writing history of both. Adopting it the way a folder open does would see a copy
  // already in this browser and make a second project, whose id the next save would write into the account's manifest.
  const accountLog = await folderSessionsOf(target.fs);
  const projectId = loaded.state.manifest.project.id;
  const cached = (await listProjectIds(store)).includes(projectId) ? await readProjectState(store, projectId) : null;
  let opened: Opened;
  if (cached === null) {
    opened = await adopt(store, loaded.state, accountLog, noticesOf(loaded.notices), droppedFieldsOf(loaded.notices), null, pictures);
  } else if (sameBook(cached, loaded.state)) {
    // The same book on both sides: the account's version takes the browser's place under the same id, with the writing history of both.
    // It is written over the copy rather than replacing it, because the copy is more than its manuscript: the writer's recurring tasks,
    // their run history and the consents they gave are this browser's, keyed by the project's id, and removing the project to make room
    // would drop them for a difference the book does not have.
    const keptLog = await readSessions(store, projectId);
    // The copy is written only while this page holds the project: another tab with it open would be writing the same rows, and the
    // lease is what says the writer is here rather than there. It is given back before the project is opened, which takes its own.
    const writing = await leaseFor(projectId);
    try {
      await writeProjectState(store, loaded.state, { now: new Date() });
    } finally {
      writing.release();
    }
    opened = await openStored(store, projectId, null, { notices: noticesOf(loaded.notices), droppedFields: droppedFieldsOf(loaded.notices), folderLog: [...accountLog, ...linesNotHeld(keptLog, accountLog)] }, pictures);
  } else {
    // The browser's copy holds words the account does not. Nothing is written over either of them: those documents are held in the
    // device queue as this device's version, the account's copy opens in their place, and the writer is asked which text the account
    // should keep — the same question a save raises when another device moved the files. "Keep mine" replays the held words; the
    // account's version stands if the writer leaves it. Opening the browser's copy silently instead would be this device's words
    // winning without the writer ever seeing they were at odds with the account.
    const held = catchingUp
      ? []
      : await heldDocumentChanges(cached, differingDocumentIds(cached, loaded.state), new Set(await target.fs.listFiles(DOCS_DIR)));
    // The manifest is the writer's own settings as much as the book — the title, the tree, the codex entries — so a copy whose manifest
    // differs from the account's is part of the same question rather than something the account's version may simply replace.
    if (!catchingUp && manifestTextOf(cached, cached.manifest.project.modifiedAt) !== manifestTextOf(loaded.state, cached.manifest.project.modifiedAt)) {
      const manifest = new MemoryArtifactFs();
      await writeProject(manifest, copyState(cached), { now: new Date(), copyFor: 'internal' });
      held.push({ path: MANIFEST_FILE, bytes: await manifest.readBytes(MANIFEST_FILE) });
    }
    if (held.length === 0) {
      // Catching up after a send, or nothing here can be held (a copy whose words this browser cannot read): the account's version takes the
      // copy's place under this page's lease, which keeps everything keyed by the project's id, and nothing is asked.
      opened = await openStored(store, projectId, null, { notices: noticesOf(loaded.notices), droppedFields: droppedFieldsOf(loaded.notices), folderLog: accountLog }, pictures);
    } else {
      target.queue?.hold(held);
      const keptLog = await readSessions(store, projectId);
      await removeProject(store, projectId);
      opened = await adopt(store, loaded.state, [...accountLog, ...linesNotHeld(keptLog, accountLog)], noticesOf(loaded.notices), droppedFieldsOf(loaded.notices), null, pictures);
      // A conflict the queue's own replay raised is already naming what it could not send; these paths join it, because both are this
      // device's words against the account's and both need the same answer.
      const asked = target.state();
      const paths = held.map((change) => change.path);
      target.raiseConflict(asked.kind === 'conflict' ? [...new Set([...asked.paths, ...paths])] : paths);
    }
  }
  // The target is kept for the session and follows every save this browser finishes, carrying the project's pictures with the files
  // that name them, and knowing what this device held so a save removes only what it deleted itself.
  // The baseline is the account's pictures, not the browser's copy of them: a picture this browser holds and the account does not is
  // one the writer still has to send, and a baseline taken from the copy would make the next save skip exactly that.
  await target.rememberOpened(opened.session.state.documents.keys(), pictures);
  installHostedTarget(target);
  // Words a save could not deliver are the writer's to send: the target says they are here, and the notice offers the action.
  target.heldAtOpen();
  target.attach({
    state: opened.session.state,
    persistence: opened.session.persistence,
    assets: () => opened.session.assets.snapshot(),
  });
  return opened;
}

