/**
 * Opening a project a host has handed over. This module is reached only through `await import('./hosted-open.js')` from the app, so that
 * `caotang.app` and the folder app pay nothing for the hosted path in their first load: the adapter, the target and the queue are one lazy
 * chunk fetched the first time a hosted project opens.
 *
 * Nothing here is a bus command, as nothing in lifecycle is: opening a project reads it.
 */

import {
  listProjectIds,
  readProject,
  readProjectState,
  readSessions,
  rebuildDerived,
  writeProjectState,
  type ArtifactFs,
  type RuntimeStore,
} from '@caotang/store';
import type { Opened } from './lifecycle.js';
import { forgetHostedTarget, hostedTargetFor, installHostedTarget } from './hosted-target-registry.js';
import type { HostedTarget } from './hosted-target.js';
import type { HostedProjectSource } from './studio-host.js';

export async function openCurrentHostedProject(
  store: RuntimeStore,
  source: HostedProjectSource,
  current: () => boolean,
  clear: () => void,
  show: (opened: Opened) => void,
  reread?: Opened['session'],
): Promise<void> {
  if (!current()) return;
  if (reread) {
    const target = hostedTargetFor(reread.projectId);
    if (!target) return;
    try {
      await reread.saved();
    } catch {
      if (current()) target.rereadRefused('save');
      return;
    }
    await target.settled();
    if (!current()) return;
    if (!target.canReread()) {
      target.rereadRefused(target.state().stageFailed ? 'save' : 'queue');
      return;
    }
    target.detach();
    clear();
    await reread.closeSafely().catch(() => undefined);
    if (!current()) return;
  }
  const opened = await openHostedProject(store, source);
  if (current()) {
    show(opened);
    return;
  }
  await opened.session.closeSafely().catch(() => undefined);
  forgetHostedTarget(opened.session.projectId);
}

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

export async function openHostedProject(
  store: RuntimeStore,
  source: HostedProjectSource,
  openTarget: (source: HostedProjectSource) => Promise<HostedTarget> = openHostedTargetLater,
): Promise<Opened> {
  const { adopt, droppedFieldsOf, folderSessionsOf, leaseFor, linesNotHeld, noticesOf, openStored } = await import('./lifecycle.js');
  const target = await openTarget(source);
  // Nothing the queue holds is sent here: opening a project reads it, and the writer is told what is still on this device with the one
  // action that would send it (hosted.md §7.2). An open that replayed on its own would write to the account without being asked.
  const loaded = await readProject(target.fs);
  if (loaded.state.manifest.project.id !== source.projectId) throw new Error('Invalid hosted project manifest.');
  loaded.state.manifest.derived.wordCounts = {};
  rebuildDerived(loaded.state);
  // The project's pictures travel with it as files among the others: the copy this browser keeps is what the session shows and what a
  // save carries, so a picture the account has and this open left behind would be a picture missing from the writer's page.
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
  } else {
    // The account's version always wins, and it is written over the browser's copy rather than replacing it: the copy is more than its
    // manuscript — the writer's recurring tasks, their run history, the consents they gave and the skills they pinned are keyed by the
    // project's id — so removing the project to make room would drop them. Nothing of the copy is compared with the account and nothing
    // here asks a question: the only device-local state a hosted project has is the queue of saves the account has not taken, and that is
    // untouched by an open.
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
  }
  await target.rememberOpened(opened.session.state, pictures);
  installHostedTarget(target);
  target.attach({
    state: opened.session.state,
    persistence: opened.session.persistence,
    assets: () => opened.session.assets.snapshot(),
  });
  return opened;
}
